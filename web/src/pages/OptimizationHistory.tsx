import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api, type CatalogFilterOptions, type CatalogPlatform, type EnrichmentRun } from "../api/client";
import { StatTile } from "../components/StatTile";
import { StatusBadge } from "../components/StatusBadge";
import { CatalogFilterBar } from "../components/CatalogFilterBar";
import { formatCost } from "../lib/currency";

export function OptimizationHistory() {
  const [runs, setRuns] = useState<EnrichmentRun[]>([]);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [filters, setFilters] = useState<CatalogFilterOptions | null>(null);
  const [platform, setPlatform] = useState<CatalogPlatform>("vtex");

  // Background polling always re-applies whatever was last searched, without refetching on every
  // keystroke — the ref sidesteps the interval closure going stale without needing a draft/applied
  // state split like a controlled form would.
  const activeFilter = useRef({ search, categoryId, brandId });

  async function refresh() {
    const f = activeFilter.current;
    setRuns(await api.listRuns({ search: f.search || undefined, categoryId: f.categoryId || undefined, brandId: f.brandId || undefined }));
  }

  useEffect(() => {
    api.catalogFilters()
      .then(setFilters)
      .catch(() => setFilters({ categories: [], brands: [] }));
    api.getCatalogPlatform().then(({ platform }) => setPlatform(platform));
    refresh().catch((err) => console.error("Failed to refresh run history", err));
    const interval = setInterval(() => {
      refresh().catch((err) => console.error("Failed to refresh run history", err));
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    activeFilter.current = { search, categoryId, brandId };
    refresh();
  }

  const running = runs.filter((r) => r.status === "running").length;
  const succeeded = runs.filter((r) => r.status === "success").length;
  const needsAttention = runs.filter((r) => r.status === "failed" || r.status === "partial").length;

  function runCost(run: EnrichmentRun): number | null {
    const value = run.summary?.totalCostUsd;
    return typeof value === "number" ? value : null;
  }
  const totalCost = runs.reduce((sum, r) => sum + (runCost(r) ?? 0), 0);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Histórico de otimizações</h1>
          <p className="muted">Todas as execuções de otimização de IA, com status, duração e custo.</p>
        </div>
      </div>

      <div className="page-content">
        <div className="stat-row">
          <StatTile label="Em execução" value={running} />
          <StatTile label="Concluídos" value={succeeded} />
          <StatTile
            label="Precisam de atenção"
            value={needsAttention}
            deltaGood={needsAttention === 0}
            delta={needsAttention > 0 ? `${needsAttention} otimização(ões)` : undefined}
          />
          <StatTile label="Custo total (IA)" value={formatCost(totalCost)} />
        </div>

        <section className="card">
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

          {runs.length === 0 ? (
            <div className="empty-state">Nenhuma otimização ainda — crie uma na tela de Produtos.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Status</th>
                  <th>Início</th>
                  <th>Duração</th>
                  <th>Processados</th>
                  <th>Custo</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>#{run.id}</td>
                    <td>
                      <StatusBadge kind="run" status={run.status} />
                    </td>
                    <td>{new Date(run.startedAt).toLocaleString("pt-BR")}</td>
                    <td>{run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : "—"}</td>
                    <td>{run.processedCount}</td>
                    <td>{runCost(run) !== null ? formatCost(runCost(run)!) : "—"}</td>
                    <td>
                      <Link to={`/runs/${run.id}`} className="link-button">
                        Revisar
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}
