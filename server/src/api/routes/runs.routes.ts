import type { FastifyInstance } from "fastify";
import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client.js";
import { enrichmentProposals, enrichmentRuns, products } from "../../db/schema.js";
import { createEnrichmentRun } from "../../orchestrator/enrichment-run.orchestrator.js";
import { enqueueEnrichmentRun, enqueuePublishRun } from "../../queue/queues.js";
import { getModelRouting } from "../../repositories/model-routing.repo.js";
import { findExceededProviders } from "../../repositories/provider-spend-limits.repo.js";
import { findExhaustedFreeQuotaProviders } from "../../repositories/provider-free-quota.repo.js";
import { requireAuth, requireSection } from "../../auth/guards.js";
import { estimateFieldCosts } from "../../agents/field-cost-estimates.js";
import { ALL_ENRICHMENT_FIELDS, type EnrichmentField } from "../../clients/llm-types.js";

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
   *  confirming) — computed from whichever model is currently routed, never a hardcoded price. */
  app.get<{ Querystring: { productCount?: string } }>("/api/runs/field-estimates", async (req) => {
    const productCount = Math.max(1, Number(req.query.productCount) || 1);
    return estimateFieldCosts(productCount);
  });

  app.get<{ Querystring: { search?: string; categoryId?: string; brandId?: string } }>("/api/runs", async (req) => {
    const { search, categoryId, brandId } = req.query;
    if (!search && !categoryId && !brandId) {
      return db.query.enrichmentRuns.findMany({ orderBy: desc(enrichmentRuns.startedAt) });
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

    return db.query.enrichmentRuns.findMany({
      where: inArray(enrichmentRuns.id, runIds),
      orderBy: desc(enrichmentRuns.startedAt),
    });
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const run = await db.query.enrichmentRuns.findFirst({ where: eq(enrichmentRuns.id, Number(req.params.id)) });
    if (!run) return reply.status(404).send({ error: "Run not found" });
    return run;
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
