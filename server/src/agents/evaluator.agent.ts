import { db } from "../db/client.js";
import { contentScores } from "../db/schema.js";
import type { LlmClient } from "../clients/llm-types.js";
import { GEO_QUESTIONS } from "../clients/llm-types.js";

export interface ComputedContentScore {
  checklistScore: number; // alias of structureScore — kept for the pre-composite-score column
  buyerConfidence: number;
  buyerUnanswered: string[];
  geoAnswerableCount: number; // alias of questionsAnswered
  geoTotalQuestions: number; // alias of questionsTotal
  unsupportedClaims: string[];
  overallScore: number;
  seoScore: number;
  conversionScore: number;
  readabilityScore: number;
  structureScore: number;
  dataConsistencyScore: number;
  catalogIssues: string[];
  attributesFilled: number;
  attributesExpected: number;
  questionsAnswered: number;
  questionsTotal: number;
}

/** Purely structural, no AI call — counts what's cheap and deterministic to check. Doing this
 *  without a Claude call keeps the per-product cost down and gives a score even for products
 *  that never make it to the LLM stage (e.g. already-good content that Analyst deprioritizes).
 *  Extended beyond the original 4-point checklist with real-HTML-structure and SEO-field signals
 *  now that "description" can be requested as structured HTML (see DescriptionRichness). */
export function structureScore(params: {
  text: string | null;
  hasStructuredData: boolean;
  faqCount: number;
  hasSeoFields: boolean;
}): number {
  const text = params.text ?? "";
  const sentenceCount = text.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;
  const hasHtmlStructure = /<h[23][ >]/i.test(text) && /<(table|p)[ >]/i.test(text);

  let score = 0;
  if (text.length >= 200) score += 20;
  if (sentenceCount >= 3) score += 15;
  if (params.hasStructuredData) score += 15;
  if (params.faqCount >= 2) score += 15;
  if (hasHtmlStructure) score += 20;
  if (params.hasSeoFields) score += 15;
  return score;
}

/** No AI call — average sentence length and long-word ratio, adapted for scannable e-commerce
 *  copy (Portuguese). HTML tags are stripped first so markup doesn't skew word/sentence counts. */
export function readabilityScore(text: string | null): number {
  const clean = (text ?? "").replace(/<[^>]+>/g, " ");
  const sentences = clean.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length === 0) return 0;

  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;

  const avgWordsPerSentence = words.length / sentences.length;
  const longWordCount = words.filter((w) => w.replace(/[^\p{L}]/gu, "").length >= 10).length;
  const longWordRatio = longWordCount / words.length;

  // Ideal average is ~15 words/sentence for scannable copy — penalize deviation in either
  // direction (choppy fragments or run-on sentences), plus a penalty for a high ratio of long/
  // technical words.
  const lengthPenalty = Math.min(100, Math.abs(avgWordsPerSentence - 15) * 4);
  const wordPenalty = Math.min(100, longWordRatio * 150);
  return Math.max(0, Math.round(100 - lengthPenalty * 0.6 - wordPenalty * 0.4));
}

/** `attributesExpected` is the union of keys between the original attributes and whatever the
 *  model proposed adding/fixing (attributesPatch) — a product with no attributes and no patch has
 *  nothing "expected" (treated as 100% complete, not penalized for a category that just has none).
 *  `attributesFilled` counts how many of those keys end up with a non-empty value. */
export function computeAttributeCompleteness(
  originalAttributes: Record<string, unknown> | null | undefined,
  attributesPatch: Record<string, string> | null | undefined,
): { attributesFilled: number; attributesExpected: number } {
  const original = originalAttributes ?? {};
  const patch = attributesPatch ?? {};
  const allKeys = new Set([...Object.keys(original), ...Object.keys(patch)]);

  let filled = 0;
  for (const key of allKeys) {
    const finalValue = key in patch ? patch[key] : (original as Record<string, unknown>)[key];
    if (finalValue !== undefined && finalValue !== null && String(finalValue).trim() !== "") filled++;
  }
  return { attributesFilled: filled, attributesExpected: allKeys.size };
}

function percentOrFull(numerator: number, denominator: number): number {
  return denominator === 0 ? 100 : Math.round((numerator / denominator) * 100);
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
  seoTitle?: string | null;
  metaDescription?: string | null;
  originalAttributes?: Record<string, unknown> | null;
  attributesPatch?: Record<string, string> | null;
}): Promise<ComputedContentScore> {
  const hasSeoFields = Boolean(params.seoTitle || params.metaDescription);
  const structure = structureScore({
    text: params.text,
    hasStructuredData: params.hasStructuredData,
    faqCount: params.faqCount,
    hasSeoFields,
  });
  const readability = readabilityScore(params.text);
  const { attributesFilled, attributesExpected } = computeAttributeCompleteness(
    params.originalAttributes,
    params.attributesPatch,
  );

  const evaluation = params.text
    ? await params.llm.evaluateContent({
        text: params.text,
        knownFacts: params.knownFacts,
        productId: params.productId,
      })
    : {
        buyerConfidence: 0,
        buyerUnanswered: GEO_QUESTIONS,
        geoAnswerableCount: 0,
        unsupportedClaims: [],
        seoScore: 0,
        conversionScore: 0,
        dataConsistencyScore: 0,
        catalogIssues: [],
      };

  const questionsTotal = GEO_QUESTIONS.length;
  const geoPercentage = percentOrFull(evaluation.geoAnswerableCount, questionsTotal);
  const completude = percentOrFull(attributesFilled, attributesExpected);

  const overallScore = Math.round(
    (evaluation.seoScore +
      geoPercentage +
      evaluation.conversionScore +
      readability +
      structure +
      evaluation.buyerConfidence +
      completude +
      evaluation.dataConsistencyScore) /
      8,
  );

  return {
    checklistScore: structure,
    buyerConfidence: evaluation.buyerConfidence,
    buyerUnanswered: evaluation.buyerUnanswered,
    geoAnswerableCount: evaluation.geoAnswerableCount,
    geoTotalQuestions: questionsTotal,
    unsupportedClaims: evaluation.unsupportedClaims,
    overallScore,
    seoScore: evaluation.seoScore,
    conversionScore: evaluation.conversionScore,
    readabilityScore: readability,
    structureScore: structure,
    dataConsistencyScore: evaluation.dataConsistencyScore,
    catalogIssues: evaluation.catalogIssues,
    attributesFilled,
    attributesExpected,
    questionsAnswered: evaluation.geoAnswerableCount,
    questionsTotal,
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
      seoScore: params.score.seoScore,
      conversionScore: params.score.conversionScore,
      readabilityScore: params.score.readabilityScore,
      structureScore: params.score.structureScore,
      dataConsistencyScore: params.score.dataConsistencyScore,
      catalogIssues: params.score.catalogIssues,
      attributesFilled: params.score.attributesFilled,
      attributesExpected: params.score.attributesExpected,
      questionsAnswered: params.score.questionsAnswered,
      questionsTotal: params.score.questionsTotal,
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
  seoTitle?: string | null;
  metaDescription?: string | null;
  originalAttributes?: Record<string, unknown> | null;
  attributesPatch?: Record<string, string> | null;
}): Promise<typeof contentScores.$inferSelect> {
  const score = await computeContentScore(params);
  return persistContentScore({ runId: params.runId, productId: params.productId, target: params.target, score });
}
