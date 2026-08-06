import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { enrichmentProposals, enrichmentRuns, generatedImages, products } from "../../db/schema.js";
import { requireAuth } from "../../auth/guards.js";
import { syncProduct } from "../../agents/catalog-reader.agent.js";
import { extractManufacturerFacts } from "../../agents/reference-facts.agent.js";
import { extractManufacturerReferenceImage } from "../../agents/manufacturer-image.agent.js";
import { generateProductImage } from "../../agents/image-generation.agent.js";
import { republishProduct } from "../../agents/publisher.agent.js";
import { getProductRealImpact } from "../../agents/impact.agent.js";
import { requireActiveCatalogClient } from "./catalog.routes.js";
import { getCatalogPlatform } from "../../repositories/catalog-settings.repo.js";
import { getConnectionCredentials } from "../../repositories/connections.repo.js";
import { makeRequestLogger } from "../../repositories/logs.repo.js";
import { GeminiClient } from "../../clients/gemini.client.js";
import { GscClient } from "../../clients/gsc.client.js";
import { Ga4Client } from "../../clients/ga4.client.js";
import { IMAGE_GENERATION_MODEL } from "../../clients/model-recommendations.js";
import { env } from "../../config/env.js";
import { PHOTO_CLASSIFICATION_LABELS, resolvePhotoLabel } from "../../lib/photo-labels.js";

const generateImageBody = z.object({
  kind: z.enum(["principal", "lifestyle", "dimensional", "feature_callout"]),
  note: z.string().max(500).optional(),
  // Which run's "Custo da otimização" this generation's cost should count toward — optional since
  // this endpoint doesn't strictly require a run context, but RunDetail (the only caller today)
  // always has one in scope; omitting it silently drops the cost from every run total, confirmed
  // live (2026-08-05).
  runId: z.number().optional(),
});

const manufacturerReferenceBody = z.object({ manufacturerReferenceUrl: z.string().url().nullable() });

// null = declassify — clears whatever slot this photo held (see the two classify routes below).
const classifyImageBody = z.object({ classification: z.enum(["principal", "ambientada", "dimensional", "destaque"]).nullable() });

const republishBody = z.object({ runId: z.number() });

function imageGenerationNoteFromScope(scope: unknown): string | undefined {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return undefined;
  const note = (scope as Record<string, unknown>).imageGenerationNote;
  return typeof note === "string" && note.trim() ? note.trim() : undefined;
}

export async function productsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/products", async () => {
    const platform = await getCatalogPlatform();
    return db.query.products.findMany({ where: eq(products.platform, platform), orderBy: desc(products.lastSyncedAt) });
  });

  /** Distinct products with at least one optimization proposal ever — used for the "Total de
   *  Otimizados" stat tile, which counts products, not runs (a product optimized in 3 runs still
   *  counts once). */
  app.get("/api/products/optimized-count", async () => {
    const platform = await getCatalogPlatform();
    const [row] = await db
      .select({ count: sql<string>`count(distinct ${enrichmentProposals.productId})` })
      .from(enrichmentProposals)
      .innerJoin(products, eq(enrichmentProposals.productId, products.id))
      .where(eq(products.platform, platform));
    return { count: Number(row?.count ?? 0) };
  });

  /** Distinct products with at least one proposal still awaiting human review (pending or edited,
   *  not yet approved/rejected/published) — the "A Validar" stat tile. */
  app.get("/api/products/pending-review-count", async () => {
    const platform = await getCatalogPlatform();
    const [row] = await db
      .select({ count: sql<string>`count(distinct ${enrichmentProposals.productId})` })
      .from(enrichmentProposals)
      .innerJoin(products, eq(enrichmentProposals.productId, products.id))
      .where(and(eq(products.platform, platform), inArray(enrichmentProposals.status, ["pending", "edited"])));
    return { count: Number(row?.count ?? 0) };
  });

  /** Live antes/depois comparison read straight from GSC/GA4 (no local snapshot table — see
   *  impact.agent.ts) pivoted on this product's earliest publish date. Works with only one of the
   *  two Google connections (e.g. GSC without GA4) — whichever side is missing just comes back null. */
  app.get<{ Params: { id: string } }>("/api/products/:id/real-impact", async (req, reply) => {
    const platform = await getCatalogPlatform();
    const product = await db.query.products.findFirst({ where: and(eq(products.id, Number(req.params.id)), eq(products.platform, platform)) });
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
      const gemini = new GeminiClient(geminiCreds.apiKey, IMAGE_GENERATION_MODEL, makeRequestLogger(body.runId));
      const run = body.runId ? await db.query.enrichmentRuns.findFirst({ where: eq(enrichmentRuns.id, body.runId) }) : null;
      const note = [imageGenerationNoteFromScope(run?.scope), body.note?.trim()]
        .filter((value): value is string => Boolean(value))
        .join(" ");
      const row = await generateProductImage({ gemini, product, kind: body.kind, note: note || undefined });
      return reply.status(201).send(row);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // A manufacturer_reference photo's classification isn't implied by its kind (unlike the 4
  // AI-generated kinds — see CLASSIFICATION_BY_KIND) since a downloaded photo could fill any of
  // the 4 slots; this lets a human assign (or reassign) one. Also usable to re-classify an
  // AI-generated image if its auto-assigned slot isn't what the merchant actually wants, or to
  // declassify one (classification: null) — if it was already published (platformImageId set) on
  // VTEX, this also clears its real Label there so it stops being picked up as the
  // principal/ambient/dimensional/destaque photo, not just locally.
  app.patch<{ Params: { id: string } }>("/api/generated-images/:id/classify", async (req, reply) => {
    const body = classifyImageBody.parse(req.body);
    const existing = await db.query.generatedImages.findFirst({ where: eq(generatedImages.id, Number(req.params.id)) });
    if (!existing) return reply.status(404).send({ error: "Imagem não encontrada" });

    if (body.classification === null && existing.platformImageId) {
      try {
        const catalog = await requireActiveCatalogClient();
        if (catalog.platform === "vtex") {
          const product = await db.query.products.findFirst({ where: eq(products.id, existing.productId) });
          if (product) {
            await catalog.updateImageLabel({
              externalId: product.vtexProductId,
              variantId: product.vtexSkuId,
              imageId: existing.platformImageId,
              label: "",
            });
          }
        }
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }

    const [updated] = await db
      .update(generatedImages)
      .set({ classification: body.classification })
      .where(eq(generatedImages.id, Number(req.params.id)))
      .returning();
    return updated;
  });

  /** Deletes a generated/reference photo from CatalogIA's own "Fotos" panel, so unwanted or
   *  never-classified generations don't pile up. If it was already published (platformImageId
   *  set), the real photo is deleted from the platform FIRST — an error there aborts the whole
   *  request rather than deleting the local row and leaving an untracked orphan live on the
   *  storefront. */
  app.delete<{ Params: { id: string } }>("/api/generated-images/:id", async (req, reply) => {
    const existing = await db.query.generatedImages.findFirst({ where: eq(generatedImages.id, Number(req.params.id)) });
    if (!existing) return reply.status(404).send({ error: "Imagem não encontrada" });

    if (existing.platformImageId) {
      try {
        const catalog = await requireActiveCatalogClient();
        const product = await db.query.products.findFirst({ where: eq(products.id, existing.productId) });
        if (product) {
          await catalog.deleteImage({
            externalId: product.vtexProductId,
            variantId: product.vtexSkuId,
            imageId: existing.platformImageId,
          });
        }
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }

    await db.delete(generatedImages).where(eq(generatedImages.id, Number(req.params.id)));
    return reply.send({ ok: true });
  });

  /** The product's own photos already on the platform (a merchant's direct VTEX upload, most of
   *  which predate this store's Label convention and so come back unclassified) — shown alongside
   *  generated-images (AI + manufacturer reference) in the same panel so every photo for a product
   *  can be classified into one carousel from one place, see RunDetail's "Fotos" section. Excludes
   *  any image that IS one of our own already-published generated-images rows — matched by the
   *  platform's own file id (platformImageId), not URL: VTEX rewrites the upload Url to its own
   *  CDN host on read, so a URL comparison never matches (confirmed live) — without this, a
   *  published photo would show up twice: once as its "Gerada por IA"/"Foto do fabricante" card,
   *  once again here as "Já na loja". */
  app.get<{ Params: { id: string } }>("/api/products/:id/catalog-images", async (req, reply) => {
    const product = await db.query.products.findFirst({ where: eq(products.id, Number(req.params.id)) });
    if (!product) return reply.status(404).send({ error: "Produto não encontrado" });
    try {
      const catalog = await requireActiveCatalogClient();
      const detail = await catalog.getProduct(product.vtexProductId);
      const ownRows = await db.query.generatedImages.findMany({ where: eq(generatedImages.productId, product.id) });
      const ownPlatformIds = new Set(ownRows.map((r) => r.platformImageId).filter((id): id is string => id !== null));
      return detail.images.filter((img) => !ownPlatformIds.has(img.id));
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Re-labels (or, for classification: null, clears the Label of) a photo that's already on the
  // platform — VTEX only, since Shopify has no equivalent field.
  app.patch<{ Params: { id: string; imageId: string } }>(
    "/api/products/:id/catalog-images/:imageId/classify",
    async (req, reply) => {
      const body = classifyImageBody.parse(req.body);
      const product = await db.query.products.findFirst({ where: eq(products.id, Number(req.params.id)) });
      if (!product) return reply.status(404).send({ error: "Produto não encontrado" });
      try {
        const catalog = await requireActiveCatalogClient();
        const label = body.classification === null ? "" : await resolvePhotoLabel(catalog, product.vtexProductId, body.classification);
        await catalog.updateImageLabel({
          externalId: product.vtexProductId,
          variantId: product.vtexSkuId,
          imageId: req.params.imageId,
          label,
        });
        return reply.send({ ok: true, label });
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Full republish for one product (see republishProduct's doc comment) — every approved/edited/
  // published proposal it has in this run, plus reordering its photo carousel to match each
  // photo's current Label. Distinct from /api/proposals/:id/republish, which only touches ONE
  // proposal (and its merged-field siblings, if any).
  app.post<{ Params: { id: string } }>("/api/products/:id/republish", async (req, reply) => {
    const body = republishBody.parse(req.body);
    try {
      const catalog = await requireActiveCatalogClient();
      const result = await republishProduct({ catalog, runId: body.runId, productId: Number(req.params.id) });
      if (!result.ok) return reply.status(400).send({ error: result.error });
      return reply.send({ ok: true });
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
      if (!image.classification) {
        return reply.status(400).send({
          error: "Classifique a foto (principal, ambientada, dimensional ou destaque) antes de publicar.",
        });
      }
      if (!env.APP_BASE_URL) {
        return reply.status(400).send({ error: "APP_BASE_URL não configurado — necessário pra plataforma buscar a imagem." });
      }

      try {
        const catalog = await requireActiveCatalogClient();
        const label = await resolvePhotoLabel(catalog, product.vtexProductId, image.classification);
        const { id: platformImageId } = await catalog.addProductImage({
          externalId: product.vtexProductId,
          variantId: product.vtexSkuId,
          imageUrl: `${env.APP_BASE_URL}/api/generated-images/${image.id}/raw`,
          altText: `${product.title} — ${PHOTO_CLASSIFICATION_LABELS[image.classification]}`,
          label,
        });
        const [updated] = await db
          .update(generatedImages)
          .set({ publishedAt: new Date(), platformImageId })
          .where(eq(generatedImages.id, image.id))
          .returning();
        return updated;
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
