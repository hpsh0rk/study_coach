import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import type { AdminTab } from "./types.ts";

interface SetupView {
  ai: { state: "live"; provider: string; model: string } | { state: "stub" | "off" };
  vision: { state: "on" | "paid_off"; provider: string; model: string } | { state: "none" };
  external: ({ state: "on" } | { state: "off" } | { state: "unconfigured"; missing: "url" }) & { mode: "agent" | "selfhost"; stub: boolean };
  counts: { users: number; textbooks: number; lessons: number; parsedPagesToday: number; modelCallsToday: number; modelCallsPerDay: number };
}

function useSetupView(saved: number): SetupView | null {
  const [view, setView] = useState<SetupView | null>(null);
  useEffect(() => {
    void api<SetupView>("/api/admin/status").then(setView, () => undefined);
  }, [saved]);
  return view;
}

/** The default tab: a few counts and what each key-backed feature does now. */
export function Overview({ saved, open }: { saved: number; open: (tab: AdminTab) => void }) {
  const view = useSetupView(saved);
  if (!view) return <p className="muted">Loading…</p>;
  const counts = [
    { id: "users", label: "账号 Accounts", value: view.counts.users },
    { id: "textbooks", label: "教材 Textbooks", value: view.counts.textbooks },
    { id: "lessons", label: "课 Lessons", value: view.counts.lessons },
    { id: "parsed", label: "今天外部解析 Pages parsed today", value: view.counts.parsedPagesToday },
    { id: "model-calls", label: `今天调用 AI 模型（每人每天上限 ${view.counts.modelCallsPerDay}）Model calls today`, value: view.counts.modelCallsToday },
  ];
  return (
    <>
      <div className="stat-grid" data-testid="admin-counts">
        {counts.map((c) => (
          <div key={c.id} className="card stat" data-testid={`count-${c.id}`}>
            <div className="stat-value">{c.value}</div>
            <div className="muted small">{c.label}</div>
          </div>
        ))}
      </div>
      <SetupStatus view={view} open={open} />
    </>
  );
}

/** Outside the overview, only a missing AI model is worth a line: without it lessons are written from templates or not at all. */
export function CriticalBanner({ saved, open }: { saved: number; open: (tab: AdminTab) => void }) {
  const view = useSetupView(saved);
  if (!view || view.ai.state === "live") return null;
  return (
    <div className="alert warn row between" data-testid="critical-banner">
      <span>{view.ai.state === "stub" ? "还没有配置 AI 模型：现在是演示模式，大纲和幻灯片由内置模板生成。" : "还没有配置 AI 模型：老师现在无法生成大纲和幻灯片。"}</span>
      <button className="btn small" onClick={() => open("ai")}>
        去填写
      </button>
    </div>
  );
}

const MODE_LABEL = { agent: "MinerU 免费轻量接口", selfhost: "学校自部署的 MinerU" } as const;

/** What each key-backed feature does now and, when something is missing, which feature is off and what to fill in where. */
function setupRows(v: SetupView): { id: string; title: string; ok: boolean; badge: string; text: string; tab: AdminTab }[] {
  const ai =
    v.ai.state === "live"
      ? { ok: true, badge: "已配置", text: `${v.ai.provider} / ${v.ai.model}` }
      : {
          ok: false,
          badge: v.ai.state === "stub" ? "演示模式" : "未配置",
          text: `还没有配置 AI 模型：${v.ai.state === "stub" ? "大纲和幻灯片现在由内置模板生成，不是 AI 写的" : "老师现在无法生成大纲和幻灯片"}。请在“AI 模型”里添加一个提供方（DeepSeek、智谱 GLM 或任何 OpenAI 兼容接口）并填 API Key。`,
        };
  const vision =
    v.vision.state === "on"
      ? { ok: true, badge: "已配置", text: `${v.vision.provider} / ${v.vision.model}` }
      : v.vision.state === "paid_off"
        ? { ok: false, badge: "未开启", text: `${v.vision.model} 可能按页收费，还没有允许付费兜底：在“外部解析服务”页勾选“允许付费兜底”，或换成免费的智谱 glm-4.6v-flash。` }
        : { ok: false, badge: "未配置", text: "扫描页、公式页读不出时不能看图识别，只能老师粘贴文字。请在“AI 模型”页的“看图模型”里配一个（智谱 glm-4.6v-flash 免费）。" };
  const e = v.external;
  const external =
    e.state === "on"
      ? { ok: true, badge: "已开启", text: `${MODE_LABEL[e.mode]}${e.stub ? "（开发 / 测试环境：用录制好的返回结果，不真正发出页面）" : ""}` }
      : e.state === "off"
        ? { ok: false, badge: "已关闭", text: "管理员关闭了外部解析服务：读不全的页不会发给 MinerU，交给看图模型或老师粘贴。" }
        : {
            ok: false,
            badge: "未配置",
            text: "选了“MinerU 自部署”，但还没有填服务地址。填好之前不会发送任何页面。",
          };
  return [
    { id: "ai", title: "AI 模型（写大纲和幻灯片）", tab: "ai", ...ai },
    { id: "vision", title: "看图模型（识别扫描页、公式页）", tab: "ai", ...vision },
    { id: "external", title: "外部解析服务（MinerU）", tab: "parsing", ...external },
  ];
}

function SetupStatus({ view, open }: { view: SetupView; open: (tab: AdminTab) => void }) {
  const rows = setupRows(view);
  return (
    <div className="card setup-status" data-testid="setup-status">
      <h2>配置状态 Setup status</h2>
      <p className="muted small">所有 Key 都只保存在服务器上（加密），浏览器里只显示开头几个字。· Keys stay on the server, encrypted.</p>
      <table className="table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-testid={`setup-${r.id}`} data-ok={r.ok}>
              <td>
                <strong>{r.title}</strong>
              </td>
              <td>
                <span className={`badge ${r.ok ? "ready" : "warn"}`}>{r.badge}</span>
              </td>
              <td className="small">{r.text}</td>
              <td className="row end">
                {!r.ok && (
                  <button className="btn small" onClick={() => open(r.tab)} data-testid={`setup-${r.id}-go`}>
                    去填写
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
