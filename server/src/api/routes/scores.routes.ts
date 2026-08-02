import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { contentScores } from "../../db/schema.js";
import { requireAuth } from "../../auth/guards.js";

export async function scoresRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get<{ Params: { id: string } }>("/api/runs/:id/scores", async (req) => {
    return db.query.contentScores.findMany({
      where: eq(contentScores.runId, Number(req.params.id)),
    });
  });
}
