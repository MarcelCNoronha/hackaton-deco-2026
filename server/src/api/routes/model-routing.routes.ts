import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getModelRouting, setModelRouting } from "../../repositories/model-routing.repo.js";
import { requireSection } from "../../auth/guards.js";

const taskEnum = z.enum(["contentEnrichment", "imageAltText", "evaluator"]);
const providerEnum = z.enum(["anthropic", "openai", "gemini"]);

const routingBody = z.object({
  routing: z.array(
    z.object({
      task: taskEnum,
      provider: providerEnum,
      model: z.string().min(1),
    }),
  ),
});

export async function modelRoutingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSection("connections"));

  app.get("/api/model-routing", async () => getModelRouting());

  app.put("/api/model-routing", async (req, reply) => {
    const body = routingBody.parse(req.body);
    await setModelRouting(body.routing);
    return reply.send(await getModelRouting());
  });
}
