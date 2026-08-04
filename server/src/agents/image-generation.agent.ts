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

/** "Integridade do produto é inegociável" (requisito explícito do usuário): a imagem gerada tem
 *  que mostrar o MESMO produto, nunca um "parecido" — só cenário/enquadramento/iluminação podem
 *  mudar. Reforçado aqui no prompt E checado de novo depois via verifyImageIntegrity (gate
 *  independente, não confia só na instrução). */
const INTEGRITY_INSTRUCTION =
  " PROIBIDO alterar a forma, cor, material ou rótulo/logo do produto mostrado nas imagens de referência — " +
  "é o MESMO produto, nunca um produto parecido ou genérico. Apenas cenário, enquadramento e iluminação " +
  "podem mudar.";

const PROMPTS: Record<"lifestyle" | "feature_callout", (title: string, note?: string) => string> = {
  lifestyle: (title, note) =>
    `Gere uma foto realista mostrando o produto "${title}" ambientado em um cenário de uso real e ` +
    "atraente (um ambiente bem decorado condizente com a categoria do produto)." +
    INTEGRITY_INSTRUCTION +
    (note ? ` Detalhe adicional pedido: ${note}` : ""),
  feature_callout: (title, note) =>
    `Gere uma imagem de destaque de produto para "${title}", em estilo still de e-commerce, aproximando ` +
    "(close-up) ou destacando visualmente um detalhe/característica importante do produto mostrado nas " +
    "imagens de referência (acabamento, material, mecanismo, textura)." +
    INTEGRITY_INSTRUCTION +
    (note ? ` Característica a destacar: ${note}` : ""),
};

/** Bounded retries for the integrity gate below — separate from (and on top of) generateProductImage's
 *  own network-level retry/backoff in gemini.client.ts. */
const MAX_INTEGRITY_ATTEMPTS = 2;

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

  let best: { mimeType: string; base64: string } | null = null;
  let integrityVerified = false;
  let integrityNotes = "";

  for (let attempt = 1; attempt <= MAX_INTEGRITY_ATTEMPTS; attempt++) {
    const generated = await gemini.generateProductImage({
      referenceImageUrls,
      prompt,
      costUsd: IMAGE_GENERATION_PRICE_PER_IMAGE,
      productId: product.id,
    });
    best = generated;

    // A thrown error here (network blip, transient 5xx) is NOT a rejection verdict — treating it
    // as one would discard an already-generated, already-billed image over a connectivity issue
    // instead of just recording that verification couldn't be completed this attempt.
    try {
      const verdict = await gemini.verifyImageIntegrity({
        referenceImageUrl: referenceImageUrls[0],
        generatedBase64: generated.base64,
        generatedMimeType: generated.mimeType,
        productId: product.id,
      });
      integrityNotes = verdict.notes;
      if (verdict.sameProduct) {
        integrityVerified = true;
        break;
      }
      console.error(
        `[image-generation] integrity check failed for product ${product.id} (attempt ${attempt}/${MAX_INTEGRITY_ATTEMPTS}): ${verdict.notes}`,
      );
    } catch (err) {
      integrityNotes = `Verificação de integridade falhou (erro técnico, não reprovação): ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[image-generation] integrity check errored for product ${product.id} (attempt ${attempt}/${MAX_INTEGRITY_ATTEMPTS}):`, err);
    }
  }

  // best is guaranteed set: the loop always runs at least once. Persisted even when never
  // verified — same "always show something, but flag it" discipline as unsupportedClaims for
  // text — so it's auditable in the panel instead of silently disappearing.
  const { mimeType, base64 } = best!;
  const [row] = await db
    .insert(generatedImages)
    .values({
      productId: product.id,
      kind,
      prompt,
      mimeType,
      imageBase64: base64,
      costUsd: IMAGE_GENERATION_PRICE_PER_IMAGE.toString(),
      integrityVerified,
      integrityNotes,
    })
    .returning();
  return row;
}
