import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { api, type Me } from "./api.ts";

/** Which model answers: `stub` means the built-in templates, not AI (banner on every page). */
export type AiMode = "live" | "stub" | "off";

interface AuthState {
  me: Me | null;
  ai: AiMode | null;
  loading: boolean;
  refresh(): Promise<Me | null>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ai, setAi] = useState<AiMode | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    const { user, ai: mode } = await api<{ user: Me | null; ai: AiMode | null }>("/api/auth/me");
    setMe(user);
    setAi(mode);
    setLoading(false);
    return user;
  }, []);
  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" });
    setMe(null);
  }, []);
  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, [refresh]);
  return <AuthContext.Provider value={{ me, ai, loading, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

export function RequireAuth({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="page-loading">Loading… 加载中</div>;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (me.mustChangePassword) return <Navigate to="/change-password" replace />;
  if (admin && me.role !== "admin") return <Navigate to="/" replace />;
  return <>{children}</>;
}
