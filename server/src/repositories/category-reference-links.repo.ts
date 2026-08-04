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

const CONSENSUS_THRESHOLD = 0.6;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

/** Consensus across every reference link pasted for a category — never inherits a single vendor's
 *  style (see the Fase 2 plan's "3 to 5 references, consensus not one-off" rule): a boolean signal
 *  only counts as part of the pattern when ≥60% of references show it; numeric targets use the
 *  median. Called after every add/remove so category_content_profiles always reflects the current
 *  set of links, not a stale computation. */
export async function recomputeReferenceProfile(platform: CatalogPlatform, category: string): Promise<void> {
  const links = await listReferenceLinks(platform, category);
  const signals = links.map((l) => l.extractedSignals).filter((s): s is StructureSignals => s !== null);

  if (signals.length === 0) return;

  const wordCounts = signals.map((s) => s.wordCount);
  const bulletCounts = signals.map((s) => s.bulletCount);
  const consensus = (values: boolean[]) => values.filter(Boolean).length / values.length >= CONSENSUS_THRESHOLD;

  await upsertContentProfile({
    platform,
    category,
    wordCountMin: Math.round(median(wordCounts) * 0.85),
    wordCountMax: Math.round(median(wordCounts) * 1.15),
    bulletCount: median(bulletCounts),
    hasFaq: consensus(signals.map((s) => s.hasFaq)),
    hasSpecTable: consensus(signals.map((s) => s.hasSpecTable)),
    hasWarrantySection: consensus(signals.map((s) => s.hasWarrantySection)),
    source: "references",
  });
}
