import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
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
  type ImpactSummary,
  type PhotoClassification,
  type Product,
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
  const [classifyingId, setClassifyingId] = useState<string | null>(null);
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
  }, [proposals]);

  /** Generates a new marketing image FROM the product's existing photos (never from scratch) —
   *  one of the 4 photo standards this store classifies its whole catalog into (see
   *  PHOTO_CLASSIFICATION_LABELS): principal, ambientada (lifestyle), dimensional, or destaque
   *  (feature_callout). */
  async function handleGenerateImage(productId: number, kind: GeneratableImageKind) {
    setImageGenError(null);
    setGeneratingFor((prev) => ({ ...prev, [productId]: kind }));
    try {
      const image = await api.generateImage(productId, { kind, runId });
      setGeneratedImages((prev) => ({ ...prev, [productId]: [image, ...(prev[productId] ?? [])] }));
      // The run may already be done (poll loop stopped) — costs otherwise wouldn't reflect this
      // generation's price until something else happens to trigger a refresh.
      api.runCosts(runId).then(setCosts);
    } catch (err) {
      setImageGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingFor((prev) => ({ ...prev, [productId]: undefined }));
    }
  }

  const [publishingImageId, setPublishingImageId] = useState<number | null>(null);

  /** Uploads an already-generated image as a real product photo on the active platform — distinct
   *  from generating it (which only ever saves inside CatalogIA until this is called). */
  async function handlePublishImage(productId: number, imageId: number) {
    setImageGenError(null);
    setPublishingImageId(imageId);
    try {
      const updated = await api.publishGeneratedImage(productId, imageId);
      setGeneratedImages((prev) => ({
        ...prev,
        [productId]: (prev[productId] ?? []).map((img) => (img.id === imageId ? updated : img)),
      }));
    } catch (err) {
      setImageGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishingImageId(null);
    }
  }

  /** Assigns which of the 4 carousel slots a generated-here image fills — the 3 AI kinds default
   *  to a matching classification already (see CLASSIFICATION_BY_KIND server-side), but a
   *  manufacturer_reference photo starts unclassified, and any of them can be reassigned. Purely
   *  local metadata until "Publicar na loja" actually sends it — distinct from classifying a photo
   *  already live on the platform, see handleClassifyCatalogImage. */
  async function handleClassifyGeneratedImage(productId: number, imageId: number, classification: PhotoClassification) {
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
  async function handleClassifyCatalogImage(productId: number, imageId: string, classification: PhotoClassification) {
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
                      onClick={() => handleGenerateImage(productId, "principal")}
                      disabled={generatingFor[productId] !== undefined}
                    >
                      {generatingFor[productId] === "principal" ? "Gerando…" : "🏷️ Gerar foto principal"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => handleGenerateImage(productId, "lifestyle")}
                      disabled={generatingFor[productId] !== undefined}
                    >
                      {generatingFor[productId] === "lifestyle" ? "Gerando…" : "🖼️ Gerar foto ambientada"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => handleGenerateImage(productId, "dimensional")}
                      disabled={generatingFor[productId] !== undefined}
                    >
                      {generatingFor[productId] === "dimensional" ? "Gerando…" : "📏 Gerar foto dimensional"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => handleGenerateImage(productId, "feature_callout")}
                      disabled={generatingFor[productId] !== undefined}
                    >
                      {generatingFor[productId] === "feature_callout" ? "Gerando…" : "🎯 Gerar foto de destaque"}
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
                        <div style={{ width: 160 }}>
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
                            onChange={(e) => handleClassifyGeneratedImage(productId, image.id, e.target.value as PhotoClassification)}
                            disabled={classifyingId === `generated-${image.id}`}
                            style={{ width: "100%", marginTop: "0.3rem", fontSize: "0.72rem" }}
                          >
                            <option value="" disabled>
                              Classificar…
                            </option>
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
                              onClick={() => handlePublishImage(productId, image.id)}
                              disabled={publishingImageId === image.id || !image.integrityVerified || !image.classification}
                              title={
                                !image.integrityVerified
                                  ? "Integridade não confirmada — gere uma nova imagem para publicar."
                                  : !image.classification
                                    ? "Classifique a foto antes de publicar."
                                    : undefined
                              }
                            >
                              {publishingImageId === image.id ? "Publicando…" : "Publicar na loja"}
                            </button>
                          )}
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
                                onChange={(e) => handleClassifyCatalogImage(productId, image.id, e.target.value as PhotoClassification)}
                                disabled={classifyingId === `catalog-${image.id}`}
                                style={{ width: "100%", marginTop: "0.3rem", fontSize: "0.72rem" }}
                              >
                                <option value="" disabled>
                                  {classifyingId === `catalog-${image.id}` ? "Salvando…" : "Classificar…"}
                                </option>
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
    </>
  );
}
