import type { BusinessImpactProduct, BusinessImpactSummary, BusinessImpactWindow } from "../api/client";
import { formatCost } from "../lib/currency";

function int(n: number): string {
  return Math.round(n).toLocaleString("pt-BR");
}

function pct(n: number | null): string {
  return n === null ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function rate(n: number | null): string {
  return n === null ? "-" : `${(n * 100).toFixed(1)}%`;
}

function points(n: number | null): string {
  return n === null ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(1)} p.p.`;
}

function money(n: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);
}

function revenueSourceLabel(source: BusinessImpactSummary["revenueSource"] | BusinessImpactProduct["revenueSource"]): string {
  if (source === "item") return "Receita por item";
  if (source === "page") return "Receita por página";
  if (source === "mixed") return "Misto";
  return "Sem receita";
}

function confidenceLabel(summary: BusinessImpactSummary): string {
  if (summary.confidence === "complete") return "Janela completa";
  if (summary.confidence === "partial") return "Janela parcial";
  if (summary.confidence === "preliminary") return "Sinal preliminar";
  if (summary.confidence === "waiting") return "Aguardando maturação";
  return "Poucos dados";
}

function stageLabel(product: BusinessImpactProduct): string {
  return product.stage === "mature" ? "Maduro" : "Preliminar";
}

function compareValue(before: number, after: number, delta: number | null, formatter = int): string {
  return `${formatter(before)} -> ${formatter(after)} (${pct(delta)})`;
}

function metricRows(before: BusinessImpactWindow, after: BusinessImpactWindow, summary: BusinessImpactSummary) {
  const gscRows = [
    ["Impressões (GSC)", int(before.impressions), int(after.impressions), pct(summary.deltas.impressionsPct)],
    ["Cliques (GSC)", int(before.clicks), int(after.clicks), pct(summary.deltas.clicksPct)],
    ["CTR orgânico", rate(before.ctr), rate(after.ctr), points(summary.deltas.ctrPoints)],
    [
      "Posição média",
      before.avgPosition === null ? "-" : before.avgPosition.toFixed(1),
      after.avgPosition === null ? "-" : after.avgPosition.toFixed(1),
      summary.deltas.positionDelta === null ? "-" : summary.deltas.positionDelta.toFixed(1),
    ],
  ];
  const ga4Rows = [
    ["Sessões (GA4)", int(before.sessions), int(after.sessions), pct(summary.deltas.sessionsPct)],
    ["Sessões engajadas", int(before.engagedSessions), int(after.engagedSessions), pct(summary.deltas.engagedSessionsPct)],
    ["Taxa de engajamento", rate(before.engagementRate), rate(after.engagementRate), points(summary.deltas.engagementRatePoints)],
    ["Visualizações de item", int(before.itemViews), int(after.itemViews), pct(summary.deltas.itemViewsPct)],
    ["Adicionar ao carrinho", int(before.addToCarts), int(after.addToCarts), pct(summary.deltas.addToCartsPct)],
    ["Checkouts", int(before.checkouts), int(after.checkouts), pct(summary.deltas.checkoutsPct)],
    ["Compras", int(before.purchases), int(after.purchases), pct(summary.deltas.purchasesPct)],
    ["Taxa de compra", rate(before.purchaseRate), rate(after.purchaseRate), points(summary.deltas.purchaseRatePoints)],
    ["Receita", money(before.revenue), money(after.revenue), money(summary.deltas.revenueAbs)],
  ];
  return summary.productCounts.mature > 0 ? [...gscRows, ...ga4Rows] : ga4Rows;
}

function EmptyBusinessImpact({ summary }: { summary: BusinessImpactSummary }) {
  const counts = summary.productCounts;
  const message =
    summary.status === "missing_google"
      ? "Conecte Google Search Console e GA4 para mensurar acessos e retorno financeiro."
      : summary.status === "no_published_products"
        ? "Ainda não há produto publicado pela revisão. O impacto real começa depois da primeira publicação."
        : summary.status === "no_mature_products"
          ? `${counts.published} produto(s) publicado(s), mas ainda sem ${summary.preliminaryDays} dias para leitura preliminar.`
          : "Há produtos com janela preliminar ou madura, mas o Google ainda não retornou linhas de GA4/GSC para essas páginas.";

  return (
    <section className="card">
      <div className="proposal-header">
        <h2>Acessos e retorno financeiro</h2>
        <span className="pill tone-muted">{confidenceLabel(summary)}</span>
      </div>
      <div className="empty-state">{message}</div>
    </section>
  );
}

export function BusinessImpactPanel({
  summary,
  onSelectProduct,
}: {
  summary: BusinessImpactSummary;
  onSelectProduct: (productId: number) => void;
}) {
  if (summary.status !== "ready") return <EmptyBusinessImpact summary={summary} />;

  const counts = summary.productCounts;
  const analyzableCount = counts.preliminary + counts.mature;

  return (
    <section className="card">
      <div className="proposal-header">
        <h2>Acessos e retorno financeiro</h2>
        <span className="pill tone-good">{confidenceLabel(summary)}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {counts.measured} de {analyzableCount} produto(s) com dados do Google: {counts.preliminary} preliminar(es) e {counts.mature}{" "}
        maduro(s). Preliminar usa GA4 a partir de {summary.preliminaryDays} dias; GSC/SEO entra na leitura madura após{" "}
        {summary.maturationDays} dias. Fonte financeira: {revenueSourceLabel(summary.revenueSource)}.
      </p>

      <div className="stat-row">
        <div className="stat-tile">
          <span className="stat-label">Produtos medidos</span>
          <span className="stat-value">{counts.measured}/{analyzableCount}</span>
          <span className="stat-delta is-good">
            {counts.preliminary} preliminar(es) / {counts.mature} maduro(s)
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">Sessões GA4</span>
          <span className="stat-value">{pct(summary.deltas.sessionsPct)}</span>
          <span className={`stat-delta ${(summary.deltas.sessionsPct ?? 0) >= 0 ? "is-good" : "is-bad"}`}>
            {summary.before.sessions} {"->"} {summary.after.sessions}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">Cliques GSC</span>
          <span className="stat-value">{pct(summary.deltas.clicksPct)}</span>
          <span className={`stat-delta ${(summary.deltas.clicksPct ?? 0) >= 0 ? "is-good" : "is-bad"}`}>
            {summary.before.clicks} {"->"} {summary.after.clicks}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">Compras GA4</span>
          <span className="stat-value">{pct(summary.deltas.purchasesPct)}</span>
          <span className={`stat-delta ${(summary.deltas.purchasesPct ?? 0) >= 0 ? "is-good" : "is-bad"}`}>
            {summary.before.purchases} {"->"} {summary.after.purchases}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">Receita incremental</span>
          <span className="stat-value">{money(summary.deltas.revenueAbs)}</span>
          <span className={`stat-delta ${summary.deltas.revenueAbs >= 0 ? "is-good" : "is-bad"}`}>
            {pct(summary.deltas.revenuePct)}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">Custo IA</span>
          <span className="stat-value">{formatCost(summary.aiCostUsd)}</span>
          <span className="stat-delta is-good">auditoria por produto</span>
        </div>
      </div>

      <h3>Antes vs. depois</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Métrica</th>
              <th>Antes</th>
              <th>Depois</th>
              <th>Variação</th>
            </tr>
          </thead>
          <tbody>
            {metricRows(summary.before, summary.after, summary).map(([label, before, after, delta]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>{before}</td>
                <td>{after}</td>
                <td>{delta}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginTop: "1.1rem" }}>Produto a produto</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Produto</th>
              <th>Estágio</th>
              <th>Publicado</th>
              <th>Sessões</th>
              <th>Compras</th>
              <th>Receita</th>
              <th>Fonte</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {summary.products.map((product) => (
              <tr key={product.productId}>
                <td>
                  <strong>{product.title}</strong>
                  <div className="muted">{product.brand || product.category || product.externalId}</div>
                </td>
                <td>
                  <span className={`pill ${product.stage === "mature" ? "tone-good" : "tone-warning"}`}>
                    {stageLabel(product)}
                  </span>
                  <div className="muted">{product.gscMature ? "GA4 + GSC" : "GA4 inicial"}</div>
                </td>
                <td className="muted">
                  {new Date(product.publishedAt).toLocaleDateString("pt-BR")}
                  <div>{product.afterWindowDays}/{summary.windowDays} dias</div>
                </td>
                <td>{compareValue(product.before.sessions, product.after.sessions, product.deltas.sessionsPct)}</td>
                <td>{compareValue(product.before.purchases, product.after.purchases, product.deltas.purchasesPct)}</td>
                <td>
                  <strong>{money(product.deltas.revenueAbs)}</strong>
                  <div className="muted">{money(product.before.revenue)} {"->"} {money(product.after.revenue)}</div>
                </td>
                <td>
                  <span className={`pill ${product.revenueSource === "item" ? "tone-good" : "tone-muted"}`}>
                    {revenueSourceLabel(product.revenueSource)}
                  </span>
                </td>
                <td>
                  <button type="button" className="secondary compact-btn" onClick={() => onSelectProduct(product.productId)}>
                    Detalhar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
