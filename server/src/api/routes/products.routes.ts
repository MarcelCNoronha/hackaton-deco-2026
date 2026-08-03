import type { FastifyInstance } from "fastify";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { enrichmentProposals, productMetrics, products } from "../../db/schema.js";
import { requireAuth } from "../../auth/guards.js";
import { syncProduct } from "../../agents/catalog-reader.agent.js";
import { requireActiveCatalogClient } from "./catalog.routes.js";

export async function productsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/products", async () => {
    return db.query.products.findMany({ orderBy: desc(products.lastSyncedAt) });
  });

  /** Distinct products with at least one optimization proposal ever — used for the "Total de
   *  Otimizados" stat tile, which counts products, not runs (a product optimized in 3 runs still
   *  counts once). */
  app.get("/api/products/optimized-count", async () => {
    const [row] = await db
      .select({ count: sql<string>`count(distinct ${enrichmentProposals.productId})` })
      .from(enrichmentProposals);
    return { count: Number(row?.count ?? 0) };
  });

  /** Distinct products with at least one proposal still awaiting human review (pending or edited,
   *  not yet approved/rejected/published) — the "A Validar" stat tile. */
  app.get("/api/products/pending-review-count", async () => {
    const [row] = await db
      .select({ count: sql<string>`count(distinct ${enrichmentProposals.productId})` })
      .from(enrichmentProposals)
      .where(inArray(enrichmentProposals.status, ["pending", "edited"]));
    return { count: Number(row?.count ?? 0) };
  });

  app.get<{ Params: { id: string } }>("/api/products/:id/metrics", async (req) => {
    return db.query.productMetrics.findMany({
      where: eq(productMetrics.productId, Number(req.params.id)),
      orderBy: desc(productMetrics.fetchedAt),
    });
  });

  /** Re-fetches one product from the active catalog platform and refreshes the local snapshot —
   *  for when the local row was synced before a field existed yet (e.g. `url`, added later) or
   *  otherwise looks incomplete, without needing to run a whole new optimization just to refresh it. */
  app.post<{ Params: { id: string } }>("/api/products/:id/resync", async (req, reply) => {
    const existing = await db.query.products.findFirst({ where: eq(products.id, Number(req.params.id)) });
    if (!existing) return reply.status(404).send({ error: "Produto não encontrado" });

    try {
      const catalog = await requireActiveCatalogClient();
      return await syncProduct(catalog, existing.vtexProductId);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
