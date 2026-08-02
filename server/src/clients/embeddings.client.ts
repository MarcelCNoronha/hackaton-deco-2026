import OpenAI from "openai";
import type { RequestLogEntry } from "./http.js";
import { computeEmbeddingCostUsd, EMBEDDING_MODEL } from "./model-recommendations.js";

/** Thin client around OpenAI's embeddings endpoint — used only for near-duplicate product
 *  detection (see product-similarity.repo.ts), never for content generation. Requires an OpenAI
 *  connection regardless of which provider is routed for the actual enrichment tasks; the
 *  orchestrator treats it as optional (same pattern as Google/GSC) — no OpenAI connection just
 *  means every product goes through full generation, same as before this feature existed. */
export class EmbeddingsClient {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly onAttempt?: (entry: RequestLogEntry) => void | Promise<void>,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  /** Batches every text into a single request — cheap and fast regardless of how many products
   *  a run touches. Returns vectors in the same order as the input texts. */
  async embed(texts: string[]): Promise<number[][]> {
    const startedAt = Date.now();
    try {
      const response = await this.client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts,
        dimensions: 1536,
      });
      const costUsd = computeEmbeddingCostUsd(response.usage.total_tokens);
      await this.onAttempt?.({
        provider: "openai",
        operation: "embedProducts",
        endpoint: "https://api.openai.com/v1/embeddings",
        method: "POST",
        success: true,
        attempt: 1,
        durationMs: Date.now() - startedAt,
        model: EMBEDDING_MODEL,
        inputTokens: response.usage.total_tokens,
        outputTokens: 0,
        costUsd,
      });
      return response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
    } catch (err) {
      await this.onAttempt?.({
        provider: "openai",
        operation: "embedProducts",
        endpoint: "https://api.openai.com/v1/embeddings",
        method: "POST",
        success: false,
        attempt: 1,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        model: EMBEDDING_MODEL,
      });
      throw err;
    }
  }
}
