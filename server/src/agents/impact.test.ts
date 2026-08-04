import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GscClient, GscSearchAnalyticsRow } from "../clients/gsc.client.js";
import type { Ga4Client, Ga4ReportRow } from "../clients/ga4.client.js";
import type { ProductRow } from "./catalog-reader.agent.js";

vi.mock("../repositories/real-impact.repo.js", () => ({
  getEarliestPublishedAt: vi.fn(),
}));

import { getProductRealImpact } from "./impact.agent.js";
import { getEarliestPublishedAt } from "../repositories/real-impact.repo.js";

const mockedGetEarliestPublishedAt = getEarliestPublishedAt as unknown as ReturnType<typeof vi.fn>;

function fakeProduct(url: string | null): ProductRow {
  return { id: 1, url } as unknown as ProductRow;
}

function fakeGsc(rows: GscSearchAnalyticsRow[]): GscClient {
  return { queryByPage: vi.fn().mockResolvedValue(rows) } as unknown as GscClient;
}

function fakeGa4(rows: Ga4ReportRow[]): Ga4Client {
  return { runProductPageReport: vi.fn().mockResolvedValue(rows) } as unknown as Ga4Client;
}

describe("getProductRealImpact", () => {
  beforeEach(() => {
    mockedGetEarliestPublishedAt.mockReset();
  });

  it("returns no_url when the product has no known URL, without even checking publish state", async () => {
    const result = await getProductRealImpact({ gsc: null, ga4: null, product: fakeProduct(null) });
    expect(result).toEqual({ status: "no_url" });
    expect(mockedGetEarliestPublishedAt).not.toHaveBeenCalled();
  });

  it("returns not_published when nothing has ever been published for this product", async () => {
    mockedGetEarliestPublishedAt.mockResolvedValue(null);
    const result = await getProductRealImpact({
      gsc: null,
      ga4: null,
      product: fakeProduct("https://loja.com/produto-1"),
    });
    expect(result).toEqual({ status: "not_published" });
  });

  it("returns maturing with a countdown when published fewer than 14 days ago", async () => {
    const publishedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    mockedGetEarliestPublishedAt.mockResolvedValue(publishedAt);

    const result = await getProductRealImpact({
      gsc: null,
      ga4: null,
      product: fakeProduct("https://loja.com/produto-1"),
    });

    expect(result.status).toBe("maturing");
    expect(result.daysSincePublish).toBe(5);
    expect(result.daysUntilReady).toBe(9);
  });

  it("returns a ready comparison with computed deltas once matured, matching by URL pathname", async () => {
    const publishedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    mockedGetEarliestPublishedAt.mockResolvedValue(publishedAt);

    const gsc = fakeGsc([
      { keys: ["https://loja.com/produto-1"], impressions: 100, clicks: 5, ctr: 0.05, position: 12 },
      { keys: ["https://loja.com/produto-2"], impressions: 999, clicks: 999, ctr: 0.99, position: 1 },
    ]);
    const ga4 = fakeGa4([{ pagePath: "/produto-1", sessions: 40, conversionRate: 0.02, revenue: 100 }]);

    const result = await getProductRealImpact({ gsc, ga4, product: fakeProduct("https://loja.com/produto-1") });

    expect(result.status).toBe("ready");
    // Same fake data returned for both the "before" and "after" query — deltas should be zero,
    // and only the /produto-1 row should be picked up, never the unrelated /produto-2 one.
    expect(result.before?.impressions).toBe(100);
    expect(result.after?.impressions).toBe(100);
    expect(result.deltas?.impressionsPct).toBe(0);
    expect(result.deltas?.positionDelta).toBe(0);
  });

  it("treats a 0-before value as a +100% delta instead of dividing by zero", async () => {
    mockedGetEarliestPublishedAt.mockResolvedValue(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

    let call = 0;
    const gsc = {
      queryByPage: vi.fn().mockImplementation(async () => {
        call++;
        // First call = "before" window (no impressions yet), second = "after" (some impressions).
        return call === 1
          ? [{ keys: ["https://loja.com/produto-1"], impressions: 0, clicks: 0, ctr: 0, position: 0 }]
          : [{ keys: ["https://loja.com/produto-1"], impressions: 50, clicks: 2, ctr: 0.04, position: 8 }];
      }),
    } as unknown as GscClient;

    const result = await getProductRealImpact({ gsc, ga4: null, product: fakeProduct("https://loja.com/produto-1") });

    expect(result.deltas?.impressionsPct).toBe(100);
  });
});
