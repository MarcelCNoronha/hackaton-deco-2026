import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { connections } from "../db/schema.js";
import { decryptCredentials, encryptCredentials } from "../security/encryption.js";
import type { VtexCredentials } from "../clients/vtex.client.js";
import type { ShopifyCredentials } from "../clients/shopify.client.js";
import type { GoogleCredentials } from "../clients/google-auth.js";

export type Provider = "vtex" | "google" | "anthropic" | "openai" | "gemini" | "shopify";

export interface AnthropicCredentials {
  apiKey: string;
}

export interface OpenAiCredentials {
  apiKey: string;
}

export interface GeminiCredentials {
  apiKey: string;
}

export type { ShopifyCredentials };

type CredentialsByProvider = {
  vtex: VtexCredentials;
  google: GoogleCredentials;
  anthropic: AnthropicCredentials;
  openai: OpenAiCredentials;
  gemini: GeminiCredentials;
  shopify: ShopifyCredentials;
};

export async function upsertConnection<P extends Provider>(
  provider: P,
  displayName: string,
  credentials: CredentialsByProvider[P],
) {
  const existing = await db.query.connections.findFirst({ where: eq(connections.provider, provider) });
  const credentialsEncrypted = encryptCredentials(credentials);

  if (existing) {
    const [updated] = await db
      .update(connections)
      .set({ displayName, credentialsEncrypted, status: "untested", updatedAt: new Date() })
      .where(eq(connections.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(connections)
    .values({ provider, displayName, credentialsEncrypted, status: "untested" })
    .returning();
  return created;
}

export async function getConnectionCredentials<P extends Provider>(
  provider: P,
): Promise<CredentialsByProvider[P] | null> {
  const row = await db.query.connections.findFirst({ where: eq(connections.provider, provider) });
  if (!row) return null;
  return decryptCredentials<CredentialsByProvider[P]>(row.credentialsEncrypted);
}

export async function setConnectionStatus(provider: Provider, status: "connected" | "error") {
  await db
    .update(connections)
    .set({ status, lastTestedAt: new Date() })
    .where(eq(connections.provider, provider));
}

export async function listConnections() {
  const rows = await db.query.connections.findMany();
  // Never return the encrypted blob to the API layer/frontend.
  return rows.map(({ credentialsEncrypted: _omit, ...rest }) => rest);
}
