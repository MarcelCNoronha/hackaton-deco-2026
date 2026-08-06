import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client.js";
import { products } from "../../db/schema.js";
import { getThresholds, setThreshold } from "../../repositories/optimization-thresholds.repo.js";
import { requireSection } from "../../auth/guards.js";
import { getCatalogPlatform } from "../../repositories/catalog-settings.repo.js";

const thresholdBody = z.object({
  category: z.string().min(1),
  excellentMin: z.number().int().min(0).max(100),
  goodMin: z.number().int().min(0).max(100),
});

export async function optimizationThresholdsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSection("connections"));

  /** Feeds the "Padrões de Otimização por Categoria" section in Connections — every configured
   *  threshold plus every distinct category actually seen in the synced catalog, so the UI can
   *  offer a card per real category (not just whichever ones already have an override). */
  app.get("/api/optimization-thresholds", async () => {
    const platform = await getCatalogPlatform();
    const [thresholds, categoryRows] = await Promise.all([
      getThresholds(),
      db.selectDistinct({ category: products.category })
        .from(products)
        .where(and(eq(products.platform, platform), isNotNull(products.category))),
    ]);
    const categories = categoryRows.map((r) => r.category).filter((c): c is string => Boolean(c));
    return { thresholds, categories };
  });

  app.put("/api/optimization-thresholds", async (req, reply) => {
    const body = thresholdBody.parse(req.body);
    if (body.goodMin > body.excellentMin) {
      return reply.status(400).send({ error: "O limite 'Bom' não pode ser maior que o limite 'Excelente'." });
    }
    await setThreshold(body.category, { excellentMin: body.excellentMin, goodMin: body.goodMin });
    return reply.send({ ok: true });
  });
}
