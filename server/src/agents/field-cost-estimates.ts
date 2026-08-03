import { ALL_ENRICHMENT_FIELDS, type DescriptionRichness, type EnrichmentField } from "../clients/llm-types.js";
import { IMAGE_GENERATION_PRICE_PER_IMAGE, priceForModel } from "../clients/model-recommendations.js";
import { getModelRouting } from "../repositories/model-routing.repo.js";

/** Rough output-token sizes per field, calibrated against the typical response size each field's
 *  prompt instructions ask for (see enrichment-schema.ts) — used only to preview cost BEFORE a run
 *  in the optimization selector. Never used to bill anything: the real, reported cost is always
 *  the actual logged token usage in agent_request_logs. */
const FIELD_OUTPUT_TOKENS: Record<EnrichmentField, number> = {
  description: 220,
  benefit_bullets: 90,
  technical_specs: 130,
  faq: 260,
  structured_data: 120,
  seo_title: 20,
  meta_description: 45,
  keywords: 70,
  tags: 35,
  cta: 20,
  attributes_patch: 90,
};

/** Shared prompt/context tokens (title, currentDescription, attributes, system instructions) paid
 *  once per product regardless of how many fields are requested — trimming fields only saves the
 *  marginal OUTPUT tokens above, never this base, so it's folded into "description" (always sent). */
const CONTENT_BASE_INPUT_TOKENS = 650;

/** Extra output tokens "description" needs once it must be real HTML (headings/sections/table)
 *  instead of flowing text — see DescriptionRichness "structured"/"structured_with_image". */
const STRUCTURED_HTML_EXTRA_OUTPUT_TOKENS = 180;
/** Rough input-token cost of sending one existing product photo for the "structured_with_image"
 *  vision call, and how many candidate photos a typical product has available to choose from —
 *  this is the one real cost jump between "Bom" and "Excelente" (see field-cost-estimates note in
 *  the plan: the other fields are cheap text, the multimodal call is the expensive part). */
const VISION_INPUT_TOKENS_PER_IMAGE = 1100;
const AVG_FEATURED_IMAGE_CANDIDATES = 3;

const ALT_TEXT_INPUT_TOKENS_PER_IMAGE = 300;
const ALT_TEXT_OUTPUT_TOKENS_PER_IMAGE = 40;
/** No per-product image count is known ahead of a run (it depends on the actual catalog data) —
 *  this is a rough catalog-wide average for the cost preview only, never the real per-image cost
 *  actually billed once the run executes. */
const AVG_IMAGES_PER_PRODUCT = 4;

export type ImageGenKind = "lifestyle" | "feature_callout";
export type EstimableField = EnrichmentField | "alt_text" | ImageGenKind;

export interface FieldCostEstimate {
  field: EstimableField;
  label: string;
  estimatedCostUsd: number;
}

const FIELD_LABELS: Record<EstimableField, string> = {
  description: "Descrição",
  benefit_bullets: "Bullets de benefícios",
  technical_specs: "Especificações técnicas",
  faq: "FAQ (GEO)",
  structured_data: "Dados estruturados (schema.org)",
  seo_title: "Título otimizado para SEO",
  meta_description: "Meta description",
  keywords: "Palavras-chave (primárias/secundárias)",
  tags: "Tags de navegação",
  cta: "Chamada à ação (CTA)",
  attributes_patch: "Normalização/preenchimento de atributos",
  alt_text: "Alt-text de imagens",
  lifestyle: "Foto ambientada gerada por IA",
  feature_callout: "Foto de destaque gerada por IA",
};

/** The 3 "níveis de anúncio" (Excelente/Bom/Médio) — differ ONLY in how much structure/vision the
 *  "description" field asks for (see DescriptionRichness); all 3 request every text field, since
 *  those are cheap regardless of level (confirmed: the real cost jump is Bom → Excelente's extra
 *  multimodal image-selection call, not the field count). AI-generated images (lifestyle/
 *  feature_callout) are a separate opt-in, unchecked by default at every level — never bundled
 *  into a package automatically. */
export type OptimizationLevel = "medio" | "bom" | "excelente";

export interface LevelPackage {
  level: OptimizationLevel;
  label: string;
  fields: EnrichmentField[];
  descriptionRichness: DescriptionRichness;
  includeAltText: boolean;
}

export const LEVEL_PACKAGES: Record<OptimizationLevel, LevelPackage> = {
  medio: { level: "medio", label: "Médio", fields: ALL_ENRICHMENT_FIELDS, descriptionRichness: "plain", includeAltText: true },
  bom: { level: "bom", label: "Bom", fields: ALL_ENRICHMENT_FIELDS, descriptionRichness: "structured", includeAltText: true },
  excelente: {
    level: "excelente",
    label: "Excelente",
    fields: ALL_ENRICHMENT_FIELDS,
    descriptionRichness: "structured_with_image",
    includeAltText: true,
  },
};

/** Estimates a per-field cost preview for `productCount` products, using whichever provider/model
 *  is currently routed for contentEnrichment/imageAltText (Connections panel) — so the preview
 *  reflects real pricing, not a fixed number. Shown before confirming a run so the user can pick
 *  which fields are worth the cost. `descriptionRichness` adjusts "description"'s own estimate
 *  (extra output tokens for real HTML, extra input tokens for the vision call). */
export async function estimateFieldCosts(
  productCount: number,
  descriptionRichness: DescriptionRichness = "plain",
): Promise<{
  estimates: FieldCostEstimate[];
  note: string;
}> {
  const routing = await getModelRouting();
  const contentRow = routing.find((r) => r.task === "contentEnrichment")!;
  const imageRow = routing.find((r) => r.task === "imageAltText")!;
  const contentPricing = priceForModel(contentRow.provider, contentRow.model);
  const imagePricing = priceForModel(imageRow.provider, imageRow.model);

  const costFor = (pricing: { input: number; output: number }, inputTokens: number, outputTokens: number) =>
    productCount * ((inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output);

  const descriptionExtraOutput = descriptionRichness === "plain" ? 0 : STRUCTURED_HTML_EXTRA_OUTPUT_TOKENS;
  const descriptionExtraInput =
    descriptionRichness === "structured_with_image" ? VISION_INPUT_TOKENS_PER_IMAGE * AVG_FEATURED_IMAGE_CANDIDATES : 0;

  const estimates: FieldCostEstimate[] = ALL_ENRICHMENT_FIELDS.map((field) => ({
    field,
    label: FIELD_LABELS[field],
    estimatedCostUsd: costFor(
      contentPricing,
      field === "description" ? CONTENT_BASE_INPUT_TOKENS + descriptionExtraInput : 0,
      FIELD_OUTPUT_TOKENS[field] + (field === "description" ? descriptionExtraOutput : 0),
    ),
  }));

  estimates.push({
    field: "alt_text",
    label: FIELD_LABELS.alt_text,
    estimatedCostUsd:
      productCount *
      AVG_IMAGES_PER_PRODUCT *
      ((ALT_TEXT_INPUT_TOKENS_PER_IMAGE / 1_000_000) * imagePricing.input +
        (ALT_TEXT_OUTPUT_TOKENS_PER_IMAGE / 1_000_000) * imagePricing.output),
  });

  // Flat per-image price (not token-based, see IMAGE_GENERATION_PRICE_PER_IMAGE) — one image per
  // product per selected kind, unlike alt-text's per-catalog-image average above.
  for (const kind of ["lifestyle", "feature_callout"] as const) {
    estimates.push({ field: kind, label: FIELD_LABELS[kind], estimatedCostUsd: productCount * IMAGE_GENERATION_PRICE_PER_IMAGE });
  }

  return {
    estimates,
    note:
      "Estimativa aproximada por tentativa — pode haver até 3 tentativas por produto até atingir a nota " +
      `mínima de qualidade (custo real pode ser maior), e o alt-text assume uma média de ${AVG_IMAGES_PER_PRODUCT} ` +
      "imagens por produto. Produtos com uma variação já aprovada muito similar reaproveitam o conteúdo " +
      "(custo real menor). O valor cobrado de fato fica registrado por chamada em Custos.",
  };
}

/** Total estimated cost of one of the 3 named level packages (Médio/Bom/Excelente) for
 *  `productCount` products — every field in the package plus alt-text, summed. Used to show a
 *  single predictable price per level as a quick-pick, before any manual field customization. */
export async function estimateLevelCost(level: OptimizationLevel, productCount: number): Promise<number> {
  const pkg = LEVEL_PACKAGES[level];
  const { estimates } = await estimateFieldCosts(productCount, pkg.descriptionRichness);
  const selected = new Set<EstimableField>(pkg.fields);
  if (pkg.includeAltText) selected.add("alt_text");
  return estimates.filter((e) => selected.has(e.field)).reduce((sum, e) => sum + e.estimatedCostUsd, 0);
}
