import { describe, expect, it } from "vitest";
import { truncateAtWordBoundary } from "./content-enrichment.agent.js";

describe("truncateAtWordBoundary", () => {
  it("returns the text untouched when it already fits", () => {
    expect(truncateAtWordBoundary("Torneira Deca Twin", 60)).toBe("Torneira Deca Twin");
  });

  it("cuts at the last whole word instead of mid-word", () => {
    const text = "Torneira Monocomando com Filtro para Cozinha Deca Twin Click Cromado";
    const result = truncateAtWordBoundary(text, 40);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toBe("Torneira Monocomando com Filtro para…");
    // Every word up to the cut is whole — "Cozinha" (the word that got cut) never appears
    // truncated to something like "Cozin…".
    expect(text).toContain(result.replace("…", "").trim());
  });

  it("falls back to a hard cut when there's no space to break on at all", () => {
    const result = truncateAtWordBoundary("Supercalifragilisticexpialidocious", 10);
    expect(result).toBe("Supercali…");
    expect(result.length).toBe(10);
  });
});
