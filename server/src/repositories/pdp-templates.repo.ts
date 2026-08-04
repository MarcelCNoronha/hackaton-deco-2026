import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { pdpTemplates } from "../db/schema.js";
import type { CatalogPlatform } from "../clients/catalog-types.js";
import type { DescriptionRichness } from "../clients/llm-types.js";

export const DEFAULT_PDP_CATEGORY = "*";

/** Every block that can be merged into the description HTML, in the order a merchant might pick —
 *  "featured_image" only ever renders when the run's `descriptionRichness` is
 *  "structured_with_image" AND the LLM actually picked a photo (silently skipped otherwise). */
export const PDP_BLOCKS = ["description", "benefit_bullets", "technical_specs", "featured_image", "faq", "cta"] as const;
export type PdpBlock = (typeof PDP_BLOCKS)[number];

export interface PdpTemplate {
  platform: CatalogPlatform;
  category: string;
  level: DescriptionRichness;
  blocks: PdpBlock[];
}

/** Same order the pipeline has always merged these in (see HACKATHON.md) — used whenever no
 *  template row exists yet for a (platform, category, level), so behavior is unchanged until a
 *  merchant actually customizes the structure. */
function defaultBlocksFor(level: DescriptionRichness): PdpBlock[] {
  const base: PdpBlock[] = ["description", "benefit_bullets", "technical_specs", "faq", "cta"];
  if (level !== "structured_with_image") return base;
  // Highlight image sits right after the intro paragraph, matching the "destaque logo no topo"
  // placement validated in the Excelente example (docs/exemplos/pdp-nivel-excelente.html).
  return ["description", "featured_image", "benefit_bullets", "technical_specs", "faq", "cta"];
}

export async function getPdpTemplates(platform: CatalogPlatform): Promise<PdpTemplate[]> {
  const rows = await db.query.pdpTemplates.findMany({ where: eq(pdpTemplates.platform, platform) });
  const byLevel = new Map(rows.map((r) => [r.level, r]));
  const levels: DescriptionRichness[] = ["plain", "structured", "structured_with_image"];
  return levels.map((level) => {
    const row = byLevel.get(level);
    return {
      platform,
      category: DEFAULT_PDP_CATEGORY,
      level,
      blocks: (row?.blocks as PdpBlock[] | undefined) ?? defaultBlocksFor(level),
    };
  });
}

/** Resolves the effective template for one product's category, falling back to the catalog-wide
 *  `'*'` row, then to the hardcoded default — used by publisher.agent.ts at publish time. */
export async function resolvePdpTemplate(
  platform: CatalogPlatform,
  category: string | null,
  level: DescriptionRichness,
): Promise<PdpBlock[]> {
  const rows = category
    ? await db.query.pdpTemplates.findMany({
        where: and(eq(pdpTemplates.platform, platform), eq(pdpTemplates.level, level)),
      })
    : [];
  const specific = rows.find((r) => r.category === category);
  const fallback = rows.find((r) => r.category === DEFAULT_PDP_CATEGORY);
  const row = specific ?? fallback;
  return (row?.blocks as PdpBlock[] | undefined) ?? defaultBlocksFor(level);
}

export async function setPdpTemplate(params: {
  platform: CatalogPlatform;
  category: string;
  level: DescriptionRichness;
  blocks: PdpBlock[];
}): Promise<void> {
  await db
    .insert(pdpTemplates)
    .values({ platform: params.platform, category: params.category, level: params.level, blocks: params.blocks, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [pdpTemplates.platform, pdpTemplates.category, pdpTemplates.level],
      set: { blocks: params.blocks, updatedAt: new Date() },
    });
}
