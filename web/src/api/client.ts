const BASE = "/api";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Routes that catch their own errors send `{ error: "<real reason>" }`. Fastify's own handler
    // for an uncaught exception sends `{ error: "Internal Server Error", message: "<real reason>" }`
    // instead — `error` there is just the generic HTTP reason phrase, not the actual cause, so
    // `message` (when present) always wins.
    throw new ApiError(body.message ?? body.error ?? `Request to ${path} failed with ${res.status}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface Connection {
  id: number;
  provider: "vtex" | "google" | "anthropic" | "openai" | "gemini" | "shopify";
  displayName: string;
  status: string;
  lastTestedAt: string | null;
}

export type CatalogPlatform = "vtex" | "shopify";

export interface CatalogProductSummary {
  externalId: string;
  title: string;
  imageUrl: string | null;
  category: string | null;
  /** VTEX: not populated yet (needs the Collections module wired up). Shopify: real collections
   *  this product belongs to, joined with ", " when there's more than one. */
  collection: string | null;
  brand: string | null;
  /** Public storefront URL, when the platform returned a slug for it. */
  url: string | null;
  /** Our local product id, only set once this item has been synced by a run at least once. */
  productId: number | null;
  /** Local SKU/variant id, once synced — falls back to externalId on the frontend until then. */
  sku: string | null;
  /** Most recent run that generated a proposal for this product, if any. */
  lastRunId: number | null;
  /** When the most recent proposal for this product was created, if any. */
  optimizedAt: string | null;
  /** "published" once every proposal from the last run was published, "pending" otherwise. */
  optimizationStatus: "pending" | "published" | null;
  /** Total AI cost of the last optimization run for this product, if any. */
  optimizationCostUsd: number | null;
  /** "ready" with >=2 GSC/GA4 snapshots (a before/after trend exists), "partial" with just 1,
   *  "none" with 0 — drives the Impacto button's color. */
  impactReadiness: "none" | "partial" | "ready";
  /** Merchant-provided reference for THIS exact product (e.g. the manufacturer's own page) — used
   *  as a factual grounding source at generation time. Null until set via
   *  api.setManufacturerReference. */
  manufacturerReferenceUrl: string | null;
}

export interface CatalogFilterOptions {
  /** VTEX: department id or category/subcategory id path ("6/13/43"). Shopify: collection id. */
  categories: Array<{ id: string; name: string }>;
  brands: Array<{ id: string; name: string }>;
}

export interface CatalogListResult {
  items: CatalogProductSummary[];
  hasMore: boolean;
  total?: number;
}

export interface CatalogFilter {
  search?: string;
  categoryId?: string;
  brandId?: string;
}

export type LlmProvider = "anthropic" | "openai" | "gemini";
export type LlmTask = "contentEnrichment" | "imageAltText" | "evaluator";
export type PriceTier = "quality" | "balanced" | "price";

export interface ModelTierInfo {
  id: string;
  label: string;
  inputPrice: number;
  outputPrice: number;
}

export type ProviderRecommendations = Record<PriceTier, ModelTierInfo>;

export interface ModelRoutingRow {
  task: LlmTask;
  provider: LlmProvider;
  model: string;
}

/** Deliberately NOT excelente/bom/medio — those already name the GENERATION level chosen before a
 *  run (DescriptionRichness, controls HTML structure). This is a different axis computed AFTER
 *  generation from the composite score, and the two can disagree (a "Médio"-level plain-text
 *  product can still score "Ouro" on SEO/conversion/completude) — sharing the same 3 words would
 *  read as a contradiction in the UI instead of two independent signals. */
export type ScoreTier = "ouro" | "prata" | "bronze";

export interface CategoryScoreThreshold {
  category: string;
  excellentMin: number;
  goodMin: number;
}

/** `'*'` — the catalog-wide default row used when a category has no override of its own. */
export const DEFAULT_THRESHOLD_CATEGORY = "*";

export function classifyScore(thresholds: CategoryScoreThreshold[], category: string | null, overallScore: number): ScoreTier {
  const byCategory = new Map(thresholds.map((t) => [t.category, t]));
  const threshold = (category ? byCategory.get(category) : undefined) ?? byCategory.get(DEFAULT_THRESHOLD_CATEGORY);
  if (!threshold) return "bronze";
  if (overallScore >= threshold.excellentMin) return "ouro";
  if (overallScore >= threshold.goodMin) return "prata";
  return "bronze";
}

export interface EnrichmentRun {
  id: number;
  status: "running" | "success" | "failed" | "partial";
  scope: { candidateProductIds?: string[]; catalogFilter?: CatalogFilter; topN?: number };
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  processedCount: number;
  summary: Record<string, unknown> | null;
  errorMessage: string | null;
}

/** The 11 fields a run can propose in one combined content-enrichment call — matches the backend's
 *  EnrichmentField (see server/src/clients/llm-types.ts). "alt_text" is a separate, per-image
 *  pipeline, so it's toggled independently (see EstimableField) rather than part of this set. */
export type EnrichmentField =
  | "description"
  | "benefit_bullets"
  | "technical_specs"
  | "faq"
  | "structured_data"
  | "seo_title"
  | "meta_description"
  | "keywords"
  | "tags"
  | "cta"
  | "attributes_patch";
export const ALL_ENRICHMENT_FIELDS: EnrichmentField[] = [
  "description",
  "benefit_bullets",
  "technical_specs",
  "faq",
  "structured_data",
  "seo_title",
  "meta_description",
  "keywords",
  "tags",
  "cta",
  "attributes_patch",
];
export type ImageGenKind = "lifestyle" | "feature_callout";
export type EstimableField = EnrichmentField | "alt_text" | ImageGenKind;

export interface FieldCostEstimate {
  field: EstimableField;
  label: string;
  estimatedCostUsd: number;
}

/** How much structure "description" should have — drives the Médio/Bom/Excelente level packages
 *  (see field-cost-estimates.ts). */
export type DescriptionRichness = "plain" | "structured" | "structured_with_image";
export type CommunicationTone = "premium" | "tecnico" | "casual" | "auto";
export type OptimizationLevel = "medio" | "bom" | "excelente";

export interface LevelCostEstimate {
  level: OptimizationLevel;
  label: string;
  estimatedCostUsd: number;
}

/** Every block that can be merged into the description HTML, in the order a merchant picks — see
 *  server/src/repositories/pdp-templates.repo.ts (single source of truth). */
export const PDP_BLOCKS = [
  "description",
  "benefit_bullets",
  "technical_specs",
  "featured_image",
  "principal_photo",
  "ambient_photo",
  "dimensional_photo",
  "destaque_gallery",
  "faq",
  "cta",
  "divider",
  "spacer",
] as const;

/** Mirrors the server's MAX_REFERENCE_LINKS (category-reference-links.repo.ts) — kept as a literal
 *  here too since the two projects don't share imports across the client/server boundary. */
export const MAX_REFERENCE_LINKS = 3;
export type PdpBlock = (typeof PDP_BLOCKS)[number];

export const PDP_ALIGN_OPTIONS = ["justify", "left", "right", "center"] as const;
export type PdpTextAlign = (typeof PDP_ALIGN_OPTIONS)[number];
export const PDP_FONT_SIZE_OPTIONS = ["sm", "md", "lg"] as const;
export type PdpFontSize = (typeof PDP_FONT_SIZE_OPTIONS)[number];

/** One cell of the "modo de layout" grid — mirrors server/src/repositories/pdp-templates.repo.ts's
 *  PdpLayoutCell. */
export interface PdpLayoutCell {
  block: PdpBlock;
  align: PdpTextAlign;
  bold: boolean;
  fontSize: PdpFontSize;
}

export interface PdpLayoutRow {
  columns: PdpLayoutCell[];
}

/** Mirrors the server's `'*'` catalog-wide default category (pdp-templates.repo.ts's
 *  DEFAULT_PDP_CATEGORY) — kept as its own constant (even though it's the same literal as
 *  DEFAULT_THRESHOLD_CATEGORY) since the two are conceptually unrelated defaults. */
export const DEFAULT_PDP_CATEGORY = "*";

export interface PdpTemplate {
  platform: CatalogPlatform;
  category: string;
  level: DescriptionRichness;
  blocks: PdpBlock[];
  /** "Modo avançado" — free-form HTML with {{placeholder}} tokens. Null means simple/layout mode
   *  decides instead. Takes priority over `layout`/`blocks` when set. */
  customHtml: string | null;
  /** "Modo de layout" — rows/columns grid, each cell naming a block + its own align/bold/fontSize.
   *  Null means this mode isn't in use. Ignored when `customHtml` is set. */
  layout: PdpLayoutRow[] | null;
  /** "specific" — this category has its own saved structure for this level. "default" — inherited
   *  from the catalog-wide `'*'` template (or the factory default if that isn't set either). */
  source: "specific" | "default";
}

/** One node of the catalog platform's category tree — `isLeaf` is where products actually get
 *  classified (Subcategoria, or Categoria when a branch has no Subcategoria level) and is where
 *  the "Campos aceitos" / referência de mercado UI lets a merchant act. Mirrors the backend's
 *  CategoryTreeNode (server/src/clients/catalog-types.ts). */
export interface CategoryTreeNode {
  id: string;
  name: string;
  path: string;
  parentPath: string | null;
  level: number;
  isLeaf: boolean;
}

export interface CategoryFieldDefinition {
  id: string;
  name: string;
  isActive: boolean;
}

export interface CategorySpecFields {
  categoryPath: string;
  categoryId: string;
  fields: CategoryFieldDefinition[];
}

export type ContentProfileSource = "internal" | "references" | "manual";

/** Structural target for a category's description — never copied text, see
 *  category-content-profile.repo.ts. `source` explains where the numbers came from: "manual" (hand-
 *  typed) beats "references" (consensus across pasted market URLs) beats "internal" (derived from
 *  the store's own best-scoring products). */
export interface CategoryContentProfile {
  category: string;
  wordCountMin: number | null;
  wordCountMax: number | null;
  bulletCount: number | null;
  hasFaq: boolean | null;
  hasSpecTable: boolean | null;
  hasWarrantySection: boolean | null;
  source: ContentProfileSource;
}

/** Returned only by the bulk listing (one row per category that's actually been configured) —
 *  powers the "já mapeada" marker + date in PdpConfig.tsx's category selector. */
export interface CategoryContentProfileSummary extends CategoryContentProfile {
  updatedAt: string;
}

export interface StructureSignals {
  wordCount: number;
  bulletCount: number;
  headingCount: number;
  hasFaq: boolean;
  hasSpecTable: boolean;
  hasWarrantySection: boolean;
  mentionsInstallation: boolean;
}

export interface CategoryReferenceLink {
  id: number;
  category: string;
  url: string;
  extractedSignals: StructureSignals | null;
  warning: string | null;
}

export interface EnrichmentProposal {
  id: number;
  runId: number;
  productId: number;
  field:
    | "description"
    | "alt_text"
    | "structured_data"
    | "faq"
    | "benefit_bullets"
    | "technical_specs"
    | "seo_title"
    | "meta_description"
    | "keywords"
    | "tags"
    | "cta"
    | "attributes_patch"
    | "featured_image";
  agent: "content" | "image";
  originalValue: string | null;
  proposedValue: string;
  status: "pending" | "approved" | "rejected" | "edited" | "published";
  reviewedBy: string | null;
  reviewedAt: string | null;
  publishedAt: string | null;
  /** Set when this content was adapted from a near-duplicate product's already-approved proposal
   *  instead of a full LLM generation — the RAG/dedup cost-saving path. */
  reusedFromProductId: number | null;
  reusedSimilarity: string | null;
}

export interface Product {
  id: number;
  vtexProductId: string;
  vtexSkuId: string;
  title: string;
  description: string | null;
  category: string | null;
  collection: string | null;
  brand: string | null;
  url: string | null;
  lastSyncedAt: string | null;
}

/** This store's VTEX carousel-slot convention: 1=principal, 2=ambientada, 3=dimensional, 4+
 *  =destaque (more than one allowed). See PhotoClassification in the server's lib/photo-labels. */
export type PhotoClassification = "principal" | "ambientada" | "dimensional" | "destaque";

/** An AI-generated marketing image produced FROM the product's existing photos (never from
 *  scratch), or a photo extracted from a manufacturer reference page — "kind" is how it was
 *  PRODUCED, "classification" is which of the 4 carousel slots it fills (independent: a
 *  manufacturer_reference photo's classification isn't implied by its kind, so it starts null
 *  until a human picks one). `imageBase64` is raw base64 (no `data:` prefix) — build the src as
 *  `data:${mimeType};base64,${imageBase64}`. */
export interface GeneratedImage {
  id: number;
  productId: number;
  kind: "principal" | "lifestyle" | "dimensional" | "feature_callout" | "manufacturer_reference";
  classification: PhotoClassification | null;
  prompt: string;
  /** Only set for kind="manufacturer_reference" — the page the photo was downloaded from. */
  sourceUrl: string | null;
  mimeType: string;
  imageBase64: string;
  costUsd: string | null;
  /** Result of the post-generation integrity gate — false means the model itself flagged this
   *  generation as NOT reliably the same product (see integrityNotes), after retrying. Shown as a
   *  warning rather than silently trusted or discarded. */
  integrityVerified: boolean;
  integrityNotes: string | null;
  /** Set once this image was actually uploaded to the active catalog platform as a real product
   *  photo — null means it only ever existed inside CatalogIA. */
  publishedAt: string | null;
  /** The platform's own id for the uploaded file (set together with publishedAt) — lets this exact
   *  photo be recognized among /products/:id/catalog-images (so it isn't shown twice) and
   *  re-labeled/cleared directly if declassified after publishing. */
  platformImageId: string | null;
  createdAt: string;
}

/** A photo already on the platform, outside CatalogIA's own generatedImages table — most predate
 *  this store's Label convention and come back with `label: null` until classified. */
export interface CatalogImage {
  id: string;
  url: string;
  altText: string | null;
  label: string | null;
}

export type RealImpactStatus = "no_url" | "not_published" | "maturing" | "ready";

export interface RealImpactWindow {
  startDate: string;
  endDate: string;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  avgPosition: number | null;
  sessions: number | null;
  conversionRate: number | null;
  revenue: number | null;
}

/** Live antes/depois comparison read straight from GSC/GA4 (no local snapshot table) — see
 *  server/src/agents/impact.agent.ts. */
export interface RealImpact {
  status: RealImpactStatus;
  publishedAt?: string;
  daysSincePublish?: number;
  daysUntilReady?: number;
  before?: RealImpactWindow;
  after?: RealImpactWindow;
  deltas?: {
    impressionsPct: number | null;
    positionDelta: number | null;
    ctrDeltaPct: number | null;
    sessionsPct: number | null;
    conversionRateDeltaPct: number | null;
    revenueDeltaAbs: number | null;
  };
}

export interface ContentScore {
  id: number;
  runId: number;
  productId: number;
  target: "original" | "proposed";
  checklistScore: number;
  buyerConfidence: number;
  buyerUnanswered: string[];
  geoAnswerableCount: number;
  geoTotalQuestions: number;
  unsupportedClaims: string[];
  overallScore: number;
  seoScore: number;
  conversionScore: number;
  readabilityScore: number;
  structureScore: number;
  dataConsistencyScore: number;
  catalogIssues: string[];
  attributesFilled: number;
  attributesExpected: number;
  questionsAnswered: number;
  questionsTotal: number;
  attempts: number;
  createdAt: string;
}

export interface ImpactSummary {
  productCount: number;
  completudeDeltaPct: number;
  seoDeltaPct: number;
  geoDeltaPct: number;
  conversionDeltaPct: number;
  consistencyDeltaPct: number;
  requiredAttributesFilledPct: number;
  estimatedTimeSavedMinutes: number;
  estimatedTimeSavedPct: number;
}

export interface RunCosts {
  totalCostUsd: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byProduct: Array<{ productId: number; costUsd: number; calls: number }>;
}

export interface ProviderSpend {
  provider: LlmProvider;
  limitUsd: number | null;
  spentUsd: number;
}

export interface FreeQuotaStatus {
  provider: LlmProvider;
  enabled: boolean;
  quotaUsd: number;
  resetIntervalHours: number;
  periodStartAt: string;
  resetAt: string;
  periodSpentUsd: number;
  exhausted: boolean;
}

export type AppSection = "connections" | "publish" | "users";

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: "admin" | "user";
  permissions: AppSection[];
  twoFactorEnabled: boolean;
}

export interface AdminUser {
  id: number;
  name: string;
  email: string;
  role: "admin" | "user";
  permissions: AppSection[];
  isActive: boolean;
  twoFactorEnabled: boolean;
  invitedAt: string | null;
  invitationAcceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoginResult {
  requiresTwoFactor: boolean;
  user?: AuthUser;
}

export const api = {
  listConnections: () => request<Connection[]>("/connections"),
  googleAuthUrl: () => request<{ url: string }>("/connections/google/auth-url"),
  listModels: (provider?: LlmProvider) =>
    request<ProviderRecommendations | Record<LlmProvider, ProviderRecommendations>>(
      provider ? `/models?provider=${provider}` : "/models",
    ),
  connectVtex: (body: {
    displayName: string;
    account: string;
    environment: string;
    appKey: string;
    appToken: string;
    storefrontDomain?: string;
  }) =>
    request<{ ok: boolean; error?: string }>("/connections/vtex", { method: "POST", body: JSON.stringify(body) }),
  connectShopify: (body: { displayName: string; shopDomain: string; accessToken: string }) =>
    request<{ ok: boolean; error?: string }>("/connections/shopify", { method: "POST", body: JSON.stringify(body) }),
  connectAnthropic: (body: { displayName: string; apiKey: string }) =>
    request<{ ok: boolean; error?: string }>("/connections/anthropic", { method: "POST", body: JSON.stringify(body) }),
  connectOpenAi: (body: { displayName: string; apiKey: string }) =>
    request<{ ok: boolean; error?: string }>("/connections/openai", { method: "POST", body: JSON.stringify(body) }),
  connectGemini: (body: { displayName: string; apiKey: string }) =>
    request<{ ok: boolean; error?: string }>("/connections/gemini", { method: "POST", body: JSON.stringify(body) }),
  connectGoogle: (body: { displayName: string; code: string; gscSiteUrl: string; ga4PropertyId: string }) =>
    request<{ ok: boolean }>("/connections/google", { method: "POST", body: JSON.stringify(body) }),
  testConnection: (provider: Connection["provider"]) =>
    request<{ ok: boolean; error?: string }>(`/connections/${provider}/test`, { method: "POST" }),

  getModelRouting: () => request<ModelRoutingRow[]>("/model-routing"),
  setModelRouting: (routing: ModelRoutingRow[]) =>
    request<ModelRoutingRow[]>("/model-routing", { method: "PUT", body: JSON.stringify({ routing }) }),

  getOptimizationThresholds: () =>
    request<{ thresholds: CategoryScoreThreshold[]; categories: string[] }>("/optimization-thresholds"),
  setOptimizationThreshold: (threshold: CategoryScoreThreshold) =>
    request<{ ok: boolean }>("/optimization-thresholds", { method: "PUT", body: JSON.stringify(threshold) }),

  getPdpTemplates: (category?: string) =>
    request<{ platform: CatalogPlatform; category: string; templates: PdpTemplate[] }>(
      `/pdp-templates${category ? `?category=${encodeURIComponent(category)}` : ""}`,
    ),
  setPdpTemplate: (body: {
    level: DescriptionRichness;
    blocks: PdpBlock[];
    category?: string;
    customHtml?: string | null;
    layout?: PdpLayoutRow[] | null;
  }) =>
    request<{ platform: CatalogPlatform; category: string; templates: PdpTemplate[] }>("/pdp-templates", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  previewPdpTemplate: (body: { level: DescriptionRichness; blocks: PdpBlock[]; customHtml?: string | null; layout?: PdpLayoutRow[] | null }) =>
    request<{ html: string }>("/pdp-templates/preview", { method: "POST", body: JSON.stringify(body) }),

  getCategoryNodes: () => request<{ platform: CatalogPlatform; nodes: CategoryTreeNode[] }>("/category-nodes"),
  getCategorySpecFields: () =>
    request<{ platform: CatalogPlatform; categories: CategorySpecFields[] }>("/category-spec-fields"),
  syncVtexCategories: () => request<{ ok: boolean }>("/connections/vtex/sync-categories", { method: "POST" }),

  getCategoryContentProfile: (category: string) =>
    request<{ profile: CategoryContentProfile | null }>(`/category-content-profile?category=${encodeURIComponent(category)}`),
  listCategoryContentProfiles: () => request<{ profiles: CategoryContentProfileSummary[] }>("/category-content-profiles"),
  setCategoryContentProfile: (body: Omit<CategoryContentProfile, "source">) =>
    request<{ profile: CategoryContentProfile | null }>("/category-content-profile", { method: "PUT", body: JSON.stringify(body) }),
  getCategoryReferenceLinks: (category: string) =>
    request<{ links: CategoryReferenceLink[] }>(`/category-reference-links?category=${encodeURIComponent(category)}`),
  /** Up to MAX_REFERENCE_LINKS urls, one request for the whole batch — a url that fails to fetch/
   *  extract shows up in `errors` without blocking the others in the same call. */
  addCategoryReferenceLinks: (body: { category: string; urls: string[] }) =>
    request<{ links: CategoryReferenceLink[]; errors: Array<{ url: string; error: string }>; profile: CategoryContentProfile | null }>(
      "/category-reference-links",
      { method: "POST", body: JSON.stringify(body) },
    ),
  removeCategoryReferenceLink: (id: number, category: string) =>
    request<{ profile: CategoryContentProfile | null }>(
      `/category-reference-links/${id}?category=${encodeURIComponent(category)}`,
      { method: "DELETE" },
    ),

  setManufacturerReference: (externalId: string, manufacturerReferenceUrl: string | null) =>
    request<{ manufacturerReferenceUrl: string | null; warning?: string }>(
      `/products/by-external-id/${encodeURIComponent(externalId)}/manufacturer-reference`,
      { method: "PATCH", body: JSON.stringify({ manufacturerReferenceUrl }) },
    ),

  getCatalogPlatform: () => request<{ platform: CatalogPlatform }>("/catalog/platform"),
  setCatalogPlatform: (platform: CatalogPlatform) =>
    request<{ platform: CatalogPlatform }>("/catalog/platform", { method: "PUT", body: JSON.stringify({ platform }) }),
  catalogFilters: () => request<CatalogFilterOptions>("/catalog/filters"),
  listCatalogProducts: (params: CatalogFilter & { page: number; pageSize: number }) => {
    const query = new URLSearchParams();
    if (params.search) query.set("search", params.search);
    if (params.categoryId) query.set("categoryId", params.categoryId);
    if (params.brandId) query.set("brandId", params.brandId);
    query.set("page", String(params.page));
    query.set("pageSize", String(params.pageSize));
    return request<CatalogListResult>(`/catalog/products?${query.toString()}`);
  },
  /** For the "A Validar"/"Pronta e enviada" filter pills — queries our own snapshot directly
   *  (status decides membership before pagination), so every matching product across the whole
   *  account shows up, not just whichever ones land on the current page of listCatalogProducts'
   *  live catalog browse. */
  listProductsByStatus: (params: { status: "pending" | "published"; page: number; pageSize: number }) => {
    const query = new URLSearchParams({ status: params.status, page: String(params.page), pageSize: String(params.pageSize) });
    return request<CatalogListResult>(`/catalog/products/by-status?${query.toString()}`);
  },

  listRuns: (filter?: CatalogFilter) => {
    const query = new URLSearchParams();
    if (filter?.search) query.set("search", filter.search);
    if (filter?.categoryId) query.set("categoryId", filter.categoryId);
    if (filter?.brandId) query.set("brandId", filter.brandId);
    const qs = query.toString();
    return request<EnrichmentRun[]>(`/runs${qs ? `?${qs}` : ""}`);
  },
  getRun: (id: number) => request<EnrichmentRun>(`/runs/${id}`),
  createRun: (body: {
    candidateProductIds?: string[];
    catalogFilter?: CatalogFilter;
    topN?: number;
    fields?: EnrichmentField[];
    includeAltText?: boolean;
    imageKinds?: ImageGenKind[];
    descriptionRichness?: DescriptionRichness;
    communicationTone?: CommunicationTone;
  }) => request<{ runId: number }>("/runs", { method: "POST", body: JSON.stringify(body) }),
  fieldCostEstimates: (productCount: number, descriptionRichness?: DescriptionRichness) =>
    request<{ estimates: FieldCostEstimate[]; note: string }>(
      `/runs/field-estimates?productCount=${productCount}${
        descriptionRichness ? `&descriptionRichness=${descriptionRichness}` : ""
      }`,
    ),
  levelCostEstimates: (productCount: number) =>
    request<{ estimates: LevelCostEstimate[] }>(`/runs/level-estimates?productCount=${productCount}`),
  publishRun: (id: number) => request<{ enqueued: boolean }>(`/runs/${id}/publish`, { method: "POST" }),
  listProposals: (runId: number) => request<EnrichmentProposal[]>(`/runs/${runId}/proposals`),
  listScores: (runId: number) => request<ContentScore[]>(`/runs/${runId}/scores`),
  runCosts: (runId: number) => request<RunCosts>(`/runs/${runId}/costs`),
  runImpactSummary: (runId: number) => request<ImpactSummary>(`/runs/${runId}/impact-summary`),
  overallImpactSummary: () => request<ImpactSummary>("/impact/summary"),
  reviewProposal: (id: number, body: { status: "approved" | "rejected" | "edited"; proposedValue?: string }) =>
    request<EnrichmentProposal>(`/proposals/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  approveAllProposals: (runId: number) =>
    request<EnrichmentProposal[]>(`/runs/${runId}/proposals/approve-all`, { method: "POST" }),
  republishProposal: (id: number, proposedValue?: string) =>
    request<{ ok: boolean }>(`/proposals/${id}/republish`, { method: "POST", body: JSON.stringify({ proposedValue }) }),

  listProducts: () => request<Product[]>("/products"),
  resyncProduct: (id: number) => request<Product>(`/products/${id}/resync`, { method: "POST" }),
  listGeneratedImages: (productId: number) => request<GeneratedImage[]>(`/products/${productId}/generated-images`),
  generateImage: (
    productId: number,
    body: { kind: "principal" | "lifestyle" | "dimensional" | "feature_callout"; note?: string; runId?: number },
  ) =>
    request<GeneratedImage>(`/products/${productId}/generated-images`, { method: "POST", body: JSON.stringify(body) }),
  // classification: null declassifies — if the photo was already published, this also clears its
  // real Label on the platform, not just the local metadata (see the route's doc comment).
  classifyGeneratedImage: (imageId: number, classification: PhotoClassification | null) =>
    request<GeneratedImage>(`/generated-images/${imageId}/classify`, { method: "PATCH", body: JSON.stringify({ classification }) }),
  publishGeneratedImage: (productId: number, imageId: number) =>
    request<GeneratedImage>(`/products/${productId}/generated-images/${imageId}/publish`, { method: "POST" }),
  /** Deletes a generated/reference photo from the panel so unwanted or never-classified
   *  generations don't pile up — if it was already published, the real photo is removed from the
   *  platform too, not just locally. */
  deleteGeneratedImage: (imageId: number) => request<{ ok: boolean }>(`/generated-images/${imageId}`, { method: "DELETE" }),
  /** The product's own photos already on the platform, outside CatalogIA's generatedImages table
   *  — shown in the same panel so every photo for a product can be classified from one place. */
  listCatalogImages: (productId: number) => request<CatalogImage[]>(`/products/${productId}/catalog-images`),
  // classification: null clears the photo's Label on the platform entirely.
  classifyCatalogImage: (productId: number, imageId: string, classification: PhotoClassification | null) =>
    request<{ ok: boolean; label: string }>(`/products/${productId}/catalog-images/${imageId}/classify`, {
      method: "PATCH",
      body: JSON.stringify({ classification }),
    }),
  /** Republishes EVERY approved/edited/published proposal this product has in the given run
   *  (description, SEO, tags, keywords, attributes, alt-texts...), plus reordering its photo
   *  carousel to match each photo's current Label — one click for "I changed some Labels/photos,
   *  push it all back out reflecting that". */
  republishProduct: (productId: number, runId: number) =>
    request<{ ok: boolean }>(`/products/${productId}/republish`, { method: "POST", body: JSON.stringify({ runId }) }),
  productRealImpact: (id: number) => request<RealImpact>(`/products/${id}/real-impact`),
  optimizedProductCount: () => request<{ count: number }>("/products/optimized-count"),
  pendingReviewCount: () => request<{ count: number }>("/products/pending-review-count"),
  /** Same per-product "latest run" classification the status filter pills use — see
   *  computeStatusCounts' doc comment for why this replaced optimizedProductCount/
   *  pendingReviewCount on the Products page specifically (those two disagreed with the pills). */
  catalogStatusCounts: () => request<{ none: number; pending: number; published: number }>("/catalog/products/status-counts"),

  getSpendLimits: () => request<ProviderSpend[]>("/spend-limits"),
  setSpendLimit: (provider: LlmProvider, limitUsd: number | null) =>
    request<{ ok: boolean }>("/spend-limits", { method: "PUT", body: JSON.stringify({ provider, limitUsd }) }),

  getFreeQuotas: () => request<FreeQuotaStatus[]>("/free-quotas"),
  setFreeQuota: (provider: LlmProvider, config: { enabled: boolean; quotaUsd: number; resetIntervalHours: number }) =>
    request<{ ok: boolean }>("/free-quotas", { method: "PUT", body: JSON.stringify({ provider, ...config }) }),

  login: (email: string, password: string) =>
    request<LoginResult>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  twoFactorChallenge: (code: string, rememberDevice?: boolean) =>
    request<{ user: AuthUser }>("/auth/two-factor/challenge", { method: "POST", body: JSON.stringify({ code, rememberDevice }) }),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  me: () => request<{ user: AuthUser }>("/auth/me"),
  forgotPassword: (email: string) =>
    request<{ ok: boolean; resetUrl?: string }>("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) }),
  resetPassword: (token: string, password: string) =>
    request<{ ok: boolean }>("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, password }) }),

  updateProfile: (name: string) => request<{ ok: boolean }>("/account/profile", { method: "PUT", body: JSON.stringify({ name }) }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>("/account/password", { method: "PUT", body: JSON.stringify({ currentPassword, newPassword }) }),
  twoFactorSetup: () => request<{ secret: string; qrDataUrl: string }>("/account/two-factor/setup", { method: "POST" }),
  twoFactorConfirm: (code: string) =>
    request<{ ok: boolean }>("/account/two-factor/confirm", { method: "POST", body: JSON.stringify({ code }) }),
  twoFactorDisable: (currentPassword: string) =>
    request<{ ok: boolean }>("/account/two-factor/disable", { method: "POST", body: JSON.stringify({ currentPassword }) }),

  listUsers: () => request<AdminUser[]>("/users"),
  createUser: (body: { name: string; email: string; role: "admin" | "user"; permissions: AppSection[] }) =>
    request<{ user: AdminUser; setupUrl: string }>("/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (
    id: number,
    body: { name?: string; role?: "admin" | "user"; permissions?: AppSection[]; isActive?: boolean },
  ) => request<{ user: AdminUser }>(`/users/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  resetUserPassword: (id: number) => request<{ resetUrl: string }>(`/users/${id}/reset-password`, { method: "POST" }),
  disableUserTwoFactor: (id: number) => request<{ ok: boolean }>(`/users/${id}/disable-two-factor`, { method: "POST" }),
  deleteUser: (id: number) => request<{ ok: boolean }>(`/users/${id}`, { method: "DELETE" }),
};
