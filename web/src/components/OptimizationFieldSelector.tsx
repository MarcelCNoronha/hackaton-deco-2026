import { useEffect, useState } from "react";
import {
  api,
  ALL_ENRICHMENT_FIELDS,
  type CommunicationTone,
  type DescriptionRichness,
  type EnrichmentField,
  type EstimableField,
  type FieldCostEstimate,
  type ImageGenKind,
  type LevelCostEstimate,
  type OptimizationLevel,
} from "../api/client";
import { formatCost } from "../lib/currency";

interface Props {
  productCount: number;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (selection: {
    fields: EnrichmentField[];
    includeAltText: boolean;
    imageKinds: ImageGenKind[];
    descriptionRichness: DescriptionRichness;
    communicationTone: CommunicationTone;
  }) => Promise<void>;
}

const ALT_TEXT_LABEL_FALLBACK = "Alt-text de imagens";
const IMAGE_GEN_KINDS: Array<{ kind: ImageGenKind; fallbackLabel: string }> = [
  { kind: "lifestyle", fallbackLabel: "Foto ambientada gerada por IA" },
  { kind: "feature_callout", fallbackLabel: "Foto de destaque gerada por IA" },
];

const LEVEL_RICHNESS: Record<OptimizationLevel, DescriptionRichness> = {
  medio: "plain",
  bom: "structured",
  excelente: "structured_with_image",
};
const LEVEL_ORDER: OptimizationLevel[] = ["medio", "bom", "excelente"];
const LEVEL_HINT: Record<OptimizationLevel, string> = {
  medio: "Descrição em texto corrido — todos os campos de texto, sem estrutura HTML nem imagem.",
  bom: "Descrição em HTML estruturado (títulos, seções, tabela de specs) — sem imagem embutida.",
  excelente: "Igual ao Bom + uma foto real do produto embutida, escolhida por visão a partir do destaque do texto.",
};

const TONE_OPTIONS: Array<{ value: CommunicationTone; label: string }> = [
  { value: "auto", label: "Automático" },
  { value: "premium", label: "Premium" },
  { value: "tecnico", label: "Técnico" },
  { value: "casual", label: "Casual" },
];

/** Which of the 4 groups shown in the UI each content field belongs to — purely a display
 *  grouping, doesn't affect what gets sent to the backend (still just EnrichmentField[]). */
const FIELD_GROUPS: Array<{ title: string; fields: EnrichmentField[] }> = [
  { title: "Conteúdo", fields: ["description", "benefit_bullets", "technical_specs"] },
  { title: "Catálogo", fields: ["attributes_patch", "tags"] },
  { title: "SEO & GEO", fields: ["seo_title", "meta_description", "keywords", "faq", "structured_data"] },
  { title: "Conversão", fields: ["cta"] },
];

/** Confirmation step before creating a run: pick a quick level (Médio/Bom/Excelente — same fields,
 *  different description richness/cost, see field-cost-estimates.ts) or fine-tune individual
 *  fields, and see an estimated cost before committing — the LLM call only requests the fields
 *  still checked here (see enrichment-schema.ts). */
export function OptimizationFieldSelector({ productCount, confirmLabel, onCancel, onConfirm }: Props) {
  const [checked, setChecked] = useState<Record<EstimableField, boolean>>(() => {
    // Image generation defaults OFF (unlike the text fields/alt-text) — it has a real, non-trivial
    // per-image cost and isn't something every run needs, so it should be an explicit opt-in, at
    // every level (Médio/Bom/Excelente alike — never bundled into a level package automatically).
    const initial = { alt_text: true, lifestyle: false, feature_callout: false } as Record<EstimableField, boolean>;
    for (const field of ALL_ENRICHMENT_FIELDS) initial[field] = true;
    return initial;
  });
  const [level, setLevel] = useState<OptimizationLevel>("excelente");
  const [tone, setTone] = useState<CommunicationTone>("auto");
  const [estimates, setEstimates] = useState<FieldCostEstimate[] | null>(null);
  const [levelEstimates, setLevelEstimates] = useState<LevelCostEstimate[] | null>(null);
  const [note, setNote] = useState("");
  const [loadingEstimate, setLoadingEstimate] = useState(true);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  // Clicking "Confirmar" used to close this modal and return control to the caller instantly,
  // with the actual API call finishing invisibly in the background — nothing on screen changed
  // until (if) a row elsewhere updated, so a click could look like it did nothing at all. Kept
  // local (not caller state) so it disables/relabels the button the instant it's clicked.
  const [submitting, setSubmitting] = useState(false);

  const descriptionRichness = LEVEL_RICHNESS[level];

  useEffect(() => {
    let cancelled = false;
    setLoadingEstimate(true);
    Promise.all([api.fieldCostEstimates(productCount, descriptionRichness), api.levelCostEstimates(productCount)])
      .then(([fieldRes, levelRes]) => {
        if (cancelled) return;
        setEstimates(fieldRes.estimates);
        setNote(fieldRes.note);
        setLevelEstimates(levelRes.estimates);
        setEstimateError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setEstimateError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingEstimate(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productCount, descriptionRichness]);

  function toggle(field: EstimableField) {
    setChecked((prev) => ({ ...prev, [field]: !prev[field] }));
  }

  const estimateByField = new Map((estimates ?? []).map((e) => [e.field, e]));
  const levelEstimateByLevel = new Map((levelEstimates ?? []).map((e) => [e.level, e]));
  const total = (estimates ?? []).reduce((sum, e) => (checked[e.field] ? sum + e.estimatedCostUsd : sum), 0);
  const canConfirm = ALL_ENRICHMENT_FIELDS.some((field) => checked[field]) || checked.alt_text;

  async function handleConfirm() {
    setSubmitting(true);
    try {
      await onConfirm({
        fields: ALL_ENRICHMENT_FIELDS.filter((field) => checked[field]),
        includeAltText: checked.alt_text,
        imageKinds: IMAGE_GEN_KINDS.map((i) => i.kind).filter((kind) => checked[kind]),
        descriptionRichness,
        communicationTone: tone,
      });
    } finally {
      setSubmitting(false);
    }
  }

  function renderRow(field: EstimableField, fallbackLabel: string) {
    const estimate = estimateByField.get(field);
    return (
      <label key={field} className="field-selector-row">
        <span>
          <input type="checkbox" checked={checked[field]} onChange={() => toggle(field)} />
          {" "}
          {estimate?.label ?? fallbackLabel}
        </span>
        <span className="muted">{loadingEstimate ? "…" : formatCost(estimate?.estimatedCostUsd ?? 0)}</span>
      </label>
    );
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-box card">
        <h2>O que otimizar?</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {productCount === 1 ? "1 produto selecionado" : `${productCount} produtos selecionados`} — escolha o nível
          do anúncio e veja o custo estimado antes de confirmar.
        </p>

        {estimateError && <div className="banner">{estimateError}</div>}

        <p className="muted" style={{ fontSize: "0.78rem", marginTop: "0.9rem", marginBottom: "0.4rem" }}>
          Nível do anúncio
        </p>
        <div className="actions" style={{ justifyContent: "flex-start", flexWrap: "wrap", gap: "0.5rem" }}>
          {LEVEL_ORDER.map((lvl) => {
            const est = levelEstimateByLevel.get(lvl);
            return (
              <button
                key={lvl}
                type="button"
                className={level === lvl ? "" : "secondary"}
                onClick={() => setLevel(lvl)}
                title={LEVEL_HINT[lvl]}
              >
                {est?.label ?? lvl} · {loadingEstimate ? "…" : formatCost(est?.estimatedCostUsd ?? 0)}
              </button>
            );
          })}
        </div>
        <p className="muted" style={{ fontSize: "0.78rem", marginTop: "0.4rem" }}>{LEVEL_HINT[level]}</p>

        <p className="muted" style={{ fontSize: "0.78rem", marginTop: "1rem", marginBottom: "0.4rem" }}>
          Tom de comunicação
        </p>
        <div className="actions" style={{ justifyContent: "flex-start", flexWrap: "wrap", gap: "0.5rem" }}>
          {TONE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={tone === opt.value ? "" : "secondary"}
              onClick={() => setTone(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {FIELD_GROUPS.map((group) => (
          <div key={group.title} style={{ marginTop: "1.1rem" }}>
            <p className="muted" style={{ fontSize: "0.78rem", marginBottom: "0.4rem" }}>{group.title}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              {group.fields.map((field) => renderRow(field, field))}
            </div>
          </div>
        ))}

        <div style={{ marginTop: "1.1rem" }}>
          <p className="muted" style={{ fontSize: "0.78rem", marginBottom: "0.4rem" }}>Imagens</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {renderRow("alt_text", ALT_TEXT_LABEL_FALLBACK)}
          </div>
        </div>

        <p className="muted" style={{ fontSize: "0.78rem", marginTop: "0.9rem", marginBottom: "0.3rem" }}>
          Imagens com IA (opcional, custo por imagem gerada, disponível em qualquer nível)
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          {IMAGE_GEN_KINDS.map(({ kind, fallbackLabel }) => renderRow(kind, fallbackLabel))}
        </div>

        {note && (
          <p className="muted" style={{ fontSize: "0.78rem", marginTop: "0.75rem" }}>
            {note}
          </p>
        )}

        <div className="actions" style={{ marginTop: "1rem", justifyContent: "space-between" }}>
          <strong>Total estimado: {loadingEstimate ? "…" : formatCost(total)}</strong>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" className="secondary" onClick={onCancel} disabled={submitting}>
              Cancelar
            </button>
            <button type="button" onClick={handleConfirm} disabled={!canConfirm || submitting}>
              {submitting ? "Otimizando…" : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
