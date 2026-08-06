import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCatalogPlatform } from "../../repositories/catalog-settings.repo.js";
import {
  getPageContent,
  setPageContent,
  DEFAULT_PAGE_CONTENT_KEY,
  type PageContentType,
} from "../../repositories/page-content.repo.js";
import { publishPageContent, publishBrandContent } from "../../agents/page-publisher.agent.js";
import { requireActiveCatalogClient } from "./catalog.routes.js";
import { requireSection } from "../../auth/guards.js";

const pageTypeEnum = z.enum(["department", "category", "subcategory", "brand"]);

const contentBody = z.object({
  pageType: pageTypeEnum,
  scopeKey: z.string().min(1).optional(),
  seoTitle: z.string().max(500).nullable().optional(),
  metaDescription: z.string().max(1000).nullable().optional(),
  keywords: z.string().max(500).nullable().optional(),
});

const publishBody = z.object({ pageType: pageTypeEnum, scopeKey: z.string().min(1) });

export async function pageContentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSection("connections"));

  /** Content for the currently active platform, resolved for one scopeKey at a time — mirrors
   *  pdp-templates.routes.ts's GET (query param, defaults to the catalog-wide `'*'`). */
  app.get<{ Querystring: { pageType?: string; scopeKey?: string } }>("/api/page-content", async (req, reply) => {
    const pageType = pageTypeEnum.safeParse(req.query.pageType);
    if (!pageType.success) return reply.status(400).send({ error: "pageType inválido" });
    const platform = await getCatalogPlatform();
    const scopeKey = req.query.scopeKey?.trim() || DEFAULT_PAGE_CONTENT_KEY;
    return getPageContent(platform, pageType.data as PageContentType, scopeKey);
  });

  app.put("/api/page-content", async (req) => {
    const body = contentBody.parse(req.body);
    const platform = await getCatalogPlatform();
    const scopeKey = body.scopeKey ?? DEFAULT_PAGE_CONTENT_KEY;
    await setPageContent({
      platform,
      pageType: body.pageType,
      scopeKey,
      seoTitle: body.seoTitle,
      metaDescription: body.metaDescription,
      keywords: body.keywords,
    });
    return getPageContent(platform, body.pageType, scopeKey);
  });

  /** Writes the resolved content for real onto the active platform — 400s with a clear error
   *  (never a generic 500) both when the platform can't support this page type at all (Shopify,
   *  see catalog-types.ts's updateCategoryContent/updateBrandContent doc comments) and when the
   *  category hasn't been synced yet / the brand name doesn't match anything on the platform. */
  app.post("/api/page-content/publish", async (req, reply) => {
    const body = publishBody.parse(req.body);
    const platform = await getCatalogPlatform();
    try {
      const catalog = await requireActiveCatalogClient();
      const result =
        body.pageType === "brand"
          ? await publishBrandContent({ catalog, platform, scopeKey: body.scopeKey })
          : await publishPageContent({ catalog, platform, pageType: body.pageType, scopeKey: body.scopeKey });
      if (!result.ok) return reply.status(400).send({ error: result.error });
      return { ok: true };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
