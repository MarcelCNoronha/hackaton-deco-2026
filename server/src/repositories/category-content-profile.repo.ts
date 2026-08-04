import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { categoryContentProfiles, contentScores, products } from "../db/schema.js";
import { classifyScore } from "./optimization-thresholds.repo.js";
import type { CatalogPlatform } from "../clients/catalog-types.js";

export type ContentProfileSource = "internal" | "references" | "manual";

export interface CategoryContentProfile {
  platform: CatalogPlatform;
  category: string;
  wordCountMin: number | null;
  wordCountMax: number | null;
  bulletCount: number | null;
  hasFaq: boolean | null;
  hasSpecTable: boolean | null;
  hasWarrantySection: boolean | null;
  source: ContentProfileSource;
}

const MIN_SAMPLE_SIZE = 3;

export async function getContentProfile(platform: CatalogPlatform, category: string): Promise<CategoryContentProfile | null> {
  const row = await db.query.categoryContentProfiles.findFirst({
    where: and(eq(categoryContentProfiles.platform, platform), eq(categoryContentProfiles.category, category)),
  });
  if (!row) return null;
  return {
    platform: row.platform,
    category: row.category,
    wordCountMin: row.wordCountMin,
    wordCountMax: row.wordCountMax,
    bulletCount: row.bulletCount,
    hasFaq: row.hasFaq,
    hasSpecTable: row.hasSpecTable,
    hasWarrantySection: row.hasWarrantySection,
    source: row.source,
  };
}

export async function upsertContentProfile(profile: Omit<CategoryContentProfile, "source"> & { source: ContentProfileSource }): Promise<void> {
  await db
    .insert(categoryContentProfiles)
    .values({ ...profile, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [categoryContentProfiles.platform, categoryContentProfiles.category],
      set: { ...profile, updatedAt: new Date() },
    });
}

/** A merchant's hand-typed values always win — see resolveCategoryContentProfile. Distinguished
 *  from upsertContentProfile's "references"/"internal" writes only by the `source` tag, so a
 *  reference-link recompute (category-reference-links.repo.ts) never silently overwrites a value
 *  the merchant deliberately set by hand. */
export async function setManualContentProfile(
  platform: CatalogPlatform,
  category: string,
  values: Omit<CategoryContentProfile, "platform" | "category" | "source">,
): Promise<void> {
  await upsertContentProfile({ platform, category, ...values, source: "manual" });
}

function stripHtmlWords(html: string): number {
  return html
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Derives a structural profile from the store's OWN Ouro/Prata-scoring published products in this
 *  category — reads the classes renderPdpHtml (publisher.agent.ts) actually emits into
 *  products.description once published (catalogia-bullets/catalogia-specs/catalogia-faq), so no
 *  extra parsing of proposal rows is needed. Returns null (caller falls further back, or applies no
 *  structural constraint) when there aren't enough good samples yet — the whole point is never
 *  deriving a "good" pattern from mediocre content. */
export async function computeInternalContentProfile(
  platform: CatalogPlatform,
  category: string,
): Promise<Omit<CategoryContentProfile, "platform" | "category" | "source"> | null> {
  const rows = await db.query.products.findMany({
    where: and(eq(products.platform, platform), eq(products.category, category)),
    columns: { id: true, description: true },
  });

  const goodHtml: string[] = [];
  for (const row of rows) {
    if (!row.description) continue;
    const latestScore = await db.query.contentScores.findFirst({
      where: and(eq(contentScores.productId, row.id), eq(contentScores.target, "proposed")),
      orderBy: [desc(contentScores.createdAt)],
    });
    if (!latestScore) continue;
    const tier = await classifyScore(category, latestScore.overallScore);
    if (tier === "ouro" || tier === "prata") goodHtml.push(row.description);
  }
  if (goodHtml.length < MIN_SAMPLE_SIZE) return null;

  const wordCounts = goodHtml.map(stripHtmlWords).sort((a, b) => a - b);
  const bulletCounts = goodHtml.map((html) => (html.match(/<li>/g) ?? []).length);

  return {
    wordCountMin: wordCounts[0],
    wordCountMax: wordCounts.at(-1) ?? wordCounts[0],
    bulletCount: Math.round(bulletCounts.reduce((a, b) => a + b, 0) / bulletCounts.length),
    hasFaq: goodHtml.filter((h) => h.includes("catalogia-faq")).length / goodHtml.length >= 0.5,
    hasSpecTable: goodHtml.filter((h) => h.includes("catalogia-specs")).length / goodHtml.length >= 0.5,
    hasWarrantySection: goodHtml.filter((h) => /garantia/i.test(h)).length / goodHtml.length >= 0.5,
  };
}

/** Manual > references (market consensus) > internal (own good products) > null (no structural
 *  constraint applied) — see the Fase 2 plan's priority order. Callers (content-enrichment.agent.ts)
 *  treat a null return as "generate as today, no extra structural guidance". */
export async function resolveCategoryContentProfile(
  platform: CatalogPlatform,
  category: string | null,
): Promise<CategoryContentProfile | null> {
  if (!category) return null;
  const existing = await getContentProfile(platform, category);
  if (existing && (existing.source === "manual" || existing.source === "references")) return existing;

  const internal = await computeInternalContentProfile(platform, category);
  if (internal) return { platform, category, ...internal, source: "internal" };
  return existing ?? null;
}
