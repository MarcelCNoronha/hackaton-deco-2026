import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [resetUrl, setResetUrl] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const result = await api.forgotPassword(email);
      setResetUrl(result.resetUrl ?? null);
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="card auth-card">
        <div className="sidebar-brand" style={{ padding: 0, marginBottom: "1.25rem" }}>
          <span className="mark">C</span>
          <span>CatalogIA</span>
        </div>

        {!submitted ? (
          <form onSubmit={handleSubmit}>
            <h1 style={{ fontSize: "1.15rem", margin: "0 0 0.3rem" }}>Recuperar senha</h1>
            <p className="muted" style={{ marginTop: 0 }}>Informe seu e-mail cadastrado.</p>
            <div className="auth-form">
              <input type="email" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
            </div>
            <div className="actions" style={{ flexDirection: "column" }}>
              <button type="submit" disabled={submitting} style={{ width: "100%" }}>
                {submitting ? "Enviando…" : "Gerar link de redefinição"}
              </button>
            </div>
          </form>
        ) : (
          <>
            <h1 style={{ fontSize: "1.15rem", margin: "0 0 0.3rem" }}>Link gerado</h1>
            <p className="muted" style={{ marginTop: 0 }}>
              Ainda não há envio de e-mail configurado — o link aparece abaixo. Copie e acesse para redefinir a senha.
            </p>
            {resetUrl ? (
              <div className="banner" style={{ wordBreak: "break-all" }}>
                <Link to={resetUrl.replace(window.location.origin, "")}>{resetUrl}</Link>
              </div>
            ) : (
              <p className="muted">Se esse e-mail existir na base, um link foi gerado.</p>
            )}
          </>
        )}

        <p className="muted" style={{ marginTop: "1rem", textAlign: "center" }}>
          <Link to="/login">Voltar para o login</Link>
        </p>
      </div>
    </div>
  );
}
