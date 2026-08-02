import { db } from "../db/client.js";
import { contentScores } from "../db/schema.js";
import type { LlmClient } from "../clients/llm-types.js";
import { GEO_QUESTIONS } from "../clients/llm-types.js";

export interface ComputedContentScore {
  checklistScore: number;
  buyerConfidence: number;
  buyerUnanswered: string[];
  geoAnswerableCount: number;
  geoTotalQuestions: number;
  unsupportedClaims: string[];
  overallScore: number;
}

/** Purely structural, no AI call — counts what's cheap and deterministic to check. Doing this
 *  without a Claude call keeps the per-product cost down and gives a score even for products
 *  that never make it to the LLM stage (e.g. already-good content that Analyst deprioritizes). */
export function checklistScore(params: {
  text: string | null;
  hasStructuredData: boolean;
  faqCount: number;
}): number {
  const text = params.text ?? "";
  const sentenceCount = text.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;

  let score = 0;
  if (text.length >= 200) score += 25;
  if (sentenceCount >= 3) score += 25;
  if (params.hasStructuredData) score += 25;
  if (params.faqCount >= 2) score += 25;
  return score;
}

/** Judges one version of a product's content against the fixed rubric — pure computation, no
 *  persistence, so a quality-gate retry loop can score several drafts before deciding which one
 *  (if any) is worth writing to the database. */
export async function computeContentScore(params: {
  llm: LlmClient;
  text: string | null;
  hasStructuredData: boolean;
  faqCount: number;
  /** Attributes/original description — only meaningful when judging a *proposed* text. */
  knownFacts?: string | null;
  productId?: number;
}): Promise<ComputedContentScore> {
  const checklist = checklistScore({
    text: params.text,
    hasStructuredData: params.hasStructuredData,
    faqCount: params.faqCount,
  });

  const evaluation = params.text
    ? await params.llm.evaluateContent({
        text: params.text,
        knownFacts: params.knownFacts,
        productId: params.productId,
      })
    : { buyerConfidence: 0, buyerUnanswered: GEO_QUESTIONS, geoAnswerableCount: 0, unsupportedClaims: [] };

  const geoPercentage = (evaluation.geoAnswerableCount / GEO_QUESTIONS.length) * 100;
  const overallScore = Math.round((checklist + evaluation.buyerConfidence + geoPercentage) / 3);

  return {
    checklistScore: checklist,
    buyerConfidence: evaluation.buyerConfidence,
    buyerUnanswered: evaluation.buyerUnanswered,
    geoAnswerableCount: evaluation.geoAnswerableCount,
    geoTotalQuestions: GEO_QUESTIONS.length,
    unsupportedClaims: evaluation.unsupportedClaims,
    overallScore,
  };
}

/** Persists an already-computed score. `attempts` records how many drafts the quality-gate loop
 *  needed before landing on this one (always 1 for "original", since there's nothing to retry). */
export async function persistContentScore(params: {
  runId: number;
  productId: number;
  target: "original" | "proposed";
  score: ComputedContentScore;
  attempts?: number;
}): Promise<typeof contentScores.$inferSelect> {
  const [row] = await db
    .insert(contentScores)
    .values({
      runId: params.runId,
      productId: params.productId,
      target: params.target,
      checklistScore: params.score.checklistScore,
      buyerConfidence: params.score.buyerConfidence,
      buyerUnanswered: params.score.buyerUnanswered,
      geoAnswerableCount: params.score.geoAnswerableCount,
      geoTotalQuestions: params.score.geoTotalQuestions,
      unsupportedClaims: params.score.unsupportedClaims,
      overallScore: params.score.overallScore,
      attempts: params.attempts ?? 1,
    })
    .returning();
  return row;
}

/** Convenience wrapper (compute + persist in one call) — used for the "original" baseline, which
 *  is only ever scored once (there's no draft to retry). */
export async function scoreContent(params: {
  llm: LlmClient;
  runId: number;
  productId: number;
  target: "original" | "proposed";
  text: string | null;
  hasStructuredData: boolean;
  faqCount: number;
  knownFacts?: string | null;
}): Promise<typeof contentScores.$inferSelect> {
  const score = await computeContentScore(params);
  return persistContentScore({ runId: params.runId, productId: params.productId, target: params.target, score });
}
