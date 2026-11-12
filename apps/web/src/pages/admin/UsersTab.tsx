import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../api.ts";

interface UserRow {
  id: string;
  username: string;
  displayName: string | null;
  role: "admin" | "teacher";
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: number;
}

export function UsersPanel() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [form, setForm] = useState({ username: "", displayName: "", role: "teacher", initialPassword: "" });
  const [issued, setIssued] = useState<{ username: string; password: string } | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => setUsers((await api<{ users: UserRow[] }>("/api/admin/users")).users), []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ user: UserRow; initialPassword: string }>("/api/admin/users", {
        body: { username: form.username, role: form.role, ...(form.displayName ? { displayName: form.displayName } : {}), ...(form.initialPassword ? { initialPassword: form.initialPassword } : {}) },
      });
      setIssued({ username: r.user.username, password: r.initialPassword });
      setForm({ username: "", displayName: "", role: "teacher", initialPassword: "" });
    });
  };

  return (
    <>
      <form className="card form-grid" onSubmit={create}>
        <h2>新建账号 Create account</h2>
        <label>
          用户名 Username
          <input name="new-username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required placeholder="wang.li" />
        </label>
        <label>
          显示名 Display name
          <input name="new-display" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="王老师" />
        </label>
        <label>
          角色 Role
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="teacher">老师 Teacher</option>
            <option value="admin">管理员 Admin</option>
          </select>
        </label>
        <label>
          初始密码 Initial password
          <input name="new-password" value={form.initialPassword} onChange={(e) => setForm({ ...form, initialPassword: e.target.value })} placeholder="留空自动生成 auto" />
        </label>
        <div className="form-actions">
          <button className="btn primary">创建 Create</button>
        </div>
      </form>
      {issued && (
        <div className="alert success" data-testid="issued-password">
          账号 <strong>{issued.username}</strong> 的初始密码：<code>{issued.password}</code> —— 只显示一次，请转交老师；首次登录需修改。
        </div>
      )}
      {error && <div className="alert error">{error}</div>}
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>显示名</th>
              <th>角色</th>
              <th>状态</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.displayName}</td>
                <td>{u.role}</td>
                <td>
                  {u.disabled ? <span className="badge failed">禁用 disabled</span> : u.mustChangePassword ? <span className="badge parsing">待改密 pending</span> : <span className="badge ready">正常 active</span>}
                </td>
                <td className="row end">
                  <button
                    className="btn ghost small"
                    onClick={() =>
                      run(async () => {
                        const r = await api<{ initialPassword: string }>(`/api/admin/users/${u.id}/reset-password`, { method: "POST" });
                        setIssued({ username: u.username, password: r.initialPassword });
                      })
                    }
                  >
                    重置密码
                  </button>
                  <button className="btn ghost small" onClick={() => run(async () => void (await api(`/api/admin/users/${u.id}/${u.disabled ? "enable" : "disable"}`, { method: "POST" })))}>
                    {u.disabled ? "启用" : "禁用"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AuditLog />
    </>
  );
}

function AuditLog() {
  const [entries, setEntries] = useState<{ id: number; action: string; target: string | null; createdAt: number; actor: string | null }[]>([]);
  useEffect(() => {
    void api<{ entries: typeof entries }>("/api/admin/audit").then((r) => setEntries(r.entries));
  }, []);
  return (
    <div className="card" data-testid="audit-log">
      <h2>最近操作 Recent activity</h2>
      {entries.length === 0 ? (
        <p className="muted">还没有记录 · Nothing yet</p>
      ) : (
        <table className="table">
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="muted small">{new Date(e.createdAt).toLocaleString()}</td>
                <td>{e.actor ?? "—"}</td>
                <td>
                  <code>{e.action}</code>
                </td>
                <td className="muted small">{e.target ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
