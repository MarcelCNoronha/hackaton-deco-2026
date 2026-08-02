import { db } from "../db/client.js";
import { enrichmentProposals } from "../db/schema.js";
import type { LlmClient } from "../clients/llm-types.js";
import type { ProductRow } from "./catalog-reader.agent.js";

interface VtexImage {
  ImageUrl: string;
  ImageName?: string;
  ImageText?: string;
  Id?: string | number;
}

/** Generates alt-text proposals for every image of one product. Proposed value is a JSON blob
 *  (imageId/imageUrl/altText) since one product can have several images sharing the "alt_text" field. */
export async function proposeImageAltText(params: {
  llm: LlmClient;
  runId: number;
  product: ProductRow;
}): Promise<void> {
  const { llm, runId, product } = params;
  const images = (product.images as VtexImage[]) ?? [];

  for (const image of images) {
    const altText = await llm.generateAltText({
      imageUrl: image.ImageUrl,
      productTitle: product.title,
      productId: product.id,
    });

    await db.insert(enrichmentProposals).values({
      runId,
      productId: product.id,
      field: "alt_text",
      agent: "image",
      originalValue: image.ImageText ?? null,
      proposedValue: JSON.stringify({ imageId: image.Id, imageUrl: image.ImageUrl, altText }),
    });
  }
}
