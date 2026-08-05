import type { FastifyInstance } from "fastify";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client.js";
import { agentRequestLogs, enrichmentProposals, enrichmentRuns, products } from "../../db/schema.js";
import { createEnrichmentRun } from "../../orchestrator/enrichment-run.orchestrator.js";
import { enqueueEnrichmentRun, enqueuePublishRun } from "../../queue/queues.js";
import { getModelRouting } from "../../repositories/model-routing.repo.js";
import { findExceededProviders } from "../../repositories/provider-spend-limits.repo.js";
import { findExhaustedFreeQuotaProviders } from "../../repositories/provider-free-quota.repo.js";
import { requireAuth, requireSection } from "../../auth/guards.js";
import { estimateFieldCosts, estimateLevelCost, LEVEL_PACKAGES, type OptimizationLevel } from "../../agents/field-cost-estimates.js";
import { ALL_ENRICHMENT_FIELDS, type EnrichmentField } from "../../clients/llm-types.js";

const DESCRIPTION_RICHNESS_VALUES = ["plain", "structured", "structured_with_image"] as const;
const COMMUNICATION_TONE_VALUES = ["premium", "tecnico", "casual", "auto"] as const;

function formatResetIn(resetAt: string): string {
  const ms = Math.max(0, new Date(resetAt).getTime() - Date.now());
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h${minutes.toString().padStart(2, "0")}min`;
}

const createRunBody = z
  .object({
    candidateProductIds: z.array(z.string().min(1)).min(1).optional(),
    catalogFilter: z
      .object({
        search: z.string().optional(),
        categoryId: z.string().optional(),
        brandId: z.string().optional(),
      })
      .optional(),
    topN: z.number().int().positive().optional(),
    fields: z.array(z.enum(ALL_ENRICHMENT_FIELDS as [EnrichmentField, ...EnrichmentField[]])).optional(),
    includeAltText: z.boolean().optional(),
    imageKinds: z.array(z.enum(["lifestyle", "feature_callout"])).optional(),
    descriptionRichness: z.enum(DESCRIPTION_RICHNESS_VALUES).optional(),
    communicationTone: z.enum(COMMUNICATION_TONE_VALUES).optional(),
  })
  .refine((body) => Boolean(body.candidateProductIds) !== Boolean(body.catalogFilter), {
    message: "Informe exatamente um entre candidateProductIds (seleção manual) e catalogFilter (otimização total).",
  });

export async function runsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.post("/api/runs", async (req, reply) => {
    const body = createRunBody.parse(req.body);

    const routing = await getModelRouting();
    const providersNeeded = [...new Set(routing.map((r) => r.provider))];
    const exceeded = await findExceededProviders(providersNeeded);
    if (exceeded.length > 0) {
      const detail = exceeded.map((p) => `${p.provider} ($${p.spentUsd.toFixed(2)} / $${p.limitUsd!.toFixed(2)} neste mês)`).join(", ");
      return reply.status(402).send({
        error: `Limite de gasto mensal atingido para: ${detail}. Ajuste o limite ou troque o roteamento de modelos no painel de Integrações.`,
      });
    }

    const exhaustedQuota = await findExhaustedFreeQuotaProviders(providersNeeded);
    if (exhaustedQuota.length > 0) {
      const detail = exhaustedQuota.map((q) => `${q.provider} (reseta em ${formatResetIn(q.resetAt)})`).join(", ");
      return reply.status(402).send({
        error: `Franquia gratuita esgotada para: ${detail}. Aguarde o reset ou troque o roteamento de modelos no painel de Integrações.`,
      });
    }

    const { runId } = await createEnrichmentRun(body);
    try {
      await enqueueEnrichmentRun({ runId, ...body });
    } catch (err) {
      // The run row is already committed as "running" — if it never actually gets a worker (e.g.
      // Redis unreachable), it would otherwise stay "running" forever and permanently block
      // publishing (POST /:id/publish 409s on that status). Mark it failed instead so it's visible
      // and re-runnable.
      await db
        .update(enrichmentRuns)
        .set({ status: "failed", finishedAt: new Date(), errorMessage: err instanceof Error ? err.message : String(err) })
        .where(eq(enrichmentRuns.id, runId));
      throw err;
    }
    return reply.status(202).send({ runId });
  });

  /** Feeds the "optimization selector" (pick which fields to run, see cost per field before
   *  confirming) — computed from whichever model is currently routed, never a hardcoded price.
   *  `descriptionRichness` shifts "description"'s own estimate (see field-cost-estimates.ts) so the
   *  preview reflects the extra HTML/vision cost when a level other than Médio is active. */
  app.get<{ Querystring: { productCount?: string; descriptionRichness?: string } }>(
    "/api/runs/field-estimates",
    async (req) => {
      const productCount = Math.max(1, Number(req.query.productCount) || 1);
      const richness = DESCRIPTION_RICHNESS_VALUES.includes(req.query.descriptionRichness as never)
        ? (req.query.descriptionRichness as (typeof DESCRIPTION_RICHNESS_VALUES)[number])
        : "plain";
      return estimateFieldCosts(productCount, richness);
    },
  );

  /** One predictable total per "nível de anúncio" (Médio/Bom/Excelente) — the quick-pick buttons in
   *  the optimization selector, before any manual field customization. */
  app.get<{ Querystring: { productCount?: string } }>("/api/runs/level-estimates", async (req) => {
    const productCount = Math.max(1, Number(req.query.productCount) || 1);
    const levels = Object.keys(LEVEL_PACKAGES) as OptimizationLevel[];
    const estimates = await Promise.all(
      levels.map(async (level) => ({
        level,
        label: LEVEL_PACKAGES[level].label,
        estimatedCostUsd: await estimateLevelCost(level, productCount),
      })),
    );
    return { estimates };
  });

  // `summary.totalCostUsd` is a snapshot frozen the moment a run finishes (see
  // enrichment-run.orchestrator.ts) — it never accounts for cost logged AFTER that (e.g.
  // generating a photo from RunDetail well after the run completed, see products.routes.ts's
  // generateImage runId param). Confirmed live: History showed $0.08 for a run whose own detail
  // page showed $0.12. This overlays the live, current sum from agent_request_logs on top of the
  // frozen snapshot before ever returning it, so the two pages can't disagree.
  async function withLiveCost(runs: (typeof enrichmentRuns.$inferSelect)[]) {
    if (runs.length === 0) return runs;
    const rows = await db
      .select({ runId: agentRequestLogs.runId, totalCostUsd: sql<string>`coalesce(sum(${agentRequestLogs.costUsd}), 0)` })
      .from(agentRequestLogs)
      .where(inArray(agentRequestLogs.runId, runs.map((r) => r.id)))
      .groupBy(agentRequestLogs.runId);
    const costByRunId = new Map(rows.map((r) => [r.runId, Number(r.totalCostUsd)]));
    return runs.map((run) => ({
      ...run,
      summary: { ...(run.summary as Record<string, unknown>), totalCostUsd: costByRunId.get(run.id) ?? 0 },
    }));
  }

  app.get<{ Querystring: { search?: string; categoryId?: string; brandId?: string } }>("/api/runs", async (req) => {
    const { search, categoryId, brandId } = req.query;
    if (!search && !categoryId && !brandId) {
      return withLiveCost(await db.query.enrichmentRuns.findMany({ orderBy: desc(enrichmentRuns.startedAt) }));
    }

    // Same filter fields as the "Nova otimização" product picker (search/categoryId/brandId) —
    // filtering by product attributes means finding which runs touched a matching product, via
    // enrichment_proposals -> products (only sees products a run has actually synced).
    const conditions = [];
    if (search) conditions.push(or(ilike(products.title, `%${search}%`), ilike(products.vtexSkuId, `%${search}%`)));
    if (categoryId) conditions.push(eq(products.category, categoryId));
    if (brandId) conditions.push(eq(products.brand, brandId));

    const matches = await db
      .selectDistinct({ runId: enrichmentProposals.runId })
      .from(enrichmentProposals)
      .innerJoin(products, eq(enrichmentProposals.productId, products.id))
      .where(and(...conditions));
    const runIds = matches.map((m) => m.runId);
    if (runIds.length === 0) return [];

    return withLiveCost(
      await db.query.enrichmentRuns.findMany({
        where: inArray(enrichmentRuns.id, runIds),
        orderBy: desc(enrichmentRuns.startedAt),
      }),
    );
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const run = await db.query.enrichmentRuns.findFirst({ where: eq(enrichmentRuns.id, Number(req.params.id)) });
    if (!run) return reply.status(404).send({ error: "Run not found" });
    const [withCost] = await withLiveCost([run]);
    return withCost;
  });

  app.post<{ Params: { id: string } }>(
    "/api/runs/:id/publish",
    { preHandler: requireSection("publish") },
    async (req, reply) => {
      const runId = Number(req.params.id);
      const run = await db.query.enrichmentRuns.findFirst({ where: eq(enrichmentRuns.id, runId) });
      if (!run) return reply.status(404).send({ error: "Run not found" });
      // The worker still processes remaining products while status is "running" — publishing now
      // would only send whatever's approved so far, silently leaving the rest for a second,
      // easy-to-forget publish once they finish. Block here too, not just in the UI, since this
      // endpoint is reachable directly.
      if (run.status === "running") {
        return reply.status(409).send({
          error: "A otimização ainda está em andamento — aguarde terminar de processar todos os produtos antes de publicar.",
        });
      }
      await enqueuePublishRun(runId);
      return reply.status(202).send({ enqueued: true });
    },
  );
}
