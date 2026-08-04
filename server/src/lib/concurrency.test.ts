import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
  it("never runs more than `limit` calls at once", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return item * 2;
    });

    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("preserves result order regardless of completion order", async () => {
    const items = [30, 10, 20];
    const results = await mapWithConcurrency(items, 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });

    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([30, 10, 20]);
  });

  it("settles every item even when some reject — one failure never blocks the rest", async () => {
    const items = [1, 2, 3, 4];
    const results = await mapWithConcurrency(items, 2, async (item) => {
      if (item === 2) throw new Error("boom");
      return item;
    });

    expect(results).toHaveLength(4);
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  });

  it("handles an empty list without hanging", async () => {
    const results = await mapWithConcurrency([], 5, async () => "unreachable");
    expect(results).toEqual([]);
  });

  it("works when limit exceeds the item count", async () => {
    const results = await mapWithConcurrency([1, 2], 10, async (n) => n + 1);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([2, 3]);
  });
});
