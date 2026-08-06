import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { CatalogPlatform } from "../clients/catalog-types.js";
import type { LlmProvider } from "../clients/llm-types.js";
import { IMAGE_GENERATION_MODEL, RECOMMENDATIONS, type PriceTier } from "../clients/model-recommendations.js";
import { db } from "../db/client.js";
import { agentRequestLogs, enrichmentProposals, generatedImages, products } from "../db/schema.js";
import { getCatalogPlatform } from "./catalog-settings.repo.js";

const LLM_PROVIDERS: LlmProvider[] = ["anthropic", "openai", "gemini"];
const PRICE_TIERS: PriceTier[] = ["quality", "balanced", "price"];

const FIELD_LABELS: Record<string, string> = {
  description: "Descricao",
  benefit_bullets: "Bullets",
  technical_specs: "Specs",
  faq: "FAQ",
  structured_data: "Dados estruturados",
  alt_text: "Alt-text",
  seo_title: "Titulo SEO",
  meta_description: "Meta description",
  keywords: "Keywords",
  tags: "Tags",
  cta: "CTA",
  attributes_patch: "Atributos",
  featured_image: "Imagem destacada",
  image_generated: "Imagem gerada",
};

export type OptimizationAnalyticsTier = PriceTier | "unknown";

export interface OptimizationAnalyticsMonth {
  month: string;
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  products: number;
}

export interface OptimizationAnalyticsModel {
  provider: LlmProvider;
  model: string | null;
  tier: OptimizationAnalyticsTier;
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  products: number;
}

export interface OptimizationAnalyticsField {
  field: string;
  label: string;
  count: number;
  products: number;
  runs: number;
  published: number;
  reused: number;
  lastCreatedAt: string | null;
}

export interface OptimizationAnalyticsSummary {
  generatedAt: string;
  platform: CatalogPlatform;
  totals: {
    costUsd: number;
    unassignedCostUsd: number;
    calls: number;
    successfulCalls: number;
    failedCalls: number;
    inputTokens: number;
    outputTokens: number;
    optimizedProducts: number;
    runs: number;
    proposals: number;
    images: number;
  };
  byMonth: OptimizationAnalyticsMonth[];
  byProviderModel: OptimizationAnalyticsModel[];
  byField: OptimizationAnalyticsField[];
}

function numberValue(value: string | number | null | undefined): number {
  return Number(value ?? 0);
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function classifyModelTier(provider: LlmProvider, model: string | null): OptimizationAnalyticsTier {
  if (!model) return "unknown";
  if (model === IMAGE_GENERATION_MODEL) return "unknown";

  const tiers = RECOMMENDATIONS[provider];
  for (const tier of PRICE_TIERS) {
    if (tiers[tier].id === model) return tier;
  }
  return "unknown";
}

async function listActivityProductIds(platform: CatalogPlatform): Promise<Set<number>> {
  const proposalProducts = await db
    .selectDistinct({ productId: enrichmentProposals.productId })
    .from(enrichmentProposals)
    .innerJoin(products, eq(enrichmentProposals.productId, products.id))
    .where(eq(products.platform, platform));

  const imageProducts = await db
    .selectDistinct({ productId: generatedImages.productId })
    .from(generatedImages)
    .innerJoin(products, eq(generatedImages.productId, products.id))
    .where(and(eq(products.platform, platform), ne(generatedImages.kind, "manufacturer_reference")));

  const costProducts = await db
    .selectDistinct({ productId: agentRequestLogs.productId })
    .from(agentRequestLogs)
    .innerJoin(products, eq(agentRequestLogs.productId, products.id))
    .where(
      and(
        inArray(agentRequestLogs.provider, LLM_PROVIDERS),
        isNotNull(agentRequestLogs.productId),
        isNotNull(agentRequestLogs.costUsd),
        eq(products.platform, platform),
      ),
    );

  return new Set([...proposalProducts, ...imageProducts, ...costProducts].map((row) => row.productId as number));
}

export async function getOptimizationAnalytics(): Promise<OptimizationAnalyticsSummary> {
  const platform = await getCatalogPlatform();
  const llmWhere = and(
    inArray(agentRequestLogs.provider, LLM_PROVIDERS),
    isNotNull(agentRequestLogs.productId),
    isNotNull(agentRequestLogs.costUsd),
    eq(products.platform, platform),
  );
  const monthExpr = sql<string>`to_char(date_trunc('month', ${agentRequestLogs.createdAt}), 'YYYY-MM')`;

  const [costTotals] = await db
    .select({
      costUsd: sql<string>`coalesce(sum(${agentRequestLogs.costUsd}), 0)`,
      calls: sql<string>`count(*)`,
      successfulCalls: sql<string>`coalesce(sum(case when ${agentRequestLogs.success} then 1 else 0 end), 0)`,
      failedCalls: sql<string>`coalesce(sum(case when not ${agentRequestLogs.success} then 1 else 0 end), 0)`,
      inputTokens: sql<string>`coalesce(sum(${agentRequestLogs.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${agentRequestLogs.outputTokens}), 0)`,
    })
    .from(agentRequestLogs)
    .innerJoin(products, eq(agentRequestLogs.productId, products.id))
    .where(llmWhere);

  const [proposalTotals] = await db
    .select({
      proposals: sql<string>`count(*)`,
      runs: sql<string>`count(distinct ${enrichmentProposals.runId})`,
    })
    .from(enrichmentProposals)
    .innerJoin(products, eq(enrichmentProposals.productId, products.id))
    .where(eq(products.platform, platform));

  const [imageTotals] = await db
    .select({ images: sql<string>`count(*)` })
    .from(generatedImages)
    .innerJoin(products, eq(generatedImages.productId, products.id))
    .where(and(eq(products.platform, platform), ne(generatedImages.kind, "manufacturer_reference")));

  const [unassignedCost] = await db
    .select({ costUsd: sql<string>`coalesce(sum(${agentRequestLogs.costUsd}), 0)` })
    .from(agentRequestLogs)
    .where(and(inArray(agentRequestLogs.provider, LLM_PROVIDERS), isNotNull(agentRequestLogs.costUsd), sql`${agentRequestLogs.productId} is null`));

  const byMonthRows = await db
    .select({
      month: monthExpr,
      costUsd: sql<string>`coalesce(sum(${agentRequestLogs.costUsd}), 0)`,
      calls: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${agentRequestLogs.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${agentRequestLogs.outputTokens}), 0)`,
      products: sql<string>`count(distinct ${agentRequestLogs.productId})`,
    })
    .from(agentRequestLogs)
    .innerJoin(products, eq(agentRequestLogs.productId, products.id))
    .where(llmWhere)
    .groupBy(monthExpr)
    .orderBy(monthExpr);

  const byProviderModelRows = await db
    .select({
      provider: agentRequestLogs.provider,
      model: agentRequestLogs.model,
      costUsd: sql<string>`coalesce(sum(${agentRequestLogs.costUsd}), 0)`,
      calls: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${agentRequestLogs.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${agentRequestLogs.outputTokens}), 0)`,
      products: sql<string>`count(distinct ${agentRequestLogs.productId})`,
    })
    .from(agentRequestLogs)
    .innerJoin(products, eq(agentRequestLogs.productId, products.id))
    .where(llmWhere)
    .groupBy(agentRequestLogs.provider, agentRequestLogs.model)
    .orderBy(sql`coalesce(sum(${agentRequestLogs.costUsd}), 0) desc`);

  const byFieldRows = await db
    .select({
      field: enrichmentProposals.field,
      count: sql<string>`count(*)`,
      products: sql<string>`count(distinct ${enrichmentProposals.productId})`,
      runs: sql<string>`count(distinct ${enrichmentProposals.runId})`,
      published: sql<string>`coalesce(sum(case when ${enrichmentProposals.status} = 'published' then 1 else 0 end), 0)`,
      reused: sql<string>`coalesce(sum(case when ${enrichmentProposals.reusedFromProductId} is not null then 1 else 0 end), 0)`,
      lastCreatedAt: sql<Date | null>`max(${enrichmentProposals.createdAt})`,
    })
    .from(enrichmentProposals)
    .innerJoin(products, eq(enrichmentProposals.productId, products.id))
    .where(eq(products.platform, platform))
    .groupBy(enrichmentProposals.field)
    .orderBy(sql`count(*) desc`);

  const [imageFieldRow] = await db
    .select({
      count: sql<string>`count(*)`,
      products: sql<string>`count(distinct ${generatedImages.productId})`,
      published: sql<string>`coalesce(sum(case when ${generatedImages.publishedAt} is not null then 1 else 0 end), 0)`,
      lastCreatedAt: sql<Date | null>`max(${generatedImages.createdAt})`,
    })
    .from(generatedImages)
    .innerJoin(products, eq(generatedImages.productId, products.id))
    .where(and(eq(products.platform, platform), ne(generatedImages.kind, "manufacturer_reference")));

  const activityProductIds = await listActivityProductIds(platform);
  const imageCount = numberValue(imageFieldRow?.count);

  const byField: OptimizationAnalyticsField[] = byFieldRows.map((row) => ({
    field: row.field,
    label: FIELD_LABELS[row.field] ?? row.field,
    count: numberValue(row.count),
    products: numberValue(row.products),
    runs: numberValue(row.runs),
    published: numberValue(row.published),
    reused: numberValue(row.reused),
    lastCreatedAt: isoOrNull(row.lastCreatedAt),
  }));

  if (imageCount > 0) {
    byField.push({
      field: "image_generated",
      label: FIELD_LABELS.image_generated,
      count: imageCount,
      products: numberValue(imageFieldRow?.products),
      runs: 0,
      published: numberValue(imageFieldRow?.published),
      reused: 0,
      lastCreatedAt: isoOrNull(imageFieldRow?.lastCreatedAt),
    });
    byField.sort((a, b) => b.count - a.count);
  }

  return {
    generatedAt: new Date().toISOString(),
    platform,
    totals: {
      costUsd: numberValue(costTotals?.costUsd),
      unassignedCostUsd: numberValue(unassignedCost?.costUsd),
      calls: numberValue(costTotals?.calls),
      successfulCalls: numberValue(costTotals?.successfulCalls),
      failedCalls: numberValue(costTotals?.failedCalls),
      inputTokens: numberValue(costTotals?.inputTokens),
      outputTokens: numberValue(costTotals?.outputTokens),
      optimizedProducts: activityProductIds.size,
      runs: numberValue(proposalTotals?.runs),
      proposals: numberValue(proposalTotals?.proposals),
      images: numberValue(imageTotals?.images),
    },
    byMonth: byMonthRows.map((row) => ({
      month: row.month,
      costUsd: numberValue(row.costUsd),
      calls: numberValue(row.calls),
      inputTokens: numberValue(row.inputTokens),
      outputTokens: numberValue(row.outputTokens),
      products: numberValue(row.products),
    })),
    byProviderModel: byProviderModelRows.map((row) => {
      const provider = row.provider as LlmProvider;
      return {
        provider,
        model: row.model,
        tier: classifyModelTier(provider, row.model),
        costUsd: numberValue(row.costUsd),
        calls: numberValue(row.calls),
        inputTokens: numberValue(row.inputTokens),
        outputTokens: numberValue(row.outputTokens),
        products: numberValue(row.products),
      };
    }),
    byField,
  };
}
