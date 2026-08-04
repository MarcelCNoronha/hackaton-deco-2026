import { requireActiveCatalogClient } from "../api/routes/catalog.routes.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { upsertCategoryNodes } from "../repositories/category-nodes.repo.js";
import { upsertCategoryFields } from "../repositories/category-spec-fields.repo.js";

// Low on purpose — this walks every leaf category and fires one VTEX call per leaf; keeping this
// small avoids hammering the account's API with a burst of concurrent requests on connect.
const CATEGORY_SYNC_CONCURRENCY = 3;

export interface CategorySyncResult {
  nodeCount: number;
  leafCount: number;
  fieldSetCount: number;
  failedCount: number;
}

/** Re-syncs the active platform's whole category tree (breadcrumbs + leaf detection) and, for
 *  every leaf node, the content/specification fields the platform accepts there — see
 *  vtex.client.ts's listCategoryTree/getCategoryFieldDefinitions. Cheap enough to always redo in
 *  full rather than diff incrementally (see category-sync.worker.ts for when this runs). */
export async function runCategorySync(): Promise<CategorySyncResult> {
  const catalog = await requireActiveCatalogClient();

  const nodes = await catalog.listCategoryTree();
  await upsertCategoryNodes(catalog.platform, nodes);

  const leaves = nodes.filter((n) => n.isLeaf);
  const results = await mapWithConcurrency(leaves, CATEGORY_SYNC_CONCURRENCY, async (node) => {
    const fields = await catalog.getCategoryFieldDefinitions(node.id);
    await upsertCategoryFields({
      platform: catalog.platform,
      categoryPath: node.path,
      categoryId: node.id,
      fields,
    });
  });

  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    console.error(
      `Category sync: ${failed.length}/${leaves.length} leaf categories failed to sync spec fields`,
      failed.map((f) => (f as PromiseRejectedResult).reason),
    );
  }

  return {
    nodeCount: nodes.length,
    leafCount: leaves.length,
    fieldSetCount: leaves.length - failed.length,
    failedCount: failed.length,
  };
}
