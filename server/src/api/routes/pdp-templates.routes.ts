import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCatalogPlatform } from "../../repositories/catalog-settings.repo.js";
import { getPdpTemplates, setPdpTemplate, PDP_BLOCKS, DEFAULT_PDP_CATEGORY, type PdpBlock } from "../../repositories/pdp-templates.repo.js";
import { renderPdp } from "../../agents/publisher.agent.js";
import { requireSection } from "../../auth/guards.js";

const levelEnum = z.enum(["plain", "structured", "structured_with_image"]);
const blockEnum = z.enum(PDP_BLOCKS);

const templateBody = z.object({
  level: levelEnum,
  blocks: z.array(blockEnum).refine((blocks) => new Set(blocks).size === blocks.length, "Blocos duplicados"),
  category: z.string().min(1).optional(),
  // Non-empty switches this (platform, category, level) to "modo avançado" — see
  // pdpTemplates.customHtml's doc comment. Empty/omitted keeps (or reverts to) simple mode.
  customHtml: z.string().nullable().optional(),
});

/** Generic placeholder content — the preview isn't tied to a real product, so this stands in for
 *  whatever the LLM would actually generate, just enough to show HOW the configured blocks/order
 *  turn into HTML. A neutral gray SVG data URI stands in for "one of the product's real photos"
 *  (never a stock photo — nothing here should look like an invented product image). */
const PLACEHOLDER_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#3a3a3a"/><text x="50%" y="50%" fill="#999" font-size="16" text-anchor="middle" dy=".3em">Foto do produto</text></svg>',
  );

const SAMPLE_DATA = {
  description:
    "Este produto foi desenvolvido para quem busca praticidade e durabilidade no dia a dia. Combina acabamento " +
    "resistente com um visual que se encaixa em diferentes ambientes.",
  bullets: [
    "Fácil instalação, sem ferramentas especiais",
    "Resistente a impactos e ao uso diário",
    "Acabamento que não desbota com o tempo",
  ],
  specs: [
    { label: "Marca", value: "Exemplo" },
    { label: "Material", value: "Liga metálica" },
    { label: "Dimensões", value: "20 x 15 x 5 cm" },
  ],
  faq: [
    { question: "Serve para uso externo?", answer: "Sim, é resistente à exposição ao tempo." },
    { question: "Qual a garantia?", answer: "12 meses contra defeito de fabricação." },
  ],
  cta: "Adicione ao carrinho e receba em casa em até 5 dias úteis.",
  featuredImage: { url: PLACEHOLDER_IMAGE, caption: "Destaque: acabamento resistente a manchas" },
};

export async function pdpTemplatesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSection("connections"));

  /** Templates for the currently active platform, resolved for one category at a time (query param,
   *  defaults to the catalog-wide `'*'`) — see PdpConfig.tsx's single category selector, shared with
   *  the VTEX-fields/content-DNA sections above it on that page. */
  app.get<{ Querystring: { category?: string } }>("/api/pdp-templates", async (req) => {
    const platform = await getCatalogPlatform();
    const category = req.query.category?.trim() || DEFAULT_PDP_CATEGORY;
    return { platform, category, templates: await getPdpTemplates(platform, category) };
  });

  /** Renders a live preview with placeholder content — using the EXACT same renderPdp (blocks OR
   *  customHtml, whichever the editor is currently in) as the real publish path, so what's shown
   *  here never drifts from what publishing would actually produce. Takes blocks/level/customHtml
   *  straight from the (possibly unsaved) editor state, not from the DB, so the user sees the
   *  effect of an edit before clicking "Salvar". */
  app.post("/api/pdp-templates/preview", async (req, reply) => {
    const body = z.object({ level: levelEnum, blocks: z.array(blockEnum), customHtml: z.string().nullable().optional() }).parse(req.body);
    const html = renderPdp({ blocks: body.blocks as PdpBlock[], customHtml: body.customHtml?.trim() || null }, body.level, SAMPLE_DATA);
    return reply.send({ html });
  });

  app.put("/api/pdp-templates", async (req, reply) => {
    const body = templateBody.parse(req.body);
    const customHtml = body.customHtml?.trim() || null;
    // Only enforced in simple mode — in "modo avançado" the merchant's own HTML decides the
    // structure, {{description}} isn't required to appear in it (though publishing without ANY
    // description content would be an odd choice, it's the merchant's call, not ours to block).
    if (!customHtml && !body.blocks.includes("description")) {
      return reply.status(400).send({ error: "O bloco 'description' é obrigatório em qualquer estrutura de PDP." });
    }
    const platform = await getCatalogPlatform();
    const category = body.category ?? DEFAULT_PDP_CATEGORY;
    await setPdpTemplate({ platform, category, level: body.level, blocks: body.blocks, customHtml });
    return { platform, category, templates: await getPdpTemplates(platform, category) };
  });
}
