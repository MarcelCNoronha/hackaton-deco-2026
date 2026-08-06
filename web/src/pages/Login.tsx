import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { PasswordInput } from "../components/PasswordInput";

export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"password" | "two-factor">("password");
  const [code, setCode] = useState("");
  const [rememberDevice, setRememberDevice] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? "/";

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.login(email, password);
      if (result.requiresTwoFactor) {
        setStep("two-factor");
      } else {
        await refresh();
        navigate(from, { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTwoFactorSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.twoFactorChallenge(code, rememberDevice);
      await refresh();
      navigate(from, { replace: true });
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

        {step === "password" ? (
          <form onSubmit={handlePasswordSubmit}>
            <h1 style={{ fontSize: "1.15rem", margin: "0 0 0.3rem" }}>Entrar</h1>
            <p className="muted" style={{ marginTop: 0 }}>Acesse com seu e-mail e senha.</p>
            <div className="auth-form">
              <input
                type="email"
                placeholder="E-mail"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                required
              />
              <PasswordInput placeholder="Senha" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {error && <div className="banner">{error}</div>}
            <div className="actions" style={{ flexDirection: "column" }}>
              <button type="submit" disabled={submitting} style={{ width: "100%" }}>
                {submitting ? "Entrando…" : "Entrar"}
              </button>
            </div>
            <p className="muted" style={{ marginTop: "1rem", textAlign: "center" }}>
              <Link to="/forgot-password">Esqueci minha senha</Link>
            </p>
          </form>
        ) : (
          <form onSubmit={handleTwoFactorSubmit}>
            <h1 style={{ fontSize: "1.15rem", margin: "0 0 0.3rem" }}>Verificação em duas etapas</h1>
            <p className="muted" style={{ marginTop: 0 }}>Digite o código do seu aplicativo autenticador.</p>
            <div className="auth-form">
              <input
                placeholder="Código de 6 dígitos"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={6}
                autoFocus
                required
              />
            </div>
            <label className="muted" style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginTop: "0.75rem" }}>
              <input type="checkbox" checked={rememberDevice} onChange={(e) => setRememberDevice(e.target.checked)} />
              Lembrar este dispositivo por 30 dias
            </label>
            {error && <div className="banner">{error}</div>}
            <div className="actions" style={{ flexDirection: "column" }}>
              <button type="submit" disabled={submitting} style={{ width: "100%" }}>
                {submitting ? "Verificando…" : "Confirmar"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
