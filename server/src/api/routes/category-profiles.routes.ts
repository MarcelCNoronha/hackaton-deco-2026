import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCatalogPlatform } from "../../repositories/catalog-settings.repo.js";
import { listCategoryNodes } from "../../repositories/category-nodes.repo.js";
import { listCategoryFields } from "../../repositories/category-spec-fields.repo.js";
import {
  getContentProfile,
  setManualContentProfile,
} from "../../repositories/category-content-profile.repo.js";
import {
  addReferenceLink,
  listReferenceLinks,
  recomputeReferenceProfile,
  removeReferenceLink,
} from "../../repositories/category-reference-links.repo.js";
import { extractReferenceStructure } from "../../agents/reference-structure.agent.js";
import { requireSection } from "../../auth/guards.js";

const categoryQuery = z.object({ category: z.string().min(1) });
const referenceLinkBody = z.object({ category: z.string().min(1), url: z.string().url() });
const manualProfileBody = z.object({
  category: z.string().min(1),
  wordCountMin: z.number().int().positive().nullable(),
  wordCountMax: z.number().int().positive().nullable(),
  bulletCount: z.number().int().nonnegative().nullable(),
  hasFaq: z.boolean().nullable(),
  hasSpecTable: z.boolean().nullable(),
  hasWarrantySection: z.boolean().nullable(),
});

/** Read-only views over what category-sync.orchestrator.ts last synced — the "Campos aceitos pela
 *  VTEX" section of PdpConfig.tsx reads both to render the category tree and, per category, which
 *  fields are accepted there. Writing/re-syncing goes through
 *  POST /api/connections/vtex/sync-categories, not a route here.
 *
 *  Also owns the Fase 2 category content-profile / reference-link CRUD — extracting structure from
 *  a pasted URL happens synchronously in the POST handler below (one fetch + one LLM call, cheap
 *  enough not to need a queue job unlike the Fase 1 category-wide sync). */
export async function categoryProfilesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSection("connections"));

  app.get("/api/category-nodes", async () => {
    const platform = await getCatalogPlatform();
    return { platform, nodes: await listCategoryNodes(platform) };
  });

  app.get("/api/category-spec-fields", async () => {
    const platform = await getCatalogPlatform();
    return { platform, categories: await listCategoryFields(platform) };
  });

  app.get("/api/category-content-profile", async (req) => {
    const { category } = categoryQuery.parse(req.query);
    const platform = await getCatalogPlatform();
    return { profile: await getContentProfile(platform, category) };
  });

  app.put("/api/category-content-profile", async (req) => {
    const body = manualProfileBody.parse(req.body);
    const platform = await getCatalogPlatform();
    await setManualContentProfile(platform, body.category, {
      wordCountMin: body.wordCountMin,
      wordCountMax: body.wordCountMax,
      bulletCount: body.bulletCount,
      hasFaq: body.hasFaq,
      hasSpecTable: body.hasSpecTable,
      hasWarrantySection: body.hasWarrantySection,
    });
    return { profile: await getContentProfile(platform, body.category) };
  });

  app.get("/api/category-reference-links", async (req) => {
    const { category } = categoryQuery.parse(req.query);
    const platform = await getCatalogPlatform();
    return { links: await listReferenceLinks(platform, category) };
  });

  app.post("/api/category-reference-links", async (req, reply) => {
    const body = referenceLinkBody.parse(req.body);
    const platform = await getCatalogPlatform();

    let extracted: Awaited<ReturnType<typeof extractReferenceStructure>>;
    try {
      extracted = await extractReferenceStructure(body.url);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }

    const link = await addReferenceLink({
      platform,
      category: body.category,
      url: body.url,
      extractedSignals: extracted.signals,
      warning: extracted.warning,
    });
    await recomputeReferenceProfile(platform, body.category);

    return reply.send({
      link,
      profile: await getContentProfile(platform, body.category),
    });
  });

  app.delete<{ Params: { id: string } }>("/api/category-reference-links/:id", async (req, reply) => {
    const { category } = categoryQuery.parse(req.query);
    const platform = await getCatalogPlatform();
    await removeReferenceLink(Number(req.params.id));
    await recomputeReferenceProfile(platform, category);
    return reply.send({ profile: await getContentProfile(platform, category) });
  });
}
