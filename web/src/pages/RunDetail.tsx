import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useParams } from "react-router";
import {
  api,
  ApiError,
  classifyScore,
  type CatalogImage,
  type CatalogPlatform,
  type CategoryScoreThreshold,
  type ContentScore,
  type EnrichmentProposal,
  type EnrichmentRun,
  type GeneratedImage,
  type GeneratedVideo,
  type ImpactSummary,
  type PhotoClassification,
  type Product,
  type ProductImage,
  type ReferenceImageCrop,
  type RunCosts,
} from "../api/client";

type GeneratableImageKind = "principal" | "lifestyle" | "dimensional" | "feature_callout";

/** Derives a catalog image's current classification from its VTEX Label — the select for these
 *  images has no local classification field to read directly the way a generatedImages row does,
 *  only the Label string the platform itself returns. */
function classificationFromLabel(label: string | null): PhotoClassification | "" {
  if (label === "1") return "principal";
  if (label === "2") return "ambientada";
  if (label === "3") return "dimensional";
  if (label && /^\d+$/.test(label) && Number(label) >= 4) return "destaque";
  return "";
}

const PHOTO_CLASSIFICATION_LABELS: Record<PhotoClassification, string> = {
  principal: "Foto principal (1)",
  ambientada: "Foto ambientada (2)",
  dimensional: "Foto dimensional (3)",
  destaque: "Foto de destaque (4+)",
};
import { StatTile } from "../components/StatTile";
import { StatusBadge } from "../components/StatusBadge";
import { ScoreCompare } from "../components/ScoreCompare";
import { ImpactSummaryBanner } from "../components/ImpactSummaryBanner";
import { formatCost } from "../lib/currency";

function isGeneratableImageKind(kind: GeneratedImage["kind"]): kind is GeneratableImageKind {
  return kind === "principal" || kind === "lifestyle" || kind === "dimensional" || kind === "feature_callout";
}

function imageGenerationNoteFromRun(run: EnrichmentRun | null): string {
  const note = run?.scope.imageGenerationNote;
  return typeof note === "string" ? note : "";
}

const IMAGE_NOTE_TEXTAREA_STYLE = {
  width: "100%",
  resize: "vertical",
  padding: "0.55rem 0.7rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--page-plane)",
  color: "inherit",
  fontFamily: "inherit",
  fontSize: "0.78rem",
} as const;

const PRINCIPAL_IMAGE_PATTERN = /principal|main|hero/i;

function orderedReferenceImages(product: Product | undefined): ProductImage[] {
  return [...(product?.images ?? [])]
    .filter((img) => Boolean(img.ImageUrl))
    .sort((a, b) => {
      const aText = `${a.ImageText ?? ""} ${a.ImageUrl}`;
      const bText = `${b.ImageText ?? ""} ${b.ImageUrl}`;
      const aPrincipal = PRINCIPAL_IMAGE_PATTERN.test(aText);
      const bPrincipal = PRINCIPAL_IMAGE_PATTERN.test(bText);
      return Number(bPrincipal) - Number(aPrincipal);
    });
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function selectionFromPoints(
  imageUrl: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
): ReferenceImageCrop {
  const minSize = 0.02;
  let x = Math.min(start.x, end.x);
  let y = Math.min(start.y, end.y);
  let width = Math.abs(end.x - start.x);
  let height = Math.abs(end.y - start.y);

  if (width < minSize) {
    x = clamp01((start.x + end.x) / 2 - minSize / 2);
    width = minSize;
  }
  if (height < minSize) {
    y = clamp01((start.y + end.y) / 2 - minSize / 2);
    height = minSize;
  }
  if (x + width > 1) x = 1 - width;
  if (y + height > 1) y = 1 - height;

  return { imageUrl, x: clamp01(x), y: clamp01(y), width: clamp01(width), height: clamp01(height) };
}

function cropPointFromPointer(event: PointerEvent<HTMLDivElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: clamp01((event.clientX - rect.left) / rect.width),
    y: clamp01((event.clientY - rect.top) / rect.height),
  };
}

/** Lets the operator pick which of a product's real photos an image generation should use as its
 *  base reference, and — only when `allowCrop` (the "foto de destaque" kind) — drag out a crop
 *  rectangle on that photo to pin the exact detail the generation must focus on. Fully controlled:
 *  switching the base image is the caller's job to pair with clearing any crop, since a crop rect
 *  only makes sense against the image it was drawn on. */
function PhotoReferencePicker({
  images,
  baseImageUrl,
  onBaseImageChange,
  crop,
  onCropChange,
  allowCrop,
}: {
  images: ProductImage[];
  baseImageUrl: string;
  onBaseImageChange: (url: string) => void;
  crop?: ReferenceImageCrop;
  onCropChange?: (crop: ReferenceImageCrop | undefined) => void;
  allowCrop: boolean;
}) {
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  // A photo just uploaded to the platform (e.g. a generated image published minutes ago) can 404
  // for a bit while the CDN finishes replicating it — tracked per-URL so switching back to an
  // already-loaded photo doesn't show a stale broken state, and so retrying doesn't require
  // reopening the modal.
  const [brokenUrls, setBrokenUrls] = useState<Record<string, boolean>>({});

  if (images.length === 0 || !baseImageUrl) return null;

  const isBroken = brokenUrls[baseImageUrl] === true;

  const activeCrop = allowCrop && crop?.imageUrl === baseImageUrl ? crop : undefined;

  function startSelection(event: PointerEvent<HTMLDivElement>) {
    if (!allowCrop || !onCropChange) return;
    event.preventDefault();
    const point = cropPointFromPointer(event);
    setDragStart(point);
    event.currentTarget.setPointerCapture(event.pointerId);
    onCropChange(selectionFromPoints(baseImageUrl, point, point));
  }

  function updateSelection(event: PointerEvent<HTMLDivElement>) {
    if (!allowCrop || !onCropChange || !dragStart) return;
    event.preventDefault();
    onCropChange(selectionFromPoints(baseImageUrl, dragStart, cropPointFromPointer(event)));
  }

  function finishSelection(event: PointerEvent<HTMLDivElement>) {
    if (!allowCrop || !onCropChange || !dragStart) return;
    event.preventDefault();
    onCropChange(selectionFromPoints(baseImageUrl, dragStart, cropPointFromPointer(event)));
    setDragStart(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap", alignItems: "flex-start" }}>
      <div style={{ width: "min(100%, 320px)" }}>
        <div className="muted" style={{ fontSize: "0.78rem", marginBottom: "0.35rem" }}>
          {allowCrop ? "Recorte para foto de destaque" : "Foto base"}
        </div>
        <div
          onPointerDown={startSelection}
          onPointerMove={updateSelection}
          onPointerUp={finishSelection}
          onPointerCancel={finishSelection}
          style={{
            position: "relative",
            width: "100%",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            overflow: "hidden",
            background: "var(--page-plane)",
            cursor: allowCrop ? "crosshair" : "default",
            touchAction: "none",
          }}
          title={allowCrop ? "Arraste para marcar o detalhe que deve orientar a foto de destaque." : undefined}
        >
          {isBroken ? (
            <div className="muted" style={{ padding: "1.5rem 1rem", fontSize: "0.78rem", textAlign: "center" }}>
              ⚠ Não foi possível carregar esta foto agora — se ela acabou de ser publicada, a
              plataforma pode ainda estar processando. Aguarde alguns instantes e tente de novo.
              <div style={{ marginTop: "0.5rem" }}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setBrokenUrls((prev) => ({ ...prev, [baseImageUrl]: false }))}
                >
                  Tentar novamente
                </button>
              </div>
            </div>
          ) : (
            <img
              src={baseImageUrl}
              alt="Referencia do produto"
              draggable={false}
              style={{ width: "100%", display: "block", userSelect: "none" }}
              onError={() => setBrokenUrls((prev) => ({ ...prev, [baseImageUrl]: true }))}
            />
          )}
          {!isBroken && activeCrop && (
            <div
              style={{
                position: "absolute",
                left: `${activeCrop.x * 100}%`,
                top: `${activeCrop.y * 100}%`,
                width: `${activeCrop.width * 100}%`,
                height: `${activeCrop.height * 100}%`,
                border: "2px solid var(--accent)",
                background: "rgba(255, 255, 255, 0.16)",
                boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.32)",
                pointerEvents: "none",
              }}
            />
          )}
        </div>
      </div>
      <div style={{ minWidth: 220, flex: "1 1 220px" }}>
        {images.length > 1 && (
          <label style={{ display: "block", marginBottom: "0.6rem" }}>
            <span className="muted" style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.25rem" }}>
              Foto de referencia
            </span>
            <select value={baseImageUrl} onChange={(event) => onBaseImageChange(event.target.value)} style={{ width: "100%" }}>
              {images.map((img, index) => (
                <option key={`${img.Id ?? img.ImageUrl}-${index}`} value={img.ImageUrl}>
                  {img.ImageText || `Foto ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
        )}
        {allowCrop && (
          <div style={{ display: "flex", gap: "0.45rem", alignItems: "center", flexWrap: "wrap" }}>
            <span className="pill">{activeCrop ? "Recorte selecionado" : "Sem recorte"}</span>
            {activeCrop && (
              <button type="button" className="link-button" onClick={() => onCropChange?.(undefined)}>
                Limpar recorte
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const IMAGE_KIND_LABELS: Record<GeneratableImageKind, string> = {
  principal: "Gerar foto principal",
  lifestyle: "Gerar foto ambientada",
  dimensional: "Gerar foto dimensional",
  feature_callout: "Gerar foto de destaque",
};

type ImageModalTarget = {
  productId: number;
  kind: GeneratableImageKind;
  /** Present when opened from "Refazer" on an existing generation — locks the kind and requires
   *  an instruction, since a blind retry with no guidance would likely reproduce the same result. */
  retryImage?: GeneratedImage;
};

function ImageGenerationModal({
  target,
  images,
  submitting,
  error,
  onCancel,
  onSubmit,
  runNote,
  savedRunNote,
  runNoteSaving,
  runNoteError,
  onRunNoteChange,
  onSaveRunNote,
}: {
  target: ImageModalTarget;
  images: ProductImage[];
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (baseImageUrl: string, crop: ReferenceImageCrop | undefined, note: string) => void;
  runNote: string;
  savedRunNote: string;
  runNoteSaving: boolean;
  runNoteError: string | null;
  onRunNoteChange: (value: string) => void;
  onSaveRunNote: () => void;
}) {
  const allowCrop = target.kind === "feature_callout";
  const requireNote = Boolean(target.retryImage);
  const [baseImageUrl, setBaseImageUrl] = useState(images[0]?.ImageUrl ?? "");
  const [crop, setCrop] = useState<ReferenceImageCrop | undefined>(undefined);
  const [note, setNote] = useState("");

  useEffect(() => {
    setBaseImageUrl(images[0]?.ImageUrl ?? "");
    setCrop(undefined);
    setNote("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.productId, target.kind, target.retryImage?.id]);

  const noteTrimmed = note.trim();
  const canSubmit = Boolean(baseImageUrl) && (!requireNote || Boolean(noteTrimmed));

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={submitting ? undefined : onCancel}>
      <div className="modal-box card" style={{ maxWidth: 640 }} onClick={(event) => event.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>
          {IMAGE_KIND_LABELS[target.kind]}
          {target.retryImage ? " — Refazer" : ""}
        </h2>
        {images.length === 0 ? (
          <p className="muted">Este produto não tem fotos cadastradas para usar como referência.</p>
        ) : (
          <>
            <PhotoReferencePicker
              images={images}
              baseImageUrl={baseImageUrl}
              onBaseImageChange={(url) => {
                setBaseImageUrl(url);
                setCrop(undefined);
              }}
              crop={crop}
              onCropChange={setCrop}
              allowCrop={allowCrop}
            />
            <label style={{ display: "block", margin: "0.9rem 0 0" }}>
              <span className="muted" style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.3rem" }}>
                Instruções{requireNote ? "" : " (opcional)"}
              </span>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={500}
                rows={3}
                placeholder="Ex.: manter exatamente 2 hastes; não inserir itens decorativos perto do produto"
                style={IMAGE_NOTE_TEXTAREA_STYLE}
              />
            </label>
            <details style={{ marginTop: "0.9rem", paddingTop: "0.75rem", borderTop: "1px solid var(--border)" }} open={Boolean(savedRunNote.trim())}>
              <summary className="muted" style={{ fontSize: "0.78rem", cursor: "pointer" }}>
                Orientação para imagens desta otimização{savedRunNote.trim() ? "" : " (opcional)"}
              </summary>
              <div style={{ marginTop: "0.5rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.6rem" }}>
                  <span className="muted" style={{ display: "block", fontSize: "0.72rem" }}>
                    Vale para novas imagens e refações desta otimização inteira, além da instrução acima —
                    somada à regra da categoria.
                  </span>
                  <button
                    type="button"
                    className="link-button"
                    style={{ fontSize: "0.75rem", whiteSpace: "nowrap" }}
                    onClick={onSaveRunNote}
                    disabled={runNoteSaving || runNote.trim() === savedRunNote}
                  >
                    {runNoteSaving ? "Salvando…" : "Salvar orientação"}
                  </button>
                </div>
                <textarea
                  value={runNote}
                  onChange={(event) => onRunNoteChange(event.target.value)}
                  maxLength={500}
                  rows={2}
                  placeholder="Ex.: manter exatamente 2 hastes; não adicionar suporte extra; usar ambiente claro"
                  style={{ ...IMAGE_NOTE_TEXTAREA_STYLE, marginTop: "0.4rem" }}
                />
                {runNoteError && (
                  <div className="banner" style={{ marginTop: "0.5rem" }}>
                    {runNoteError}
                  </div>
                )}
              </div>
            </details>
          </>
        )}
        {error && (
          <div className="banner" style={{ marginTop: "0.75rem" }}>
            {error}
          </div>
        )}
        <div className="actions" style={{ marginTop: "1rem", justifyContent: "flex-end" }}>
          <button type="button" className="secondary" onClick={onCancel} disabled={submitting}>
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => onSubmit(baseImageUrl, allowCrop ? crop : undefined, noteTrimmed)}
            disabled={submitting || !canSubmit}
          >
            {submitting ? "Gerando…" : "Gerar imagem"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Mirrors ImageGenerationModal, simplified: no crop (Veo takes one whole reference photo, not a
 *  detail region), no run-wide note (video is a one-off ask per product, not a repeated action
 *  across a whole run's worth of generations the way image kinds are). */
function VideoGenerationModal({
  productId,
  images,
  submitting,
  error,
  onCancel,
  onSubmit,
}: {
  productId: number;
  images: ProductImage[];
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (baseImageUrl: string, note: string) => void;
}) {
  const [baseImageUrl, setBaseImageUrl] = useState(images[0]?.ImageUrl ?? "");
  const [note, setNote] = useState("");

  useEffect(() => {
    setBaseImageUrl(images[0]?.ImageUrl ?? "");
    setNote("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  // Mirrors video-generation.agent.ts's selectSourceImageUrls: the chosen base photo goes first,
  // filled out with up to MAX_REFERENCE_IMAGES(3) total from the product's other real photos — the
  // extra ones aren't picked here, just counted, so the operator knows more than the base photo
  // will actually be sent to Veo.
  const additionalReferenceCount = Math.min(Math.max(images.length - 1, 0), 2);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={submitting ? undefined : onCancel}>
      <div className="modal-box card" style={{ maxWidth: 640 }} onClick={(event) => event.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Gerar vídeo do produto</h2>
        <p className="muted" style={{ fontSize: "0.78rem", marginTop: "-0.4rem" }}>
          Vídeo curto (8s) gerado por IA a partir de fotos reais do produto. Pode levar alguns minutos.
          {additionalReferenceCount > 0
            ? ` Além da foto escolhida abaixo, ${additionalReferenceCount === 1 ? "mais 1 foto real do produto entra" : `mais ${additionalReferenceCount} fotos reais do produto entram`} automaticamente como referência (Veo aceita até 3).`
            : " Este produto só tem essa foto disponível como referência."}
        </p>
        {images.length === 0 ? (
          <p className="muted">Este produto não tem fotos cadastradas para usar como referência.</p>
        ) : (
          <>
            <PhotoReferencePicker images={images} baseImageUrl={baseImageUrl} onBaseImageChange={setBaseImageUrl} allowCrop={false} />
            <label style={{ display: "block", margin: "0.9rem 0 0" }}>
              <span className="muted" style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.3rem" }}>
                Instruções (opcional)
              </span>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={500}
                rows={3}
                placeholder="Ex.: leve giro mostrando os dois lados; câmera fixa, só aproximação suave"
                style={IMAGE_NOTE_TEXTAREA_STYLE}
              />
            </label>
          </>
        )}
        {error && (
          <div className="banner" style={{ marginTop: "0.75rem" }}>
            {error}
          </div>
        )}
        <div className="actions" style={{ marginTop: "1rem", justifyContent: "flex-end" }}>
          <button type="button" className="secondary" onClick={onCancel} disabled={submitting}>
            Cancelar
          </button>
          <button type="button" onClick={() => onSubmit(baseImageUrl, note.trim())} disabled={submitting || !baseImageUrl}>
            {submitting ? "Gerando… (pode levar minutos)" : "Gerar vídeo"}
          </button>
        </div>
      </div>
    </div>
  );
}

const FIELD_LABELS: Record<EnrichmentProposal["field"], string> = {
  description: "Descrição",
  alt_text: "Alt-text de imagem",
  structured_data: "Dados estruturados (schema.org)",
  faq: "FAQ (GEO)",
  benefit_bullets: "Bullets de benefício",
  technical_specs: "Especificações técnicas",
  seo_title: "Título otimizado para SEO",
  meta_description: "Meta description",
  keywords: "Palavras-chave",
  tags: "Tags de navegação",
  cta: "Chamada à ação (CTA)",
  attributes_patch: "Normalização/preenchimento de atributos",
  featured_image: "Foto de destaque na descrição",
};

/** description/alt_text/seo_title/meta_description/cta store plain text in proposedValue; the
 *  rest store a JSON-encoded value — this renders a readable preview for those instead of showing
 *  raw JSON in the diff view. The underlying textarea below still lets a reviewer edit the raw
 *  JSON directly if needed. */
function ProposalPreview({ proposal }: { proposal: EnrichmentProposal }) {
  if (["description", "alt_text", "seo_title", "meta_description", "cta"].includes(proposal.field)) return null;

  try {
    if (proposal.field === "keywords") {
      const keywords = JSON.parse(proposal.proposedValue) as { primary: string[]; secondary: string[] };
      return (
        <div style={{ marginBottom: "0.75rem" }}>
          <div>
            <span className="muted">Principais: </span>
            {keywords.primary.join(", ")}
          </div>
          <div>
            <span className="muted">Secundárias: </span>
            {keywords.secondary.join(", ")}
          </div>
        </div>
      );
    }
    if (proposal.field === "tags") {
      const tags = JSON.parse(proposal.proposedValue) as string[];
      return (
        <div style={{ marginBottom: "0.75rem", display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
          {tags.map((tag, i) => (
            <span key={i} className="pill">
              {tag}
            </span>
          ))}
        </div>
      );
    }
    if (proposal.field === "attributes_patch") {
      return <pre style={{ marginBottom: "0.75rem" }}>{JSON.stringify(JSON.parse(proposal.proposedValue), null, 2)}</pre>;
    }
    if (proposal.field === "featured_image") {
      const { url, caption } = JSON.parse(proposal.proposedValue) as { url: string; caption: string };
      return (
        <div style={{ marginBottom: "0.75rem" }}>
          <img src={url} alt={caption} style={{ maxWidth: 200, borderRadius: "var(--radius-md)" }} />
          {caption && <p className="muted" style={{ margin: "0.3rem 0 0" }}>{caption}</p>}
        </div>
      );
    }
    if (proposal.field === "benefit_bullets") {
      const bullets = JSON.parse(proposal.proposedValue) as string[];
      return (
        <ul style={{ margin: "0 0 0.75rem", paddingLeft: "1.2rem" }}>
          {bullets.map((bullet, i) => (
            <li key={i}>{bullet}</li>
          ))}
        </ul>
      );
    }
    if (proposal.field === "technical_specs") {
      const specs = JSON.parse(proposal.proposedValue) as Array<{ label: string; value: string }>;
      return (
        <table style={{ marginBottom: "0.75rem" }}>
          <tbody>
            {specs.map((spec, i) => (
              <tr key={i}>
                <td className="muted" style={{ width: "40%" }}>
                  {spec.label}
                </td>
                <td>{spec.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    if (proposal.field === "faq") {
      const faq = JSON.parse(proposal.proposedValue) as Array<{ question: string; answer: string }>;
      return (
        <div style={{ marginBottom: "0.75rem" }}>
          {faq.map((item, i) => (
            <div key={i} style={{ marginBottom: "0.5rem" }}>
              <strong>{item.question}</strong>
              <p className="muted" style={{ margin: "0.2rem 0 0" }}>
                {item.answer}
              </p>
            </div>
          ))}
        </div>
      );
    }
    if (proposal.field === "structured_data") {
      return <pre style={{ marginBottom: "0.75rem" }}>{JSON.stringify(JSON.parse(proposal.proposedValue), null, 2)}</pre>;
    }
  } catch {
    return null;
  }
  return null;
}

const PLATFORM_LABELS: Record<CatalogPlatform, string> = {
  vtex: "VTEX",
  shopify: "Shopify",
};

// Named Ouro/Prata/Bronze, not Excelente/Bom/Médio — that vocabulary is already used for the
// GENERATION level (chosen before the run, controls HTML structure) and the two can disagree, so
// sharing words here would read as a contradiction instead of two independent signals.
const TIER_LABELS: Record<"ouro" | "prata" | "bronze", string> = {
  ouro: "Ouro",
  prata: "Prata",
  bronze: "Bronze",
};

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 100 : Math.round((numerator / denominator) * 100);
}

export function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const runId = Number(id);
  const [run, setRun] = useState<EnrichmentRun | null>(null);
  const [runImageNote, setRunImageNote] = useState("");
  const [savedRunImageNote, setSavedRunImageNote] = useState("");
  const [savingRunImageNote, setSavingRunImageNote] = useState(false);
  const [runImageNoteError, setRunImageNoteError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<EnrichmentProposal[]>([]);
  const [scores, setScores] = useState<ContentScore[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [costs, setCosts] = useState<RunCosts | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [platform, setPlatform] = useState<CatalogPlatform>("vtex");
  const [publishError, setPublishError] = useState<string | null>(null);
  const [resyncingIds, setResyncingIds] = useState<Set<number>>(new Set());
  const [resyncError, setResyncError] = useState<string | null>(null);
  const [generatedImages, setGeneratedImages] = useState<Record<number, GeneratedImage[]>>({});
  // The product's own photos already on the platform (outside CatalogIA's generatedImages table) —
  // most predate this store's Label convention and come back unclassified, see listCatalogImages.
  const [catalogImages, setCatalogImages] = useState<Record<number, CatalogImage[]>>({});
  const [thresholds, setThresholds] = useState<CategoryScoreThreshold[]>([]);
  const [impactSummary, setImpactSummary] = useState<ImpactSummary | null>(null);
  const [generatingFor, setGeneratingFor] = useState<Record<number, GeneratableImageKind | undefined>>({});
  const [imageGenError, setImageGenError] = useState<string | null>(null);
  const [imageModal, setImageModal] = useState<ImageModalTarget | null>(null);
  const [imageModalSubmitting, setImageModalSubmitting] = useState(false);
  const [imageModalError, setImageModalError] = useState<string | null>(null);
  const [classifyingId, setClassifyingId] = useState<string | null>(null);
  const [generatedVideos, setGeneratedVideos] = useState<Record<number, GeneratedVideo[]>>({});
  const [generatingVideoFor, setGeneratingVideoFor] = useState<Set<number>>(new Set());
  const [videoGenError, setVideoGenError] = useState<string | null>(null);
  const [videoModalProductId, setVideoModalProductId] = useState<number | null>(null);
  const [videoModalSubmitting, setVideoModalSubmitting] = useState(false);
  const [videoModalError, setVideoModalError] = useState<string | null>(null);
  const [deletingVideoId, setDeletingVideoId] = useState<number | null>(null);
  const runImageNoteDirtyRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh() {
    const [runData, proposalsData, scoresData, costsData, impactData] = await Promise.all([
      api.getRun(runId),
      api.listProposals(runId),
      api.listScores(runId),
      api.runCosts(runId),
      api.runImpactSummary(runId),
    ]);
    setRun(runData);
    const nextRunImageNote = imageGenerationNoteFromRun(runData);
    setSavedRunImageNote(nextRunImageNote);
    if (!runImageNoteDirtyRef.current) setRunImageNote(nextRunImageNote);
    setProposals(proposalsData);
    setScores(scoresData);
    setCosts(costsData);
    setImpactSummary(impactData);
    // Once the run leaves "running", nothing about it changes anymore — stop polling instead of
    // hitting 4 endpoints every 5s forever for a page the user may just leave open.
    if (runData.status !== "running" && intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }

  useEffect(() => {
    refresh().catch((err) => console.error("Failed to refresh run", err));
    api.listProducts().then(setProducts);
    api.getCatalogPlatform().then(({ platform }) => setPlatform(platform));
    api.getOptimizationThresholds().then(({ thresholds }) => setThresholds(thresholds));
    intervalRef.current = setInterval(() => {
      refresh().catch((err) => console.error("Failed to refresh run", err));
    }, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [runId]);

  /** Re-fetches one product from the active catalog platform without running a whole new
   *  optimization — for when the local snapshot was synced before a field existed (e.g. `url`,
   *  added later) and still shows stale/incomplete data. */
  async function resyncProduct(productId: number) {
    setResyncError(null);
    setResyncingIds((prev) => new Set(prev).add(productId));
    try {
      const updated = await api.resyncProduct(productId);
      setProducts((prev) => prev.map((p) => (p.id === productId ? updated : p)));
    } catch (err) {
      setResyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setResyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(productId);
        return next;
      });
    }
  }

  // Loads once proposals resolve (and again on every poll tick — the list is small and rarely
  // changes, so refetching is simpler than tracking exactly which product ids are new).
  useEffect(() => {
    const ids = [...new Set(proposals.map((p) => p.productId))];
    if (ids.length === 0) return;
    Promise.all(ids.map((productId) => api.listGeneratedImages(productId).then((images) => [productId, images] as const)))
      .then((pairs) => setGeneratedImages(Object.fromEntries(pairs)))
      .catch((err) => console.error("Failed to load generated images", err));
    Promise.all(
      ids.map((productId) =>
        api
          .listCatalogImages(productId)
          .then((images) => [productId, images] as const)
          .catch(() => [productId, []] as const),
      ),
    ).then((pairs) => setCatalogImages(Object.fromEntries(pairs)));
    Promise.all(ids.map((productId) => api.listGeneratedVideos(productId).then((videos) => [productId, videos] as const)))
      .then((pairs) => setGeneratedVideos(Object.fromEntries(pairs)))
      .catch((err) => console.error("Failed to load generated videos", err));
  }, [proposals]);

  /** Generates a new marketing image FROM the product's existing photos (never from scratch) —
   *  one of the 4 photo standards this store classifies its whole catalog into (see
   *  PHOTO_CLASSIFICATION_LABELS): principal, ambientada (lifestyle), dimensional, or destaque
   *  (feature_callout). */
  async function handleSaveRunImageNote() {
    setRunImageNoteError(null);
    setSavingRunImageNote(true);
    try {
      const updated = await api.updateRunImageGenerationNote(runId, runImageNote.trim());
      setRun(updated);
      const saved = imageGenerationNoteFromRun(updated);
      setSavedRunImageNote(saved);
      setRunImageNote(saved);
      runImageNoteDirtyRef.current = false;
    } catch (err) {
      setRunImageNoteError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRunImageNote(false);
    }
  }

  function handleRunImageNoteChange(value: string) {
    runImageNoteDirtyRef.current = value.trim() !== savedRunImageNote;
    setRunImageNote(value);
  }

  /** Generates one image and returns an error message on failure (null on success) — the modal
   *  shows that message inline instead of the page-level banner, since it's already the surface
   *  the operator is looking at when the request fails. */
  async function handleGenerateImage(
    productId: number,
    kind: GeneratableImageKind,
    options: { note?: string; baseImageUrl?: string; referenceCrop?: ReferenceImageCrop },
  ): Promise<string | null> {
    setGeneratingFor((prev) => ({ ...prev, [productId]: kind }));
    try {
      const note = (options.note ?? "").trim();
      const image = await api.generateImage(productId, {
        kind,
        runId,
        note: note || undefined,
        baseImageUrl: options.baseImageUrl || undefined,
        referenceCrop: kind === "feature_callout" ? options.referenceCrop : undefined,
      });
      setGeneratedImages((prev) => ({ ...prev, [productId]: [image, ...(prev[productId] ?? [])] }));
      // The run may already be done (poll loop stopped) — costs otherwise wouldn't reflect this
      // generation's price until something else happens to trigger a refresh.
      api.runCosts(runId).then(setCosts);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      setGeneratingFor((prev) => ({ ...prev, [productId]: undefined }));
    }
  }

  async function handleImageModalSubmit(baseImageUrl: string, crop: ReferenceImageCrop | undefined, note: string) {
    if (!imageModal) return;
    setImageModalSubmitting(true);
    setImageModalError(null);
    const err = await handleGenerateImage(imageModal.productId, imageModal.kind, { note, baseImageUrl, referenceCrop: crop });
    setImageModalSubmitting(false);
    if (err) setImageModalError(err);
    else setImageModal(null);
  }

  /** Generates a short marketing video FROM the product's existing photos (never from scratch) —
   *  mirrors handleGenerateImage, but tracked in a Set instead of a per-kind map since there's only
   *  one video "kind", and the request itself can take up to several minutes (Veo polls internally
   *  on the server — see gemini.client.ts's generateProductVideo). */
  async function handleGenerateVideo(productId: number, options: { note?: string; baseImageUrl?: string }): Promise<string | null> {
    setGeneratingVideoFor((prev) => new Set(prev).add(productId));
    try {
      const note = (options.note ?? "").trim();
      const video = await api.generateVideo(productId, {
        runId,
        note: note || undefined,
        baseImageUrl: options.baseImageUrl || undefined,
      });
      setGeneratedVideos((prev) => ({ ...prev, [productId]: [video, ...(prev[productId] ?? [])] }));
      api.runCosts(runId).then(setCosts);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      setGeneratingVideoFor((prev) => {
        const next = new Set(prev);
        next.delete(productId);
        return next;
      });
    }
  }

  async function handleVideoModalSubmit(baseImageUrl: string, note: string) {
    if (videoModalProductId === null) return;
    setVideoModalSubmitting(true);
    setVideoModalError(null);
    const err = await handleGenerateVideo(videoModalProductId, { note, baseImageUrl });
    setVideoModalSubmitting(false);
    if (err) setVideoModalError(err);
    else setVideoModalProductId(null);
  }

  async function handleDeleteGeneratedVideo(productId: number, video: GeneratedVideo) {
    if (video.publishedAt && !window.confirm("Esse vídeo já está publicado na loja — excluir aqui também remove o vídeo real da loja. Continuar?")) {
      return;
    }
    setVideoGenError(null);
    setDeletingVideoId(video.id);
    try {
      await api.deleteGeneratedVideo(video.id);
      setGeneratedVideos((prev) => ({
        ...prev,
        [productId]: (prev[productId] ?? []).filter((v) => v.id !== video.id),
      }));
    } catch (err) {
      setVideoGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingVideoId(null);
    }
  }

  const [publishingVideoId, setPublishingVideoId] = useState<number | null>(null);

  /** Uploads an already-generated video as a real product video on the active platform — distinct
   *  from generating it (which only ever saves inside CatalogIA until this is called). */
  async function handlePublishVideo(productId: number, video: GeneratedVideo) {
    if (
      !video.integrityVerified &&
      !window.confirm(
        "A integridade deste vídeo não foi confirmada automaticamente. Se você revisou visualmente e o vídeo está correto, pode publicar mesmo assim. Continuar?",
      )
    ) {
      return;
    }
    setVideoGenError(null);
    setPublishingVideoId(video.id);
    try {
      const updated = await api.publishGeneratedVideo(productId, video.id, { force: !video.integrityVerified });
      setGeneratedVideos((prev) => ({
        ...prev,
        [productId]: (prev[productId] ?? []).map((v) => (v.id === video.id ? updated : v)),
      }));
    } catch (err) {
      setVideoGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishingVideoId(null);
    }
  }

  const [publishingImageId, setPublishingImageId] = useState<number | null>(null);

  /** Uploads an already-generated image as a real product photo on the active platform — distinct
   *  from generating it (which only ever saves inside CatalogIA until this is called). */
  async function handlePublishImage(productId: number, image: GeneratedImage) {
    if (
      !image.integrityVerified &&
      !window.confirm(
        "A integridade desta imagem nao foi confirmada automaticamente. Se voce revisou visualmente e a imagem esta correta, pode publicar mesmo assim. Continuar?",
      )
    ) {
      return;
    }
    setImageGenError(null);
    setPublishingImageId(image.id);
    try {
      const updated = await api.publishGeneratedImage(productId, image.id, { force: !image.integrityVerified });
      setGeneratedImages((prev) => ({
        ...prev,
        [productId]: (prev[productId] ?? []).map((img) => (img.id === image.id ? updated : img)),
      }));
    } catch (err) {
      setImageGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishingImageId(null);
    }
  }

  const [deletingImageId, setDeletingImageId] = useState<number | null>(null);

  /** Removes a generated/reference photo from the panel so unwanted or never-classified
   *  generations don't pile up — confirms first only when it's already published, since that
   *  also deletes the real photo from the storefront, not just this row. */
  async function handleDeleteGeneratedImage(productId: number, image: GeneratedImage) {
    if (image.publishedAt && !window.confirm("Essa foto já está publicada na loja — excluir aqui também remove a foto real da loja. Continuar?")) {
      return;
    }
    setImageGenError(null);
    setDeletingImageId(image.id);
    try {
      await api.deleteGeneratedImage(image.id);
      setGeneratedImages((prev) => ({
        ...prev,
        [productId]: (prev[productId] ?? []).filter((img) => img.id !== image.id),
      }));
    } catch (err) {
      setImageGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingImageId(null);
    }
  }

  /** Assigns which of the 4 carousel slots a generated-here image fills — the 3 AI kinds default
   *  to a matching classification already (see CLASSIFICATION_BY_KIND server-side), but a
   *  manufacturer_reference photo starts unclassified, and any of them can be reassigned. Purely
   *  local metadata until "Publicar na loja" actually sends it — distinct from classifying a photo
   *  already live on the platform, see handleClassifyCatalogImage. */
  async function handleClassifyGeneratedImage(productId: number, imageId: number, classification: PhotoClassification | null) {
    setImageGenError(null);
    setClassifyingId(`generated-${imageId}`);
    try {
      const updated = await api.classifyGeneratedImage(imageId, classification);
      setGeneratedImages((prev) => ({
        ...prev,
        [productId]: (prev[productId] ?? []).map((img) => (img.id === imageId ? updated : img)),
      }));
    } catch (err) {
      setImageGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setClassifyingId(null);
    }
  }

  /** Re-labels a photo already on the platform — sends the VTEX write immediately (no separate
   *  "publish" step, since the photo's already live; only its Label metadata is changing). */
  async function handleClassifyCatalogImage(productId: number, imageId: string, classification: PhotoClassification | null) {
    setImageGenError(null);
    setClassifyingId(`catalog-${imageId}`);
    try {
      const { label } = await api.classifyCatalogImage(productId, imageId, classification);
      setCatalogImages((prev) => ({
        ...prev,
        [productId]: (prev[productId] ?? []).map((img) => (img.id === imageId ? { ...img, label } : img)),
      }));
    } catch (err) {
      setImageGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setClassifyingId(null);
    }
  }

  const [republishingProductId, setRepublishingProductId] = useState<number | null>(null);

  /** Republishes EVERY approved/edited/published proposal this product has (description, SEO,
   *  tags, keywords, attributes, alt-texts...) plus reordering its photo carousel to match each
   *  photo's current Label — for after reclassifying a photo or generating a new one, so the
   *  storefront actually reflects the current state without clicking a separate "reenviar" per
   *  field. */
  async function handleRepublishProduct(productId: number) {
    setImageGenError(null);
    setRepublishingProductId(productId);
    try {
      await api.republishProduct(productId, runId);
      refresh();
    } catch (err) {
      setImageGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setRepublishingProductId(null);
    }
  }

  async function review(proposal: EnrichmentProposal, status: "approved" | "rejected" | "edited") {
    const proposedValue = status === "edited" ? drafts[proposal.id] ?? proposal.proposedValue : undefined;
    await api.reviewProposal(proposal.id, { status, proposedValue });
    refresh();
  }

  const [republishingId, setRepublishingId] = useState<number | null>(null);
  const [republishError, setRepublishError] = useState<string | null>(null);

  // Point-fix for a proposal that's already approved/published — saves the edited draft and sends
  // just that correction to the platform right away, instead of routing back through
  // approve→"Publicar aprovadas" for a small fix a merchant wants live immediately.
  async function handleRepublish(proposal: EnrichmentProposal) {
    setRepublishError(null);
    setRepublishingId(proposal.id);
    try {
      await api.republishProposal(proposal.id, drafts[proposal.id]);
      refresh();
    } catch (err) {
      setRepublishError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setRepublishingId(null);
    }
  }

  async function handlePublish() {
    setPublishError(null);
    try {
      await api.publishRun(runId);
      refresh();
    } catch (err) {
      setPublishError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    }
  }

  async function handleApproveAll() {
    setPublishError(null);
    try {
      await api.approveAllProposals(runId);
      refresh();
    } catch (err) {
      setPublishError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    }
  }

  const approvedCount = proposals.filter((p) => p.status === "approved").length;
  const pendingCount = proposals.filter((p) => p.status === "pending" || p.status === "edited").length;
  const publishedCount = proposals.filter((p) => p.status === "published").length;
  // The worker still processes remaining products in the background while status is "running" —
  // publishing now would only send whatever's ready so far, and the rest would need a second,
  // easy-to-forget publish once they finish generating. Block until the run itself is done.
  const runInProgress = run?.status === "running";
  const reusedCount = proposals.filter((p) => p.field === "description" && p.reusedFromProductId !== null).length;

  const productIds = [...new Set(proposals.map((p) => p.productId))];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Otimização #{runId}</h1>
          {run && (
            <p className="muted">
              <StatusBadge kind="run" status={run.status} /> · {run.processedCount} produtos processados
            </p>
          )}
        </div>
      </div>

      <div className="page-content">
        {impactSummary && <ImpactSummaryBanner summary={impactSummary} />}

        <div className="stat-row">
          <StatTile label="Pendentes" value={pendingCount} />
          <StatTile label="Aprovadas" value={approvedCount} />
          <StatTile label="Publicadas" value={publishedCount} />
          {costs && (
            <>
              <StatTile label="Custo da otimização" value={formatCost(costs.totalCostUsd)} />
              <StatTile label="Chamadas de IA" value={costs.totalCalls} />
            </>
          )}
          {reusedCount > 0 && (
            <StatTile label="Reaproveitados (RAG)" value={reusedCount} delta="menor custo" deltaGood />
          )}
        </div>

        <div className="banner">
          <span>
            {runInProgress
              ? "Otimização ainda em andamento — aguarde terminar de processar todos os produtos antes de publicar, para não deixar parte de fora."
              : `Aprove o conteúdo abaixo antes de publicar de volta na ${PLATFORM_LABELS[platform]}.`}
          </span>
          <button type="button" onClick={handleApproveAll} disabled={pendingCount === 0 || runInProgress}>
            Aprovar todos
          </button>
          <button type="button" onClick={handlePublish} disabled={approvedCount === 0 || runInProgress}>
            Publicar aprovadas na {PLATFORM_LABELS[platform]}
          </button>
        </div>
        {publishError && <div className="banner">{publishError}</div>}
        {republishError && <div className="banner">{republishError}</div>}
        {resyncError && <div className="banner">{resyncError}</div>}
        {imageGenError && <div className="banner">{imageGenError}</div>}

        {productIds.map((productId) => {
          const productProposals = proposals.filter((p) => p.productId === productId);
          const original = scores.find((s) => s.productId === productId && s.target === "original");
          const proposed = scores.find((s) => s.productId === productId && s.target === "proposed");

          const productCost = costs?.byProduct.find((c) => c.productId === productId);
          const currentProduct = products.find((p) => p.id === productId);
          const referenceImages = orderedReferenceImages(currentProduct);
          const descriptionProposal = productProposals.find((p) => p.field === "description");
          const donorProduct =
            descriptionProposal?.reusedFromProductId != null
              ? products.find((p) => p.id === descriptionProposal.reusedFromProductId)
              : undefined;

          return (
            <section className="card" key={productId}>
              <div className="proposal-header">
                <h2 style={{ margin: 0 }}>{currentProduct?.title ?? `Produto #${productId}`}</h2>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                  {currentProduct?.url && (
                    <a href={currentProduct.url} target="_blank" rel="noreferrer" className="link-button">
                      Ver na loja ↗
                    </a>
                  )}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => resyncProduct(productId)}
                    disabled={resyncingIds.has(productId)}
                    title="Busca os dados mais recentes deste produto na loja — útil quando a sincronização local está incompleta ou desatualizada."
                  >
                    {resyncingIds.has(productId) ? "Ressincronizando…" : "Ressincronizar produto"}
                  </button>
                  {descriptionProposal?.reusedFromProductId != null && (
                    <span className="pill" title="Conteúdo adaptado de um produto muito similar já aprovado — menos chamadas de IA, menor custo.">
                      🔗 Reaproveitado{donorProduct ? ` de "${donorProduct.title}"` : ""}
                      {descriptionProposal.reusedSimilarity
                        ? ` (${Math.round(Number(descriptionProposal.reusedSimilarity) * 100)}% similar)`
                        : ""}
                    </span>
                  )}
                  {productCost && (
                    <span className="pill">
                      Custo desta otimização: {formatCost(productCost.costUsd)} ({productCost.calls} chamadas)
                    </span>
                  )}
                </div>
              </div>

              {original && proposed && (
                <div className="card" style={{ background: "var(--surface-2)", margin: "0 0 1rem" }}>
                  <div className="proposal-header">
                    <h3 style={{ margin: 0 }}>Score de qualidade de conteúdo (antes → depois)</h3>
                    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                      <span className="pill">
                        Classificação: {TIER_LABELS[classifyScore(thresholds, currentProduct?.category ?? null, proposed.overallScore)]}
                      </span>
                      {proposed.attempts > 1 && (
                        <span className="pill">
                          Refinado automaticamente em {proposed.attempts} tentativas até atingir score {proposed.overallScore}
                        </span>
                      )}
                    </div>
                  </div>
                  <ScoreCompare label="Score geral" before={original.overallScore} after={proposed.overallScore} />
                  <ScoreCompare
                    label="Completude do catálogo"
                    before={percent(original.attributesFilled, original.attributesExpected)}
                    after={percent(proposed.attributesFilled, proposed.attributesExpected)}
                  />
                  <ScoreCompare label="SEO" before={original.seoScore} after={proposed.seoScore} />
                  {proposed.seoQueryCoverage !== null && (
                    <p className="muted" style={{ fontSize: "0.72rem", margin: "-0.5rem 0 0.75rem" }}>
                      Cobre {proposed.seoQueryCoverage}% das buscas reais do Google Search Console para esta página
                      {original.seoQueryCoverage !== null ? ` (antes: ${original.seoQueryCoverage}%)` : ""} — já somado ao score de SEO acima.
                    </p>
                  )}
                  <ScoreCompare
                    label="GEO"
                    before={percent(original.questionsAnswered, original.questionsTotal)}
                    after={percent(proposed.questionsAnswered, proposed.questionsTotal)}
                  />
                  <ScoreCompare label="Conversão" before={original.conversionScore} after={proposed.conversionScore} />
                  <ScoreCompare label="Legibilidade" before={original.readabilityScore} after={proposed.readabilityScore} />
                  <ScoreCompare label="Estrutura" before={original.structureScore} after={proposed.structureScore} />
                  <ScoreCompare label="Confiança do comprador" before={original.buyerConfidence} after={proposed.buyerConfidence} />
                  <ScoreCompare
                    label="Atributos preenchidos"
                    before={original.attributesFilled}
                    after={proposed.attributesFilled}
                    max={proposed.attributesExpected}
                  />
                  <ScoreCompare
                    label="Perguntas respondidas"
                    before={original.questionsAnswered}
                    after={proposed.questionsAnswered}
                    max={proposed.questionsTotal}
                  />
                  <ScoreCompare
                    label="Consistência dos dados"
                    before={original.dataConsistencyScore}
                    after={proposed.dataConsistencyScore}
                  />
                  {proposed.unsupportedClaims.length > 0 && (
                    <p className="muted" style={{ color: "var(--status-warning)" }}>
                      ⚠ Possível alucinação — revisar: {proposed.unsupportedClaims.join("; ")}
                    </p>
                  )}
                  {proposed.catalogIssues.length > 0 && (
                    <p className="muted" style={{ color: "var(--status-warning)" }}>
                      ⚠ Possível inconsistência de catálogo: {proposed.catalogIssues.join("; ")}
                    </p>
                  )}
                </div>
              )}

              <div className="card" style={{ background: "var(--surface-2)", margin: "0 0 1rem" }}>
                <div className="proposal-header">
                  <h3 style={{ margin: 0 }}>Fotos</h3>
                  <div className="actions" style={{ marginTop: 0, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setImageModal({ productId, kind: "principal" })}
                      disabled={generatingFor[productId] !== undefined}
                    >
                      {generatingFor[productId] === "principal" ? "Gerando…" : "🏷️ Gerar foto principal"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setImageModal({ productId, kind: "lifestyle" })}
                      disabled={generatingFor[productId] !== undefined}
                    >
                      {generatingFor[productId] === "lifestyle" ? "Gerando…" : "🖼️ Gerar foto ambientada"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setImageModal({ productId, kind: "dimensional" })}
                      disabled={generatingFor[productId] !== undefined}
                    >
                      {generatingFor[productId] === "dimensional" ? "Gerando…" : "📏 Gerar foto dimensional"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setImageModal({ productId, kind: "feature_callout" })}
                      disabled={generatingFor[productId] !== undefined}
                    >
                      {generatingFor[productId] === "feature_callout" ? "Gerando…" : "🎯 Gerar foto de destaque"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setVideoModalProductId(productId)}
                      disabled={generatingVideoFor.has(productId)}
                    >
                      {generatingVideoFor.has(productId) ? "Gerando… (minutos)" : "🎬 Gerar vídeo"}
                    </button>
                    {descriptionProposal && (descriptionProposal.status === "approved" || descriptionProposal.status === "published") && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => handleRepublishProduct(productId)}
                        disabled={republishingProductId === productId}
                        title="Reenvia tudo que já foi aprovado/publicado deste produto (descrição, SEO, tags, etc) e reordena o carrossel de fotos pelos Labels — útil depois de mudar um Label ou gerar uma foto nova."
                      >
                        {republishingProductId === productId ? "Enviando…" : "🔄 Republicar anúncio"}
                      </button>
                    )}
                  </div>
                </div>
                {(() => {
                  // One combined, ordered view of every photo for this product regardless of
                  // source (generated-here vs already-on-the-platform) — sorted by classification
                  // slot (principal, ambientada, dimensional, then every "destaque" one together),
                  // not by whatever order each source's API happened to return. The numeric Label
                  // actually sent to VTEX is unchanged by any of this — purely how this panel
                  // organizes/names cards for a human reviewing them.
                  type PhotoCard = { key: string; classification: PhotoClassification | ""; render: (name: string) => React.ReactNode };
                  const SLOT_ORDER: Record<PhotoClassification | "", number> = {
                    principal: 0,
                    ambientada: 1,
                    dimensional: 2,
                    destaque: 3,
                    "": 4,
                  };
                  // Locking rule: principal/ambientada/dimensional are 1-photo slots — once any
                  // photo (from either source) holds one, that option disables on every OTHER
                  // photo's select so two photos can never both claim the same single slot.
                  // "destaque" stays open on every select since it's the one slot allowing more
                  // than one photo.
                  const usedSingleSlots = new Set<PhotoClassification>();
                  for (const img of generatedImages[productId] ?? []) {
                    if (img.classification && img.classification !== "destaque") usedSingleSlots.add(img.classification);
                  }
                  for (const img of catalogImages[productId] ?? []) {
                    const c = classificationFromLabel(img.label);
                    if (c && c !== "destaque") usedSingleSlots.add(c);
                  }
                  function optionsFor(ownValue: PhotoClassification | "") {
                    return (Object.keys(PHOTO_CLASSIFICATION_LABELS) as PhotoClassification[]).map((c) => (
                      <option key={c} value={c} disabled={c !== "destaque" && c !== ownValue && usedSingleSlots.has(c)}>
                        {PHOTO_CLASSIFICATION_LABELS[c]}
                      </option>
                    ));
                  }

                  const cards: PhotoCard[] = [
                    ...(generatedImages[productId] ?? []).map((image) => ({
                      key: `generated-${image.id}`,
                      classification: (image.classification ?? "") as PhotoClassification | "",
                      render: (name: string) => (
                        <div style={{ width: 180 }}>
                          <img
                            src={`data:${image.mimeType};base64,${image.imageBase64}`}
                            alt={name}
                            style={{ width: "100%", height: 160, objectFit: "cover", borderRadius: "var(--radius-md)" }}
                          />
                          <div style={{ fontSize: "0.75rem", fontWeight: 600, marginTop: "0.3rem" }}>{name}</div>
                          <div className="muted" style={{ fontSize: "0.72rem" }}>
                            {image.kind === "manufacturer_reference" ? "Foto do fabricante" : `Gerada por IA · ${formatCost(Number(image.costUsd ?? 0))}`}
                          </div>
                          {image.kind === "manufacturer_reference" && image.sourceUrl && (
                            <a
                              href={image.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="muted"
                              style={{ fontSize: "0.7rem", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                            >
                              {image.sourceUrl}
                            </a>
                          )}
                          {!image.integrityVerified && (
                            <div
                              style={{ fontSize: "0.72rem", marginTop: "0.2rem", color: "var(--status-warning)" }}
                              title={image.integrityNotes ?? ""}
                            >
                              ⚠ Integridade do produto não confirmada
                            </div>
                          )}
                          <select
                            value={image.classification ?? ""}
                            onChange={(e) =>
                              handleClassifyGeneratedImage(productId, image.id, e.target.value === "" ? null : (e.target.value as PhotoClassification))
                            }
                            disabled={classifyingId === `generated-${image.id}`}
                            style={{ width: "100%", marginTop: "0.3rem", fontSize: "0.72rem" }}
                          >
                            <option value="">Sem classificação</option>
                            {optionsFor(image.classification ?? "")}
                          </select>
                          {image.publishedAt ? (
                            <div style={{ fontSize: "0.72rem", marginTop: "0.3rem", color: "var(--status-good)" }}>
                              ✓ Publicada na loja
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="link-button"
                              style={{ fontSize: "0.72rem", marginTop: "0.3rem" }}
                              onClick={() => handlePublishImage(productId, image)}
                              disabled={publishingImageId === image.id || !image.classification}
                              title={
                                !image.classification
                                    ? "Classifique a foto antes de publicar."
                                  : !image.integrityVerified
                                    ? "Integridade nao confirmada automaticamente — publique apenas se voce revisou visualmente."
                                    : undefined
                              }
                            >
                              {publishingImageId === image.id
                                ? "Publicando..."
                                : image.integrityVerified
                                  ? "Aceitar e publicar"
                                  : "Aceitar mesmo assim"}
                            </button>
                          )}
                          {isGeneratableImageKind(image.kind) && (
                            <div style={{ marginTop: "0.45rem", paddingTop: "0.45rem", borderTop: "1px solid var(--border)" }}>
                              <button
                                type="button"
                                className="link-button"
                                style={{ fontSize: "0.72rem" }}
                                onClick={() => {
                                  const kind = image.kind;
                                  if (isGeneratableImageKind(kind)) setImageModal({ productId, kind, retryImage: image });
                                }}
                                disabled={generatingFor[productId] !== undefined}
                                title="Gera uma nova imagem mantendo esta aqui para comparacao."
                              >
                                Refazer
                              </button>
                            </div>
                          )}
                          <button
                            type="button"
                            className="link-button danger"
                            style={{ fontSize: "0.72rem", marginTop: "0.2rem" }}
                            onClick={() => handleDeleteGeneratedImage(productId, image)}
                            disabled={deletingImageId === image.id}
                          >
                            {deletingImageId === image.id ? "Excluindo…" : "🗑️ Excluir"}
                          </button>
                        </div>
                      ),
                    })),
                    ...(catalogImages[productId] ?? []).map((image) => {
                      const currentClassification = classificationFromLabel(image.label);
                      return {
                        key: `catalog-${image.id}`,
                        classification: currentClassification,
                        render: (name: string) => (
                          <div style={{ width: 160 }}>
                            <img
                              src={image.url}
                              alt={name}
                              style={{ width: "100%", height: 160, objectFit: "cover", borderRadius: "var(--radius-md)" }}
                            />
                            <div style={{ fontSize: "0.75rem", fontWeight: 600, marginTop: "0.3rem" }}>{name}</div>
                            <div className="muted" style={{ fontSize: "0.72rem" }}>
                              Já na loja {image.label ? `· Label ${image.label}` : "· sem Label"}
                            </div>
                            {platform === "vtex" ? (
                              <select
                                value={currentClassification}
                                onChange={(e) =>
                                  handleClassifyCatalogImage(productId, image.id, e.target.value === "" ? null : (e.target.value as PhotoClassification))
                                }
                                disabled={classifyingId === `catalog-${image.id}`}
                                style={{ width: "100%", marginTop: "0.3rem", fontSize: "0.72rem" }}
                              >
                                <option value="">{classifyingId === `catalog-${image.id}` ? "Salvando…" : "Sem classificação"}</option>
                                {optionsFor(currentClassification)}
                              </select>
                            ) : (
                              <div className="muted" style={{ fontSize: "0.68rem", marginTop: "0.3rem" }}>
                                Shopify não usa Label
                              </div>
                            )}
                          </div>
                        ),
                      };
                    }),
                  ];

                  if (cards.length === 0) {
                    return (
                      <p className="muted" style={{ margin: 0 }}>
                        Nenhuma foto encontrada para este produto ainda.
                      </p>
                    );
                  }

                  const sorted = [...cards].sort((a, b) => SLOT_ORDER[a.classification] - SLOT_ORDER[b.classification]);
                  let detalheCount = 0;
                  const CLASSIFICATION_NAMES: Record<PhotoClassification | "", string> = {
                    principal: "Foto Principal",
                    ambientada: "Foto Ambientada",
                    dimensional: "Foto Dimensional",
                    destaque: "",
                    "": "Não classificada",
                  };
                  return (
                    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                      {sorted.map((card) => {
                        const name =
                          card.classification === "destaque"
                            ? detalheCount++ === 0
                              ? "Foto Detalhe"
                              : `Foto Detalhe ${detalheCount - 1}`
                            : CLASSIFICATION_NAMES[card.classification];
                        return <div key={card.key}>{card.render(name)}</div>;
                      })}
                    </div>
                  );
                })()}
              </div>

              {((generatedVideos[productId] ?? []).length > 0 || generatingVideoFor.has(productId)) && (
                <div className="card" style={{ background: "var(--surface-2)", margin: "0 0 1rem" }}>
                  <h3 style={{ margin: "0 0 0.6rem" }}>Vídeos</h3>
                  {videoGenError && (
                    <div className="banner" style={{ marginBottom: "0.6rem" }}>
                      {videoGenError}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                    {generatingVideoFor.has(productId) && (
                      <div className="muted" style={{ width: 180, fontSize: "0.78rem" }}>
                        Gerando vídeo… pode levar alguns minutos.
                      </div>
                    )}
                    {(generatedVideos[productId] ?? []).map((video) => (
                      <div key={video.id} style={{ width: 180 }}>
                        <video
                          src={api.generatedVideoRawUrl(video.id)}
                          controls
                          loop
                          style={{ width: "100%", height: 160, objectFit: "cover", borderRadius: "var(--radius-md)", background: "#000" }}
                        />
                        <div className="muted" style={{ fontSize: "0.72rem", marginTop: "0.3rem" }}>
                          {video.durationSeconds}s · {formatCost(Number(video.costUsd ?? 0))}
                        </div>
                        {!video.integrityVerified && (
                          <div
                            style={{ fontSize: "0.72rem", marginTop: "0.2rem", color: "var(--status-warning)" }}
                            title={video.integrityNotes ?? ""}
                          >
                            ⚠ Integridade do produto não confirmada
                          </div>
                        )}
                        {video.publishedAt ? (
                          <div style={{ fontSize: "0.72rem", marginTop: "0.3rem", color: "var(--status-good)" }}>✓ Publicado na loja</div>
                        ) : (
                          <button
                            type="button"
                            className="link-button"
                            style={{ fontSize: "0.72rem", marginTop: "0.3rem" }}
                            onClick={() => handlePublishVideo(productId, video)}
                            disabled={publishingVideoId === video.id}
                            title={
                              !video.integrityVerified
                                ? "Integridade nao confirmada automaticamente — publique apenas se voce revisou visualmente."
                                : undefined
                            }
                          >
                            {publishingVideoId === video.id
                              ? "Publicando…"
                              : video.integrityVerified
                                ? "Publicar na loja"
                                : "Publicar mesmo assim"}
                          </button>
                        )}
                        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.3rem" }}>
                          <a href={api.generatedVideoRawUrl(video.id)} download className="link-button" style={{ fontSize: "0.72rem" }}>
                            Baixar
                          </a>
                          <button
                            type="button"
                            className="link-button"
                            style={{ fontSize: "0.72rem", color: "var(--status-critical)" }}
                            onClick={() => handleDeleteGeneratedVideo(productId, video)}
                            disabled={deletingVideoId === video.id}
                          >
                            {deletingVideoId === video.id ? "Excluindo…" : "Excluir"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {productProposals.map((proposal) => (
                <div key={proposal.id} style={{ marginBottom: "1.25rem" }}>
                  <div className="proposal-header">
                    <span className="pill">{FIELD_LABELS[proposal.field]}</span>
                    <StatusBadge kind="proposal" status={proposal.status} />
                  </div>
                  <ProposalPreview proposal={proposal} />
                  <div className="diff">
                    <div>
                      <h3>Antes</h3>
                      <pre>{proposal.originalValue ?? "(vazio)"}</pre>
                    </div>
                    <div>
                      <h3>Proposto</h3>
                      <textarea
                        value={drafts[proposal.id] ?? proposal.proposedValue}
                        onChange={(e) => setDrafts({ ...drafts, [proposal.id]: e.target.value })}
                        rows={6}
                      />
                    </div>
                  </div>
                  {(proposal.status === "pending" || proposal.status === "edited") && (
                    <div className="actions">
                      <button type="button" onClick={() => review(proposal, "approved")}>
                        Aprovar
                      </button>
                      <button type="button" className="secondary" onClick={() => review(proposal, "edited")}>
                        Salvar edição
                      </button>
                      <button type="button" onClick={() => review(proposal, "rejected")} className="danger">
                        Rejeitar
                      </button>
                    </div>
                  )}
                  {(proposal.status === "approved" || proposal.status === "published") && (
                    <div className="actions">
                      <button type="button" className="secondary" onClick={() => handleRepublish(proposal)} disabled={republishingId === proposal.id}>
                        {republishingId === proposal.id ? "Enviando…" : "Salvar e reenviar correção"}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </section>
          );
        })}

        {productIds.length === 0 && <div className="empty-state">Nenhuma proposta gerada ainda para esta otimização.</div>}
      </div>
      {imageModal && (
        <ImageGenerationModal
          target={imageModal}
          images={orderedReferenceImages(products.find((p) => p.id === imageModal.productId))}
          submitting={imageModalSubmitting}
          error={imageModalError}
          onCancel={() => {
            if (imageModalSubmitting) return;
            setImageModal(null);
            setImageModalError(null);
          }}
          onSubmit={handleImageModalSubmit}
          runNote={runImageNote}
          savedRunNote={savedRunImageNote}
          runNoteSaving={savingRunImageNote}
          runNoteError={runImageNoteError}
          onRunNoteChange={handleRunImageNoteChange}
          onSaveRunNote={handleSaveRunImageNote}
        />
      )}
      {videoModalProductId !== null && (
        <VideoGenerationModal
          productId={videoModalProductId}
          images={orderedReferenceImages(products.find((p) => p.id === videoModalProductId))}
          submitting={videoModalSubmitting}
          error={videoModalError}
          onCancel={() => {
            if (videoModalSubmitting) return;
            setVideoModalProductId(null);
            setVideoModalError(null);
          }}
          onSubmit={handleVideoModalSubmit}
        />
      )}
    </>
  );
}
