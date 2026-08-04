import { db } from "../db/client.js";
import { modelRouting } from "../db/schema.js";
import type { LlmProvider } from "../clients/llm-types.js";
import { resolveModel } from "../clients/model-recommendations.js";

export type LlmTask = "contentEnrichment" | "imageAltText" | "evaluator";

export interface ModelRoutingRow {
  task: LlmTask;
  provider: LlmProvider;
  model: string;
}

/** Sensible out-of-the-box routing so the pipeline works before anyone visits the Connections
 *  panel. Evaluator defaults to a DIFFERENT provider than Content Enrichment on purpose — grading
 *  a draft with the same model family that wrote it is circular (it tends to rate its own style
 *  favorably); a different provider judging is a meaningfully more independent check. Falls back
 *  to the same DEFAULT_ROUTING shape either way when the user has already saved a routing row in
 *  Connections, this default is never consulted again for that task. */
const DEFAULT_ROUTING: ModelRoutingRow[] = [
  { task: "contentEnrichment", provider: "anthropic", model: resolveModel("anthropic", "balanced").id },
  { task: "imageAltText", provider: "anthropic", model: resolveModel("anthropic", "price").id },
  { task: "evaluator", provider: "openai", model: resolveModel("openai", "balanced").id },
];

export async function getModelRouting(): Promise<ModelRoutingRow[]> {
  const rows = await db.query.modelRouting.findMany();
  const byTask = new Map(rows.map((row) => [row.task, row]));
  return DEFAULT_ROUTING.map((fallback) => {
    const row = byTask.get(fallback.task);
    return row ? { task: row.task, provider: row.provider, model: row.model } : fallback;
  });
}

export async function setModelRouting(rows: ModelRoutingRow[]): Promise<void> {
  for (const row of rows) {
    await db
      .insert(modelRouting)
      .values({ task: row.task, provider: row.provider, model: row.model, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: modelRouting.task,
        set: { provider: row.provider, model: row.model, updatedAt: new Date() },
      });
  }
}
