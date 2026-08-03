import { eq, inArray, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { contentScores, enrichmentRuns } from "../db/schema.js";

type ContentScoreRow = typeof contentScores.$inferSelect;

/** Assumed manual copywriting/research time per listing (title, description, specs, FAQ, SEO
 *  fields) — used only to estimate "tempo economizado" against the run's actual wall-clock
 *  duration. A rough, stated assumption for the pitch, not a measured baseline. */
const MANUAL_MINUTES_PER_LISTING = 25;

export interface ImpactSummary {
  productCount: number;
  completudeDeltaPct: number;
  seoDeltaPct: number;
  geoDeltaPct: number;
  conversionDeltaPct: number;
  consistencyDeltaPct: number;
  /** Current (proposed-side) average completude — the "100% dos atributos preenchidos" headline. */
  requiredAttributesFilledPct: number;
  estimatedTimeSavedMinutes: number;
  estimatedTimeSavedPct: number;
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 100 : (numerator / denominator) * 100;
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

/** Pairs up original/proposed scores keyed by (runId, productId) — NOT just productId, so a
 *  product optimized across multiple runs contributes each run's own before/after delta instead of
 *  collapsing to a single "current state" pair. Only pairs with BOTH sides counted — a run that
 *  only ever scored the original (e.g. failed before generating a proposal) contributes nothing. */
function computeSummary(scores: ContentScoreRow[], durationMs: number, processedCount: number): ImpactSummary {
  const byPair = new Map<string, { original?: ContentScoreRow; proposed?: ContentScoreRow }>();
  for (const s of scores) {
    const key = `${s.runId}-${s.productId}`;
    const entry = byPair.get(key) ?? {};
    if (s.target === "original") entry.original = s;
    else entry.proposed = s;
    byPair.set(key, entry);
  }
  const pairs = [...byPair.values()].filter(
    (p): p is { original: ContentScoreRow; proposed: ContentScoreRow } => Boolean(p.original && p.proposed),
  );

  const completudeBefore = avg(pairs.map((p) => percent(p.original.attributesFilled, p.original.attributesExpected)));
  const completudeAfter = avg(pairs.map((p) => percent(p.proposed.attributesFilled, p.proposed.attributesExpected)));
  const seoBefore = avg(pairs.map((p) => p.original.seoScore));
  const seoAfter = avg(pairs.map((p) => p.proposed.seoScore));
  const geoBefore = avg(pairs.map((p) => percent(p.original.questionsAnswered, p.original.questionsTotal)));
  const geoAfter = avg(pairs.map((p) => percent(p.proposed.questionsAnswered, p.proposed.questionsTotal)));
  const conversionBefore = avg(pairs.map((p) => p.original.conversionScore));
  const conversionAfter = avg(pairs.map((p) => p.proposed.conversionScore));
  const consistencyBefore = avg(pairs.map((p) => p.original.dataConsistencyScore));
  const consistencyAfter = avg(pairs.map((p) => p.proposed.dataConsistencyScore));

  const manualMinutes = processedCount * MANUAL_MINUTES_PER_LISTING;
  const actualMinutes = durationMs / 60_000;
  const estimatedTimeSavedMinutes = Math.max(0, manualMinutes - actualMinutes);
  const estimatedTimeSavedPct = manualMinutes > 0 ? (estimatedTimeSavedMinutes / manualMinutes) * 100 : 0;

  return {
    productCount: pairs.length,
    completudeDeltaPct: Math.round(completudeAfter - completudeBefore),
    seoDeltaPct: Math.round(seoAfter - seoBefore),
    geoDeltaPct: Math.round(geoAfter - geoBefore),
    conversionDeltaPct: Math.round(conversionAfter - conversionBefore),
    consistencyDeltaPct: Math.round(consistencyAfter - consistencyBefore),
    requiredAttributesFilledPct: Math.round(completudeAfter),
    estimatedTimeSavedMinutes: Math.round(estimatedTimeSavedMinutes),
    estimatedTimeSavedPct: Math.max(0, Math.min(100, Math.round(estimatedTimeSavedPct))),
  };
}

export async function getRunImpactSummary(runId: number): Promise<ImpactSummary> {
  const [run, scores] = await Promise.all([
    db.query.enrichmentRuns.findFirst({ where: eq(enrichmentRuns.id, runId) }),
    db.query.contentScores.findMany({ where: eq(contentScores.runId, runId) }),
  ]);
  return computeSummary(scores, run?.durationMs ?? 0, run?.processedCount ?? 0);
}

/** Account-wide rollup across every finished run — feeds the Impact page's banner. */
export async function getOverallImpactSummary(): Promise<ImpactSummary> {
  const finishedRuns = await db.query.enrichmentRuns.findMany({ where: ne(enrichmentRuns.status, "running") });
  const runIds = finishedRuns.map((r) => r.id);
  const scores = runIds.length ? await db.query.contentScores.findMany({ where: inArray(contentScores.runId, runIds) }) : [];
  const totalDuration = finishedRuns.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const totalProcessed = finishedRuns.reduce((sum, r) => sum + r.processedCount, 0);
  return computeSummary(scores, totalDuration, totalProcessed);
}
