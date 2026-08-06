import { and, inArray, isNotNull, sql } from "drizzle-orm";
import { MATURATION_DAYS, PRELIMINARY_IMPACT_DAYS } from "../agents/impact.agent.js";
import type { Ga4Client, Ga4DailyItemReportRow, Ga4DailyPageReportRow } from "../clients/ga4.client.js";
import type { GscClient, GscDailyPageRow } from "../clients/gsc.client.js";
import { db } from "../db/client.js";
import { agentRequestLogs, products } from "../db/schema.js";
import { getEarliestPublishedAtByProduct } from "./real-impact.repo.js";

export const BUSINESS_IMPACT_WINDOW_DAYS = 28;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type RevenueSource = "item" | "page" | "none";
type BusinessImpactStatus = "missing_google" | "no_published_products" | "no_mature_products" | "no_google_data" | "ready";
type BusinessImpactConfidence = "waiting" | "preliminary" | "low_data" | "partial" | "complete";
type BusinessImpactStage = "preliminary" | "mature";

export interface BusinessImpactWindow {
  impressions: number;
  clicks: number;
  ctr: number | null;
  avgPosition: number | null;
  sessions: number;
  engagedSessions: number;
  engagementRate: number | null;
  itemViews: number;
  addToCarts: number;
  checkouts: number;
  purchases: number;
  purchaseRate: number | null;
  revenue: number;
  pageRevenue: number;
  itemRevenue: number;
}

export interface BusinessImpactDeltas {
  impressionsPct: number | null;
  clicksPct: number | null;
  ctrPoints: number | null;
  positionDelta: number | null;
  sessionsPct: number | null;
  engagedSessionsPct: number | null;
  engagementRatePoints: number | null;
  itemViewsPct: number | null;
  addToCartsPct: number | null;
  checkoutsPct: number | null;
  purchasesPct: number | null;
  purchaseRatePoints: number | null;
  revenueAbs: number;
  revenuePct: number | null;
}

export interface BusinessImpactProduct {
  productId: number;
  title: string;
  externalId: string;
  sku: string | null;
  url: string | null;
  category: string | null;
  brand: string | null;
  publishedAt: string;
  stage: BusinessImpactStage;
  gscMature: boolean;
  beforeStartDate: string;
  beforeEndDate: string;
  afterStartDate: string;
  afterEndDate: string;
  afterWindowDays: number;
  revenueSource: RevenueSource;
  aiCostUsd: number;
  hasGoogleData: boolean;
  before: BusinessImpactWindow;
  after: BusinessImpactWindow;
  deltas: BusinessImpactDeltas;
}

export interface BusinessImpactSummary {
  status: BusinessImpactStatus;
  confidence: BusinessImpactConfidence;
  generatedAt: string;
  windowDays: number;
  preliminaryDays: number;
  maturationDays: number;
  revenueCurrency: string;
  revenueSource: RevenueSource | "mixed";
  productCounts: {
    published: number;
    missingUrl: number;
    maturing: number;
    preliminary: number;
    mature: number;
    measured: number;
    fullAfterWindow: number;
    partialAfterWindow: number;
    itemMatched: number;
  };
  aiCostUsd: number;
  before: BusinessImpactWindow;
  after: BusinessImpactWindow;
  deltas: BusinessImpactDeltas;
  products: BusinessImpactProduct[];
}

type ProductRow = typeof products.$inferSelect;

interface AnalyzableProduct {
  product: ProductRow;
  publishedAt: Date;
  stage: BusinessImpactStage;
  gscMature: boolean;
  beforeStart: Date;
  beforeEnd: Date;
  afterStart: Date;
  afterEnd: Date;
  afterWindowDays: number;
}

interface MetricAccumulator {
  impressions: number;
  clicks: number;
  positionWeightedSum: number;
  positionWeight: number;
  sessions: number;
  engagedSessions: number;
  itemViews: number;
  addToCarts: number;
  checkouts: number;
  purchases: number;
  pagePurchases: number;
  itemPurchases: number;
  pageRevenue: number;
  itemRevenue: number;
}

function emptyAccumulator(): MetricAccumulator {
  return {
    impressions: 0,
    clicks: 0,
    positionWeightedSum: 0,
    positionWeight: 0,
    sessions: 0,
    engagedSessions: 0,
    itemViews: 0,
    addToCarts: 0,
    checkouts: 0,
    purchases: 0,
    pagePurchases: 0,
    itemPurchases: 0,
    pageRevenue: 0,
    itemRevenue: 0,
  };
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() < b.getTime() ? a : b;
}

function fmt(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysInclusive(start: Date, end: Date): number {
  return Math.max(0, Math.floor((startOfUtcDay(end).getTime() - startOfUtcDay(start).getTime()) / MS_PER_DAY) + 1);
}

function pctDelta(before: number, after: number): number | null {
  if (before === 0) return after === 0 ? 0 : 100;
  return Math.round(((after - before) / before) * 1000) / 10;
}

function pointDelta(before: number | null, after: number | null): number | null {
  if (before === null || after === null) return null;
  return Math.round((after - before) * 1000) / 10;
}

function normalizeGa4Date(value: string): string {
  if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  return value;
}

function pathOnly(urlOrPath: string | null): string | null {
  if (!urlOrPath) return null;
  try {
    return new URL(urlOrPath, "https://catalogia.local").pathname;
  } catch {
    return urlOrPath.split("?")[0]?.split("#")[0] ?? urlOrPath;
  }
}

function mapKey(date: string, path: string): string {
  return `${date}|${path}`;
}

function productDateKey(productId: number, date: string): string {
  return `${productId}|${date}`;
}

function addGsc(acc: MetricAccumulator, row?: GscDailyPageRow) {
  if (!row) return;
  acc.impressions += row.impressions;
  acc.clicks += row.clicks;
  if (row.impressions > 0) {
    acc.positionWeightedSum += row.position * row.impressions;
    acc.positionWeight += row.impressions;
  }
}

function addGa4Page(acc: MetricAccumulator, row?: Ga4DailyPageReportRow) {
  if (!row) return;
  acc.sessions += row.sessions;
  acc.engagedSessions += row.engagedSessions;
  acc.pagePurchases += row.purchases;
  acc.pageRevenue += row.revenue;
}

function addGa4Item(acc: MetricAccumulator, row?: Pick<Ga4DailyItemReportRow, "itemsViewed" | "itemsAddedToCart" | "itemsCheckedOut" | "itemsPurchased" | "itemRevenue">) {
  if (!row) return;
  acc.itemViews += row.itemsViewed;
  acc.addToCarts += row.itemsAddedToCart;
  acc.checkouts += row.itemsCheckedOut;
  acc.itemPurchases += row.itemsPurchased;
  acc.itemRevenue += row.itemRevenue;
}

function finalizeWindow(acc: MetricAccumulator, revenueSource: RevenueSource): BusinessImpactWindow {
  const purchases = revenueSource === "item" ? acc.itemPurchases : revenueSource === "page" ? acc.pagePurchases : 0;
  const revenue = revenueSource === "item" ? acc.itemRevenue : revenueSource === "page" ? acc.pageRevenue : 0;
  return {
    impressions: Math.round(acc.impressions),
    clicks: Math.round(acc.clicks),
    ctr: acc.impressions > 0 ? acc.clicks / acc.impressions : null,
    avgPosition: acc.positionWeight > 0 ? Math.round((acc.positionWeightedSum / acc.positionWeight) * 10) / 10 : null,
    sessions: Math.round(acc.sessions),
    engagedSessions: Math.round(acc.engagedSessions),
    engagementRate: acc.sessions > 0 ? acc.engagedSessions / acc.sessions : null,
    itemViews: Math.round(acc.itemViews),
    addToCarts: Math.round(acc.addToCarts),
    checkouts: Math.round(acc.checkouts),
    purchases: Math.round(purchases),
    purchaseRate: acc.sessions > 0 ? purchases / acc.sessions : null,
    revenue: Math.round(revenue * 100) / 100,
    pageRevenue: Math.round(acc.pageRevenue * 100) / 100,
    itemRevenue: Math.round(acc.itemRevenue * 100) / 100,
  };
}

function emptyWindow(): BusinessImpactWindow {
  return finalizeWindow(emptyAccumulator(), "none");
}

function computeDeltas(before: BusinessImpactWindow, after: BusinessImpactWindow): BusinessImpactDeltas {
  return {
    impressionsPct: pctDelta(before.impressions, after.impressions),
    clicksPct: pctDelta(before.clicks, after.clicks),
    ctrPoints: pointDelta(before.ctr, after.ctr),
    positionDelta:
      before.avgPosition !== null && after.avgPosition !== null
        ? Math.round((after.avgPosition - before.avgPosition) * 10) / 10
        : null,
    sessionsPct: pctDelta(before.sessions, after.sessions),
    engagedSessionsPct: pctDelta(before.engagedSessions, after.engagedSessions),
    engagementRatePoints: pointDelta(before.engagementRate, after.engagementRate),
    itemViewsPct: pctDelta(before.itemViews, after.itemViews),
    addToCartsPct: pctDelta(before.addToCarts, after.addToCarts),
    checkoutsPct: pctDelta(before.checkouts, after.checkouts),
    purchasesPct: pctDelta(before.purchases, after.purchases),
    purchaseRatePoints: pointDelta(before.purchaseRate, after.purchaseRate),
    revenueAbs: Math.round((after.revenue - before.revenue) * 100) / 100,
    revenuePct: pctDelta(before.revenue, after.revenue),
  };
}

function hasData(window: BusinessImpactWindow): boolean {
  return (
    window.impressions +
      window.clicks +
      window.sessions +
      window.engagedSessions +
      window.itemViews +
      window.purchases +
      window.revenue >
    0
  );
}

function productIdentityKeys(product: ProductRow): string[] {
  return [product.vtexProductId, product.vtexSkuId, product.sku]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function mergeWindow(acc: MetricAccumulator, window: BusinessImpactWindow) {
  acc.impressions += window.impressions;
  acc.clicks += window.clicks;
  if (window.avgPosition !== null && window.impressions > 0) {
    acc.positionWeightedSum += window.avgPosition * window.impressions;
    acc.positionWeight += window.impressions;
  }
  acc.sessions += window.sessions;
  acc.engagedSessions += window.engagedSessions;
  acc.itemViews += window.itemViews;
  acc.addToCarts += window.addToCarts;
  acc.checkouts += window.checkouts;
  acc.pagePurchases += window.purchases;
  acc.itemPurchases += window.purchases;
  acc.pageRevenue += window.revenue;
  acc.itemRevenue += window.revenue;
}

async function costByProduct(productIds: number[]): Promise<Map<number, number>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({ productId: agentRequestLogs.productId, costUsd: sql<string>`coalesce(sum(${agentRequestLogs.costUsd}), 0)` })
    .from(agentRequestLogs)
    .where(and(isNotNull(agentRequestLogs.productId), isNotNull(agentRequestLogs.costUsd), inArray(agentRequestLogs.productId, productIds)))
    .groupBy(agentRequestLogs.productId);
  return new Map(rows.map((row) => [row.productId as number, Number(row.costUsd)]));
}

function buildEmptySummary(status: BusinessImpactStatus, counts?: Partial<BusinessImpactSummary["productCounts"]>): BusinessImpactSummary {
  const before = emptyWindow();
  const after = emptyWindow();
  return {
    status,
    confidence: status === "no_mature_products" ? "waiting" : "low_data",
    generatedAt: new Date().toISOString(),
    windowDays: BUSINESS_IMPACT_WINDOW_DAYS,
    preliminaryDays: PRELIMINARY_IMPACT_DAYS,
    maturationDays: MATURATION_DAYS,
    revenueCurrency: "BRL",
    revenueSource: "none",
    productCounts: {
      published: 0,
      missingUrl: 0,
      maturing: 0,
      preliminary: 0,
      mature: 0,
      measured: 0,
      fullAfterWindow: 0,
      partialAfterWindow: 0,
      itemMatched: 0,
      ...counts,
    },
    aiCostUsd: 0,
    before,
    after,
    deltas: computeDeltas(before, after),
    products: [],
  };
}

export async function getBusinessImpactSummary(params: {
  gsc: GscClient | null;
  ga4: Ga4Client | null;
}): Promise<BusinessImpactSummary> {
  if (!params.gsc && !params.ga4) return buildEmptySummary("missing_google");

  const productRows = await db.query.products.findMany();
  const publishedAtByProduct = await getEarliestPublishedAtByProduct(productRows.map((product) => product.id));
  const publishedProducts = productRows.filter((product) => publishedAtByProduct.has(product.id));
  if (publishedProducts.length === 0) return buildEmptySummary("no_published_products");

  const today = startOfUtcDay(new Date());
  const analyzableProducts: AnalyzableProduct[] = [];
  let missingUrl = 0;
  let maturing = 0;

  for (const product of publishedProducts) {
    const publishedAt = publishedAtByProduct.get(product.id);
    if (!publishedAt) continue;
    if (!product.url) {
      missingUrl += 1;
      continue;
    }

    const publishedDay = startOfUtcDay(publishedAt);
    const preliminaryStart = addDays(publishedDay, PRELIMINARY_IMPACT_DAYS);
    const matureStart = addDays(publishedDay, MATURATION_DAYS);
    if (preliminaryStart.getTime() > today.getTime()) {
      maturing += 1;
      continue;
    }

    const stage: BusinessImpactStage = matureStart.getTime() <= today.getTime() ? "mature" : "preliminary";
    const afterStart = stage === "mature" ? matureStart : preliminaryStart;
    const afterEnd = minDate(today, addDays(afterStart, BUSINESS_IMPACT_WINDOW_DAYS - 1));
    analyzableProducts.push({
      product,
      publishedAt,
      stage,
      gscMature: stage === "mature",
      beforeStart: addDays(publishedDay, -BUSINESS_IMPACT_WINDOW_DAYS),
      beforeEnd: addDays(publishedDay, -1),
      afterStart,
      afterEnd,
      afterWindowDays: daysInclusive(afterStart, afterEnd),
    });
  }

  if (analyzableProducts.length === 0) {
    return buildEmptySummary("no_mature_products", {
      published: publishedProducts.length,
      missingUrl,
      maturing,
    });
  }

  const startDate = fmt(
    analyzableProducts.reduce((min, row) => (row.beforeStart < min ? row.beforeStart : min), analyzableProducts[0].beforeStart),
  );
  const endDate = fmt(
    analyzableProducts.reduce((max, row) => (row.afterEnd > max ? row.afterEnd : max), analyzableProducts[0].afterEnd),
  );

  const [gscRows, ga4PageRows, ga4ItemRows, productCosts] = await Promise.all([
    params.gsc ? params.gsc.queryByPageAndDate({ startDate, endDate }).catch(() => []) : Promise.resolve([]),
    params.ga4 ? params.ga4.runProductPageDailyReport({ startDate, endDate }).catch(() => []) : Promise.resolve([]),
    params.ga4 ? params.ga4.runItemDailyReport({ startDate, endDate }).catch(() => []) : Promise.resolve([]),
    costByProduct(analyzableProducts.map((row) => row.product.id)),
  ]);

  const gscByDatePath = new Map<string, GscDailyPageRow>();
  for (const row of gscRows) {
    const path = pathOnly(row.page);
    if (path) gscByDatePath.set(mapKey(row.date, path), row);
  }

  const ga4PageByDatePath = new Map<string, Ga4DailyPageReportRow>();
  for (const row of ga4PageRows) {
    const path = pathOnly(row.pagePath);
    if (path) ga4PageByDatePath.set(mapKey(normalizeGa4Date(row.date), path), row);
  }

  const productIdByItemKey = new Map<string, number>();
  for (const { product } of analyzableProducts) {
    for (const key of productIdentityKeys(product)) productIdByItemKey.set(key, product.id);
  }

  const ga4ItemByProductDate = new Map<string, Ga4DailyItemReportRow>();
  for (const row of ga4ItemRows) {
    const productId = productIdByItemKey.get(row.itemId.trim().toLowerCase());
    if (!productId) continue;
    const key = productDateKey(productId, normalizeGa4Date(row.date));
    const current = ga4ItemByProductDate.get(key);
    if (!current) {
      ga4ItemByProductDate.set(key, { ...row, date: normalizeGa4Date(row.date) });
    } else {
      current.itemsViewed += row.itemsViewed;
      current.itemsAddedToCart += row.itemsAddedToCart;
      current.itemsCheckedOut += row.itemsCheckedOut;
      current.itemsPurchased += row.itemsPurchased;
      current.itemRevenue += row.itemRevenue;
    }
  }

  const productsImpact: BusinessImpactProduct[] = [];
  const beforeTotalAcc = emptyAccumulator();
  const afterTotalAcc = emptyAccumulator();
  let measured = 0;
  let fullAfterWindow = 0;
  let partialAfterWindow = 0;
  let itemMatched = 0;
  let measuredPreliminary = 0;

  for (const row of analyzableProducts) {
    const path = pathOnly(row.product.url);
    if (!path) continue;

    const beforeAcc = emptyAccumulator();
    const afterAcc = emptyAccumulator();

    for (let date = row.beforeStart; date.getTime() <= row.beforeEnd.getTime(); date = addDays(date, 1)) {
      const dateKey = fmt(date);
      if (row.gscMature) addGsc(beforeAcc, gscByDatePath.get(mapKey(dateKey, path)));
      addGa4Page(beforeAcc, ga4PageByDatePath.get(mapKey(dateKey, path)));
      addGa4Item(beforeAcc, ga4ItemByProductDate.get(productDateKey(row.product.id, dateKey)));
    }

    for (let date = row.afterStart; date.getTime() <= row.afterEnd.getTime(); date = addDays(date, 1)) {
      const dateKey = fmt(date);
      if (row.gscMature) addGsc(afterAcc, gscByDatePath.get(mapKey(dateKey, path)));
      addGa4Page(afterAcc, ga4PageByDatePath.get(mapKey(dateKey, path)));
      addGa4Item(afterAcc, ga4ItemByProductDate.get(productDateKey(row.product.id, dateKey)));
    }

    const hasItemData =
      beforeAcc.itemViews +
        beforeAcc.itemPurchases +
        beforeAcc.itemRevenue +
        afterAcc.itemViews +
        afterAcc.itemPurchases +
        afterAcc.itemRevenue >
      0;
    const hasPageFinancialData = beforeAcc.pagePurchases + beforeAcc.pageRevenue + afterAcc.pagePurchases + afterAcc.pageRevenue > 0;
    const revenueSource: RevenueSource = hasItemData ? "item" : hasPageFinancialData ? "page" : "none";
    if (hasItemData) itemMatched += 1;

    const before = finalizeWindow(beforeAcc, revenueSource);
    const after = finalizeWindow(afterAcc, revenueSource);
    const hasGoogleData = hasData(before) || hasData(after);
    if (hasGoogleData) {
      measured += 1;
      if (row.stage === "preliminary") measuredPreliminary += 1;
    }
    if (row.afterWindowDays >= BUSINESS_IMPACT_WINDOW_DAYS) fullAfterWindow += 1;
    else partialAfterWindow += 1;

    mergeWindow(beforeTotalAcc, before);
    mergeWindow(afterTotalAcc, after);

    productsImpact.push({
      productId: row.product.id,
      title: row.product.title,
      externalId: row.product.vtexProductId,
      sku: row.product.sku,
      url: row.product.url,
      category: row.product.category,
      brand: row.product.brand,
      publishedAt: row.publishedAt.toISOString(),
      stage: row.stage,
      gscMature: row.gscMature,
      beforeStartDate: fmt(row.beforeStart),
      beforeEndDate: fmt(row.beforeEnd),
      afterStartDate: fmt(row.afterStart),
      afterEndDate: fmt(row.afterEnd),
      afterWindowDays: row.afterWindowDays,
      revenueSource,
      aiCostUsd: Math.round((productCosts.get(row.product.id) ?? 0) * 10000) / 10000,
      hasGoogleData,
      before,
      after,
      deltas: computeDeltas(before, after),
    });
  }

  const revenueSources = new Set(productsImpact.filter((product) => product.hasGoogleData).map((product) => product.revenueSource));
  const aggregateRevenueSource: BusinessImpactSummary["revenueSource"] =
    revenueSources.size === 1 ? ([...revenueSources][0] ?? "none") : "mixed";
  const before = finalizeWindow(beforeTotalAcc, aggregateRevenueSource === "item" ? "item" : aggregateRevenueSource === "page" ? "page" : "page");
  const after = finalizeWindow(afterTotalAcc, aggregateRevenueSource === "item" ? "item" : aggregateRevenueSource === "page" ? "page" : "page");
  const status: BusinessImpactStatus = measured > 0 ? "ready" : "no_google_data";
  const preliminary = analyzableProducts.filter((row) => row.stage === "preliminary").length;
  const mature = analyzableProducts.length - preliminary;
  const confidence: BusinessImpactConfidence =
    measured === 0
      ? "low_data"
      : measuredPreliminary > 0
        ? "preliminary"
        : measured < 3
          ? "low_data"
          : partialAfterWindow > 0
            ? "partial"
            : "complete";

  return {
    status,
    confidence,
    generatedAt: new Date().toISOString(),
    windowDays: BUSINESS_IMPACT_WINDOW_DAYS,
    preliminaryDays: PRELIMINARY_IMPACT_DAYS,
    maturationDays: MATURATION_DAYS,
    revenueCurrency: "BRL",
    revenueSource: aggregateRevenueSource,
    productCounts: {
      published: publishedProducts.length,
      missingUrl,
      maturing,
      preliminary,
      mature,
      measured,
      fullAfterWindow,
      partialAfterWindow,
      itemMatched,
    },
    aiCostUsd: Math.round([...productCosts.values()].reduce((sum, value) => sum + value, 0) * 10000) / 10000,
    before,
    after,
    deltas: computeDeltas(before, after),
    products: productsImpact.sort((a, b) => b.deltas.revenueAbs - a.deltas.revenueAbs || (b.deltas.sessionsPct ?? -999) - (a.deltas.sessionsPct ?? -999)),
  };
}
