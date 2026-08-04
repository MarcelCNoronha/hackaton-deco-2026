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
    throw new ApiError(body.error ?? `Request to ${path} failed with ${res.status}`, res.status);
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
}

export interface CatalogFilterOptions {
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

export type ScoreTier = "excelente" | "bom" | "medio";

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
  if (!threshold) return "medio";
  if (overallScore >= threshold.excellentMin) return "excelente";
  if (overallScore >= threshold.goodMin) return "bom";
  return "medio";
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
export const PDP_BLOCKS = ["description", "benefit_bullets", "technical_specs", "featured_image", "faq", "cta"] as const;
export type PdpBlock = (typeof PDP_BLOCKS)[number];

export interface PdpTemplate {
  platform: CatalogPlatform;
  category: string;
  level: DescriptionRichness;
  blocks: PdpBlock[];
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

/** An AI-generated marketing image produced FROM the product's existing photos (never from
 *  scratch) — "lifestyle" places it in a realistic use setting, "feature_callout" highlights one
 *  detail. `imageBase64` is raw base64 (no `data:` prefix) — build the src as
 *  `data:${mimeType};base64,${imageBase64}`. */
export interface GeneratedImage {
  id: number;
  productId: number;
  kind: "lifestyle" | "feature_callout";
  prompt: string;
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
  createdAt: string;
}

export interface ProductMetric {
  id: number;
  source: "gsc" | "ga4";
  periodStart: string;
  periodEnd: string;
  impressions: number | null;
  clicks: number | null;
  ctr: string | null;
  avgPosition: string | null;
  sessions: number | null;
  conversionRate: string | null;
  revenue: string | null;
  fetchedAt: string;
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
  connectVtex: (body: { displayName: string; account: string; environment: string; appKey: string; appToken: string }) =>
    request<{ ok: boolean }>("/connections/vtex", { method: "POST", body: JSON.stringify(body) }),
  connectShopify: (body: { displayName: string; shopDomain: string; accessToken: string }) =>
    request<{ ok: boolean }>("/connections/shopify", { method: "POST", body: JSON.stringify(body) }),
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

  getPdpTemplates: () => request<{ platform: CatalogPlatform; templates: PdpTemplate[] }>("/pdp-templates"),
  setPdpTemplate: (body: { level: DescriptionRichness; blocks: PdpBlock[] }) =>
    request<{ platform: CatalogPlatform; templates: PdpTemplate[] }>("/pdp-templates", { method: "PUT", body: JSON.stringify(body) }),

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

  listProducts: () => request<Product[]>("/products"),
  resyncProduct: (id: number) => request<Product>(`/products/${id}/resync`, { method: "POST" }),
  listGeneratedImages: (productId: number) => request<GeneratedImage[]>(`/products/${productId}/generated-images`),
  generateImage: (productId: number, body: { kind: "lifestyle" | "feature_callout"; note?: string }) =>
    request<GeneratedImage>(`/products/${productId}/generated-images`, { method: "POST", body: JSON.stringify(body) }),
  publishGeneratedImage: (productId: number, imageId: number) =>
    request<GeneratedImage>(`/products/${productId}/generated-images/${imageId}/publish`, { method: "POST" }),
  productMetrics: (id: number) => request<ProductMetric[]>(`/products/${id}/metrics`),
  optimizedProductCount: () => request<{ count: number }>("/products/optimized-count"),
  pendingReviewCount: () => request<{ count: number }>("/products/pending-review-count"),

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
