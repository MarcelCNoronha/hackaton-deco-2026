import type { GscClient } from "../clients/gsc.client.js";
import type { Ga4Client } from "../clients/ga4.client.js";
import type { ProductRow } from "./catalog-reader.agent.js";

export interface PrioritizedProduct {
  product: ProductRow;
  score: number;
  reason: string;
}

/** Exported so other GSC-consuming code (enrichment-run.orchestrator.ts, matching real search
 *  queries to a product) uses the exact same URL-to-pathname normalization as prioritization,
 *  instead of a second, possibly-drifting copy. */
export function pathnameOf(urlOrPath: string): string {
  try {
    return new URL(urlOrPath).pathname;
  } catch {
    return urlOrPath;
  }
}

/**
 * Pulls GSC + GA4 signal for the given products and ranks them by expected enrichment impact:
 * high impressions with low CTR (content isn't compelling enough to be clicked) and high
 * sessions with low conversion (content isn't compelling enough to convert) both score high.
 * NOTE: matching requires `products.url` to be populated (VTEX product URL) — products without
 * a known URL can't be matched to GSC/GA4 rows and fall back to score 0 (still enrichable,
 * just without a data-backed priority reason).
 */
export async function prioritizeProducts(params: {
  gsc: GscClient;
  ga4: Ga4Client;
  productsRows: ProductRow[];
  lookbackDays?: number;
}): Promise<PrioritizedProduct[]> {
  const lookbackDays = params.lookbackDays ?? 28;
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const [gscRows, ga4Rows] = await Promise.all([
    params.gsc.queryByPage({ startDate: fmt(startDate), endDate: fmt(endDate) }),
    params.ga4.runProductPageReport({ startDate: fmt(startDate), endDate: fmt(endDate) }),
  ]);

  const gscByPath = new Map(gscRows.map((row) => [pathnameOf(row.keys[0]), row]));
  const ga4ByPath = new Map(ga4Rows.map((row) => [pathnameOf(row.pagePath), row]));

  // Raw impressions/sessions live on very different scales (thousands vs. tens), so summing them
  // directly would just let whichever source has bigger numbers dominate the ranking — that's not
  // "most in need of enrichment", it's "has the most raw traffic". Two passes: compute the raw
  // signals first, then normalize each by its own max in this batch before combining.
  interface RawSignal {
    product: ProductRow;
    gsc?: (typeof gscRows)[number];
    ga4?: (typeof ga4Rows)[number];
    gscRaw: number;
    ga4Raw: number;
  }

  const raw: RawSignal[] = params.productsRows.map((product) => {
    if (!product.url) return { product, gscRaw: 0, ga4Raw: 0 };

    const path = pathnameOf(product.url);
    const gsc = gscByPath.get(path);
    const ga4 = ga4ByPath.get(path);
    return {
      product,
      gsc,
      ga4,
      gscRaw: gsc ? gsc.impressions * (1 - gsc.ctr) : 0,
      ga4Raw: ga4 ? ga4.sessions * (1 - ga4.conversionRate) : 0,
    };
  });

  const maxGscRaw = Math.max(...raw.map((r) => r.gscRaw), 1);
  const maxGa4Raw = Math.max(...raw.map((r) => r.ga4Raw), 1);

  const results: PrioritizedProduct[] = [];

  for (const { product, gsc, ga4, gscRaw, ga4Raw } of raw) {
    if (!product.url) {
      results.push({ product, score: 0, reason: "Sem URL conhecida — não foi possível cruzar com GSC/GA4" });
      continue;
    }

    // Each signal normalized to 0-1 against the batch's own max, then averaged — a product that's
    // merely "worst in GSC" and one that's "worst in GA4" end up comparable, instead of whichever
    // metric happens to have bigger raw numbers always winning.
    const score = (gscRaw / maxGscRaw + ga4Raw / maxGa4Raw) / 2;

    const reasonParts: string[] = [];
    if (gsc) reasonParts.push(`${gsc.impressions} impressões, CTR ${(gsc.ctr * 100).toFixed(1)}%`);
    if (ga4) reasonParts.push(`${ga4.sessions} sessões, conversão ${(ga4.conversionRate * 100).toFixed(1)}%`);

    results.push({
      product,
      score,
      reason: reasonParts.length ? reasonParts.join(" · ") : "Sem dado de GSC/GA4 para esta página",
    });
  }

  return results.sort((a, b) => b.score - a.score);
}
