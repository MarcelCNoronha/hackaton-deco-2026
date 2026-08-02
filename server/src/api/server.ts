import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { env } from "../config/env.js";
import { connectionsRoutes } from "./routes/connections.routes.js";
import { runsRoutes } from "./routes/runs.routes.js";
import { proposalsRoutes } from "./routes/proposals.routes.js";
import { productsRoutes } from "./routes/products.routes.js";
import { scoresRoutes } from "./routes/scores.routes.js";
import { costsRoutes } from "./routes/costs.routes.js";
import { modelRoutingRoutes } from "./routes/model-routing.routes.js";
import { catalogRoutes } from "./routes/catalog.routes.js";
import { spendLimitsRoutes } from "./routes/spend-limits.routes.js";
import { freeQuotaRoutes } from "./routes/free-quota.routes.js";
import { authRoutes } from "./routes/auth.routes.js";
import { accountRoutes } from "./routes/account.routes.js";
import { usersRoutes } from "./routes/users.routes.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true, credentials: true });
await app.register(cookie, { secret: env.SESSION_COOKIE_SECRET, hook: "onRequest" });

app.get("/api/health", async () => ({ ok: true }));

await app.register(authRoutes);
await app.register(accountRoutes);
await app.register(usersRoutes);
await app.register(connectionsRoutes);
await app.register(runsRoutes);
await app.register(proposalsRoutes);
await app.register(productsRoutes);
await app.register(scoresRoutes);
await app.register(costsRoutes);
await app.register(modelRoutingRoutes);
await app.register(catalogRoutes);
await app.register(spendLimitsRoutes);
await app.register(freeQuotaRoutes);

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .then(() => app.log.info(`CatalogIA API listening on :${env.PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
