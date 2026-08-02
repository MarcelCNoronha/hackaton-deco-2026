import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client.js";
import { enrichmentProposals } from "../../db/schema.js";
import { requireAuth } from "../../auth/guards.js";

const reviewBody = z.object({
  status: z.enum(["approved", "rejected", "edited"]),
  proposedValue: z.string().optional(),
  reviewedBy: z.string().optional(),
});

export async function proposalsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get<{ Params: { id: string } }>("/api/runs/:id/proposals", async (req) => {
    return db.query.enrichmentProposals.findMany({
      where: eq(enrichmentProposals.runId, Number(req.params.id)),
    });
  });

  app.patch<{ Params: { id: string } }>("/api/proposals/:id", async (req, reply) => {
    const body = reviewBody.parse(req.body);
    const proposalId = Number(req.params.id);

    const [updated] = await db
      .update(enrichmentProposals)
      .set({
        status: body.status,
        ...(body.proposedValue !== undefined ? { proposedValue: body.proposedValue } : {}),
        reviewedBy: body.reviewedBy ?? "unknown",
        reviewedAt: new Date(),
      })
      .where(eq(enrichmentProposals.id, proposalId))
      .returning();

    if (!updated) return reply.status(404).send({ error: "Proposal not found" });
    return updated;
  });
}
