import { describe, expect, it } from "vitest";
import {
  computeAttributeCompleteness,
  computeContentScore,
  computeGeoStructureScore,
  computeSeoQueryCoverage,
  readabilityScore,
  structureScore,
} from "./evaluator.agent.js";
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

// geoAnswerableCount is intentionally NOT used for scoring anymore (see computeGeoStructureScore)
// — kept here only because ContentEvaluation still requires the field from evaluateContent's shape.
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

// Written to trip every one of the 11 GEO_TOPIC_PATTERNS at least once, so tests can assert full
// coverage without hardcoding a topicsCovered count that would silently drift if a pattern changes.
const GEO_COMPLETE_TEXT =
  "Serve para revestir paredes internas e é compatível com pisos já existentes. " +
  "Material cerâmico de alta qualidade, nas dimensões de 60x60 cm. " +
  "Não deve ser usado em áreas externas sem proteção adequada. " +
  "Garantia de 5 anos contra defeitos, com troca garantida. " +
  "Em comparação com outras opções do mercado, tem acabamento diferencial superior ao concorrente. " +
  "Indicado para quem busca durabilidade — perfeito para reformas completas. " +
  "A instalação é simples, veja o passo a passo no manual. " +
  "Vale o investimento pelo excelente custo-benefício.";

describe("computeGeoStructureScore", () => {
  it("covers every topic when the text explicitly addresses all 11", () => {
    const { topicsCovered, topicsTotal } = computeGeoStructureScore(GEO_COMPLETE_TEXT, []);
    expect(topicsCovered).toBe(11);
    expect(topicsTotal).toBe(11);
  });

  it("returns 0/11 for empty text and no FAQ", () => {
    const { topicsCovered, topicsTotal } = computeGeoStructureScore(null, []);
    expect(topicsCovered).toBe(0);
    expect(topicsTotal).toBe(11);
  });

  it("credits a topic addressed only in FAQ content, not the main text", () => {
    const withoutFaq = computeGeoStructureScore("Produto de alta qualidade.", []);
    const withFaq = computeGeoStructureScore("Produto de alta qualidade.", [
      { question: "Qual a garantia?", answer: "Garantia de 2 anos contra defeitos de fabricação." },
    ]);
    expect(withFaq.topicsCovered).toBeGreaterThan(withoutFaq.topicsCovered);
  });

  it("ignores accents so 'compatível' matches the same as 'compativel'", () => {
    const accented = computeGeoStructureScore("Este produto é compatível com qualquer instalação elétrica.", []);
    const plain = computeGeoStructureScore("Este produto e compativel com qualquer instalacao eletrica.", []);
    expect(accented.topicsCovered).toBe(plain.topicsCovered);
    expect(accented.topicsCovered).toBeGreaterThan(0);
  });
});

describe("computeSeoQueryCoverage", () => {
  it("returns null (not 0) when there are no real queries to check", () => {
    expect(computeSeoQueryCoverage(null, "qualquer texto")).toBeNull();
    expect(computeSeoQueryCoverage([], "qualquer texto")).toBeNull();
  });

  it("matches a query whose significant words mostly appear, without requiring an exact phrase", () => {
    // "revestimento" and "banheiro" both present, "para" is <3 chars-filtered-out isn't relevant
    // here, but the query as a whole should count as covered.
    const coverage = computeSeoQueryCoverage(["revestimento para banheiro"], "Revestimento cerâmico ideal para banheiros modernos");
    expect(coverage).toBe(100);
  });

  it("does not count a query whose significant words are absent", () => {
    const coverage = computeSeoQueryCoverage(["torneira cromada"], "Piso cerâmico antiderrapante");
    expect(coverage).toBe(0);
  });

  it("computes a partial percentage across multiple queries", () => {
    const coverage = computeSeoQueryCoverage(
      ["piso ceramico", "torneira cromada"],
      "Piso cerâmico de alta resistência",
    );
    expect(coverage).toBe(50);
  });
});

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
  it("averages the 8 sub-scores into overallScore, sourcing GEO from real topic coverage (not AI self-judgment)", async () => {
    const score = await computeContentScore({
      llm: fakeLlm(FULL_EVALUATION),
      text: "<h2>Título</h2><p>" + GEO_COMPLETE_TEXT + "</p><table></table>",
      hasStructuredData: true,
      faqCount: 3,
      seoTitle: "Título SEO",
      originalAttributes: { cor: "branco" },
      attributesPatch: { material: "cerâmica" },
      expectedAttributeKeys: ["cor", "material"],
    });

    // Not hardcoded to 11/11 — derived from the same deterministic function computeContentScore
    // itself calls, so this test tracks real behavior instead of an assumption about the patterns.
    const { topicsCovered, topicsTotal } = computeGeoStructureScore(GEO_COMPLETE_TEXT, []);
    const expectedGeo = Math.round((topicsCovered / topicsTotal) * 100);
    const expectedCompletude = 100; // both expected keys filled
    // No topSearchQueries passed — seoScore should be untouched AI judgment, seoQueryCoverage null.
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

    expect(topicsCovered).toBe(11); // sanity: GEO_COMPLETE_TEXT is written to hit every pattern
    expect(score.overallScore).toBe(manualAverage);
    expect(score.questionsTotal).toBe(11);
    expect(score.attributesExpected).toBe(2);
    expect(score.seoScore).toBe(FULL_EVALUATION.seoScore);
    expect(score.seoQueryCoverage).toBeNull();
  });

  it("blends seoScore with real Search Console query coverage when topSearchQueries is provided", async () => {
    const score = await computeContentScore({
      llm: fakeLlm(FULL_EVALUATION),
      text: "Piso cerâmico antiderrapante para área externa, fácil de instalar.",
      hasStructuredData: false,
      faqCount: 0,
      seoTitle: "Piso cerâmico antiderrapante",
      topSearchQueries: ["piso ceramico antiderrapante", "piso area externa"],
    });

    // Both queries' significant words appear in the seoTitle/text above — full coverage.
    expect(score.seoQueryCoverage).toBe(100);
    expect(score.seoScore).toBe(Math.round(FULL_EVALUATION.seoScore * 0.6 + 100 * 0.4));
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
