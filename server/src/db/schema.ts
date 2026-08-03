import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  vector,
} from "drizzle-orm/pg-core";

export const providerEnum = pgEnum("provider", ["vtex", "google", "anthropic", "openai", "gemini", "shopify"]);
export const llmTaskEnum = pgEnum("llm_task", ["contentEnrichment", "imageAltText", "evaluator"]);
export const llmProviderEnum = pgEnum("llm_provider", ["anthropic", "openai", "gemini"]);
export const catalogPlatformEnum = pgEnum("catalog_platform", ["vtex", "shopify"]);
export const metricSourceEnum = pgEnum("metric_source", ["gsc", "ga4"]);
export const runStatusEnum = pgEnum("run_status", ["running", "success", "failed", "partial"]);
export const proposalFieldEnum = pgEnum("proposal_field", [
  "description",
  "alt_text",
  "structured_data",
  "faq",
  "benefit_bullets",
  "technical_specs",
]);
export const proposalAgentEnum = pgEnum("proposal_agent", ["content", "image"]);
export const proposalStatusEnum = pgEnum("proposal_status", [
  "pending",
  "approved",
  "rejected",
  "edited",
  "published",
]);
export const scoreTargetEnum = pgEnum("score_target", ["original", "proposed"]);
export const userRoleEnum = pgEnum("user_role", ["admin", "user"]);
export const appSectionEnum = pgEnum("app_section", ["connections", "publish", "users"]);

/** Every external credential (VTEX keys, Anthropic key, Google OAuth refresh token) lives here, encrypted. */
export const connections = pgTable("connections", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  provider: providerEnum("provider").notNull(),
  displayName: text("display_name").notNull(),
  credentialsEncrypted: text("credentials_encrypted").notNull(),
  status: text("status").notNull().default("untested"),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Local snapshot of the store's catalog, refreshed by the catalog-reader agent. `vtexProductId`/
 *  `vtexSkuId` hold the external product/variant id regardless of platform (Shopify GIDs included)
 *  — kept named after VTEX since it was the only platform when the columns were added; `platform`
 *  records which one a given row actually came from. */
export const products = pgTable("products", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  platform: catalogPlatformEnum("platform").notNull().default("vtex"),
  vtexProductId: text("vtex_product_id").notNull(),
  vtexSkuId: text("vtex_sku_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  images: jsonb("images").notNull().default(sql`'[]'::jsonb`),
  attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
  category: text("category"),
  brand: text("brand"),
  // Merchant-assigned SKU code (VTEX RefId / Shopify variant sku) — distinct from vtexSkuId, which
  // is the internal variant identifier used for API calls, not what a merchant calls "the SKU".
  sku: text("sku"),
  url: text("url"),
  // 1536 dims matches text-embedding-3-small-equivalent output; used only for the pgvector
  // stretch goal (near-duplicate/generic-description detection to help the Analyst prioritize).
  embedding: vector("embedding", { dimensions: 1536 }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  vtexProductIdIdx: index("products_vtex_product_id_idx").on(table.vtexProductId),
}));

/** GSC/GA4 snapshots per product, used to prioritize and to prove before/after impact. */
export const productMetrics = pgTable("product_metrics", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  productId: bigint("product_id", { mode: "number" })
    .notNull()
    .references(() => products.id),
  source: metricSourceEnum("source").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  impressions: integer("impressions"),
  clicks: integer("clicks"),
  ctr: numeric("ctr"),
  avgPosition: numeric("avg_position"),
  sessions: integer("sessions"),
  conversionRate: numeric("conversion_rate"),
  revenue: numeric("revenue"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  productIdIdx: index("product_metrics_product_id_idx").on(table.productId),
}));

/** Top-level tracking for one enrichment pipeline execution — mirrors Mundial's integration_sync_runs. */
export const enrichmentRuns = pgTable("enrichment_runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  status: runStatusEnum("status").notNull().default("running"),
  scope: jsonb("scope").notNull().default(sql`'{}'::jsonb`),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  processedCount: integer("processed_count").notNull().default(0),
  summary: jsonb("summary"),
  errorMessage: text("error_message"),
});

/** One proposed change (description/alt-text/structured-data/faq) awaiting human review. */
export const enrichmentProposals = pgTable("enrichment_proposals", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  runId: bigint("run_id", { mode: "number" })
    .notNull()
    .references(() => enrichmentRuns.id),
  productId: bigint("product_id", { mode: "number" })
    .notNull()
    .references(() => products.id),
  field: proposalFieldEnum("field").notNull(),
  agent: proposalAgentEnum("agent").notNull(),
  originalValue: text("original_value"),
  proposedValue: text("proposed_value").notNull(),
  status: proposalStatusEnum("status").notNull().default("pending"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  // Set only when this content was generated by adapting a near-duplicate product's
  // already-approved proposal (the RAG/dedup cost-saving path) instead of writing from scratch —
  // see content-enrichment.agent.ts. Null means it went through full generation as normal.
  reusedFromProductId: bigint("reused_from_product_id", { mode: "number" }).references(() => products.id),
  reusedSimilarity: numeric("reused_similarity"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runIdIdx: index("enrichment_proposals_run_id_idx").on(table.runId),
  productIdIdx: index("enrichment_proposals_product_id_idx").on(table.productId),
  statusIdx: index("enrichment_proposals_status_idx").on(table.status),
}));

/** Before/after content quality score for a product within a run — the "does this actually help
 *  the user" evidence that doesn't have to wait on Google's crawl/re-rank lag. checklistScore is
 *  computed with no AI call (structural signals only); the rest comes from one Claude judge call. */
export const contentScores = pgTable("content_scores", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  runId: bigint("run_id", { mode: "number" })
    .notNull()
    .references(() => enrichmentRuns.id),
  productId: bigint("product_id", { mode: "number" })
    .notNull()
    .references(() => products.id),
  target: scoreTargetEnum("target").notNull(),
  checklistScore: integer("checklist_score").notNull(),
  buyerConfidence: integer("buyer_confidence").notNull(),
  buyerUnanswered: jsonb("buyer_unanswered").notNull().default(sql`'[]'::jsonb`),
  geoAnswerableCount: integer("geo_answerable_count").notNull(),
  geoTotalQuestions: integer("geo_total_questions").notNull(),
  unsupportedClaims: jsonb("unsupported_claims").notNull().default(sql`'[]'::jsonb`),
  overallScore: integer("overall_score").notNull(),
  // How many quality-gate drafts it took to land on this score — always 1 for "original".
  attempts: integer("attempts").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runIdIdx: index("content_scores_run_id_idx").on(table.runId),
}));

/** Fine-grained log of every external API call — proves retry/error handling actually works. */
export const agentRequestLogs = pgTable("agent_request_logs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  runId: bigint("run_id", { mode: "number" }).references(() => enrichmentRuns.id),
  provider: providerEnum("provider").notNull(),
  operation: text("operation").notNull(),
  endpoint: text("endpoint").notNull(),
  method: text("method").notNull(),
  statusCode: integer("status_code"),
  success: boolean("success").notNull(),
  attempt: integer("attempt").notNull().default(1),
  durationMs: integer("duration_ms"),
  error: text("error"),
  meta: jsonb("meta"),
  // Anthropic calls only — which model ran, token usage, computed USD cost, and (when known)
  // which product the call was made for. Powers the per-run/per-product cost views.
  model: text("model"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: numeric("cost_usd"),
  productId: bigint("product_id", { mode: "number" }).references(() => products.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runIdIdx: index("agent_request_logs_run_id_idx").on(table.runId),
}));

/** Which provider+model runs each pipeline task — always exactly 3 rows (one per task), upserted
 *  together from the Connections panel's "Roteamento de modelos" section. Replaces the old
 *  per-connection `AnthropicCredentials.models` field now that a task can point at any provider. */
export const modelRouting = pgTable("model_routing", {
  task: llmTaskEnum("task").primaryKey(),
  provider: llmProviderEnum("provider").notNull(),
  model: text("model").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Which catalog platform (VTEX or Shopify) is currently active — always exactly 1 row (id=1),
 *  upserted from the Connections panel's platform selector. Only one platform runs the pipeline
 *  at a time. */
export const catalogSettings = pgTable("catalog_settings", {
  id: integer("id").primaryKey().default(1),
  platform: catalogPlatformEnum("platform").notNull().default("vtex"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-provider monthly spending cap (USD) — a row only exists once a limit has been set for that
 *  provider via the Connections panel; no row means no limit configured. Resets on the 1st of each
 *  calendar month (periodStartAt tracks the current month's start, lazily advanced on read — same
 *  no-cron-needed pattern as providerFreeQuotas). Enforced as a circuit breaker: once a provider's
 *  spend for the current month reaches its limit, new runs that would use it are blocked. */
export const providerSpendLimits = pgTable("provider_spend_limits", {
  provider: llmProviderEnum("provider").primaryKey(),
  limitUsd: numeric("limit_usd").notNull(),
  periodStartAt: timestamp("period_start_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Free-tier quota per provider (e.g. "only use Gemini's free daily allowance") — distinct from
 *  providerSpendLimits (an all-time hard cap): this tracks spend within a *rolling period* that
 *  auto-resets every `reset_interval_hours`, mirroring how providers' own free tiers reset. Reads
 *  lazily advance `period_start_at` forward by whole intervals instead of needing a cron job. */
export const providerFreeQuotas = pgTable("provider_free_quotas", {
  provider: llmProviderEnum("provider").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  quotaUsd: numeric("quota_usd").notNull().default("0"),
  resetIntervalHours: integer("reset_interval_hours").notNull().default(24),
  periodStartAt: timestamp("period_start_at", { withTimezone: true }).notNull().defaultNow(),
});

/** `role='admin'` always bypasses the `permissions` check (mirrors Mundial's admin/master bypass).
 *  `permissions` is a JSON array of appSection values — only meaningful for role='user'.
 *  `pendingTwoFactorSecret` holds a freshly-generated TOTP secret between "show me the QR code"
 *  and "confirm the 6-digit code" — cleared either way once confirmed or abandoned. */
export const users = pgTable("users", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("user"),
  permissions: jsonb("permissions").notNull().default(sql`'[]'::jsonb`),
  isActive: boolean("is_active").notNull().default(true),
  twoFactorSecretEncrypted: text("two_factor_secret_encrypted"),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  pendingTwoFactorSecret: text("pending_two_factor_secret"),
  invitedAt: timestamp("invited_at", { withTimezone: true }),
  invitationAcceptedAt: timestamp("invitation_accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Server-side session — `id` is itself the unguessable token (32 random bytes, hex), set as the
 *  `session_id` cookie value, not an auto-increment id. `twoFactorPending` means the password was
 *  correct but the 2FA challenge hasn't been passed yet — session exists but isn't fully authed. */
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" })
    .notNull()
    .references(() => users.id),
  twoFactorPending: boolean("two_factor_pending").notNull().default(false),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index("sessions_user_id_idx").on(table.userId),
}));

/** One-time password-reset tokens — `tokenHash` (sha256 of the raw token) is stored, never the raw
 *  token itself, same as the raw token never touching disk anywhere except the one-time link shown
 *  to the user. `usedAt` prevents replay once consumed. */
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: bigint("user_id", { mode: "number" })
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** "Remember this device" after a 2FA challenge — `tokenHash` is checked against the `device_token`
 *  cookie so a trusted browser skips the TOTP prompt on subsequent logins until it expires. */
export const twoFactorTrustedDevices = pgTable("two_factor_trusted_devices", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: bigint("user_id", { mode: "number" })
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
