import type { LlmProvider } from "./llm-types.js";

export type PriceTier = "quality" | "balanced" | "price";

export interface ModelTierInfo {
  id: string;
  label: string;
  /** USD per 1M tokens (list price). */
  inputPrice: number;
  outputPrice: number;
}

/** Three tiers per provider — quality (most capable), balanced (recommended default), price
 *  (cheapest viable). IDs/pricing fetched live (beyond training cutoff) on 2026-08-01, not guessed. */
export const RECOMMENDATIONS: Record<LlmProvider, Record<PriceTier, ModelTierInfo>> = {
  anthropic: {
    quality: { id: "claude-opus-5", label: "Claude Opus 5", inputPrice: 5.0, outputPrice: 25.0 },
    balanced: {
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5 (recomendado)",
      inputPrice: 2.0,
      outputPrice: 10.0,
    },
    price: { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", inputPrice: 1.0, outputPrice: 5.0 },
  },
  openai: {
    quality: { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", inputPrice: 5.0, outputPrice: 30.0 },
    balanced: { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (recomendado)", inputPrice: 2.0, outputPrice: 12.0 },
    price: { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", inputPrice: 0.2, outputPrice: 1.2 },
  },
  gemini: {
    quality: {
      id: "gemini-3.1-pro-preview",
      label: "Gemini 3.1 Pro (preview)",
      inputPrice: 2.0,
      outputPrice: 12.0,
    },
    balanced: {
      id: "gemini-3.6-flash",
      label: "Gemini 3.6 Flash (recomendado)",
      inputPrice: 1.5,
      outputPrice: 7.5,
    },
    price: { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite", inputPrice: 0.3, outputPrice: 2.5 },
  },
};

export function resolveModel(provider: LlmProvider, tier: PriceTier): ModelTierInfo {
  return RECOMMENDATIONS[provider][tier];
}

/** Looks up list pricing for any model id known to a provider's 3 tiers; falls back to the
 *  provider's "balanced" tier pricing for a model that isn't one of the three (e.g. a future one
 *  set directly in the DB) so cost tracking never throws. */
export function priceForModel(provider: LlmProvider, model: string): { input: number; output: number } {
  const tiers = RECOMMENDATIONS[provider];
  const match = Object.values(tiers).find((tier) => tier.id === model);
  const pricing = match ?? tiers.balanced;
  return { input: pricing.inputPrice, output: pricing.outputPrice };
}

export function computeCostUsd(provider: LlmProvider, model: string, inputTokens: number, outputTokens: number): number {
  const pricing = priceForModel(provider, model);
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

/** OpenAI's smallest embedding model — 1536 dims matches `products.embedding`'s column size.
 *  Used only for near-duplicate detection (see embeddings.client.ts), never for content
 *  generation itself, so this is independent of whichever provider/model is routed per task. */
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_PRICE_PER_1M = 0.02;

export function computeEmbeddingCostUsd(tokens: number): number {
  return (tokens / 1_000_000) * EMBEDDING_PRICE_PER_1M;
}

/** Image generation is priced per-image, not per-token, so it doesn't go through
 *  computeCostUsd/priceForModel above — Gemini is the only one of our 3 providers that generates
 *  images at all (Claude is vision-input-only; OpenAI's image-edit endpoint isn't wired up here).
 *  Fetched live (beyond training cutoff) on 2026-08-01, not guessed. */
export const IMAGE_GENERATION_MODEL = "gemini-2.5-flash-image";
export const IMAGE_GENERATION_PRICE_PER_IMAGE = 0.039;
