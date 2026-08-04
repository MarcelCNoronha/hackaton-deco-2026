import { useEffect, useState } from "react";
import { api, type AdminUser, type AppSection } from "../api/client";
import { useAuth } from "../context/AuthContext";

const SECTIONS: Array<{ key: AppSection; label: string }> = [
  { key: "connections", label: "Integrações" },
  { key: "publish", label: "Publicar" },
  { key: "users", label: "Usuários" },
];

export function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [permissions, setPermissions] = useState<Set<AppSection>>(new Set());
  const [creating, setCreating] = useState(false);
  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editPermissions, setEditPermissions] = useState<Set<AppSection>>(new Set());
  const [savingPermissions, setSavingPermissions] = useState(false);

  async function refresh() {
    setUsers(await api.listUsers());
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  function togglePermission(section: AppSection) {
    setPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setSetupUrl(null);
    try {
      const result = await api.createUser({ name, email, role, permissions: [...permissions] });
      setSetupUrl(result.setupUrl);
      setName("");
      setEmail("");
      setRole("user");
      setPermissions(new Set());
      await refresh();
      setMessage(`Usuário ${result.user.email} convidado.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  function openEditPermissions(target: AdminUser) {
    setEditingUser(target);
    setEditPermissions(new Set(target.permissions));
  }

  function toggleEditPermission(section: AppSection) {
    setEditPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

  async function handleSavePermissions() {
    if (!editingUser) return;
    setSavingPermissions(true);
    try {
      await api.updateUser(editingUser.id, { permissions: [...editPermissions] });
      await refresh();
      setEditingUser(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPermissions(false);
    }
  }

  async function handleRoleChange(target: AdminUser, nextRole: "admin" | "user") {
    try {
      await api.updateUser(target.id, { role: nextRole });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleToggleActive(target: AdminUser) {
    try {
      await api.updateUser(target.id, { isActive: !target.isActive });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleResetPassword(target: AdminUser) {
    const { resetUrl } = await api.resetUserPassword(target.id);
    setSetupUrl(resetUrl);
    setMessage(`Link de redefinição gerado para ${target.email}.`);
  }

  async function handleDisableTwoFactor(target: AdminUser) {
    await api.disableUserTwoFactor(target.id);
    await refresh();
    setMessage(`2FA desativado para ${target.email}.`);
  }

  async function handleDelete(target: AdminUser) {
    await api.deleteUser(target.id);
    await refresh();
    setMessage(`Usuário ${target.email} removido.`);
  }

  if (loading) return null;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Usuários</h1>
          <p className="muted">Convide novos usuários e gerencie permissões de acesso.</p>
        </div>
      </div>

      <div className="page-content">
        {message && <div className="banner">{message}</div>}
        {error && <div className="banner">{error}</div>}
        {setupUrl && (
          <div className="banner" style={{ wordBreak: "break-all" }}>
            Link de acesso (sem envio de e-mail configurado): {setupUrl}
          </div>
        )}

        <section className="card">
          <h2>Convidar usuário</h2>
          <form onSubmit={handleCreate}>
            <div className="form-grid">
              <input placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} required />
              <input type="email" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <select value={role} onChange={(e) => setRole(e.target.value as "admin" | "user")}>
                <option value="user">Usuário</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            {role === "user" && (
              <div className="actions" style={{ marginTop: "0.6rem" }}>
                {SECTIONS.map((section) => (
                  <button
                    key={section.key}
                    type="button"
                    className={permissions.has(section.key) ? "" : "secondary"}
                    onClick={() => togglePermission(section.key)}
                  >
                    {section.label}
                  </button>
                ))}
              </div>
            )}
            <button type="submit" disabled={creating} style={{ marginTop: "0.75rem" }}>
              {creating ? "Convidando…" : "Convidar"}
            </button>
          </form>
        </section>

        <section className="card">
          <h2>Usuários cadastrados</h2>
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>E-mail</th>
                <th>Papel</th>
                <th>Permissões</th>
                <th>Status</th>
                <th>2FA</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td className="muted">{u.email}</td>
                  <td>
                    <select value={u.role} onChange={(e) => handleRoleChange(u, e.target.value as "admin" | "user")} disabled={u.id === me?.id}>
                      <option value="user">Usuário</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td>
                    {u.role === "admin" ? (
                      <span className="muted">Acesso total</span>
                    ) : (
                      <button type="button" className="secondary" onClick={() => openEditPermissions(u)}>
                        Editar ({u.permissions.length})
                      </button>
                    )}
                  </td>
                  <td>
                    <button type="button" className={u.isActive ? "secondary" : ""} onClick={() => handleToggleActive(u)} disabled={u.id === me?.id}>
                      {u.isActive ? "Ativo" : "Inativo"}
                    </button>
                  </td>
                  <td className="muted">{u.twoFactorEnabled ? "Ativado" : "Desativado"}</td>
                  <td>
                    <div className="actions" style={{ marginTop: 0 }}>
                      <button type="button" className="secondary" onClick={() => handleResetPassword(u)}>
                        Redefinir senha
                      </button>
                      {u.twoFactorEnabled && (
                        <button type="button" className="secondary" onClick={() => handleDisableTwoFactor(u)}>
                          Desativar 2FA
                        </button>
                      )}
                      {u.id !== me?.id && (
                        <button type="button" className="danger" onClick={() => handleDelete(u)}>
                          Excluir
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      {editingUser && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-box card">
            <h2>Permissões de {editingUser.name}</h2>
            <p className="muted" style={{ marginTop: 0 }}>{editingUser.email}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.75rem" }}>
              {SECTIONS.map((section) => (
                <label key={section.key} className="field-selector-row">
                  <span>
                    <input
                      type="checkbox"
                      checked={editPermissions.has(section.key)}
                      onChange={() => toggleEditPermission(section.key)}
                    />
                    {" "}
                    {section.label}
                  </span>
                </label>
              ))}
            </div>
            <div className="actions" style={{ marginTop: "1rem", justifyContent: "flex-end" }}>
              <button type="button" className="secondary" onClick={() => setEditingUser(null)}>
                Cancelar
              </button>
              <button type="button" onClick={handleSavePermissions} disabled={savingPermissions}>
                {savingPermissions ? "Salvando…" : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
