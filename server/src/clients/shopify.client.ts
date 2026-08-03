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
  // Shopify's GraphQL API only supports forward cursor pagination (no jumping straight to page N
  // the way VTEX's REST _from/_to does) — this instance-scoped map remembers, for each page
  // number already reached ON THIS CLIENT INSTANCE, the cursor to fetch the next one. That's
  // exactly how callers that page through sequentially on one instance use this (the "otimização
  // total" candidate-gathering loop in enrichment-run.orchestrator.ts, which previously re-fetched
  // page 1's results on every iteration here — silently duplicating every product up to 4x and
  // burning 4x the LLM cost per run). A caller that builds a fresh client per HTTP request (the
  // Produtos browser's paginated list) still can't jump to page 2+ without re-walking from page 1
  // first — a real limitation, not silently wrong data, tracked as a follow-up.
  private readonly cursorForNextPage = new Map<number, string | null>();

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
    if (params.categoryId) filters.push(`collection_id:${params.categoryId}`);
    if (params.brandId) filters.push(`vendor:${JSON.stringify(params.brandId)}`);

    type Resp = {
      products: {
        nodes: Array<{
          id: string;
          title: string;
          handle: string;
          productType: string | null;
          vendor: string | null;
          featuredImage: { url: string } | null;
          variants: { nodes: Array<{ sku: string | null }> };
          collections: { nodes: Array<{ title: string }> };
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };

    // undefined (page 1, or a page never reached sequentially on this instance yet) means "start
    // from the beginning" — see the field comment on cursorForNextPage above.
    const after = params.page > 1 ? this.cursorForNextPage.get(params.page) : undefined;

    const data = await this.graphql<Resp>(
      "listProducts",
      `query ListProducts($first: Int!, $query: String, $after: String) {
        products(first: $first, query: $query, after: $after) {
          nodes {
            id title handle productType vendor featuredImage { url } variants(first: 1) { nodes { sku } }
            collections(first: 3) { nodes { title } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: params.pageSize, query: filters.join(" ") || null, after: after ?? null },
    );

    this.cursorForNextPage.set(
      params.page + 1,
      data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null,
    );

    return {
      items: data.products.nodes.map((p) => ({
        externalId: p.id,
        title: p.title,
        imageUrl: p.featuredImage?.url ?? null,
        category: p.productType || null,
        brand: p.vendor || null,
        collection: p.collections.nodes.length ? p.collections.nodes.map((c) => c.title).join(", ") : null,
        sku: p.variants.nodes[0]?.sku || null,
        url: `https://${this.credentials.shopDomain}/products/${p.handle}`,
      })),
      hasMore: data.products.pageInfo.hasNextPage,
    };
  }

  /** "Categoria" for Shopify is real Collections (verified live: `collections(first)` root query +
   *  `collection_id:<numericId>` product search filter both work against a real store) — matching
   *  what the product list's "Coleção" column already shows, instead of the `productType` field
   *  used before. `productVendors` (brand filter) is unrelated and unchanged. Collection GIDs
   *  (`gid://shopify/Collection/123`) are trimmed to the trailing numeric id, which is what the
   *  `collection_id:` search filter expects back. */
  async listFilterOptions(): Promise<CatalogFilterOptions> {
    type Resp = {
      collections: { edges: Array<{ node: { id: string; title: string } }> };
      productVendors: { edges: Array<{ node: string }> };
    };
    const data = await this.graphql<Resp>(
      "listFilterOptions",
      `query ListFilterOptions {
        collections(first: 250, sortKey: TITLE) { edges { node { id title } } }
        productVendors(first: 250) { edges { node } }
      }`,
    );
    return {
      categories: data.collections.edges.map((e) => ({ id: e.node.id.split("/").pop()!, name: e.node.title })),
      brands: data.productVendors.edges.filter((e) => e.node).map((e) => ({ id: e.node, name: e.node })),
    };
  }

  async getProduct(externalId: string): Promise<CatalogProductDetail> {
    type Resp = {
      product: {
        id: string;
        title: string;
        handle: string;
        descriptionHtml: string | null;
        productType: string | null;
        vendor: string | null;
        // `product.images` (ProductImage) is gone from the schema — media (MediaImage) is the
        // current API, and its `id` is also the one `fileUpdate` (see updateImageAltText) accepts.
        media: { nodes: Array<{ id: string; alt: string | null; mediaContentType: string; image: { url: string } | null }> };
        variants: { nodes: Array<{ id: string; sku: string | null }> };
        // Covers both the standard category metafields (Color, Material, ... under the `shopify`
        // namespace, populated from the product's assigned taxonomy category) and any
        // merchant-defined custom metafields (e.g. `finish`, `pieces_per_box`) — both show up here
        // identically, so no special-casing is needed to read either.
        metafields: { nodes: Array<{ namespace: string; key: string; value: string }> };
        collections: { nodes: Array<{ title: string }> };
      };
    };

    const data = await this.graphql<Resp>(
      "getProduct",
      `query GetProduct($id: ID!) {
        product(id: $id) {
          id title handle descriptionHtml productType vendor
          media(first: 20) { nodes { id alt mediaContentType ... on MediaImage { image { url } } } }
          variants(first: 1) { nodes { id sku } }
          metafields(first: 50) { nodes { namespace key value } }
          collections(first: 3) { nodes { title } }
        }
      }`,
      { id: externalId },
    );

    const images = data.product.media.nodes.filter((m) => m.mediaContentType === "IMAGE" && m.image);
    // Reference-type metafields (e.g. a taxonomy field like "color-pattern" pointing at a
    // Metaobject) return a raw `gid://...` id as `value`, not the human-readable label — resolving
    // that needs a separate query per metaobject (its "display" field varies by definition), not
    // done here. Sending the raw id to the LLM would be worse than omitting it, so it's filtered out.
    const attributes = Object.fromEntries(
      data.product.metafields.nodes.filter((m) => !m.value.includes("gid://")).map((m) => [m.key, m.value]),
    );

    return {
      externalId: data.product.id,
      title: data.product.title,
      description: data.product.descriptionHtml,
      category: data.product.productType || null,
      brand: data.product.vendor || null,
      collection: data.product.collections.nodes.length ? data.product.collections.nodes.map((c) => c.title).join(", ") : null,
      sku: data.product.variants.nodes[0]?.sku || null,
      url: `https://${this.credentials.shopDomain}/products/${data.product.handle}`,
      imageUrl: images[0]?.image?.url ?? null,
      variantId: data.product.variants.nodes[0]?.id ?? "",
      images: images.map((m) => ({ id: m.id, url: m.image!.url, altText: m.alt })),
      attributes,
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

  async updateProductSeo(externalId: string, seo: { title?: string; metaDescription?: string }): Promise<void> {
    if (!seo.title && !seo.metaDescription) return;
    type Resp = { productUpdate: { userErrors: Array<{ field: string[]; message: string }> } };
    const data = await this.graphql<Resp>(
      "updateProductSeo",
      `mutation UpdateSeo($input: ProductInput!) {
        productUpdate(input: $input) { userErrors { field message } }
      }`,
      {
        input: {
          id: externalId,
          seo: {
            ...(seo.title ? { title: seo.title } : {}),
            ...(seo.metaDescription ? { description: seo.metaDescription } : {}),
          },
        },
      },
    );
    if (data.productUpdate.userErrors.length > 0) {
      throw new Error(`Shopify productUpdate userError: ${data.productUpdate.userErrors[0].message}`);
    }
  }

  async updateProductTags(externalId: string, tags: string[]): Promise<void> {
    type Resp = { productUpdate: { userErrors: Array<{ field: string[]; message: string }> } };
    const data = await this.graphql<Resp>(
      "updateProductTags",
      `mutation UpdateTags($input: ProductInput!) {
        productUpdate(input: $input) { userErrors { field message } }
      }`,
      { input: { id: externalId, tags } },
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
