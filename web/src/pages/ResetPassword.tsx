import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { PasswordInput } from "../components/PasswordInput";

export function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("A senha precisa ter pelo menos 8 caracteres.");
      return;
    }
    if (password !== confirmPassword) {
      setError("As senhas não coincidem.");
      return;
    }
    setSubmitting(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
      setTimeout(() => navigate("/login", { replace: true }), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="card auth-card">
        <div className="sidebar-brand" style={{ padding: 0, marginBottom: "1.25rem" }}>
          <img src="/logo-icon.png" alt="" className="mark" />
          <span>CatalogIA</span>
        </div>

        {!token ? (
          <div className="banner">Link inválido — falta o token de redefinição na URL.</div>
        ) : done ? (
          <div className="banner">Senha atualizada. Redirecionando para o login…</div>
        ) : (
          <form onSubmit={handleSubmit}>
            <h1 style={{ fontSize: "1.15rem", margin: "0 0 0.3rem" }}>Definir nova senha</h1>
            <div className="auth-form">
              <PasswordInput
                placeholder="Nova senha (mín. 8 caracteres)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                required
              />
              <PasswordInput
                placeholder="Confirmar nova senha"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>
            {error && <div className="banner">{error}</div>}
            <div className="actions" style={{ flexDirection: "column" }}>
              <button type="submit" disabled={submitting} style={{ width: "100%" }}>
                {submitting ? "Salvando…" : "Salvar nova senha"}
              </button>
            </div>
          </form>
        )}

        <p className="muted" style={{ marginTop: "1rem", textAlign: "center" }}>
          <Link to="/login">Voltar para o login</Link>
        </p>
      </div>
    </div>
  );
}
