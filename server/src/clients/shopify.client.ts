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

/** Metafield types we're confident writing blind — plain scalars. Reference/list types (e.g. the
 *  standard "Color"/"Material" category metafields, typically `list.metaobject_reference`) need
 *  resolving a value to a taxonomy entry's GID first, not attempted here — skipped rather than
 *  guessed, since a wrong write there is more damaging than not writing at all. */
const SAFE_METAFIELD_TYPES = new Set([
  "single_line_text_field",
  "multi_line_text_field",
  "number_integer",
  "number_decimal",
  "boolean",
  "url",
  "json",
]);

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

  /** Links to the Admin product page (works whether or not the storefront is even published yet —
   *  a guessed `/products/{handle}` link 404s or bounces to a shopifypreview.com theme-preview URL
   *  on a store that hasn't gone live, which is common mid-build). Always resolves for anyone
   *  logged into this shop's admin, unlike a public storefront link. */
  private adminProductUrl(productGid: string): string {
    const numericId = productGid.split("/").pop();
    return `https://${this.credentials.shopDomain}/admin/products/${numericId}`;
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

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.graphql("testConnection", `query { shop { name } }`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
        url: this.adminProductUrl(p.id),
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
      url: this.adminProductUrl(data.product.id),
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

  /** Fetches the merchant's own registered PRODUCT metafield definitions (both the standard
   *  category ones enabled for this shop's taxonomy, like "Color"/"Material", and any custom ones
   *  like "pieces_per_box") — filtered to types safe to write blind. Used both to guide generation
   *  (see content-enrichment.agent.ts) and, self-contained, inside `updateProductMetafields` to
   *  resolve a key's real namespace/type before writing. */
  private async fetchSafeMetafieldDefinitions(): Promise<Array<{ namespace: string; key: string; name: string; type: string }>> {
    type Resp = {
      metafieldDefinitions: { nodes: Array<{ namespace: string; key: string; name: string; type: { name: string } }> };
    };
    const data = await this.graphql<Resp>(
      "listMetafieldDefinitions",
      `query ListMetafieldDefinitions {
        metafieldDefinitions(ownerType: PRODUCT, first: 100) {
          nodes { namespace key name type { name } }
        }
      }`,
    );
    return data.metafieldDefinitions.nodes
      .filter((d) => SAFE_METAFIELD_TYPES.has(d.type.name))
      .map((d) => ({ namespace: d.namespace, key: d.key, name: d.name, type: d.type.name }));
  }

  async getKnownAttributeFields(): Promise<Array<{ key: string; name: string }>> {
    const defs = await this.fetchSafeMetafieldDefinitions();
    return defs.map((d) => ({ key: d.key, name: d.name }));
  }

  /** ASCII-safe, underscore-separated key derived from a free-form label (e.g. "Cor do rejunte" ->
   *  "cor_do_rejunte") — Shopify metafield keys must be lowercase alphanumeric/underscore, capped
   *  well under its 64-char limit. */
  private slugifyMetafieldKey(label: string): string {
    return label
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
  }

  private normalizeForMatch(s: string): string {
    return s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  /** "Se já existe um campo pra esse conceito, usar a mesma terminologia" — before creating
   *  anything new, checks whether an existing definition's name/key already matches (exact, or one
   *  containing the other for labels long enough to not false-positive on short substrings). */
  private findMatchingDefinition(
    label: string,
    defs: Array<{ namespace: string; key: string; name: string; type: string }>,
  ): { namespace: string; key: string; type: string } | null {
    const target = this.normalizeForMatch(label);
    for (const def of defs) {
      const name = this.normalizeForMatch(def.name);
      const key = this.normalizeForMatch(def.key);
      // Both sides of a substring comparison must clear the length floor — guarding only `target`
      // still let a short EXISTING field name (e.g. "cor") match inside an unrelated longer label
      // (e.g. "decoração" contains "cor") purely by coincidence, in a language full of short common
      // words. Exact equality is always allowed regardless of length.
      const matches =
        target === name ||
        target === key ||
        (target.length >= 4 &&
          ((name.length >= 4 && (name.includes(target) || target.includes(name))) ||
            (key.length >= 4 && (key.includes(target) || target.includes(key)))));
      if (matches) return { namespace: def.namespace, key: def.key, type: def.type };
    }
    return null;
  }

  /** Creates a new PRODUCT metafield definition — only reached when no existing field matches the
   *  concept (see findMatchingDefinition), so this never duplicates a field the merchant already
   *  has. Reuses an existing custom definition's namespace when one exists (keeps new fields
   *  grouped alongside the merchant's own), falling back to Shopify's own UI default ("custom"). */
  private async createAttributeField(
    label: string,
    existingDefs: Array<{ namespace: string; key: string; name: string; type: string }>,
  ): Promise<{ namespace: string; key: string; type: string }> {
    const namespace = existingDefs.find((d) => d.namespace !== "shopify")?.namespace ?? "custom";
    const key = this.slugifyMetafieldKey(label) || `field_${Date.now()}`;
    const type = "single_line_text_field";

    type Resp = {
      metafieldDefinitionCreate: {
        createdDefinition: { namespace: string; key: string } | null;
        userErrors: Array<{ field: string[]; message: string; code: string }>;
      };
    };
    const data = await this.graphql<Resp>(
      "createAttributeField",
      `mutation CreateDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition { namespace key }
          userErrors { field message code }
        }
      }`,
      { definition: { name: label, namespace, key, type, ownerType: "PRODUCT" } },
    );

    const errors = data.metafieldDefinitionCreate.userErrors;
    if (errors.length > 0 && !errors.some((e) => e.code === "TAKEN")) {
      throw new Error(`Shopify metafieldDefinitionCreate userError: ${errors[0].message}`);
    }
    // TAKEN (a concurrent run/request created the same key first) is fine — the field exists
    // either way, which is all this call needs to guarantee.
    return { namespace, key, type };
  }

  async updateProductMetafields(
    externalId: string,
    values: Array<{ key: string; value: string; type?: string; namespace?: string }>,
  ): Promise<void> {
    const withExplicitNamespace = values.filter((v) => v.namespace);
    const needingResolution = values.filter((v) => !v.namespace);

    const resolved: Array<{ namespace: string; key: string; type: string; value: string }> = withExplicitNamespace.map((v) => ({
      namespace: v.namespace!,
      key: v.key,
      type: v.type ?? "single_line_text_field",
      value: v.value,
    }));

    if (needingResolution.length > 0) {
      const defs = await this.fetchSafeMetafieldDefinitions();
      for (const v of needingResolution) {
        const existing = this.findMatchingDefinition(v.key, defs);
        const target = existing ?? (await this.createAttributeField(v.key, defs));
        resolved.push({ namespace: target.namespace, key: target.key, type: target.type, value: v.value });
      }
    }

    if (resolved.length === 0) return;

    type Resp = { metafieldsSet: { userErrors: Array<{ field: string[]; message: string }> } };
    const data = await this.graphql<Resp>(
      "updateProductMetafields",
      `mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`,
      { metafields: resolved.map((r) => ({ ownerId: externalId, namespace: r.namespace, key: r.key, type: r.type, value: r.value })) },
    );
    if (data.metafieldsSet.userErrors.length > 0) {
      throw new Error(`Shopify metafieldsSet userError: ${data.metafieldsSet.userErrors[0].message}`);
    }
  }

  async addProductImage(params: { externalId: string; variantId: string; imageUrl: string; altText?: string }): Promise<void> {
    type Resp = { productCreateMedia: { mediaUserErrors: Array<{ field: string[]; message: string }> } };
    const data = await this.graphql<Resp>(
      "addProductImage",
      `mutation CreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) { mediaUserErrors { field message } }
      }`,
      {
        productId: params.externalId,
        media: [{ originalSource: params.imageUrl, alt: params.altText ?? "", mediaContentType: "IMAGE" }],
      },
    );
    if (data.productCreateMedia.mediaUserErrors.length > 0) {
      throw new Error(`Shopify productCreateMedia userError: ${data.productCreateMedia.mediaUserErrors[0].message}`);
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
