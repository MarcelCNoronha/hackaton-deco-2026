import { getGoogleAccessToken } from "./google-auth.js";
import { requestWithRetry, type RequestLogEntry } from "./http.js";

export interface GscSearchAnalyticsRow {
  keys: string[]; // [page] or [page, query] depending on requested dimensions
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Thin client for the Google Search Console API (searchanalytics.query). */
export class GscClient {
  constructor(
    private readonly siteUrl: string,
    private readonly refreshToken: string,
    private readonly onAttempt?: (entry: RequestLogEntry) => void | Promise<void>,
  ) {}

  async queryByPage(params: { startDate: string; endDate: string; rowLimit?: number }): Promise<GscSearchAnalyticsRow[]> {
    const accessToken = await getGoogleAccessToken(this.refreshToken);
    const res = await requestWithRetry({
      provider: "google",
      operation: "gsc.searchAnalytics.query",
      url: `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(this.siteUrl)}/searchAnalytics/query`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          startDate: params.startDate,
          endDate: params.endDate,
          dimensions: ["page"],
          rowLimit: params.rowLimit ?? 1000,
        }),
      },
      onAttempt: this.onAttempt,
    });
    const body = (await res.json()) as { rows?: GscSearchAnalyticsRow[] };
    return body.rows ?? [];
  }

  async testConnection(): Promise<boolean> {
    try {
      const accessToken = await getGoogleAccessToken(this.refreshToken);
      const res = await requestWithRetry({
        provider: "google",
        operation: "gsc.sites.get",
        url: `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(this.siteUrl)}`,
        init: { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } },
        retry: { maxAttempts: 1 },
        onAttempt: this.onAttempt,
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
