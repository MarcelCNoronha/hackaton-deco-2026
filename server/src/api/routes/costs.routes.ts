import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { agentRequestLogs } from "../../db/schema.js";
import { requireAuth } from "../../auth/guards.js";
import { getOptimizationAnalytics } from "../../repositories/optimization-analytics.repo.js";

export async function costsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/optimization-analytics", async () => getOptimizationAnalytics());

  /** Cost breakdown for one run: total plus per-product, per-model — the "quanto custou cada
   *  otimização" view. Only Anthropic calls carry a cost; other providers' rows have costUsd null. */
  app.get<{ Params: { id: string } }>("/api/runs/:id/costs", async (req) => {
    const runId = Number(req.params.id);

    const [totalRow] = await db
      .select({
        totalCostUsd: sql<string>`coalesce(sum(${agentRequestLogs.costUsd}), 0)`,
        totalCalls: sql<number>`count(*)`,
        totalInputTokens: sql<string>`coalesce(sum(${agentRequestLogs.inputTokens}), 0)`,
        totalOutputTokens: sql<string>`coalesce(sum(${agentRequestLogs.outputTokens}), 0)`,
      })
      .from(agentRequestLogs)
      .where(eq(agentRequestLogs.runId, runId));

    const byProduct = await db
      .select({
        productId: agentRequestLogs.productId,
        costUsd: sql<string>`coalesce(sum(${agentRequestLogs.costUsd}), 0)`,
        calls: sql<number>`count(*)`,
      })
      .from(agentRequestLogs)
      .where(eq(agentRequestLogs.runId, runId))
      .groupBy(agentRequestLogs.productId);

    return {
      totalCostUsd: Number(totalRow?.totalCostUsd ?? 0),
      totalCalls: Number(totalRow?.totalCalls ?? 0),
      totalInputTokens: Number(totalRow?.totalInputTokens ?? 0),
      totalOutputTokens: Number(totalRow?.totalOutputTokens ?? 0),
      byProduct: byProduct
        .filter((row) => row.productId !== null)
        .map((row) => ({ productId: row.productId as number, costUsd: Number(row.costUsd), calls: Number(row.calls) })),
    };
  });
}
