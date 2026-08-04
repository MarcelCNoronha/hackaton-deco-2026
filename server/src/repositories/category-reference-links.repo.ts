import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { categoryReferenceLinks } from "../db/schema.js";
import { upsertContentProfile } from "./category-content-profile.repo.js";
import type { CatalogPlatform } from "../clients/catalog-types.js";
import type { StructureSignals } from "../agents/reference-structure.agent.js";

export interface CategoryReferenceLink {
  id: number;
  platform: CatalogPlatform;
  category: string;
  url: string;
  extractedSignals: StructureSignals | null;
  warning: string | null;
}

export async function addReferenceLink(params: {
  platform: CatalogPlatform;
  category: string;
  url: string;
  extractedSignals: StructureSignals;
  warning: string | null;
}): Promise<CategoryReferenceLink> {
  const [row] = await db
    .insert(categoryReferenceLinks)
    .values({
      platform: params.platform,
      category: params.category,
      url: params.url,
      extractedSignals: params.extractedSignals,
      warning: params.warning,
    })
    .returning();
  return {
    id: row.id,
    platform: row.platform,
    category: row.category,
    url: row.url,
    extractedSignals: row.extractedSignals as StructureSignals | null,
    warning: row.warning,
  };
}

export async function removeReferenceLink(id: number): Promise<void> {
  await db.delete(categoryReferenceLinks).where(eq(categoryReferenceLinks.id, id));
}

export async function listReferenceLinks(platform: CatalogPlatform, category: string): Promise<CategoryReferenceLink[]> {
  const rows = await db.query.categoryReferenceLinks.findMany({
    where: and(eq(categoryReferenceLinks.platform, platform), eq(categoryReferenceLinks.category, category)),
  });
  return rows.map((row) => ({
    id: row.id,
    platform: row.platform,
    category: row.category,
    url: row.url,
    extractedSignals: row.extractedSignals as StructureSignals | null,
    warning: row.warning,
  }));
}

/** Enforced in category-profiles.routes.ts before ever calling addReferenceLink — kept here too
 *  since it's the number the consensus math below was actually tuned/labeled around. */
export const MAX_REFERENCE_LINKS = 3;

const CONSENSUS_THRESHOLD = 0.6;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

/** Consensus across every reference link pasted for a category — never inherits a single vendor's
 *  style (see the Fase 2 plan's "consensus, not one-off" rule, now capped at MAX_REFERENCE_LINKS): a boolean signal
 *  only counts as part of the pattern when ≥60% of references show it; numeric targets use the
 *  median. Called after every add/remove so category_content_profiles always reflects the current
 *  set of links, not a stale computation. */
export async function recomputeReferenceProfile(platform: CatalogPlatform, category: string): Promise<void> {
  const links = await listReferenceLinks(platform, category);
  const signals = links.map((l) => l.extractedSignals).filter((s): s is StructureSignals => s !== null);

  if (signals.length === 0) return;

  // The LLM extraction is untrusted input — a provider omitting a field or returning a non-numeric
  // value (seen live: a real reference link crashed this with "invalid input syntax for type
  // integer: NaN") must never reach an `integer` column. Filtering to finite numbers here means a
  // single bad signal degrades that one field to "not enough data" instead of poisoning the whole
  // profile with NaN.
  const wordCounts = signals.map((s) => s.wordCount).filter((n) => Number.isFinite(n));
  const bulletCounts = signals.map((s) => s.bulletCount).filter((n) => Number.isFinite(n));
  const consensus = (values: boolean[]) => values.filter(Boolean).length / values.length >= CONSENSUS_THRESHOLD;

  await upsertContentProfile({
    platform,
    category,
    wordCountMin: wordCounts.length > 0 ? Math.round(median(wordCounts) * 0.85) : null,
    wordCountMax: wordCounts.length > 0 ? Math.round(median(wordCounts) * 1.15) : null,
    bulletCount: bulletCounts.length > 0 ? median(bulletCounts) : null,
    hasFaq: consensus(signals.map((s) => s.hasFaq)),
    hasSpecTable: consensus(signals.map((s) => s.hasSpecTable)),
    hasWarrantySection: consensus(signals.map((s) => s.hasWarrantySection)),
    source: "references",
  });
}
