import { useEffect, useRef, useState } from "react";
import { ARCHITECTURE_DIAGRAM, ARCHITECTURE_NOTES } from "../lib/architecture-diagram";
import { API_REFERENCE, type ApiOperationKind } from "../lib/api-reference";

const KIND_LABEL: Record<ApiOperationKind, string> = { read: "Leitura", write: "Escrita" };
const KIND_COLOR: Record<ApiOperationKind, string> = { read: "var(--accent)", write: "var(--status-good)" };

/** Renders the living architecture diagram (see architecture-diagram.ts) client-side via mermaid —
 *  loaded lazily so the ~500kb library only ever ships to whoever actually opens this tab. Update
 *  ARCHITECTURE_DIAGRAM/ARCHITECTURE_NOTES as agents/loops change; this page always reflects
 *  whatever's in that file, nothing to redraw by hand. */
export function Architecture() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        themeVariables: {
          background: "#121828",
          primaryColor: "#1a2137",
          primaryTextColor: "#f8fafc",
          primaryBorderColor: "#3b82f6",
          lineColor: "#8b93a7",
          secondaryColor: "#1a2137",
          tertiaryColor: "#0b0e17",
          fontFamily: "-apple-system, 'Segoe UI', Roboto, Inter, sans-serif",
        },
        flowchart: { curve: "basis" },
      });
      try {
        const { svg } = await mermaid.render("architecture-diagram-svg", ARCHITECTURE_DIAGRAM);
        if (!cancelled && containerRef.current) containerRef.current.innerHTML = svg;
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Arquitetura</h1>
          <p className="muted">
            Fluxo completo do pipeline multi-agente — atualizado à medida que o CatalogIA evolui, não é um
            print estático.
          </p>
        </div>
      </div>

      <div className="page-content">
        <section className="card">
          {error && <div className="banner">Falha ao renderizar o diagrama: {error}</div>}
          <div ref={containerRef} style={{ overflowX: "auto" }} />
        </section>

        {ARCHITECTURE_NOTES.map((note) => (
          <section className="card" key={note.title}>
            <h3 style={{ marginTop: 0 }}>{note.title}</h3>
            <p className="muted" style={{ margin: 0 }}>
              {note.body}
            </p>
          </section>
        ))}

        <div className="page-header" style={{ marginTop: "0.5rem" }}>
          <div>
            <h1 style={{ fontSize: "1.3rem" }}>Referência de APIs</h1>
            <p className="muted">
              Toda operação externa que o pipeline realmente chama, campo a campo — ver{" "}
              <code>web/src/lib/api-reference.ts</code>, atualizado junto do código dos clients.
            </p>
          </div>
        </div>

        {API_REFERENCE.map((system) => (
          <section className="card" key={system.key}>
            <h3 style={{ marginTop: 0 }}>{system.title}</h3>
            <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
              {system.baseUrl}
              <br />
              {system.auth} · {system.retry}
            </p>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", fontSize: "0.85rem" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Operação</th>
                    <th style={{ textAlign: "left" }}>Endpoint</th>
                    <th style={{ textAlign: "left" }}>Tipo</th>
                    <th style={{ textAlign: "left" }}>Campos</th>
                    <th style={{ textAlign: "left" }}>Uso / observação</th>
                  </tr>
                </thead>
                <tbody>
                  {system.operations.map((op) => (
                    <tr key={op.name}>
                      <td style={{ verticalAlign: "top", whiteSpace: "nowrap" }}>
                        <code>{op.name}</code>
                      </td>
                      <td style={{ verticalAlign: "top" }}>
                        <span className="muted">{op.method}</span> {op.endpoint}
                      </td>
                      <td style={{ verticalAlign: "top" }}>
                        <span className="pill" style={{ color: KIND_COLOR[op.kind] }}>
                          {KIND_LABEL[op.kind]}
                        </span>
                      </td>
                      <td style={{ verticalAlign: "top" }} className="muted">
                        {op.fields}
                      </td>
                      <td style={{ verticalAlign: "top" }}>
                        {op.purpose}
                        {op.caveat && (
                          <>
                            <br />
                            <span className="muted" style={{ fontSize: "0.8rem" }}>
                              ⚠ {op.caveat}
                            </span>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
