import { Fragment, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../api.ts";
import { useAuth } from "../../auth.tsx";

type Kind = "deepseek" | "glm" | "custom";
type Protocol = "openai" | "messages";

interface AiProviderRow {
  id: string;
  purpose: "text" | "vision";
  kind: Kind;
  name: string;
  baseUrl: string;
  apiKeyHint: string;
  model: string;
  protocol: Protocol;
  maxTokens: number | null;
  /** Header name → masked value; the values never come back. */
  headerHints: Record<string, string>;
  enabled: boolean;
}

/** `message` is the plain-Chinese verdict: 连接成功 + latency + reply, or Key / model name / unreachable / HTTP error. */
type TestResult = { ok: boolean; message: string; kind?: string; error?: string; latencyMs?: number };

interface AiView {
  presets: Record<Kind, { label: string; baseUrl: string; models: string[]; visionModels: string[]; docs: string }>;
  stubFallback: boolean;
  providers: AiProviderRow[];
  recentCalls: { id: string; capability: string; providerId: string; model: string; status: string; latencyMs: number; inputTokens: number; outputTokens: number; createdAt: number; error: string | null }[];
}

interface Advanced {
  protocol: Protocol;
  maxTokens: string;
  headers: string;
}

const NO_ADVANCED: Advanced = { protocol: "openai", maxTokens: "", headers: "" };

/** One "name: value" per line. On edit, a name with no value keeps the stored value. */
function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    const name = (i < 0 ? line : line.slice(0, i)).trim();
    if (name) out[name] = i < 0 ? "" : line.slice(i + 1).trim();
  }
  return out;
}

const advancedBody = (a: Advanced) => ({ protocol: a.protocol, maxTokens: a.maxTokens ? Number(a.maxTokens) : null, headers: parseHeaders(a.headers) });

function protocolSummary(p: AiProviderRow): string {
  const parts = [p.protocol === "messages" ? "Messages /v1/messages" : "OpenAI Chat Completions"];
  if (p.maxTokens) parts.push(`max_tokens ${p.maxTokens}`);
  const headers = Object.entries(p.headerHints);
  if (headers.length) parts.push(`请求头 ${headers.map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  return parts.join(" · ");
}

function AdvancedFields({ value, onChange, prefix }: { value: Advanced; onChange: (a: Advanced) => void; prefix: string }) {
  return (
    <>
      <label>
        接口协议 Protocol
        <select value={value.protocol} onChange={(e) => onChange({ ...value, protocol: e.target.value as Protocol })} data-testid={`${prefix}-protocol`}>
          <option value="openai">OpenAI Chat Completions（OpenAI 兼容）</option>
          <option value="messages">Messages（/v1/messages，Anthropic 兼容）</option>
        </select>
      </label>
      <label>
        max_tokens（可选）
        <input
          type="number"
          min={16}
          value={value.maxTokens}
          onChange={(e) => onChange({ ...value, maxTokens: e.target.value })}
          placeholder={value.protocol === "messages" ? "不填为 4096" : "不填用默认"}
          data-testid={`${prefix}-max-tokens`}
        />
      </label>
      <label className="span2">
        自定义请求头（可选）Custom headers
        <textarea rows={2} value={value.headers} onChange={(e) => onChange({ ...value, headers: e.target.value })} placeholder="x-source: tensorhawk" data-testid={`${prefix}-headers`} />
        <span className="muted small">每行一个“名称: 值”，比如公司网关要求的 x-source。值和 Key 一样加密保存，浏览器里只显示开头几个字。· One per line; values are stored like the key.</span>
      </label>
    </>
  );
}

/** Protocol, max_tokens and headers of a saved provider; a header left without a value keeps its stored value. */
function AdvancedEdit({ p, run, done }: { p: AiProviderRow; run: (fn: () => Promise<void>) => Promise<void>; done: () => void }) {
  const [value, setValue] = useState<Advanced>({
    protocol: p.protocol,
    maxTokens: p.maxTokens ? String(p.maxTokens) : "",
    headers: Object.keys(p.headerHints)
      .map((k) => `${k}:`)
      .join("\n"),
  });
  const [apiKey, setApiKey] = useState("");
  const moved = value.protocol !== p.protocol;
  return (
    <form
      className="form-grid"
      data-testid="advanced-edit"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/api/admin/ai/providers/${p.id}`, { method: "PATCH", body: { ...advancedBody(value), ...(moved ? { apiKey } : {}) } });
          done();
        });
      }}
    >
      <AdvancedFields value={value} onChange={setValue} prefix="edit" />
      {moved && (
        <label className="span2">
          API Key（改协议要重新填写）
          <input type="password" required minLength={8} value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" data-testid="edit-api-key" />
          <span className="muted small">已保存的 Key 和请求头的值只发给原来的地址和协议；改了就要重新填写。· The stored key only goes where it was first sent.</span>
        </label>
      )}
      <p className="muted small span2">已保存的请求头只列出名称；名称后面留空表示保留原来的值，删掉那一行表示不再发送。· Blank value keeps the stored one.</p>
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={done}>
          取消
        </button>
        <button className="btn primary" data-testid="advanced-save">
          保存 Save
        </button>
      </div>
    </form>
  );
}

export function AiPanel({ onSaved }: { onSaved: () => void }) {
  const { refresh } = useAuth();
  const [view, setView] = useState<AiView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState<{ kind: Kind; name: string; baseUrl: string; apiKey: string; model: string }>({
    kind: "deepseek",
    name: "DeepSeek",
    baseUrl: "",
    apiKey: "",
    model: "deepseek-chat",
  });
  const [advanced, setAdvanced] = useState<Advanced>(NO_ADVANCED);
  const [editing, setEditing] = useState<string | null>(null);
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
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  if (!view) return <p className="muted">Loading…</p>;
  const preset = view.presets[form.kind];
  const providerName = (id: string | null) => view.providers.find((p) => p.id === id)?.name ?? id ?? "—";
  const textProviders = view.providers.filter((p) => p.purpose === "text");
  const active = textProviders.find((p) => p.enabled && p.model);
  const test = (p: AiProviderRow) =>
    run(async () => {
      const r = await api<TestResult>(`/api/admin/ai/providers/${p.id}/test`, { body: {} });
      if (r.ok) setNotice(`测试连接：${p.name} / ${p.model} · ${r.message}`);
      else setError(`测试连接：${p.name} / ${p.model} · ${r.message}`);
    });

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
        data-testid="add-model-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/api/admin/ai/providers", {
              body: { kind: form.kind, name: form.name, apiKey: form.apiKey, model: form.model, ...advancedBody(advanced), ...(form.baseUrl ? { baseUrl: form.baseUrl } : {}) },
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
          Base URL
          <input
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            placeholder={advanced.protocol === "messages" ? "http://your-gateway（请求 {base}/v1/messages）" : preset.baseUrl || "https://your-endpoint/v1"}
            required={form.kind === "custom"}
            data-testid="model-base-url"
          />
        </label>
        <AdvancedFields value={advanced} onChange={setAdvanced} prefix="model" />
        <label className="span2">
          API Key
          <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} required autoComplete="new-password" />
        </label>
        <div className="form-actions">
          <button className="btn primary">保存并启用 Save &amp; enable</button>
        </div>
      </form>

      <div className="card">
        <h2>模型 Models</h2>
        {textProviders.length === 0 ? (
          <p className="muted">暂无。</p>
        ) : (
          <table className="table">
            <tbody>
              {textProviders.map((p) => (
                <Fragment key={p.id}>
                <tr>
                  <td>
                    <strong>{p.name}</strong> <span className="muted small">{p.kind}</span> {p.id === active?.id && <span className="badge ready">使用中 active</span>}
                  </td>
                  <td>
                    <code>{p.model || "—"}</code>
                  </td>
                  <td className="muted small">
                    {p.baseUrl}
                    <div data-testid="protocol-summary">{protocolSummary(p)}</div>
                  </td>
                  <td>
                    <code>{p.apiKeyHint}</code>
                  </td>
                  <td className="row end">
                    <button className="btn ghost small" onClick={() => setEditing(editing === p.id ? null : p.id)} data-testid="advanced-toggle">
                      协议与请求头
                    </button>
                    <button className="btn ghost small" onClick={() => test(p)}>
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
                {editing === p.id && (
                  <tr>
                    <td colSpan={5}>
                      <AdvancedEdit p={p} run={run} done={() => setEditing(null)} />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <VisionProviderCard view={view} run={run} test={test} />

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

/** The provider that reads page images, with its own key (the text provider's key again when it is the same provider). */
function VisionProviderCard({ view, run, test }: { view: AiView; run: (fn: () => Promise<void>) => Promise<void>; test: (p: AiProviderRow) => Promise<void> }) {
  const [form, setForm] = useState<{ kind: Kind; name: string; baseUrl: string; apiKey: string; model: string }>({ kind: "glm", name: "智谱 GLM", baseUrl: "", apiKey: "", model: "glm-4.6v-flash" });
  const [advanced, setAdvanced] = useState<Advanced>(NO_ADVANCED);
  const [editing, setEditing] = useState<string | null>(null);
  const rows = view.providers.filter((p) => p.purpose === "vision");
  const inUse = rows.find((p) => p.enabled && p.model);
  const preset = view.presets[form.kind];
  return (
    <div className="card stack" data-testid="vision-provider-card">
      <h2>看图模型（可选）Vision model</h2>
      <p className="muted small">
        浏览器读不出的扫描页、公式页，可以把页面图片交给看图模型识别。文字和看图用同一家（比如都用智谱 GLM）时，这里再填一次同一个 Key；文字用 DeepSeek
        这类没有看图模型的提供方时，另填一家的 Key：智谱 <code>glm-4.6v-flash</code>（免费），或阿里百炼{" "}
        <code>qwen-vl-ocr</code>（选“Custom”，Base URL 填 <code>https://dashscope.aliyuncs.com/compatible-mode/v1</code>）。· Reads page images with its own key.
      </p>
      <div className={`alert ${inUse ? "info" : "warn"}`} data-testid="vision-in-use">
        {inUse
          ? `现在读图用：${inUse.name} / ${inUse.model} · In use`
          : "还没有看图模型：读不出的页只能交给外部解析服务，或老师粘贴文字。在这里填一个。· No vision model"}
      </div>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/api/admin/ai/providers", {
              body: { purpose: "vision", kind: form.kind, name: form.name, apiKey: form.apiKey, model: form.model, ...advancedBody(advanced), ...(form.baseUrl ? { baseUrl: form.baseUrl } : {}) },
            });
            setForm({ ...form, apiKey: "" });
          });
        }}
      >
        <label>
          类型 Type
          <select
            value={form.kind}
            onChange={(e) => {
              const kind = e.target.value as Kind;
              setForm({ ...form, kind, name: kind === "glm" ? "智谱 GLM" : kind === "custom" ? "阿里百炼 Qwen" : view.presets[kind].label, model: view.presets[kind].visionModels[0] ?? "" });
            }}
            data-testid="vision-provider-kind"
          >
            {(Object.keys(view.presets) as Kind[])
              .filter((k) => view.presets[k].visionModels.length > 0)
              .map((k) => (
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
          看图模型 Vision model
          <input list="vision-only-suggestions" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} required data-testid="vision-provider-model" />
          <datalist id="vision-only-suggestions">
            {preset.visionModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label>
          Base URL
          <input
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            placeholder={preset.baseUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1"}
            required={form.kind === "custom"}
            data-testid="vision-provider-base-url"
          />
        </label>
        <AdvancedFields value={advanced} onChange={setAdvanced} prefix="vision-provider" />
        <label className="span2">
          API Key
          <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} required autoComplete="new-password" data-testid="vision-provider-key" />
          <span className="muted small">加密保存在服务器上，浏览器里只显示开头几个字。· Encrypted on the server; only a hint comes back.</span>
        </label>
        <div className="form-actions">
          <button className="btn primary" data-testid="vision-provider-save">
            保存并启用 Save &amp; enable
          </button>
        </div>
      </form>
      {rows.length > 0 && (
        <table className="table">
          <tbody>
            {rows.map((p) => (
              <Fragment key={p.id}>
              <tr data-testid="vision-provider-row">
                <td>
                  <strong>{p.name}</strong> <span className="muted small">{p.kind}</span> {p.id === inUse?.id && <span className="badge ready">使用中 active</span>}
                </td>
                <td>
                  <code>{p.model}</code>
                </td>
                <td className="muted small">
                  {p.baseUrl}
                  <div>{protocolSummary(p)}</div>
                </td>
                <td>
                  <code>{p.apiKeyHint}</code>
                </td>
                <td className="row end">
                  <button className="btn ghost small" onClick={() => setEditing(editing === p.id ? null : p.id)}>
                    协议与请求头
                  </button>
                  <button className="btn ghost small" onClick={() => test(p)} data-testid="vision-provider-test">
                    测试连接 Test
                  </button>
                  <button
                    className="btn ghost small"
                    onClick={() =>
                      run(async () => {
                        const model = prompt("看图模型 Vision model", p.model)?.trim();
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
              {editing === p.id && (
                <tr>
                  <td colSpan={5}>
                    <AdvancedEdit p={p} run={run} done={() => setEditing(null)} />
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
