import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { enrichmentProposals, generatedImages, productMetrics, products } from "../../db/schema.js";
import { requireAuth } from "../../auth/guards.js";
import { syncProduct } from "../../agents/catalog-reader.agent.js";
import { generateProductImage } from "../../agents/image-generation.agent.js";
import { requireActiveCatalogClient } from "./catalog.routes.js";
import { getConnectionCredentials } from "../../repositories/connections.repo.js";
import { makeRequestLogger } from "../../repositories/logs.repo.js";
import { GeminiClient } from "../../clients/gemini.client.js";
import { IMAGE_GENERATION_MODEL } from "../../clients/model-recommendations.js";
import { env } from "../../config/env.js";

const generateImageBody = z.object({
  kind: z.enum(["lifestyle", "feature_callout"]),
  note: z.string().max(500).optional(),
});

export async function productsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/products", async () => {
    return db.query.products.findMany({ orderBy: desc(products.lastSyncedAt) });
  });

  /** Distinct products with at least one optimization proposal ever — used for the "Total de
   *  Otimizados" stat tile, which counts products, not runs (a product optimized in 3 runs still
   *  counts once). */
  app.get("/api/products/optimized-count", async () => {
    const [row] = await db
      .select({ count: sql<string>`count(distinct ${enrichmentProposals.productId})` })
      .from(enrichmentProposals);
    return { count: Number(row?.count ?? 0) };
  });

  /** Distinct products with at least one proposal still awaiting human review (pending or edited,
   *  not yet approved/rejected/published) — the "A Validar" stat tile. */
  app.get("/api/products/pending-review-count", async () => {
    const [row] = await db
      .select({ count: sql<string>`count(distinct ${enrichmentProposals.productId})` })
      .from(enrichmentProposals)
      .where(inArray(enrichmentProposals.status, ["pending", "edited"]));
    return { count: Number(row?.count ?? 0) };
  });

  app.get<{ Params: { id: string } }>("/api/products/:id/metrics", async (req) => {
    return db.query.productMetrics.findMany({
      where: eq(productMetrics.productId, Number(req.params.id)),
      orderBy: desc(productMetrics.fetchedAt),
    });
  });

  /** Re-fetches one product from the active catalog platform and refreshes the local snapshot —
   *  for when the local row was synced before a field existed yet (e.g. `url`, added later) or
   *  otherwise looks incomplete, without needing to run a whole new optimization just to refresh it. */
  app.post<{ Params: { id: string } }>("/api/products/:id/resync", async (req, reply) => {
    const existing = await db.query.products.findFirst({ where: eq(products.id, Number(req.params.id)) });
    if (!existing) return reply.status(404).send({ error: "Produto não encontrado" });

    try {
      const catalog = await requireActiveCatalogClient();
      return await syncProduct(catalog, existing.vtexProductId);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/products/:id/generated-images", async (req) => {
    return db.query.generatedImages.findMany({
      where: eq(generatedImages.productId, Number(req.params.id)),
      orderBy: desc(generatedImages.createdAt),
    });
  });

  /** Generates a new marketing image FROM the product's existing photos (lifestyle scene or a
   *  feature close-up) via Gemini — the only one of our 3 LLM providers that can generate images
   *  at all (Claude is vision-input-only; OpenAI's image-edit endpoint isn't wired up here). */
  app.post<{ Params: { id: string } }>("/api/products/:id/generated-images", async (req, reply) => {
    const body = generateImageBody.parse(req.body);
    const product = await db.query.products.findFirst({ where: eq(products.id, Number(req.params.id)) });
    if (!product) return reply.status(404).send({ error: "Produto não encontrado" });

    const geminiCreds = await getConnectionCredentials<"gemini">("gemini");
    if (!geminiCreds) {
      return reply.status(400).send({ error: "Conexão Gemini não configurada — configure no painel de Integrações primeiro." });
    }

    try {
      const gemini = new GeminiClient(geminiCreds.apiKey, IMAGE_GENERATION_MODEL, makeRequestLogger());
      const row = await generateProductImage({ gemini, product, kind: body.kind, note: body.note });
      return reply.status(201).send(row);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Uploads an already-generated image as a real product photo on the active catalog platform —
   *  distinct from generating it (above), which only ever saves it inside CatalogIA. Requires
   *  APP_BASE_URL to be set to a publicly reachable origin (VTEX/Shopify's own servers fetch the
   *  image bytes from `/api/generated-images/:id/raw`, not from the caller's browser). */
  app.post<{ Params: { id: string; imageId: string } }>(
    "/api/products/:id/generated-images/:imageId/publish",
    async (req, reply) => {
      const product = await db.query.products.findFirst({ where: eq(products.id, Number(req.params.id)) });
      if (!product) return reply.status(404).send({ error: "Produto não encontrado" });
      const image = await db.query.generatedImages.findFirst({ where: eq(generatedImages.id, Number(req.params.imageId)) });
      if (!image || image.productId !== product.id) return reply.status(404).send({ error: "Imagem não encontrada" });
      if (!env.APP_BASE_URL) {
        return reply.status(400).send({ error: "APP_BASE_URL não configurado — necessário pra plataforma buscar a imagem." });
      }

      try {
        const catalog = await requireActiveCatalogClient();
        await catalog.addProductImage({
          externalId: product.vtexProductId,
          variantId: product.vtexSkuId,
          imageUrl: `${env.APP_BASE_URL}/api/generated-images/${image.id}/raw`,
          altText: `${product.title} — ${image.kind === "lifestyle" ? "foto ambientada" : "foto de destaque"}`,
        });
        const [updated] = await db
          .update(generatedImages)
          .set({ publishedAt: new Date() })
          .where(eq(generatedImages.id, image.id))
          .returning();
        return updated;
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
