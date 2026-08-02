import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type CatalogFilterOptions,
  type CatalogListResult,
  type CatalogProductSummary,
  type EnrichmentField,
  type FreeQuotaStatus,
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

  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [filters, setFilters] = useState<CatalogFilterOptions | null>(null);
  const [page, setPage] = useState(1);
  const [listResult, setListResult] = useState<CatalogListResult | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

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

  async function refreshQuotaAlerts() {
    const quotas = await api.getFreeQuotas();
    setExhaustedQuotas(quotas.filter((q) => q.enabled && q.exhausted));
  }

  async function refreshOptimizedCount() {
    setOptimizedCount((await api.optimizedProductCount()).count);
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
      const result = await api.listCatalogProducts({
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
    refreshOptimizedCount();
    refreshQuotaAlerts();
    loadFilters();
    loadProducts(1);
    const interval = setInterval(() => {
      refreshOptimizedCount();
      refreshQuotaAlerts();
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

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

  function confirmSingleOptimize(fields: EnrichmentField[], includeAltText: boolean) {
    const externalId = pendingSingle;
    setPendingSingle(null);
    if (!externalId || optimizingRef.current.has(externalId)) return;
    optimizingRef.current.add(externalId);
    setOptimizingIds(new Set(optimizingRef.current));
    setRunError(null);
    api
      .createRun({ candidateProductIds: [externalId], fields, includeAltText })
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

  function confirmBulkOptimize(fields: EnrichmentField[], includeAltText: boolean) {
    setPendingBulk(false);
    setCreating(true);
    setRunError(null);
    const body = selectAllMatching
      ? {
          catalogFilter: { search: search || undefined, categoryId: categoryId || undefined, brandId: brandId || undefined },
          topN: topN ? Number(topN) : undefined,
          fields,
          includeAltText,
        }
      : { candidateProductIds: [...selectedIds], topN: topN ? Number(topN) : undefined, fields, includeAltText };

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
          <StatTile label="Total de Otimizados" value={optimizedCount} />
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
          />

          <div className="actions" style={{ marginTop: "0.6rem", alignItems: "center" }}>
            <span className="muted" style={{ fontSize: "0.8rem" }}>
              Status:
            </span>
            {(Object.keys(STATUS_GROUP_LABELS) as StatusGroup[]).map((group) => (
              <button
                key={group}
                type="button"
                className={statusFilter.has(group) ? "" : "secondary"}
                onClick={() =>
                  setStatusFilter((prev) => {
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

          {catalogError && (
            <div className="banner" style={{ marginTop: "0.75rem" }}>
              {catalogError} — configure a plataforma ativa no painel de Integrações.
            </div>
          )}

          {!catalogError && listResult && (
            <>
              <table style={{ marginTop: "0.75rem" }}>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        checked={selectAllMatching}
                        onChange={toggleSelectAllMatching}
                        title="Selecionar todos os produtos deste filtro"
                      />
                    </th>
                    <th></th>
                    <th>SKU / Produto</th>
                    <th>Categoria</th>
                    <th>Marca</th>
                    <th>Otimização</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((item) => (
                    <tr key={item.externalId}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectAllMatching || selectedIds.has(item.externalId)}
                          disabled={selectAllMatching}
                          onChange={() => toggleSelect(item.externalId)}
                        />
                      </td>
                      <td>
                        {item.imageUrl ? (
                          <img src={item.imageUrl} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: "var(--radius-sm)" }} />
                        ) : (
                          <div style={{ width: 40, height: 40, background: "var(--surface-2)", borderRadius: "var(--radius-sm)" }} />
                        )}
                      </td>
                      <td>
                        <div className="muted" style={{ fontSize: "0.75rem" }}>
                          {item.sku ? shortId(item.sku) : `Sem SKU (${shortId(item.externalId)})`}
                        </div>
                        <div>{item.title}</div>
                      </td>
                      <td className="muted">{item.category ?? "—"}</td>
                      <td className="muted">{item.brand ?? "—"}</td>
                      <td>
                        {item.optimizedAt ? (
                          <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start" }}>
                            <div>
                              <div
                                style={{
                                  fontWeight: 600,
                                  color: item.optimizationStatus === "published" ? "var(--status-good)" : "var(--status-critical)",
                                }}
                              >
                                {item.optimizationStatus === "published" ? "Pronta e enviada" : "A validar"}
                              </div>
                              <div className="muted" style={{ fontSize: "0.8rem" }}>
                                {new Date(item.optimizedAt).toLocaleDateString("pt-BR")}
                              </div>
                              <div className="muted" style={{ fontSize: "0.8rem" }}>
                                {formatCost(item.optimizationCostUsd ?? 0)}
                              </div>
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
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
                              <button
                                type="button"
                                className="link-button"
                                onClick={() => handleOptimizeOne(item.externalId)}
                                disabled={optimizingIds.has(item.externalId)}
                              >
                                {optimizingIds.has(item.externalId) ? "Enviando…" : "Refazer"}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => handleOptimizeOne(item.externalId)}
                            disabled={optimizingIds.has(item.externalId)}
                          >
                            {optimizingIds.has(item.externalId) ? "Enviando…" : "Otimizar"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {visibleItems.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted">
                        Nenhum produto encontrado para esse filtro.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

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
          onConfirm={({ fields, includeAltText }) => confirmSingleOptimize(fields, includeAltText)}
        />
      )}
      {pendingBulk && (
        <OptimizationFieldSelector
          productCount={selectAllMatching ? (topN ? Number(topN) : 50) : selectedIds.size}
          confirmLabel="Confirmar otimização"
          onCancel={() => setPendingBulk(false)}
          onConfirm={({ fields, includeAltText }) => confirmBulkOptimize(fields, includeAltText)}
        />
      )}
    </>
  );
}
