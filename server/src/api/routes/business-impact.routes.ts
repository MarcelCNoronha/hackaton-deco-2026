import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../auth/guards.js";
import { Ga4Client } from "../../clients/ga4.client.js";
import { GscClient } from "../../clients/gsc.client.js";
import { getConnectionCredentials } from "../../repositories/connections.repo.js";
import { getBusinessImpactSummary } from "../../repositories/business-impact.repo.js";
import { makeRequestLogger } from "../../repositories/logs.repo.js";

export async function businessImpactRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/impact/business", async () => {
    const googleCreds = await getConnectionCredentials("google");
    if (!googleCreds) return getBusinessImpactSummary({ gsc: null, ga4: null });

    const logger = makeRequestLogger();
    return getBusinessImpactSummary({
      gsc: new GscClient(googleCreds.gscSiteUrl, googleCreds.refreshToken, logger),
      ga4: new Ga4Client(googleCreds.ga4PropertyId, googleCreds.refreshToken, logger),
    });
  });
}
