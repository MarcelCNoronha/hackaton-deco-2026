import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { agentRequestLogs, enrichmentProposals, products } from "../../db/schema.js";
import { getConnectionCredentials } from "../../repositories/connections.repo.js";
import { getCatalogPlatform, setCatalogPlatform } from "../../repositories/catalog-settings.repo.js";
import { getEarliestPublishedAtByProduct } from "../../repositories/real-impact.repo.js";
import { MATURATION_DAYS } from "../../agents/impact.agent.js";
import { VtexClient, type VtexCredentials } from "../../clients/vtex.client.js";
import { ShopifyClient, type ShopifyCredentials } from "../../clients/shopify.client.js";
import type { CatalogClient, CatalogListResult, CatalogPlatform } from "../../clients/catalog-types.js";
import { makeRequestLogger } from "../../repositories/logs.repo.js";
import { requireAuth, requireSection } from "../../auth/guards.js";

const platformBody = z.object({ platform: z.enum(["vtex", "shopify"]) });

const listQuery = z.object({
  search: z.string().optional(),
  categoryId: z.string().optional(),
  brandId: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(24),
});

const byStatusQuery = z.object({
  status: z.enum(["pending", "published"]),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(24),
});

/** Loads the credentials for whichever platform is active and builds the matching CatalogClient —
 *  same factory-per-request pattern used for LLM clients in the orchestrator. */
export async function requireActiveCatalogClient(): Promise<CatalogClient> {
  const platform = await getCatalogPlatform();
  const logger = makeRequestLogger();

  if (platform === "vtex") {
    const credentials = await getConnectionCredentials<"vtex">("vtex");
    if (!credentials) throw new Error("Conexão VTEX não configurada — configure no painel de Integrações primeiro.");
    return new VtexClient(credentials as VtexCredentials, logger);
  }

  const credentials = await getConnectionCredentials<"shopify">("shopify");
  if (!credentials) throw new Error("Conexão Shopify não configurada — configure no painel de Integrações primeiro.");
  return new ShopifyClient(credentials as ShopifyCredentials, logger);
}

interface ProductEnrichment {
  lastRunId: number | null;
  optimizedAt: string | null;
  optimizationStatus: "pending" | "published" | null;
  optimizationCostUsd: number | null;
  impactReadiness: "none" | "partial" | "ready";
}

/** Shared by withOptimizationStatus (annotating a page of the LIVE platform catalog) and
 *  listProductsByStatus (querying our own snapshot directly, status-first) — everything about a
 *  local product that depends on its proposal/run/cost/impact history, keyed by our own
 *  products.id. Returns an entry for every id passed in, even ones with no run yet (all nulls/
 *  "none"), so callers never need an extra `?? default` fallback per field. */
async function computeProductEnrichment(localIds: number[]): Promise<Map<number, ProductEnrichment>> {
  const lastRunByProductId = new Map<number, { runId: number; optimizedAt: string }>();
  const statusByProductId = new Map<number, "pending" | "published">();
  if (localIds.length > 0) {
    const proposalRows = await db
      .select({
        productId: enrichmentProposals.productId,
        runId: enrichmentProposals.runId,
        status: enrichmentProposals.status,
        createdAt: enrichmentProposals.createdAt,
      })
      .from(enrichmentProposals)
      .where(inArray(enrichmentProposals.productId, localIds))
      .orderBy(desc(enrichmentProposals.createdAt));

    for (const row of proposalRows) {
      if (!lastRunByProductId.has(row.productId)) {
        lastRunByProductId.set(row.productId, { runId: row.runId, optimizedAt: row.createdAt.toISOString() });
      }
    }
    for (const [productId, { runId }] of lastRunByProductId) {
      const statuses = proposalRows.filter((r) => r.productId === productId && r.runId === runId).map((r) => r.status);
      statusByProductId.set(productId, statuses.every((s) => s === "published") ? "published" : "pending");
    }
  }

  const costByProductAndRun = new Map<string, number>();
  if (localIds.length > 0) {
    const costRows = await db
      .select({
        productId: agentRequestLogs.productId,
        runId: agentRequestLogs.runId,
        costUsd: sql<string>`coalesce(sum(${agentRequestLogs.costUsd}), 0)`,
      })
      .from(agentRequestLogs)
      .where(inArray(agentRequestLogs.productId, localIds))
      .groupBy(agentRequestLogs.productId, agentRequestLogs.runId);
    for (const row of costRows) {
      if (row.productId === null || row.runId === null) continue;
      costByProductAndRun.set(`${row.productId}:${row.runId}`, Number(row.costUsd));
    }
  }

  // Impact (antes/depois) is a LIVE Google comparison pivoted on each product's earliest publish
  // date (see impact.agent.ts) — no local snapshot to count anymore, just how long ago it was
  // published. Drives the Impacto button color: not published yet, still maturing, or ready to compare.
  const earliestPublishedAtByProductId = await getEarliestPublishedAtByProduct(localIds);

  const result = new Map<number, ProductEnrichment>();
  for (const productId of localIds) {
    const lastRun = lastRunByProductId.get(productId);
    const costUsd = lastRun ? costByProductAndRun.get(`${productId}:${lastRun.runId}`) ?? 0 : null;
    const earliestPublishedAt = earliestPublishedAtByProductId.get(productId);
    const daysSincePublish = earliestPublishedAt
      ? Math.floor((Date.now() - earliestPublishedAt.getTime()) / (24 * 60 * 60 * 1000))
      : null;
    result.set(productId, {
      lastRunId: lastRun?.runId ?? null,
      optimizedAt: lastRun?.optimizedAt ?? null,
      optimizationStatus: statusByProductId.get(productId) ?? null,
      optimizationCostUsd: costUsd,
      impactReadiness: daysSincePublish === null ? "none" : daysSincePublish >= MATURATION_DAYS ? "ready" : "partial",
    });
  }
  return result;
}

/** Cross-references catalog items against our local snapshot so the product list can badge items
 *  that already have a past optimization — green once every proposal from that run was published,
 *  red while any of them still needs human review — linking to the run that produced it. */
async function withOptimizationStatus(result: CatalogListResult, platform: CatalogPlatform) {
  const externalIds = result.items.map((item) => item.externalId);
  if (externalIds.length === 0) return { ...result, items: [] };

  const localRows = await db.query.products.findMany({
    where: and(inArray(products.vtexProductId, externalIds), eq(products.platform, platform)),
  });
  const localIdByExternalId = new Map(localRows.map((row) => [row.vtexProductId, row.id]));
  const skuByProductId = new Map(localRows.map((row) => [row.id, row.sku]));
  const manufacturerReferenceUrlByProductId = new Map(localRows.map((row) => [row.id, row.manufacturerReferenceUrl]));
  const enrichment = await computeProductEnrichment(localRows.map((row) => row.id));

  return {
    ...result,
    items: result.items.map((item) => {
      const productId = localIdByExternalId.get(item.externalId);
      const e = productId !== undefined ? enrichment.get(productId) : undefined;
      return {
        ...item,
        productId: productId ?? null,
        sku: (productId !== undefined ? skuByProductId.get(productId) : undefined) ?? item.sku ?? null,
        lastRunId: e?.lastRunId ?? null,
        optimizedAt: e?.optimizedAt ?? null,
        optimizationStatus: e?.optimizationStatus ?? null,
        optimizationCostUsd: e?.optimizationCostUsd ?? null,
        impactReadiness: e?.impactReadiness ?? "none",
        manufacturerReferenceUrl: (productId !== undefined ? manufacturerReferenceUrlByProductId.get(productId) : undefined) ?? null,
      };
    }),
  };
}

/** Lists products directly from our local snapshot, filtered to a specific optimization status —
 *  the opposite direction from withOptimizationStatus above: status decides membership FIRST, then
 *  gets paginated, instead of paginating the live platform catalog and hoping matching products
 *  land on the current page. Fixes the "A Validar"/"Pronta e enviada" filter pills only ever
 *  matching whatever happened to be on the currently-loaded page of the raw catalog — with this,
 *  they show every matching product across the whole account. Only meaningful for products that
 *  already have a local row (touched by at least one run) — "Não otimizado" has no local row to
 *  query this way, so the frontend keeps using the live-catalog browse for that case. */
async function listProductsByStatus(
  platform: CatalogPlatform,
  status: "pending" | "published",
  page: number,
  pageSize: number,
): Promise<CatalogListResult> {
  const localRows = await db.query.products.findMany({ where: eq(products.platform, platform) });
  const enrichment = await computeProductEnrichment(localRows.map((row) => row.id));

  const matching = localRows
    .filter((row) => enrichment.get(row.id)?.optimizationStatus === status)
    .sort((a, b) => (enrichment.get(b.id)?.optimizedAt ?? "").localeCompare(enrichment.get(a.id)?.optimizedAt ?? ""));

  const start = (page - 1) * pageSize;
  const pageRows = matching.slice(start, start + pageSize);

  return {
    items: pageRows.map((row) => {
      const e = enrichment.get(row.id)!;
      const images = (row.images as Array<{ ImageUrl: string }>) ?? [];
      return {
        externalId: row.vtexProductId,
        title: row.title,
        imageUrl: images[0]?.ImageUrl ?? null,
        category: row.category,
        collection: row.collection,
        brand: row.brand,
        url: row.url,
        productId: row.id,
        sku: row.sku,
        lastRunId: e.lastRunId,
        optimizedAt: e.optimizedAt,
        optimizationStatus: e.optimizationStatus,
        optimizationCostUsd: e.optimizationCostUsd,
        impactReadiness: e.impactReadiness,
        manufacturerReferenceUrl: row.manufacturerReferenceUrl,
      };
    }),
    hasMore: start + pageSize < matching.length,
    total: matching.length,
  };
}

/** Tallies every local product into exactly the 3 groups the "Filtro de Status" pills use
 *  (Otimizar/Validar/Otimizado) — the products page used to show these counts from two dedicated
 *  endpoints (products/optimized-count, products/pending-review-count) that counted distinct
 *  PROPOSALS ever, regardless of which run they came from. That disagreed with the pills, which
 *  classify by each product's LATEST run only — confirmed live: "A Validar: 1" while the "Validar"
 *  pill itself showed zero matching products, because that one pending proposal belonged to a run
 *  a product had since been re-optimized past. This computes counts with the exact same
 *  per-product logic the pills/listProductsByStatus already use, so "pending"/"published" (the two
 *  that only ever apply to a product with a local row) can never disagree with what filtering
 *  shows. `none` is derived as accountTotal - pending - published (matching the "Não otimizado"
 *  pill, which browses the full live catalog, not just locally-synced rows) rather than just
 *  counting local zero-run rows — confirmed live: with most of a real catalog never synced/touched,
 *  the local-only count read "1" while the account actually had hundreds of un-optimized listings.
 *  Falls back to the local-only count if the platform can't report an account-wide total (Shopify,
 *  when its productsCount query somehow comes back empty). */
async function computeStatusCounts(platform: CatalogPlatform): Promise<{ none: number; pending: number; published: number }> {
  const localRows = await db.query.products.findMany({ where: eq(products.platform, platform) });
  const enrichment = await computeProductEnrichment(localRows.map((row) => row.id));
  const counts = { none: 0, pending: 0, published: 0 };
  for (const row of localRows) {
    const status = enrichment.get(row.id)?.optimizationStatus;
    if (status === "published") counts.published++;
    else if (status === "pending") counts.pending++;
    else counts.none++;
  }

  const catalog = await requireActiveCatalogClient();
  const { total } = await catalog.listProducts({ page: 1, pageSize: 1 });
  if (total !== undefined) {
    counts.none = Math.max(0, total - counts.pending - counts.published);
  }
  return counts;
}

export async function catalogRoutes(app: FastifyInstance) {
  // Switching the active platform is a sensitive config action — same permission as Integrações.
  app.get("/api/catalog/platform", { preHandler: requireSection("connections") }, async () => ({
    platform: await getCatalogPlatform(),
  }));

  app.put("/api/catalog/platform", { preHandler: requireSection("connections") }, async (req, reply) => {
    const body = platformBody.parse(req.body);
    await setCatalogPlatform(body.platform);
    return reply.send({ platform: body.platform });
  });

  // Browsing the catalog to pick products for an optimization run is everyday use — any logged-in
  // user can do it, not just those with the "connections" permission.
  app.get("/api/catalog/filters", { preHandler: requireAuth }, async (req, reply) => {
    try {
      const catalog = await requireActiveCatalogClient();
      return await catalog.listFilterOptions();
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{ Querystring: Record<string, string> }>(
    "/api/catalog/products",
    { preHandler: requireAuth },
    async (req, reply) => {
      const query = listQuery.parse(req.query);
      try {
        const platform = await getCatalogPlatform();
        const catalog = await requireActiveCatalogClient();
        const result = await catalog.listProducts(query);
        return await withOptimizationStatus(result, platform);
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // See listProductsByStatus's doc comment — only for the "A Validar"/"Pronta e enviada" filter
  // pills, which need every matching product account-wide, not just whatever's on the current
  // page of the live catalog browse above.
  app.get<{ Querystring: Record<string, string> }>(
    "/api/catalog/products/by-status",
    { preHandler: requireAuth },
    async (req, reply) => {
      const query = byStatusQuery.parse(req.query);
      try {
        const platform = await getCatalogPlatform();
        return await listProductsByStatus(platform, query.status, query.page, query.pageSize);
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Backs the 3 "Filtro de Status" stat tiles — see computeStatusCounts' doc comment for why these
  // can't just reuse products/optimized-count + products/pending-review-count.
  app.get("/api/catalog/products/status-counts", { preHandler: requireAuth }, async (_req, reply) => {
    try {
      const platform = await getCatalogPlatform();
      return await computeStatusCounts(platform);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
