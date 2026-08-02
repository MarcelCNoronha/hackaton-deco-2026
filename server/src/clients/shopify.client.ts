import { requestWithRetry, type RequestLogEntry } from "./http.js";
import type {
  CatalogClient,
  CatalogFilterOptions,
  CatalogListParams,
  CatalogListResult,
  CatalogProductDetail,
} from "./catalog-types.js";

export interface ShopifyCredentials {
  /** e.g. "mundialacabamentos.myshopify.com" */
  shopDomain: string;
  /** Custom app Admin API access token (shpat_...) — the Shopify equivalent of VTEX's App Key/Token pair. */
  accessToken: string;
}

const API_VERSION = "2026-01";

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * Thin client for the Shopify Admin GraphQL API — implements the platform-agnostic CatalogClient
 * so the pipeline/browsing routes work identically whether the store runs VTEX or Shopify.
 * NOTE: field/mutation names below follow Shopify's current documented schema but haven't been
 * exercised against a real store yet (no local .d.ts to typecheck against, unlike the OpenAI/
 * Gemini clients) — treat as needing a smoke test against a real custom-app token before trusting
 * it in production, same discipline used for the LLM provider clients.
 */
export class ShopifyClient implements CatalogClient {
  readonly platform = "shopify" as const;
  private readonly endpoint: string;

  constructor(
    private readonly credentials: ShopifyCredentials,
    private readonly onAttempt?: (entry: RequestLogEntry) => void | Promise<void>,
  ) {
    this.endpoint = `https://${credentials.shopDomain}/admin/api/${API_VERSION}/graphql.json`;
  }

  private async graphql<T>(operation: string, query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await requestWithRetry({
      provider: "shopify",
      operation,
      url: this.endpoint,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": this.credentials.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      },
      onAttempt: this.onAttempt,
    });
    const body = (await res.json()) as GraphQlResponse<T>;
    if (body.errors?.length) throw new Error(`Shopify GraphQL error in ${operation}: ${body.errors[0].message}`);
    return body.data as T;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.graphql("testConnection", `query { shop { name } }`);
      return true;
    } catch {
      return false;
    }
  }

  async listProducts(params: CatalogListParams): Promise<CatalogListResult> {
    const filters: string[] = [];
    if (params.search) filters.push(params.search);
    if (params.categoryId) filters.push(`product_type:${JSON.stringify(params.categoryId)}`);
    if (params.brandId) filters.push(`vendor:${JSON.stringify(params.brandId)}`);

    type Resp = {
      products: {
        nodes: Array<{
          id: string;
          title: string;
          productType: string | null;
          vendor: string | null;
          featuredImage: { url: string } | null;
          variants: { nodes: Array<{ sku: string | null }> };
        }>;
        pageInfo: { hasNextPage: boolean };
      };
    };

    const data = await this.graphql<Resp>(
      "listProducts",
      `query ListProducts($first: Int!, $query: String) {
        products(first: $first, query: $query) {
          nodes { id title productType vendor featuredImage { url } variants(first: 1) { nodes { sku } } }
          pageInfo { hasNextPage }
        }
      }`,
      { first: params.pageSize, query: filters.join(" ") || null },
    );

    return {
      items: data.products.nodes.map((p) => ({
        externalId: p.id,
        title: p.title,
        imageUrl: p.featuredImage?.url ?? null,
        category: p.productType || null,
        brand: p.vendor || null,
        sku: p.variants.nodes[0]?.sku || null,
      })),
      hasMore: data.products.pageInfo.hasNextPage,
    };
  }

  async listFilterOptions(): Promise<CatalogFilterOptions> {
    // Shopify doesn't expose a single stable "list all distinct product types/vendors" query the
    // way VTEX exposes a category tree + brand list — the free-text search in listProducts()
    // still works standalone. Populating these dropdowns properly needs a real store to confirm
    // the right query (candidates: paginating distinct `productType`/`vendor` off `products`, or
    // the shop-level `productTypes`/`productVendors` connections) — left empty until then rather
    // than shipping a guessed query that would fail at runtime.
    return { categories: [], brands: [] };
  }

  async getProduct(externalId: string): Promise<CatalogProductDetail> {
    type Resp = {
      product: {
        id: string;
        title: string;
        descriptionHtml: string | null;
        productType: string | null;
        vendor: string | null;
        // `product.images` (ProductImage) is gone from the schema — media (MediaImage) is the
        // current API, and its `id` is also the one `fileUpdate` (see updateImageAltText) accepts.
        media: { nodes: Array<{ id: string; alt: string | null; mediaContentType: string; image: { url: string } | null }> };
        variants: { nodes: Array<{ id: string; sku: string | null }> };
      };
    };

    const data = await this.graphql<Resp>(
      "getProduct",
      `query GetProduct($id: ID!) {
        product(id: $id) {
          id title descriptionHtml productType vendor
          media(first: 20) { nodes { id alt mediaContentType ... on MediaImage { image { url } } } }
          variants(first: 1) { nodes { id sku } }
        }
      }`,
      { id: externalId },
    );

    const images = data.product.media.nodes.filter((m) => m.mediaContentType === "IMAGE" && m.image);

    return {
      externalId: data.product.id,
      title: data.product.title,
      description: data.product.descriptionHtml,
      category: data.product.productType || null,
      brand: data.product.vendor || null,
      sku: data.product.variants.nodes[0]?.sku || null,
      imageUrl: images[0]?.image?.url ?? null,
      variantId: data.product.variants.nodes[0]?.id ?? "",
      images: images.map((m) => ({ id: m.id, url: m.image!.url, altText: m.alt })),
      attributes: {},
    };
  }

  async updateProductDescription(externalId: string, description: string): Promise<void> {
    type Resp = { productUpdate: { userErrors: Array<{ field: string[]; message: string }> } };
    const data = await this.graphql<Resp>(
      "updateProductDescription",
      `mutation UpdateDescription($input: ProductInput!) {
        productUpdate(input: $input) { userErrors { field message } }
      }`,
      { input: { id: externalId, descriptionHtml: description } },
    );
    if (data.productUpdate.userErrors.length > 0) {
      throw new Error(`Shopify productUpdate userError: ${data.productUpdate.userErrors[0].message}`);
    }
  }

  /** `params.imageId` must be the MediaImage id returned by getProduct()'s `images[].id` —
   *  Shopify removed the old ProductImage/productImageUpdate mutation; media is now managed
   *  through the generic Files API (`fileUpdate`), even for images attached to a product. */
  async updateImageAltText(params: {
    externalId: string;
    variantId: string;
    imageId: string;
    altText: string;
  }): Promise<void> {
    type Resp = { fileUpdate: { userErrors: Array<{ field: string[]; message: string }> } };
    const data = await this.graphql<Resp>(
      "updateImageAltText",
      `mutation UpdateImageAlt($files: [FileUpdateInput!]!) {
        fileUpdate(files: $files) { userErrors { field message } }
      }`,
      { files: [{ id: params.imageId, alt: params.altText }] },
    );
    if (data.fileUpdate.userErrors.length > 0) {
      throw new Error(`Shopify fileUpdate userError: ${data.fileUpdate.userErrors[0].message}`);
    }
  }
}
