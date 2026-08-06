import { db } from "../db/client.js";
import { generatedImages } from "../db/schema.js";
import { safeUrlFetch } from "../clients/safe-url-fetch.js";
import type { GeminiClient } from "../clients/gemini.client.js";
import { toStoreJpeg } from "../lib/image-processing.js";

const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_SOURCE_IMAGE_BYTES = 25_000_000;
const MAX_DOWNLOAD_ATTEMPTS = 8;

export async function extractManufacturerReferenceImage(params: {
  gemini: GeminiClient | null;
  productId: number;
  sourceUrl: string;
  imageUrls: string[];
  existingImageUrl: string | null;
}): Promise<typeof generatedImages.$inferSelect | null> {
  for (const imageUrl of params.imageUrls.slice(0, MAX_DOWNLOAD_ATTEMPTS)) {
    let jpeg: Buffer;
    try {
      const { response, body } = await safeUrlFetch(imageUrl, {
        timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
        maxBytes: MAX_SOURCE_IMAGE_BYTES,
        init: {
          headers: {
            Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5",
            "User-Agent": "Mozilla/5.0 (compatible; CatalogIA-ImageFetcher/1.0)",
          },
        },
      });
      if (!response.ok) continue;
      jpeg = await toStoreJpeg(body);
    } catch (err) {
      console.error(`[manufacturer-image] candidate ${imageUrl} failed to download/decode for product ${params.productId}:`, err);
      continue;
    }

    let integrityVerified = false;
    let integrityNotes: string;
    if (!params.gemini) {
      integrityNotes = "Conexao Gemini nao configurada - integridade nao verificada.";
    } else if (!params.existingImageUrl) {
      integrityNotes = "Produto sem foto propria cadastrada para comparar - integridade nao verificada.";
    } else {
      try {
        const verdict = await params.gemini.verifyImageIntegrity({
          referenceImageUrl: params.existingImageUrl,
          generatedBase64: jpeg.toString("base64"),
          generatedMimeType: "image/jpeg",
          productId: params.productId,
        });
        integrityVerified = verdict.sameProduct;
        integrityNotes = verdict.notes;
      } catch (err) {
        integrityNotes = `Verificacao de integridade falhou (erro tecnico, nao reprovacao): ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[manufacturer-image] integrity check errored for product ${params.productId}:`, err);
      }
    }

    const [row] = await db
      .insert(generatedImages)
      .values({
        productId: params.productId,
        kind: "manufacturer_reference",
        prompt: `Foto extraida da referencia do fabricante: ${params.sourceUrl}`,
        sourceUrl: params.sourceUrl,
        mimeType: "image/jpeg",
        imageBase64: jpeg.toString("base64"),
        integrityVerified,
        integrityNotes,
      })
      .returning();
    return row;
  }
  return null;
}
