import { describe, expect, it } from "vitest";
import { classifyScore, DEFAULT_THRESHOLD_CATEGORY, type CategoryScoreThreshold } from "./client.js";

const DEFAULT_ONLY: CategoryScoreThreshold[] = [{ category: DEFAULT_THRESHOLD_CATEGORY, excellentMin: 85, goodMin: 60 }];

describe("classifyScore", () => {
  it("classifies ouro/prata/bronze against the '*' default when no category override exists", () => {
    expect(classifyScore(DEFAULT_ONLY, "piso", 90)).toBe("ouro");
    expect(classifyScore(DEFAULT_ONLY, "piso", 70)).toBe("prata");
    expect(classifyScore(DEFAULT_ONLY, "piso", 40)).toBe("bronze");
  });

  it("is inclusive at the exact threshold boundary", () => {
    expect(classifyScore(DEFAULT_ONLY, null, 85)).toBe("ouro");
    expect(classifyScore(DEFAULT_ONLY, null, 60)).toBe("prata");
    expect(classifyScore(DEFAULT_ONLY, null, 59)).toBe("bronze");
  });

  it("prefers a category-specific override over the '*' default", () => {
    const thresholds: CategoryScoreThreshold[] = [
      ...DEFAULT_ONLY,
      { category: "piso", excellentMin: 50, goodMin: 30 },
    ];
    // Would be "bronze" under the default (85/60), but "piso" opens the bar down to 50/30.
    expect(classifyScore(thresholds, "piso", 55)).toBe("ouro");
    // A different category with no override still falls back to the default (85/60) — 55 is
    // below even the "prata" bar there, so it's "bronze", not "ouro" like piso got.
    expect(classifyScore(thresholds, "torneira", 55)).toBe("bronze");
  });

  it("falls back to bronze when there isn't even a '*' default configured", () => {
    expect(classifyScore([], "piso", 99)).toBe("bronze");
  });

  it("falls back to the default when the product has no category at all", () => {
    expect(classifyScore(DEFAULT_ONLY, null, 90)).toBe("ouro");
  });
});
