import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { agentRequestLogs, enrichmentProposals, productMetrics, products } from "../../db/schema.js";
import { getConnectionCredentials } from "../../repositories/connections.repo.js";
import { getCatalogPlatform, setCatalogPlatform } from "../../repositories/catalog-settings.repo.js";
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

/** Loads the credentials for whichever platform is active and builds the matching CatalogClient —
 *  same factory-per-request pattern used for LLM clients in the orchestrator. */
async function requireActiveCatalogClient(): Promise<CatalogClient> {
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
  const localIds = localRows.map((row) => row.id);

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

  // Impact (antes/depois) needs at least 2 GSC/GA4 snapshots to show a trend — 1 shows only a
  // single point (not comparable yet), 0 means nothing collected. Drives the Impacto button color.
  const metricsCountByProductId = new Map<number, number>();
  if (localIds.length > 0) {
    const metricsRows = await db
      .select({ productId: productMetrics.productId, count: sql<string>`count(*)` })
      .from(productMetrics)
      .where(inArray(productMetrics.productId, localIds))
      .groupBy(productMetrics.productId);
    for (const row of metricsRows) {
      metricsCountByProductId.set(row.productId, Number(row.count));
    }
  }

  return {
    ...result,
    items: result.items.map((item) => {
      const productId = localIdByExternalId.get(item.externalId);
      const lastRun = productId !== undefined ? lastRunByProductId.get(productId) : undefined;
      const costUsd =
        productId !== undefined && lastRun ? costByProductAndRun.get(`${productId}:${lastRun.runId}`) ?? 0 : null;
      const metricsCount = productId !== undefined ? metricsCountByProductId.get(productId) ?? 0 : 0;
      const impactReadiness: "none" | "partial" | "ready" =
        metricsCount >= 2 ? "ready" : metricsCount === 1 ? "partial" : "none";
      return {
        ...item,
        productId: productId ?? null,
        sku: (productId !== undefined ? skuByProductId.get(productId) : undefined) ?? item.sku ?? null,
        lastRunId: lastRun?.runId ?? null,
        optimizedAt: lastRun?.optimizedAt ?? null,
        optimizationStatus: productId !== undefined ? statusByProductId.get(productId) ?? null : null,
        optimizationCostUsd: costUsd,
        impactReadiness,
      };
    }),
  };
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
}
