import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { categoryNodes } from "../db/schema.js";
import type { CatalogPlatform } from "../clients/catalog-types.js";
import type { CategoryTreeNode } from "../clients/catalog-types.js";

/** Replaces the whole synced tree for a platform in one go — the tree is cheap to re-fetch and
 *  re-walk in full (see category-sync.worker.ts), so there's no incremental-diff logic here, just
 *  upsert everything the latest walk produced. */
export async function upsertCategoryNodes(platform: CatalogPlatform, nodes: CategoryTreeNode[]): Promise<void> {
  for (const node of nodes) {
    await db
      .insert(categoryNodes)
      .values({
        platform,
        path: node.path,
        vtexCategoryId: node.id,
        parentPath: node.parentPath,
        level: node.level,
        isLeaf: node.isLeaf,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [categoryNodes.platform, categoryNodes.path],
        set: {
          vtexCategoryId: node.id,
          parentPath: node.parentPath,
          level: node.level,
          isLeaf: node.isLeaf,
          updatedAt: new Date(),
        },
      });
  }
}

export async function listCategoryNodes(platform: CatalogPlatform): Promise<CategoryTreeNode[]> {
  const rows = await db.query.categoryNodes.findMany({ where: eq(categoryNodes.platform, platform) });
  return rows.map((r) => ({
    id: r.vtexCategoryId,
    name: r.path.split(" > ").at(-1) ?? r.path,
    path: r.path,
    parentPath: r.parentPath,
    level: r.level,
    isLeaf: r.isLeaf,
  }));
}

/** Nodes where products actually get classified — where the category/subcategory reference-link
 *  and content-profile UI lets a merchant add references, per the "Subcategoria, or Categoria if
 *  there's no Subcategoria" rule baked into isLeaf (see CategoryTreeNode's doc comment). */
export async function listLeafCategoryNodes(platform: CatalogPlatform): Promise<CategoryTreeNode[]> {
  const nodes = await listCategoryNodes(platform);
  return nodes.filter((n) => n.isLeaf);
}
