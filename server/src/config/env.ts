import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3333),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  VALKEY_URL: z.string().min(1, "VALKEY_URL is required"),
  ENCRYPTION_KEY: z
    .string()
    .length(64, "ENCRYPTION_KEY must be a 64-char hex string (32 bytes) — generate with `openssl rand -hex 32`"),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1, "GOOGLE_OAUTH_CLIENT_ID is required"),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1, "GOOGLE_OAUTH_CLIENT_SECRET is required"),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url(),
  SESSION_COOKIE_SECRET: z
    .string()
    .min(32, "SESSION_COOKIE_SECRET must be at least 32 characters — generate with `openssl rand -hex 32`"),
  // Optional: without these, password-reset/invite links are returned directly in the API
  // response instead of emailed (today's behavior) — same "graceful without it" pattern as the
  // Google/OpenAI-optional integrations elsewhere in this app.
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().optional(),
  // Base URL used to build password-reset/invite links (e.g. "https://app.example.com").
  // Deliberately NOT derived from the request's Origin header — that header is
  // client-supplied and trusting it lets an attacker redirect a real reset email's link
  // to an attacker-controlled domain. Falls back to the request Origin (then localhost)
  // only when unset, so local dev keeps working without extra config.
  APP_BASE_URL: z.string().url().optional(),
});

export const env = envSchema.parse(process.env);
