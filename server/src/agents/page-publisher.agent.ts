import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { categoryNodes } from "../db/schema.js";
import type { CatalogClient, CatalogPlatform } from "../clients/catalog-types.js";
import { resolvePageContent, type PageContentType } from "../repositories/page-content.repo.js";

export interface PublishPageContentResult {
  ok: boolean;
  error?: string;
}

/** Publishes a Departamento/Categoria/Subcategoria page — resolves categoryNodes by `scopeKey`
 *  (the same breadcrumb `path` string) to get the VTEX category id, then writes the resolved SEO
 *  content directly (no HTML render step: unlike PDP there's no body/blocks to compose, VTEX's
 *  category screen only has the 3 flat fields — see page-content.repo.ts's doc comment). No `Map`
 *  cache the way publisher.agent.ts's `templateFor` has, since this publishes exactly ONE page per
 *  call, nothing to reuse across products. Failure is returned, never swallowed — this write IS the
 *  primary action the merchant asked for by clicking "Publicar", not a best-effort secondary field
 *  in a bigger batch. */
export async function publishPageContent(params: {
  catalog: CatalogClient;
  platform: CatalogPlatform;
  pageType: Extract<PageContentType, "department" | "category" | "subcategory">;
  scopeKey: string;
}): Promise<PublishPageContentResult> {
  const node = await db.query.categoryNodes.findFirst({
    where: and(eq(categoryNodes.platform, params.platform), eq(categoryNodes.path, params.scopeKey)),
  });
  if (!node) {
    return { ok: false, error: `Categoria "${params.scopeKey}" ainda não foi sincronizada — rode a sincronização de categorias primeiro.` };
  }
  const resolved = await resolvePageContent(params.platform, params.pageType, params.scopeKey);
  try {
    await params.catalog.updateCategoryContent(node.vtexCategoryId, {
      title: resolved.seoTitle ?? undefined,
      description: resolved.metaDescription ?? undefined,
      keywords: resolved.keywords ?? undefined,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Same idea for a Marca page — VTEX has no persisted brand table, so the brand name is resolved
 *  to its platform id live via listFilterOptions() (already on every CatalogClient) instead of a
 *  new sync job, since publishing one brand page is a low-frequency admin action, not a hot path. */
export async function publishBrandContent(params: {
  catalog: CatalogClient;
  platform: CatalogPlatform;
  scopeKey: string;
}): Promise<PublishPageContentResult> {
  const { brands } = await params.catalog.listFilterOptions();
  const brand = brands.find((b) => b.name.localeCompare(params.scopeKey, "pt-BR", { sensitivity: "base" }) === 0);
  if (!brand) {
    return { ok: false, error: `Marca "${params.scopeKey}" não encontrada na plataforma.` };
  }
  const resolved = await resolvePageContent(params.platform, "brand", params.scopeKey);
  try {
    await params.catalog.updateBrandContent(brand.id, {
      title: resolved.seoTitle ?? undefined,
      description: resolved.metaDescription ?? undefined,
      keywords: resolved.keywords ?? undefined,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
