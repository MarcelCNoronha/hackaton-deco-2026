import { db } from "../db/client.js";
import { generatedImages } from "../db/schema.js";
import type { GeminiClient } from "../clients/gemini.client.js";
import { IMAGE_GENERATION_PRICE_PER_IMAGE } from "../clients/model-recommendations.js";
import type { ProductRow } from "./catalog-reader.agent.js";

interface ProductImage {
  ImageUrl: string;
  ImageText?: string;
  Id?: string | number;
}

/** Gemini's multi-image input works best with a couple of clear references, not the whole gallery
 *  — more images raises cost and risks diluting which one the model treats as "the product". */
const MAX_REFERENCE_IMAGES = 2;

const PROMPTS: Record<"lifestyle" | "feature_callout", (title: string, note?: string) => string> = {
  lifestyle: (title, note) =>
    `Gere uma foto realista mostrando o produto "${title}" ambientado em um cenário de uso real e ` +
    "atraente (um ambiente bem decorado condizente com a categoria do produto). Preserve fielmente a " +
    "aparência, cor, formato e material do produto mostrado nas imagens de referência — não invente um " +
    "produto diferente, apenas insira-o de forma realista no novo cenário." +
    (note ? ` Detalhe adicional pedido: ${note}` : ""),
  feature_callout: (title, note) =>
    `Gere uma imagem de destaque de produto para "${title}", em estilo still de e-commerce, aproximando ` +
    "(close-up) ou destacando visualmente um detalhe/característica importante do produto mostrado nas " +
    "imagens de referência (acabamento, material, mecanismo, textura). Preserve fielmente a aparência real " +
    "do produto." +
    (note ? ` Característica a destacar: ${note}` : ""),
};

/** Generates a new marketing image FROM a product's existing photos (never from scratch) and
 *  persists it. Throws if the product has no reference images to work from — there's nothing to
 *  compose the new image against. */
export async function generateProductImage(params: {
  gemini: GeminiClient;
  product: ProductRow;
  kind: "lifestyle" | "feature_callout";
  note?: string;
}): Promise<typeof generatedImages.$inferSelect> {
  const { gemini, product, kind, note } = params;
  const images = (product.images as ProductImage[]) ?? [];
  if (images.length === 0) {
    throw new Error("Este produto não tem nenhuma imagem cadastrada para usar como referência.");
  }

  const referenceImageUrls = images.slice(0, MAX_REFERENCE_IMAGES).map((img) => img.ImageUrl);
  const prompt = PROMPTS[kind](product.title, note);

  const { mimeType, base64 } = await gemini.generateProductImage({
    referenceImageUrls,
    prompt,
    costUsd: IMAGE_GENERATION_PRICE_PER_IMAGE,
    productId: product.id,
  });

  const [row] = await db
    .insert(generatedImages)
    .values({
      productId: product.id,
      kind,
      prompt,
      mimeType,
      imageBase64: base64,
      costUsd: IMAGE_GENERATION_PRICE_PER_IMAGE.toString(),
    })
    .returning();
  return row;
}
