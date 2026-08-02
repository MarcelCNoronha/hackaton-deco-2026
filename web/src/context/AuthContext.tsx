import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, api, type AppSection, type AuthUser } from "../api/client";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  can: (section: AppSection) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const { user: loaded } = await api.me();
      setUser(loaded);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setUser(null);
      else throw err;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function logout() {
    await api.logout();
    setUser(null);
  }

  function can(section: AppSection): boolean {
    if (!user) return false;
    return user.role === "admin" || user.permissions.includes(section);
  }

  return <AuthContext.Provider value={{ user, loading, refresh, logout, can }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
