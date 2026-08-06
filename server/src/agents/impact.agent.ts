import { pathnameOf } from "./analyst.agent.js";
import type { GscClient, GscSearchAnalyticsRow } from "../clients/gsc.client.js";
import type { Ga4Client, Ga4ReportRow } from "../clients/ga4.client.js";
import type { ProductRow } from "./catalog-reader.agent.js";
import { getEarliestPublishedAt } from "../repositories/real-impact.repo.js";

/** How long after publish Google needs before ranking/impressions plausibly reflect the new
 *  content — comparing sooner would measure noise, not the optimization. Exported so the catalog
 *  list's impactReadiness badge (catalog.routes.ts) uses the exact same threshold instead of a
 *  second, possibly-drifting copy of "14". */
export const MATURATION_DAYS = 14;
/** Width of each comparison window (days) — matches Analyst's own lookback default. */
const WINDOW_DAYS = 28;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
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
  engagedSessions: number | null;
  conversionRate: number | null;
  purchases: number | null;
  revenue: number | null;
}

export interface RealImpactResult {
  status: RealImpactStatus;
  publishedAt?: string;
  daysSincePublish?: number;
  /** Only set when status is "maturing". */
  daysUntilReady?: number;
  before?: RealImpactWindow;
  after?: RealImpactWindow;
  deltas?: {
    impressionsPct: number | null;
    /** Positions LOWER is better (closer to #1) — a negative delta means ranking improved. */
    positionDelta: number | null;
    ctrDeltaPct: number | null;
    sessionsPct: number | null;
    engagedSessionsPct: number | null;
    conversionRateDeltaPct: number | null;
    purchasesPct: number | null;
    revenueDeltaAbs: number | null;
    revenuePct: number | null;
  };
}

function pctDelta(before: number | null, after: number | null): number | null {
  if (before === null || after === null) return null;
  if (before === 0) return after === 0 ? 0 : 100;
  return Math.round(((after - before) / before) * 100);
}

/** Live before/after comparison read straight from Google's own history — deliberately NOT backed
 *  by a local snapshot table. GSC retains ~16 months of daily data and GA4's standard reports
 *  cover any range within the property's own retention, so both the "antes" and "depois" windows
 *  are always queryable on demand; keeping our own copy would just be a second, possibly-stale
 *  source of numbers Google already stores authoritatively. The pivot between the two windows is
 *  the product's own earliest `publishedAt` (see real-impact.repo.ts) — not "when this endpoint
 *  happened to be called". */
export async function getProductRealImpact(params: {
  gsc: GscClient | null;
  ga4: Ga4Client | null;
  product: ProductRow;
}): Promise<RealImpactResult> {
  const { gsc, ga4, product } = params;
  if (!product.url) return { status: "no_url" };

  const publishedAt = await getEarliestPublishedAt(product.id);
  if (!publishedAt) return { status: "not_published" };

  const now = new Date();
  const daysSincePublish = Math.floor((now.getTime() - publishedAt.getTime()) / MS_PER_DAY);
  if (daysSincePublish < MATURATION_DAYS) {
    return {
      status: "maturing",
      publishedAt: publishedAt.toISOString(),
      daysSincePublish,
      daysUntilReady: MATURATION_DAYS - daysSincePublish,
    };
  }

  const publishedDay = new Date(Date.UTC(publishedAt.getUTCFullYear(), publishedAt.getUTCMonth(), publishedAt.getUTCDate()));
  const beforeStart = new Date(publishedDay.getTime() - WINDOW_DAYS * MS_PER_DAY);
  const beforeEnd = new Date(publishedDay.getTime() - MS_PER_DAY);
  const afterStart = new Date(publishedDay.getTime() + MATURATION_DAYS * MS_PER_DAY);
  const afterEnd = new Date(Math.min(now.getTime(), afterStart.getTime() + (WINDOW_DAYS - 1) * MS_PER_DAY));

  const path = pathnameOf(product.url);

  const [gscBefore, gscAfter, ga4Before, ga4After] = await Promise.all([
    gsc?.queryByPage({ startDate: fmt(beforeStart), endDate: fmt(beforeEnd) }) ?? Promise.resolve([]),
    gsc?.queryByPage({ startDate: fmt(afterStart), endDate: fmt(afterEnd) }) ?? Promise.resolve([]),
    ga4?.runProductPageReport({ startDate: fmt(beforeStart), endDate: fmt(beforeEnd) }) ?? Promise.resolve([]),
    ga4?.runProductPageReport({ startDate: fmt(afterStart), endDate: fmt(afterEnd) }) ?? Promise.resolve([]),
  ]);

  const findGsc = (rows: GscSearchAnalyticsRow[]) => rows.find((r) => pathnameOf(r.keys[0]) === path) ?? null;
  const findGa4 = (rows: Ga4ReportRow[]) => rows.find((r) => pathnameOf(r.pagePath) === path) ?? null;

  const gscB = findGsc(gscBefore);
  const gscA = findGsc(gscAfter);
  const ga4B = findGa4(ga4Before);
  const ga4A = findGa4(ga4After);

  const before: RealImpactWindow = {
    startDate: fmt(beforeStart),
    endDate: fmt(beforeEnd),
    impressions: gscB?.impressions ?? null,
    clicks: gscB?.clicks ?? null,
    ctr: gscB?.ctr ?? null,
    avgPosition: gscB?.position ?? null,
    sessions: ga4B?.sessions ?? null,
    engagedSessions: ga4B?.engagedSessions ?? null,
    conversionRate: ga4B?.conversionRate ?? null,
    purchases: ga4B?.purchases ?? null,
    revenue: ga4B?.revenue ?? null,
  };
  const after: RealImpactWindow = {
    startDate: fmt(afterStart),
    endDate: fmt(afterEnd),
    impressions: gscA?.impressions ?? null,
    clicks: gscA?.clicks ?? null,
    ctr: gscA?.ctr ?? null,
    avgPosition: gscA?.position ?? null,
    sessions: ga4A?.sessions ?? null,
    engagedSessions: ga4A?.engagedSessions ?? null,
    conversionRate: ga4A?.conversionRate ?? null,
    purchases: ga4A?.purchases ?? null,
    revenue: ga4A?.revenue ?? null,
  };

  return {
    status: "ready",
    publishedAt: publishedAt.toISOString(),
    daysSincePublish,
    before,
    after,
    deltas: {
      impressionsPct: pctDelta(before.impressions, after.impressions),
      positionDelta:
        before.avgPosition !== null && after.avgPosition !== null
          ? Math.round((after.avgPosition - before.avgPosition) * 10) / 10
          : null,
      ctrDeltaPct: pctDelta(before.ctr, after.ctr),
      sessionsPct: pctDelta(before.sessions, after.sessions),
      engagedSessionsPct: pctDelta(before.engagedSessions, after.engagedSessions),
      conversionRateDeltaPct: pctDelta(before.conversionRate, after.conversionRate),
      purchasesPct: pctDelta(before.purchases, after.purchases),
      revenueDeltaAbs:
        before.revenue !== null && after.revenue !== null ? Math.round((after.revenue - before.revenue) * 100) / 100 : null,
      revenuePct: pctDelta(before.revenue, after.revenue),
    },
  };
}
