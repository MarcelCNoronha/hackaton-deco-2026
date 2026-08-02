export function StatTile({
  label,
  value,
  delta,
  deltaGood,
}: {
  label: string;
  value: string | number;
  delta?: string;
  /** Whether the delta direction is a good thing (colors it with the success token) or not (critical). */
  deltaGood?: boolean;
}) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {delta && <span className={`stat-delta ${deltaGood ? "is-good" : "is-bad"}`}>{delta}</span>}
    </div>
  );
}
