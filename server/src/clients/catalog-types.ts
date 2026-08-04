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

/** One node of the catalog platform's category tree, with the same "A > B > C" breadcrumb
 *  `products.category` uses (see vtex.client.ts's formatVtexCategoryPath) so per-category tables
 *  (category_spec_fields, category_content_profiles...) can key off it directly. `isLeaf` marks
 *  nodes with no children — where products actually get classified; a branch with no third level
 *  has its second-level node marked leaf instead, so "reference at the Subcategoria, or the
 *  Categoria if there's no Subcategoria" needs no special-casing anywhere else. */
export interface CategoryTreeNode {
  id: string;
  name: string;
  path: string;
  parentPath: string | null;
  level: number;
  isLeaf: boolean;
}

/** A content/specification field the catalog platform accepts for a given category — scoped to
 *  product-level fields only (never price/stock/the category assignment itself, which are separate
 *  APIs entirely; see vtex.client.ts's getCategoryFieldDefinitions doc comment). */
export interface CategoryFieldDefinition {
  id: string;
  name: string;
  isActive: boolean;
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
  testConnection(): Promise<{ ok: boolean; error?: string }>;
  listFilterOptions(): Promise<CatalogFilterOptions>;
  /** Full category tree with breadcrumb paths, for browsing/pre-populating per-category reference
   *  links and profiles ahead of any product actually being synced into that category. Shopify has
   *  no comparable category tree (collections are flat, not hierarchical) — its implementation
   *  always returns `[]`. */
  listCategoryTree(): Promise<CategoryTreeNode[]>;
  /** Which content/specification fields the platform accepts for one category — consulted before
   *  generation so the enrichment prompt never invents an attribute outside this list. VTEX only
   *  (`specification/field/listTreeByCategoryId`); Shopify has no per-category field registry
   *  (its metafields are shop-wide, see getKnownAttributeFields), so its implementation returns
   *  `[]`. */
  getCategoryFieldDefinitions(categoryId: string): Promise<CategoryFieldDefinition[]>;
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
  /** The category/product metafield slots already registered on the platform (e.g. Shopify's
   *  "Category metafields"/"Product metafields" panel) that are SAFE to write blind — scalar types
   *  only (text/number/boolean), never a reference/list type (those need resolving a value to a
   *  taxonomy entry's GID, not attempted here). Consulted BEFORE generation so `attributes_patch`
   *  can target these exact keys instead of inventing arbitrary labels. VTEX has no metafield
   *  concept, so its implementation always returns `[]`. */
  getKnownAttributeFields(): Promise<Array<{ key: string; name: string }>>;
  /** Writes metafield values. Two modes: omit `namespace` to target an ALREADY-REGISTERED
   *  merchant field (only ones `getKnownAttributeFields` returned — resolved by key against the
   *  platform's own definitions, silently skipped if not found/not a safe scalar type; this is
   *  how `attributes_patch` reaches real "Product metafields" slots). Pass `namespace: "catalogia"`
   *  to write our own synthesized data (structured_data, keywords) that has no pre-existing
   *  merchant field, using whatever `key`/`type` we choose. VTEX no-ops either way. */
  updateProductMetafields(
    externalId: string,
    values: Array<{ key: string; value: string; type?: string; namespace?: string }>,
  ): Promise<void>;
  /** Uploads an AI-generated image as a real product photo — `imageUrl` must be a publicly
   *  fetchable URL (both platforms fetch the bytes server-side rather than accepting a direct
   *  upload here), see the `/api/generated-images/:id/raw` route. */
  addProductImage(params: { externalId: string; variantId: string; imageUrl: string; altText?: string }): Promise<void>;
}
