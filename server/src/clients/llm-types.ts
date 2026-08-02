export type LlmProvider = "anthropic" | "openai" | "gemini";

/** The 5 fields `enrichProductContent` can produce in one combined call (mirrors `proposal_field`'s
 *  text-content values in schema.ts — `alt_text` is a separate, per-image pipeline, see
 *  image-alttext.agent.ts, so it's not part of this set). Used to let a run request only a subset,
 *  trimming both output tokens and which proposal rows get created — see enrichment-schema.ts. */
export type EnrichmentField = "description" | "benefit_bullets" | "technical_specs" | "faq" | "structured_data";

export const ALL_ENRICHMENT_FIELDS: EnrichmentField[] = [
  "description",
  "benefit_bullets",
  "technical_specs",
  "faq",
  "structured_data",
];

export interface EnrichedContent {
  description: string;
  /** Short, scannable value props — distinct from the flowing description, matching how
   *  high-conversion product pages separate a benefits list from the main copy. Absent when
   *  "benefit_bullets" wasn't requested for this run. */
  benefitBullets?: string[];
  /** Formatted FROM the product's own `attributes`/`currentDescription` input only — the prompt is
   *  instructed to never invent a spec not present there, so this can't hallucinate technical facts.
   *  Absent when "technical_specs" wasn't requested for this run. */
  technicalSpecs?: Array<{ label: string; value: string }>;
  /** Absent when "faq" wasn't requested for this run. */
  faq?: Array<{ question: string; answer: string }>;
  /** schema.org/Product JSON-LD. Absent when "structured_data" wasn't requested for this run. */
  structuredData?: Record<string, unknown>;
}

export interface ContentEvaluation {
  buyerConfidence: number; // 0-100 — simulated shopper reading only this text
  buyerUnanswered: string[]; // questions a shopper would still have
  geoAnswerableCount: number; // out of GEO_QUESTIONS.length
  unsupportedClaims: string[]; // claims not grounded in knownFacts (only checked when knownFacts is passed)
}

/** Already-approved content from a near-duplicate product, handed to the LLM to adapt instead of
 *  generating from scratch — the cost-saving path for catalogs with many similar variants (see
 *  content-enrichment.agent.ts's reuse branch). */
export interface ReuseReference {
  title: string;
  description: string;
  benefitBullets: string[];
  technicalSpecs: Array<{ label: string; value: string }>;
  faq: Array<{ question: string; answer: string }>;
  structuredData: Record<string, unknown>;
}

/** Fixed rubric so "before" and "after" are always judged on the exact same questions. */
export const GEO_QUESTIONS = [
  "Para que serve este produto / em que situação usar?",
  "Com o que ele é compatível ou combina?",
  "Qual o material ou composição?",
  "Quais as dimensões, tamanho ou capacidade?",
  "Existe alguma restrição de uso ou cuidado especial?",
];

/** Common surface every provider (Anthropic, OpenAI, Gemini) implements — lets each pipeline task
 *  (content enrichment, evaluation, alt-text) run on a different provider/model, chosen per-task
 *  in the Connections panel's model-routing section. */
export interface LlmClient {
  enrichProductContent(params: {
    title: string;
    currentDescription: string | null;
    attributes: Record<string, unknown>;
    category: string | null;
    feedback?: { buyerUnanswered: string[]; unsupportedClaims: string[] } | null;
    /** When set, adapt this near-duplicate product's already-approved content instead of writing
     *  from scratch — see content-enrichment.agent.ts's reuse branch. */
    reuseReference?: ReuseReference | null;
    productId?: number;
    /** Which fields to request beyond "description" (always requested — the quality-gate loop is
     *  anchored on it). Defaults to ALL_ENRICHMENT_FIELDS when omitted. See enrichment-schema.ts. */
    fields?: EnrichmentField[];
  }): Promise<EnrichedContent>;

  evaluateContent(params: { text: string; knownFacts?: string | null; productId?: number }): Promise<ContentEvaluation>;

  generateAltText(params: { imageUrl: string; productTitle: string; productId?: number }): Promise<string>;

  /** Returns the real failure reason (not just true/false) so a bad key/model/quota issue is
   *  visible in the Connections panel instead of a generic "falha ao validar". */
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}
