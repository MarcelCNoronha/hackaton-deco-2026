type StatusKind = "run" | "proposal" | "connection";

const STATUS_MAP: Record<StatusKind, Record<string, { label: string; tone: "good" | "warning" | "serious" | "critical" | "muted" }>> = {
  run: {
    running: { label: "Em execução", tone: "warning" },
    success: { label: "Concluído", tone: "good" },
    partial: { label: "Parcial", tone: "serious" },
    failed: { label: "Falhou", tone: "critical" },
  },
  proposal: {
    pending: { label: "Pendente", tone: "warning" },
    approved: { label: "Aprovado", tone: "good" },
    edited: { label: "Editado", tone: "warning" },
    rejected: { label: "Rejeitado", tone: "critical" },
    published: { label: "Publicado", tone: "good" },
  },
  connection: {
    connected: { label: "Conectado", tone: "good" },
    error: { label: "Erro", tone: "critical" },
    untested: { label: "Não testado", tone: "muted" },
  },
};

/** Status is always icon(dot) + label, never color alone — see dataviz skill's status-palette rule. */
export function StatusBadge({ kind, status }: { kind: StatusKind; status: string }) {
  const entry = STATUS_MAP[kind][status] ?? { label: status, tone: "muted" as const };
  return (
    <span className={`status-badge tone-${entry.tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {entry.label}
    </span>
  );
}
