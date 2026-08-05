import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { enrichmentProposals, enrichmentRuns, products } from "../db/schema.js";
import type { CatalogClient } from "../clients/catalog-types.js";
import type { DescriptionRichness } from "../clients/llm-types.js";
import { resolvePdpTemplate, type PdpBlock, type ResolvedPdpTemplate } from "../repositories/pdp-templates.repo.js";
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
function renderDescriptionBlock(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (paragraphs.length ? paragraphs : [text]).map((p) => `<p>${escapeHtml(p)}</p>`).join("");
}

function renderBulletsBlock(bullets: string[], level: DescriptionRichness): string {
  if (level === "plain") return `<p>${bullets.map(escapeHtml).join(" — ")}</p>`;
  return `<ul class="catalogia-bullets">${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`;
}

function renderSpecsBlock(specs: Array<{ label: string; value: string }>, level: DescriptionRichness): string {
  if (level === "plain") {
    return `<p>${specs.map((s) => `${escapeHtml(s.label)}: ${escapeHtml(s.value)}`).join(". ")}</p>`;
  }
  const rows = specs.map((s) => `<tr><td>${escapeHtml(s.label)}</td><td>${escapeHtml(s.value)}</td></tr>`).join("");
  return `<div class="catalogia-specs"><h2>Especificações</h2><table>${rows}</table></div>`;
}

function renderFaqBlock(faq: Array<{ question: string; answer: string }>, level: DescriptionRichness): string {
  if (level === "plain") {
    return `<div class="catalogia-faq">${faq.map((f) => `<p><strong>${escapeHtml(f.question)}</strong> ${escapeHtml(f.answer)}</p>`).join("")}</div>`;
  }
  const items = faq.map((f) => `<h3>${escapeHtml(f.question)}</h3><p>${escapeHtml(f.answer)}</p>`).join("");
  return `<div class="catalogia-faq"><h2>Perguntas frequentes</h2>${items}</div>`;
}

function renderCtaBlock(cta: string): string {
  return `<p class="catalogia-cta"><strong>${escapeHtml(cta)}</strong></p>`;
}

function renderFeaturedImageBlock(url: string, caption: string): string {
  return `<figure class="catalogia-featured-image"><img src="${escapeHtml(url)}" alt="${escapeHtml(caption)}" />${
    caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""
  }</figure>`;
}

export interface BlockData {
  description?: string;
  bullets?: string[];
  specs?: Array<{ label: string; value: string }>;
  faq?: Array<{ question: string; answer: string }>;
  cta?: string;
  featuredImage?: { url: string; caption: string };
}

/** Assembles the final description HTML strictly following `blocks`' order — a block is skipped
 *  whenever its data wasn't approved for this product (e.g. no featured_image proposal, or the
 *  merchant's template doesn't include a block at all). Exported so the "Configuração de PDP"
 *  preview (pdp-templates.routes.ts) renders with the EXACT same function that actually publishes
 *  — a preview that could drift from real behavior would be worse than no preview at all. */
export function renderPdpHtml(blocks: PdpBlock[], level: DescriptionRichness, data: BlockData): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block === "description" && data.description) parts.push(renderDescriptionBlock(data.description));
    else if (block === "benefit_bullets" && data.bullets) parts.push(renderBulletsBlock(data.bullets, level));
    else if (block === "technical_specs" && data.specs) parts.push(renderSpecsBlock(data.specs, level));
    else if (block === "faq" && data.faq) parts.push(renderFaqBlock(data.faq, level));
    else if (block === "cta" && data.cta) parts.push(renderCtaBlock(data.cta));
    else if (block === "featured_image" && data.featuredImage) {
      parts.push(renderFeaturedImageBlock(data.featuredImage.url, data.featuredImage.caption));
    }
  }
  return parts.join("");
}

/** "Modo avançado" (see pdpTemplates.customHtml's doc comment) — same per-block renderers as
 *  renderPdpHtml above (same escaping, same level-awareness), just assembled by substituting
 *  {{placeholder}} tokens into merchant-authored HTML instead of concatenating a fixed block list
 *  in order. A placeholder with no matching data (e.g. {{featured_image}} when nothing was
 *  approved) is replaced with an empty string — same "skip silently, never an empty shell" rule as
 *  the simple-mode renderer, just token-by-token instead of block-by-block. */
export function renderPdpHtmlFromTemplate(customHtml: string, level: DescriptionRichness, data: BlockData): string {
  const fragments: Record<PdpBlock, string> = {
    description: data.description ? renderDescriptionBlock(data.description) : "",
    benefit_bullets: data.bullets ? renderBulletsBlock(data.bullets, level) : "",
    technical_specs: data.specs ? renderSpecsBlock(data.specs, level) : "",
    faq: data.faq ? renderFaqBlock(data.faq, level) : "",
    cta: data.cta ? renderCtaBlock(data.cta) : "",
    featured_image: data.featuredImage ? renderFeaturedImageBlock(data.featuredImage.url, data.featuredImage.caption) : "",
  };
  return customHtml.replace(/\{\{(\w+)\}\}/g, (match, token: string) =>
    Object.prototype.hasOwnProperty.call(fragments, token) ? fragments[token as PdpBlock] : match,
  );
}

/** Picks whichever of the two renderers above applies — the one call site both publisher.agent.ts
 *  and the "Configuração de PDP" preview route need, so neither has to duplicate the
 *  customHtml-vs-blocks branch itself. */
export function renderPdp(template: { blocks: PdpBlock[]; customHtml: string | null }, level: DescriptionRichness, data: BlockData): string {
  return template.customHtml ? renderPdpHtmlFromTemplate(template.customHtml, level, data) : renderPdpHtml(template.blocks, level, data);
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
        const finalDescription = renderPdp(template, level, {
          description: descriptionProposal?.proposedValue ?? product.description ?? undefined,
          bullets: bulletsProposal ? (JSON.parse(bulletsProposal.proposedValue) as string[]) : undefined,
          specs: specsProposal ? (JSON.parse(specsProposal.proposedValue) as Array<{ label: string; value: string }>) : undefined,
          faq: faqProposal ? (JSON.parse(faqProposal.proposedValue) as Array<{ question: string; answer: string }>) : undefined,
          cta: ctaProposal?.proposedValue,
          featuredImage,
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
