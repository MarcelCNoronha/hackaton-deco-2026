import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  api,
  ApiError,
  type CatalogPlatform,
  type ContentScore,
  type EnrichmentProposal,
  type EnrichmentRun,
  type GeneratedImage,
  type Product,
  type RunCosts,
} from "../api/client";
import { StatTile } from "../components/StatTile";
import { StatusBadge } from "../components/StatusBadge";
import { ScoreCompare } from "../components/ScoreCompare";
import { formatCost } from "../lib/currency";

const FIELD_LABELS: Record<EnrichmentProposal["field"], string> = {
  description: "Descrição",
  alt_text: "Alt-text de imagem",
  structured_data: "Dados estruturados (schema.org)",
  faq: "FAQ (GEO)",
  benefit_bullets: "Bullets de benefício",
  technical_specs: "Especificações técnicas",
};

/** description/alt_text store plain text in proposedValue; the rest store a JSON-encoded value —
 *  this renders a readable preview for those instead of showing raw JSON in the diff view. The
 *  underlying textarea below still lets a reviewer edit the raw JSON directly if needed. */
function ProposalPreview({ proposal }: { proposal: EnrichmentProposal }) {
  if (proposal.field === "description" || proposal.field === "alt_text") return null;

  try {
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
  const [generatingFor, setGeneratingFor] = useState<Record<number, "lifestyle" | "feature_callout" | undefined>>({});
  const [imageGenError, setImageGenError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh() {
    const [runData, proposalsData, scoresData, costsData] = await Promise.all([
      api.getRun(runId),
      api.listProposals(runId),
      api.listScores(runId),
      api.runCosts(runId),
    ]);
    setRun(runData);
    setProposals(proposalsData);
    setScores(scoresData);
    setCosts(costsData);
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
  }, [proposals]);

  /** Generates a new marketing image FROM the product's existing photos (never from scratch) —
   *  "lifestyle" places it in a realistic use setting, "feature_callout" highlights one detail. */
  async function handleGenerateImage(productId: number, kind: "lifestyle" | "feature_callout") {
    setImageGenError(null);
    setGeneratingFor((prev) => ({ ...prev, [productId]: kind }));
    try {
      const image = await api.generateImage(productId, { kind });
      setGeneratedImages((prev) => ({ ...prev, [productId]: [image, ...(prev[productId] ?? [])] }));
    } catch (err) {
      setImageGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingFor((prev) => ({ ...prev, [productId]: undefined }));
    }
  }

  async function review(proposal: EnrichmentProposal, status: "approved" | "rejected" | "edited") {
    const proposedValue = status === "edited" ? drafts[proposal.id] ?? proposal.proposedValue : undefined;
    await api.reviewProposal(proposal.id, { status, proposedValue });
    refresh();
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
          <button type="button" onClick={handlePublish} disabled={approvedCount === 0 || runInProgress}>
            Publicar aprovadas na {PLATFORM_LABELS[platform]}
          </button>
        </div>
        {publishError && <div className="banner">{publishError}</div>}
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
                    {proposed.attempts > 1 && (
                      <span className="pill">
                        Refinado automaticamente em {proposed.attempts} tentativas até atingir score {proposed.overallScore}
                      </span>
                    )}
                  </div>
                  <ScoreCompare label="Score geral" before={original.overallScore} after={proposed.overallScore} />
                  <ScoreCompare label="Checklist estrutural" before={original.checklistScore} after={proposed.checklistScore} />
                  <ScoreCompare label="Confiança do comprador" before={original.buyerConfidence} after={proposed.buyerConfidence} />
                  <ScoreCompare
                    label="Perguntas respondidas (GEO)"
                    before={original.geoAnswerableCount}
                    after={proposed.geoAnswerableCount}
                    max={proposed.geoTotalQuestions}
                  />
                  {proposed.unsupportedClaims.length > 0 && (
                    <p className="muted" style={{ color: "var(--status-warning)" }}>
                      ⚠ Possível alucinação — revisar: {proposed.unsupportedClaims.join("; ")}
                    </p>
                  )}
                </div>
              )}

              <div className="card" style={{ background: "var(--surface-2)", margin: "0 0 1rem" }}>
                <div className="proposal-header">
                  <h3 style={{ margin: 0 }}>Fotos geradas por IA</h3>
                  <div className="actions" style={{ marginTop: 0 }}>
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
                      onClick={() => handleGenerateImage(productId, "feature_callout")}
                      disabled={generatingFor[productId] !== undefined}
                    >
                      {generatingFor[productId] === "feature_callout" ? "Gerando…" : "🎯 Gerar foto de destaque"}
                    </button>
                  </div>
                </div>
                {(generatedImages[productId]?.length ?? 0) === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>
                    Nenhuma imagem gerada ainda para este produto.
                  </p>
                ) : (
                  <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                    {generatedImages[productId]!.map((image) => (
                      <div key={image.id} style={{ width: 160 }}>
                        <img
                          src={`data:${image.mimeType};base64,${image.imageBase64}`}
                          alt={image.kind === "lifestyle" ? "Foto ambientada gerada por IA" : "Foto de destaque gerada por IA"}
                          style={{ width: "100%", height: 160, objectFit: "cover", borderRadius: "var(--radius-md)" }}
                        />
                        <div className="muted" style={{ fontSize: "0.72rem", marginTop: "0.3rem" }}>
                          {image.kind === "lifestyle" ? "Ambientada" : "Destaque"} · {formatCost(Number(image.costUsd ?? 0))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
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
