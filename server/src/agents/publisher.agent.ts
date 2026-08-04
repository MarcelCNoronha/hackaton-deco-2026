import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { enrichmentProposals, enrichmentRuns, products } from "../db/schema.js";
import type { CatalogClient } from "../clients/catalog-types.js";
import type { DescriptionRichness } from "../clients/llm-types.js";
import { resolvePdpTemplate, type PdpBlock } from "../repositories/pdp-templates.repo.js";

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

interface BlockData {
  description?: string;
  bullets?: string[];
  specs?: Array<{ label: string; value: string }>;
  faq?: Array<{ question: string; answer: string }>;
  cta?: string;
  featuredImage?: { url: string; caption: string };
}

/** Assembles the final description HTML strictly following `blocks`' order — a block is skipped
 *  whenever its data wasn't approved for this product (e.g. no featured_image proposal, or the
 *  merchant's template doesn't include a block at all). */
function renderPdpHtml(blocks: PdpBlock[], level: DescriptionRichness, data: BlockData): string {
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
  const templateCache = new Map<string, PdpBlock[]>();
  async function templateFor(category: string | null): Promise<PdpBlock[]> {
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
        const blocks = await templateFor(product.category);
        const featuredImage = featuredImageProposal
          ? (JSON.parse(featuredImageProposal.proposedValue) as { url: string; caption: string })
          : undefined;
        const finalDescription = renderPdpHtml(blocks, level, {
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

    // Our own synthesized data (no pre-existing merchant field for either) — written under a
    // fixed "catalogia" namespace on Shopify; no-op on VTEX (no metafield concept there).
    if (structuredDataProposal || keywordsProposal) {
      try {
        const values: Array<{ key: string; value: string; type: string; namespace: string }> = [];
        if (structuredDataProposal) {
          values.push({ key: "structured_data", value: structuredDataProposal.proposedValue, type: "json", namespace: "catalogia" });
        }
        if (keywordsProposal) {
          values.push({ key: "keywords", value: keywordsProposal.proposedValue, type: "json", namespace: "catalogia" });
        }
        await params.catalog.updateProductMetafields(product.vtexProductId, values);
        for (const p of [structuredDataProposal, keywordsProposal]) {
          if (!p) continue;
          await markPublished(p.id);
          published++;
        }
      } catch (err) {
        console.error(`Failed to publish structured_data/keywords for product ${productId}:`, err);
        failed += [structuredDataProposal, keywordsProposal].filter(Boolean).length;
      }
    }

    // Attribute normalization/fill — targets the platform's OWN already-registered fields (Shopify
    // Category/Product metafields), matching existing terminology or creating a new field only
    // when nothing matches (see ShopifyClient.updateProductMetafields). No-op on VTEX.
    if (attributesPatchProposal) {
      try {
        const patch = JSON.parse(attributesPatchProposal.proposedValue) as Record<string, string>;
        const values = Object.entries(patch).map(([key, value]) => ({ key, value }));
        await params.catalog.updateProductMetafields(product.vtexProductId, values);
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
