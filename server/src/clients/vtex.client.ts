// VTEX API reference (consultar se precisar validar/estender qualquer endpoint deste arquivo):
// https://developers.vtex.com/docs/api-reference
import { requestWithRetry, NonRetryableHttpError, type RequestLogEntry } from "./http.js";
import type {
  CategoryFieldDefinition,
  CategoryTreeNode,
  CatalogClient,
  CatalogFilterOptions,
  CatalogListParams,
  CatalogListResult,
  CatalogProductDetail,
} from "./catalog-types.js";

export interface VtexCredentials {
  account: string;
  environment: string; // usually "vtexcommercestable"
  appKey: string;
  appToken: string;
  /** The real public storefront hostname (e.g. "www.mundialacabamentos.com.br") — optional
   *  because plenty of accounts never bind a custom domain, but confirmed live that
   *  `{account}.{environment}.com.br` and the Search API's own `link` field BOTH keep reporting
   *  the raw VTEX-hosted domain even for a product on an account that clearly has a working custom
   *  domain (the storefront itself is reachable there) — so there is no reliable way to discover
   *  this from the API alone, it has to be told to us. Falls back to the raw domain when unset. */
  storefrontDomain?: string;
}

export interface VtexProduct {
  Id: number;
  Name: string;
  DepartmentId?: number;
  CategoryId?: number;
  Description?: string;
  /** SEO-friendly URL slug — storefront product page is `{account}.{environment}.com.br/{LinkId}/p`. */
  LinkId?: string;
  [key: string]: unknown;
}

export interface VtexSku {
  Id: number;
  ProductId: number;
  NameComplete?: string;
  /** Merchant-assigned reference code — what a merchant actually calls "the SKU". */
  RefId?: string;
  [key: string]: unknown;
}

/** `/pvt/stockkeepingunit/{id}/file` response shape — the private SKU endpoint itself
 *  (`/pvt/stockkeepingunit/{id}`, see VtexSku) never returns an `Images` field despite that being
 *  the long-standing assumption in this file; confirmed live against a real SKU with 3 real
 *  photos, none of which showed up on that endpoint at all. This is the endpoint that actually
 *  returns them. `FileLocation` omits the account subdomain (`vteximg.com.br/arquivos/...`,
 *  not `{account}.vteximg.com.br/...`) — see fetchSkuFiles. `Label` is a free-text tag the
 *  merchant sets per photo in the admin; this store's own convention uses "2" for the
 *  lifestyle/"foto ambientada" shot, confirmed live (see manufacturer-image.agent.ts's future
 *  ambient-photo sourcing). `Position` is the real, writable field that controls storefront
 *  gallery/carousel order (lower first) — confirmed live: the original catalog photo sits at 0,
 *  while every photo this app has ever uploaded via addProductImage came back at 9999 (VTEX's
 *  apparent "no explicit position given" default), regardless of its Label — see
 *  reorderImagesByLabel. */
interface VtexSkuFile {
  Id: number;
  ArchiveId: number;
  Name: string;
  IsMain: boolean;
  Text?: string;
  Label?: string;
  FileLocation: string;
  Position: number;
}

interface VtexSearchProduct {
  productId: string;
  productName: string;
  description?: string;
  brand?: string;
  categories?: string[];
  /** Full storefront URL — the public Search API returns this ready-made, unlike the private
   *  Catalog API (which only has the `LinkId` slug, see VtexProduct). */
  link?: string;
  linkText?: string;
  /** Names of every category-level specification field ("Características"/"Especificações" in
   *  the admin) that has a value on this product — each name is ALSO a top-level property on this
   *  same object (e.g. `allSpecifications: ["Material"]` implies `Material: ["Liga de Cobre..."]`),
   *  a long-standing documented behavior of this Search API. Empty fields (never filled in the
   *  admin) simply don't appear here at all. */
  allSpecifications?: string[];
  items?: Array<{
    itemId: string;
    referenceId?: Array<{ Key: string; Value: string }> | string;
    images?: Array<{ imageId?: string; imageUrl: string; imageText?: string }>;
  }>;
  [key: string]: unknown;
}

/** `allSpecifications` lists which spec fields have a value; each name doubles as a top-level
 *  property holding that field's value(s) as a string array — collapses single-value arrays to a
 *  plain string since that's how virtually every VTEX spec field is actually used in practice. */
function extractVtexSpecifications(p: VtexSearchProduct): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const name of p.allSpecifications ?? []) {
    const values = p[name];
    if (!Array.isArray(values) || values.length === 0) continue;
    attributes[name] = values.length === 1 ? values[0] : values;
  }
  return attributes;
}

/** VTEX organizes its catalog around a category TREE (not a flat collection list, unlike
 *  Shopify) — `categories` here is a slash-separated breadcrumb like "/Casa/Banheiro/Torneiras/".
 *  Returns the full path (e.g. "Casa > Banheiro > Torneiras") rather than just the leaf name, so
 *  a synced product's category carries real hierarchy context (useful both for display and as
 *  extra context handed to the content-enrichment LLM prompt). */
function formatVtexCategoryPath(categories?: string[]): string | null {
  const path = categories?.[0]?.replace(/^\/|\/$/g, "");
  return path ? path.split("/").join(" > ") : null;
}

export interface VtexCategoryTreeNode {
  id: number;
  name: string;
  children?: VtexCategoryTreeNode[];
}

function normalizeVtexCategoryFacetValue(categoryId: string): string {
  return categoryId.trim().replace(/^\/+|\/+$/g, "");
}

export function normalizeVtexStorefrontUrl(url: string | null, credentials: VtexCredentials): string | null {
  const storefrontDomain = credentials.storefrontDomain?.trim();
  if (!url || !storefrontDomain) return url;

  try {
    const parsed = new URL(url);
    const rawHost = `${credentials.account}.${credentials.environment}.com.br`;
    if (parsed.hostname !== rawHost) return url;
    parsed.hostname = storefrontDomain;
    return parsed.toString();
  } catch {
    return url;
  }
}

export function buildVtexCategoryFilterOptions(tree: VtexCategoryTreeNode[]): Array<{ id: string; name: string }> {
  const categories: Array<{ id: string; name: string }> = [];
  const walk = (nodes: VtexCategoryTreeNode[], parentPath: string | null, parentIds: string[]) => {
    for (const node of nodes) {
      const path = parentPath ? `${parentPath} > ${node.name}` : node.name;
      const ids = [...parentIds, String(node.id)];
      // VTEX Search only accepts a plain id for level 1. Category/subcategory filters need the
      // full ancestor id path, e.g. C:6/13/43, otherwise they return zero products.
      categories.push({ id: ids.join("/"), name: path });
      if (node.children?.length) walk(node.children, path, ids);
    }
  };
  walk(tree, null, []);
  return categories;
}

export function resolveVtexCategoryFacetValue(categoryId: string, tree: VtexCategoryTreeNode[]): string {
  const normalized = normalizeVtexCategoryFacetValue(categoryId);
  if (!normalized || normalized.includes("/")) return normalized;

  let resolved: string | null = null;
  const walk = (nodes: VtexCategoryTreeNode[], parentIds: string[]) => {
    for (const node of nodes) {
      const ids = [...parentIds, String(node.id)];
      if (String(node.id) === normalized) {
        resolved = ids.join("/");
        return;
      }
      if (node.children?.length) walk(node.children, ids);
      if (resolved) return;
    }
  };
  walk(tree, []);
  return resolved ?? normalized;
}

interface VtexBrand {
  id: number;
  name: string;
  isActive?: boolean;
}

/** `GET/PUT /pvt/category/{id}` full record shape — see updateCategoryContent's doc comment for
 *  which 3 fields this app actually writes; every other key is preserved as-is via the GET-then-PUT
 *  merge, never read/interpreted here. */
interface VtexCategoryRecord {
  Id: number;
  Name: string;
  Title?: string;
  MetaTagDescription?: string;
  KeyWords?: string;
  [key: string]: unknown;
}

/** `GET/PUT /pvt/brand/{id}` full record shape — same "preserve everything else via merge" role as
 *  VtexCategoryRecord, see updateBrandContent's doc comment. */
interface VtexBrandRecord {
  Id: number;
  Name: string;
  Title?: string;
  MetaTagDescription?: string;
  KeyWords?: string;
  [key: string]: unknown;
}

/** Response shape of `specification/field/listTreeByCategoryId/{categoryId}` — `CategoryId` is
 *  usually null (the field is inherited from a group, not tied directly to this category), and
 *  `IsStockKeepingUnit` distinguishes SKU-level fields (VTEX allows registering specs at either
 *  level) from product-level ones, see getCategoryFieldDefinitions. */
interface VtexSpecificationField {
  Name: string;
  CategoryId: number | null;
  FieldId: number;
  IsActive: boolean;
  IsStockKeepingUnit: boolean;
}

/** The legacy Search API represents a SKU's reference code either as a plain string or as a
 *  {Key,Value} facet array (varies by account/version) — handle both rather than guessing one. */
function extractVtexReferenceId(referenceId: Array<{ Key: string; Value: string }> | string | undefined): string | null {
  if (!referenceId) return null;
  if (typeof referenceId === "string") return referenceId;
  return referenceId[0]?.Value ?? null;
}

/**
 * Thin client for the VTEX Catalog API — only HTTP calls, no business logic. Implements the
 * platform-agnostic CatalogClient so the pipeline/browsing routes don't need VTEX-specific code.
 * NOTE: exact field names for the private Catalog API (product/SKU) were validated against the
 * account's live API in earlier testing; the public Search API used for listProducts/
 * listFilterOptions (added for the VTEX/Shopify platform selector) follows VTEX's documented
 * legacy Search API shape but hasn't been exercised against a real account yet — worth a quick
 * smoke test once VTEX access is restored.
 */
export class VtexClient implements CatalogClient {
  readonly platform = "vtex" as const;
  private readonly host: string;
  private readonly baseUrl: string;
  private readonly searchBaseUrl: string;
  /** Storefront-facing hostname — see VtexCredentials.storefrontDomain's doc comment for why this
   *  can't just be `this.host` (the API host) or trusted from the Search API's own `link` field. */
  private readonly storefrontHost: string;

  constructor(
    private readonly credentials: VtexCredentials,
    private readonly onAttempt?: (entry: RequestLogEntry) => void | Promise<void>,
  ) {
    this.host = `${credentials.account}.${credentials.environment}.com.br`;
    this.baseUrl = `https://${this.host}/api/catalog`;
    this.searchBaseUrl = `https://${this.host}/api/catalog_system/pub`;
    this.storefrontHost = credentials.storefrontDomain?.trim() || this.host;
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-VTEX-API-AppKey": this.credentials.appKey,
      "X-VTEX-API-AppToken": this.credentials.appToken,
    };
  }

  private async fetchProduct(productId: string | number): Promise<VtexProduct> {
    const res = await requestWithRetry({
      provider: "vtex",
      operation: "getProduct",
      url: `${this.baseUrl}/pvt/product/${productId}`,
      init: { method: "GET", headers: this.headers() },
      onAttempt: this.onAttempt,
    });
    return (await res.json()) as VtexProduct;
  }

  /** The private product endpoint (fetchProduct, `/pvt/product/{id}`) does NOT reliably return a
   *  `SkuIds` field — confirmed live: a real product with real photos on `{account}.vteximg.com.br`
   *  still came back with no `SkuIds` key at all in the response. This is the endpoint that
   *  actually works for resolving a product's SKU id(s), used as getProduct's only source of truth
   *  now instead of the ad-hoc `product.SkuIds?.[0]` that silently never matched anything. Never
   *  throws: same "don't fail the whole sync over an image lookup" reasoning as
   *  fetchProductSpecifications — an empty array just means getProduct's `images` stays empty. */
  private async fetchSkuIdsByProductId(productId: string | number): Promise<number[]> {
    try {
      const res = await requestWithRetry({
        provider: "vtex",
        operation: "getSkuIdsByProductId",
        url: `https://${this.host}/api/catalog_system/pvt/sku/stockkeepingunitByProductId/${productId}`,
        init: { method: "GET", headers: this.headers() },
        onAttempt: this.onAttempt,
      });
      const skus = ((await res.json()) as Array<{ Id: number }>) ?? [];
      return skus.map((s) => s.Id);
    } catch (err) {
      console.error(`VTEX getSkuIdsByProductId failed for product ${productId} — continuing with no SKU`, err);
      return [];
    }
  }

  private async fetchSku(skuId: string | number): Promise<VtexSku> {
    const res = await requestWithRetry({
      provider: "vtex",
      operation: "getSku",
      url: `${this.baseUrl}/pvt/stockkeepingunit/${skuId}`,
      init: { method: "GET", headers: this.headers() },
      onAttempt: this.onAttempt,
    });
    return (await res.json()) as VtexSku;
  }

  /** See VtexSkuFile's doc comment — the real source of a SKU's photos. Never throws: same
   *  "don't fail the whole sync over an image lookup" reasoning as fetchProductSpecifications. */
  private async fetchSkuFiles(skuId: string | number): Promise<VtexSkuFile[]> {
    try {
      const res = await requestWithRetry({
        provider: "vtex",
        operation: "getSkuFiles",
        url: `${this.baseUrl}/pvt/stockkeepingunit/${skuId}/file`,
        init: { method: "GET", headers: this.headers() },
        onAttempt: this.onAttempt,
      });
      return ((await res.json()) as VtexSkuFile[]) ?? [];
    } catch (err) {
      console.error(`VTEX getSkuFiles failed for SKU ${skuId} — continuing with no images`, err);
      return [];
    }
  }

  /** The private Catalog API (fetchProduct/fetchSku) never returns category-level specification
   *  values ("Características"/"Especificações" in the admin — real specs like Material, Acabamento,
   *  dimensões) nor the brand NAME (only fetchProduct's numeric BrandId) — only the public Search
   *  API has both, as dynamic per-product fields (see extractVtexSpecifications). Reuses that same
   *  endpoint/auth as listProducts, filtered down to this one product. Never throws: a lookup
   *  failing shouldn't fail the whole product sync, it just means the LLM falls back to whatever's
   *  in the free-text description (and brand stays unset), same as before this existed. */
  private async fetchProductSpecifications(
    productId: string | number,
  ): Promise<{ attributes: Record<string, unknown>; brand: string | null; category: string | null; url: string | null }> {
    try {
      const res = await requestWithRetry({
        provider: "vtex",
        operation: "getProductSpecifications",
        url: `${this.searchBaseUrl}/products/search?fq=productId:${productId}`,
        init: { method: "GET", headers: this.headers() },
        onAttempt: this.onAttempt,
      });
      const items = ((await res.json()) as VtexSearchProduct[]) ?? [];
      const item = items[0];
      return {
        attributes: item ? extractVtexSpecifications(item) : {},
        brand: item?.brand ?? null,
        category: formatVtexCategoryPath(item?.categories),
        // Built from storefrontHost + linkText, NOT `item.link` — confirmed live that `link` keeps
        // reporting the raw `{account}.{environment}.com.br` domain even for a product on an
        // account with a working custom domain (the storefront itself is reachable there), so it
        // can't be trusted as "the real shopper-facing URL". See VtexCredentials.storefrontDomain.
        url: item?.linkText ? `https://${this.storefrontHost}/${item.linkText}/p` : normalizeVtexStorefrontUrl(item?.link ?? null, this.credentials),
      };
    } catch (err) {
      console.error(`VTEX getProductSpecifications failed for product ${productId} — continuing with empty attributes`, err);
      return { attributes: {}, brand: null, category: null, url: null };
    }
  }

  /** Composes the private product+SKU endpoints into the platform-agnostic detail shape —
   *  treats the first SKU's images as "the" product images, same simplification the pipeline
   *  already relied on before this abstraction existed. */
  async getProduct(externalId: string): Promise<CatalogProductDetail> {
    const [product, skuIds] = await Promise.all([this.fetchProduct(externalId), this.fetchSkuIdsByProductId(externalId)]);
    const skuId = skuIds[0];
    const [sku, files, { attributes, brand, category, url }] = await Promise.all([
      skuId ? this.fetchSku(skuId) : Promise.resolve(undefined),
      skuId ? this.fetchSkuFiles(skuId) : Promise.resolve([]),
      this.fetchProductSpecifications(externalId),
    ]);
    // FileLocation omits the account subdomain (see VtexSkuFile's doc comment) — this is the
    // same {account}.vteximg.com.br host every other VTEX-hosted image on this store already uses.
    const images = [...files].sort((a, b) => (a.IsMain === b.IsMain ? 0 : a.IsMain ? -1 : 1));

    return {
      externalId: String(product.Id),
      title: product.Name,
      description: product.Description ?? null,
      // Falls back to the raw numeric id only if the search-API lookup above failed entirely —
      // still better than nothing, but category (unlike brand) is virtually always resolved since
      // every real product has to sit somewhere in the tree.
      category: category ?? (product.CategoryId ? String(product.CategoryId) : null),
      brand,
      // VTEX organizes by category tree, not a flat collection list like Shopify — its actual
      // Collections module (grupos de coleções) needs its own private-API lookup, not yet verified
      // against a live account (no VTEX connection available to test against right now).
      collection: null,
      sku: sku?.RefId ?? null,
      // Falls back to storefrontHost + the private product's own LinkId only if the search-API
      // lookup above failed entirely (see fetchProductSpecifications) — still better than nothing.
      url: url ?? (product.LinkId ? `https://${this.storefrontHost}/${product.LinkId}/p` : null),
      imageUrl: images[0] ? `https://${this.credentials.account}.${images[0].FileLocation}` : null,
      variantId: sku ? String(sku.Id) : "",
      images: images.map((img) => ({
        id: String(img.Id),
        url: `https://${this.credentials.account}.${img.FileLocation}`,
        altText: img.Text?.trim() || null,
        // This store's own convention for the lifestyle/"foto ambientada" shot — see
        // VtexSkuFile's doc comment. Null on any account that doesn't use this convention.
        label: img.Label ?? null,
      })),
      attributes,
    };
  }

  /** Uses the same free-text/category/brand facets as VTEX's own storefront search — the public
   *  Search API, which (unlike the private Catalog API) supports listing/filtering directly. */
  async listProducts(params: CatalogListParams): Promise<CatalogListResult> {
    const from = (params.page - 1) * params.pageSize;
    const to = from + params.pageSize - 1;
    const query = new URLSearchParams({ _from: String(from), _to: String(to) });
    if (params.search) query.set("ft", params.search);
    if (params.categoryId) query.append("fq", `C:${await this.resolveCategoryFacetValue(params.categoryId)}`);
    if (params.brandId) query.append("fq", `B:${params.brandId}`);

    const res = await requestWithRetry({
      provider: "vtex",
      operation: "listProducts",
      url: `${this.searchBaseUrl}/products/search?${query.toString()}`,
      init: { method: "GET", headers: this.headers() },
      onAttempt: this.onAttempt,
    });
    const items = ((await res.json()) as VtexSearchProduct[]) ?? [];
    const totalHeader = res.headers.get("resources");
    const total = totalHeader ? Number(totalHeader.split("/")[1]) : undefined;

    return {
      items: items.map((p) => ({
        externalId: p.productId,
        title: p.productName,
        imageUrl: p.items?.[0]?.images?.[0]?.imageUrl ?? null,
        category: formatVtexCategoryPath(p.categories),
        brand: p.brand ?? null,
        collection: null, // see getProduct's comment — VTEX Collections not wired up yet
        sku: extractVtexReferenceId(p.items?.[0]?.referenceId),
        // See fetchProductSpecifications' comment — `link` isn't trustworthy, storefrontHost + the
        // reliable `linkText` is.
        url: p.linkText ? `https://${this.storefrontHost}/${p.linkText}/p` : normalizeVtexStorefrontUrl(p.link ?? null, this.credentials),
      })),
      hasMore: items.length === params.pageSize,
      total,
    };
  }

  /** VTEX's category tree is 3 levels deep (Departamento > Categoria > Subcategoria) — shared by
   *  listFilterOptions (flat {id,name} for filter dropdowns) and listCategoryTree (breadcrumb path
   *  + leaf detection for per-category reference/profile UIs). One fetch, two shapes. */
  private async fetchCategoryTree(): Promise<VtexCategoryTreeNode[]> {
    const res = await requestWithRetry({
      provider: "vtex",
      operation: "listCategoryTree",
      url: `${this.searchBaseUrl}/category/tree/3`,
      init: { method: "GET", headers: this.headers() },
      onAttempt: this.onAttempt,
    });
    return ((await res.json()) as VtexCategoryTreeNode[]) ?? [];
  }

  private async resolveCategoryFacetValue(categoryId: string): Promise<string> {
    const normalized = normalizeVtexCategoryFacetValue(categoryId);
    if (!normalized || normalized.includes("/")) return normalized;

    try {
      return resolveVtexCategoryFacetValue(normalized, await this.fetchCategoryTree());
    } catch (err) {
      console.error(`VTEX category filter path lookup failed for category ${categoryId} - falling back to raw value`, err);
      return normalized;
    }
  }

  async listFilterOptions(): Promise<CatalogFilterOptions> {
    const [tree, brandRes] = await Promise.all([
      this.fetchCategoryTree(),
      requestWithRetry({
        provider: "vtex",
        operation: "listBrands",
        url: `${this.searchBaseUrl}/brand/list`,
        init: { method: "GET", headers: this.headers() },
        onAttempt: this.onAttempt,
      }),
    ]);

    const brands = ((await brandRes.json()) as VtexBrand[]) ?? [];

    return {
      categories: buildVtexCategoryFilterOptions(tree),
      brands: brands.filter((b) => b.isActive !== false).map((b) => ({ id: String(b.id), name: b.name })),
    };
  }

  /** Walks the same 3-level tree as listFilterOptions, but keeps the breadcrumb ("Casa > Banheiro
   *  > Torneiras") and leaf-ness of each node instead of flattening to {id,name} — see
   *  CategoryTreeNode's doc comment for why this exact shape matters (matches products.category,
   *  resolves the "reference at Subcategoria, or Categoria if no Subcategoria" fallback for free). */
  async listCategoryTree(): Promise<CategoryTreeNode[]> {
    const tree = await this.fetchCategoryTree();
    const nodes: CategoryTreeNode[] = [];
    const walk = (children: VtexCategoryTreeNode[], parentPath: string | null, level: number) => {
      for (const node of children) {
        const path = parentPath ? `${parentPath} > ${node.name}` : node.name;
        const isLeaf = !node.children?.length;
        nodes.push({ id: String(node.id), name: node.name, path, parentPath, level, isLeaf });
        if (node.children?.length) walk(node.children, path, level + 1);
      }
    };
    walk(tree, null, 1);
    return nodes;
  }

  /** `specification/field/listTreeByCategoryId` (NOT `listByCategoryId`, which was found empty
   *  against a real account even for categories with fields configured in the admin UI —
   *  `listTreeByCategoryId` is the one that actually returns them) — the content/spec fields VTEX
   *  accepts for a category, e.g. "Material"/"Garantia"/"Acabamento". Filtered to
   *  `IsStockKeepingUnit === false` only: these fields live on the PRODUCT, not the SKU (SKUs are
   *  just the product's variations) — SKU-level fields aren't relevant to product-description
   *  generation. Never includes price, stock, or the category assignment itself — those are
   *  entirely separate VTEX APIs, not part of this "specification" module at all, so this feature
   *  can't accidentally expose them as editable. */
  async getCategoryFieldDefinitions(categoryId: string): Promise<CategoryFieldDefinition[]> {
    const res = await requestWithRetry({
      provider: "vtex",
      operation: "listCategorySpecificationFields",
      url: `${this.searchBaseUrl}/specification/field/listTreeByCategoryId/${categoryId}`,
      init: { method: "GET", headers: this.headers() },
      onAttempt: this.onAttempt,
    });
    const fields = ((await res.json()) as VtexSpecificationField[]) ?? [];
    return fields
      .filter((f) => f.IsActive && !f.IsStockKeepingUnit)
      .map((f) => ({ id: String(f.FieldId), name: f.Name, isActive: f.IsActive }));
  }

  async updateImageAltText(params: {
    externalId: string;
    variantId: string;
    imageId: string;
    altText: string;
  }): Promise<void> {
    await this.updateSkuFile(params.variantId, params.imageId, { text: params.altText });
  }

  /** Re-labels an image already on the platform (this store's own carousel-slot convention — see
   *  photoClassificationEnum) without re-uploading it — e.g. a merchant's pre-existing catalog
   *  photo that was never assigned a Label at all. */
  async updateImageLabel(params: { externalId: string; variantId: string; imageId: string; label: string }): Promise<void> {
    await this.updateSkuFile(params.variantId, params.imageId, { label: params.label });
  }

  /** Composes a SKU's photo carousel to be EXACTLY this store's classified selection (confirmed
   *  explicit product requirement, 2026-08-05): every file whose Label is a plain number
   *  (1=principal, 2=ambientada, 3=dimensional, 4+=destaque) gets reordered to match via its real
   *  `Position` field (see VtexSkuFile's doc comment for how that was confirmed live); every file
   *  with NO Label (or a non-numeric one) is DELETED from the platform outright, not just skipped —
   *  the carousel a shopper sees should only ever contain what was deliberately classified here.
   *  Safety guard: if not a single file has a numeric Label yet (nothing classified), this refuses
   *  to delete anything and throws instead — a real product's whole gallery going to zero photos
   *  because nothing was classified yet would be worse than a stale carousel. Best-effort per file
   *  beyond that check — one file's write/delete failing (e.g. a transient network blip) doesn't
   *  stop the rest from being processed. */
  async reorderImagesByLabel(params: { externalId: string; variantId: string }): Promise<void> {
    const files = await this.fetchSkuFiles(params.variantId);
    const classified = files.filter((f) => f.Label && /^\d+$/.test(f.Label));
    const unclassified = files.filter((f) => !f.Label || !/^\d+$/.test(f.Label));
    if (classified.length === 0 && unclassified.length > 0) {
      throw new Error(
        `Nenhuma foto do SKU ${params.variantId} está classificada ainda — recusando remover as ${unclassified.length} foto(s) sem Label para não deixar o anúncio sem nenhuma imagem.`,
      );
    }

    for (const file of classified) {
      const position = Number(file.Label);
      if (file.Position === position) continue;
      try {
        await requestWithRetry({
          provider: "vtex",
          operation: "reorderSkuFile",
          url: `${this.baseUrl}/pvt/stockkeepingunit/${params.variantId}/file/${file.Id}`,
          init: {
            method: "PUT",
            headers: this.headers(),
            body: JSON.stringify({
              Url: `https://${this.credentials.account}.${file.FileLocation}`,
              Text: file.Text ?? "",
              Label: file.Label,
              IsMain: file.IsMain,
              Position: position,
            }),
          },
          onAttempt: this.onAttempt,
        });
      } catch (err) {
        console.error(`Failed to reorder SKU ${params.variantId} file ${file.Id} (Label ${file.Label}) to Position ${position}:`, err);
      }
    }

    for (const file of unclassified) {
      try {
        await this.deleteImage({ externalId: params.externalId, variantId: params.variantId, imageId: String(file.Id) });
      } catch (err) {
        console.error(`Failed to delete unclassified SKU ${params.variantId} file ${file.Id}:`, err);
      }
    }
  }

  /** Permanently removes one photo from the platform — confirmed against VTEX's own API reference
   *  (`DELETE /api/catalog/pvt/stockkeepingunit/{skuId}/file/{skuFileId}`, "Delete SKU image
   *  file") before ever calling it against a real account, given how irreversible this is. Used
   *  both by reorderImagesByLabel's unclassified cleanup and by a human explicitly deleting a
   *  photo from CatalogIA's own "Fotos" panel (see products.routes.ts). */
  async deleteImage(params: { externalId: string; variantId: string; imageId: string }): Promise<void> {
    await requestWithRetry({
      provider: "vtex",
      operation: "deleteSkuFile",
      url: `${this.baseUrl}/pvt/stockkeepingunit/${params.variantId}/file/${params.imageId}`,
      init: { method: "DELETE", headers: this.headers() },
      onAttempt: this.onAttempt,
    });
  }

  /** `PUT /pvt/product/{id}` is NOT a partial update — VTEX does not merge, it replaces. Fields
   *  omitted from the body can come back blank (Title, LinkId, MetaTagDescription, etc.), a
   *  well-known footgun on this endpoint. So every write here fetches the CURRENT full product
   *  first and PUTs it back merged with only the intended change, instead of a bare partial body —
   *  load-bearing on a real production catalog, not just tidiness. */
  private async updateProductFields(productId: string | number, patch: Partial<VtexProduct>): Promise<void> {
    const current = await this.fetchProduct(productId);
    await requestWithRetry({
      provider: "vtex",
      operation: "updateProductFields",
      url: `${this.baseUrl}/pvt/product/${productId}`,
      init: {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({ ...current, ...patch }),
      },
      onAttempt: this.onAttempt,
    });
  }

  async updateProductDescription(productId: string | number, description: string): Promise<void> {
    await this.updateProductFields(productId, { Description: description });
  }

  async updateProductSeo(productId: string | number, seo: { title?: string; metaDescription?: string }): Promise<void> {
    const patch: Partial<VtexProduct> = {};
    if (seo.title) patch.Title = seo.title;
    if (seo.metaDescription) patch.MetaTagDescription = seo.metaDescription;
    if (Object.keys(patch).length === 0) return;

    await this.updateProductFields(productId, patch);
  }

  /** VTEX has no clean native "tags" field without touching its category tree — tags proposals
   *  stay in-app only on this platform, see CatalogClient's doc comment. */
  async updateProductTags(): Promise<void> {}

  /** `KeyWords` — confirmed live against a real account's `GET /pvt/product/{id}` response (present
   *  as an empty string on an unpublished product), matching the "Palavras similares" field shown
   *  in the VTEX admin's Frente de loja tab. */
  async updateProductKeywords(productId: string | number, keywords: string): Promise<void> {
    await this.updateProductFields(productId, { KeyWords: keywords });
  }

  /** `GET /pvt/product/{id}/specification` — every specification value currently set on the
   *  product, keyed by FieldId. Used by updateProductSpecificationValues to decide what's actually
   *  missing; never throws (a lookup failure just means the safety filter below treats nothing as
   *  "already set", same fail-safe direction as fetchProductSpecifications). */
  private async fetchCurrentSpecificationValues(productId: string | number): Promise<Map<number, string>> {
    try {
      const res = await requestWithRetry({
        provider: "vtex",
        operation: "getProductSpecificationValues",
        url: `${this.baseUrl}/pvt/product/${productId}/specification`,
        init: { method: "GET", headers: this.headers() },
        onAttempt: this.onAttempt,
      });
      const rows = ((await res.json()) as Array<{ FieldId: number; Text: string | null }>) ?? [];
      return new Map(rows.map((r) => [r.FieldId, r.Text ?? ""]));
    } catch (err) {
      console.error(`VTEX getProductSpecificationValues failed for product ${productId} — treating all fields as unset`, err);
      return new Map();
    }
  }

  /** `PUT /pvt/product/{id}/specificationvalue` with `{FieldId, FieldValues}` — validated live
   *  against a real account/product: correctly reuses the field's existing value row (no
   *  duplicate) when `FieldId` names the SAME field already on the product. One request per field
   *  — the endpoint takes exactly one FieldId per call, not a batch. Deliberately does NOT accept
   *  `FieldName` as an alternative key: tried live first, and it matched/created an unrelated field
   *  sharing the same display name in a different field group instead of updating the intended one,
   *  duplicating the spec on the product — confirmed and reverted before ever trusting this path.
   *
   *  Only fills fields that are CURRENTLY EMPTY — explicit product requirement ("só permitir
   *  aumentar, nunca diminuir o número de especificações"): never overwrites a value a merchant (or
   *  a previous run) already set, so this can only grow the count of filled specs, never replace or
   *  effectively erase one with a worse/different value. */
  async updateProductSpecificationValues(
    productId: string | number,
    values: Array<{ fieldId: string; value: string }>,
  ): Promise<void> {
    const current = await this.fetchCurrentSpecificationValues(productId);
    const toWrite = values.filter(({ fieldId }) => !current.get(Number(fieldId))?.trim());

    for (const { fieldId, value } of toWrite) {
      await requestWithRetry({
        provider: "vtex",
        operation: "updateProductSpecificationValue",
        url: `${this.baseUrl}/pvt/product/${productId}/specificationvalue`,
        init: {
          method: "PUT",
          headers: this.headers(),
          body: JSON.stringify({ FieldId: Number(fieldId), FieldValues: [value] }),
        },
        onAttempt: this.onAttempt,
      });
    }
  }

  /** VTEX has no metafield concept — attribute normalization / structured_data / keywords stay
   *  in-app only on this platform. */
  async getKnownAttributeFields(): Promise<Array<{ key: string; name: string }>> {
    return [];
  }

  async updateProductMetafields(): Promise<void> {}

  private async fetchCategoryContent(categoryId: string): Promise<VtexCategoryRecord> {
    const res = await requestWithRetry({
      provider: "vtex",
      operation: "getCategoryContent",
      url: `${this.baseUrl}/pvt/category/${categoryId}`,
      init: { method: "GET", headers: this.headers() },
      onAttempt: this.onAttempt,
    });
    return (await res.json()) as VtexCategoryRecord;
  }

  /** Same "not a partial update" footgun as updateProductFields (`PUT /pvt/category/{id}` replaces
   *  the whole record) — fetches the current category first and PUTs it back merged with only the
   *  intended change, so fields this app never touches (ParentCategoryId, IsActive, the "Menu"/
   *  "Filtro de marca" flags, GlobalCategoryId...) don't come back blank. Field mapping confirmed
   *  live against the real admin (Catálogo > Categorias > Editar categoria): "Título da página
   *  (Title Tag)"→Title, "Descrição da categoria (meta tag de descrição)"→MetaTagDescription,
   *  "Palavras similares"→KeyWords — same field name VTEX already uses for this exact "palavras
   *  similares" concept on the product record (see updateProductKeywords). There is no separate
   *  long-form body/description field on this screen — MetaTagDescription is the only "Descrição"
   *  this app can write here. */
  async updateCategoryContent(categoryId: string, patch: { title?: string; description?: string; keywords?: string }): Promise<void> {
    const current = await this.fetchCategoryContent(categoryId);
    const next: Partial<VtexCategoryRecord> = {};
    if (patch.title !== undefined) next.Title = patch.title;
    if (patch.description !== undefined) next.MetaTagDescription = patch.description;
    if (patch.keywords !== undefined) next.KeyWords = patch.keywords;
    await requestWithRetry({
      provider: "vtex",
      operation: "updateCategoryContent",
      url: `${this.baseUrl}/pvt/category/${categoryId}`,
      init: { method: "PUT", headers: this.headers(), body: JSON.stringify({ ...current, ...next }) },
      onAttempt: this.onAttempt,
    });
  }

  private async fetchBrandContent(brandId: string): Promise<VtexBrandRecord> {
    const res = await requestWithRetry({
      provider: "vtex",
      operation: "getBrandContent",
      url: `${this.baseUrl}/pvt/brand/${brandId}`,
      init: { method: "GET", headers: this.headers() },
      onAttempt: this.onAttempt,
    });
    return (await res.json()) as VtexBrandRecord;
  }

  /** Same GET-then-merge-then-PUT technique as updateCategoryContent, `PUT /pvt/brand/{id}` (the
   *  single-entity endpoint under `catalog`, distinct from the `catalog_system/pvt/brand/list`
   *  listFilterOptions() reads from to resolve a brand name to this id — see page-publisher.agent.ts).
   *  Field mapping confirmed live against the real admin (Conteúdo > Marcas > Editar marca):
   *  "Título da página da marca (Title Tag)"→Title, "Descrição da marca (meta tag de
   *  descrição)"→MetaTagDescription, "Palavras similares"→KeyWords — same 3-field shape as
   *  updateCategoryContent, confirmed independently on this separate admin screen. */
  async updateBrandContent(brandId: string, patch: { title?: string; description?: string; keywords?: string }): Promise<void> {
    const current = await this.fetchBrandContent(brandId);
    const next: Partial<VtexBrandRecord> = {};
    if (patch.title !== undefined) next.Title = patch.title;
    if (patch.description !== undefined) next.MetaTagDescription = patch.description;
    if (patch.keywords !== undefined) next.KeyWords = patch.keywords;
    await requestWithRetry({
      provider: "vtex",
      operation: "updateBrandContent",
      url: `${this.baseUrl}/pvt/brand/${brandId}`,
      init: { method: "PUT", headers: this.headers(), body: JSON.stringify({ ...current, ...next }) },
      onAttempt: this.onAttempt,
    });
  }

  /** Attaches a new SKU image by URL (VTEX fetches the bytes itself from `Url` — no direct binary
   *  upload here, same as the Shopify implementation). Unlike `updateSkuImageAltText` (PUT, edits
   *  an existing image), this is a POST — VTEX creates a new file entry. Returns that new file's
   *  own id (persisted as generatedImages.platformImageId) so this exact upload can later be
   *  recognized among the product's platform photos (URL comparison doesn't work — VTEX rewrites
   *  it to its own CDN host on read, confirmed live) and re-labeled/cleared directly. */
  async addProductImage(params: {
    externalId: string;
    variantId: string;
    imageUrl: string;
    altText?: string;
    label?: string;
  }): Promise<{ id: string }> {
    const res = await requestWithRetry({
      provider: "vtex",
      operation: "addProductImage",
      url: `${this.baseUrl}/pvt/stockkeepingunit/${params.variantId}/file`,
      init: {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ IsMain: false, Label: params.label ?? "", Text: params.altText ?? "", Url: params.imageUrl }),
      },
      onAttempt: this.onAttempt,
    });
    const created = (await res.json()) as { Id: number };
    return { id: String(created.Id) };
  }

  /** `Videos` is a plain string array field directly on the SKU record (`GET/PUT
   *  /pvt/stockkeepingunit/{id}`, same endpoint fetchSku already reads) — confirmed live 2026-08-07
   *  against a real account: added a test URL through the admin's own "Vídeos" section (next to
   *  Imagens, under Mídias), then GET the SKU and found it verbatim in `Videos`. Same "not a partial
   *  update" footgun as updateProductFields — fetches the current SKU first and PUTs it back with
   *  only `Videos` changed, so an unguarded write doesn't blank out Name/RefId/dimensions/etc. VTEX
   *  doesn't eagerly validate or download the URL (confirmed: an unreachable test URL was accepted
   *  without error), so this can't itself confirm the video plays — same trust level as the URL
   *  being publicly fetchable at all, which is the caller's job (APP_BASE_URL check in the route). */
  async addProductVideo(params: { externalId: string; variantId: string; videoUrl: string }): Promise<{ id: string | null }> {
    const current = await this.fetchSku(params.variantId);
    const existing = Array.isArray(current.Videos) ? (current.Videos as string[]) : [];
    if (!existing.includes(params.videoUrl)) {
      await requestWithRetry({
        provider: "vtex",
        operation: "addProductVideo",
        url: `${this.baseUrl}/pvt/stockkeepingunit/${params.variantId}`,
        init: { method: "PUT", headers: this.headers(), body: JSON.stringify({ ...current, Videos: [...existing, params.videoUrl] }) },
        onAttempt: this.onAttempt,
      });
    }
    return { id: null };
  }

  /** No per-entry id for a `Videos` array member (see addProductVideo) — removal filters the array
   *  by exact URL match instead. `videoId` is ignored (Shopify-only concept), kept in the shared
   *  signature so callers don't need platform-specific branching. */
  async removeProductVideo(params: { externalId: string; variantId: string; videoUrl: string }): Promise<void> {
    const current = await this.fetchSku(params.variantId);
    const existing = Array.isArray(current.Videos) ? (current.Videos as string[]) : [];
    const next = existing.filter((url) => url !== params.videoUrl);
    if (next.length === existing.length) return;
    await requestWithRetry({
      provider: "vtex",
      operation: "removeProductVideo",
      url: `${this.baseUrl}/pvt/stockkeepingunit/${params.variantId}`,
      init: { method: "PUT", headers: this.headers(), body: JSON.stringify({ ...current, Videos: next }) },
      onAttempt: this.onAttempt,
    });
  }

  /** Same "not a partial update" footgun as updateProductFields — confirmed live: sending just
   *  `{Text: altText}` 400s with "Field Url is required". VTEX also never echoes the original
   *  upload URL back on GET (`Url` comes back null, only `FileLocation` does), so the current
   *  record has to be re-fetched and its real hosted URL reconstructed before writing back —
   *  merges in `patch` (Text and/or Label) over whatever's already there so an unguarded write
   *  never silently wipes the other field this store's own image-label convention relies on. */
  private async updateSkuFile(skuId: string | number, imageId: string, patch: { text?: string; label?: string }): Promise<void> {
    const files = await this.fetchSkuFiles(skuId);
    const current = files.find((f) => String(f.Id) === String(imageId));
    if (!current) throw new Error(`Image ${imageId} not found on SKU ${skuId} — can't update it`);
    await requestWithRetry({
      provider: "vtex",
      operation: "updateSkuFile",
      url: `${this.baseUrl}/pvt/stockkeepingunit/${skuId}/file/${imageId}`,
      init: {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({
          Url: `https://${this.credentials.account}.${current.FileLocation}`,
          Text: patch.text ?? current.Text ?? "",
          Label: patch.label ?? current.Label ?? "",
          IsMain: current.IsMain,
        }),
      },
      onAttempt: this.onAttempt,
    });
  }

  /** `catalog_system/pvt/brand/list` (unlike `catalog/pvt/category/1`) doesn't depend on any
   *  specific ID existing in the account's catalog — it 200s with an array (empty or not) for any
   *  valid credential pair, so it can't false-negative just because the store never had a category
   *  numbered 1. Private `brand/list` lives under `catalog_system`, not `catalog` (that's a 404). */
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await requestWithRetry({
        provider: "vtex",
        operation: "testConnection",
        url: `https://${this.host}/api/catalog_system/pvt/brand/list`,
        init: { method: "GET", headers: this.headers() },
        retry: { maxAttempts: 1 },
        onAttempt: this.onAttempt,
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof NonRetryableHttpError) {
        const reason =
          err.statusCode === 401 || err.statusCode === 403
            ? "AppKey/AppToken inválidos ou sem permissão para o recurso Catálogo."
            : `HTTP ${err.statusCode}`;
        return { ok: false, error: reason };
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
