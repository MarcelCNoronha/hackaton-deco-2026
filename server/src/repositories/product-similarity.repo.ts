import { and, cosineDistance, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { enrichmentProposals, products } from "../db/schema.js";
import type { ReuseReference } from "../clients/llm-types.js";

/** How close (cosine similarity, 0-1) two products' embeddings must be before one's content is
 *  considered safe to adapt for the other. Deliberately strict — this is meant to catch true
 *  near-duplicates (same item, different size/color/finish), not merely-related products, since
 *  reusing content across genuinely different products would both read wrong and risk thin/
 *  duplicate-content SEO issues. */
const SIMILARITY_THRESHOLD = 0.96;

/** Text embedded per product — title/category/brand/attributes capture what makes two products
 *  "the same thing" for reuse purposes; description is deliberately excluded since that's exactly
 *  what we're trying to avoid duplicating blindly. */
export function buildEmbeddingText(product: { title: string; category: string | null; brand: string | null; attributes: unknown }): string {
  return [product.title, product.category, product.brand, JSON.stringify(product.attributes ?? {})]
    .filter((part): part is string => Boolean(part))
    .join(" | ");
}

export async function saveEmbedding(productId: number, embedding: number[]): Promise<void> {
  await db.update(products).set({ embedding }).where(eq(products.id, productId));
}

export interface ReuseDonor {
  productId: number;
  similarity: number;
  reference: ReuseReference;
}

/** Finds the closest product (by embedding cosine similarity) that already has a human-approved
 *  or published description — i.e. content someone has actually signed off on, never an
 *  unreviewed AI draft — and is close enough to count as a near-duplicate. Returns null if
 *  nothing qualifies (including: this is the very first product of its kind, which is expected —
 *  it becomes a future donor itself once its own proposal gets approved). */
export async function findReuseDonor(excludeProductId: number, embedding: number[]): Promise<ReuseDonor | null> {
  const distance = cosineDistance(products.embedding, embedding);

  const [candidate] = await db
    .select({
      productId: products.id,
      distance,
      runId: enrichmentProposals.runId,
      description: enrichmentProposals.proposedValue,
    })
    .from(products)
    .innerJoin(
      enrichmentProposals,
      and(
        eq(enrichmentProposals.productId, products.id),
        eq(enrichmentProposals.field, "description"),
        inArray(enrichmentProposals.status, ["approved", "published"]),
      ),
    )
    .where(and(sql`${products.id} != ${excludeProductId}`, sql`${products.embedding} is not null`))
    .orderBy(distance, desc(enrichmentProposals.createdAt))
    .limit(1);

  if (!candidate) return null;

  const similarity = 1 - Number(candidate.distance);
  if (similarity < SIMILARITY_THRESHOLD) return null;

  function findField(field: "faq" | "structured_data" | "benefit_bullets" | "technical_specs") {
    return db.query.enrichmentProposals.findFirst({
      where: and(
        eq(enrichmentProposals.runId, candidate.runId),
        eq(enrichmentProposals.productId, candidate.productId),
        eq(enrichmentProposals.field, field),
      ),
    });
  }

  const [faqRow, structuredDataRow, benefitBulletsRow, technicalSpecsRow, donorProduct] = await Promise.all([
    findField("faq"),
    findField("structured_data"),
    findField("benefit_bullets"),
    findField("technical_specs"),
    db.query.products.findFirst({ where: eq(products.id, candidate.productId) }),
  ]);

  // Any of these missing would mean inconsistent data (all fields are always inserted
  // together) — safer to skip reuse than to adapt from partial content.
  if (!faqRow || !structuredDataRow || !benefitBulletsRow || !technicalSpecsRow || !donorProduct) return null;

  return {
    productId: candidate.productId,
    similarity,
    reference: {
      title: donorProduct.title,
      description: candidate.description,
      benefitBullets: JSON.parse(benefitBulletsRow.proposedValue),
      technicalSpecs: JSON.parse(technicalSpecsRow.proposedValue),
      faq: JSON.parse(faqRow.proposedValue),
      structuredData: JSON.parse(structuredDataRow.proposedValue),
    },
  };
}
