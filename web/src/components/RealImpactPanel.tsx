import { StatTile } from "./StatTile";
import type { RealImpact } from "../api/client";

function pct(n: number | null): string {
  return n === null ? "-" : `${n >= 0 ? "+" : ""}${n}%`;
}

function money(n: number | null): string {
  return n === null ? "-" : `${n >= 0 ? "+" : ""}R$ ${n.toFixed(2)}`;
}

function int(n: number | null): string {
  return n === null ? "-" : n.toLocaleString("pt-BR");
}

/** Per-product (or per-page, see PageImpact.tsx) before/after panel fed by a live GSC/GA4
 *  comparison. `subject` customizes the empty-state wording ("produto"/"página") — the underlying
 *  comparison logic is identical either way (see impact.agent.ts's computeRealImpact). */
export function RealImpactPanel({ impact, subject = "produto" }: { impact: RealImpact; subject?: string }) {
  if (impact.status === "no_url") {
    return <div className="empty-state">Este {subject} nao tem URL conhecida para cruzar com Search Console/GA4.</div>;
  }

  if (impact.status === "not_published") {
    return <div className="empty-state">Nada deste {subject} foi publicado ainda. O impacto real comeca na primeira publicacao.</div>;
  }

  if (impact.status === "maturing") {
    return (
      <div className="empty-state">
        Publicado ha {impact.daysSincePublish} {impact.daysSincePublish === 1 ? "dia" : "dias"}. Faltam{" "}
        {impact.daysUntilReady} {impact.daysUntilReady === 1 ? "dia" : "dias"} para a leitura preliminar de GA4 ficar disponivel.
      </div>
    );
  }

  const { before, after, deltas } = impact;
  if (!before || !after || !deltas) return null;
  const isPreliminary = impact.status === "preliminary";

  return (
    <div>
      <p className="muted" style={{ marginTop: 0, fontSize: "0.82rem" }}>
        {isPreliminary ? "Leitura preliminar GA4. " : "Leitura madura GA4 + GSC. "}
        Antes: {before.startDate} a {before.endDate} · Depois: {after.startDate} a {after.endDate}. Consulta em tempo
        real ao Google, sem armazenar copia local.
        {isPreliminary && impact.daysUntilMature !== undefined
          ? ` GSC/SEO entra em ${impact.daysUntilMature} ${impact.daysUntilMature === 1 ? "dia" : "dias"}.`
          : ""}
      </p>
      <div className="stat-row">
        {!isPreliminary && (
          <>
            <StatTile label="Impressoes (GSC)" value={pct(deltas.impressionsPct)} deltaGood={(deltas.impressionsPct ?? 0) >= 0} />
            <StatTile
              label="Posicao media (GSC)"
              value={deltas.positionDelta === null ? "-" : deltas.positionDelta.toFixed(1)}
              delta={deltas.positionDelta === null ? undefined : deltas.positionDelta <= 0 ? "melhorou" : "piorou"}
              deltaGood={(deltas.positionDelta ?? 0) <= 0}
            />
            <StatTile label="CTR (GSC)" value={pct(deltas.ctrDeltaPct)} deltaGood={(deltas.ctrDeltaPct ?? 0) >= 0} />
          </>
        )}
        <StatTile label="Sessoes (GA4)" value={pct(deltas.sessionsPct)} deltaGood={(deltas.sessionsPct ?? 0) >= 0} />
        <StatTile
          label="Sessoes engajadas (GA4)"
          value={pct(deltas.engagedSessionsPct)}
          delta={`${int(before.engagedSessions)} -> ${int(after.engagedSessions)}`}
          deltaGood={(deltas.engagedSessionsPct ?? 0) >= 0}
        />
        <StatTile
          label="Compras (GA4)"
          value={pct(deltas.purchasesPct)}
          delta={`${int(before.purchases)} -> ${int(after.purchases)}`}
          deltaGood={(deltas.purchasesPct ?? 0) >= 0}
        />
        <StatTile
          label="Taxa de compra (GA4)"
          value={pct(deltas.conversionRateDeltaPct)}
          deltaGood={(deltas.conversionRateDeltaPct ?? 0) >= 0}
        />
        <StatTile
          label="Receita (GA4)"
          value={money(deltas.revenueDeltaAbs)}
          delta={pct(deltas.revenuePct)}
          deltaGood={(deltas.revenueDeltaAbs ?? 0) >= 0}
        />
      </div>
    </div>
  );
}
