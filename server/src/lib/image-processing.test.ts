import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { cropReferenceToJpeg, normalizedCropToPixelBox, STORE_IMAGE_SIZE } from "./image-processing.js";

describe("image processing crop helpers", () => {
  it("converts normalized crop coordinates to a bounded pixel box", () => {
    expect(normalizedCropToPixelBox({ x: 0.25, y: 0.1, width: 0.5, height: 0.75 }, 200, 100)).toEqual({
      left: 50,
      top: 10,
      width: 100,
      height: 75,
    });

    expect(normalizedCropToPixelBox({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, 200, 100)).toEqual({
      left: 180,
      top: 90,
      width: 20,
      height: 10,
    });
  });

  it("crops a reference image into the store square JPEG format", async () => {
    const source = await sharp({
      create: {
        width: 200,
        height: 100,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .jpeg()
      .toBuffer();

    const output = await cropReferenceToJpeg(source, { x: 0.25, y: 0, width: 0.5, height: 1 });
    const metadata = await sharp(output).metadata();

    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(STORE_IMAGE_SIZE);
    expect(metadata.height).toBe(STORE_IMAGE_SIZE);
  });
});
