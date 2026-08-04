import { describe, expect, it } from "vitest";
import { computeAttributeCompleteness, computeContentScore, readabilityScore, structureScore } from "./evaluator.agent.js";
import type { ContentEvaluation, LlmClient } from "../clients/llm-types.js";

function fakeLlm(evaluation: ContentEvaluation): LlmClient {
  return {
    enrichProductContent: async () => {
      throw new Error("not used in these tests");
    },
    evaluateContent: async () => evaluation,
    generateAltText: async () => "",
    testConnection: async () => ({ ok: true }),
  };
}

const FULL_EVALUATION: ContentEvaluation = {
  buyerConfidence: 80,
  buyerUnanswered: [],
  geoAnswerableCount: 11,
  unsupportedClaims: [],
  seoScore: 90,
  conversionScore: 70,
  dataConsistencyScore: 100,
  catalogIssues: [],
};

describe("structureScore", () => {
  it("scores 0 for empty content", () => {
    expect(structureScore({ text: "", hasStructuredData: false, faqCount: 0, hasSeoFields: false })).toBe(0);
  });

  it("awards every point when all signals are present", () => {
    const text = "<h2>Título</h2><p>" + "Frase longa o suficiente pra passar de 200 caracteres. ".repeat(4) + "</p><table></table>";
    const score = structureScore({ text, hasStructuredData: true, faqCount: 3, hasSeoFields: true });
    expect(score).toBe(100);
  });

  it("does not credit HTML structure from a heading alone without a table/paragraph tag", () => {
    const text = "<h2>Título</h2>" + "x".repeat(250);
    const score = structureScore({ text, hasStructuredData: false, faqCount: 0, hasSeoFields: false });
    // length (20) — no sentence punctuation, no structured data, no faq, no html pair, no seo
    expect(score).toBe(20);
  });
});

describe("readabilityScore", () => {
  it("returns 0 for empty text", () => {
    expect(readabilityScore("")).toBe(0);
    expect(readabilityScore(null)).toBe(0);
  });

  it("strips HTML tags before counting words/sentences", () => {
    const withTags = "<p>Frase simples e direta.</p> <p>Outra frase curta aqui.</p>";
    const withoutTags = "Frase simples e direta. Outra frase curta aqui.";
    expect(readabilityScore(withTags)).toBe(readabilityScore(withoutTags));
  });

  it("penalizes a wall of very long words more than short scannable sentences", () => {
    const scannable = "Piso cerâmico resistente. Fácil de instalar. Ótimo acabamento final.";
    const dense = "Impermeabilização hidrorrepelente característica microporosidade excepcionalíssima.";
    expect(readabilityScore(scannable)).toBeGreaterThan(readabilityScore(dense));
  });
});

describe("computeAttributeCompleteness", () => {
  it("uses the fixed category baseline (expectedKeys) as the denominator when provided", () => {
    const result = computeAttributeCompleteness({ cor: "branco" }, { material: "cerâmica" }, ["cor", "material", "marca"]);
    // cor comes from original, material from patch, marca is missing from both
    expect(result).toEqual({ attributesFilled: 2, attributesExpected: 3 });
  });

  it("falls back to the union of original+patch keys when no expectedKeys baseline exists", () => {
    const result = computeAttributeCompleteness({ cor: "branco" }, { material: "cerâmica" }, null);
    expect(result).toEqual({ attributesFilled: 2, attributesExpected: 2 });
  });

  it("never counts an empty-string or missing value as filled", () => {
    const result = computeAttributeCompleteness({ cor: "" }, {}, ["cor", "material"]);
    expect(result).toEqual({ attributesFilled: 0, attributesExpected: 2 });
  });

  it("lets a patch value override the original for the same key", () => {
    const result = computeAttributeCompleteness({ cor: "branco" }, { cor: "" }, ["cor"]);
    // patch explicitly blanks it out — still counts as not filled, patch wins over original
    expect(result).toEqual({ attributesFilled: 0, attributesExpected: 1 });
  });
});

describe("computeContentScore", () => {
  it("averages the 8 sub-scores into overallScore", async () => {
    const score = await computeContentScore({
      llm: fakeLlm(FULL_EVALUATION),
      text: "<h2>Título</h2><p>" + "Texto de exemplo com tamanho razoável para pontuar bem. ".repeat(5) + "</p><table></table>",
      hasStructuredData: true,
      faqCount: 3,
      seoTitle: "Título SEO",
      originalAttributes: { cor: "branco" },
      attributesPatch: { material: "cerâmica" },
      expectedAttributeKeys: ["cor", "material"],
    });

    const expectedGeo = 100; // 11/11 answerable, GEO_QUESTIONS has 11 entries
    const expectedCompletude = 100; // both expected keys filled
    const manualAverage = Math.round(
      (FULL_EVALUATION.seoScore +
        expectedGeo +
        FULL_EVALUATION.conversionScore +
        score.readabilityScore +
        score.structureScore +
        FULL_EVALUATION.buyerConfidence +
        expectedCompletude +
        FULL_EVALUATION.dataConsistencyScore) /
        8,
    );

    expect(score.overallScore).toBe(manualAverage);
    expect(score.questionsTotal).toBe(11);
    expect(score.attributesExpected).toBe(2);
  });

  it("skips the LLM call when there is no text to judge, scoring every AI sub-score 0", async () => {
    const score = await computeContentScore({
      llm: fakeLlm(FULL_EVALUATION),
      text: null,
      hasStructuredData: false,
      faqCount: 0,
    });

    expect(score.buyerConfidence).toBe(0);
    expect(score.seoScore).toBe(0);
    expect(score.geoAnswerableCount).toBe(0);
    // NOT 0 overall: attributesExpected is also 0 here (no attributes/patch/expectedKeys given
    // at all), and percentOrFull's "nothing expected = 100% complete" rule pulls completude up to
    // 100 — (0+0+0+0+0+0+100+0)/8 rounds to 13, not 0. Documents the quirk rather than hiding it.
    expect(score.overallScore).toBe(13);
  });

  it("scores completude as 0%, not 100%, when there IS an expected baseline but nothing filled", async () => {
    const score = await computeContentScore({
      llm: fakeLlm(FULL_EVALUATION),
      text: null,
      hasStructuredData: false,
      faqCount: 0,
      expectedAttributeKeys: ["cor", "material"],
    });

    expect(score.attributesExpected).toBe(2);
    expect(score.attributesFilled).toBe(0);
  });
});
