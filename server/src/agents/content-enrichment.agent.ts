import { db } from "../db/client.js";
import { enrichmentProposals } from "../db/schema.js";
import type { EnrichedContent, LlmClient } from "../clients/llm-types.js";
import type { ProductRow } from "./catalog-reader.agent.js";
import { computeContentScore, persistContentScore, scoreContent, type ComputedContentScore } from "./evaluator.agent.js";
import { findReuseDonor } from "../repositories/product-similarity.repo.js";

/** Below this score, or without at least this much improvement over the original, the draft
 *  is considered not good enough to hand to a human — the agent retries with specific feedback
 *  instead of forwarding mediocre content. Tuned to be reachable in 1-2 attempts for genuinely
 *  poor originals, not a bar that always burns all 3 attempts. */
const QUALITY_THRESHOLD = 75;
const MIN_IMPROVEMENT = 20;
const MAX_ATTEMPTS = 3;

/** The LLM is instructed not to invent price/offers/name/brand/sku, but nothing stops it from
 *  drifting on those anyway — so the facts we already know for certain always win over whatever
 *  it produced, applied after generation rather than trusted from the prompt alone. */
function buildFinalStructuredData(enriched: EnrichedContent, product: ProductRow): Record<string, unknown> {
  return {
    ...enriched.structuredData,
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    ...(product.sku ? { sku: product.sku } : {}),
    ...(product.brand ? { brand: { "@type": "Brand", name: product.brand } } : {}),
    ...(product.category ? { category: product.category } : {}),
  };
}

function buildProposalRows(params: {
  runId: number;
  product: ProductRow;
  enriched: EnrichedContent;
  reuse?: { productId: number; similarity: number };
}): (typeof enrichmentProposals.$inferInsert)[] {
  const { runId, product, enriched, reuse } = params;
  const reuseFields = reuse
    ? { reusedFromProductId: reuse.productId, reusedSimilarity: reuse.similarity.toString() }
    : {};

  return [
    {
      runId,
      productId: product.id,
      field: "description",
      agent: "content",
      originalValue: product.description,
      proposedValue: enriched.description,
      ...reuseFields,
    },
    {
      runId,
      productId: product.id,
      field: "benefit_bullets",
      agent: "content",
      originalValue: null,
      proposedValue: JSON.stringify(enriched.benefitBullets),
      ...reuseFields,
    },
    {
      runId,
      productId: product.id,
      field: "technical_specs",
      agent: "content",
      originalValue: null,
      proposedValue: JSON.stringify(enriched.technicalSpecs),
      ...reuseFields,
    },
    {
      runId,
      productId: product.id,
      field: "faq",
      agent: "content",
      originalValue: null,
      proposedValue: JSON.stringify(enriched.faq),
      ...reuseFields,
    },
    {
      runId,
      productId: product.id,
      field: "structured_data",
      agent: "content",
      originalValue: null,
      proposedValue: JSON.stringify(buildFinalStructuredData(enriched, product)),
      ...reuseFields,
    },
  ];
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
}): Promise<{ attempts: number; finalScore: number; reused: boolean }> {
  const { contentLlm, evaluatorLlm, runId, product } = params;

  const originalScore = await scoreContent({
    llm: evaluatorLlm,
    runId,
    productId: product.id,
    target: "original",
    text: product.description,
    hasStructuredData: false,
    faqCount: 0,
  });

  const knownFacts = JSON.stringify({
    originalDescription: product.description,
    attributes: product.attributes,
  });

  const donor = params.embedding ? await findReuseDonor(product.id, params.embedding) : null;

  if (donor) {
    const enriched = await contentLlm.enrichProductContent({
      title: product.title,
      currentDescription: product.description,
      attributes: product.attributes as Record<string, unknown>,
      category: product.category,
      reuseReference: donor.reference,
      productId: product.id,
    });

    const score = await computeContentScore({
      llm: evaluatorLlm,
      text: enriched.description,
      hasStructuredData: Boolean(enriched.structuredData),
      faqCount: enriched.faq.length,
      knownFacts,
      productId: product.id,
    });

    await db.insert(enrichmentProposals).values(
      buildProposalRows({ runId, product, enriched, reuse: { productId: donor.productId, similarity: donor.similarity } }),
    );

    await persistContentScore({ runId, productId: product.id, target: "proposed", score, attempts: 1 });

    return { attempts: 1, finalScore: score.overallScore, reused: true };
  }

  let best: { enriched: EnrichedContent; score: ComputedContentScore } | null = null;
  let feedback: { buyerUnanswered: string[]; unsupportedClaims: string[] } | null = null;
  let attempts = 0;

  for (attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
    const enriched = await contentLlm.enrichProductContent({
      title: product.title,
      currentDescription: product.description,
      attributes: product.attributes as Record<string, unknown>,
      category: product.category,
      feedback,
      productId: product.id,
    });

    const score = await computeContentScore({
      llm: evaluatorLlm,
      text: enriched.description,
      hasStructuredData: Boolean(enriched.structuredData),
      faqCount: enriched.faq.length,
      knownFacts,
      productId: product.id,
    });

    if (!best || score.overallScore > best.score.overallScore) {
      best = { enriched, score };
    }

    const clearsBar =
      score.overallScore >= QUALITY_THRESHOLD && score.overallScore - originalScore.overallScore >= MIN_IMPROVEMENT;
    if (clearsBar) break;

    feedback = { buyerUnanswered: score.buyerUnanswered, unsupportedClaims: score.unsupportedClaims };
  }

  // best is guaranteed set: the loop always runs at least once.
  const { enriched, score } = best!;
  const finalAttempts = Math.min(attempts, MAX_ATTEMPTS);

  await db.insert(enrichmentProposals).values(buildProposalRows({ runId, product, enriched }));

  await persistContentScore({ runId, productId: product.id, target: "proposed", score, attempts: finalAttempts });

  return { attempts: finalAttempts, finalScore: score.overallScore, reused: false };
}
