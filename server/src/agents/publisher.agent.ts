import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { enrichmentProposals, products } from "../db/schema.js";
import type { CatalogClient } from "../clients/catalog-types.js";

/** Writes every human-approved proposal of a run back to the active catalog platform (VTEX or
 *  Shopify). Never touches non-approved proposals. */
export async function publishApprovedProposals(params: {
  catalog: CatalogClient;
  runId: number;
}): Promise<{ published: number; failed: number }> {
  const approved = await db.query.enrichmentProposals.findMany({
    where: and(eq(enrichmentProposals.runId, params.runId), eq(enrichmentProposals.status, "approved")),
  });

  // A product with multiple approved proposals (e.g. description + several alt-texts) would
  // otherwise refetch the same row once per proposal — one batched lookup instead.
  const productIds = [...new Set(approved.map((p) => p.productId))];
  const productRows = productIds.length ? await db.query.products.findMany({ where: inArray(products.id, productIds) }) : [];
  const productById = new Map(productRows.map((p) => [p.id, p]));

  let published = 0;
  let failed = 0;

  for (const proposal of approved) {
    try {
      const product = productById.get(proposal.productId);
      if (!product) throw new Error(`Product ${proposal.productId} not found`);

      if (proposal.field === "description") {
        await params.catalog.updateProductDescription(product.vtexProductId, proposal.proposedValue);
      } else if (proposal.field === "alt_text") {
        const { imageId, altText } = JSON.parse(proposal.proposedValue) as { imageId: string; altText: string };
        await params.catalog.updateImageAltText({
          externalId: product.vtexProductId,
          variantId: product.vtexSkuId,
          imageId,
          altText,
        });
      }
      // "faq" e "structured_data" não são campos nativos da plataforma nesta v1 — são
      // apresentados diretamente pela nossa própria camada de storefront/API.

      await db
        .update(enrichmentProposals)
        .set({ status: "published", publishedAt: new Date() })
        .where(eq(enrichmentProposals.id, proposal.id));
      published++;
    } catch (err) {
      console.error(`Failed to publish proposal ${proposal.id}:`, err);
      failed++;
    }
  }

  return { published, failed };
}
