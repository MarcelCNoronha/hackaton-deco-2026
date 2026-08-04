import sharp from "sharp";
import { db } from "../db/client.js";
import { generatedImages } from "../db/schema.js";
import type { GeminiClient } from "../clients/gemini.client.js";

/** The store's own convention for photos uploaded to VTEX — see products.routes.ts's manufacturer-
 *  reference route, where the user confirmed this is the exact target format. */
const TARGET_SIZE = 1000;
const JPEG_QUALITY = 90;

/** Candidates are tried in order (og:image first — see web-fetch.client.ts) until one actually
 *  downloads and decodes; a small cap since each attempt is a real HTTP fetch, not because we
 *  expect to need more than one or two. */
const MAX_DOWNLOAD_ATTEMPTS = 3;

/** Downloads the first workable candidate photo from a product's manufacturer reference page,
 *  crops/resizes it to the store's VTEX upload convention (1000x1000 JPG), and — when the product
 *  already has an existing photo to compare against — runs the same integrity gate as AI-generated
 *  images (never trusts that "the manufacturer's page for this product" is actually a match; a
 *  stale or wrong URL could point at a similar-but-different item). Persists even when integrity
 *  fails or can't be checked at all (no existing photo, or no Gemini connection) — same "always
 *  show something, but flag it" discipline as image-generation.agent.ts, so a human reviewing it
 *  in RunDetail sees exactly what happened instead of the candidate silently disappearing.
 *
 *  Never throws — called as a best-effort side effect of saving a manufacturer reference URL, same
 *  discipline as extractManufacturerFacts. Returns null when no candidate could be downloaded, or
 *  the page had no candidates at all. */
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
      const res = await fetch(imageUrl);
      if (!res.ok) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      jpeg = await sharp(buffer).resize(TARGET_SIZE, TARGET_SIZE, { fit: "cover" }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
    } catch (err) {
      console.error(`[manufacturer-image] candidate ${imageUrl} failed to download/decode for product ${params.productId}:`, err);
      continue;
    }

    let integrityVerified = false;
    let integrityNotes: string;
    if (!params.gemini) {
      integrityNotes = "Conexão Gemini não configurada — integridade não verificada.";
    } else if (!params.existingImageUrl) {
      integrityNotes = "Produto sem foto própria cadastrada para comparar — integridade não verificada.";
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
        integrityNotes = `Verificação de integridade falhou (erro técnico, não reprovação): ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[manufacturer-image] integrity check errored for product ${params.productId}:`, err);
      }
    }

    const [row] = await db
      .insert(generatedImages)
      .values({
        productId: params.productId,
        kind: "manufacturer_reference",
        prompt: `Foto extraída da referência do fabricante: ${params.sourceUrl}`,
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
