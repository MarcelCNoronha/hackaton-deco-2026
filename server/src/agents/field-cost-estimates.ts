import { ALL_ENRICHMENT_FIELDS, type EnrichmentField } from "../clients/llm-types.js";
import { priceForModel } from "../clients/model-recommendations.js";
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
};

/** Shared prompt/context tokens (title, currentDescription, attributes, system instructions) paid
 *  once per product regardless of how many fields are requested — trimming fields only saves the
 *  marginal OUTPUT tokens above, never this base, so it's folded into "description" (always sent). */
const CONTENT_BASE_INPUT_TOKENS = 650;

const ALT_TEXT_INPUT_TOKENS_PER_IMAGE = 300;
const ALT_TEXT_OUTPUT_TOKENS_PER_IMAGE = 40;
/** No per-product image count is known ahead of a run (it depends on the actual catalog data) —
 *  this is a rough catalog-wide average for the cost preview only, never the real per-image cost
 *  actually billed once the run executes. */
const AVG_IMAGES_PER_PRODUCT = 4;

export type EstimableField = EnrichmentField | "alt_text";

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
  alt_text: "Alt-text de imagens",
};

/** Estimates a per-field cost preview for `productCount` products, using whichever provider/model
 *  is currently routed for contentEnrichment/imageAltText (Connections panel) — so the preview
 *  reflects real pricing, not a fixed number. Shown before confirming a run so the user can pick
 *  which fields are worth the cost. */
export async function estimateFieldCosts(productCount: number): Promise<{
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

  const estimates: FieldCostEstimate[] = ALL_ENRICHMENT_FIELDS.map((field) => ({
    field,
    label: FIELD_LABELS[field],
    estimatedCostUsd: costFor(
      contentPricing,
      field === "description" ? CONTENT_BASE_INPUT_TOKENS : 0,
      FIELD_OUTPUT_TOKENS[field],
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

  return {
    estimates,
    note:
      "Estimativa aproximada por tentativa — pode haver até 3 tentativas por produto até atingir a nota " +
      `mínima de qualidade (custo real pode ser maior), e o alt-text assume uma média de ${AVG_IMAGES_PER_PRODUCT} ` +
      "imagens por produto. Produtos com uma variação já aprovada muito similar reaproveitam o conteúdo " +
      "(custo real menor). O valor cobrado de fato fica registrado por chamada em Custos.",
  };
}
