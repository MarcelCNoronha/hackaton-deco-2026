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
  /** % of `topSearchQueries` (real Search Console data) whose significant words show up in the
   *  SEO-relevant fields — null when no real query data was available to compare against (GSC
   *  disconnected, or no impressions yet for this product's page), distinguishing "no data" from
   *  "0% coverage". Already folded into `seoScore` (see computeContentScore) — kept separately too
   *  so the panel can show the real-data component instead of just the blended number. */
  seoQueryCoverage: number | null;
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

/** Strips accents and lowercases so pattern matching doesn't miss a match over "compatível" vs
 *  "compativel" or a differently-capitalized real search query. */
const COMBINING_DIACRITICS_PATTERN = new RegExp("[\\u0300-\\u036f]", "g");

function normalizeForMatch(text: string): string {
  return text.normalize("NFD").replace(COMBINING_DIACRITICS_PATTERN, "").toLowerCase();
}

/** One pattern per GEO_QUESTIONS entry, same order/length (11) — keyword/pattern proxies for
 *  "does the text structurally address this topic", not full NLP comprehension. Deliberately
 *  replaces asking the SAME model that wrote the text to self-judge whether its own text answers
 *  these questions (the old `geoAnswerableCount` from evaluateContent) — a model grading its own
 *  homework trends optimistic; a fixed keyword check doesn't. Approximate by nature (real content
 *  can address a topic in wording these patterns miss), documented here rather than hidden. */
const GEO_TOPIC_PATTERNS: RegExp[] = [
  /serve (para|pra)|indicado (para|pra)|uso (em|no|na|para)|utilizado (em|para)|ideal para|usado (em|para|como)/,
  /compativel|combina (com|bem)|combinacao|compoe com/,
  /material|composicao|feito (de|em)|fabricado em/,
  /dimens(ao|oes)|tamanho|capacidade|medid[ao]s?|\d+\s?(cm|mm|m2|m²|l|kg|litros)/,
  /cuidado|restric(ao|oes)|nao (deve|use|utilize)|atencao ao usar|evite/,
  /garantia|troca|devolucao/,
  /compara(do|cao)|em relacao a|diferente de|versus|ao contrario de/,
  /diferencial|se destaca|vantagem|superior ao|unico no mercado/,
  /indicado para (quem|voce)|perfil (de uso|de comprador)|perfeito para|pensado para/,
  /instalac(ao|oes)|montagem|aplicacao|como instalar|como montar|passo a passo/,
  /vale (a pena|o investimento)|custo-beneficio|investimento (que )?vale|compensa/,
];

/** Deterministic, no AI call — % of the 11 GEO_QUESTIONS topics the text (description + FAQ
 *  content) structurally addresses. Independent of structureScore's faqCount/hasStructuredData
 *  bonuses (those already credit FAQ/schema.org presence) — this only checks TOPIC coverage, so
 *  the two sub-scores don't double-count the same signal. */
export function computeGeoStructureScore(
  text: string | null,
  faq: Array<{ question: string; answer: string }>,
): { topicsCovered: number; topicsTotal: number } {
  const haystack = normalizeForMatch(
    [text ?? "", ...faq.flatMap((f) => [f.question, f.answer])].join(" \n "),
  );
  const topicsCovered = GEO_TOPIC_PATTERNS.filter((pattern) => pattern.test(haystack)).length;
  return { topicsCovered, topicsTotal: GEO_TOPIC_PATTERNS.length };
}

/** Deterministic, no AI call — % of real Search Console queries (what buyers actually search for
 *  this product's page) whose significant words (≥3 chars) show up in the SEO-relevant fields.
 *  Requires ≥60% of a query's significant words present rather than an exact phrase match — real
 *  copy rarely repeats a multi-word query verbatim even when it genuinely covers that intent.
 *  Returns null (not 0) when there's no real query data to check against, so the caller can tell
 *  "no data" apart from "covers none of it". */
export function computeSeoQueryCoverage(topSearchQueries: string[] | null | undefined, haystack: string): number | null {
  const queries = (topSearchQueries ?? []).map((q) => q.trim()).filter(Boolean);
  if (queries.length === 0) return null;

  const normalizedHaystack = normalizeForMatch(haystack);
  const matched = queries.filter((query) => {
    const words = normalizeForMatch(query).split(/\s+/).filter((w) => w.length >= 3);
    if (words.length === 0) return false;
    const hits = words.filter((w) => normalizedHaystack.includes(w)).length;
    return hits / words.length >= 0.6;
  }).length;

  return Math.round((matched / queries.length) * 100);
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

/** `attributesExpected` is normally derived from `expectedKeys` — attribute keys that already
 *  show up filled in at least half of this product's category's OTHER synced products (see
 *  catalog-attributes.repo.ts's `getExpectedAttributeKeys`), a FIXED target independent of
 *  whatever this same run's AI proposed. Only falls back to the union of original+patch keys
 *  when there's no such catalog baseline yet (a brand-new/tiny category) — that fallback is
 *  self-referential (the model scoring itself defines its own denominator) and is a known,
 *  documented limitation for that edge case only, not the common path anymore.
 *  `attributesFilled` counts how many of those keys end up with a non-empty value. */
export function computeAttributeCompleteness(
  originalAttributes: Record<string, unknown> | null | undefined,
  attributesPatch: Record<string, string> | null | undefined,
  expectedKeys?: string[] | null,
): { attributesFilled: number; attributesExpected: number } {
  const original = originalAttributes ?? {};
  const patch = attributesPatch ?? {};
  const allKeys =
    expectedKeys && expectedKeys.length > 0
      ? new Set(expectedKeys)
      : new Set([...Object.keys(original), ...Object.keys(patch)]);

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
  /** Actual FAQ content (not just faqCount) — used by computeGeoStructureScore to check topic
   *  coverage against Q&A content too, not just the main description. Omitted/empty is fine
   *  (e.g. judging the "original" text, which never has FAQ). */
  faq?: Array<{ question: string; answer: string }> | null;
  /** Attributes/original description — only meaningful when judging a *proposed* text. */
  knownFacts?: string | null;
  productId?: number;
  seoTitle?: string | null;
  metaDescription?: string | null;
  keywords?: { primary: string[]; secondary: string[] } | null;
  /** Real Search Console queries for this product's page — see computeSeoQueryCoverage. Omitted
   *  when GSC isn't connected or has no data yet; seoScore then falls back to pure AI judgment,
   *  same as before this signal existed. */
  topSearchQueries?: string[] | null;
  originalAttributes?: Record<string, unknown> | null;
  attributesPatch?: Record<string, string> | null;
  /** Category-derived "expected attributes" baseline — see catalog-attributes.repo.ts. Fetched
   *  once per product (not per attempt) by the caller, since it doesn't change across a
   *  quality-gate retry loop. */
  expectedAttributeKeys?: string[] | null;
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
    params.expectedAttributeKeys,
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

  // Deterministic, computed regardless of whether the LLM call ran at all (unlike the old
  // AI-self-judged geoAnswerableCount, which needed a real evaluation to mean anything).
  const { topicsCovered, topicsTotal: questionsTotal } = computeGeoStructureScore(params.text, params.faq ?? []);
  const geoPercentage = percentOrFull(topicsCovered, questionsTotal);
  const completude = percentOrFull(attributesFilled, attributesExpected);

  const seoHaystack = [
    params.seoTitle ?? "",
    params.metaDescription ?? "",
    ...(params.keywords?.primary ?? []),
    ...(params.keywords?.secondary ?? []),
    params.text ?? "",
  ].join(" \n ");
  const seoQueryCoverage = computeSeoQueryCoverage(params.topSearchQueries, seoHaystack);
  // Blended, not replaced: query coverage alone can't judge natural-language quality (a title
  // that stuffs every query verbatim would score high on coverage but read badly), so the AI
  // judgment keeps the majority weight — the real-data signal just pulls it away from pure
  // self-assessment. Falls back to the untouched AI score when there's no real query data yet.
  const seoScore = seoQueryCoverage === null ? evaluation.seoScore : Math.round(evaluation.seoScore * 0.6 + seoQueryCoverage * 0.4);

  const overallScore = Math.round(
    (seoScore +
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
    geoAnswerableCount: topicsCovered,
    geoTotalQuestions: questionsTotal,
    unsupportedClaims: evaluation.unsupportedClaims,
    overallScore,
    seoScore,
    seoQueryCoverage,
    conversionScore: evaluation.conversionScore,
    readabilityScore: readability,
    structureScore: structure,
    dataConsistencyScore: evaluation.dataConsistencyScore,
    catalogIssues: evaluation.catalogIssues,
    attributesFilled,
    attributesExpected,
    questionsAnswered: topicsCovered,
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
      seoQueryCoverage: params.score.seoQueryCoverage,
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
  faq?: Array<{ question: string; answer: string }> | null;
  knownFacts?: string | null;
  seoTitle?: string | null;
  metaDescription?: string | null;
  keywords?: { primary: string[]; secondary: string[] } | null;
  topSearchQueries?: string[] | null;
  originalAttributes?: Record<string, unknown> | null;
  attributesPatch?: Record<string, string> | null;
  expectedAttributeKeys?: string[] | null;
}): Promise<typeof contentScores.$inferSelect> {
  const score = await computeContentScore(params);
  return persistContentScore({ runId: params.runId, productId: params.productId, target: params.target, score });
}
