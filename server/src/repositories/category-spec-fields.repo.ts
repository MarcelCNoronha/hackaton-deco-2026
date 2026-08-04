import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { categorySpecFields } from "../db/schema.js";
import type { CatalogPlatform, CategoryFieldDefinition } from "../clients/catalog-types.js";

export interface CategorySpecFields {
  platform: CatalogPlatform;
  categoryPath: string;
  categoryId: string;
  fields: CategoryFieldDefinition[];
}

export async function upsertCategoryFields(params: {
  platform: CatalogPlatform;
  categoryPath: string;
  categoryId: string;
  fields: CategoryFieldDefinition[];
}): Promise<void> {
  await db
    .insert(categorySpecFields)
    .values({
      platform: params.platform,
      categoryPath: params.categoryPath,
      categoryId: params.categoryId,
      fields: params.fields,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [categorySpecFields.platform, categorySpecFields.categoryPath],
      set: { categoryId: params.categoryId, fields: params.fields, updatedAt: new Date() },
    });
}

export async function getCategoryFields(
  platform: CatalogPlatform,
  categoryPath: string,
): Promise<CategoryFieldDefinition[] | null> {
  const row = await db.query.categorySpecFields.findFirst({
    where: and(eq(categorySpecFields.platform, platform), eq(categorySpecFields.categoryPath, categoryPath)),
  });
  return (row?.fields as CategoryFieldDefinition[] | undefined) ?? null;
}

export async function listCategoryFields(platform: CatalogPlatform): Promise<CategorySpecFields[]> {
  const rows = await db.query.categorySpecFields.findMany({ where: eq(categorySpecFields.platform, platform) });
  return rows.map((r) => ({
    platform: r.platform,
    categoryPath: r.categoryPath,
    categoryId: r.categoryId,
    fields: (r.fields as CategoryFieldDefinition[] | undefined) ?? [],
  }));
}
