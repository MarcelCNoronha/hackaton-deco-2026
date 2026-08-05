import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { pdpTemplates } from "../db/schema.js";
import type { CatalogPlatform } from "../clients/catalog-types.js";
import type { DescriptionRichness } from "../clients/llm-types.js";

export const DEFAULT_PDP_CATEGORY = "*";

/** Every block that can be merged into the description HTML, in the order a merchant might pick —
 *  "featured_image" only ever renders when the run's `descriptionRichness` is
 *  "structured_with_image" AND the LLM actually picked a photo (silently skipped otherwise).
 *  "ambient_photo" is the manufacturer-reference/lifestyle photo a merchant can choose to show
 *  INSTEAD of (or alongside) "technical_specs" in the description — real specs always go to the
 *  Specification module ("Características do Produto") regardless of whether this block is used. */
export const PDP_BLOCKS = [
  "description",
  "benefit_bullets",
  "technical_specs",
  "featured_image",
  "ambient_photo",
  "faq",
  "cta",
] as const;
export type PdpBlock = (typeof PDP_BLOCKS)[number];

export type PdpTextAlign = "left" | "right" | "center" | "justify";
export type PdpFontSize = "sm" | "md" | "lg";

/** One cell of the "modo de layout" grid — see schema.ts's doc comment on pdpTemplates.layout. */
export interface PdpLayoutCell {
  block: PdpBlock;
  align: PdpTextAlign;
  bold: boolean;
  fontSize: PdpFontSize;
}

/** One row of the layout grid — 1 or 2 cells (columns) wide. */
export interface PdpLayoutRow {
  columns: PdpLayoutCell[];
}

export interface PdpTemplate {
  platform: CatalogPlatform;
  category: string;
  level: DescriptionRichness;
  blocks: PdpBlock[];
  /** "Modo avançado" — free-form HTML with {{placeholder}} tokens (see schema.ts's doc comment on
   *  pdpTemplates.customHtml). Null means "simple mode" — `blocks` decides the structure instead. */
  customHtml: string | null;
  /** "Modo de layout" — rows/columns grid, each cell naming a block + its own align/bold/fontSize
   *  (see schema.ts's doc comment on pdpTemplates.layout). Null means this mode isn't in use.
   *  Ignored when `customHtml` is set. */
  layout: PdpLayoutRow[] | null;
  /** "specific" — this exact category has its own saved row for this level. "default" — no
   *  category-specific row exists, so `blocks`/`customHtml` are inherited from the catalog-wide
   *  `'*'` row (or the hardcoded factory default if even that doesn't exist yet). Only meaningful
   *  for the admin editor (PdpConfig.tsx) — resolvePdpTemplate (the publish-time path) doesn't need
   *  to know which case it hit, just the final blocks/customHtml. */
  source: "specific" | "default";
}

/** What a resolved template needs at publish/preview time — same {blocks, customHtml} pair as
 *  PdpTemplate, just without the admin-only `source`/`category`/`platform`/`level` bookkeeping. */
export interface ResolvedPdpTemplate {
  blocks: PdpBlock[];
  customHtml: string | null;
  layout: PdpLayoutRow[] | null;
}

/** Same order the pipeline has always merged these in (see HACKATHON.md) — used whenever no
 *  template row exists yet for a (platform, category, level), so behavior is unchanged until a
 *  merchant actually customizes the structure. */
function defaultBlocksFor(level: DescriptionRichness): PdpBlock[] {
  const base: PdpBlock[] = ["description", "benefit_bullets", "technical_specs", "faq", "cta"];
  if (level !== "structured_with_image") return base;
  // Highlight image sits right after the intro paragraph — "destaque logo no topo" placement,
  // adjustable live in the "Configuração de PDP" page's preview.
  return ["description", "featured_image", "benefit_bullets", "technical_specs", "faq", "cta"];
}

/** Resolves the effective template PER LEVEL for one specific category (or the catalog-wide `'*'`
 *  default when `category` is omitted/`'*'` itself) — used by the "Configuração de PDP" admin
 *  editor, one category at a time (see PdpConfig.tsx). Distinct from the old blind
 *  "byLevel = Map(rows...)" this replaced: that assumed only ONE row per level ever existed (true
 *  only while every template was still the `'*'` default) and would have silently picked an
 *  arbitrary row once a second category got its own override. */
export async function getPdpTemplates(platform: CatalogPlatform, category: string = DEFAULT_PDP_CATEGORY): Promise<PdpTemplate[]> {
  const rows = await db.query.pdpTemplates.findMany({ where: eq(pdpTemplates.platform, platform) });
  const levels: DescriptionRichness[] = ["plain", "structured", "structured_with_image"];
  return levels.map((level) => {
    const specificRow = rows.find((r) => r.level === level && r.category === category);
    if (specificRow) {
      return {
        platform,
        category,
        level,
        blocks: specificRow.blocks as PdpBlock[],
        customHtml: specificRow.customHtml,
        layout: (specificRow.layout as PdpLayoutRow[] | null) ?? null,
        source: "specific" as const,
      };
    }
    const fallbackRow =
      category !== DEFAULT_PDP_CATEGORY ? rows.find((r) => r.level === level && r.category === DEFAULT_PDP_CATEGORY) : undefined;
    return {
      platform,
      category,
      level,
      blocks: (fallbackRow?.blocks as PdpBlock[] | undefined) ?? defaultBlocksFor(level),
      customHtml: fallbackRow?.customHtml ?? null,
      layout: (fallbackRow?.layout as PdpLayoutRow[] | null | undefined) ?? null,
      source: "default" as const,
    };
  });
}

/** Resolves the effective template for one product's category, falling back to the catalog-wide
 *  `'*'` row, then to the hardcoded default — used by publisher.agent.ts at publish time. */
export async function resolvePdpTemplate(
  platform: CatalogPlatform,
  category: string | null,
  level: DescriptionRichness,
): Promise<ResolvedPdpTemplate> {
  // Always query — a product with no resolved category (common: Shopify with an empty
  // productType, VTEX when the category lookup failed) still must see the merchant's configured
  // '*' catalog-wide default instead of silently falling through to the hardcoded factory
  // default. Only the "specific category override" half of the lookup needs `category` truthy.
  const rows = await db.query.pdpTemplates.findMany({
    where: and(eq(pdpTemplates.platform, platform), eq(pdpTemplates.level, level)),
  });
  const specific = category ? rows.find((r) => r.category === category) : undefined;
  const fallback = rows.find((r) => r.category === DEFAULT_PDP_CATEGORY);
  const row = specific ?? fallback;
  return {
    blocks: (row?.blocks as PdpBlock[] | undefined) ?? defaultBlocksFor(level),
    customHtml: row?.customHtml ?? null,
    layout: (row?.layout as PdpLayoutRow[] | null | undefined) ?? null,
  };
}

export async function setPdpTemplate(params: {
  platform: CatalogPlatform;
  category: string;
  level: DescriptionRichness;
  blocks: PdpBlock[];
  /** Omit/null to stay in (or revert to) simple mode; a non-empty string switches this
   *  (platform, category, level) to advanced mode — see schema.ts's doc comment. */
  customHtml?: string | null;
  /** Omit/null to stay in (or revert to) simple/advanced mode; a non-empty array switches this
   *  (platform, category, level) to "modo de layout" — see schema.ts's doc comment. */
  layout?: PdpLayoutRow[] | null;
}): Promise<void> {
  const customHtml = params.customHtml?.trim() || null;
  const layout = params.layout?.length ? params.layout : null;
  await db
    .insert(pdpTemplates)
    .values({
      platform: params.platform,
      category: params.category,
      level: params.level,
      blocks: params.blocks,
      customHtml,
      layout,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [pdpTemplates.platform, pdpTemplates.category, pdpTemplates.level],
      set: { blocks: params.blocks, customHtml, layout, updatedAt: new Date() },
    });
}
