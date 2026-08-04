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

  /** Real search queries that actually bring people to each page — grounds SEO title/keywords
   *  generation in what buyers really type instead of the model guessing plausible-sounding
   *  terms. `rowLimit` caps the raw (page,query) pairs fetched in one call; `maxQueriesPerPage`
   *  caps how many top queries (by clicks, then impressions) are kept per page after grouping. */
  async queryTopQueriesByPage(params: {
    startDate: string;
    endDate: string;
    rowLimit?: number;
    maxQueriesPerPage?: number;
  }): Promise<Map<string, string[]>> {
    const accessToken = await getGoogleAccessToken(this.refreshToken);
    const res = await requestWithRetry({
      provider: "google",
      operation: "gsc.searchAnalytics.queryByPageAndQuery",
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
          dimensions: ["page", "query"],
          rowLimit: params.rowLimit ?? 5000,
        }),
      },
      onAttempt: this.onAttempt,
    });
    const body = (await res.json()) as { rows?: GscSearchAnalyticsRow[] };
    const rows = body.rows ?? [];

    const byPage = new Map<string, GscSearchAnalyticsRow[]>();
    for (const row of rows) {
      const [page] = row.keys;
      const list = byPage.get(page) ?? [];
      list.push(row);
      byPage.set(page, list);
    }

    const maxPerPage = params.maxQueriesPerPage ?? 5;
    const topQueriesByPage = new Map<string, string[]>();
    for (const [page, pageRows] of byPage) {
      const top = [...pageRows]
        .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
        .slice(0, maxPerPage)
        .map((r) => r.keys[1]);
      topQueriesByPage.set(page, top);
    }
    return topQueriesByPage;
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
