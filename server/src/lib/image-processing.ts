import sharp from "sharp";

/** This store's convention for every photo uploaded to VTEX (confirmed with the user) — every
 *  image this app ever publishes, AI-generated or downloaded from a manufacturer reference page,
 *  gets normalized to exactly this before it's persisted. */
export const STORE_IMAGE_SIZE = 1000;
const JPEG_QUALITY = 90;

export interface NormalizedCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function normalizedCropToPixelBox(crop: NormalizedCropRect, imageWidth: number, imageHeight: number) {
  const left = Math.max(0, Math.min(imageWidth - 1, Math.floor(crop.x * imageWidth)));
  const top = Math.max(0, Math.min(imageHeight - 1, Math.floor(crop.y * imageHeight)));
  const desiredWidth = Math.max(1, Math.round(crop.width * imageWidth));
  const desiredHeight = Math.max(1, Math.round(crop.height * imageHeight));

  return {
    left,
    top,
    width: Math.max(1, Math.min(desiredWidth, imageWidth - left)),
    height: Math.max(1, Math.min(desiredHeight, imageHeight - top)),
  };
}

/** Crops/resizes any source image (whatever format/dimensions it came in as) to a
 *  STORE_IMAGE_SIZE x STORE_IMAGE_SIZE JPEG. `fit: "cover"` crops to fill the square rather than
 *  letterboxing — matches how this store's existing catalog photos are framed. */
export async function toStoreJpeg(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize(STORE_IMAGE_SIZE, STORE_IMAGE_SIZE, { fit: "cover" })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}

/** Turns a user-selected normalized rectangle from a reference photo into a square JPEG reference
 *  for image generation. This is only prompt context, not a publishable asset. */
export async function cropReferenceToJpeg(buffer: Buffer, crop: NormalizedCropRect): Promise<Buffer> {
  const image = sharp(buffer);
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Nao foi possivel ler as dimensoes da imagem de referencia.");
  }

  return image
    .extract(normalizedCropToPixelBox(crop, metadata.width, metadata.height))
    .resize(STORE_IMAGE_SIZE, STORE_IMAGE_SIZE, { fit: "cover" })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}
