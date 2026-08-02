/** Before → after per item = dumbbell (1 hue, 2 shades): a track with two dots, connected,
 *  the "antes" dot in the faded shade and "depois" in the full accent — see dataviz skill. */
export function ScoreCompare({
  label,
  before,
  after,
  max = 100,
  unit = "",
}: {
  label: string;
  before: number;
  after: number;
  max?: number;
  unit?: string;
}) {
  const beforePct = Math.max(0, Math.min(100, (before / max) * 100));
  const afterPct = Math.max(0, Math.min(100, (after / max) * 100));
  const delta = after - before;
  const lineLeft = Math.min(beforePct, afterPct);
  const lineWidth = Math.abs(afterPct - beforePct);

  return (
    <div className="score-compare">
      <div className="score-compare-head">
        <span>{label}</span>
        <span className={`score-delta ${delta > 0 ? "is-good" : delta < 0 ? "is-bad" : "is-flat"}`}>
          {delta > 0 ? "+" : ""}
          {delta}
          {unit}
        </span>
      </div>
      <div className="score-compare-track">
        <div className="score-compare-line" style={{ left: `${lineLeft}%`, width: `${lineWidth}%` }} />
        <div className="score-dot is-before" style={{ left: `${beforePct}%` }} title={`Antes: ${before}${unit}`} />
        <div className="score-dot is-after" style={{ left: `${afterPct}%` }} title={`Depois: ${after}${unit}`} />
      </div>
      <div className="score-compare-labels">
        <span>
          Antes: {before}
          {unit}
        </span>
        <span>
          Depois: {after}
          {unit}
        </span>
      </div>
    </div>
  );
}
