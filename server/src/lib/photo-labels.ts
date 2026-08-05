import type { CatalogClient } from "../clients/catalog-types.js";

/** This store's VTEX image-slot ("Label") convention — see the generated_images table's
 *  classification column and photoClassificationEnum in schema.ts for the full picture. Applies
 *  to every photo on a product regardless of where it came from: already on the platform (a
 *  merchant's own upload, previously unlabeled), extracted from a manufacturer reference page, or
 *  generated here by AI. */
export type PhotoClassification = "principal" | "ambientada" | "dimensional" | "destaque";

export const PHOTO_CLASSIFICATION_LABELS: Record<PhotoClassification, string> = {
  principal: "foto principal",
  ambientada: "foto ambientada",
  dimensional: "foto dimensional",
  destaque: "foto de destaque",
};

const FIXED_LABEL: Record<Exclude<PhotoClassification, "destaque">, string> = {
  principal: "1",
  ambientada: "2",
  dimensional: "3",
};

/** Resolves the numeric VTEX Label for a classification — fixed for principal/ambientada/
 *  dimensional (exactly one photo each), or the next free number from 4 up for "destaque" (the
 *  only slot that allows more than one photo). Reads the LIVE set of Labels already in the
 *  platform's own gallery for this product rather than any local bookkeeping, so numbering stays
 *  correct regardless of whether the existing "4"/"5"/etc. slots came from a photo generated here,
 *  a manufacturer-reference extraction, or something the merchant uploaded directly in the VTEX
 *  admin years ago. */
export async function resolvePhotoLabel(
  catalog: CatalogClient,
  externalId: string,
  classification: PhotoClassification,
): Promise<string> {
  if (classification !== "destaque") return FIXED_LABEL[classification];

  const detail = await catalog.getProduct(externalId);
  const usedDestaqueNumbers = detail.images
    .map((img) => (img.label ? Number(img.label) : NaN))
    .filter((n) => Number.isInteger(n) && n >= 4);
  const next = usedDestaqueNumbers.length > 0 ? Math.max(...usedDestaqueNumbers) + 1 : 4;
  return String(next);
}
