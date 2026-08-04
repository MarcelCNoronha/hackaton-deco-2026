import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCatalogPlatform } from "../../repositories/catalog-settings.repo.js";
import { getPdpTemplates, setPdpTemplate, PDP_BLOCKS, DEFAULT_PDP_CATEGORY } from "../../repositories/pdp-templates.repo.js";
import { requireSection } from "../../auth/guards.js";

const levelEnum = z.enum(["plain", "structured", "structured_with_image"]);
const blockEnum = z.enum(PDP_BLOCKS);

const templateBody = z.object({
  level: levelEnum,
  blocks: z.array(blockEnum).refine((blocks) => new Set(blocks).size === blocks.length, "Blocos duplicados"),
  category: z.string().min(1).optional(),
});

export async function pdpTemplatesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSection("connections"));

  /** Templates for the currently active platform — the "Estrutura da PDP" section in
   *  Connections.tsx only ever edits the active platform's structure, since only one platform runs
   *  the pipeline at a time (see catalog_settings). */
  app.get("/api/pdp-templates", async () => {
    const platform = await getCatalogPlatform();
    return { platform, templates: await getPdpTemplates(platform) };
  });

  app.put("/api/pdp-templates", async (req, reply) => {
    const body = templateBody.parse(req.body);
    if (!body.blocks.includes("description")) {
      return reply.status(400).send({ error: "O bloco 'description' é obrigatório em qualquer estrutura de PDP." });
    }
    const platform = await getCatalogPlatform();
    await setPdpTemplate({ platform, category: body.category ?? DEFAULT_PDP_CATEGORY, level: body.level, blocks: body.blocks });
    return { platform, templates: await getPdpTemplates(platform) };
  });
}
