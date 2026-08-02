import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getProviderSpend, setProviderSpendLimit } from "../../repositories/provider-spend-limits.repo.js";
import { requireSection } from "../../auth/guards.js";

const setLimitBody = z.object({
  provider: z.enum(["anthropic", "openai", "gemini"]),
  limitUsd: z.number().positive().nullable(),
});

export async function spendLimitsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSection("connections"));

  app.get("/api/spend-limits", async () => getProviderSpend());

  app.put("/api/spend-limits", async (req, reply) => {
    const body = setLimitBody.parse(req.body);
    await setProviderSpendLimit(body.provider, body.limitUsd);
    return reply.send({ ok: true });
  });
}
