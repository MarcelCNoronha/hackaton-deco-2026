import { and, eq } from "drizzle-orm";
import type { CatalogPlatform } from "../clients/catalog-types.js";
import {
  ALL_ENRICHMENT_FIELDS,
  type CategoryPromptRules,
  type EnrichmentField,
  type ImageInstructionKind,
} from "../clients/llm-types.js";
import { db } from "../db/client.js";
import { categoryPromptRules } from "../db/schema.js";

export const DEFAULT_PROMPT_RULE_CATEGORY = "*";

const IMAGE_INSTRUCTION_KINDS: ImageInstructionKind[] = ["principal", "lifestyle", "dimensional", "feature_callout"];

export interface CategoryPromptRulesConfig extends CategoryPromptRules {
  platform: CatalogPlatform;
  category: string;
  updatedAt: string | null;
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLocaleLowerCase("pt-BR");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueNonEmpty(value.filter((item): item is string => typeof item === "string")) : [];
}

function instructionRecord<T extends string>(value: unknown, allowedKeys: readonly T[]): Partial<Record<T, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = new Set<string>(allowedKeys);
  const out: Partial<Record<T, string>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key) || typeof raw !== "string") continue;
    const instruction = raw.trim();
    if (instruction) out[key as T] = instruction;
  }
  return out;
}

function hasRules(rules: CategoryPromptRules): boolean {
  return (
    rules.recommendedTerms.length > 0 ||
    rules.forbiddenTerms.length > 0 ||
    Object.keys(rules.fieldInstructions).length > 0 ||
    Object.keys(rules.imageInstructions).length > 0
  );
}

function toApiShape(row: typeof categoryPromptRules.$inferSelect): CategoryPromptRulesConfig {
  return {
    platform: row.platform,
    category: row.category,
    recommendedTerms: stringArray(row.recommendedTerms),
    forbiddenTerms: stringArray(row.forbiddenTerms),
    fieldInstructions: instructionRecord(row.fieldInstructions, ALL_ENRICHMENT_FIELDS),
    imageInstructions: instructionRecord(row.imageInstructions, IMAGE_INSTRUCTION_KINDS),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function emptyPromptRules(platform: CatalogPlatform, category: string): CategoryPromptRulesConfig {
  return {
    platform,
    category,
    recommendedTerms: [],
    forbiddenTerms: [],
    fieldInstructions: {},
    imageInstructions: {},
    updatedAt: null,
  };
}

export async function getCategoryPromptRules(
  platform: CatalogPlatform,
  category: string,
): Promise<CategoryPromptRulesConfig | null> {
  const row = await db.query.categoryPromptRules.findFirst({
    where: and(eq(categoryPromptRules.platform, platform), eq(categoryPromptRules.category, category)),
  });
  return row ? toApiShape(row) : null;
}

export async function setCategoryPromptRules(params: {
  platform: CatalogPlatform;
  category: string;
  recommendedTerms: string[];
  forbiddenTerms: string[];
  fieldInstructions: Partial<Record<EnrichmentField, string>>;
  imageInstructions: Partial<Record<ImageInstructionKind, string>>;
}): Promise<CategoryPromptRulesConfig> {
  const values = {
    platform: params.platform,
    category: params.category,
    recommendedTerms: uniqueNonEmpty(params.recommendedTerms),
    forbiddenTerms: uniqueNonEmpty(params.forbiddenTerms),
    fieldInstructions: instructionRecord(params.fieldInstructions, ALL_ENRICHMENT_FIELDS),
    imageInstructions: instructionRecord(params.imageInstructions, IMAGE_INSTRUCTION_KINDS),
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(categoryPromptRules)
    .values(values)
    .onConflictDoUpdate({
      target: [categoryPromptRules.platform, categoryPromptRules.category],
      set: {
        recommendedTerms: values.recommendedTerms,
        forbiddenTerms: values.forbiddenTerms,
        fieldInstructions: values.fieldInstructions,
        imageInstructions: values.imageInstructions,
        updatedAt: values.updatedAt,
      },
    })
    .returning();
  return toApiShape(row);
}

export async function resolveCategoryPromptRules(
  platform: CatalogPlatform,
  category: string | null,
): Promise<CategoryPromptRules | null> {
  const fallback = await getCategoryPromptRules(platform, DEFAULT_PROMPT_RULE_CATEGORY);
  const specific =
    category && category !== DEFAULT_PROMPT_RULE_CATEGORY ? await getCategoryPromptRules(platform, category) : null;

  const merged: CategoryPromptRules = {
    recommendedTerms: uniqueNonEmpty([...(fallback?.recommendedTerms ?? []), ...(specific?.recommendedTerms ?? [])]),
    forbiddenTerms: uniqueNonEmpty([...(fallback?.forbiddenTerms ?? []), ...(specific?.forbiddenTerms ?? [])]),
    fieldInstructions: { ...(fallback?.fieldInstructions ?? {}), ...(specific?.fieldInstructions ?? {}) },
    imageInstructions: { ...(fallback?.imageInstructions ?? {}), ...(specific?.imageInstructions ?? {}) },
  };
  return hasRules(merged) ? merged : null;
}
