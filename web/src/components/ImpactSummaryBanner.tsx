import { StatTile } from "./StatTile";
import type { ImpactSummary } from "../api/client";

function formatDelta(deltaPct: number): string {
  return `${deltaPct >= 0 ? "+" : ""}${deltaPct}%`;
}

/** "Confiança de conteúdo" banner — aggregate before/after deltas across every product with both an
 *  original and a proposed content_scores row in scope (one run, or the whole account — see
 *  impact-summary.repo.ts). Deliberately NOT called "Impacto" — every number here is the AI judging
 *  its own before/after text, available instantly; the real, Google-data impact (which takes days
 *  to mature) lives in RealImpactPanel/impact.agent.ts. Reuses StatTile/.stat-row exactly like every
 *  other stat block in this app instead of introducing a new chart component. */
export function ImpactSummaryBanner({ summary }: { summary: ImpactSummary }) {
  if (summary.productCount === 0) return null;

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div className="proposal-header">
        <h3 style={{ margin: 0 }}>Confiança de conteúdo (estimada por IA)</h3>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {summary.productCount} {summary.productCount === 1 ? "produto otimizado" : "produtos otimizados"}
        </span>
      </div>
      <div className="stat-row">
        <StatTile
          label="Completude do catálogo"
          value={`${summary.requiredAttributesFilledPct}%`}
          delta={formatDelta(summary.completudeDeltaPct)}
          deltaGood={summary.completudeDeltaPct >= 0}
        />
        <StatTile
          label="Cobertura SEO"
          value={formatDelta(summary.seoDeltaPct)}
          delta={summary.seoDeltaPct >= 0 ? "melhora" : "piora"}
          deltaGood={summary.seoDeltaPct >= 0}
        />
        <StatTile
          label="Cobertura GEO"
          value={formatDelta(summary.geoDeltaPct)}
          delta={summary.geoDeltaPct >= 0 ? "melhora" : "piora"}
          deltaGood={summary.geoDeltaPct >= 0}
        />
        <StatTile
          label="Potencial de conversão"
          value={formatDelta(summary.conversionDeltaPct)}
          delta={summary.conversionDeltaPct >= 0 ? "melhora" : "piora"}
          deltaGood={summary.conversionDeltaPct >= 0}
        />
        <StatTile
          label="Consistência dos dados"
          value={formatDelta(summary.consistencyDeltaPct)}
          delta={summary.consistencyDeltaPct >= 0 ? "melhora" : "piora"}
          deltaGood={summary.consistencyDeltaPct >= 0}
        />
        <StatTile
          label="Tempo economizado (estimado)"
          value={`${summary.estimatedTimeSavedPct}%`}
          delta={`${summary.estimatedTimeSavedMinutes} min`}
          deltaGood={summary.estimatedTimeSavedMinutes >= 0}
        />
      </div>
    </div>
  );
}
