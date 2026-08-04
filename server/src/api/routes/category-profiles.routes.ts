import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCatalogPlatform } from "../../repositories/catalog-settings.repo.js";
import { listCategoryNodes } from "../../repositories/category-nodes.repo.js";
import { listCategoryFields } from "../../repositories/category-spec-fields.repo.js";
import {
  getContentProfile,
  listContentProfiles,
  setManualContentProfile,
} from "../../repositories/category-content-profile.repo.js";
import {
  addReferenceLink,
  listReferenceLinks,
  recomputeReferenceProfile,
  removeReferenceLink,
  MAX_REFERENCE_LINKS,
  type CategoryReferenceLink,
} from "../../repositories/category-reference-links.repo.js";
import { extractReferenceStructure } from "../../agents/reference-structure.agent.js";
import { requireSection } from "../../auth/guards.js";

const categoryQuery = z.object({ category: z.string().min(1) });
const referenceLinkBody = z.object({
  category: z.string().min(1),
  urls: z.array(z.string().url()).min(1).max(MAX_REFERENCE_LINKS),
});
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
 *  up to MAX_REFERENCE_LINKS pasted URLs happens synchronously in the POST handler below, one
 *  request for the whole batch (still cheap enough not to need a queue job unlike the Fase 1
 *  category-wide sync). Each URL's fetch+extraction is isolated (Promise.allSettled) so one bad
 *  link (unreachable site, blocked by the target's bot protection, etc.) never fails the others in
 *  the same request. */
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

  /** Every category with a saved profile — powers the "já mapeada" marker + date next to each
   *  option in PdpConfig.tsx's category selector. */
  app.get("/api/category-content-profiles", async () => {
    const platform = await getCatalogPlatform();
    return { profiles: await listContentProfiles(platform) };
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

    const existing = await listReferenceLinks(platform, body.category);
    const slotsLeft = MAX_REFERENCE_LINKS - existing.length;
    if (slotsLeft <= 0) {
      return reply.status(400).send({
        error: `Esta categoria já tem o máximo de ${MAX_REFERENCE_LINKS} links de referência — remova um antes de adicionar outro.`,
      });
    }

    // Only the first slotsLeft URLs get processed — the frontend already caps the form at
    // MAX_REFERENCE_LINKS total, this is the server-side backstop against a stale/tampered request.
    const urlsToProcess = body.urls.slice(0, slotsLeft);
    const results = await Promise.allSettled(
      urlsToProcess.map(async (url): Promise<CategoryReferenceLink> => {
        const extracted = await extractReferenceStructure(url);
        return addReferenceLink({
          platform,
          category: body.category,
          url,
          extractedSignals: extracted.signals,
          warning: extracted.warning,
        });
      }),
    );

    const links: CategoryReferenceLink[] = [];
    const errors: Array<{ url: string; error: string }> = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        links.push(result.value);
      } else {
        const reason = result.reason;
        errors.push({ url: urlsToProcess[i], error: reason instanceof Error ? reason.message : String(reason) });
      }
    });

    // Recompute once for the whole batch, not per link — same end state, one fifth the DB writes
    // when all 3 succeed. Guarded on its own: the links above are already safely persisted, so a
    // recompute failure (unexpected — signals are sanitized before ever reaching here, see
    // reference-structure.agent.ts) should never turn an otherwise-successful add into a 500 that
    // hides the fact the links actually saved.
    if (links.length > 0) {
      try {
        await recomputeReferenceProfile(platform, body.category);
      } catch (err) {
        errors.push({ url: "(recalcular perfil)", error: err instanceof Error ? err.message : String(err) });
      }
    }

    return reply.send({
      links,
      errors,
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
