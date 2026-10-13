import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api.ts";
import { useAuth } from "../auth.tsx";

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
  stubFallback: boolean;
  providers: { id: string; kind: Kind; name: string; baseUrl: string; apiKeyHint: string; model: string; enabled: boolean }[];
  recentCalls: { id: string; capability: string; providerId: string; model: string; status: string; latencyMs: number; inputTokens: number; outputTokens: number; createdAt: number; error: string | null }[];
}

export function AdminPage() {
  const [tab, setTab] = useState<"users" | "ai" | "parsing">("users");
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
          <button className={tab === "parsing" ? "active" : ""} onClick={() => setTab("parsing")} data-testid="admin-tab-parsing">
            外部解析服务 Parsing
          </button>
        </div>
      </div>
      {tab === "users" ? <UsersPanel /> : tab === "ai" ? <AiPanel /> : <ParsingPanel />}
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

function AiPanel() {
  const { refresh } = useAuth();
  const [view, setView] = useState<AiView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState<{ kind: Kind; name: string; baseUrl: string; apiKey: string; model: string }>({ kind: "deepseek", name: "DeepSeek", baseUrl: "", apiKey: "", model: "deepseek-chat" });
  const load = useCallback(async () => setView(await api<AiView>("/api/admin/ai")), []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setError("");
    setNotice("");
    try {
      await fn();
      await Promise.all([load(), refresh()]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  if (!view) return <p className="muted">Loading…</p>;
  const preset = view.presets[form.kind];
  const providerName = (id: string | null) => view.providers.find((p) => p.id === id)?.name ?? id ?? "—";
  const active = view.providers.find((p) => p.enabled && p.model);

  return (
    <>
      {!active &&
        (view.stubFallback ? (
          <div className="alert info">尚未启用模型：当前使用本地确定性 stub 生成（仅用于开发调试）。No model enabled — the deterministic stub is used.</div>
        ) : (
          <div className="alert warn">尚未启用模型：老师现在无法生成大纲和幻灯片。请在下面添加并启用一个。· No model enabled: generation is unavailable.</div>
        ))}
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      <form
        className="card form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/api/admin/ai/providers", { body: { kind: form.kind, name: form.name, apiKey: form.apiKey, model: form.model, ...(form.baseUrl ? { baseUrl: form.baseUrl } : {}) } });
            setForm({ ...form, apiKey: "" });
            setNotice("已保存并启用，API Key 已加密存储 · Saved and enabled; key encrypted at rest");
          });
        }}
      >
        <h2>添加模型 Add model</h2>
        <p className="muted small span2">所有生成都用唯一启用的那个模型；添加新的会自动停用旧的。· One enabled provider + model serves every call.</p>
        <label>
          类型 Type
          <select
            value={form.kind}
            onChange={(e) => {
              const kind = e.target.value as Kind;
              setForm({ ...form, kind, name: view.presets[kind].label.split(" ")[0] ?? "", model: view.presets[kind].models[0] ?? "" });
            }}
          >
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
        <label>
          模型 Model
          <input list="model-suggestions" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} required />
          <datalist id="model-suggestions">
            {preset.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label>
          Base URL（OpenAI 兼容）
          <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={preset.baseUrl || "https://your-endpoint/v1"} required={form.kind === "custom"} />
        </label>
        <label className="span2">
          API Key
          <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} required autoComplete="off" />
        </label>
        <div className="form-actions">
          <button className="btn primary">保存并启用 Save &amp; enable</button>
        </div>
      </form>

      <div className="card">
        <h2>模型 Models</h2>
        {view.providers.length === 0 ? (
          <p className="muted">暂无。</p>
        ) : (
          <table className="table">
            <tbody>
              {view.providers.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong> <span className="muted small">{p.kind}</span> {p.id === active?.id && <span className="badge ready">使用中 active</span>}
                  </td>
                  <td>
                    <code>{p.model || "—"}</code>
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
                          const r = await api<{ ok: boolean; error?: string; latencyMs?: number }>(`/api/admin/ai/providers/${p.id}/test`, { body: {} });
                          if (r.ok) setNotice(`${p.name} / ${p.model} OK (${r.latencyMs} ms)`);
                          else setError(`${p.name}: ${r.error}`);
                        })
                      }
                    >
                      测试连接 Test
                    </button>
                    <button
                      className="btn ghost small"
                      onClick={() =>
                        run(async () => {
                          const model = prompt("模型名 Model", p.model)?.trim();
                          if (model) await api(`/api/admin/ai/providers/${p.id}`, { method: "PATCH", body: { model } });
                        })
                      }
                    >
                      改模型
                    </button>
                    <button className="btn ghost small" onClick={() => run(async () => void (await api(`/api/admin/ai/providers/${p.id}`, { method: "PATCH", body: { enabled: !p.enabled } })))}>
                      {p.enabled ? "停用" : "改用这个"}
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

interface ParsingView {
  externalEnabled: boolean;
  mineruMode: "agent" | "token";
  tokenHint: string | null;
  envToken: boolean;
  stub: boolean;
  limits: { bookAutoPages: number; userDayPages: number; siteDayPages: number };
  today: { site: number; org: number };
}

/** "外部解析服务": whether pages the browser could not read may be sent to MinerU. Off by default. */
function ParsingPanel() {
  const [view, setView] = useState<ParsingView | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => setView(await api<ParsingView>("/api/admin/parsing")), []);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (body: Record<string, unknown>, done: string) => {
    setError("");
    setNotice("");
    try {
      await api("/api/admin/parsing", { method: "PUT", body });
      await load();
      setNotice(done);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  if (!view) return <p className="muted">Loading…</p>;
  const noToken = view.mineruMode === "token" && !view.tokenHint && !view.envToken;

  return (
    <>
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}
      <div className="card stack" data-testid="parsing-panel">
        <div className="row between">
          <h2>外部解析服务 External parser</h2>
          <span className={`badge ${view.externalEnabled ? "note" : "warn"}`} data-testid="parsing-state">
            {view.externalEnabled ? "已开启 On" : "已关闭 Off"}
          </span>
        </div>
        <p className="small">
          浏览器读 PDF 时，扫描页、画成图形的公式和乱码字体读不出来。开启后，这些页会被单独切成一个小 PDF，经本站服务器转发给 <b>MinerU</b>（上海人工智能实验室 OpenDataLab 的在线服务）重新识别，识别出的文字存回这本教材；整本书不会发出去。老师也可以对表格、公式多的章节点“精修本章”。关闭时，老师可以把这些页的文字粘贴进来。
        </p>
        <p className="muted small">
          When on, pages the browser could not read are cut into a small PDF and sent through this server to MinerU (OpenDataLab); the rest of the book never leaves the browser. Off by default.
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={view.externalEnabled}
            onChange={(e) => void save({ externalEnabled: e.target.checked }, e.target.checked ? "已开启外部解析服务 · External parser on" : "已关闭外部解析服务 · External parser off")}
            data-testid="parsing-enabled"
          />
          <span>允许把读不全的页发送给 MinerU 识别 · Allow sending unreadable pages to MinerU</span>
        </label>
        <fieldset className="choice">
          <legend className="small">接口 API</legend>
          <label className="check-row">
            <input type="radio" name="mineru-mode" checked={view.mineruMode === "agent"} onChange={() => void save({ mineruMode: "agent" }, "已切换到免费轻量接口 · Using the token-free API")} />
            <span>免费轻量接口：不需要 Token，每次最多 10 页、10 MB，按 IP 限频 · Token-free agent API</span>
          </label>
          <label className="check-row">
            <input type="radio" name="mineru-mode" checked={view.mineruMode === "token"} onChange={() => void save({ mineruMode: "token" }, "已切换到精准接口 · Using the precise API")} />
            <span>精准接口（vlm 模型，更准）：需要 MinerU Token · Precise API (needs a token)</span>
          </label>
        </fieldset>
        {view.mineruMode === "token" && (
          <form
            className="row wrap"
            onSubmit={(e) => {
              e.preventDefault();
              void save({ token }, "Token 已加密保存 · Token saved (encrypted)").then(() => setToken(""));
            }}
          >
            <input type="password" placeholder={view.tokenHint ?? (view.envToken ? "使用服务器上的 MINERU_API_TOKEN" : "MinerU API Token")} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            <button className="btn small" disabled={token.trim().length < 8}>
              保存 Token
            </button>
            {view.tokenHint && (
              <button type="button" className="btn small ghost" onClick={() => void save({ token: null }, "Token 已删除 · Token removed")}>
                删除 Remove
              </button>
            )}
          </form>
        )}
        {noToken && <div className="alert warn">精准接口需要 Token，填好之前老师用不了外部解析服务 · The precise API needs a token</div>}
        {view.stub && <div className="alert info">开发 / 测试环境：外部解析服务用录制好的 MinerU 返回结果，不会真正发出页面 · Stubbed (recorded response)</div>}
        <p className="muted small" data-testid="parsing-usage">
          今天已送出 {view.today.org} 页（全站 {view.today.site} / {view.limits.siteDayPages}）· 每位老师每天最多 {view.limits.userDayPages} 页 · 每本书自动送出最多 {view.limits.bookAutoPages} 页
        </p>
      </div>
    </>
  );
}
