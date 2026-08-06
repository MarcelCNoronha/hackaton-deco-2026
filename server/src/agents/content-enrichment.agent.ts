import { db } from "../db/client.js";
import { enrichmentProposals } from "../db/schema.js";
import {
  ALL_ENRICHMENT_FIELDS,
  type CommunicationTone,
  type DescriptionRichness,
  type EnrichedContent,
  type EnrichmentField,
  type LlmClient,
} from "../clients/llm-types.js";
import type { ProductRow } from "./catalog-reader.agent.js";
import { computeContentScore, persistContentScore, scoreContent, type ComputedContentScore } from "./evaluator.agent.js";
import { findReuseDonor } from "../repositories/product-similarity.repo.js";
import { getExpectedAttributeKeys } from "../repositories/catalog-attributes.repo.js";
import { getCategoryFields } from "../repositories/category-spec-fields.repo.js";
import { resolveCategoryContentProfile } from "../repositories/category-content-profile.repo.js";
import { resolveCategoryPromptRules } from "../repositories/category-prompt-rules.repo.js";

// Real platform/SEO limits — the prompt already asks for these lengths (see
// enrichment-schema.ts), but a prompt is a request, not a guarantee, and a search engine or VTEX
// itself truncates mid-word past these counts. This is the hard backstop that actually gets
// written, so a model that ignores the prompt can't publish an SEO title that gets cut off
// mid-word on a Google result or in VTEX's own title field.
const SEO_TITLE_MAX_LENGTH = 60;
const META_DESCRIPTION_MAX_LENGTH = 160;

/** Cuts at the last whole word that still fits, rather than mid-word — a truncated "…" reads as
 *  intentional, a truncated half-word reads as broken. Exported for unit testing (see
 *  content-enrichment.agent.test.ts). */
export function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function normalizeForTermMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = normalizeForTermMatch(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function collectGeneratedStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectGeneratedStrings(item, out));
    return out;
  }
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((item) => collectGeneratedStrings(item, out));
  }
  return out;
}

export function findForbiddenTermHits(enriched: EnrichedContent, forbiddenTerms: string[]): string[] {
  const terms = uniqueStrings(forbiddenTerms);
  if (terms.length === 0) return [];
  const haystack = normalizeForTermMatch(collectGeneratedStrings(enriched).join("\n"));
  return terms.filter((term) => haystack.includes(normalizeForTermMatch(term)));
}

function applyForbiddenTermPenalty(score: ComputedContentScore, forbiddenHits: string[]): ComputedContentScore {
  if (forbiddenHits.length === 0) return score;
  const issue = `Remover termos proibidos desta categoria: ${forbiddenHits.join(", ")}.`;
  const claims = forbiddenHits.map((term) => `Termo proibido da categoria encontrado: "${term}".`);
  return {
    ...score,
    buyerConfidence: Math.min(score.buyerConfidence, 35),
    seoScore: Math.min(score.seoScore, 35),
    conversionScore: Math.min(score.conversionScore, 35),
    dataConsistencyScore: Math.min(score.dataConsistencyScore, 35),
    overallScore: Math.min(score.overallScore, 35),
    buyerUnanswered: uniqueStrings([...score.buyerUnanswered, issue]),
    unsupportedClaims: uniqueStrings([...score.unsupportedClaims, ...claims]),
    catalogIssues: uniqueStrings([...score.catalogIssues, ...claims]),
  };
}

interface VtexImage {
  ImageUrl: string;
  ImageName?: string;
  ImageText?: string;
  Id?: string | number;
}

/** Below this score, or without at least this much improvement over the original, the draft
 *  is considered not good enough to hand to a human — the agent retries with specific feedback
 *  instead of forwarding mediocre content. Tuned to be reachable in 1-2 attempts for genuinely
 *  poor originals, not a bar that always burns all 3 attempts.
 *
 *  MIN_IMPROVEMENT is checked as `original + MIN_IMPROVEMENT`, which exceeds 100 (impossible to
 *  reach) once the original already scores above 80 — without NEAR_PERFECT_SCORE as an escape
 *  hatch, every product with genuinely good existing content would silently burn all
 *  MAX_ATTEMPTS every single run, tripling its LLM cost for no reason. */
const QUALITY_THRESHOLD = 75;
const MIN_IMPROVEMENT = 20;
const NEAR_PERFECT_SCORE = 95;
const MAX_ATTEMPTS = 3;

/** The LLM is instructed not to invent price/offers/name/brand/sku, but nothing stops it from
 *  drifting on those anyway — so the facts we already know for certain always win over whatever
 *  it produced, applied after generation rather than trusted from the prompt alone. */
function buildFinalStructuredData(enriched: EnrichedContent, product: ProductRow): Record<string, unknown> {
  return {
    ...(enriched.structuredData ?? {}),
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    ...(product.sku ? { sku: product.sku } : {}),
    ...(product.brand ? { brand: { "@type": "Brand", name: product.brand } } : {}),
    ...(product.category ? { category: product.category } : {}),
  };
}

/** Only creates a row for a field if the caller actually selected it — `enriched` may carry other
 *  fields too (the LLM always fills "description" for scoring regardless of selection, see
 *  enrichment-schema.ts's resolveRequestedFields), but those shouldn't surface as proposals the
 *  user never asked for. */
function buildProposalRows(params: {
  runId: number;
  product: ProductRow;
  enriched: EnrichedContent;
  fields: EnrichmentField[];
  reuse?: { productId: number; similarity: number };
}): (typeof enrichmentProposals.$inferInsert)[] {
  const { runId, product, enriched, fields, reuse } = params;
  const reuseFields = reuse
    ? { reusedFromProductId: reuse.productId, reusedSimilarity: reuse.similarity.toString() }
    : {};
  const selected = new Set(fields);
  const rows: (typeof enrichmentProposals.$inferInsert)[] = [];

  if (selected.has("description")) {
    // Always plain narrative text — where this and the other blocks (bullets/specs/faq/cta/
    // featured image) end up in the final HTML is the PDP template's job, not the model's or this
    // function's (see publisher.agent.ts's renderPdpHtml).
    rows.push({
      runId,
      productId: product.id,
      field: "description",
      agent: "content",
      originalValue: product.description,
      proposedValue: enriched.description,
      ...reuseFields,
    });
  }
  // Not gated by field selection — there's no checkbox for it; it only exists when the
  // structured_with_image call actually found a matching photo. A real proposal row (rather than
  // baking it into `description`) so it goes through the same human review as everything else,
  // and so the PDP template controls its position instead of it being pre-embedded.
  if (enriched.featuredImageUrl) {
    rows.push({
      runId,
      productId: product.id,
      field: "featured_image",
      agent: "content",
      originalValue: null,
      proposedValue: JSON.stringify({ url: enriched.featuredImageUrl, caption: enriched.imageCaption ?? "" }),
      ...reuseFields,
    });
  }
  if (selected.has("benefit_bullets") && enriched.benefitBullets) {
    rows.push({
      runId,
      productId: product.id,
      field: "benefit_bullets",
      agent: "content",
      originalValue: null,
      proposedValue: JSON.stringify(enriched.benefitBullets),
      ...reuseFields,
    });
  }
  if (selected.has("technical_specs") && enriched.technicalSpecs) {
    rows.push({
      runId,
      productId: product.id,
      field: "technical_specs",
      agent: "content",
      originalValue: null,
      proposedValue: JSON.stringify(enriched.technicalSpecs),
      ...reuseFields,
    });
  }
  if (selected.has("faq") && enriched.faq) {
    rows.push({
      runId,
      productId: product.id,
      field: "faq",
      agent: "content",
      originalValue: null,
      proposedValue: JSON.stringify(enriched.faq),
      ...reuseFields,
    });
  }
  if (selected.has("structured_data")) {
    rows.push({
      runId,
      productId: product.id,
      field: "structured_data",
      agent: "content",
      originalValue: null,
      proposedValue: JSON.stringify(buildFinalStructuredData(enriched, product)),
      ...reuseFields,
    });
  }
  if (selected.has("seo_title") && enriched.seoTitle) {
    rows.push({
      runId,
      productId: product.id,
      field: "seo_title",
      agent: "content",
      originalValue: product.title,
      proposedValue: truncateAtWordBoundary(enriched.seoTitle, SEO_TITLE_MAX_LENGTH),
      ...reuseFields,
    });
  }
  if (selected.has("meta_description") && enriched.metaDescription) {
    rows.push({
      runId,
      productId: product.id,
      field: "meta_description",
      agent: "content",
      originalValue: null,
      proposedValue: truncateAtWordBoundary(enriched.metaDescription, META_DESCRIPTION_MAX_LENGTH),
      ...reuseFields,
    });
  }
  if (selected.has("keywords") && enriched.keywords) {
    rows.push({
      runId,
      productId: product.id,
      field: "keywords",
      agent: "content",
      originalValue: null,
      proposedValue: JSON.stringify(enriched.keywords),
      ...reuseFields,
    });
  }
  if (selected.has("tags") && enriched.tags) {
    rows.push({
      runId,
      productId: product.id,
      field: "tags",
      agent: "content",
      originalValue: null,
      proposedValue: JSON.stringify(enriched.tags),
      ...reuseFields,
    });
  }
  if (selected.has("cta") && enriched.cta) {
    rows.push({
      runId,
      productId: product.id,
      field: "cta",
      agent: "content",
      originalValue: null,
      proposedValue: enriched.cta,
      ...reuseFields,
    });
  }
  if (selected.has("attributes_patch") && enriched.attributesPatch) {
    rows.push({
      runId,
      productId: product.id,
      field: "attributes_patch",
      agent: "content",
      originalValue: JSON.stringify(product.attributes),
      proposedValue: JSON.stringify(enriched.attributesPatch),
      ...reuseFields,
    });
  }
  return rows;
}

/** Generates description/FAQ/structured-data proposals for one product, iterating up to
 *  MAX_ATTEMPTS times against the Evaluator's rubric until the draft clears a minimum quality
 *  bar (or attempts run out, in which case the best draft seen wins). Scores the original and
 *  the final proposed content on the same rubric so the run/impact views show a real, immediate
 *  "antes vs. depois" — no need to wait on Search Console/GA4 to catch up.
 *
 *  When `embedding` is given and a near-duplicate product with already-approved content exists
 *  (see product-similarity.repo.ts), skips the retry loop entirely: one adapt call + one score
 *  call instead of up to MAX_ATTEMPTS of each. This is the RAG/dedup cost-saving path for
 *  catalogs with many similar variants (same item, different size/color/finish). */
export async function proposeContentEnrichment(params: {
  contentLlm: LlmClient;
  evaluatorLlm: LlmClient;
  runId: number;
  product: ProductRow;
  embedding?: number[] | null;
  /** Which fields the user selected to receive as proposals for this run — defaults to all 5.
   *  "description" is always generated internally regardless (the quality-gate loop needs it to
   *  score anything at all) but only surfaces as a proposal row when it's in this list too. */
  fields?: EnrichmentField[];
  descriptionRichness?: DescriptionRichness;
  communicationTone?: CommunicationTone;
  /** Parameter slots already registered on the catalog platform (see CatalogClient.
   *  getKnownAttributeFields, fetched once per run in the orchestrator) — steers attributesPatch
   *  to reuse these exact keys. Empty/omitted on VTEX. */
  knownAttributeFields?: Array<{ key: string; name: string }>;
  /** Real Search Console queries for this product's page (resolved once per run in the
   *  orchestrator via GSC.queryTopQueriesByPage + pathnameOf) — grounds seoTitle/keywords/
   *  description in what buyers actually search for. Empty/omitted when GSC isn't connected or
   *  has no data for this product's page. */
  topSearchQueries?: string[];
}): Promise<{ attempts: number; finalScore: number; reused: boolean }> {
  const { contentLlm, evaluatorLlm, runId, product } = params;
  const fields = params.fields ?? ALL_ENRICHMENT_FIELDS;
  const descriptionRichness = params.descriptionRichness ?? "plain";
  const imageUrls =
    descriptionRichness === "structured_with_image"
      ? ((product.images as VtexImage[]) ?? []).map((img) => img.ImageUrl)
      : undefined;

  // Fetched once per product (not per quality-gate attempt, since it's a category-level fact
  // that doesn't change across retries) — see catalog-attributes.repo.ts for what "expected"
  // means here (a fixed baseline from the category's OWN synced products, not from whatever this
  // same run's AI proposes for this one product).
  const expectedAttributeKeys = await getExpectedAttributeKeys(product.platform, product.category);

  // Category-level signals, fetched once per product (same reasoning as expectedAttributeKeys —
  // fixed facts about the category, not something that should shift across quality-gate retries).
  // Both are independent of `donor`/manufacturerFacts below: they apply to a category regardless
  // of whether this specific product has a manufacturer reference set (see llm-types.ts's doc
  // comments on categoryFields/contentProfile/manufacturerFacts).
  const categoryFields = product.category ? await getCategoryFields(product.platform, product.category) : null;
  const contentProfile = await resolveCategoryContentProfile(product.platform, product.category);
  const categoryPromptRules = await resolveCategoryPromptRules(product.platform, product.category);
  const forbiddenTerms = categoryPromptRules?.forbiddenTerms ?? [];
  const manufacturerFacts = product.manufacturerReferenceFacts as Record<string, string> | null;

  const originalScore = await scoreContent({
    llm: evaluatorLlm,
    runId,
    productId: product.id,
    target: "original",
    text: product.description,
    hasStructuredData: false,
    faqCount: 0,
    originalAttributes: product.attributes as Record<string, unknown>,
    expectedAttributeKeys,
  });

  const knownFacts = JSON.stringify({
    originalDescription: product.description,
    attributes: product.attributes,
  });

  // Deliberate: the donor/reuse branch still skips QUALITY_THRESHOLD/MIN_IMPROVEMENT (the donor
  // was already human-approved), but category compliance terms are non-negotiable: if the adapted
  // draft contains a forbidden term, it falls through to the normal retry loop with explicit
  // feedback instead of being accepted automatically.
  let best: { enriched: EnrichedContent; score: ComputedContentScore; forbiddenHits: string[] } | null = null;
  let feedback: { buyerUnanswered: string[]; unsupportedClaims: string[] } | null = null;
  let attempts = 0;

  const donor = params.embedding ? await findReuseDonor(product.platform, product.id, params.embedding) : null;

  if (donor) {
    const enriched = await contentLlm.enrichProductContent({
      title: product.title,
      currentDescription: product.description,
      attributes: product.attributes as Record<string, unknown>,
      category: product.category,
      reuseReference: donor.reference,
      productId: product.id,
      fields,
      descriptionRichness,
      communicationTone: params.communicationTone,
      imageUrls,
      knownAttributeFields: params.knownAttributeFields,
      topSearchQueries: params.topSearchQueries,
      categoryFields: categoryFields ?? undefined,
      contentProfile,
      categoryPromptRules,
      manufacturerFacts,
    });

    const rawScore = await computeContentScore({
      llm: evaluatorLlm,
      text: enriched.description,
      hasStructuredData: Boolean(enriched.structuredData),
      faqCount: enriched.faq?.length ?? 0,
      knownFacts,
      productId: product.id,
      seoTitle: enriched.seoTitle,
      metaDescription: enriched.metaDescription,
      originalAttributes: product.attributes as Record<string, unknown>,
      attributesPatch: enriched.attributesPatch,
      expectedAttributeKeys,
    });
    const forbiddenHits = findForbiddenTermHits(enriched, forbiddenTerms);
    const score = applyForbiddenTermPenalty(rawScore, forbiddenHits);

    if (forbiddenHits.length > 0) {
      feedback = { buyerUnanswered: score.buyerUnanswered, unsupportedClaims: score.unsupportedClaims };
    } else {
      const donorRows = buildProposalRows({
        runId,
        product,
        enriched,
        fields,
        reuse: { productId: donor.productId, similarity: donor.similarity },
      });
      // Drizzle's `.values([])` throws — reachable when the user deselects every field the model
      // actually returned (e.g. only unchecking benefit_bullets/technical_specs/faq, all of which
      // come back empty/omitted).
      if (donorRows.length > 0) await db.insert(enrichmentProposals).values(donorRows);

      await persistContentScore({ runId, productId: product.id, target: "proposed", score, attempts: 1 });

      return { attempts: 1, finalScore: score.overallScore, reused: true };
    }
  }

  for (attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
    const enriched = await contentLlm.enrichProductContent({
      title: product.title,
      currentDescription: product.description,
      attributes: product.attributes as Record<string, unknown>,
      category: product.category,
      feedback,
      productId: product.id,
      fields,
      descriptionRichness,
      communicationTone: params.communicationTone,
      imageUrls,
      knownAttributeFields: params.knownAttributeFields,
      topSearchQueries: params.topSearchQueries,
      categoryFields: categoryFields ?? undefined,
      contentProfile,
      categoryPromptRules,
      manufacturerFacts,
    });

    const rawScore = await computeContentScore({
      llm: evaluatorLlm,
      text: enriched.description,
      hasStructuredData: Boolean(enriched.structuredData),
      faqCount: enriched.faq?.length ?? 0,
      knownFacts,
      productId: product.id,
      seoTitle: enriched.seoTitle,
      metaDescription: enriched.metaDescription,
      originalAttributes: product.attributes as Record<string, unknown>,
      attributesPatch: enriched.attributesPatch,
      expectedAttributeKeys,
    });
    const forbiddenHits = findForbiddenTermHits(enriched, forbiddenTerms);
    const score = applyForbiddenTermPenalty(rawScore, forbiddenHits);

    if (!best || score.overallScore > best.score.overallScore) {
      best = { enriched, score, forbiddenHits };
    }

    const clearsBar =
      score.overallScore >= QUALITY_THRESHOLD &&
      (score.overallScore - originalScore.overallScore >= MIN_IMPROVEMENT || score.overallScore >= NEAR_PERFECT_SCORE);
    if (clearsBar) break;

    feedback = { buyerUnanswered: score.buyerUnanswered, unsupportedClaims: score.unsupportedClaims };
  }

  // best is guaranteed set: the loop always runs at least once.
  const { enriched, score, forbiddenHits } = best!;
  const finalAttempts = Math.min(attempts, MAX_ATTEMPTS);

  if (forbiddenHits.length > 0) {
    throw new Error(
      `Conteúdo gerado ainda contém termos proibidos desta categoria após ${finalAttempts} tentativa(s): ${forbiddenHits.join(", ")}.`,
    );
  }

  const rows = buildProposalRows({ runId, product, enriched, fields });
  if (rows.length > 0) await db.insert(enrichmentProposals).values(rows);

  await persistContentScore({ runId, productId: product.id, target: "proposed", score, attempts: finalAttempts });

  return { attempts: finalAttempts, finalScore: score.overallScore, reused: false };
}
