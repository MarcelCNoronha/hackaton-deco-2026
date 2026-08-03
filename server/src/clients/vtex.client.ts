import { requestWithRetry, type RequestLogEntry } from "./http.js";
import type {
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
  Images?: Array<{ ImageUrl: string; ImageName?: string; ImageText?: string }>;
  [key: string]: unknown;
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

interface VtexCategoryTreeNode {
  id: number;
  name: string;
  children?: VtexCategoryTreeNode[];
}

interface VtexBrand {
  id: number;
  name: string;
  isActive?: boolean;
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

  constructor(
    private readonly credentials: VtexCredentials,
    private readonly onAttempt?: (entry: RequestLogEntry) => void | Promise<void>,
  ) {
    this.host = `${credentials.account}.${credentials.environment}.com.br`;
    this.baseUrl = `https://${this.host}/api/catalog`;
    this.searchBaseUrl = `https://${this.host}/api/catalog_system/pub`;
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

  /** The private Catalog API (fetchProduct/fetchSku) never returns category-level specification
   *  values ("Características"/"Especificações" in the admin — real specs like Material, Acabamento,
   *  dimensões) nor the brand NAME (only fetchProduct's numeric BrandId) — only the public Search
   *  API has both, as dynamic per-product fields (see extractVtexSpecifications). Reuses that same
   *  endpoint/auth as listProducts, filtered down to this one product. Never throws: a lookup
   *  failing shouldn't fail the whole product sync, it just means the LLM falls back to whatever's
   *  in the free-text description (and brand stays unset), same as before this existed. */
  private async fetchProductSpecifications(
    productId: string | number,
  ): Promise<{ attributes: Record<string, unknown>; brand: string | null }> {
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
      return { attributes: item ? extractVtexSpecifications(item) : {}, brand: item?.brand ?? null };
    } catch (err) {
      console.error(`VTEX getProductSpecifications failed for product ${productId} — continuing with empty attributes`, err);
      return { attributes: {}, brand: null };
    }
  }

  /** Composes the private product+SKU endpoints into the platform-agnostic detail shape —
   *  treats the first SKU's images as "the" product images, same simplification the pipeline
   *  already relied on before this abstraction existed. */
  async getProduct(externalId: string): Promise<CatalogProductDetail> {
    const product = await this.fetchProduct(externalId);
    const skuId = (product as { SkuIds?: number[] }).SkuIds?.[0];
    const [sku, { attributes, brand }] = await Promise.all([
      skuId ? this.fetchSku(skuId) : Promise.resolve(undefined),
      this.fetchProductSpecifications(externalId),
    ]);
    const images = (sku?.Images ?? []) as Array<{ Id?: string | number; ImageUrl: string; ImageText?: string }>;

    return {
      externalId: String(product.Id),
      title: product.Name,
      description: product.Description ?? null,
      category: product.CategoryId ? String(product.CategoryId) : null,
      brand,
      sku: sku?.RefId ?? null,
      url: product.LinkId ? `https://${this.host}/${product.LinkId}/p` : null,
      imageUrl: images[0]?.ImageUrl ?? null,
      variantId: sku ? String(sku.Id) : "",
      images: images.map((img, i) => ({
        id: String(img.Id ?? i),
        url: img.ImageUrl,
        altText: img.ImageText ?? null,
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
    if (params.categoryId) query.append("fq", `C:${params.categoryId}`);
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
        category: p.categories?.[0]?.replace(/^\/|\/$/g, "").split("/").pop() ?? null,
        brand: p.brand ?? null,
        sku: extractVtexReferenceId(p.items?.[0]?.referenceId),
        url: p.link ?? (p.linkText ? `https://${this.host}/${p.linkText}/p` : null),
      })),
      hasMore: items.length === params.pageSize,
      total,
    };
  }

  async listFilterOptions(): Promise<CatalogFilterOptions> {
    const [categoryRes, brandRes] = await Promise.all([
      requestWithRetry({
        provider: "vtex",
        operation: "listCategoryTree",
        url: `${this.searchBaseUrl}/category/tree/3`,
        init: { method: "GET", headers: this.headers() },
        onAttempt: this.onAttempt,
      }),
      requestWithRetry({
        provider: "vtex",
        operation: "listBrands",
        url: `${this.searchBaseUrl}/brand/list`,
        init: { method: "GET", headers: this.headers() },
        onAttempt: this.onAttempt,
      }),
    ]);

    const tree = ((await categoryRes.json()) as VtexCategoryTreeNode[]) ?? [];
    const brands = ((await brandRes.json()) as VtexBrand[]) ?? [];

    const categories: Array<{ id: string; name: string }> = [];
    const flatten = (nodes: VtexCategoryTreeNode[]) => {
      for (const node of nodes) {
        categories.push({ id: String(node.id), name: node.name });
        if (node.children?.length) flatten(node.children);
      }
    };
    flatten(tree);

    return {
      categories,
      brands: brands.filter((b) => b.isActive !== false).map((b) => ({ id: String(b.id), name: b.name })),
    };
  }

  async updateImageAltText(params: {
    externalId: string;
    variantId: string;
    imageId: string;
    altText: string;
  }): Promise<void> {
    await this.updateSkuImageAltText(params.variantId, params.imageId, params.altText);
  }

  async updateProductDescription(productId: string | number, description: string): Promise<void> {
    await requestWithRetry({
      provider: "vtex",
      operation: "updateProductDescription",
      url: `${this.baseUrl}/pvt/product/${productId}`,
      init: {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({ Description: description }),
      },
      onAttempt: this.onAttempt,
    });
  }

  async updateSkuImageAltText(skuId: string | number, imageId: string, altText: string): Promise<void> {
    await requestWithRetry({
      provider: "vtex",
      operation: "updateSkuImageAltText",
      url: `${this.baseUrl}/pvt/stockkeepingunit/${skuId}/file/${imageId}`,
      init: {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({ Text: altText }),
      },
      onAttempt: this.onAttempt,
    });
  }

  async testConnection(): Promise<boolean> {
    try {
      const res = await requestWithRetry({
        provider: "vtex",
        operation: "testConnection",
        url: `${this.baseUrl}/pvt/category/1`,
        init: { method: "GET", headers: this.headers() },
        retry: { maxAttempts: 1 },
        onAttempt: this.onAttempt,
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
