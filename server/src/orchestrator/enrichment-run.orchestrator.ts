import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentRequestLogs, enrichmentRuns } from "../db/schema.js";
import { getConnectionCredentials } from "../repositories/connections.repo.js";
import { getCatalogPlatform } from "../repositories/catalog-settings.repo.js";
import { getModelRouting, type ModelRoutingRow } from "../repositories/model-routing.repo.js";
import { makeRequestLogger } from "../repositories/logs.repo.js";
import { VtexClient, type VtexCredentials } from "../clients/vtex.client.js";
import { ShopifyClient, type ShopifyCredentials } from "../clients/shopify.client.js";
import { GscClient } from "../clients/gsc.client.js";
import { Ga4Client } from "../clients/ga4.client.js";
import { ClaudeClient } from "../clients/claude.client.js";
import { OpenAiClient } from "../clients/openai.client.js";
import { GeminiClient } from "../clients/gemini.client.js";
import { EmbeddingsClient } from "../clients/embeddings.client.js";
import type { EnrichmentField, LlmClient, LlmProvider } from "../clients/llm-types.js";
import type { CatalogClient } from "../clients/catalog-types.js";
import type { RequestLogEntry } from "../clients/http.js";
import { syncCatalogByProductIds, type ProductRow } from "../agents/catalog-reader.agent.js";
import { prioritizeProducts } from "../agents/analyst.agent.js";
import { proposeContentEnrichment } from "../agents/content-enrichment.agent.js";
import { proposeImageAltText } from "../agents/image-alttext.agent.js";
import { publishApprovedProposals } from "../agents/publisher.agent.js";
import { buildEmbeddingText, saveEmbedding } from "../repositories/product-similarity.repo.js";

export interface StartEnrichmentRunParams {
  /** Seleção manual de produtos. Exatamente um entre isto e catalogFilter é esperado. */
  candidateProductIds?: string[];
  /** "Otimização total": todos os produtos do catálogo que batem com este filtro. */
  catalogFilter?: { search?: string; categoryId?: string; brandId?: string };
  /** If set, only the top N candidates (ranked by the Analyst) are actually enriched. Defaults
   *  to 50 when running in catalogFilter mode without an explicit value, so "otimização total"
   *  never fires AI cost against an entire catalog without the user consciously picking a size. */
  topN?: number;
  /** Which content fields to propose (see the optimization selector in the UI). `undefined` means
   *  all 5 (unchanged default behavior); an explicit `[]` skips content enrichment entirely for
   *  this run (e.g. an alt-text-only run) — see the `runContent` guard in executeEnrichmentRun. */
  fields?: EnrichmentField[];
  /** Whether to also run the (separate, per-image) alt-text pass. Defaults to true. */
  includeAltText?: boolean;
}

/** Safety ceiling on how many products a catalogFilter run fetches to consider for ranking —
 *  independent of topN (which caps how many are actually enriched after ranking). */
const MAX_CATALOG_FILTER_CANDIDATES = 200;
const CATALOG_LIST_PAGE_SIZE = 50;

/** Instantiates the right LlmClient subclass for a routing row, reusing whichever provider
 *  credential is already connected. Each pipeline task can point at a different provider/model. */
function buildLlmClient(
  provider: LlmProvider,
  apiKey: string,
  model: string,
  logger: (entry: RequestLogEntry) => void | Promise<void>,
): LlmClient {
  if (provider === "anthropic") return new ClaudeClient(apiKey, model, logger);
  if (provider === "openai") return new OpenAiClient(apiKey, model, logger);
  return new GeminiClient(apiKey, model, logger);
}

/** Instantiates the right CatalogClient subclass for whichever platform is active. */
async function buildCatalogClient(logger: (entry: RequestLogEntry) => void | Promise<void>): Promise<CatalogClient> {
  const platform = await getCatalogPlatform();
  if (platform === "vtex") {
    const credentials = await getConnectionCredentials<"vtex">("vtex");
    if (!credentials) throw new Error("Conexão VTEX não está configurada — configure no painel de Integrações primeiro.");
    return new VtexClient(credentials as VtexCredentials, logger);
  }
  const credentials = await getConnectionCredentials<"shopify">("shopify");
  if (!credentials) throw new Error("Conexão Shopify não está configurada — configure no painel de Integrações primeiro.");
  return new ShopifyClient(credentials as ShopifyCredentials, logger);
}

async function requireConnectedClients(runId: number) {
  const logger = makeRequestLogger(runId);

  const [catalog, googleCreds, openaiCreds, routing] = await Promise.all([
    buildCatalogClient(logger),
    getConnectionCredentials("google"),
    getConnectionCredentials("openai"),
    getModelRouting(),
  ]);

  // Google (GSC/GA4) is only needed to *rank* candidates when topN trims a larger pool — a run
  // without topN, or with candidateProductIds already at the target size, doesn't need it at all.
  const gsc = googleCreds ? new GscClient(googleCreds.gscSiteUrl, googleCreds.refreshToken, logger) : null;
  const ga4 = googleCreds ? new Ga4Client(googleCreds.ga4PropertyId, googleCreds.refreshToken, logger) : null;

  // Embeddings power near-duplicate detection (see product-similarity.repo.ts) so very similar
  // products can reuse already-approved content instead of a full LLM generation — independent of
  // whichever provider is actually routed for the enrichment tasks below. Optional: without an
  // OpenAI connection every product just goes through full generation, same as before this existed.
  const embeddings = openaiCreds ? new EmbeddingsClient(openaiCreds.apiKey, logger) : null;

  const providersNeeded = [...new Set(routing.map((r) => r.provider))];
  const credentialsByProvider = new Map<LlmProvider, string>();
  for (const provider of providersNeeded) {
    const creds = await getConnectionCredentials(provider);
    if (!creds) {
      throw new Error(
        `Conexão do provedor de IA "${provider}" não está configurada — configure no painel de Integrações primeiro.`,
      );
    }
    credentialsByProvider.set(provider, creds.apiKey);
  }

  const routingByTask = new Map<ModelRoutingRow["task"], ModelRoutingRow>(routing.map((r) => [r.task, r]));
  function clientFor(task: ModelRoutingRow["task"]): LlmClient {
    const row = routingByTask.get(task)!;
    return buildLlmClient(row.provider, credentialsByProvider.get(row.provider)!, row.model, logger);
  }

  return {
    catalog,
    gsc,
    ga4,
    embeddings,
    contentLlm: clientFor("contentEnrichment"),
    evaluatorLlm: clientFor("evaluator"),
    imageLlm: clientFor("imageAltText"),
  };
}

/** Embeds every target product in a single batched request and persists the vectors, so
 *  content-enrichment.agent.ts can look up near-duplicate donors per product. No-ops (returns an
 *  empty map) when no OpenAI connection is configured, OR when the embedding call itself fails
 *  (bad/expired key, quota, network) — this is a cost optimization, not a requirement, so a
 *  failure here must never fail the whole run. Either way every product just falls back to full
 *  generation, exactly like before this feature existed. */
async function embedTargetProducts(
  embeddings: EmbeddingsClient | null,
  targetProducts: ProductRow[],
): Promise<Map<number, number[]>> {
  const embeddingByProductId = new Map<number, number[]>();
  if (!embeddings || targetProducts.length === 0) return embeddingByProductId;

  try {
    const vectors = await embeddings.embed(targetProducts.map(buildEmbeddingText));
    await Promise.all(
      targetProducts.map((product, i) => {
        embeddingByProductId.set(product.id, vectors[i]);
        return saveEmbedding(product.id, vectors[i]);
      }),
    );
  } catch (err) {
    console.error("Product embedding failed — continuing without near-duplicate reuse for this run", err);
    embeddingByProductId.clear();
  }
  return embeddingByProductId;
}

/** Resolves "otimização total" (catalogFilter) into a concrete ID list by paginating the active
 *  catalog client, capped at MAX_CATALOG_FILTER_CANDIDATES regardless of topN — topN separately
 *  trims this pool after GSC/GA4 ranking, same as manual candidateProductIds runs already do. */
async function resolveCandidateProductIds(catalog: CatalogClient, params: StartEnrichmentRunParams): Promise<string[]> {
  if (params.candidateProductIds) return params.candidateProductIds;

  const filter = params.catalogFilter ?? {};
  const ids: string[] = [];
  for (let page = 1; ids.length < MAX_CATALOG_FILTER_CANDIDATES; page++) {
    const result = await catalog.listProducts({ ...filter, page, pageSize: CATALOG_LIST_PAGE_SIZE });
    ids.push(...result.items.map((item) => item.externalId));
    if (!result.hasMore) break;
  }
  return ids.slice(0, MAX_CATALOG_FILTER_CANDIDATES);
}

/** Creates the run row synchronously so the API can hand back a runId immediately, before the
 *  (potentially slow) pipeline actually executes on the queue. */
export async function createEnrichmentRun(params: StartEnrichmentRunParams): Promise<{ runId: number }> {
  const [run] = await db
    .insert(enrichmentRuns)
    .values({ status: "running", scope: params })
    .returning();
  return { runId: run.id };
}

/** Runs Analyst -> Catalog Reader -> Content Enrichment + Image Alt-Text (parallel) for a scope of products,
 *  against an already-created run row. Stops after generating proposals — publishing only happens once a
 *  human approves them (see publishRun). This is what the enrichment BullMQ worker calls. */
export async function executeEnrichmentRun(runId: number, params: StartEnrichmentRunParams): Promise<void> {
  const startedAt = Date.now();
  const topN = params.topN ?? (params.catalogFilter ? 50 : undefined);

  try {
    const { catalog, gsc, ga4, embeddings, contentLlm, evaluatorLlm, imageLlm } = await requireConnectedClients(runId);

    const candidateProductIds = await resolveCandidateProductIds(catalog, params);
    const syncedProducts = await syncCatalogByProductIds(catalog, candidateProductIds);

    let targetProducts = syncedProducts;
    let priorityReasons: Record<string, string> = {};
    if (topN && topN < syncedProducts.length) {
      if (gsc && ga4) {
        const ranked = await prioritizeProducts({ gsc, ga4, productsRows: syncedProducts });
        targetProducts = ranked.slice(0, topN).map((r) => r.product);
        priorityReasons = Object.fromEntries(ranked.map((r) => [r.product.vtexProductId, r.reason]));
      } else {
        // No GSC/GA4 connected — still enforce the topN cap (important for catalogFilter's cost
        // safety default) just without a priority ranking behind it.
        targetProducts = syncedProducts.slice(0, topN);
      }
    }

    const embeddingByProductId = await embedTargetProducts(embeddings, targetProducts);

    // `fields: []` is an explicit "skip content generation entirely" (an alt-text-only run) —
    // distinct from `undefined`, which keeps the pre-existing "all 5 fields" default.
    const runContent = !params.fields || params.fields.length > 0;
    const runAltText = params.includeAltText ?? true;

    const [contentResults, imageResults] = await Promise.all([
      runContent
        ? Promise.allSettled(
            targetProducts.map((product) =>
              proposeContentEnrichment({
                contentLlm,
                evaluatorLlm,
                runId,
                product,
                embedding: embeddingByProductId.get(product.id) ?? null,
                fields: params.fields,
              }),
            ),
          )
        : Promise.resolve([]),
      runAltText
        ? Promise.allSettled(targetProducts.map((product) => proposeImageAltText({ llm: imageLlm, runId, product })))
        : Promise.resolve([]),
    ]);

    const failures = [...contentResults, ...imageResults].filter((r) => r.status === "rejected");
    const totalTasks = contentResults.length + imageResults.length;
    const durationMs = Date.now() - startedAt;

    const fulfilledContent = contentResults.filter(
      (r): r is PromiseFulfilledResult<{ attempts: number; finalScore: number; reused: boolean }> =>
        r.status === "fulfilled",
    );
    const avgAttempts = fulfilledContent.length
      ? fulfilledContent.reduce((sum, r) => sum + r.value.attempts, 0) / fulfilledContent.length
      : 0;
    const reusedCount = fulfilledContent.filter((r) => r.value.reused).length;
    const avgFinalScore = fulfilledContent.length
      ? fulfilledContent.reduce((sum, r) => sum + r.value.finalScore, 0) / fulfilledContent.length
      : 0;

    const [costRow] = await db
      .select({ totalCostUsd: sql<string>`coalesce(sum(${agentRequestLogs.costUsd}), 0)` })
      .from(agentRequestLogs)
      .where(eq(agentRequestLogs.runId, runId));

    await db
      .update(enrichmentRuns)
      .set({
        status: failures.length === 0 ? "success" : failures.length === totalTasks ? "failed" : "partial",
        finishedAt: new Date(),
        durationMs,
        processedCount: targetProducts.length,
        summary: {
          candidateCount: syncedProducts.length,
          enrichedCount: targetProducts.length,
          failedTasks: failures.length,
          priorityReasons,
          avgQualityGateAttempts: Math.round(avgAttempts * 10) / 10,
          avgFinalContentScore: Math.round(avgFinalScore),
          totalCostUsd: Number(costRow?.totalCostUsd ?? 0),
          reusedCount,
        },
      })
      .where(eq(enrichmentRuns.id, runId));
  } catch (err) {
    await db
      .update(enrichmentRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      .where(eq(enrichmentRuns.id, runId));
    throw err;
  }
}

/** Publishes every proposal a human has approved for this run back to the active catalog platform. */
export async function publishRun(runId: number): Promise<{ published: number; failed: number }> {
  const { catalog } = await requireConnectedClients(runId);
  return publishApprovedProposals({ catalog, runId });
}
