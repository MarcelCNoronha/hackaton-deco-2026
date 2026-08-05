import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { enrichmentProposals, enrichmentRuns, products } from "../db/schema.js";
import type { CatalogClient } from "../clients/catalog-types.js";
import type { DescriptionRichness } from "../clients/llm-types.js";
import {
  resolvePdpTemplate,
  type PdpBlock,
  type PdpFontSize,
  type PdpLayoutCell,
  type PdpLayoutRow,
  type PdpTextAlign,
  type ResolvedPdpTemplate,
} from "../repositories/pdp-templates.repo.js";
import { getCategoryFields } from "../repositories/category-spec-fields.repo.js";
import type { CatalogPlatform } from "../clients/catalog-types.js";

/** Some VTEX categories have a Specification field literally named "Descrição" — a leftover/legacy
 *  spec slot, entirely distinct from the product's real native Description (the one
 *  updateProductDescription actually publishes to the storefront) despite the identical name.
 *  Confirmed live: it already had a stale copy of an old description sitting in it, unrelated to
 *  what customers see. Never auto-resolved by name for that reason — the real description already
 *  has its own dedicated, correct publish path; matching this one by coincidence of name would
 *  silently write into a dead field a merchant could mistake for the real thing. */
const RESERVED_SPEC_FIELD_NAMES = new Set(["descrição", "descricao"]);

/** Resolves label→fieldId against the product's category's synced spec fields (empty/no-op on
 *  Shopify, which has no such registry — see category-spec-fields.repo.ts). Case-insensitive since
 *  the LLM's label casing doesn't always match VTEX's own field Name exactly (e.g. "Cor" vs "cor"). */
async function resolveSpecFieldValues(
  platform: CatalogPlatform,
  category: string | null,
  entries: Array<[string, string]>,
): Promise<{ specValues: Array<{ fieldId: string; value: string }>; rest: Array<[string, string]> }> {
  const fields = category ? await getCategoryFields(platform, category) : null;
  const specValues: Array<{ fieldId: string; value: string }> = [];
  const rest: Array<[string, string]> = [];
  for (const [label, value] of entries) {
    const field = fields?.find((f) => f.name.toLowerCase() === label.toLowerCase() && !RESERVED_SPEC_FIELD_NAMES.has(f.name.toLowerCase()));
    if (field) specValues.push({ fieldId: field.id, value });
    else rest.push([label, value]);
  }
  return { specValues, rest };
}

type Proposal = typeof enrichmentProposals.$inferSelect;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Level-aware block renderers — the ONLY place that turns the model's structured output into
 *  HTML. Content generation never improvises tags itself (see enrichment-schema.ts's
 *  buildDescriptionRichnessSuffix); a PDP template (pdp-templates.repo.ts) decides which of these
 *  blocks appear and in what order, so the final markup is 100% predictable and merchant-editable
 *  without touching a prompt. "plain" (Médio) renders everything as flowing paragraphs — no
 *  headings/lists/tables — matching that tier's "texto corrido" definition; "structured"/
 *  "structured_with_image" (Bom/Excelente) use real semantic HTML. */
/** Shared type scale/spacing for every block below — confirmed live that this store's theme
 *  supplies none of it (raw tags butted straight against each other with no visual breathing
 *  room, and h2/h3 with no distinct size from body text). Kept in one place so every section
 *  reads as part of one consistent system instead of each block inventing its own numbers. */
const SECTION_HEADING_STYLE = 'style="font-size:1.15em;font-weight:700;margin:1.5em 0 0.75em;line-height:1.3;"';
const PARAGRAPH_STYLE = 'style="margin:0 0 1em;line-height:1.6;"';

function renderDescriptionBlock(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (paragraphs.length ? paragraphs : [text]).map((p) => `<p ${PARAGRAPH_STYLE}>${escapeHtml(p)}</p>`).join("");
}

/** `<ul>`/`<li>` with `list-style:disc` still rendered as plain stacked lines with no visible
 *  marker AND no indent on this store's live theme — confirmed by re-checking the actually
 *  published HTML, which had the inline style intact, meaning something targets `ul`/`li`
 *  specifically (the `<table>`/`<h2>`/`<h3>` inline styles elsewhere on this same page all render
 *  fine). Rather than chase that further, bullets are built from `<div>`/`<span>` with a literal "•"
 *  character positioned via flexbox — no tag a list-targeting rule could catch, no dependence on
 *  the browser's marker box at all. */
const BULLETS_SECTION_STYLE = 'style="margin:1.25em 0;"';
const BULLET_ROW_STYLE = 'style="display:flex;gap:0.6em;margin-bottom:0.4em;line-height:1.5;"';
const BULLET_MARK_STYLE = 'style="flex:none;"';

function renderBulletsBlock(bullets: string[], level: DescriptionRichness): string {
  if (level === "plain") return `<p>${bullets.map(escapeHtml).join(" — ")}</p>`;
  const items = bullets
    .map((b) => `<div ${BULLET_ROW_STYLE}><span ${BULLET_MARK_STYLE}>•</span><span>${escapeHtml(b)}</span></div>`)
    .join("");
  return `<div class="catalogia-bullets" ${BULLETS_SECTION_STYLE}>${items}</div>`;
}

/** A bare `<table>` has NO default browser border/spacing — confirmed live: without a store theme
 *  rule targeting it (most don't, since raw tables are unusual inside a product description), it
 *  rendered as an unstructured stack of label/value lines, not a real table. Inline styles here
 *  guarantee a legible table regardless of the theme's own CSS — deliberately minimal (borders,
 *  padding, no color) so it can't clash with a theme's palette. */
const SPECS_SECTION_STYLE = 'style="margin:1.5em 0;"';
const SPECS_TABLE_STYLE = 'style="width:100%;border-collapse:collapse;font-size:0.95em;"';
const SPECS_CELL_STYLE = 'style="padding:0.5em 0.75em;border:1px solid #ddd;text-align:left;line-height:1.4;"';
const SPECS_LABEL_CELL_STYLE =
  'style="padding:0.5em 0.75em;border:1px solid #ddd;text-align:left;font-weight:600;width:35%;line-height:1.4;"';

function renderSpecsBlock(specs: Array<{ label: string; value: string }>, level: DescriptionRichness): string {
  if (level === "plain") {
    return `<p>${specs.map((s) => `${escapeHtml(s.label)}: ${escapeHtml(s.value)}`).join(". ")}</p>`;
  }
  const rows = specs
    .map((s) => `<tr><td ${SPECS_LABEL_CELL_STYLE}>${escapeHtml(s.label)}</td><td ${SPECS_CELL_STYLE}>${escapeHtml(s.value)}</td></tr>`)
    .join("");
  return `<div class="catalogia-specs" ${SPECS_SECTION_STYLE}><h2 ${SECTION_HEADING_STYLE}>Especificações</h2><table ${SPECS_TABLE_STYLE}>${rows}</table></div>`;
}

/** Same reasoning as the specs table/bullets styles above — confirmed live: with no theme rule
 *  distinguishing <h3> from the <p> right after it, a question ran straight into its answer and
 *  into the next question with no visible break at all. Bolds the question and spaces out each
 *  question/answer pair, nothing else. */
const FAQ_SECTION_STYLE = 'style="margin:1.5em 0;"';
const FAQ_QUESTION_STYLE = 'style="font-weight:600;margin:1em 0 0.3em;line-height:1.4;"';
const FAQ_ANSWER_STYLE = 'style="margin:0 0 0.25em;line-height:1.6;"';

function renderFaqBlock(faq: Array<{ question: string; answer: string }>, level: DescriptionRichness): string {
  if (level === "plain") {
    return `<div class="catalogia-faq">${faq.map((f) => `<p><strong>${escapeHtml(f.question)}</strong> ${escapeHtml(f.answer)}</p>`).join("")}</div>`;
  }
  const items = faq
    .map((f) => `<h3 ${FAQ_QUESTION_STYLE}>${escapeHtml(f.question)}</h3><p ${FAQ_ANSWER_STYLE}>${escapeHtml(f.answer)}</p>`)
    .join("");
  return `<div class="catalogia-faq" ${FAQ_SECTION_STYLE}><h2 ${SECTION_HEADING_STYLE}>Perguntas frequentes</h2>${items}</div>`;
}

const CTA_STYLE = 'style="margin:1.5em 0 0.5em;font-size:1.05em;line-height:1.5;"';

function renderCtaBlock(cta: string): string {
  return `<p class="catalogia-cta" ${CTA_STYLE}><strong>${escapeHtml(cta)}</strong></p>`;
}

const FEATURED_IMAGE_STYLE = 'style="margin:1.25em 0;"';
const FEATURED_IMAGE_IMG_STYLE = 'style="max-width:100%;height:auto;display:block;"';
const FEATURED_IMAGE_CAPTION_STYLE = 'style="font-size:0.85em;margin-top:0.4em;"';

function renderFeaturedImageBlock(url: string, caption: string): string {
  return `<figure class="catalogia-featured-image" ${FEATURED_IMAGE_STYLE}><img src="${escapeHtml(url)}" alt="${escapeHtml(caption)}" ${FEATURED_IMAGE_IMG_STYLE} />${
    caption ? `<figcaption ${FEATURED_IMAGE_CAPTION_STYLE}>${escapeHtml(caption)}</figcaption>` : ""
  }</figure>`;
}

/** "divider"/"spacer" are purely structural — no product data behind them, so unlike every other
 *  block they always render something, never "" (see PDP_BLOCKS' doc comment). Size only matters
 *  in "modo de layout", where each cell picks its own — elsewhere (fixed block list, {{token}}
 *  template) there's no per-block config surface at all, so they fall back to "md". */
function renderDividerBlock(): string {
  return `<hr style="border:none;border-top:1px solid #ddd;margin:0.5em 0;" />`;
}

const SPACER_HEIGHT: Record<PdpFontSize, string> = { sm: "1em", md: "2em", lg: "3.5em" };

function renderSpacerBlock(size: PdpFontSize = "md"): string {
  return `<div style="height:${SPACER_HEIGHT[size]};" aria-hidden="true"></div>`;
}

export interface BlockData {
  description?: string;
  bullets?: string[];
  specs?: Array<{ label: string; value: string }>;
  faq?: Array<{ question: string; answer: string }>;
  cta?: string;
  featuredImage?: { url: string; caption: string };
  // "ambient_photo" block's source — manufacturer-reference photo first, AI-generated lifestyle
  // image as fallback (not wired up yet: no proposal field populates this today, so the block
  // silently renders empty, same as any other block with no data — see PDP_BLOCKS' doc comment).
  ambientPhoto?: { url: string; caption: string };
}

/** Renders exactly one block, or "" when its data wasn't approved/available for this product —
 *  the single dispatch table every render mode (fixed list, {{placeholder}} template, row/column
 *  layout) shares, so a new block type or a tweak to an existing one never has to be taught to
 *  more than one place. */
function renderBlock(block: PdpBlock, level: DescriptionRichness, data: BlockData): string {
  switch (block) {
    case "description":
      return data.description ? renderDescriptionBlock(data.description) : "";
    case "benefit_bullets":
      return data.bullets ? renderBulletsBlock(data.bullets, level) : "";
    case "technical_specs":
      return data.specs ? renderSpecsBlock(data.specs, level) : "";
    case "faq":
      return data.faq ? renderFaqBlock(data.faq, level) : "";
    case "cta":
      return data.cta ? renderCtaBlock(data.cta) : "";
    case "featured_image":
      return data.featuredImage ? renderFeaturedImageBlock(data.featuredImage.url, data.featuredImage.caption) : "";
    case "ambient_photo":
      return data.ambientPhoto ? renderFeaturedImageBlock(data.ambientPhoto.url, data.ambientPhoto.caption) : "";
    case "divider":
      return renderDividerBlock();
    case "spacer":
      return renderSpacerBlock();
  }
}

/** Assembles the final description HTML strictly following `blocks`' order — a block is skipped
 *  whenever its data wasn't approved for this product (e.g. no featured_image proposal, or the
 *  merchant's template doesn't include a block at all). Exported so the "Configuração de PDP"
 *  preview (pdp-templates.routes.ts) renders with the EXACT same function that actually publishes
 *  — a preview that could drift from real behavior would be worse than no preview at all. */
export function renderPdpHtml(blocks: PdpBlock[], level: DescriptionRichness, data: BlockData): string {
  return blocks.map((block) => renderBlock(block, level, data)).join("");
}

/** "Modo avançado" (see pdpTemplates.customHtml's doc comment) — same per-block renderers as
 *  renderPdpHtml above (same escaping, same level-awareness), just assembled by substituting
 *  {{placeholder}} tokens into merchant-authored HTML instead of concatenating a fixed block list
 *  in order. A placeholder with no matching data (e.g. {{featured_image}} when nothing was
 *  approved) is replaced with an empty string — same "skip silently, never an empty shell" rule as
 *  the simple-mode renderer, just token-by-token instead of block-by-block. */
export function renderPdpHtmlFromTemplate(customHtml: string, level: DescriptionRichness, data: BlockData): string {
  const fragments: Partial<Record<PdpBlock, string>> = Object.fromEntries(
    (
      ["description", "benefit_bullets", "technical_specs", "faq", "cta", "featured_image", "ambient_photo", "divider", "spacer"] as const
    ).map((block) => [block, renderBlock(block, level, data)]),
  );
  return customHtml.replace(/\{\{(\w+)\}\}/g, (match, token: string) =>
    Object.prototype.hasOwnProperty.call(fragments, token) ? (fragments[token as PdpBlock] ?? "") : match,
  );
}

const ALIGN_CSS: Record<PdpTextAlign, string> = { left: "left", right: "right", center: "center", justify: "justify" };
const FONT_SIZE_CSS: Record<PdpFontSize, string> = { sm: "0.85em", md: "1em", lg: "1.2em" };

/** Wraps one cell's rendered block in its own align/weight/size — `text-align`/`font-weight`/
 *  `font-size` all inherit into the block's own tags (paragraphs, list rows, table cells), so one
 *  wrapper is enough without having to thread these through every renderBlock case individually. */
function wrapLayoutCell(html: string, cell: PdpLayoutCell): string {
  if (!html) return "";
  const style = `text-align:${ALIGN_CSS[cell.align]};font-size:${FONT_SIZE_CSS[cell.fontSize]};${cell.bold ? "font-weight:700;" : ""}`;
  return `<div style="${style}">${html}</div>`;
}

/** Renders one layout cell — "divider"/"spacer" bypass wrapLayoutCell entirely (align/bold don't
 *  mean anything for a plain rule or an empty gap, and a cell's fontSize means "how big a gap"
 *  for a spacer instead of literal text size), every other block goes through the normal
 *  align/weight/size wrapper. */
function renderLayoutCell(cell: PdpLayoutCell, level: DescriptionRichness, data: BlockData): string {
  if (cell.block === "divider") return renderDividerBlock();
  if (cell.block === "spacer") return renderSpacerBlock(cell.fontSize);
  return wrapLayoutCell(renderBlock(cell.block, level, data), cell);
}

/** "Modo de layout" (see pdpTemplates.layout's doc comment) — a row with one column renders full
 *  width; a row with two renders as a side-by-side flex pair (wraps on narrow viewports rather than
 *  forcing an overlap). A cell whose block has no data collapses out entirely, same "never an empty
 *  shell" rule as the other two render modes — including a two-column row where only one side has
 *  data, which then just renders as that one column, not a lopsided empty box next to it. */
export function renderPdpLayout(layout: PdpLayoutRow[], level: DescriptionRichness, data: BlockData): string {
  const rows = layout
    .map((row) => row.columns.map((cell) => renderLayoutCell(cell, level, data)).filter(Boolean))
    .filter((cells) => cells.length > 0)
    .map((cells) =>
      cells.length === 1
        ? cells[0]
        : `<div style="display:flex;gap:1.5em;flex-wrap:wrap;margin:1em 0;">${cells
            .map((c) => `<div style="flex:1;min-width:220px;">${c}</div>`)
            .join("")}</div>`,
    );
  return rows.join("");
}

/** Picks whichever render mode applies — the one call site both publisher.agent.ts and the
 *  "Configuração de PDP" preview route need, so neither has to duplicate the
 *  customHtml-vs-layout-vs-blocks precedence itself. */
export function renderPdp(
  template: { blocks: PdpBlock[]; customHtml: string | null; layout?: PdpLayoutRow[] | null },
  level: DescriptionRichness,
  data: BlockData,
): string {
  if (template.customHtml) return renderPdpHtmlFromTemplate(template.customHtml, level, data);
  if (template.layout && template.layout.length > 0) return renderPdpLayout(template.layout, level, data);
  return renderPdpHtml(template.blocks, level, data);
}

/** Whether a resolved template actually places this block somewhere — used to skip the extra
 *  "fetch the product's own images" round-trip (see ambient_photo sourcing below) for every
 *  product in a run when the merchant's template doesn't even use that block. */
function templateUsesBlock(template: ResolvedPdpTemplate, block: PdpBlock): boolean {
  if (template.customHtml) return template.customHtml.includes(`{{${block}}}`);
  if (template.layout && template.layout.length > 0) return template.layout.some((row) => row.columns.some((c) => c.block === block));
  return template.blocks.includes(block);
}

async function markPublished(proposalId: number): Promise<void> {
  await db.update(enrichmentProposals).set({ status: "published", publishedAt: new Date() }).where(eq(enrichmentProposals.id, proposalId));
}

/** Writes every human-approved proposal of a run back to the active catalog platform (VTEX or
 *  Shopify). Never touches non-approved proposals. */
export async function publishApprovedProposals(params: {
  catalog: CatalogClient;
  runId: number;
}): Promise<{ published: number; failed: number }> {
  const [run, approved] = await Promise.all([
    db.query.enrichmentRuns.findFirst({ where: eq(enrichmentRuns.id, params.runId) }),
    db.query.enrichmentProposals.findMany({
      where: and(eq(enrichmentProposals.runId, params.runId), eq(enrichmentProposals.status, "approved")),
    }),
  ]);
  // The run's own request params (StartEnrichmentRunParams) are stored verbatim as `scope` —
  // that's the one place descriptionRichness is recorded, so the same level used to GENERATE the
  // content is what resolves which PDP template renders it back.
  const level = ((run?.scope as { descriptionRichness?: DescriptionRichness } | null)?.descriptionRichness ?? "plain") as DescriptionRichness;

  // A product with multiple approved proposals (e.g. description + FAQ + several alt-texts) would
  // otherwise refetch the same row once per proposal — one batched lookup instead.
  const productIds = [...new Set(approved.map((p) => p.productId))];
  const productRows = productIds.length ? await db.query.products.findMany({ where: inArray(products.id, productIds) }) : [];
  const productById = new Map(productRows.map((p) => [p.id, p]));

  const byProduct = new Map<number, Proposal[]>();
  for (const proposal of approved) {
    const list = byProduct.get(proposal.productId) ?? [];
    list.push(proposal);
    byProduct.set(proposal.productId, list);
  }

  let published = 0;
  let failed = 0;

  const PDP_MERGED_FIELDS = ["description", "benefit_bullets", "technical_specs", "faq", "cta", "featured_image"] as const;
  // Resolving a template hits the DB — cache per category since many products in a run usually
  // share one.
  const templateCache = new Map<string, ResolvedPdpTemplate>();
  async function templateFor(category: string | null): Promise<ResolvedPdpTemplate> {
    const key = category ?? "";
    if (!templateCache.has(key)) templateCache.set(key, await resolvePdpTemplate(params.catalog.platform, category, level));
    return templateCache.get(key)!;
  }

  for (const [productId, proposals] of byProduct) {
    const product = productById.get(productId);
    if (!product) {
      console.error(`Failed to publish proposals for product ${productId}: product not found`);
      failed += proposals.length;
      continue;
    }

    const descriptionProposal = proposals.find((p) => p.field === "description");
    const bulletsProposal = proposals.find((p) => p.field === "benefit_bullets");
    const specsProposal = proposals.find((p) => p.field === "technical_specs");
    const faqProposal = proposals.find((p) => p.field === "faq");
    const ctaProposal = proposals.find((p) => p.field === "cta");
    const featuredImageProposal = proposals.find((p) => p.field === "featured_image");
    const seoTitleProposal = proposals.find((p) => p.field === "seo_title");
    const metaDescriptionProposal = proposals.find((p) => p.field === "meta_description");
    const tagsProposal = proposals.find((p) => p.field === "tags");
    const structuredDataProposal = proposals.find((p) => p.field === "structured_data");
    const keywordsProposal = proposals.find((p) => p.field === "keywords");
    const attributesPatchProposal = proposals.find((p) => p.field === "attributes_patch");
    const handled = new Set([
      ...PDP_MERGED_FIELDS,
      "seo_title",
      "meta_description",
      "tags",
      "structured_data",
      "keywords",
      "attributes_patch",
    ]);
    const rest = proposals.filter((p) => !handled.has(p.field));

    const mergedProposals = [descriptionProposal, bulletsProposal, specsProposal, faqProposal, ctaProposal, featuredImageProposal];
    if (mergedProposals.some(Boolean)) {
      try {
        const template = await templateFor(product.category);
        const featuredImage = featuredImageProposal
          ? (JSON.parse(featuredImageProposal.proposedValue) as { url: string; caption: string })
          : undefined;
        // No proposal/generation step produces this — it's sourced straight from the product's own
        // already-hosted photos, no AI call needed. This store's own convention tags the lifestyle/
        // "foto ambientada" shot with image Label "2" (confirmed live); only bothers fetching the
        // product's images at all when the resolved template actually places this block somewhere.
        let ambientPhoto: { url: string; caption: string } | undefined;
        if (templateUsesBlock(template, "ambient_photo")) {
          try {
            const detail = await params.catalog.getProduct(product.vtexProductId);
            const labeled = detail.images.find((img) => img.label === "2");
            if (labeled) ambientPhoto = { url: labeled.url, caption: labeled.altText ?? product.title };
          } catch (err) {
            console.error(`Failed to resolve ambient_photo for product ${productId} — leaving that block empty`, err);
          }
        }
        const finalDescription = renderPdp(template, level, {
          description: descriptionProposal?.proposedValue ?? product.description ?? undefined,
          bullets: bulletsProposal ? (JSON.parse(bulletsProposal.proposedValue) as string[]) : undefined,
          specs: specsProposal ? (JSON.parse(specsProposal.proposedValue) as Array<{ label: string; value: string }>) : undefined,
          faq: faqProposal ? (JSON.parse(faqProposal.proposedValue) as Array<{ question: string; answer: string }>) : undefined,
          cta: ctaProposal?.proposedValue,
          featuredImage,
          ambientPhoto,
        });
        await params.catalog.updateProductDescription(product.vtexProductId, finalDescription);
        for (const p of mergedProposals) {
          if (!p) continue;
          await markPublished(p.id);
          published++;
        }

        // Best-effort, in addition to the merged-HTML block above: any spec whose label matches a
        // field the platform's category actually accepts also gets written into the REAL
        // Specification module ("Características do Produto" on VTEX) — not just the description's
        // inline table. Never lets a failure here undo the successful description publish just above.
        if (specsProposal) {
          try {
            const specs = JSON.parse(specsProposal.proposedValue) as Array<{ label: string; value: string }>;
            const { specValues } = await resolveSpecFieldValues(
              params.catalog.platform,
              product.category,
              specs.map((s) => [s.label, s.value]),
            );
            if (specValues.length > 0) await params.catalog.updateProductSpecificationValues(product.vtexProductId, specValues);
          } catch (err) {
            console.error(`Failed to publish technical_specs to the native Specification module for product ${productId}:`, err);
          }
        }
      } catch (err) {
        console.error(`Failed to publish PDP blocks for product ${productId}:`, err);
        failed += mergedProposals.filter(Boolean).length;
      }
    }

    // seo_title/meta_description share one native platform write (VTEX: same product PUT.
    // Shopify: same productUpdate `seo` input).
    if (seoTitleProposal || metaDescriptionProposal) {
      try {
        await params.catalog.updateProductSeo(product.vtexProductId, {
          title: seoTitleProposal?.proposedValue,
          metaDescription: metaDescriptionProposal?.proposedValue,
        });
        for (const p of [seoTitleProposal, metaDescriptionProposal]) {
          if (!p) continue;
          await markPublished(p.id);
          published++;
        }
      } catch (err) {
        console.error(`Failed to publish seo_title/meta_description for product ${productId}:`, err);
        failed += [seoTitleProposal, metaDescriptionProposal].filter(Boolean).length;
      }
    }

    if (tagsProposal) {
      try {
        await params.catalog.updateProductTags(product.vtexProductId, JSON.parse(tagsProposal.proposedValue) as string[]);
        await markPublished(tagsProposal.id);
        published++;
      } catch (err) {
        console.error(`Failed to publish tags for product ${productId}:`, err);
        failed++;
      }
    }

    // Our own synthesized data with no pre-existing merchant field — written under a fixed
    // "catalogia" namespace on Shopify; no-op on VTEX (no metafield concept there).
    if (structuredDataProposal) {
      try {
        await params.catalog.updateProductMetafields(product.vtexProductId, [
          { key: "structured_data", value: structuredDataProposal.proposedValue, type: "json", namespace: "catalogia" },
        ]);
        await markPublished(structuredDataProposal.id);
        published++;
      } catch (err) {
        console.error(`Failed to publish structured_data for product ${productId}:`, err);
        failed++;
      }
    }

    // VTEX: real native field (`KeyWords`, "Palavras similares" in the admin — confirmed live
    // against a real account). Shopify: no native equivalent, publishes via the metafield below
    // instead (see ShopifyClient.updateProductKeywords's doc comment).
    if (keywordsProposal) {
      try {
        const { primary, secondary } = JSON.parse(keywordsProposal.proposedValue) as { primary: string[]; secondary: string[] };
        await params.catalog.updateProductKeywords(product.vtexProductId, [...primary, ...secondary].join(", "));
        await params.catalog.updateProductMetafields(product.vtexProductId, [
          { key: "keywords", value: keywordsProposal.proposedValue, type: "json", namespace: "catalogia" },
        ]);
        await markPublished(keywordsProposal.id);
        published++;
      } catch (err) {
        console.error(`Failed to publish keywords for product ${productId}:`, err);
        failed++;
      }
    }

    // Attribute normalization/fill — VTEX: any key matching a field the product's category
    // actually accepts goes to the real Specification module (updateProductSpecificationValues);
    // anything left over falls through to updateProductMetafields, same as before (Shopify's real
    // path — matches existing terminology or creates a new field; a no-op on VTEX, which has no
    // metafield concept, so a key VTEX doesn't recognize as a spec field simply isn't published).
    if (attributesPatchProposal) {
      try {
        const patch = JSON.parse(attributesPatchProposal.proposedValue) as Record<string, string>;
        const { specValues, rest: unresolved } = await resolveSpecFieldValues(
          params.catalog.platform,
          product.category,
          Object.entries(patch),
        );
        if (specValues.length > 0) await params.catalog.updateProductSpecificationValues(product.vtexProductId, specValues);
        if (unresolved.length > 0) {
          await params.catalog.updateProductMetafields(
            product.vtexProductId,
            unresolved.map(([key, value]) => ({ key, value })),
          );
        }
        await markPublished(attributesPatchProposal.id);
        published++;
      } catch (err) {
        console.error(`Failed to publish attributes_patch for product ${productId}:`, err);
        failed++;
      }
    }

    for (const proposal of rest) {
      try {
        if (proposal.field === "alt_text") {
          const { imageId, altText } = JSON.parse(proposal.proposedValue) as { imageId: string; altText: string };
          await params.catalog.updateImageAltText({
            externalId: product.vtexProductId,
            variantId: product.vtexSkuId,
            imageId,
            altText,
          });
        }
        await markPublished(proposal.id);
        published++;
      } catch (err) {
        console.error(`Failed to publish proposal ${proposal.id}:`, err);
        failed++;
      }
    }
  }

  return { published, failed };
}
