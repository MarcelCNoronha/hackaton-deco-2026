import { useState } from "react";
import { API_REFERENCE, type ApiOperationKind } from "../lib/api-reference";

const KIND_LABEL: Record<ApiOperationKind, string> = { read: "Leitura", write: "Escrita" };
const KIND_COLOR: Record<ApiOperationKind, string> = { read: "var(--accent)", write: "var(--status-good)" };

/** Living inventory of every external API operation the pipeline calls — see api-reference.ts,
 *  updated alongside the client files it describes. One tab per system instead of one long
 *  stacked scroll, same pattern as PdpConfig's level tabs. */
export function ApiReference() {
  const [activeKey, setActiveKey] = useState(API_REFERENCE[0].key);
  const active = API_REFERENCE.find((s) => s.key === activeKey) ?? API_REFERENCE[0];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Referência de APIs</h1>
          <p className="muted">
            Toda operação externa que o pipeline realmente chama, campo a campo — ver{" "}
            <code>web/src/lib/api-reference.ts</code>, atualizado junto do código dos clients.
          </p>
        </div>
      </div>

      <div className="page-content">
        <div className="actions" style={{ justifyContent: "flex-start", flexWrap: "wrap", marginBottom: "1rem" }}>
          {API_REFERENCE.map((system) => (
            <button
              key={system.key}
              type="button"
              className={system.key === activeKey ? "" : "secondary"}
              onClick={() => setActiveKey(system.key)}
            >
              {system.title}
            </button>
          ))}
        </div>

        <section className="card">
          <h3 style={{ marginTop: 0 }}>{active.title}</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
            {active.baseUrl}
            <br />
            {active.auth} · {active.retry}
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
                {active.operations.map((op) => (
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
      </div>
    </>
  );
}
