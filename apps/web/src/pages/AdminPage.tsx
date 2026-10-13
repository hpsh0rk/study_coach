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
  presets: Record<Kind, { label: string; baseUrl: string; models: string[]; visionModels: string[]; docs: string }>;
  stubFallback: boolean;
  providers: { id: string; kind: Kind; name: string; baseUrl: string; apiKeyHint: string; model: string; visionModel: string; enabled: boolean }[];
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
  const [form, setForm] = useState<{ kind: Kind; name: string; baseUrl: string; apiKey: string; model: string; visionModel: string }>({
    kind: "deepseek",
    name: "DeepSeek",
    baseUrl: "",
    apiKey: "",
    model: "deepseek-chat",
    visionModel: "",
  });
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
            await api("/api/admin/ai/providers", {
              body: { kind: form.kind, name: form.name, apiKey: form.apiKey, model: form.model, visionModel: form.visionModel, ...(form.baseUrl ? { baseUrl: form.baseUrl } : {}) },
            });
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
              setForm({ ...form, kind, name: view.presets[kind].label.split(" ")[0] ?? "", model: view.presets[kind].models[0] ?? "", visionModel: "" });
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
          看图模型（可选）Vision model
          <input list="vision-model-suggestions" value={form.visionModel} onChange={(e) => setForm({ ...form, visionModel: e.target.value })} placeholder={preset.visionModels[0] ?? "—"} data-testid="vision-model" />
          <datalist id="vision-model-suggestions">
            {preset.visionModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <span className="muted small">浏览器读不出的扫描页、公式页，可以把页面图片交给它识别；同一个提供方、同一个 Key。· Reads page images the browser could not.</span>
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
                    {p.visionModel && (
                      <div className="muted small">
                        看图 vision: <code>{p.visionModel}</code>
                      </div>
                    )}
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
                    <button
                      className="btn ghost small"
                      onClick={() =>
                        run(async () => {
                          const visionModel = prompt("看图模型（留空表示不用）Vision model (empty: none)", p.visionModel);
                          if (visionModel !== null) await api(`/api/admin/ai/providers/${p.id}`, { method: "PATCH", body: { visionModel: visionModel.trim() } });
                        })
                      }
                    >
                      改看图模型
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

type ExternalChoice = "auto" | "on" | "off";
type MineruApi = "agent" | "token" | "selfhost";

interface ParsingView {
  externalChoice: ExternalChoice;
  external: { state: "on" } | { state: "off" } | { state: "unconfigured"; missing: "token" | "url" };
  mineruMode: MineruApi;
  tokenHint: string | null;
  envToken: boolean;
  selfhostUrlHint: string | null;
  selfhostKeyHint: string | null;
  stub: boolean;
  limits: { bookAutoPages: number; userDayPages: number; siteDayPages: number; bookCostMicroYuan: number };
  today: { site: number; org: number; monthCostMicroYuan: number };
  paidEnabled: boolean;
  monthlyBudgetMicroYuan: number;
  vision: { model: string; microYuanPerPage: number; source: "admin" | "list" | "unknown" } | null;
}

/** Micro-yuan as 元 for display. */
const yuan = (micro: number) => `${(micro / 1_000_000).toFixed(micro % 10_000 ? 4 : 2)} 元`;
const PRICE_SOURCE = { admin: "管理员填写", list: "列表价", unknown: "未知模型，按最贵的列表价计" } as const;

const STATE_BADGE = {
  on: { cls: "note", text: "已开启 On" },
  off: { cls: "warn", text: "已关闭 Off" },
  unconfigured: { cls: "warn", text: "未配置 Not configured" },
} as const;

const MODE_NOTICE: Record<MineruApi, string> = {
  agent: "已切换到免费轻量接口 · Using the token-free API",
  token: "已切换到精准接口 · Using the precise API",
  selfhost: "已切换到学校自部署的 MinerU · Using the self-hosted MinerU",
};

/** "外部解析服务": whether pages the browser could not read go to MinerU (online, or the school's own server). On once configured, unless an admin turns it off. */
function ParsingPanel() {
  const [view, setView] = useState<ParsingView | null>(null);
  const [token, setToken] = useState("");
  const [selfhostUrl, setSelfhostUrl] = useState("");
  const [selfhostKey, setSelfhostKey] = useState("");
  const [price, setPrice] = useState("");
  const [budget, setBudget] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testing, setTesting] = useState(false);
  const load = useCallback(async () => setView(await api<ParsingView>("/api/admin/parsing")), []);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (body: Record<string, unknown>, done: string) => {
    setError("");
    setNotice("");
    const { externalChoice, mineruMode } = body as Partial<Pick<ParsingView, "externalChoice" | "mineruMode">>;
    if (externalChoice || mineruMode) setView((v) => v && { ...v, ...(externalChoice && { externalChoice }), ...(mineruMode && { mineruMode }) });
    try {
      await api("/api/admin/parsing", { method: "PUT", body });
      await load();
      setNotice(done);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      await load().catch(() => undefined);
    }
  };
  const test = async () => {
    setError("");
    setNotice("");
    setTesting(true);
    try {
      const r = await api<{ ok: boolean; message: string }>("/api/admin/parsing/test", { body: {} });
      (r.ok ? setNotice : setError)(`测试连接：${r.message}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };
  if (!view) return <p className="muted">Loading…</p>;
  const visionUsable = !!view.vision && (view.vision.microYuanPerPage === 0 || view.paidEnabled);
  const badge = STATE_BADGE[view.external.state];

  return (
    <>
      {error && (
        <div className="alert error" data-testid="parsing-error">
          {error}
        </div>
      )}
      {notice && (
        <div className="alert success" data-testid="parsing-notice">
          {notice}
        </div>
      )}
      <div className="card stack" data-testid="parsing-panel">
        <div className="row between">
          <h2>外部解析服务 External parser</h2>
          <span className={`badge ${badge.cls}`} data-testid="parsing-state">
            {badge.text}
          </span>
        </div>
        <p className="small">
          浏览器读 PDF 时，扫描页、画成图形的公式和乱码字体读不出来。这些页会被单独切成一个小 PDF，经本站服务器转发给 <b>MinerU</b> 重新识别（OpenDataLab 的在线服务，或学校自己部署的 MinerU），识别出的文字存回这本教材；整本书不会发出去。老师也可以对表格、公式多的章节点“精修本章”。外部解析用不了时，这些页交给下面的看图模型（如果配置了），再不行由老师粘贴文字。
        </p>
        <p className="muted small">
          Pages the browser could not read are cut into a small PDF and sent through this server to MinerU (online, or your own server); the rest of the book never leaves the browser. On by default once the chosen API is configured.
        </p>
        <fieldset className="choice">
          <legend className="small">开关 Switch</legend>
          {(
            [
              ["auto", "跟随配置（默认）：下面选的接口配置好就开启 · On once configured"],
              ["on", "开启 · On"],
              ["off", "关闭：不发送任何页面 · Off: send nothing"],
            ] as const
          ).map(([choice, label]) => (
            <label className="check-row" key={choice}>
              <input
                type="radio"
                name="external-choice"
                checked={view.externalChoice === choice}
                onChange={() => void save({ externalChoice: choice }, choice === "off" ? "已关闭外部解析服务 · External parser off" : "已保存 · Saved")}
                data-testid={`external-choice-${choice}`}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="choice">
          <legend className="small">接口 API</legend>
          <label className="check-row">
            <input type="radio" name="mineru-mode" checked={view.mineruMode === "agent"} onChange={() => void save({ mineruMode: "agent" }, MODE_NOTICE.agent)} data-testid="mineru-mode-agent" />
            <span>免费轻量接口：不需要 Token，每次最多 10 页、10 MB，按 IP 限频 · Token-free agent API</span>
          </label>
          <label className="check-row">
            <input type="radio" name="mineru-mode" checked={view.mineruMode === "token"} onChange={() => void save({ mineruMode: "token" }, MODE_NOTICE.token)} data-testid="mineru-mode-token" />
            <span>精准接口（vlm 模型，更准）：需要 MinerU Token · Precise API (needs a token)</span>
          </label>
          <label className="check-row">
            <input type="radio" name="mineru-mode" checked={view.mineruMode === "selfhost"} onChange={() => void save({ mineruMode: "selfhost" }, MODE_NOTICE.selfhost)} data-testid="mineru-mode-selfhost" />
            <span>MinerU 自部署：学校自己的 mineru-api 服务（MinerU 4 的 /v1 接口，或 3.x 的 /tasks 接口），填地址和可选的 API Key · Self-hosted MinerU</span>
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
        {view.mineruMode === "selfhost" && (
          <form
            className="form-grid"
            data-testid="selfhost-form"
            onSubmit={(e) => {
              e.preventDefault();
              const body: Record<string, string> = {};
              if (selfhostUrl.trim()) body.selfhostUrl = selfhostUrl.trim();
              if (selfhostKey.trim()) body.selfhostKey = selfhostKey.trim();
              void save(body, "已加密保存 · Saved (encrypted)").then(() => {
                setSelfhostUrl("");
                setSelfhostKey("");
              });
            }}
          >
            <label>
              服务地址 Base URL
              <input value={selfhostUrl} onChange={(e) => setSelfhostUrl(e.target.value)} placeholder={view.selfhostUrlHint ? `已保存：${view.selfhostUrlHint}` : "http://127.0.0.1:8000"} autoComplete="off" data-testid="selfhost-url" />
            </label>
            <label>
              API Key（可选，服务用 --api-key 启动时填）
              <input type="password" value={selfhostKey} onChange={(e) => setSelfhostKey(e.target.value)} placeholder={view.selfhostKeyHint ?? "—"} autoComplete="off" data-testid="selfhost-key" />
            </label>
            <p className="muted small span2">
              地址填到 /v1 之前，例如 <code>https://mineru.your-school.cn</code>。本站服务器要能访问到它（线上部署时用公网地址或 Cloudflare Tunnel；本机开发可以用 127.0.0.1）。地址和 Key 加密存在服务器上，浏览器里只显示开头几个字符。
            </p>
            <div className="form-actions">
              {view.selfhostKeyHint && (
                <button type="button" className="btn small ghost" onClick={() => void save({ selfhostKey: null }, "API Key 已删除 · Key removed")}>
                  删除 Key
                </button>
              )}
              <button className="btn small" disabled={!selfhostUrl.trim() && !selfhostKey.trim()} data-testid="selfhost-save">
                保存 Save
              </button>
            </div>
          </form>
        )}
        {view.external.state === "unconfigured" && (
          <div className="alert warn" data-testid="parsing-missing">
            {view.external.missing === "url"
              ? "还没有填写自部署 MinerU 的地址：填好之前外部解析服务不会开启，读不全的页交给看图模型（如果配置了）或老师粘贴。· Enter the self-hosted URL to turn it on."
              : "精准接口需要 MinerU Token：填好之前外部解析服务不会开启，读不全的页交给看图模型（如果配置了）或老师粘贴。· The precise API needs a token."}
          </div>
        )}
        {view.stub && <div className="alert info">开发 / 测试环境：MinerU 在线接口用录制好的返回结果，不会真正发出页面（自部署按填写的地址连接）· Online API stubbed</div>}
        <div className="row wrap">
          <button className="btn small" onClick={() => void test()} disabled={testing || view.external.state === "unconfigured"} data-testid="parsing-test">
            {testing ? "测试中… Testing" : "测试连接 Test connection"}
          </button>
          <span className="muted small">只检查能否连上、Key 对不对，不发送任何页面 · Sends no page</span>
        </div>
        <p className="muted small" data-testid="parsing-usage">
          今天已送出 {view.today.org} 页（MinerU 在线接口全站 {view.today.site} / {view.limits.siteDayPages}，自部署不计）· 每位老师每天最多 {view.limits.userDayPages} 页 · 每本书自动送出最多 {view.limits.bookAutoPages} 页
        </p>
      </div>

      <div className="card stack" data-testid="vision-panel">
        <div className="row between">
          <h2>看图模型兜底 Vision fallback</h2>
          {view.vision && (
            <span className={`badge ${visionUsable ? "note" : "warn"}`} data-testid="vision-usable">
              {visionUsable ? "可用 Usable" : "要付费，未开启 Paid · off"}
            </span>
          )}
        </div>
        <p className="small">
          外部解析服务关着、或者它没读出来的页，可以由“AI 模型”里配置的看图模型识别：浏览器把那一页画成图片，经本站服务器发给模型。读出的文字会标上“看图识别”，提醒老师核对公式和数字。没有配置看图模型时，老师粘贴文字补上。
        </p>
        {view.vision ? (
          <>
            <p className="small">
              看图模型 <code>{view.vision.model}</code> · 每千页约 <b>{yuan(view.vision.microYuanPerPage * 1000)}</b>（{PRICE_SOURCE[view.vision.source]}）
            </p>
            <form
              className="row wrap"
              onSubmit={(e) => {
                e.preventDefault();
                void save({ visionPriceMicroYuan: Math.round(Number(price) * 1000) }, "价格已保存 · Price saved").then(() => setPrice(""));
              }}
            >
              <label className="check-row">
                <span>每千页价格（元）Price per 1000 pages</span>
                <input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={String(view.vision.microYuanPerPage / 1000)} data-testid="vision-price" />
              </label>
              <button className="btn small" disabled={price.trim() === "" || !(Number(price) >= 0)} data-testid="vision-price-save">
                保存价格
              </button>
              {view.vision.source === "admin" && (
                <button type="button" className="btn small ghost" onClick={() => void save({ visionPriceMicroYuan: null }, "已恢复列表价 · Back to the list price")}>
                  恢复列表价
                </button>
              )}
            </form>
          </>
        ) : (
          <div className="alert info" data-testid="vision-none">
            还没有配置看图模型：在“AI 模型”里给启用的模型填写“看图模型”，例如智谱 <code>glm-4.6v-flash</code>（免费）或百炼 <code>qwen-vl-ocr</code>（约 0.9 元 / 千页）。· No vision model configured.
          </div>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            checked={view.paidEnabled}
            onChange={(e) => void save({ paidEnabled: e.target.checked }, e.target.checked ? "已允许付费兜底 · Paid parsing allowed" : "已关闭付费兜底 · Paid parsing off")}
            data-testid="paid-enabled"
          />
          <span>允许付费兜底：要花钱的解析（每页价格大于 0）只在这里打开后才会用，并受下面的月度预算和每本书 {yuan(view.limits.bookCostMicroYuan)} 的上限约束 · Allow paid parsing</span>
        </label>
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ monthlyBudgetMicroYuan: Math.round(Number(budget) * 1_000_000) }, "月度预算已保存 · Monthly budget saved").then(() => setBudget(""));
          }}
        >
          <label className="check-row">
            <span>每月预算（元）Monthly budget</span>
            <input type="number" min="0" step="1" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={String(view.monthlyBudgetMicroYuan / 1_000_000)} data-testid="monthly-budget" />
          </label>
          <button className="btn small" disabled={budget.trim() === "" || !(Number(budget) >= 0)} data-testid="monthly-budget-save">
            保存预算
          </button>
        </form>
        <p className="muted small" data-testid="parsing-month">
          本月已花 {yuan(view.today.monthCostMicroYuan)} / 预算 {yuan(view.monthlyBudgetMicroYuan)}
        </p>
      </div>
    </>
  );
}
