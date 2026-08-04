import { StatTile } from "./StatTile";
import type { RealImpact } from "../api/client";

function pct(n: number | null): string {
  return n === null ? "—" : `${n >= 0 ? "+" : ""}${n}%`;
}

function money(n: number | null): string {
  return n === null ? "—" : `${n >= 0 ? "+" : ""}R$ ${n.toFixed(2)}`;
}

/** Per-product antes/depois panel fed by a LIVE GSC/GA4 comparison (see impact.agent.ts) — never a
 *  local snapshot. The two windows and the delta only exist once `status === "ready"`; the other
 *  states explain exactly why not yet, since "sem dados" alone doesn't say whether that's a data
 *  problem or just Google needing more time. */
export function RealImpactPanel({ impact }: { impact: RealImpact }) {
  if (impact.status === "no_url") {
    return (
      <div className="empty-state">
        Este produto não tem uma URL conhecida — não é possível cruzar com o Search Console/GA4.
      </div>
    );
  }

  if (impact.status === "not_published") {
    return (
      <div className="empty-state">
        Nenhum campo deste produto foi publicado ainda — o impacto real só existe a partir da
        primeira publicação (veja a aba de Revisão do run).
      </div>
    );
  }

  if (impact.status === "maturing") {
    return (
      <div className="empty-state">
        Publicado há {impact.daysSincePublish} {impact.daysSincePublish === 1 ? "dia" : "dias"} — o
        Google ainda está processando a mudança. Faltam {impact.daysUntilReady}{" "}
        {impact.daysUntilReady === 1 ? "dia" : "dias"} para a comparação ficar disponível.
      </div>
    );
  }

  const { before, after, deltas } = impact;
  if (!before || !after || !deltas) return null;

  return (
    <div>
      <p className="muted" style={{ marginTop: 0, fontSize: "0.82rem" }}>
        Antes: {before.startDate} a {before.endDate} · Depois: {after.startDate} a {after.endDate} — publicado há{" "}
        {impact.daysSincePublish} dias. Consulta em tempo real ao Google, sem armazenar cópia local.
      </p>
      <div className="stat-row">
        <StatTile label="Impressões (GSC)" value={pct(deltas.impressionsPct)} deltaGood={(deltas.impressionsPct ?? 0) >= 0} />
        <StatTile
          label="Posição média (GSC)"
          value={deltas.positionDelta === null ? "—" : deltas.positionDelta.toFixed(1)}
          delta={deltas.positionDelta === null ? undefined : deltas.positionDelta <= 0 ? "melhorou" : "piorou"}
          deltaGood={(deltas.positionDelta ?? 0) <= 0}
        />
        <StatTile label="CTR (GSC)" value={pct(deltas.ctrDeltaPct)} deltaGood={(deltas.ctrDeltaPct ?? 0) >= 0} />
        <StatTile label="Sessões (GA4)" value={pct(deltas.sessionsPct)} deltaGood={(deltas.sessionsPct ?? 0) >= 0} />
        <StatTile
          label="Taxa de conversão (GA4)"
          value={pct(deltas.conversionRateDeltaPct)}
          deltaGood={(deltas.conversionRateDeltaPct ?? 0) >= 0}
        />
        <StatTile label="Receita (GA4)" value={money(deltas.revenueDeltaAbs)} deltaGood={(deltas.revenueDeltaAbs ?? 0) >= 0} />
      </div>
    </div>
  );
}
