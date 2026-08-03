import { useEffect, useState } from "react";
import {
  api,
  ALL_ENRICHMENT_FIELDS,
  type EnrichmentField,
  type EstimableField,
  type FieldCostEstimate,
  type ImageGenKind,
} from "../api/client";
import { formatCost } from "../lib/currency";

interface Props {
  productCount: number;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (selection: { fields: EnrichmentField[]; includeAltText: boolean; imageKinds: ImageGenKind[] }) => void;
}

const ALT_TEXT_LABEL_FALLBACK = "Alt-text de imagens";
const IMAGE_GEN_KINDS: Array<{ kind: ImageGenKind; fallbackLabel: string }> = [
  { kind: "lifestyle", fallbackLabel: "Foto ambientada gerada por IA" },
  { kind: "feature_callout", fallbackLabel: "Foto de destaque gerada por IA" },
];

/** Confirmation step before creating a run: pick which fields to generate and see an estimated
 *  cost per field (fetched from whichever provider/model is actually routed) before committing —
 *  the LLM call itself only requests the fields still checked here (see enrichment-schema.ts). */
export function OptimizationFieldSelector({ productCount, confirmLabel, onCancel, onConfirm }: Props) {
  const [checked, setChecked] = useState<Record<EstimableField, boolean>>(() => {
    // Image generation defaults OFF (unlike the text fields/alt-text) — it has a real, non-trivial
    // per-image cost and isn't something every run needs, so it should be an explicit opt-in.
    const initial = { alt_text: true, lifestyle: false, feature_callout: false } as Record<EstimableField, boolean>;
    for (const field of ALL_ENRICHMENT_FIELDS) initial[field] = true;
    return initial;
  });
  const [estimates, setEstimates] = useState<FieldCostEstimate[] | null>(null);
  const [note, setNote] = useState("");
  const [loadingEstimate, setLoadingEstimate] = useState(true);
  const [estimateError, setEstimateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingEstimate(true);
    api
      .fieldCostEstimates(productCount)
      .then((res) => {
        if (cancelled) return;
        setEstimates(res.estimates);
        setNote(res.note);
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
  }, [productCount]);

  function toggle(field: EstimableField) {
    setChecked((prev) => ({ ...prev, [field]: !prev[field] }));
  }

  const estimateByField = new Map((estimates ?? []).map((e) => [e.field, e]));
  const total = (estimates ?? []).reduce((sum, e) => (checked[e.field] ? sum + e.estimatedCostUsd : sum), 0);
  const canConfirm = ALL_ENRICHMENT_FIELDS.some((field) => checked[field]) || checked.alt_text;

  function handleConfirm() {
    onConfirm({
      fields: ALL_ENRICHMENT_FIELDS.filter((field) => checked[field]),
      includeAltText: checked.alt_text,
      imageKinds: IMAGE_GEN_KINDS.map((i) => i.kind).filter((kind) => checked[kind]),
    });
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
          {productCount === 1 ? "1 produto selecionado" : `${productCount} produtos selecionados`} — escolha quais
          campos gerar e veja o custo estimado antes de confirmar.
        </p>

        {estimateError && <div className="banner">{estimateError}</div>}

        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginTop: "0.75rem" }}>
          {ALL_ENRICHMENT_FIELDS.map((field) => renderRow(field, field))}
          {renderRow("alt_text", ALT_TEXT_LABEL_FALLBACK)}
        </div>

        <p className="muted" style={{ fontSize: "0.78rem", marginTop: "0.9rem", marginBottom: "0.3rem" }}>
          Imagens com IA (opcional, custo por imagem gerada)
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
            <button type="button" className="secondary" onClick={onCancel}>
              Cancelar
            </button>
            <button type="button" onClick={handleConfirm} disabled={!canConfirm}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
