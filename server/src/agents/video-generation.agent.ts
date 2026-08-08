import { db } from "../db/client.js";
import { generatedVideos } from "../db/schema.js";
import type { GeminiClient } from "../clients/gemini.client.js";
import { VIDEO_GENERATION_DURATION_SECONDS, VIDEO_GENERATION_PRICE_PER_VIDEO } from "../clients/model-recommendations.js";
import type { ProductRow } from "./catalog-reader.agent.js";

interface ProductImage {
  ImageUrl: string;
  ImageText?: string;
  Id?: string | number;
}

const PRINCIPAL_IMAGE_PATTERN = /principal|main|hero/i;
/** Veo's ASSET-type referenceImages caps out here (confirmed live 2026-08-07) — same cost as 1
 *  image since Veo bills per second of OUTPUT video, not per input image, so there's no reason to
 *  send fewer than the max when more real photos are available. */
const MAX_REFERENCE_IMAGES = 3;

/** Picks up to MAX_REFERENCE_IMAGES real photos to use as Veo's asset references — the operator's
 *  chosen base image always goes first (it's what they explicitly picked in the generation modal),
 *  filled out with the product's other photos (principal-pattern first) up to the cap. */
function selectSourceImageUrls(images: ProductImage[], baseImageUrl?: string): string[] {
  const urls = images.filter((img) => Boolean(img.ImageUrl));
  if (baseImageUrl && !urls.some((img) => img.ImageUrl === baseImageUrl)) {
    throw new Error("A imagem base precisa ser uma imagem cadastrada neste produto.");
  }

  const ordered = [...urls].sort((a, b) => {
    const aPrincipal = PRINCIPAL_IMAGE_PATTERN.test(`${a.ImageText ?? ""} ${a.ImageUrl}`);
    const bPrincipal = PRINCIPAL_IMAGE_PATTERN.test(`${b.ImageText ?? ""} ${b.ImageUrl}`);
    return Number(bPrincipal) - Number(aPrincipal);
  });

  const selected = baseImageUrl ? [baseImageUrl] : [];
  for (const img of ordered) {
    if (selected.length >= MAX_REFERENCE_IMAGES) break;
    if (!selected.includes(img.ImageUrl)) selected.push(img.ImageUrl);
  }
  return selected;
}

/** Same integrity framing as image-generation.agent.ts's INTEGRITY_INSTRUCTION — repeated here
 *  rather than shared since a video prompt also needs to constrain MOTION (no product deformation
 *  across frames), which the image-only instruction doesn't address. */
function buildPrompt(title: string, note?: string): string {
  const trimmedNote = note?.trim();
  return (
    `Gere um vídeo curto de e-commerce mostrando o produto "${title}" a partir das imagens de referência — ` +
    "câmera com leve movimento (giro suave, aproximação sutil ou parallax de cenário), iluminação " +
    "consistente, still de produto tomando vida. INTEGRIDADE DO PRODUTO É OBRIGATÓRIA: o produto deve " +
    "permanecer EXATAMENTE o mesmo em todos os frames — mesma forma, cor, material e rótulo das imagens de " +
    "referência, sem deformar, duplicar ou alterar partes ao longo do movimento. Não gere pessoas, texto " +
    "ou marcas d'água na cena." +
    (trimmedNote ? ` INSTRUÇÃO ADICIONAL DO OPERADOR: ${trimmedNote}.` : "")
  );
}

/** Generates a short (see VIDEO_GENERATION_DURATION_SECONDS) marketing video FROM up to
 *  MAX_REFERENCE_IMAGES of the product's existing photos (never from scratch) and persists it.
 *  Runs the same post-generation integrity gate as generateProductImage, but only ONE attempt
 *  (never regenerates on a failed verdict) — unlike image's MAX_INTEGRITY_ATTEMPTS retry loop, a
 *  single Veo generation already costs ~$0.80 and takes minutes, so auto-retrying here would 2x
 *  both for every video, verified or not. A failed/unverified verdict still doesn't block the
 *  video from being saved — same "always show something, but flag it" discipline as images — it
 *  only blocks *publishing* (see products.routes.ts's publish route) until a human confirms. */
export async function generateProductVideo(params: {
  gemini: GeminiClient;
  product: ProductRow;
  note?: string;
  baseImageUrl?: string;
}): Promise<typeof generatedVideos.$inferSelect> {
  const { gemini, product, note, baseImageUrl } = params;
  const images = (product.images as ProductImage[]) ?? [];
  if (images.length === 0) {
    throw new Error("Este produto não tem nenhuma imagem cadastrada para usar como referência.");
  }

  const sourceImageUrls = selectSourceImageUrls(images, baseImageUrl);
  const prompt = buildPrompt(product.title, note);

  const generated = await gemini.generateProductVideo({
    referenceImageUrls: sourceImageUrls,
    prompt,
    durationSeconds: VIDEO_GENERATION_DURATION_SECONDS,
    costUsd: VIDEO_GENERATION_PRICE_PER_VIDEO,
    productId: product.id,
  });

  let integrityVerified = false;
  let integrityNotes = "";
  // Same discipline as generateProductImage: a thrown error here (network blip, model rejecting
  // video input) is NOT a rejection verdict — it just means verification couldn't be completed,
  // so the video is still saved with integrityVerified=false for human review rather than lost.
  try {
    const verdict = await gemini.verifyVideoIntegrity({
      referenceImageUrl: sourceImageUrls[0],
      generatedVideoBase64: generated.base64,
      generatedVideoMimeType: generated.mimeType,
      productId: product.id,
      requiredInstruction: note,
    });
    integrityVerified = verdict.sameProduct;
    integrityNotes = verdict.notes;
    if (!integrityVerified) {
      console.error(`[video-generation] integrity check failed for product ${product.id}: ${verdict.notes}`);
    }
  } catch (err) {
    integrityNotes = `Verificação de integridade falhou (erro técnico, não reprovação): ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[video-generation] integrity check errored for product ${product.id}:`, err);
  }

  const [row] = await db
    .insert(generatedVideos)
    .values({
      productId: product.id,
      // Only the operator-chosen (or auto-picked) PRIMARY reference is stored here — the other up
      // to 2 supporting references used in generation aren't persisted individually, same as this
      // column already only ever held one URL (see schema.ts's doc comment).
      sourceImageUrl: sourceImageUrls[0],
      prompt,
      durationSeconds: VIDEO_GENERATION_DURATION_SECONDS,
      mimeType: generated.mimeType,
      videoBase64: generated.base64,
      costUsd: VIDEO_GENERATION_PRICE_PER_VIDEO.toString(),
      integrityVerified,
      integrityNotes,
    })
    .returning();
  return row;
}
