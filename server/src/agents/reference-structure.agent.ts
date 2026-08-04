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

const STRUCTURE_SCHEMA = {
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
  return { signals, warning: page.warning };
}
