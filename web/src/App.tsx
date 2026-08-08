import { useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { Architecture } from "./pages/Architecture";
import { ApiReference } from "./pages/ApiReference";
import { Documentation } from "./pages/Documentation";
import { PdpConfig } from "./pages/PdpConfig";
import { PageContentEditor } from "./pages/PageContentEditor";
import { Connections } from "./pages/Connections";
import { Runs } from "./pages/Runs";
import { RunDetail } from "./pages/RunDetail";
import { Impact } from "./pages/Impact";
import { PageImpact } from "./pages/PageImpact";
import { OptimizationHistory } from "./pages/OptimizationHistory";
import { Dashboard } from "./pages/Dashboard";
import { Login } from "./pages/Login";
import { ForgotPassword } from "./pages/ForgotPassword";
import { ResetPassword } from "./pages/ResetPassword";
import { Account } from "./pages/Account";
import { Users } from "./pages/Users";
import { useAuth } from "./context/AuthContext";

function AppShell() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("sidebar_collapsed") === "true");
  const { user, can, logout } = useAuth();
  const location = useLocation();

  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebar_collapsed", String(next));
      return next;
    });
  }

  return (
    <div className="app">
      <aside className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`}>
        <Link to="/" className="sidebar-brand" style={{ textDecoration: "none" }}>
          <img src="/logo-icon.png" alt="" className="mark" />
          <span>CatalogIA</span>
        </Link>
        <nav className="sidebar-nav">
          <NavLink to="/products">
            <span className="nav-icon">▤</span> <span className="nav-label">Produtos</span>
          </NavLink>
          {can("connections") && (
            <NavLink to="/page-content">
              <span className="nav-icon">🏷️</span> <span className="nav-label">Páginas</span>
            </NavLink>
          )}
          <NavLink to="/history">
            <span className="nav-icon">🕘</span> <span className="nav-label">Histórico</span>
          </NavLink>
          <NavLink to="/impact">
            <span className="nav-icon">◈</span> <span className="nav-label">Impacto Produto</span>
          </NavLink>
          <NavLink to="/page-impact">
            <span className="nav-icon">◈</span> <span className="nav-label">Impacto Páginas</span>
          </NavLink>
        </nav>
        <nav className="sidebar-nav sidebar-nav--account">
          {can("connections") && (
            <NavLink to="/documentation">
              <span className="nav-icon">📄</span> <span className="nav-label">Documentação</span>
            </NavLink>
          )}
          {can("connections") && (
            <NavLink to="/pdp-config">
              <span className="nav-icon">🧩</span> <span className="nav-label">Configuração de Descrição</span>
            </NavLink>
          )}
          {can("connections") && (
            <NavLink to="/connections">
              <span className="nav-icon">⚙</span> <span className="nav-label">Integrações</span>
            </NavLink>
          )}
          {can("users") && (
            <NavLink to="/users">
              <span className="nav-icon">👤</span> <span className="nav-label">Usuários</span>
            </NavLink>
          )}
          <NavLink to="/account">
            <span className="nav-icon">◑</span> <span className="nav-label">Minha conta</span>
          </NavLink>
          <button type="button" onClick={() => logout()}>
            <span className="nav-icon">⏻</span> <span className="nav-label">Sair</span>
          </button>
        </nav>
        <button
          type="button"
          className="sidebar-collapse-btn"
          onClick={toggleCollapsed}
          title={collapsed ? "Expandir menu" : "Recolher menu"}
        >
          {collapsed ? "»" : "« Recolher"}
        </button>
        <div className="sidebar-footer">Agents for Commerce · Catalog &amp; Content</div>
      </aside>
      <div className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/products" element={<Runs />} />
          <Route path="/history" element={<OptimizationHistory />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/impact" element={<Impact />} />
          <Route path="/page-impact" element={<PageImpact />} />
          <Route path="/account" element={<Account />} />
          {can("connections") && <Route path="/architecture" element={<Architecture />} />}
          {can("connections") && <Route path="/api-reference" element={<ApiReference />} />}
          {can("connections") && <Route path="/documentation" element={<Documentation />} />}
          {can("connections") && <Route path="/pdp-config" element={<PdpConfig />} />}
          {can("connections") && <Route path="/page-content" element={<PageContentEditor />} />}
          {can("connections") && <Route path="/connections" element={<Connections />} />}
          {can("users") && <Route path="/users" element={<Users />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}

export function App() {
  const { loading, user } = useAuth();

  if (loading) return null;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/forgot-password" element={user ? <Navigate to="/" replace /> : <ForgotPassword />} />
      <Route path="/reset-password" element={user ? <Navigate to="/" replace /> : <ResetPassword />} />
      <Route path="/*" element={<AppShell />} />
    </Routes>
  );
}
