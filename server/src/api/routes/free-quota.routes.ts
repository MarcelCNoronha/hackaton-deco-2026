import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getFreeQuotaStatuses, setFreeQuotaConfig } from "../../repositories/provider-free-quota.repo.js";
import { requireSection } from "../../auth/guards.js";

const setQuotaBody = z.object({
  provider: z.enum(["anthropic", "openai", "gemini"]),
  enabled: z.boolean(),
  quotaUsd: z.number().min(0),
  resetIntervalHours: z.number().int().positive(),
});

export async function freeQuotaRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSection("connections"));

  app.get("/api/free-quotas", async () => getFreeQuotaStatuses());

  app.put("/api/free-quotas", async (req, reply) => {
    const body = setQuotaBody.parse(req.body);
    await setFreeQuotaConfig(body.provider, {
      enabled: body.enabled,
      quotaUsd: body.quotaUsd,
      resetIntervalHours: body.resetIntervalHours,
    });
    return reply.send({ ok: true });
  });
}
