import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api.ts";

interface UserRow {
  id: string;
  username: string;
  displayName: string | null;
  role: "admin" | "teacher";
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: number;
}
type Kind = "deepseek" | "glm" | "custom";
interface AiView {
  presets: Record<Kind, { label: string; baseUrl: string; models: string[]; docs: string }>;
  capabilities: string[];
  stubFallback: boolean;
  providers: { id: string; kind: Kind; name: string; baseUrl: string; apiKeyHint: string; enabled: boolean }[];
  routes: { capability: string; primaryProviderId: string; primaryModel: string; fallbackProviderId: string | null; fallbackModel: string | null; temperature: number | null }[];
  recentCalls: { id: string; capability: string; providerId: string; model: string; status: string; latencyMs: number; inputTokens: number; outputTokens: number; createdAt: number; error: string | null }[];
}

export function AdminPage() {
  const [tab, setTab] = useState<"users" | "ai">("users");
  return (
    <div className="stack">
      <div className="row between">
        <h1>后台管理 Admin</h1>
        <div className="tabs">
          <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>
            白名单账号 Users
          </button>
          <button className={tab === "ai" ? "active" : ""} onClick={() => setTab("ai")}>
            AI 模型 Models
          </button>
        </div>
      </div>
      {tab === "users" ? <UsersPanel /> : <AiPanel />}
    </div>
  );
}

function UsersPanel() {
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
    </>
  );
}

function AiPanel() {
  const [view, setView] = useState<AiView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState<{ kind: Kind; name: string; baseUrl: string; apiKey: string }>({ kind: "deepseek", name: "DeepSeek", baseUrl: "", apiKey: "" });
  const [route, setRoute] = useState({ capability: "default", providerId: "", model: "", fallbackProviderId: "", fallbackModel: "" });
  const load = useCallback(async () => setView(await api<AiView>("/api/admin/ai")), []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  if (!view) return <p className="muted">Loading…</p>;
  const preset = view.presets[form.kind];
  const providerName = (id: string | null) => view.providers.find((p) => p.id === id)?.name ?? id ?? "—";
  const modelsFor = (id: string) => view.presets[view.providers.find((p) => p.id === id)?.kind ?? "custom"]?.models ?? [];

  return (
    <>
      {view.stubFallback && view.routes.length === 0 && (
        <div className="alert info">尚未配置模型：当前使用本地确定性 stub 生成（仅用于开发调试）。No route configured — the deterministic stub is used.</div>
      )}
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      <form
        className="card form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/api/admin/ai/providers", { body: { kind: form.kind, name: form.name, apiKey: form.apiKey, ...(form.baseUrl ? { baseUrl: form.baseUrl } : {}) } });
            setForm({ ...form, apiKey: "" });
            setNotice("已保存，API Key 已加密存储 · Saved; key encrypted at rest");
          });
        }}
      >
        <h2>添加模型提供方 Add provider</h2>
        <label>
          类型 Type
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Kind, name: view.presets[e.target.value as Kind].label.split(" ")[0] ?? "" })}>
            {(Object.keys(view.presets) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {view.presets[k].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          名称 Name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </label>
        <label className="span2">
          Base URL（OpenAI 兼容）
          <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={preset.baseUrl || "https://your-endpoint/v1"} required={form.kind === "custom"} />
        </label>
        <label className="span2">
          API Key
          <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} required autoComplete="off" />
        </label>
        <div className="form-actions">
          <button className="btn primary">保存 Save</button>
        </div>
      </form>

      <div className="card">
        <h2>提供方 Providers</h2>
        {view.providers.length === 0 ? (
          <p className="muted">暂无。</p>
        ) : (
          <table className="table">
            <tbody>
              {view.providers.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong> <span className="muted small">{p.kind}</span>
                  </td>
                  <td className="muted small">{p.baseUrl}</td>
                  <td>
                    <code>{p.apiKeyHint}</code>
                  </td>
                  <td className="row end">
                    <button
                      className="btn ghost small"
                      onClick={() =>
                        run(async () => {
                          const model = view.presets[p.kind].models[0] ?? prompt("Model name to test") ?? "";
                          const r = await api<{ ok: boolean; error?: string; latencyMs?: number }>(`/api/admin/ai/providers/${p.id}/test`, { body: { model } });
                          if (r.ok) setNotice(`${p.name} OK (${r.latencyMs} ms)`);
                          else setError(`${p.name}: ${r.error}`);
                        })
                      }
                    >
                      测试连接 Test
                    </button>
                    <button className="btn ghost small" onClick={() => run(async () => void (await api(`/api/admin/ai/providers/${p.id}`, { method: "PATCH", body: { enabled: !p.enabled } })))}>
                      {p.enabled ? "停用" : "启用"}
                    </button>
                    <button className="btn ghost small" onClick={() => run(async () => void (await api(`/api/admin/ai/providers/${p.id}`, { method: "DELETE" })))}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <form
        className="card form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/api/admin/ai/routes", {
              method: "PUT",
              body: {
                capability: route.capability,
                primary: { providerId: route.providerId, model: route.model },
                fallback: route.fallbackProviderId && route.fallbackModel ? { providerId: route.fallbackProviderId, model: route.fallbackModel } : null,
              },
            });
            setNotice("路由已保存 · Route saved");
          });
        }}
      >
        <h2>能力路由 Capability routing</h2>
        <label>
          能力 Capability
          <select value={route.capability} onChange={(e) => setRoute({ ...route, capability: e.target.value })}>
            {view.capabilities.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          主模型 Provider
          <select value={route.providerId} onChange={(e) => setRoute({ ...route, providerId: e.target.value, model: modelsFor(e.target.value)[0] ?? "" })} required>
            <option value="">—</option>
            {view.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          模型 Model
          <input list="model-suggestions" value={route.model} onChange={(e) => setRoute({ ...route, model: e.target.value })} required />
          <datalist id="model-suggestions">
            {modelsFor(route.providerId).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label>
          备用 Fallback
          <select value={route.fallbackProviderId} onChange={(e) => setRoute({ ...route, fallbackProviderId: e.target.value, fallbackModel: modelsFor(e.target.value)[0] ?? "" })}>
            <option value="">无 none</option>
            {view.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          备用模型 Fallback model
          <input value={route.fallbackModel} onChange={(e) => setRoute({ ...route, fallbackModel: e.target.value })} />
        </label>
        <div className="form-actions">
          <button className="btn primary">保存路由 Save route</button>
        </div>
        {view.routes.length > 0 && (
          <table className="table span-all">
            <tbody>
              {view.routes.map((r) => (
                <tr key={r.capability}>
                  <td>
                    <code>{r.capability}</code>
                  </td>
                  <td>
                    {providerName(r.primaryProviderId)} / {r.primaryModel}
                  </td>
                  <td className="muted">{r.fallbackProviderId ? `↳ ${providerName(r.fallbackProviderId)} / ${r.fallbackModel}` : ""}</td>
                  <td className="row end">
                    <button type="button" className="btn ghost small" onClick={() => run(async () => void (await api(`/api/admin/ai/routes/${encodeURIComponent(r.capability)}`, { method: "DELETE" })))}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </form>

      <div className="card">
        <h2>最近调用 Recent AI calls</h2>
        <table className="table small">
          <tbody>
            {view.recentCalls.map((c) => (
              <tr key={c.id}>
                <td>{new Date(c.createdAt).toLocaleTimeString()}</td>
                <td>
                  <code>{c.capability}</code>
                </td>
                <td>
                  {providerName(c.providerId)} / {c.model}
                </td>
                <td>
                  <span className={`badge ${c.status === "ok" ? "ready" : "failed"}`}>{c.status}</span>
                </td>
                <td className="muted">
                  {c.latencyMs} ms · {c.inputTokens}/{c.outputTokens} tok
                </td>
                <td className="muted small">{c.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
