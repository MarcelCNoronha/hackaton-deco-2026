import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { enrichmentProposals, products } from "../db/schema.js";
import type { CatalogClient } from "../clients/catalog-types.js";

type Proposal = typeof enrichmentProposals.$inferSelect;

/** VTEX/Shopify have no native "FAQ" product field, so a FAQ proposal on its own would never
 *  actually reach a shopper — appended as plain HTML onto the (also native) description instead,
 *  the only field that both is publishable and is actually shown to a customer. */
function renderFaqHtml(faq: Array<{ question: string; answer: string }>): string {
  const items = faq
    .map((item) => `<h3>${escapeHtml(item.question)}</h3><p>${escapeHtml(item.answer)}</p>`)
    .join("");
  return `<div class="catalogia-faq"><h2>Perguntas frequentes</h2>${items}</div>`;
}

/** Same reasoning as FAQ: no native "CTA" field on either platform, so it's merged as a short HTML
 *  block onto the description instead of staying invisible to a shopper. */
function renderCtaHtml(cta: string): string {
  return `<p class="catalogia-cta"><strong>${escapeHtml(cta)}</strong></p>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  const approved = await db.query.enrichmentProposals.findMany({
    where: and(eq(enrichmentProposals.runId, params.runId), eq(enrichmentProposals.status, "approved")),
  });

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

  for (const [productId, proposals] of byProduct) {
    const product = productById.get(productId);
    if (!product) {
      console.error(`Failed to publish proposals for product ${productId}: product not found`);
      failed += proposals.length;
      continue;
    }

    const descriptionProposal = proposals.find((p) => p.field === "description");
    const faqProposal = proposals.find((p) => p.field === "faq");
    const ctaProposal = proposals.find((p) => p.field === "cta");
    const seoTitleProposal = proposals.find((p) => p.field === "seo_title");
    const metaDescriptionProposal = proposals.find((p) => p.field === "meta_description");
    const tagsProposal = proposals.find((p) => p.field === "tags");
    const mergedIntoDescription = new Set(["description", "faq", "cta"]);
    const rest = proposals.filter(
      (p) => !mergedIntoDescription.has(p.field) && p.field !== "seo_title" && p.field !== "meta_description" && p.field !== "tags",
    );

    // Merge FAQ/CTA into the description update so they're actually visible to a shopper —
    // publishing any subset of the three still results in exactly one description write.
    if (descriptionProposal || faqProposal || ctaProposal) {
      try {
        let finalDescription = descriptionProposal?.proposedValue ?? product.description ?? "";
        if (faqProposal) {
          finalDescription += renderFaqHtml(JSON.parse(faqProposal.proposedValue) as Array<{ question: string; answer: string }>);
        }
        if (ctaProposal) {
          finalDescription += renderCtaHtml(ctaProposal.proposedValue);
        }
        await params.catalog.updateProductDescription(product.vtexProductId, finalDescription);
        for (const p of [descriptionProposal, faqProposal, ctaProposal]) {
          if (!p) continue;
          await markPublished(p.id);
          published++;
        }
      } catch (err) {
        console.error(`Failed to publish description/FAQ/CTA for product ${productId}:`, err);
        failed += [descriptionProposal, faqProposal, ctaProposal].filter(Boolean).length;
      }
    }

    // seo_title/meta_description share one native platform write (VTEX: same product PUT.
    // Shopify: same productUpdate `seo` input) — merge the pair the same way as description/FAQ.
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
        // "structured_data"/"keywords"/"attributes_patch" não têm campo nativo equivalente na
        // plataforma nesta v1 — seguem apresentados apenas dentro do CatalogIA por enquanto.
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
