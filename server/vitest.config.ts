import { defineConfig } from "vitest/config";

// Dummy values satisfying config/env.ts's zod schema — the pure-logic unit tests never actually
// open a DB/Redis connection or call Google OAuth, they only need `env.ts`'s module-load-time
// `envSchema.parse(process.env)` to succeed. Vitest applies `test.env` before any test file
// imports run, and dotenv/config (loaded by env.ts) never overwrites an already-set variable, so
// these win over a real local .env without needing one to exist at all.
export default defineConfig({
  test: {
    environment: "node",
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      VALKEY_URL: "redis://localhost:6379",
      ENCRYPTION_KEY: "0".repeat(64),
      GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3333/api/connections/google/callback",
      SESSION_COOKIE_SECRET: "test-session-cookie-secret-at-least-32-chars",
    },
  },
});
