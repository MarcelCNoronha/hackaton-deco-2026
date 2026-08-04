import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { enrichmentProposals, generatedImages, products } from "../../db/schema.js";
import { requireAuth } from "../../auth/guards.js";
import { syncProduct } from "../../agents/catalog-reader.agent.js";
import { extractManufacturerFacts } from "../../agents/reference-facts.agent.js";
import { extractManufacturerReferenceImage } from "../../agents/manufacturer-image.agent.js";
import { generateProductImage } from "../../agents/image-generation.agent.js";
import { getProductRealImpact } from "../../agents/impact.agent.js";
import { requireActiveCatalogClient } from "./catalog.routes.js";
import { getConnectionCredentials } from "../../repositories/connections.repo.js";
import { makeRequestLogger } from "../../repositories/logs.repo.js";
import { GeminiClient } from "../../clients/gemini.client.js";
import { GscClient } from "../../clients/gsc.client.js";
import { Ga4Client } from "../../clients/ga4.client.js";
import { IMAGE_GENERATION_MODEL } from "../../clients/model-recommendations.js";
import { env } from "../../config/env.js";

const generateImageBody = z.object({
  kind: z.enum(["lifestyle", "feature_callout"]),
  note: z.string().max(500).optional(),
});

const manufacturerReferenceBody = z.object({ manufacturerReferenceUrl: z.string().url().nullable() });

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

  /** Live antes/depois comparison read straight from GSC/GA4 (no local snapshot table — see
   *  impact.agent.ts) pivoted on this product's earliest publish date. Works with only one of the
   *  two Google connections (e.g. GSC without GA4) — whichever side is missing just comes back null. */
  app.get<{ Params: { id: string } }>("/api/products/:id/real-impact", async (req, reply) => {
    const product = await db.query.products.findFirst({ where: eq(products.id, Number(req.params.id)) });
    if (!product) return reply.status(404).send({ error: "Produto não encontrado" });

    const googleCreds = await getConnectionCredentials("google");
    const logger = makeRequestLogger();
    const gsc = googleCreds ? new GscClient(googleCreds.gscSiteUrl, googleCreds.refreshToken, logger) : null;
    const ga4 = googleCreds ? new Ga4Client(googleCreds.ga4PropertyId, googleCreds.refreshToken, logger) : null;

    return getProductRealImpact({ gsc, ga4, product });
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

  /** Sets (or clears, when null) the merchant's per-product reference URL — typically the
   *  manufacturer's own page for this exact product — used as a factual grounding source at
   *  generation time (see reference-facts.agent.ts and enrichment-schema.ts's
   *  especificacoesFabricante payload field). Extraction runs synchronously here (one URL, one LLM
   *  call) and the result is cached on the product row so future optimizations of this same
   *  product don't re-fetch/re-extract unless the URL changes. Independent of the category-level
   *  DNA (category-reference-links.repo.ts) — this is per-product facts, that's category-wide
   *  structure.
   *
   *  Keyed by `externalId` (not the local `products.id`) and syncs-on-demand via syncProduct: the
   *  Runs.tsx catalog list is browsing the live platform catalog, where a product may not have a
   *  local row yet (only created once a run has touched it — see CatalogProductSummary.productId).
   *  This lets a merchant set the reference before ever running an optimization. */
  app.patch<{ Params: { externalId: string } }>("/api/products/by-external-id/:externalId/manufacturer-reference", async (req, reply) => {
    const body = manufacturerReferenceBody.parse(req.body);
    try {
      const catalog = await requireActiveCatalogClient();
      const product = await syncProduct(catalog, req.params.externalId);

      if (!body.manufacturerReferenceUrl) {
        const [updated] = await db
          .update(products)
          .set({ manufacturerReferenceUrl: null, manufacturerReferenceFacts: null, manufacturerReferenceSyncedAt: null })
          .where(eq(products.id, product.id))
          .returning();
        return updated;
      }

      const { facts, warning, imageUrls } = await extractManufacturerFacts(body.manufacturerReferenceUrl);
      const [updated] = await db
        .update(products)
        .set({
          manufacturerReferenceUrl: body.manufacturerReferenceUrl,
          manufacturerReferenceFacts: facts,
          manufacturerReferenceSyncedAt: new Date(),
        })
        .where(eq(products.id, product.id))
        .returning();

      // Best-effort, never blocks saving the reference/facts above — same discipline as
      // extractManufacturerFacts itself. Runs after the DB write so a slow/failed image download
      // never delays the merchant seeing their facts saved.
      if (imageUrls.length > 0) {
        try {
          const geminiCreds = await getConnectionCredentials<"gemini">("gemini");
          const gemini = geminiCreds ? new GeminiClient(geminiCreds.apiKey, IMAGE_GENERATION_MODEL, makeRequestLogger()) : null;
          const existingImageUrl = (product.images as Array<{ ImageUrl: string }>)[0]?.ImageUrl ?? null;
          await extractManufacturerReferenceImage({
            gemini,
            productId: product.id,
            sourceUrl: body.manufacturerReferenceUrl,
            imageUrls,
            existingImageUrl,
          });
        } catch (err) {
          console.error(`[manufacturer-image] extraction failed for product ${product.id}:`, err);
        }
      }

      return { ...updated, warning };
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
      if (!image.integrityVerified) {
        // Enforced here, not just as a UI warning — "nunca publicar uma imagem enganosa" holds
        // even if a human clicks past the warning shown in RunDetail.
        return reply.status(400).send({
          error: "Integridade do produto não confirmada para esta imagem — não pode ser publicada. Gere uma nova imagem.",
        });
      }
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
