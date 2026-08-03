import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getConnectionCredentials,
  listConnections,
  setConnectionStatus,
  upsertConnection,
  type AnthropicCredentials,
  type GeminiCredentials,
  type OpenAiCredentials,
} from "../../repositories/connections.repo.js";
import type { VtexCredentials } from "../../clients/vtex.client.js";
import type { ShopifyCredentials } from "../../clients/shopify.client.js";
import type { GoogleCredentials } from "../../clients/google-auth.js";
import type { LlmProvider } from "../../clients/llm-types.js";
import { VtexClient } from "../../clients/vtex.client.js";
import { ShopifyClient } from "../../clients/shopify.client.js";
import { ClaudeClient } from "../../clients/claude.client.js";
import { OpenAiClient } from "../../clients/openai.client.js";
import { GeminiClient } from "../../clients/gemini.client.js";
import { GscClient } from "../../clients/gsc.client.js";
import { Ga4Client } from "../../clients/ga4.client.js";
import { buildGoogleAuthUrl, exchangeGoogleAuthCode } from "../../clients/google-auth.js";
import { RECOMMENDATIONS, resolveModel } from "../../clients/model-recommendations.js";
import { requireSection } from "../../auth/guards.js";

// Both fields end up interpolated straight into a request URL (see vtex.client.ts's constructor)
// alongside the account's AppKey/AppToken — an unvalidated value like "evil.com/" would send those
// credentials to an attacker-controlled host. Restricted to what a real VTEX subdomain/environment
// segment can contain.
const VTEX_SEGMENT = /^[a-z0-9-]+$/;
const vtexBody = z.object({
  displayName: z.string().min(1),
  account: z.string().min(1).regex(VTEX_SEGMENT, "Deve conter apenas letras minúsculas, números e hífen."),
  environment: z.string().min(1).regex(VTEX_SEGMENT, "Deve conter apenas letras minúsculas, números e hífen.").default("vtexcommercestable"),
  appKey: z.string().min(1),
  appToken: z.string().min(1),
});

// Same concern as VTEX above — shopDomain is interpolated into the GraphQL endpoint URL alongside
// the store's access token.
const shopifyBody = z.object({
  displayName: z.string().min(1),
  shopDomain: z.string().min(1).regex(/^[a-z0-9-]+\.myshopify\.com$/, "Deve ser o domínio *.myshopify.com da loja."),
  accessToken: z.string().min(1),
});

const apiKeyBody = z.object({
  displayName: z.string().min(1),
  apiKey: z.string().min(1),
});

const googleBody = z.object({
  displayName: z.string().min(1),
  code: z.string().min(1),
  gscSiteUrl: z.string().min(1),
  ga4PropertyId: z.string().min(1),
});

const llmProviderParam = z.enum(["anthropic", "openai", "gemini"]);

function buildTestClient(provider: LlmProvider, apiKey: string) {
  const model = resolveModel(provider, "price").id;
  if (provider === "anthropic") return new ClaudeClient(apiKey, model);
  if (provider === "openai") return new OpenAiClient(apiKey, model);
  return new GeminiClient(apiKey, model);
}

export async function connectionsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSection("connections"));

  app.get("/api/connections", async () => listConnections());

  app.get("/api/connections/google/auth-url", async () => ({ url: buildGoogleAuthUrl() }));

  app.post("/api/connections/vtex", async (req, reply) => {
    const body = vtexBody.parse(req.body);
    const { displayName, ...credentials } = body;
    await upsertConnection("vtex", displayName, credentials);

    const ok = await new VtexClient(credentials).testConnection();
    await setConnectionStatus("vtex", ok ? "connected" : "error");
    return reply.send({ ok });
  });

  app.post("/api/connections/shopify", async (req, reply) => {
    const body = shopifyBody.parse(req.body);
    const { displayName, ...credentials } = body;
    await upsertConnection("shopify", displayName, credentials);

    const ok = await new ShopifyClient(credentials).testConnection();
    await setConnectionStatus("shopify", ok ? "connected" : "error");
    return reply.send({ ok });
  });

  app.get<{ Querystring: { provider?: string } }>("/api/models", async (req) => {
    const provider = llmProviderParam.optional().parse(req.query.provider);
    if (provider) return RECOMMENDATIONS[provider];
    return RECOMMENDATIONS;
  });

  app.post("/api/connections/anthropic", async (req, reply) => {
    const body = apiKeyBody.parse(req.body);
    await upsertConnection("anthropic", body.displayName, { apiKey: body.apiKey });

    const { ok, error } = await buildTestClient("anthropic", body.apiKey).testConnection();
    await setConnectionStatus("anthropic", ok ? "connected" : "error");
    return reply.send({ ok, error });
  });

  app.post("/api/connections/openai", async (req, reply) => {
    const body = apiKeyBody.parse(req.body);
    await upsertConnection("openai", body.displayName, { apiKey: body.apiKey });

    const { ok, error } = await buildTestClient("openai", body.apiKey).testConnection();
    await setConnectionStatus("openai", ok ? "connected" : "error");
    return reply.send({ ok, error });
  });

  app.post("/api/connections/gemini", async (req, reply) => {
    const body = apiKeyBody.parse(req.body);
    await upsertConnection("gemini", body.displayName, { apiKey: body.apiKey });

    const { ok, error } = await buildTestClient("gemini", body.apiKey).testConnection();
    await setConnectionStatus("gemini", ok ? "connected" : "error");
    return reply.send({ ok, error });
  });

  app.post("/api/connections/google", async (req, reply) => {
    const body = googleBody.parse(req.body);
    const tokens = await exchangeGoogleAuthCode(body.code);
    const credentials = {
      refreshToken: tokens.refresh_token!,
      gscSiteUrl: body.gscSiteUrl,
      ga4PropertyId: body.ga4PropertyId,
    };
    await upsertConnection("google", body.displayName, credentials);

    const [gscOk, ga4Ok] = await Promise.all([
      new GscClient(credentials.gscSiteUrl, credentials.refreshToken).testConnection(),
      new Ga4Client(credentials.ga4PropertyId, credentials.refreshToken).testConnection(),
    ]);
    await setConnectionStatus("google", gscOk && ga4Ok ? "connected" : "error");
    return reply.send({ ok: gscOk && ga4Ok, gscOk, ga4Ok });
  });

  app.post<{ Params: { provider: "vtex" | "google" | "anthropic" | "openai" | "gemini" | "shopify" } }>(
    "/api/connections/:provider/test",
    async (req, reply) => {
      const { provider } = req.params;

      let ok = false;
      let error: string | undefined;
      if (provider === "vtex") {
        const credentials = await getConnectionCredentials<"vtex">("vtex");
        if (!credentials) return reply.status(404).send({ error: "Connection not configured" });
        ok = await new VtexClient(credentials as VtexCredentials).testConnection();
      } else if (provider === "shopify") {
        const credentials = await getConnectionCredentials<"shopify">("shopify");
        if (!credentials) return reply.status(404).send({ error: "Connection not configured" });
        ok = await new ShopifyClient(credentials as ShopifyCredentials).testConnection();
      } else if (provider === "anthropic" || provider === "openai" || provider === "gemini") {
        const credentials = await getConnectionCredentials<"anthropic" | "openai" | "gemini">(provider);
        if (!credentials) return reply.status(404).send({ error: "Connection not configured" });
        const { apiKey } = credentials as AnthropicCredentials | OpenAiCredentials | GeminiCredentials;
        ({ ok, error } = await buildTestClient(provider, apiKey).testConnection());
      } else {
        const credentials = await getConnectionCredentials<"google">("google");
        if (!credentials) return reply.status(404).send({ error: "Connection not configured" });
        const google = credentials as GoogleCredentials;
        const [gscOk, ga4Ok] = await Promise.all([
          new GscClient(google.gscSiteUrl, google.refreshToken).testConnection(),
          new Ga4Client(google.ga4PropertyId, google.refreshToken).testConnection(),
        ]);
        ok = gscOk && ga4Ok;
      }

      await setConnectionStatus(provider, ok ? "connected" : "error");
      return reply.send({ ok, error });
    },
  );
}
