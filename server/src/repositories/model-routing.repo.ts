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
 *  panel — all on Anthropic, matching the previous DEFAULT_MODELS. */
const DEFAULT_ROUTING: ModelRoutingRow[] = [
  { task: "contentEnrichment", provider: "anthropic", model: resolveModel("anthropic", "balanced").id },
  { task: "imageAltText", provider: "anthropic", model: resolveModel("anthropic", "price").id },
  { task: "evaluator", provider: "anthropic", model: resolveModel("anthropic", "balanced").id },
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
