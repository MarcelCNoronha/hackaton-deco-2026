import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { generatedImages } from "../../db/schema.js";

/** Deliberately UNAUTHENTICATED (registered outside the `requireAuth` hook other product routes
 *  use) — VTEX/Shopify's own servers fetch this URL directly when publishing a generated image as
 *  a real product photo (see CatalogClient.addProductImage), and neither platform can present a
 *  session cookie. Safe to leave open: these are AI-generated marketing photos meant to become
 *  public product images anyway, not confidential data — same trust level as a public storefront
 *  image URL. */
export async function generatedImagesPublicRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/generated-images/:id/raw", async (req, reply) => {
    const image = await db.query.generatedImages.findFirst({ where: eq(generatedImages.id, Number(req.params.id)) });
    if (!image) return reply.status(404).send();
    reply.header("Content-Type", image.mimeType).header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(Buffer.from(image.imageBase64, "base64"));
  });
}
