import { fetchPageText } from "../clients/web-fetch.client.js";
import { resolveLlmClient } from "../lib/llm-client-resolver.js";

// `type: "object"` at the top level is load-bearing — see reference-structure.agent.ts's
// STRUCTURE_SCHEMA for the real production failure this same omission caused there.
const FACTS_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      description: "Fatos técnicos objetivos sobre o produto (especificações, dimensões, materiais, certificações, garantia).",
      items: {
        type: "object",
        properties: {
          key: { type: "string", description: "Nome do atributo, ex.: 'Material', 'Voltagem', 'Garantia'." },
          value: { type: "string", description: "Valor do atributo, como declarado na página." },
        },
        required: ["key", "value"],
      },
    },
  },
  required: ["facts"],
};

interface FactsResponse {
  facts: Array<{ key: string; value: string }>;
}

const SYSTEM_INSTRUCTION =
  "Você analisa o texto de uma página oficial (extraído de HTML, pode conter ruído de menu/rodapé/cookies — ignore isso) do FABRICANTE de um " +
  "produto e extrai APENAS fatos técnicos objetivos (especificações, dimensões, materiais, certificações, garantia, compatibilidade). NUNCA " +
  "extraia texto de marketing/copy de venda. Se não tiver certeza de um valor, omita-o em vez de adivinhar. Nunca invente um fato que não esteja " +
  "explicitamente no texto.";

export interface ExtractedManufacturerFacts {
  facts: Record<string, string>;
  warning: string | null;
}

/** Fetches a product-specific reference URL (typically the manufacturer's own page for that exact
 *  product) and extracts only objective facts — the opposite emphasis of
 *  reference-structure.agent.ts (structure only, never facts): here we WANT the facts, since the
 *  source is authoritative for this specific product, not a generic market-structure reference.
 *  Used as grounding to reduce hallucinated specs (see enrichment-schema.ts's
 *  especificacoesFabricante payload field). */
export async function extractManufacturerFacts(url: string): Promise<ExtractedManufacturerFacts> {
  const page = await fetchPageText(url);
  const llm = await resolveLlmClient("contentEnrichment");
  const { facts } = await llm.extractStructuredData<FactsResponse>({
    operation: "extractManufacturerFacts",
    systemInstruction: SYSTEM_INSTRUCTION,
    text: page.text,
    schema: FACTS_SCHEMA,
  });
  return {
    facts: Object.fromEntries(facts.map((f) => [f.key, f.value])),
    warning: page.warning,
  };
}
