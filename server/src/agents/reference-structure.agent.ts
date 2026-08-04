import { fetchPageText } from "../clients/web-fetch.client.js";
import { resolveLlmClient } from "../lib/llm-client-resolver.js";

/** Structural signals only — never a fact, never a quote from the source. Feeds
 *  category-reference-links.repo.ts's consensus aggregation, which is what actually reaches the
 *  enrichment prompt (see enrichment-schema.ts's buildContentProfileSuffix). */
export interface StructureSignals {
  wordCount: number;
  bulletCount: number;
  headingCount: number;
  hasFaq: boolean;
  hasSpecTable: boolean;
  hasWarrantySection: boolean;
  mentionsInstallation: boolean;
}

// `type: "object"` at the top level is load-bearing, not decorative — every other schema-
// constrained call in this codebase (enrichProductContent/evaluateContent) includes it; this one
// didn't, and against the currently-routed Gemini provider (which, unlike ClaudeClient's
// extractStructuredData, doesn't add it automatically) that meant the model's output wasn't
// actually locked to these field names at all. Confirmed live: real production rows came back with
// invented fields like has_price/count_technical_specifications instead of wordCount/bulletCount,
// which then silently coerced to 0 via sanitizeSignals below instead of surfacing as a real error.
const STRUCTURE_SCHEMA = {
  type: "object",
  properties: {
    wordCount: { type: "integer", description: "Contagem aproximada de palavras do corpo descritivo do produto (ignore menu/rodapé/cookies)." },
    bulletCount: { type: "integer", description: "Quantos itens de lista (bullets) de benefícios/características aparecem." },
    headingCount: { type: "integer", description: "Quantos títulos/subtítulos de seção o conteúdo descritivo tem." },
    hasFaq: { type: "boolean", description: "Existe uma seção de perguntas frequentes?" },
    hasSpecTable: { type: "boolean", description: "Existe uma tabela ou lista formal de especificações técnicas?" },
    hasWarrantySection: { type: "boolean", description: "O texto menciona garantia explicitamente?" },
    mentionsInstallation: { type: "boolean", description: "O texto explica instalação, montagem ou aplicação do produto?" },
  },
  required: ["wordCount", "bulletCount", "headingCount", "hasFaq", "hasSpecTable", "hasWarrantySection", "mentionsInstallation"],
};

const SYSTEM_INSTRUCTION =
  "Você analisa o texto de uma página de produto de e-commerce (extraído de HTML, pode conter ruído de menu/rodapé/cookies — ignore isso) " +
  "e extrai APENAS sinais estruturais sobre como o conteúdo está organizado. NUNCA reproduza, cite ou parafraseie frases do texto original na " +
  "sua resposta — responda somente com os campos numéricos/booleanos pedidos, nunca com texto livre extraído da página.";

export interface ExtractedReferenceStructure {
  signals: StructureSignals;
  warning: string | null;
}

/** The JSON schema sent to the model is advisory, not enforced by every provider — a field can
 *  come back missing, as a string ("cerca de 500"), or otherwise non-numeric. Coercing here, at the
 *  boundary where untrusted LLM output enters the system, means every StructureSignals this module
 *  ever returns is guaranteed a real finite integer — callers (category-reference-links.repo.ts's
 *  median/consensus math, eventually written to `integer` columns) never have to defend against
 *  NaN themselves. Seen live: an ungrounded field crashed a Postgres write with "invalid input
 *  syntax for type integer: NaN" before this existed. */
function toSafeCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function sanitizeSignals(raw: StructureSignals): StructureSignals {
  return {
    wordCount: toSafeCount(raw.wordCount),
    bulletCount: toSafeCount(raw.bulletCount),
    headingCount: toSafeCount(raw.headingCount),
    hasFaq: Boolean(raw.hasFaq),
    hasSpecTable: Boolean(raw.hasSpecTable),
    hasWarrantySection: Boolean(raw.hasWarrantySection),
    mentionsInstallation: Boolean(raw.mentionsInstallation),
  };
}

/** Fetches a merchant-pasted market-reference URL for a category and extracts only its structural
 *  shape — see StructureSignals. Throws only on a real fetch failure (bad URL, network error, non-
 *  2xx); a "page loaded but had little text" outcome is returned as a warning, not an exception. */
export async function extractReferenceStructure(url: string): Promise<ExtractedReferenceStructure> {
  const page = await fetchPageText(url);
  const llm = await resolveLlmClient("contentEnrichment");
  const signals = await llm.extractStructuredData<StructureSignals>({
    operation: "extractReferenceStructure",
    systemInstruction: SYSTEM_INSTRUCTION,
    text: page.text,
    schema: STRUCTURE_SCHEMA,
  });
  return { signals: sanitizeSignals(signals), warning: page.warning };
}
