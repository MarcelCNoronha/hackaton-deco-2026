function severityTone(pct: number): "good" | "warning" | "serious" | "critical" {
  if (pct >= 80) return "good";
  if (pct >= 60) return "warning";
  if (pct >= 40) return "serious";
  return "critical";
}

/** A same-ramp track/fill meter: fill carries severity, unfilled track is the fill's own hue at low
 *  opacity so the whole bar reads as one state, not two colors fighting each other. */
export function Meter({ value, max = 100, label }: { value: number; max?: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const tone = severityTone(pct);

  return (
    <div className="meter">
      {label && (
        <div className="meter-head">
          <span>{label}</span>
          <span className="meter-value">
            {value}
            {max !== 100 ? `/${max}` : ""}
          </span>
        </div>
      )}
      <div className={`meter-track tone-${tone}`}>
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
