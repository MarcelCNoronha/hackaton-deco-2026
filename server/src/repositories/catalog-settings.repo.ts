import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { catalogSettings } from "../db/schema.js";
import type { CatalogPlatform } from "../clients/catalog-types.js";

const ROW_ID = 1;

export async function getCatalogPlatform(): Promise<CatalogPlatform> {
  const row = await db.query.catalogSettings.findFirst({ where: eq(catalogSettings.id, ROW_ID) });
  return row?.platform ?? "vtex";
}

export async function setCatalogPlatform(platform: CatalogPlatform): Promise<void> {
  await db
    .insert(catalogSettings)
    .values({ id: ROW_ID, platform, updatedAt: new Date() })
    .onConflictDoUpdate({ target: catalogSettings.id, set: { platform, updatedAt: new Date() } });
}
