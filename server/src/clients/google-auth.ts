import { google } from "googleapis";
import { env } from "../config/env.js";

export interface GoogleCredentials {
  refreshToken: string;
  gscSiteUrl: string;
  ga4PropertyId: string;
}

/** Bootstrap OAuth app (client id/secret) lives in env; per-connection refresh token lives encrypted in DB. */
export function createGoogleOAuthClient() {
  return new google.auth.OAuth2(
    env.GOOGLE_OAUTH_CLIENT_ID,
    env.GOOGLE_OAUTH_CLIENT_SECRET,
    env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

export function buildGoogleAuthUrl(): string {
  const client = createGoogleOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/webmasters.readonly",
      "https://www.googleapis.com/auth/analytics.readonly",
    ],
  });
}

export async function exchangeGoogleAuthCode(code: string) {
  const client = createGoogleOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh_token — retry the consent screen with prompt=consent");
  }
  return tokens;
}

export async function getGoogleAccessToken(refreshToken: string): Promise<string> {
  const client = createGoogleOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("Failed to refresh Google access token");
  return token;
}
