import { getGoogleAccessToken } from "./google-auth.js";
import { requestWithRetry, type RequestLogEntry } from "./http.js";

export interface Ga4ReportRow {
  pagePath: string;
  sessions: number;
  conversionRate: number;
  revenue: number;
}

/** Thin client for the GA4 Data API (runReport). */
export class Ga4Client {
  constructor(
    private readonly propertyId: string,
    private readonly refreshToken: string,
    private readonly onAttempt?: (entry: RequestLogEntry) => void | Promise<void>,
  ) {}

  async runProductPageReport(params: { startDate: string; endDate: string }): Promise<Ga4ReportRow[]> {
    const accessToken = await getGoogleAccessToken(this.refreshToken);
    const res = await requestWithRetry({
      provider: "google",
      operation: "ga4.runReport",
      url: `https://analyticsdata.googleapis.com/v1beta/properties/${this.propertyId}:runReport`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
          dimensions: [{ name: "pagePath" }],
          metrics: [
            { name: "sessions" },
            { name: "sessionConversionRate" },
            { name: "totalRevenue" },
          ],
        }),
      },
      onAttempt: this.onAttempt,
    });

    const body = (await res.json()) as {
      rows?: Array<{ dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }> }>;
    };

    return (body.rows ?? []).map((row) => ({
      pagePath: row.dimensionValues[0]?.value ?? "",
      sessions: Number(row.metricValues[0]?.value ?? 0),
      conversionRate: Number(row.metricValues[1]?.value ?? 0),
      revenue: Number(row.metricValues[2]?.value ?? 0),
    }));
  }

  async testConnection(): Promise<boolean> {
    try {
      const accessToken = await getGoogleAccessToken(this.refreshToken);
      const res = await requestWithRetry({
        provider: "google",
        operation: "ga4.properties.get",
        url: `https://analyticsadmin.googleapis.com/v1beta/properties/${this.propertyId}`,
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
