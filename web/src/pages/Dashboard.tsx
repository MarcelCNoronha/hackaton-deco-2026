import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  api,
  type CatalogPlatform,
  type Connection,
  type EnrichmentRun,
  type OptimizationAnalytics,
  type OptimizationAnalyticsTier,
  type ProviderSpend,
} from "../api/client";
import { StatTile } from "../components/StatTile";
import { StatusBadge } from "../components/StatusBadge";
import { ToolStatusGrid } from "../components/ToolStatusGrid";
import { formatCost } from "../lib/currency";
import { useAuth } from "../context/AuthContext";

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  gemini: "Google (Gemini)",
};

const TIER_LABELS: Record<OptimizationAnalyticsTier, string> = {
  quality: "Qualidade",
  balanced: "Equilibrado",
  price: "Preco",
  unknown: "Fora do trio",
};

const NUMBER = new Intl.NumberFormat("pt-BR");

function formatNumber(value: number): string {
  return NUMBER.format(value);
}

function monthLabel(value: string): string {
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return value;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("pt-BR", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function Dashboard() {
  const { can } = useAuth();
  const [runs, setRuns] = useState<EnrichmentRun[]>([]);
  const [optimizedCount, setOptimizedCount] = useState(0);
  const [spendLimits, setSpendLimits] = useState<ProviderSpend[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [catalogPlatform, setCatalogPlatform] = useState<CatalogPlatform>("vtex");
  const [analytics, setAnalytics] = useState<OptimizationAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.listRuns(),
      api.optimizedProductCount(),
      api.getSpendLimits(),
      api.listConnections(),
      api.getCatalogPlatform(),
      api.optimizationAnalytics(),
    ]).then(([runsResult, optimized, spend, connectionsResult, { platform }, analyticsResult]) => {
      setRuns(runsResult);
      setOptimizedCount(optimized.count);
      setSpendLimits(spend);
      setConnections(connectionsResult);
      setCatalogPlatform(platform);
      setAnalytics(analyticsResult);
      setLoading(false);
    });
  }, []);

  if (loading) return null;

  const totalRuns = runs.length;
  const failedRuns = runs.filter((r) => r.status === "failed").length;
  const runningRuns = runs.filter((r) => r.status === "running").length;
  const totalSpendUsd = spendLimits.reduce((sum, l) => sum + l.spentUsd, 0);
  const reusedTotal = runs.reduce((sum, r) => sum + (Number(r.summary?.reusedCount) || 0), 0);
  const recentRuns = runs.slice(0, 8);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Panorama das otimizações de catálogo e do custo de IA.</p>
        </div>
      </div>

      <div className="page-content">
        <ToolStatusGrid connections={connections} catalogPlatform={catalogPlatform} canManage={can("connections")} />

        <div className="stat-row">
          <StatTile label="Total de Otimizados" value={optimizedCount} />
          <StatTile label="Otimizações executadas" value={totalRuns} />
          <StatTile label="Em execução" value={runningRuns} />
          <StatTile label="Falharam" value={failedRuns} delta={failedRuns > 0 ? "revisar" : undefined} deltaGood={false} />
          <StatTile label="Gasto no mês (IA)" value={formatCost(totalSpendUsd)} />
          {reusedTotal > 0 && (
            <StatTile label="Reaproveitados (RAG)" value={reusedTotal} delta="menor custo" deltaGood />
          )}
        </div>

        {analytics && (
          <>
            <div className="stat-row">
              <StatTile label="Custo historico IA" value={formatCost(analytics.totals.costUsd)} />
              <StatTile label="Chamadas IA" value={formatNumber(analytics.totals.calls)} />
              <StatTile label="Produtos no analytics" value={formatNumber(analytics.totals.optimizedProducts)} delta={analytics.platform.toUpperCase()} deltaGood />
              <StatTile label="Campos gerados" value={formatNumber(analytics.totals.proposals)} />
              <StatTile label="Imagens geradas" value={formatNumber(analytics.totals.images)} />
              {analytics.totals.unassignedCostUsd > 0 && (
                <StatTile label="Custo sem produto" value={formatCost(analytics.totals.unassignedCostUsd)} delta="fora do escopo" deltaGood={false} />
              )}
            </div>

            <div className="analytics-grid">
              <section className="card">
                <h2>Historico mes a mes</h2>
                {analytics.byMonth.length === 0 ? (
                  <p className="muted">Ainda nao ha custo de IA vinculado a produto na plataforma ativa.</p>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Mes</th>
                          <th>Custo</th>
                          <th>Chamadas</th>
                          <th>Produtos</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...analytics.byMonth].reverse().map((row) => (
                          <tr key={row.month}>
                            <td>{monthLabel(row.month)}</td>
                            <td>{formatCost(row.costUsd)}</td>
                            <td className="muted">{formatNumber(row.calls)}</td>
                            <td className="muted">{formatNumber(row.products)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="card">
                <h2>Volume por campo</h2>
                {analytics.byField.length === 0 ? (
                  <p className="muted">Nenhum campo otimizado ainda para a plataforma ativa.</p>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Campo</th>
                          <th>Total</th>
                          <th>Produtos</th>
                          <th>Publicados</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.byField.map((row) => (
                          <tr key={row.field}>
                            <td>{row.label}</td>
                            <td>{formatNumber(row.count)}</td>
                            <td className="muted">{formatNumber(row.products)}</td>
                            <td className="muted">{formatNumber(row.published)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="card analytics-grid-wide">
                <h2>Custo por provedor e modelo</h2>
                {analytics.byProviderModel.length === 0 ? (
                  <p className="muted">Ainda nao ha chamadas pagas de IA na plataforma ativa.</p>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Provedor</th>
                          <th>Modelo</th>
                          <th>Nivel</th>
                          <th>Custo</th>
                          <th>Chamadas</th>
                          <th>Tokens</th>
                          <th>Produtos</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.byProviderModel.map((row) => (
                          <tr key={`${row.provider}:${row.model ?? "unknown"}`}>
                            <td>{PROVIDER_LABELS[row.provider] ?? row.provider}</td>
                            <td>{row.model ?? "Sem modelo"}</td>
                            <td className="muted">{TIER_LABELS[row.tier]}</td>
                            <td>{formatCost(row.costUsd)}</td>
                            <td className="muted">{formatNumber(row.calls)}</td>
                            <td className="muted">{formatNumber(row.inputTokens + row.outputTokens)}</td>
                            <td className="muted">{formatNumber(row.products)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          </>
        )}

        <section className="card">
          <h2>Gasto por provedor neste mês</h2>
          {spendLimits.length === 0 ? (
            <p className="muted">Nenhum provedor de IA conectado ainda.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Provedor</th>
                  <th>Gasto</th>
                  <th>Limite mensal</th>
                </tr>
              </thead>
              <tbody>
                {spendLimits.map((l) => (
                  <tr key={l.provider}>
                    <td>{PROVIDER_LABELS[l.provider] ?? l.provider}</td>
                    <td>{formatCost(l.spentUsd)}</td>
                    <td className="muted">{l.limitUsd !== null ? formatCost(l.limitUsd) : "Sem limite"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <h2>Atividade recente</h2>
          {recentRuns.length === 0 ? (
            <p className="muted">Nenhuma otimização rodada ainda — comece pela aba Produtos.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Iniciado em</th>
                  <th>Produtos</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((run) => (
                  <tr key={run.id}>
                    <td>#{run.id}</td>
                    <td>
                      <StatusBadge kind="run" status={run.status} />
                    </td>
                    <td className="muted">{new Date(run.startedAt).toLocaleString("pt-BR")}</td>
                    <td className="muted">{run.processedCount}</td>
                    <td>
                      <Link to={`/runs/${run.id}`} className="link-button">
                        Ver
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
