import sharp from "sharp";

/** This store's convention for every photo uploaded to VTEX (confirmed with the user) — every
 *  image this app ever publishes, AI-generated or downloaded from a manufacturer reference page,
 *  gets normalized to exactly this before it's persisted. */
export const STORE_IMAGE_SIZE = 1000;
const JPEG_QUALITY = 90;

/** Crops/resizes any source image (whatever format/dimensions it came in as) to a
 *  STORE_IMAGE_SIZE x STORE_IMAGE_SIZE JPEG. `fit: "cover"` crops to fill the square rather than
 *  letterboxing — matches how this store's existing catalog photos are framed. */
export async function toStoreJpeg(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize(STORE_IMAGE_SIZE, STORE_IMAGE_SIZE, { fit: "cover" })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}
