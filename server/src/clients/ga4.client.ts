import { getGoogleAccessToken } from "./google-auth.js";
import { requestWithRetry, type RequestLogEntry } from "./http.js";

export interface Ga4ReportRow {
  pagePath: string;
  sessions: number;
  engagedSessions: number;
  conversionRate: number;
  purchases: number;
  revenue: number;
}

export interface Ga4DailyPageReportRow extends Ga4ReportRow {
  date: string;
}

export interface Ga4DailyItemReportRow {
  date: string;
  itemId: string;
  itemName: string;
  itemsViewed: number;
  itemsAddedToCart: number;
  itemsCheckedOut: number;
  itemsPurchased: number;
  itemRevenue: number;
}

/** Thin client for the GA4 Data API (runReport). */
export class Ga4Client {
  constructor(
    private readonly propertyId: string,
    private readonly refreshToken: string,
    private readonly onAttempt?: (entry: RequestLogEntry) => void | Promise<void>,
  ) {}

  async runProductPageReport(params: { startDate: string; endDate: string }): Promise<Ga4ReportRow[]> {
    const rows = await this.runProductPageDailyReport(params);
    const byPath = new Map<string, Omit<Ga4ReportRow, "pagePath">>();
    for (const row of rows) {
      const current = byPath.get(row.pagePath) ?? {
        sessions: 0,
        engagedSessions: 0,
        conversionRate: 0,
        purchases: 0,
        revenue: 0,
      };
      current.sessions += row.sessions;
      current.engagedSessions += row.engagedSessions;
      current.purchases += row.purchases;
      current.revenue += row.revenue;
      byPath.set(row.pagePath, current);
    }
    return [...byPath.entries()].map(([pagePath, row]) => ({
      pagePath,
      ...row,
      conversionRate: row.sessions > 0 ? row.purchases / row.sessions : 0,
    }));
  }

  async runProductPageDailyReport(params: { startDate: string; endDate: string }): Promise<Ga4DailyPageReportRow[]> {
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
          dimensions: [{ name: "date" }, { name: "pagePath" }],
          metrics: [
            { name: "sessions" },
            { name: "engagedSessions" },
            { name: "sessionKeyEventRate" },
            { name: "ecommercePurchases" },
            { name: "purchaseRevenue" },
          ],
          limit: "100000",
        }),
      },
      onAttempt: this.onAttempt,
    });

    const body = (await res.json()) as {
      rows?: Array<{ dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }> }>;
    };

    return (body.rows ?? []).map((row) => ({
      date: row.dimensionValues[0]?.value ?? "",
      pagePath: row.dimensionValues[1]?.value ?? "",
      sessions: Number(row.metricValues[0]?.value ?? 0),
      engagedSessions: Number(row.metricValues[1]?.value ?? 0),
      conversionRate: Number(row.metricValues[2]?.value ?? 0),
      purchases: Number(row.metricValues[3]?.value ?? 0),
      revenue: Number(row.metricValues[4]?.value ?? 0),
    }));
  }

  async runItemDailyReport(params: { startDate: string; endDate: string }): Promise<Ga4DailyItemReportRow[]> {
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
          dimensions: [{ name: "date" }, { name: "itemId" }, { name: "itemName" }],
          metrics: [
            { name: "itemsViewed" },
            { name: "itemsAddedToCart" },
            { name: "itemsCheckedOut" },
            { name: "itemsPurchased" },
            { name: "itemRevenue" },
          ],
          limit: "100000",
        }),
      },
      onAttempt: this.onAttempt,
    });

    const body = (await res.json()) as {
      rows?: Array<{ dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }> }>;
    };

    return (body.rows ?? []).map((row) => ({
      date: row.dimensionValues[0]?.value ?? "",
      itemId: row.dimensionValues[1]?.value ?? "",
      itemName: row.dimensionValues[2]?.value ?? "",
      itemsViewed: Number(row.metricValues[0]?.value ?? 0),
      itemsAddedToCart: Number(row.metricValues[1]?.value ?? 0),
      itemsCheckedOut: Number(row.metricValues[2]?.value ?? 0),
      itemsPurchased: Number(row.metricValues[3]?.value ?? 0),
      itemRevenue: Number(row.metricValues[4]?.value ?? 0),
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
