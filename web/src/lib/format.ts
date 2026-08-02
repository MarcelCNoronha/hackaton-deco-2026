/** Shopify ids come as GIDs (e.g. "gid://shopify/Product/123") — this shows just the trailing
 *  numeric id, which is what a merchant actually recognizes as "the SKU/product number". VTEX ids
 *  have no "/" and pass through unchanged. */
export function shortId(id: string): string {
  const parts = id.split("/");
  return parts[parts.length - 1] || id;
}
