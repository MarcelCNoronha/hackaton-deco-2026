import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type EnrichmentRun, type ProviderSpend } from "../api/client";
import { StatTile } from "../components/StatTile";
import { StatusBadge } from "../components/StatusBadge";
import { formatCost } from "../lib/currency";

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  gemini: "Google (Gemini)",
};

export function Dashboard() {
  const [runs, setRuns] = useState<EnrichmentRun[]>([]);
  const [optimizedCount, setOptimizedCount] = useState(0);
  const [spendLimits, setSpendLimits] = useState<ProviderSpend[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.listRuns(), api.optimizedProductCount(), api.getSpendLimits()]).then(
      ([runsResult, optimized, spend]) => {
        setRuns(runsResult);
        setOptimizedCount(optimized.count);
        setSpendLimits(spend);
        setLoading(false);
      },
    );
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
