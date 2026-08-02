import { useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";

export function Account() {
  const { user, refresh } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(user?.name ?? "");
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const [setupData, setSetupData] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [confirmingTwoFactor, setConfirmingTwoFactor] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disablingTwoFactor, setDisablingTwoFactor] = useState(false);

  function announce(ok: boolean, okMsg: string, err: unknown) {
    if (ok) {
      setMessage(okMsg);
      setError(null);
    } else {
      setError(err instanceof Error ? err.message : String(err));
      setMessage(null);
    }
  }

  async function handleProfileSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    try {
      await api.updateProfile(name);
      await refresh();
      announce(true, "Perfil atualizado.", null);
    } catch (err) {
      announce(false, "", err);
    } finally {
      setSavingProfile(false);
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSavingPassword(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      announce(true, "Senha alterada. Suas outras sessões foram encerradas.", null);
    } catch (err) {
      announce(false, "", err);
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleStartTwoFactorSetup() {
    try {
      setSetupData(await api.twoFactorSetup());
    } catch (err) {
      announce(false, "", err);
    }
  }

  async function handleConfirmTwoFactor(e: React.FormEvent) {
    e.preventDefault();
    setConfirmingTwoFactor(true);
    try {
      await api.twoFactorConfirm(confirmCode);
      setSetupData(null);
      setConfirmCode("");
      await refresh();
      announce(true, "Verificação em duas etapas ativada.", null);
    } catch (err) {
      announce(false, "", err);
    } finally {
      setConfirmingTwoFactor(false);
    }
  }

  async function handleDisableTwoFactor(e: React.FormEvent) {
    e.preventDefault();
    setDisablingTwoFactor(true);
    try {
      await api.twoFactorDisable(disablePassword);
      setDisablePassword("");
      await refresh();
      announce(true, "Verificação em duas etapas desativada.", null);
    } catch (err) {
      announce(false, "", err);
    } finally {
      setDisablingTwoFactor(false);
    }
  }

  if (!user) return null;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Minha conta</h1>
          <p className="muted">Dados de perfil, senha e verificação em duas etapas.</p>
        </div>
      </div>

      <div className="page-content">
        {message && <div className="banner">{message}</div>}
        {error && <div className="banner">{error}</div>}

        <section className="card">
          <h2>Perfil</h2>
          <form onSubmit={handleProfileSubmit} className="form-grid">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome" />
            <input value={user.email} disabled />
            <button type="submit" disabled={savingProfile}>
              {savingProfile ? "Salvando…" : "Salvar perfil"}
            </button>
          </form>
        </section>

        <section className="card">
          <h2>Alterar senha</h2>
          <form onSubmit={handlePasswordSubmit} className="form-grid">
            <input
              type="password"
              placeholder="Senha atual"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
            <input
              type="password"
              placeholder="Nova senha (mín. 8 caracteres)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
            <button type="submit" disabled={savingPassword}>
              {savingPassword ? "Salvando…" : "Alterar senha"}
            </button>
          </form>
        </section>

        <section className="card">
          <h2>Verificação em duas etapas (2FA)</h2>
          {user.twoFactorEnabled ? (
            <>
              <p className="muted">2FA está ativado na sua conta.</p>
              <form onSubmit={handleDisableTwoFactor} className="form-grid">
                <input
                  type="password"
                  placeholder="Senha atual"
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                  required
                />
                <button type="submit" className="danger" disabled={disablingTwoFactor}>
                  {disablingTwoFactor ? "Desativando…" : "Desativar 2FA"}
                </button>
              </form>
            </>
          ) : setupData ? (
            <>
              <p className="muted">Escaneie o QR code no seu aplicativo autenticador e confirme com o código gerado.</p>
              <img src={setupData.qrDataUrl} alt="QR code do 2FA" style={{ width: 180, height: 180, background: "#fff", borderRadius: "var(--radius-md)" }} />
              <p className="muted" style={{ fontSize: "0.8rem" }}>
                Ou digite manualmente: <code>{setupData.secret}</code>
              </p>
              <form onSubmit={handleConfirmTwoFactor} className="form-grid">
                <input placeholder="Código de 6 dígitos" value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} maxLength={6} required />
                <button type="submit" disabled={confirmingTwoFactor}>
                  {confirmingTwoFactor ? "Confirmando…" : "Confirmar e ativar"}
                </button>
              </form>
            </>
          ) : (
            <>
              <p className="muted">2FA está desativado. Ative para adicionar uma camada extra de segurança no login.</p>
              <button type="button" onClick={handleStartTwoFactorSetup}>
                Ativar 2FA
              </button>
            </>
          )}
        </section>
      </div>
    </>
  );
}
