export type CatalogPlatform = "vtex" | "shopify";

export interface CatalogProductSummary {
  externalId: string;
  title: string;
  imageUrl: string | null;
  /** VTEX: nome da categoria. Shopify: productType. */
  category: string | null;
  /** VTEX: nome da marca. Shopify: vendor. */
  brand: string | null;
  /** Collections this product belongs to, joined with ", " when there's more than one. Shopify:
   *  the product's `collections` connection. VTEX: null for now — the private Collections API
   *  (`GET /api/catalog_system/pvt/collection/...`) needs verifying against a real account before
   *  wiring it up, same discipline as this file's other VTEX endpoints. */
  collection: string | null;
  /** Merchant-assigned SKU code (VTEX: RefId. Shopify: variant sku) — null when unset ("No SKU"). */
  sku: string | null;
  /** Public storefront URL (VTEX: `{account}.{environment}.com.br/{LinkId}/p`. Shopify:
   *  `{shopDomain}/products/{handle}`) — null when the platform didn't return a slug. */
  url: string | null;
}

export interface CatalogProductDetail extends CatalogProductSummary {
  description: string | null;
  /** Internal variant/SKU identifier used for API calls (image updates, etc) — NOT the merchant
   *  SKU code, see `sku` for that. VTEX: numeric SkuId. Shopify: variant GID. */
  variantId: string;
  images: Array<{ id: string; url: string; altText: string | null }>;
  attributes: Record<string, unknown>;
}

export interface CatalogFilterOptions {
  categories: Array<{ id: string; name: string }>;
  brands: Array<{ id: string; name: string }>;
}

export interface CatalogListParams {
  search?: string;
  /** VTEX: category id (tree node). Shopify: Collection id — filters by the same Collections
   *  membership shown in the product list's "Coleção" column, not the productType field. */
  categoryId?: string;
  brandId?: string;
  page: number;
  pageSize: number;
}

export interface CatalogListResult {
  items: CatalogProductSummary[];
  hasMore: boolean;
  total?: number;
}

/** Common surface every catalog platform (VTEX, Shopify) implements — lets the pipeline (catalog
 *  reader, publisher, catalog browsing routes) work without knowing which platform is active. */
export interface CatalogClient {
  readonly platform: CatalogPlatform;
  testConnection(): Promise<boolean>;
  listFilterOptions(): Promise<CatalogFilterOptions>;
  listProducts(params: CatalogListParams): Promise<CatalogListResult>;
  getProduct(externalId: string): Promise<CatalogProductDetail>;
  updateProductDescription(externalId: string, description: string): Promise<void>;
  updateImageAltText(params: {
    externalId: string;
    variantId: string;
    imageId: string;
    altText: string;
  }): Promise<void>;
  /** Publishes the seo_title/meta_description proposals — both platforms have a native field for
   *  these (VTEX: Title/MetaTagDescription on the product record. Shopify: the `seo` input on
   *  productUpdate), unlike structured_data/benefit_bullets which stay in-app only. Either key may
   *  be omitted (only the approved one of the pair is sent). */
  updateProductSeo(externalId: string, seo: { title?: string; metaDescription?: string }): Promise<void>;
  /** Only Shopify has a native tags field on the product — VTEX has no clean equivalent without
   *  touching its category tree, so its implementation is a no-op and `tags` proposals stay
   *  in-app only there (see publisher.agent.ts). */
  updateProductTags(externalId: string, tags: string[]): Promise<void>;
}
