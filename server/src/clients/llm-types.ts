export type LlmProvider = "anthropic" | "openai" | "gemini";

/** The 11 fields `enrichProductContent` can produce in one combined call (mirrors `proposal_field`'s
 *  text-content values in schema.ts — `alt_text` is a separate, per-image pipeline, see
 *  image-alttext.agent.ts, so it's not part of this set). Used to let a run request only a subset,
 *  trimming both output tokens and which proposal rows get created — see enrichment-schema.ts. */
export type EnrichmentField =
  | "description"
  | "benefit_bullets"
  | "technical_specs"
  | "faq"
  | "structured_data"
  | "seo_title"
  | "meta_description"
  | "keywords"
  | "tags"
  | "cta"
  | "attributes_patch";

export const ALL_ENRICHMENT_FIELDS: EnrichmentField[] = [
  "description",
  "benefit_bullets",
  "technical_specs",
  "faq",
  "structured_data",
  "seo_title",
  "meta_description",
  "keywords",
  "tags",
  "cta",
  "attributes_patch",
];

/** How much structure the "description" field should have — drives the Excelente/Bom/Médio
 *  generation packages (see field-cost-estimates.ts): "plain" is today's flowing text, "structured"
 *  asks for real HTML (headings/sections/spec table), "structured_with_image" additionally embeds
 *  one of the product's OWN existing photos next to the highlight point extracted from its
 *  existing text/attributes — never a newly generated image. Defaults to "plain" when omitted, so
 *  existing callers keep today's behavior unchanged. */
export type DescriptionRichness = "plain" | "structured" | "structured_with_image";

/** Optional run-level style knob — adjusts tone/vocabulary of description/bullets/cta without
 *  changing which fields are generated. "auto" (default) leaves today's neutral tone unchanged. */
export type CommunicationTone = "premium" | "tecnico" | "casual" | "auto";

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
  /** SEO-optimized, spelling-corrected product title. Absent when "seo_title" wasn't requested. */
  seoTitle?: string;
  /** Meta description tag (~150-160 chars). Absent when "meta_description" wasn't requested. */
  metaDescription?: string;
  /** Absent when "keywords" wasn't requested for this run. */
  keywords?: { primary: string[]; secondary: string[] };
  /** Absent when "tags" wasn't requested for this run. */
  tags?: string[];
  /** Short call-to-action line, merged into the description like the FAQ block (see
   *  publisher.agent.ts) rather than published as its own field. Absent when "cta" wasn't requested. */
  cta?: string;
  /** Proposed fixes/additions to `attributes` (normalized values, filled-in gaps) — never removes an
   *  existing key. Absent when "attributes_patch" wasn't requested for this run. */
  attributesPatch?: Record<string, string>;
  /** Advisory-only suggestion, never auto-published — always returned when the model has an opinion,
   *  regardless of field selection (it's cheap, comes from the same call). */
  suggestedCategory?: string;
  /** Only set when `descriptionRichness` was "structured_with_image": one of the product's own
   *  existing photo URLs (never invented — must match one of the URLs sent in the request) chosen
   *  to illustrate the highlight point pulled from the product's existing text/attributes, plus a
   *  short caption naming that point. */
  featuredImageUrl?: string;
  imageCaption?: string;
}

export interface ContentEvaluation {
  buyerConfidence: number; // 0-100 — simulated shopper reading only this text
  buyerUnanswered: string[]; // questions a shopper would still have
  geoAnswerableCount: number; // out of GEO_QUESTIONS.length
  unsupportedClaims: string[]; // claims not grounded in knownFacts (only checked when knownFacts is passed)
  seoScore: number; // 0-100 — title/meta/keywords/heading quality for search discoverability
  conversionScore: number; // 0-100 — CTA clarity, benefit framing, objection handling
  dataConsistencyScore: number; // 0-100 — agreement between title/description/attributes
  catalogIssues: string[]; // conflicting or missing catalog info spotted while judging
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

/** Fixed rubric so "before" and "after" are always judged on the exact same questions — doubles as
 *  the "Perguntas respondidas" composite-score metric (see evaluator.agent.ts), so its length (11)
 *  is also `questionsTotal`. Expanded from the original 5 (use-case/compatibility/material/
 *  dimensions/care) with objection- and comparison-style questions real buyers also ask. */
export const GEO_QUESTIONS = [
  "Para que serve este produto / em que situação usar?",
  "Com o que ele é compatível ou combina?",
  "Qual o material ou composição?",
  "Quais as dimensões, tamanho ou capacidade?",
  "Existe alguma restrição de uso ou cuidado especial?",
  "Qual a garantia ou política de troca/devolução?",
  "Como ele se compara a outras variações ou produtos similares?",
  "Qual o principal diferencial em relação a alternativas mais baratas?",
  "Para quem (perfil de comprador/uso) este produto é indicado?",
  "Como é feita a instalação, montagem ou aplicação?",
  "O preço se justifica pelo que o produto entrega?",
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
    /** Defaults to "plain" (today's behavior) when omitted. */
    descriptionRichness?: DescriptionRichness;
    /** Defaults to "auto" (no explicit tone instruction) when omitted. */
    communicationTone?: CommunicationTone;
    /** The product's own existing photo URLs — only read when `descriptionRichness` is
     *  "structured_with_image", to let the model pick (via real vision, not filename guessing)
     *  which existing photo best illustrates the highlight point it extracts from the text. */
    imageUrls?: string[];
    /** Parameter slots already registered on the catalog platform (Shopify's Category/Product
     *  metafields, consulted via CatalogClient.getKnownAttributeFields BEFORE generation) — when
     *  given, `attributesPatch` should key its entries by these exact field keys wherever grounded
     *  info exists, instead of inventing an arbitrary label, so the value can publish straight into
     *  that real platform field. Empty/omitted on VTEX (no metafield concept there). */
    knownAttributeFields?: Array<{ key: string; name: string }>;
    /** Real Search Console queries that actually bring shoppers to this product's page (fetched
     *  once per run in the orchestrator, matched by URL) — grounds seo_title/keywords/description
     *  in what buyers really type instead of the model inventing plausible-sounding terms. Empty/
     *  omitted when GSC isn't connected or the product has no matching page yet. */
    topSearchQueries?: string[];
    /** Specification fields the catalog platform accepts for this product's category (VTEX's
     *  specification module — see vtex.client.ts's getCategoryFieldDefinitions), consulted BEFORE
     *  generation so attributesPatch/technicalSpecs never proposes a field the platform can't
     *  actually save. Empty/omitted when the category has no synced fields (Shopify always; VTEX
     *  categories that legitimately have none configured). */
    categoryFields?: Array<{ name: string }>;
    /** Structural target (word-count range, bullet count, FAQ/spec-table/warranty presence) for
     *  this product's category — resolved from a merchant override, market-reference consensus, or
     *  the store's own best-scoring products (see category-content-profile.repo.ts). A structural
     *  guide only, never content — omitted when no profile could be resolved. */
    contentProfile?: {
      wordCountMin: number | null;
      wordCountMax: number | null;
      bulletCount: number | null;
      hasFaq: boolean | null;
      hasSpecTable: boolean | null;
      hasWarrantySection: boolean | null;
    } | null;
    /** Objective facts extracted from a merchant-provided reference for THIS exact product
     *  (typically the manufacturer's own page) — a primary source of truth against hallucinated
     *  specs, distinct from `attributes` (from the catalog platform itself). Omitted when the
     *  product has no reference set (see products.manufacturerReferenceFacts). */
    manufacturerFacts?: Record<string, string> | null;
  }): Promise<EnrichedContent>;

  evaluateContent(params: { text: string; knownFacts?: string | null; productId?: number }): Promise<ContentEvaluation>;

  generateAltText(params: { imageUrl: string; productTitle: string; productId?: number }): Promise<string>;

  /** Generic schema-constrained extraction over arbitrary text — used by reference-structure.agent.ts
   *  (category-level market reference ads: structural signals ONLY, never the copy itself) and
   *  reference-facts.agent.ts (product-level manufacturer page: objective specs ONLY, never
   *  marketing copy). Deliberately generic (unlike enrichProductContent's fixed EnrichedContent
   *  shape) since the two callers want very different, small, purpose-built schemas. */
  extractStructuredData<T>(params: {
    operation: string;
    systemInstruction: string;
    text: string;
    schema: Record<string, unknown>;
    maxTokens?: number;
    productId?: number;
  }): Promise<T>;

  /** Returns the real failure reason (not just true/false) so a bad key/model/quota issue is
   *  visible in the Connections panel instead of a generic "falha ao validar". */
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}
