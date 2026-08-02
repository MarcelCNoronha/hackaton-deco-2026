import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { enrichmentProposals, productMetrics, products } from "../../db/schema.js";
import { requireAuth } from "../../auth/guards.js";

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

  app.get<{ Params: { id: string } }>("/api/products/:id/metrics", async (req) => {
    return db.query.productMetrics.findMany({
      where: eq(productMetrics.productId, Number(req.params.id)),
      orderBy: desc(productMetrics.fetchedAt),
    });
  });
}
