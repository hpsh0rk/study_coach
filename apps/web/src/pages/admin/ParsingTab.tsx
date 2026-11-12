import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../api.ts";

type ExternalChoice = "auto" | "off";
type MineruApi = "agent" | "selfhost";

interface ParsingView {
  externalChoice: ExternalChoice;
  external: { state: "on" } | { state: "off" } | { state: "unconfigured"; missing: "url" };
  mineruMode: MineruApi;
  selfhostUrlHint: string | null;
  selfhostKeyHint: string | null;
  stub: boolean;
  dayPages: number;
  today: number;
  paidEnabled: boolean;
  vision: { model: string; free: boolean } | null;
}

const STATE_BADGE = {
  on: { cls: "note", text: "已开启 On" },
  off: { cls: "warn", text: "已关闭 Off" },
  unconfigured: { cls: "warn", text: "未配置 Not configured" },
} as const;

const MODE_NOTICE: Record<MineruApi, string> = {
  agent: "已切换到免费轻量接口 · Using the token-free API",
  selfhost: "已切换到学校自部署的 MinerU · Using the self-hosted MinerU",
};

/** "外部解析服务": whether pages the browser could not read go to MinerU (online, or the school's own server). On once configured, unless an admin turns it off. */
export function ParsingPanel({ onSaved }: { onSaved: () => void }) {
  const [view, setView] = useState<ParsingView | null>(null);
  const [selfhostUrl, setSelfhostUrl] = useState("");
  const [selfhostKey, setSelfhostKey] = useState("");
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
    const { externalChoice, mineruMode, paidEnabled } = body as Partial<Pick<ParsingView, "externalChoice" | "mineruMode" | "paidEnabled">>;
    setView((v) => v && { ...v, ...(externalChoice && { externalChoice }), ...(mineruMode && { mineruMode }), ...(paidEnabled !== undefined && { paidEnabled }) });
    try {
      await api("/api/admin/parsing", { method: "PUT", body });
      await load();
      onSaved();
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
  const visionUsable = !!view.vision && (view.vision.free || view.paidEnabled);
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
        <label className="check-row">
          <input
            type="checkbox"
            checked={view.externalChoice === "auto"}
            onChange={(e) => void save({ externalChoice: e.target.checked ? "auto" : "off" }, e.target.checked ? "已开启外部解析服务 · External parser on" : "已关闭外部解析服务 · External parser off")}
            data-testid="external-enabled"
          />
          <span>开启外部解析服务（默认开）：下面选的接口配置好就发送；关掉后不发送任何页面 · On once the chosen API is configured; off sends nothing</span>
        </label>
        <fieldset className="choice">
          <legend className="small">接口 API</legend>
          <label className="check-row">
            <input type="radio" name="mineru-mode" checked={view.mineruMode === "agent"} onChange={() => void save({ mineruMode: "agent" }, MODE_NOTICE.agent)} data-testid="mineru-mode-agent" />
            <span>免费轻量接口：不需要 Token，每次最多 10 页、10 MB，按 IP 限频 · Token-free agent API</span>
          </label>
          <label className="check-row">
            <input type="radio" name="mineru-mode" checked={view.mineruMode === "selfhost"} onChange={() => void save({ mineruMode: "selfhost" }, MODE_NOTICE.selfhost)} data-testid="mineru-mode-selfhost" />
            <span>MinerU 自部署：学校自己的 mineru-api 服务（MinerU 4 或更新版本的 /v1 接口），填地址和可选的 API Key · Self-hosted MinerU</span>
          </label>
        </fieldset>
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
              <input type="password" value={selfhostKey} onChange={(e) => setSelfhostKey(e.target.value)} placeholder={view.selfhostKeyHint ?? "—"} autoComplete="new-password" data-testid="selfhost-key" />
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
            还没有填写自部署 MinerU 的地址：填好之前外部解析服务不会开启，读不全的页交给看图模型（如果配置了）或老师粘贴。· Enter the self-hosted URL to turn it on.
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
          今天全校已送出 {view.today} 页 · 每位老师每天最多 {view.dayPages} 页（外部解析和看图模型合计）
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
          <p className="small">
            看图模型 <code>{view.vision.model}</code> · {view.vision.free ? "免费" : "可能按页收费：打开下面的“允许付费兜底”才会用"}
          </p>
        ) : (
          <div className="alert info" data-testid="vision-none">
            还没有配置看图模型：在“AI 模型”页的“看图模型”里添加一个，例如智谱 <code>glm-4.6v-flash</code>（免费）或百炼 <code>qwen-vl-ocr</code>（收费）。· No vision model configured.
          </div>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            checked={view.paidEnabled}
            onChange={(e) => void save({ paidEnabled: e.target.checked }, e.target.checked ? "已允许付费兜底 · Paid parsing allowed" : "已关闭付费兜底 · Paid parsing off")}
            data-testid="paid-enabled"
          />
          <span>允许付费兜底：免费的 glm-4.6v-flash 以外的看图模型可能按页收费，只在这里打开后才会用（仍受每位老师每天 {view.dayPages} 页的限制）· Allow paid vision models</span>
        </label>
      </div>
    </>
  );
}
