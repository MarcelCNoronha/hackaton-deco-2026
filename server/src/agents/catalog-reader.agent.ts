import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { products } from "../db/schema.js";
import type { CatalogClient } from "../clients/catalog-types.js";

export type ProductRow = typeof products.$inferSelect;

/** Fetches one product from the active catalog platform and upserts the local snapshot. */
export async function syncProduct(catalog: CatalogClient, externalId: string): Promise<ProductRow> {
  const product = await catalog.getProduct(externalId);

  const existing = await db.query.products.findFirst({ where: eq(products.vtexProductId, externalId) });

  const values = {
    platform: catalog.platform,
    vtexProductId: product.externalId,
    vtexSkuId: product.variantId,
    title: product.title,
    description: product.description,
    images: product.images.map((img) => ({ Id: img.id, ImageUrl: img.url, ImageText: img.altText })),
    attributes: product.attributes,
    category: product.category,
    brand: product.brand,
    sku: product.sku,
    url: product.url,
    lastSyncedAt: new Date(),
  };

  if (existing) {
    const [updated] = await db.update(products).set(values).where(eq(products.id, existing.id)).returning();
    return updated;
  }

  const [created] = await db.insert(products).values(values).returning();
  return created;
}

export async function syncCatalogByProductIds(catalog: CatalogClient, externalIds: string[]): Promise<ProductRow[]> {
  const rows: ProductRow[] = [];
  // Sequential on purpose: catalog platform rate limits are per-account, and this runs inside a
  // BullMQ job that already caps overall pipeline concurrency — no need to also parallelize here.
  for (const externalId of externalIds) {
    rows.push(await syncProduct(catalog, externalId));
  }
  return rows;
}
