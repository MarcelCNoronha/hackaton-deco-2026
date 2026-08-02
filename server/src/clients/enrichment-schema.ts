import { ALL_ENRICHMENT_FIELDS, type EnrichmentField } from "./llm-types.js";

interface FieldSpec {
  /** camelCase key as it appears in EnrichedContent / the JSON schema sent to the model. */
  property: string;
  schema: Record<string, unknown>;
  /** Only the 4 "extra" fields need a prompt fragment — description's instructions live in each
   *  client's base system prompt since it's always requested. */
  promptFragment?: string;
}

const FIELD_SPECS: Record<EnrichmentField, FieldSpec> = {
  description: { property: "description", schema: { type: "string" } },
  benefit_bullets: {
    property: "benefitBullets",
    schema: {
      type: "array",
      items: { type: "string" },
      description: "4 a 6 frases curtas de benefício/diferencial, separadas da descrição corrida.",
    },
    promptFragment:
      "'benefitBullets' — 4 a 6 frases curtas e diretas com os principais benefícios/diferenciais, separadas do " +
      "texto corrido da descrição",
  },
  technical_specs: {
    property: "technicalSpecs",
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" }, value: { type: "string" } },
        required: ["label", "value"],
      },
      description:
        "Baseado exclusivamente em 'attributes' e no texto de 'currentDescription' — nunca invente uma " +
        "especificação que não conste em nenhum dos dois.",
    },
    promptFragment:
      "'technicalSpecs' — especificações técnicas em formato rótulo+valor, baseadas exclusivamente nos dados " +
      "fornecidos ('attributes' e o texto em 'currentDescription'), nunca inventando uma especificação que não " +
      "conste em nenhum dos dois",
  },
  faq: {
    property: "faq",
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: { question: { type: "string" }, answer: { type: "string" } },
        required: ["question", "answer"],
      },
    },
    promptFragment:
      "'faq' com 6 a 10 perguntas reais que um comprador pesquisaria (uso, compatibilidade, cuidados, comparação " +
      "com variações do produto), não só as básicas",
  },
  structured_data: {
    property: "structuredData",
    schema: {
      type: "object",
      description:
        "Objeto schema.org/Product válido (@context, @type, name, description, additionalProperty, ...). " +
        "Nunca inclua price, offers ou availability.",
    },
    promptFragment:
      "para 'structuredData', preencha apenas campos descritivos do schema.org/Product (name, description, " +
      "category, additionalProperty a partir de technicalSpecs) — NUNCA inclua price, offers ou availability, " +
      "esses dados são preenchidos separadamente com informação real",
  },
};

/** "description" is always requested — the retry/scoring loop in content-enrichment.agent.ts is
 *  anchored on it — regardless of whether the caller's selection included it. Order follows
 *  ALL_ENRICHMENT_FIELDS so schema/prompt output is deterministic. */
export function resolveRequestedFields(fields?: EnrichmentField[]): EnrichmentField[] {
  const requested = new Set<EnrichmentField>(fields ?? ALL_ENRICHMENT_FIELDS);
  requested.add("description");
  return ALL_ENRICHMENT_FIELDS.filter((field) => requested.has(field));
}

/** Appended to whichever base system/instructions text a client already builds (reuse-adaptation
 *  vs. from-scratch, with/without retry feedback) — empty string when only "description" was
 *  requested, so the prompt doesn't dangle a "Gere também:" with nothing after it. */
export function buildEnrichmentInstructionSuffix(fields: EnrichmentField[]): string {
  const extras = fields.filter((field) => field !== "description");
  if (extras.length === 0) return "";
  const fragments = extras.map((field, i) => `(${i + 1}) ${FIELD_SPECS[field].promptFragment}`);
  return " Gere também: " + fragments.join("; ") + ".";
}

/** Builds the `{properties, required}` pair every provider's schema/tool-input shares (Claude's
 *  `input_schema`, OpenAI's `parameters`, Gemini's `schema` are otherwise byte-identical JSON
 *  Schema objects) — restricted to exactly the requested fields. */
export function buildEnrichmentSchema(fields: EnrichmentField[]): { properties: Record<string, unknown>; required: string[] } {
  const properties: Record<string, unknown> = {};
  for (const field of fields) properties[FIELD_SPECS[field].property] = FIELD_SPECS[field].schema;
  return { properties, required: fields.map((field) => FIELD_SPECS[field].property) };
}
