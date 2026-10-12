import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { api, ApiError } from "../api.ts";
import { useAuth } from "../auth.tsx";

export function LoginPage() {
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { body: { username, password } });
      const me = await refresh();
      nav(me?.mustChangePassword ? "/change-password" : (params.get("next") ?? "/"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <span className="brand-mark big">〰</span>
          <h1>AI 课件工坊</h1>
          <p className="muted">Courseware workshop for bilingual teachers</p>
        </div>
        <label>
          用户名 Username
          <input name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </label>
        <label>
          密码 Password
          <input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="alert error">{error}</div>}
        <button className="btn primary block" disabled={busy}>
          {busy ? "…" : "登录 Log in"}
        </button>
        <p className="muted small center">账号由管理员创建 · Accounts are created by your admin</p>
      </form>
    </div>
  );
}

export function ChangePasswordPage() {
  const { me, loading, refresh } = useAuth();
  const nav = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  if (loading) return null;
  if (!me) return <Navigate to="/login" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) return setError("两次输入不一致 · Passwords do not match");
    try {
      await api("/api/auth/change-password", { body: { currentPassword: current, newPassword: next } });
      await refresh();
      nav("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed");
    }
  }

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <h1>设置新密码</h1>
        <p className="muted">{me.mustChangePassword ? "首次登录请修改管理员给你的初始密码。Please replace your initial password." : "Change your password."}</p>
        <label>
          当前密码 Current password
          <input name="current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label>
          新密码 New password
          <input name="new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </label>
        <label>
          再输一次 Confirm
          <input name="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        <p className="muted small">至少 8 位，包含字母和数字 · 8+ characters with letters and digits</p>
        {error && <div className="alert error">{error}</div>}
        <button className="btn primary block">保存 Save</button>
      </form>
    </div>
  );
}
