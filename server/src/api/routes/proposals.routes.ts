import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client.js";
import { enrichmentProposals } from "../../db/schema.js";
import { requireAuth } from "../../auth/guards.js";
import { requireActiveCatalogClient } from "./catalog.routes.js";
import { republishProposal } from "../../agents/publisher.agent.js";

const reviewBody = z.object({
  status: z.enum(["approved", "rejected", "edited"]),
  proposedValue: z.string().optional(),
});

const republishBody = z.object({ proposedValue: z.string().optional() });

export async function proposalsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get<{ Params: { id: string } }>("/api/runs/:id/proposals", async (req) => {
    return db.query.enrichmentProposals.findMany({
      where: eq(enrichmentProposals.runId, Number(req.params.id)),
    });
  });

  // Bulk counterpart to the single-proposal PATCH below — approves every pending/edited proposal
  // in one run instead of one review() round-trip per proposal (a run can hold dozens).
  app.post<{ Params: { id: string } }>("/api/runs/:id/proposals/approve-all", async (req) => {
    const runId = Number(req.params.id);
    return db
      .update(enrichmentProposals)
      .set({
        status: "approved",
        reviewedBy: req.authUser!.email,
        reviewedAt: new Date(),
      })
      .where(and(eq(enrichmentProposals.runId, runId), inArray(enrichmentProposals.status, ["pending", "edited"])))
      .returning();
  });

  app.patch<{ Params: { id: string } }>("/api/proposals/:id", async (req, reply) => {
    const body = reviewBody.parse(req.body);
    const proposalId = Number(req.params.id);

    const [updated] = await db
      .update(enrichmentProposals)
      .set({
        status: body.status,
        ...(body.proposedValue !== undefined ? { proposedValue: body.proposedValue } : {}),
        reviewedBy: req.authUser!.email,
        reviewedAt: new Date(),
      })
      .where(eq(enrichmentProposals.id, proposalId))
      .returning();

    if (!updated) return reply.status(404).send({ error: "Proposal not found" });
    return updated;
  });

  // Point-fix: save an edit to an already approved/published proposal and immediately push just
  // that correction to the platform — distinct from the normal review→approve→bulk-publish flow,
  // for a typo/small fix a merchant wants live right away instead of waiting on the whole run.
  app.post<{ Params: { id: string } }>("/api/proposals/:id/republish", async (req, reply) => {
    const body = republishBody.parse(req.body);
    const proposalId = Number(req.params.id);

    if (body.proposedValue !== undefined) {
      const [updated] = await db
        .update(enrichmentProposals)
        .set({ proposedValue: body.proposedValue, reviewedBy: req.authUser!.email, reviewedAt: new Date() })
        .where(eq(enrichmentProposals.id, proposalId))
        .returning();
      if (!updated) return reply.status(404).send({ error: "Proposal not found" });
    }

    try {
      const catalog = await requireActiveCatalogClient();
      const result = await republishProposal({ catalog, proposalId });
      if (!result.ok) return reply.status(400).send({ error: result.error });
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
