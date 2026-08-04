import { and, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { enrichmentProposals } from "../db/schema.js";

/** Earliest moment ANY field of a product was actually published — the pivot that splits "antes"
 *  from "depois" for real Google-data comparison (see impact.agent.ts). A product can be published
 *  across several runs/fields; only the first one matters as the campaign's start date. */
export async function getEarliestPublishedAtByProduct(productIds: number[]): Promise<Map<number, Date>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({ productId: enrichmentProposals.productId, publishedAt: enrichmentProposals.publishedAt })
    .from(enrichmentProposals)
    .where(and(inArray(enrichmentProposals.productId, productIds), isNotNull(enrichmentProposals.publishedAt)));

  const earliest = new Map<number, Date>();
  for (const row of rows) {
    if (!row.publishedAt) continue;
    const current = earliest.get(row.productId);
    if (!current || row.publishedAt < current) earliest.set(row.productId, row.publishedAt);
  }
  return earliest;
}

export async function getEarliestPublishedAt(productId: number): Promise<Date | null> {
  const map = await getEarliestPublishedAtByProduct([productId]);
  return map.get(productId) ?? null;
}
