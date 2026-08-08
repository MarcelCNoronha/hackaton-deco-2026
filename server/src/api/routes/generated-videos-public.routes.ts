import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { generatedVideos } from "../../db/schema.js";

/** Deliberately UNAUTHENTICATED (registered outside the `requireAuth` hook other product routes
 *  use) — VTEX/Shopify's own servers fetch this URL directly when publishing a generated video as
 *  a real product video (see CatalogClient.addProductVideo), and neither platform can present a
 *  session cookie. Same reasoning/trust level as generated-images-public.routes.ts. */
export async function generatedVideosPublicRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/generated-videos/:id/raw", async (req, reply) => {
    const video = await db.query.generatedVideos.findFirst({ where: eq(generatedVideos.id, Number(req.params.id)) });
    if (!video) return reply.status(404).send();
    reply.header("Content-Type", video.mimeType).header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(Buffer.from(video.videoBase64, "base64"));
  });
}
