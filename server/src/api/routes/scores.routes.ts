import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { contentScores } from "../../db/schema.js";
import { requireAuth } from "../../auth/guards.js";
import { getOverallImpactSummary, getRunImpactSummary } from "../../repositories/impact-summary.repo.js";

export async function scoresRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get<{ Params: { id: string } }>("/api/runs/:id/scores", async (req) => {
    return db.query.contentScores.findMany({
      where: eq(contentScores.runId, Number(req.params.id)),
    });
  });

  /** "Impacto Estimado" banner for one run — aggregate before/after deltas across every product
   *  scored in it, plus an estimated time-saved figure vs. a manual-copywriting baseline. */
  app.get<{ Params: { id: string } }>("/api/runs/:id/impact-summary", async (req) => {
    return getRunImpactSummary(Number(req.params.id));
  });

  /** Same banner, rolled up across every finished run — feeds the Impact page's headline. */
  app.get("/api/impact/summary", async () => getOverallImpactSummary());
}
