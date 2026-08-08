import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/guards.js";
import { getCatalogPlatform } from "../../repositories/catalog-settings.repo.js";
import { getConnectionCredentials } from "../../repositories/connections.repo.js";
import { makeRequestLogger } from "../../repositories/logs.repo.js";
import { GscClient } from "../../clients/gsc.client.js";
import { Ga4Client } from "../../clients/ga4.client.js";
import { getPageRealImpact } from "../../agents/page-impact.agent.js";

const pageTypeEnum = z.enum(["department", "category", "subcategory", "brand"]);

/** Same shape/spirit as products.routes.ts's `/api/products/:id/real-impact` — live GSC/GA4
 *  antes/depois, no local snapshot — but for a Departamento/Categoria/Subcategoria/Marca page
 *  instead of a product. Registered with only `requireAuth` (not the `connections`-gated hook
 *  page-content.routes.ts uses for editing) to match product real-impact's own access level:
 *  viewing read-only Google data isn't the same privilege as editing SEO content. */
export async function pageImpactRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get<{ Querystring: { pageType?: string; scopeKey?: string } }>("/api/page-content/real-impact", async (req, reply) => {
    const pageType = pageTypeEnum.safeParse(req.query.pageType);
    if (!pageType.success) return reply.status(400).send({ error: "pageType inválido" });
    const scopeKey = req.query.scopeKey?.trim();
    if (!scopeKey) return reply.status(400).send({ error: "scopeKey obrigatório" });

    const platform = await getCatalogPlatform();
    const googleCreds = await getConnectionCredentials("google");
    const logger = makeRequestLogger();
    const gsc = googleCreds ? new GscClient(googleCreds.gscSiteUrl, googleCreds.refreshToken, logger) : null;
    const ga4 = googleCreds ? new Ga4Client(googleCreds.ga4PropertyId, googleCreds.refreshToken, logger) : null;

    return getPageRealImpact({ gsc, ga4, platform, pageType: pageType.data, scopeKey });
  });
}
