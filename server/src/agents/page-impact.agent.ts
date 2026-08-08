import type { GscClient } from "../clients/gsc.client.js";
import type { Ga4Client } from "../clients/ga4.client.js";
import type { CatalogPlatform } from "../clients/catalog-types.js";
import { computeRealImpact, type RealImpactResult } from "./impact.agent.js";
import { getPageContentPivot, type PageContentType } from "../repositories/page-content.repo.js";
import { getCategoryNodeUrl } from "../repositories/category-nodes.repo.js";

/** Resolves the real storefront URL for one Departamento/Categoria/Subcategoria/Marca page —
 *  page_content's own manual `pageUrl` always wins when set (the only source at all for "brand",
 *  see schema.ts's doc comment on why VTEX gives no brand URL to auto-resolve from), otherwise
 *  falls back to the category tree's auto-synced URL for the other 3 types. */
async function resolvePageUrl(platform: CatalogPlatform, pageType: PageContentType, scopeKey: string, manualUrl: string | null): Promise<string | null> {
  if (manualUrl) return manualUrl;
  if (pageType === "brand") return null;
  return getCategoryNodeUrl(platform, scopeKey);
}

/** Page-scoped pivot resolution (URL from pageContent/categoryNodes, publishedAt = this exact
 *  scopeKey's firstPublishedAt) on top of the shared computeRealImpact core — see impact.agent.ts's
 *  getProductRealImpact for the product-scoped equivalent. */
export async function getPageRealImpact(params: {
  gsc: GscClient | null;
  ga4: Ga4Client | null;
  platform: CatalogPlatform;
  pageType: PageContentType;
  scopeKey: string;
}): Promise<RealImpactResult> {
  const { gsc, ga4, platform, pageType, scopeKey } = params;
  const pivot = await getPageContentPivot(platform, pageType, scopeKey);
  const url = await resolvePageUrl(platform, pageType, scopeKey, pivot.pageUrl);
  return computeRealImpact({ gsc, ga4, url, publishedAt: pivot.firstPublishedAt });
}
