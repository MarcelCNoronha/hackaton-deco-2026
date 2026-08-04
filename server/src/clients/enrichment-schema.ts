import { ALL_ENRICHMENT_FIELDS, type DescriptionRichness, type EnrichmentField } from "./llm-types.js";

interface FieldSpec {
  /** camelCase key as it appears in EnrichedContent / the JSON schema sent to the model. */
  property: string;
  schema: Record<string, unknown>;
  /** Only the "extra" fields need a prompt fragment — description's instructions live in each
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
  seo_title: {
    property: "seoTitle",
    schema: {
      type: "string",
      description:
        "Título otimizado para SEO: corrige ortografia/caixa-alta indevida, remove ruído, inclui a palavra-chave " +
        "principal — continua sendo o mesmo produto, nunca inventa modelo/marca diferente.",
    },
    promptFragment:
      "'seoTitle' — título otimizado para SEO a partir do título atual (correção ortográfica/padronização, " +
      "palavra-chave principal no início, sem caixa-alta abusiva), sem mudar de que produto se trata",
  },
  meta_description: {
    property: "metaDescription",
    schema: {
      type: "string",
      description: "Meta description de ~150-160 caracteres, resumindo o principal benefício + uma chamada à ação.",
    },
    promptFragment: "'metaDescription' — meta description de 150 a 160 caracteres, com o principal benefício e uma chamada à ação",
  },
  keywords: {
    property: "keywords",
    schema: {
      type: "object",
      properties: {
        primary: { type: "array", items: { type: "string" }, description: "3 a 5 termos de busca principais." },
        secondary: { type: "array", items: { type: "string" }, description: "5 a 10 termos secundários/long-tail." },
      },
      required: ["primary", "secondary"],
    },
    promptFragment:
      "'keywords' com 'primary' (3 a 5 termos de busca principais) e 'secondary' (5 a 10 termos secundários/long-tail), " +
      "baseados no que o produto realmente é",
  },
  tags: {
    property: "tags",
    schema: {
      type: "array",
      items: { type: "string" },
      description: "5 a 10 tags curtas pra navegação/filtro do catálogo (não confundir com keywords de busca).",
    },
    promptFragment: "'tags' — 5 a 10 tags curtas de navegação/filtro do catálogo",
  },
  cta: {
    property: "cta",
    schema: {
      type: "string",
      description: "Uma frase curta de chamada à ação, específica pro produto (não genérica tipo \"compre agora\").",
    },
    promptFragment: "'cta' — uma frase curta de chamada à ação específica pro produto, não genérica",
  },
  attributes_patch: {
    property: "attributesPatch",
    schema: {
      type: "object",
      description:
        "Apenas chaves de 'attributes' que precisam de correção/normalização, ou chaves claramente ausentes que dá " +
        "pra inferir com segurança do texto/attributes existentes — nunca remove uma chave existente, nunca inventa " +
        "um valor sem base nos dados fornecidos.",
    },
    promptFragment:
      "'attributesPatch' — objeto só com atributos a corrigir/normalizar ou preencher (nunca remover, nunca inventar " +
      "sem base no que já foi fornecido)",
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

/** `suggestedCategory` is always offered as an optional output regardless of field selection — it's
 *  advisory-only (never auto-published, never becomes a proposal row, see publisher.agent.ts), just
 *  shown as a hint in RunDetail, so it doesn't need a checkbox/EnrichmentField of its own. */
const SUGGESTED_CATEGORY_PROPERTY = {
  suggestedCategory: {
    type: "string",
    description:
      "Só preencha se a categoria atual do produto parecer errada ou ausente — sugestão de categoria mais " +
      "adequada. Omita se a categoria atual já estiver correta.",
  },
};

/** Builds the `{properties, required}` pair every provider's schema/tool-input shares (Claude's
 *  `input_schema`, OpenAI's `parameters`, Gemini's `schema` are otherwise byte-identical JSON
 *  Schema objects) — restricted to exactly the requested fields, plus the always-available
 *  `suggestedCategory` and (when `richness` embeds an image) `featuredImageUrl`/`imageCaption`. */
export function buildEnrichmentSchema(
  fields: EnrichmentField[],
  richness: DescriptionRichness = "plain",
): { properties: Record<string, unknown>; required: string[] } {
  const properties: Record<string, unknown> = { ...SUGGESTED_CATEGORY_PROPERTY };
  for (const field of fields) properties[FIELD_SPECS[field].property] = FIELD_SPECS[field].schema;
  if (richness === "structured_with_image") {
    properties.featuredImageUrl = {
      type: "string",
      description:
        "A URL EXATA de uma das fotos fornecidas (nunca invente uma URL) que melhor ilustra o ponto de destaque " +
        "do produto — omita se nenhuma foto fornecida servir bem.",
    };
    properties.imageCaption = {
      type: "string",
      description: "Legenda curta descrevendo o ponto de destaque ilustrado por 'featuredImageUrl'.",
    };
  }
  // suggestedCategory/featuredImageUrl/imageCaption are intentionally NOT in `required` — they're
  // optional-when-applicable, unlike the requested content fields which the model must always fill.
  return { properties, required: fields.map((field) => FIELD_SPECS[field].property) };
}

/** Appended only when the caller consulted the platform's already-registered parameter slots
 *  (Shopify Category/Product metafields) before generating — steers `attributesPatch` to reuse
 *  those exact keys instead of inventing arbitrary labels, so the value can publish straight into
 *  a real platform field. Empty string when there's nothing to align to (VTEX, or no fields). */
export function buildKnownAttributeFieldsSuffix(fields?: Array<{ key: string; name: string }>): string {
  if (!fields || fields.length === 0) return "";
  const list = fields.map((f) => `${f.key} (${f.name})`).join(", ");
  return (
    ` Este produto tem os seguintes parâmetros já cadastrados na plataforma, disponíveis pra preenchimento: ` +
    `${list}. Sempre que 'attributesPatch' tiver uma informação real e atualizada pra um desses parâmetros ` +
    `(baseada em 'attributes'/'currentDescription', nunca inventada), use EXATAMENTE a chave indicada acima ` +
    `(antes do parênteses) em vez de um rótulo livre.`
  );
}

/** Appended only when Search Console is connected AND has real query data for this product's
 *  page — grounds seo_title/keywords/description in what buyers actually search for, instead of
 *  the model inventing plausible-sounding terms. Never told to invent a query — only to prefer
 *  covering these when a claim about the product genuinely supports it. */
export function buildTopSearchQueriesSuffix(queries?: string[]): string {
  if (!queries || queries.length === 0) return "";
  return (
    ` Estas são buscas reais que já trazem gente pra esta página no Google: ${queries.join(", ")}. ` +
    `Sempre que fizer sentido pro produto de verdade, priorize cobrir esses termos (naturalmente, nunca ` +
    `forçado) em 'seoTitle'/'keywords'/'description' — são termos reais de comprador, não invente outros ` +
    `no lugar deles.`
  );
}

/** Appended only when the active category has synced spec-field definitions from the catalog
 *  platform (VTEX's specification module — see vtex.client.ts's getCategoryFieldDefinitions).
 *  Constrains 'attributesPatch'/'technicalSpecs' to fields the platform actually accepts for this
 *  category, so generation never proposes an attribute the store has no way to save — deliberately
 *  never mentions price/stock/category, since those aren't part of this "specification" concept at
 *  all (separate VTEX APIs entirely, see category_spec_fields' schema doc comment). */
export function buildCategoryFieldsSuffix(fields?: Array<{ name: string }>): string {
  if (!fields || fields.length === 0) return "";
  const list = fields.map((f) => f.name).join(", ");
  return (
    ` Os campos de especificação que esta categoria aceita na plataforma são: ${list}. Ao preencher ` +
    `'attributesPatch'/'technicalSpecs', use só esses rótulos (ou o mais próximo semanticamente) — nunca invente ` +
    `um atributo fora dessa lista.`
  );
}

/** Appended only when the active category has a resolved structural profile (see
 *  category-content-profile.repo.ts's resolveCategoryContentProfile — manual override, market-
 *  reference consensus, or derived from the store's own best-scoring products, in that priority
 *  order). A STRUCTURAL target only: word-count range, bullet count, presence of FAQ/spec-table/
 *  warranty section — never content itself, so this can't leak a competitor's copy into a
 *  generation. Missing individual fields (e.g. bulletCount unset) are simply omitted from the
 *  sentence instead of forcing a guess. */
export function buildContentProfileSuffix(profile?: {
  wordCountMin: number | null;
  wordCountMax: number | null;
  bulletCount: number | null;
  hasFaq: boolean | null;
  hasSpecTable: boolean | null;
  hasWarrantySection: boolean | null;
} | null): string {
  if (!profile) return "";
  const parts: string[] = [];
  if (profile.wordCountMin != null && profile.wordCountMax != null) {
    parts.push(`entre ${profile.wordCountMin} e ${profile.wordCountMax} palavras na descrição`);
  }
  if (profile.bulletCount != null) parts.push(`cerca de ${profile.bulletCount} bullets de benefício`);
  if (profile.hasFaq) parts.push("uma seção de FAQ");
  if (profile.hasSpecTable) parts.push("uma tabela de especificações técnicas");
  if (profile.hasWarrantySection) parts.push("uma menção explícita à garantia");
  if (parts.length === 0) return "";
  return (
    ` Anúncios de referência de qualidade para esta categoria costumam ter: ${parts.join("; ")}. Use isso como ` +
    `alvo estrutural quando o campo correspondente for gerado, mas nunca invente conteúdo só para atingir esses ` +
    `números — se os dados do produto não sustentarem, prefira ficar mais curto/simples do que inventar.`
  );
}

/** Extra instruction appended when "description" should be more than flowing text — see
 *  `DescriptionRichness`. Returns "" for "plain" so existing prompts are byte-identical to before. */
export function buildDescriptionRichnessSuffix(richness: DescriptionRichness): string {
  // "description" is ALWAYS plain narrative paragraphs — how it (and benefit_bullets/
  // technical_specs/faq/cta around it) actually turns into HTML is entirely the PDP template's
  // job (see pdp-templates.repo.ts / publisher.agent.ts's renderPdpHtml), never the model's. This
  // keeps every draft's structure 100% predictable and lets a merchant reorder/restyle blocks
  // without touching the prompt at all. "plain"/"structured" are therefore identical here — the
  // only richness that changes what's asked of the model is "structured_with_image".
  if (richness !== "structured_with_image") return "";
  return (
    " Identifique o principal ponto de destaque do produto usando SOMENTE o texto/atributos já existentes " +
    "(nunca invente um diferencial não mencionado), e escolha entre as fotos fornecidas a que melhor ilustra " +
    "esse ponto: preencha 'featuredImageUrl' com a URL EXATA de uma delas (nunca invente uma URL) e " +
    "'imageCaption' com uma legenda curta desse destaque — a própria página, não você, decide onde essa " +
    "imagem entra na estrutura final."
  );
}
