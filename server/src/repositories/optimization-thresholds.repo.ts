import { db } from "../db/client.js";
import { categoryScoreThresholds } from "../db/schema.js";

/** Catalog-wide fallback used when a category has no explicit override. */
export const DEFAULT_CATEGORY = "*";

export interface CategoryScoreThreshold {
  category: string;
  excellentMin: number;
  goodMin: number;
}

const DEFAULT_THRESHOLD: CategoryScoreThreshold = { category: DEFAULT_CATEGORY, excellentMin: 85, goodMin: 60 };

export type ScoreTier = "excelente" | "bom" | "medio";

/** Every configured threshold, always including a `'*'` row (the built-in default when none was
 *  ever saved for it) — mirrors model-routing.repo.ts's DEFAULT_ROUTING fallback pattern. */
export async function getThresholds(): Promise<CategoryScoreThreshold[]> {
  const rows = await db.query.categoryScoreThresholds.findMany();
  if (rows.some((r) => r.category === DEFAULT_CATEGORY)) return rows;
  return [DEFAULT_THRESHOLD, ...rows];
}

export async function setThreshold(category: string, values: { excellentMin: number; goodMin: number }): Promise<void> {
  await db
    .insert(categoryScoreThresholds)
    .values({ category, excellentMin: values.excellentMin, goodMin: values.goodMin, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: categoryScoreThresholds.category,
      set: { excellentMin: values.excellentMin, goodMin: values.goodMin, updatedAt: new Date() },
    });
}

/** Classifies one product's composite `overallScore` into Excelente/Bom/Médio using its
 *  category's threshold, falling back to the catalog-wide `'*'` default when the category has no
 *  override (or the product has no category at all). */
export async function classifyScore(category: string | null, overallScore: number): Promise<ScoreTier> {
  const rows = await getThresholds();
  const byCategory = new Map(rows.map((r) => [r.category, r]));
  const threshold = (category ? byCategory.get(category) : undefined) ?? byCategory.get(DEFAULT_CATEGORY) ?? DEFAULT_THRESHOLD;
  if (overallScore >= threshold.excellentMin) return "excelente";
  if (overallScore >= threshold.goodMin) return "bom";
  return "medio";
}
