import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type CatalogFilterOptions,
  type CatalogListResult,
  type CatalogPlatform,
  type CatalogProductSummary,
  type CommunicationTone,
  type DescriptionRichness,
  type EnrichmentField,
  type FreeQuotaStatus,
  type ImageGenKind,
} from "../api/client";
import { StatTile } from "../components/StatTile";
import { CatalogFilterBar } from "../components/CatalogFilterBar";
import { OptimizationFieldSelector } from "../components/OptimizationFieldSelector";
import { shortId } from "../lib/format";
import { formatCost } from "../lib/currency";

const PAGE_SIZE = 12;

function toneStyle(tone: "good" | "warning" | "critical"): React.CSSProperties {
  const color = `var(--status-${tone})`;
  return { color, borderColor: color };
}

type StatusGroup = "none" | "pending" | "published";

const STATUS_GROUP_LABELS: Record<StatusGroup, string> = {
  none: "Não otimizado",
  pending: "A validar",
  published: "Pronta e enviada",
};

function statusGroupOf(item: CatalogProductSummary): StatusGroup {
  if (!item.optimizedAt) return "none";
  return item.optimizationStatus === "published" ? "published" : "pending";
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Claude",
  openai: "GPT",
  gemini: "Gemini",
};

function formatResetIn(resetAt: string): string {
  const ms = Math.max(0, new Date(resetAt).getTime() - Date.now());
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const resetTime = new Date(resetAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${hours}h${minutes.toString().padStart(2, "0")}min (às ${resetTime})`;
}

export function Runs() {
  const [optimizedCount, setOptimizedCount] = useState(0);
  const [pendingReviewCount, setPendingReviewCount] = useState(0);
  const [avgPrecision, setAvgPrecision] = useState<number | null>(null);

  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [filters, setFilters] = useState<CatalogFilterOptions | null>(null);
  const [page, setPage] = useState(1);
  const [listResult, setListResult] = useState<CatalogListResult | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<CatalogPlatform>("vtex");

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [statusFilter, setStatusFilter] = useState<Set<StatusGroup>>(new Set(["none", "pending", "published"]));
  const [topN, setTopN] = useState("");
  const [creating, setCreating] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [exhaustedQuotas, setExhaustedQuotas] = useState<FreeQuotaStatus[]>([]);
  const [optimizingIds, setOptimizingIds] = useState<Set<string>>(new Set());
  // React state updates aren't applied synchronously, so a fast double-click can fire the
  // handler twice before the `disabled` attribute actually reaches the DOM — this ref is mutated
  // immediately, so the guard below is never fooled by render timing.
  const optimizingRef = useRef<Set<string>>(new Set());
  // Set while the field-selector modal is open for a single-row "Otimizar"/"Refazer" click;
  // holds the externalId so confirmSingleOptimize knows which product to run.
  const [pendingSingle, setPendingSingle] = useState<string | null>(null);
  const [pendingBulk, setPendingBulk] = useState(false);

  // Which product-row's "referência do fabricante" editor is open, and its draft value — only one
  // open at a time keeps the list from getting cluttered with an input per row.
  const [editingReferenceId, setEditingReferenceId] = useState<string | null>(null);
  const [referenceUrlDraft, setReferenceUrlDraft] = useState("");
  const [savingReferenceId, setSavingReferenceId] = useState<string | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);

  function openReferenceEditor(externalId: string, currentUrl: string | null) {
    setEditingReferenceId(externalId);
    setReferenceUrlDraft(currentUrl ?? "");
    setReferenceError(null);
  }

  async function handleSaveReference(externalId: string) {
    setSavingReferenceId(externalId);
    setReferenceError(null);
    try {
      const result = await api.setManufacturerReference(externalId, referenceUrlDraft.trim() || null);
      setListResult((prev) =>
        prev
          ? { ...prev, items: prev.items.map((it) => (it.externalId === externalId ? { ...it, manufacturerReferenceUrl: result.manufacturerReferenceUrl } : it)) }
          : prev,
      );
      if (result.warning) setReferenceError(result.warning);
      else setEditingReferenceId(null);
    } catch (err) {
      setReferenceError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingReferenceId(null);
    }
  }

  async function refreshQuotaAlerts() {
    const quotas = await api.getFreeQuotas();
    setExhaustedQuotas(quotas.filter((q) => q.enabled && q.exhausted));
  }

  async function refreshOptimizedCount() {
    setOptimizedCount((await api.optimizedProductCount()).count);
  }

  async function refreshPendingReviewCount() {
    setPendingReviewCount((await api.pendingReviewCount()).count);
  }

  /** "Taxa de precisão" — average final content score across completed runs (already computed
   *  per run by the quality-gate loop, see enrichment-run.orchestrator.ts's avgFinalContentScore).
   *  Reuses the existing runs list endpoint rather than adding a dedicated aggregate one. */
  async function refreshAvgPrecision() {
    const runs = await api.listRuns();
    const scores = runs
      .map((r) => (r.summary as { avgFinalContentScore?: number } | null)?.avgFinalContentScore)
      .filter((v): v is number => typeof v === "number");
    setAvgPrecision(scores.length ? scores.reduce((sum, v) => sum + v, 0) / scores.length : null);
  }

  async function loadFilters() {
    try {
      setFilters(await api.catalogFilters());
    } catch {
      setFilters({ categories: [], brands: [] });
    }
  }

  async function loadProducts(targetPage: number) {
    setLoadingList(true);
    setCatalogError(null);
    try {
      // "A Validar"/"Pronta e enviada" (filter narrowed to exactly one of these) query our own
      // snapshot directly instead of the live catalog browse — see api.listProductsByStatus's doc
      // comment for why: paginating the raw catalog and filtering client-side only ever showed
      // matches that happened to land on the current page, missing most of them on any real
      // catalog. Search/category/brand filters don't apply in this mode yet.
      const onlyStatus = statusFilter.size === 1 ? [...statusFilter][0] : null;
      const result =
        onlyStatus === "pending" || onlyStatus === "published"
          ? await api.listProductsByStatus({ status: onlyStatus, page: targetPage, pageSize: PAGE_SIZE })
          : await api.listCatalogProducts({
              search: search || undefined,
              categoryId: categoryId || undefined,
              brandId: brandId || undefined,
              page: targetPage,
              pageSize: PAGE_SIZE,
            });
      setListResult(result);
      setPage(targetPage);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : String(err));
      setListResult(null);
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => {
    function refreshStats() {
      refreshOptimizedCount().catch((err) => console.error("Failed to refresh stats", err));
      refreshPendingReviewCount().catch((err) => console.error("Failed to refresh stats", err));
      refreshAvgPrecision().catch((err) => console.error("Failed to refresh stats", err));
      refreshQuotaAlerts().catch((err) => console.error("Failed to refresh stats", err));
    }
    refreshStats();
    loadFilters();
    loadProducts(1);
    api.getCatalogPlatform().then(({ platform }) => setPlatform(platform));
    const interval = setInterval(refreshStats, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Re-fetches whenever the status filter changes — needed now that "A Validar"/"Pronta e
  // enviada" hit a different endpoint (see loadProducts) instead of just re-filtering
  // already-loaded items client-side. Skips the very first run so it doesn't duplicate the mount
  // effect's own initial loadProducts(1) call above.
  const statusFilterMounted = useRef(false);
  useEffect(() => {
    if (!statusFilterMounted.current) {
      statusFilterMounted.current = true;
      return;
    }
    loadProducts(1);
  }, [statusFilter]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    loadProducts(1);
  }

  function toggleSelect(externalId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(externalId)) next.delete(externalId);
      else next.add(externalId);
      return next;
    });
  }

  function toggleSelectAllMatching() {
    setSelectAllMatching((prev) => {
      const next = !prev;
      if (next) setSelectedIds(new Set());
      return next;
    });
  }


  /** Opens the field-selector modal for a single-product run from the row — works both for a
   *  never-optimized product and to redo an already-optimized one. The actual run is only fired
   *  from confirmSingleOptimize, once the user picks fields and confirms. */
  function handleOptimizeOne(externalId: string) {
    if (optimizingRef.current.has(externalId)) return;
    setPendingSingle(externalId);
  }

  function confirmSingleOptimize(
    fields: EnrichmentField[],
    includeAltText: boolean,
    imageKinds: ImageGenKind[],
    descriptionRichness: DescriptionRichness,
    communicationTone: CommunicationTone,
  ) {
    const externalId = pendingSingle;
    setPendingSingle(null);
    if (!externalId || optimizingRef.current.has(externalId)) return;
    optimizingRef.current.add(externalId);
    setOptimizingIds(new Set(optimizingRef.current));
    setRunError(null);
    api
      .createRun({ candidateProductIds: [externalId], fields, includeAltText, imageKinds, descriptionRichness, communicationTone })
      .then(() => {
        refreshOptimizedCount();
        loadProducts(page);
      })
      .catch((err) => setRunError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        optimizingRef.current.delete(externalId);
        setOptimizingIds((prev) => {
          const next = new Set(prev);
          next.delete(externalId);
          return next;
        });
      });
  }

  function handleCreateRun() {
    if (!selectAllMatching && selectedIds.size === 0) return;
    setPendingBulk(true);
  }

  function confirmBulkOptimize(
    fields: EnrichmentField[],
    includeAltText: boolean,
    imageKinds: ImageGenKind[],
    descriptionRichness: DescriptionRichness,
    communicationTone: CommunicationTone,
  ) {
    setPendingBulk(false);
    setCreating(true);
    setRunError(null);
    const body = selectAllMatching
      ? {
          catalogFilter: { search: search || undefined, categoryId: categoryId || undefined, brandId: brandId || undefined },
          topN: topN ? Number(topN) : undefined,
          fields,
          includeAltText,
          imageKinds,
          descriptionRichness,
          communicationTone,
        }
      : {
          candidateProductIds: [...selectedIds],
          topN: topN ? Number(topN) : undefined,
          fields,
          includeAltText,
          imageKinds,
          descriptionRichness,
          communicationTone,
        };

    api
      .createRun(body)
      .then(() => {
        setSelectedIds(new Set());
        setSelectAllMatching(false);
        setTopN("");
        refreshOptimizedCount();
        loadProducts(page);
      })
      .catch((err) => setRunError(err instanceof Error ? err.message : String(err)))
      .finally(() => setCreating(false));
  }

  const visibleItems = listResult?.items.filter((item) => statusFilter.has(statusGroupOf(item))) ?? [];

  return (
    <>
      {exhaustedQuotas.length > 0 && (
        <div className="floating-alerts">
          {exhaustedQuotas.map((q) => (
            <div key={q.provider} className="floating-alert">
              <strong>Franquia {PROVIDER_NAMES[q.provider] ?? q.provider} esgotada</strong>
              <div className="muted" style={{ marginTop: "0.25rem" }}>
                Reseta em {formatResetIn(q.resetAt)}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="page-header">
        <div>
          <h1>Produtos</h1>
          <p className="muted">Encontre produtos do catálogo e rode a otimização de IA — o histórico de execuções fica na aba Histórico.</p>
        </div>
      </div>

      <div className="page-content">
        <div className="stat-row">
          <StatTile label="Total Otimizados" value={optimizedCount} />
          <StatTile label="A Validar" value={pendingReviewCount} />
          <StatTile label="Taxa de Precisão" value={avgPrecision !== null ? `${Math.round(avgPrecision)}%` : "—"} />
          <div className="stat-tile status-filter-tile">
            <span className="stat-label">Filtro de Status</span>
            <div className="status-filter-pills">
              <button
                type="button"
                className={`pill-btn ${statusFilter.size === 3 ? "is-active" : ""}`}
                onClick={() => setStatusFilter(new Set(["none", "pending", "published"]))}
              >
                Todos
              </button>
              {(Object.keys(STATUS_GROUP_LABELS) as StatusGroup[]).map((group) => (
                <button
                  key={group}
                  type="button"
                  className={`pill-btn ${statusFilter.size !== 3 && statusFilter.has(group) ? "is-active" : ""}`}
                  onClick={() =>
                    setStatusFilter((prev) => {
                      // Coming from "Todos" (all 3 selected), clicking one filter narrows down to
                      // just that one — the opposite of a plain toggle, which would instead have
                      // *removed* it and left the other two selected (the one just clicked ending
                      // up the only unselected one, backwards from what clicking it should mean).
                      if (prev.size === 3) return new Set([group]);
                      const next = new Set(prev);
                      if (next.has(group)) next.delete(group);
                      else next.add(group);
                      return next;
                    })
                  }
                >
                  {STATUS_GROUP_LABELS[group]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <section className="card">
          <h2>Nova otimização</h2>

          <CatalogFilterBar
            search={search}
            setSearch={setSearch}
            categoryId={categoryId}
            setCategoryId={setCategoryId}
            brandId={brandId}
            setBrandId={setBrandId}
            filters={filters}
            onSubmit={handleSearch}
            platform={platform}
          />

          {catalogError && (
            <div className="banner" style={{ marginTop: "0.75rem" }}>
              {catalogError} — configure a plataforma ativa no painel de Integrações.
            </div>
          )}

          {!catalogError && listResult && (
            <>
              <label className="product-select-all">
                <input type="checkbox" checked={selectAllMatching} onChange={toggleSelectAllMatching} />
                Selecionar todos os produtos deste filtro
              </label>

              <div className="product-card-list">
                {visibleItems.map((item) => (
                  <div className="product-row-card" key={item.externalId}>
                    <input
                      type="checkbox"
                      className="product-row-checkbox"
                      checked={selectAllMatching || selectedIds.has(item.externalId)}
                      disabled={selectAllMatching}
                      onChange={() => toggleSelect(item.externalId)}
                    />
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt="" className="product-row-thumb" />
                    ) : (
                      <div className="product-row-thumb product-row-thumb--empty" />
                    )}
                    <div className="product-row-main">
                      <div className="muted" style={{ fontSize: "0.72rem" }}>
                        {item.sku ? shortId(item.sku) : `Sem SKU (${shortId(item.externalId)})`}
                      </div>
                      <div className="product-row-title">{item.title}</div>
                      {/* Only shown here when there's no "Ver Ativo" action button already covering
                          the same link (published items) — avoids showing the same link twice. */}
                      {item.url && item.optimizationStatus !== "published" && (
                        <a href={item.url} target="_blank" rel="noreferrer" className="link-button" style={{ fontSize: "0.75rem" }}>
                          Ver na loja ↗
                        </a>
                      )}

                      {editingReferenceId === item.externalId ? (
                        <div style={{ marginTop: "0.35rem", display: "flex", flexDirection: "column", gap: "0.25rem", maxWidth: 260 }}>
                          <input
                            type="url"
                            placeholder="URL do fabricante (opcional)"
                            value={referenceUrlDraft}
                            onChange={(e) => setReferenceUrlDraft(e.target.value)}
                            style={{ fontSize: "0.75rem", padding: "0.3rem 0.5rem" }}
                          />
                          {referenceError && (
                            <div className="muted" style={{ fontSize: "0.7rem", color: "var(--status-warning)" }}>
                              {referenceError}
                            </div>
                          )}
                          <div style={{ display: "flex", gap: "0.4rem" }}>
                            <button
                              type="button"
                              style={{ fontSize: "0.72rem", padding: "0.25rem 0.6rem" }}
                              onClick={() => handleSaveReference(item.externalId)}
                              disabled={savingReferenceId === item.externalId}
                            >
                              {savingReferenceId === item.externalId ? "Analisando…" : "Salvar"}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              style={{ fontSize: "0.72rem", padding: "0.25rem 0.6rem" }}
                              onClick={() => setEditingReferenceId(null)}
                            >
                              Cancelar
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="link-button"
                          style={{ fontSize: "0.72rem", background: "transparent", border: "none", padding: 0, display: "block", marginTop: "0.2rem" }}
                          onClick={() => openReferenceEditor(item.externalId, item.manufacturerReferenceUrl)}
                        >
                          {item.manufacturerReferenceUrl ? "🏭 Referência definida" : "🏭 Definir referência do fabricante"}
                        </button>
                      )}
                    </div>
                    <div className="product-row-category">
                      <span className="muted" style={{ fontSize: "0.72rem" }}>
                        {platform === "shopify" ? "Coleção" : "Categoria"}
                      </span>
                      <div>{(platform === "shopify" ? item.collection : item.category) ?? "—"}</div>
                    </div>
                    <div className="product-row-brand">
                      <span className="muted" style={{ fontSize: "0.72rem" }}>
                        Marca
                      </span>
                      <div>{item.brand ?? "—"}</div>
                    </div>
                    <div className="product-row-status">
                      {item.optimizedAt ? (
                        <>
                          <span className={`pill tone-${item.optimizationStatus === "published" ? "good" : "warning"}`}>
                            {item.optimizationStatus === "published" ? "Pronta e enviada" : "A validar"}
                          </span>
                          <div className="muted" style={{ fontSize: "0.72rem", marginTop: "0.3rem" }}>
                            {new Date(item.optimizedAt).toLocaleDateString("pt-BR")} · {formatCost(item.optimizationCostUsd ?? 0)}
                          </div>
                          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.35rem", flexWrap: "wrap", justifyContent: "center" }}>
                            <Link
                              to={`/runs/${item.lastRunId}`}
                              className="link-button"
                              style={toneStyle(item.optimizationStatus === "published" ? "good" : "critical")}
                            >
                              Otimização
                            </Link>
                            {item.productId !== null && (
                              <Link
                                to={`/impact?productId=${item.productId}`}
                                className="link-button"
                                style={toneStyle(
                                  item.impactReadiness === "ready"
                                    ? "good"
                                    : item.impactReadiness === "partial"
                                      ? "warning"
                                      : "critical",
                                )}
                              >
                                Impacto
                              </Link>
                            )}
                          </div>
                        </>
                      ) : (
                        <span className="pill tone-muted">Não otimizado</span>
                      )}
                    </div>
                    <div className="product-row-action">
                      {item.optimizationStatus === "published" && item.url ? (
                        <>
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noreferrer"
                            className="link-button"
                            style={{ display: "block", fontSize: "0.85rem", padding: "0.55rem 1.1rem", ...toneStyle("good") }}
                          >
                            Ver Ativo ↗
                          </a>
                          <button
                            type="button"
                            className="link-button"
                            style={{
                              display: "block",
                              marginTop: "0.4rem",
                              background: "transparent",
                              border: "none",
                              color: "var(--status-warning)",
                            }}
                            onClick={() => handleOptimizeOne(item.externalId)}
                            disabled={optimizingIds.has(item.externalId)}
                          >
                            {optimizingIds.has(item.externalId) ? "Enviando…" : "🪄 Refazer"}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          style={item.optimizedAt ? { background: "var(--status-warning)" } : undefined}
                          onClick={() => handleOptimizeOne(item.externalId)}
                          disabled={optimizingIds.has(item.externalId)}
                        >
                          {optimizingIds.has(item.externalId) ? "Enviando…" : `🪄 ${item.optimizedAt ? "Refazer" : "Otimizar"}`}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {visibleItems.length === 0 && <div className="empty-state">Nenhum produto encontrado para esse filtro.</div>}
              </div>

              <div className="actions" style={{ marginTop: "0.75rem" }}>
                <button type="button" className="secondary" onClick={() => loadProducts(page - 1)} disabled={page <= 1 || loadingList}>
                  ← Anterior
                </button>
                <span className="muted">
                  Página {page}
                  {listResult.total ? ` · ${listResult.total} produtos no filtro` : ""}
                </span>
                <button type="button" className="secondary" onClick={() => loadProducts(page + 1)} disabled={!listResult.hasMore || loadingList}>
                  Próxima →
                </button>
                {!selectAllMatching && selectedIds.size > 0 && (
                  <button type="button" className="secondary" onClick={() => setSelectedIds(new Set())}>
                    Limpar seleção ({selectedIds.size})
                  </button>
                )}
              </div>
            </>
          )}

          <div className="form-grid" style={{ marginTop: "1rem" }}>
            <input
              placeholder="Top N (opcional — prioriza via GSC/GA4; padrão 50 quando 'selecionar todos' está ativo)"
              value={topN}
              onChange={(e) => setTopN(e.target.value)}
            />
          </div>
          {runError && <div className="banner">{runError}</div>}
          <div className="actions" style={{ marginTop: "0.5rem" }}>
            <button
              type="button"
              onClick={handleCreateRun}
              disabled={creating || (!selectAllMatching && selectedIds.size === 0) || !!catalogError}
            >
              {creating
                ? "Criando…"
                : `Otimização dos selecionados${selectAllMatching ? " (todos do filtro)" : selectedIds.size ? ` (${selectedIds.size})` : ""}`}
            </button>
          </div>
        </section>
      </div>

      {pendingSingle && (
        <OptimizationFieldSelector
          productCount={1}
          confirmLabel="Confirmar otimização"
          onCancel={() => setPendingSingle(null)}
          onConfirm={({ fields, includeAltText, imageKinds, descriptionRichness, communicationTone }) =>
            confirmSingleOptimize(fields, includeAltText, imageKinds, descriptionRichness, communicationTone)
          }
        />
      )}
      {pendingBulk && (
        <OptimizationFieldSelector
          productCount={selectAllMatching ? (topN ? Number(topN) : 50) : selectedIds.size}
          confirmLabel="Confirmar otimização"
          onCancel={() => setPendingBulk(false)}
          onConfirm={({ fields, includeAltText, imageKinds, descriptionRichness, communicationTone }) =>
            confirmBulkOptimize(fields, includeAltText, imageKinds, descriptionRichness, communicationTone)
          }
        />
      )}
    </>
  );
}
