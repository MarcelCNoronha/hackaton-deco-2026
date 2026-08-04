import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { products } from "../db/schema.js";

const MIN_SAMPLE_SIZE = 3;
const EXPECTED_FREQUENCY_THRESHOLD = 0.5;

/** Derives which attribute keys are "expected" for a category from the catalog's OWN already-
 *  synced data — keys with a non-empty value in at least half of that category's products —
 *  instead of letting `attributesPatch` (produced by the same AI whose completeness is being
 *  scored) define its own denominator. See evaluator.agent.ts's `computeAttributeCompleteness`.
 *  Returns `null` (caller falls back to the old union-with-patch behavior) when there aren't
 *  enough synced products in the category yet for the frequency count to mean anything. */
export async function getExpectedAttributeKeys(category: string | null): Promise<string[] | null> {
  if (!category) return null;

  const rows = await db.query.products.findMany({
    where: eq(products.category, category),
    columns: { attributes: true },
  });
  if (rows.length < MIN_SAMPLE_SIZE) return null;

  const counts = new Map<string, number>();
  for (const row of rows) {
    const attrs = (row.attributes as Record<string, unknown>) ?? {};
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || String(value).trim() === "") continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const expected = [...counts.entries()]
    .filter(([, count]) => count / rows.length >= EXPECTED_FREQUENCY_THRESHOLD)
    .map(([key]) => key);
  return expected.length > 0 ? expected : null;
}
