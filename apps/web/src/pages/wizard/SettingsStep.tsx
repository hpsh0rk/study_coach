import { useState } from "react";
import { useNavigate } from "react-router";
import { countPages } from "@kj/pdf-structure";
import { LANGUAGE_LABEL, LESSON_TYPE_LABEL, LEVEL_LABEL, planBudget } from "@kj/pedagogy";
import type { LessonParams, ThemeId } from "@kj/schema";
import { THEMES } from "@kj/templates/render";
import { ApiError } from "../../api.ts";
import { lessonApi, type LessonView } from "../../lessonApi.ts";
import { Stepper, StepIntro, type StepKey } from "./Stepper.tsx";

const MINUTE_CHOICES = [30, 35, 40, 45, 60, 80, 90];

/** How much textbook each minute has to cover; drives the density hint before any model call. */
export function pacing(minutes: number, pages: number): { perPage: number; level: "dense" | "ok" | "light"; text: string } {
  const perPage = pages ? minutes / pages : 0;
  if (perPage < 2) return { perPage, level: "dense", text: "内容偏多：每页教材不到 2 分钟，建议少选几页或延长课时 · Dense: consider fewer pages or a longer lesson" };
  if (perPage > 10) return { perPage, level: "light", text: "内容偏少：课时会有大量练习时间，可以多选几页 · Light: you could add pages" };
  return { perPage, level: "ok", text: "内容量合适 · Good fit" };
}

export function SettingsStep({ view, reached }: { view: LessonView; reached: StepKey }) {
  const nav = useNavigate();
  const [params, setParams] = useState<LessonParams>(view.lesson.params);
  const [theme, setTheme] = useState<ThemeId>(view.lesson.theme);
  const [title, setTitle] = useState(view.lesson.title);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const pages = countPages(view.lesson.scope.ranges);
  const p = pacing(params.minutes, pages);
  const budget = planBudget(params);
  const set = <K extends keyof LessonParams>(k: K, v: LessonParams[K]) => setParams({ ...params, [k]: v });

  async function go(redraft: boolean) {
    setError("");
    try {
      setBusy("save");
      await lessonApi.patch(view.lesson.id, { params, theme, title });
      if (redraft || !view.version) {
        setBusy("draft");
        await lessonApi.draft(view.lesson.id);
      }
      nav(`/lessons/${view.lesson.id}/outline`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      setBusy("");
    }
  }

  return (
    <div className="wizard">
      <Stepper current="settings" reached={reached} lessonId={view.lesson.id} />
      <StepIntro step="settings" />
      <div className="settings-grid">
        <div className="card form-grid">
          <label className="span2">
            课题 Lesson title
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </label>
          <fieldset className="span2 choice">
            <legend>课时 Lesson length</legend>
            {MINUTE_CHOICES.map((m) => (
              <button key={m} type="button" className={`chip ${params.minutes === m ? "on" : ""}`} onClick={() => set("minutes", m)}>
                {m} 分钟
              </button>
            ))}
            <input type="number" min={10} max={120} value={params.minutes} onChange={(e) => set("minutes", Math.max(10, Math.min(120, Number(e.target.value) || 40)))} aria-label="自定义分钟 Custom minutes" className="minutes-input" />
          </fieldset>
          <label>
            学生水平 Student level
            <select value={params.level} onChange={(e) => set("level", e.target.value as LessonParams["level"])}>
              {Object.entries(LEVEL_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            课型 Lesson type
            <select value={params.lessonType} onChange={(e) => set("lessonType", e.target.value as LessonParams["lessonType"])}>
              {Object.entries(LESSON_TYPE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            授课语言 Teaching language
            <select value={params.language} onChange={(e) => set("language", e.target.value as LessonParams["language"])}>
              {Object.entries(LANGUAGE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            主题 Theme
            <select value={theme} onChange={(e) => setTheme(e.target.value as ThemeId)}>
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="span2">
            重点（可选）Focus (optional)
            <input value={params.focus} onChange={(e) => set("focus", e.target.value)} maxLength={200} placeholder="例如：重点讲 v = fλ 的计算 · e.g. focus on calculating wave speed" />
          </label>
        </div>
        <aside className="card pacing" data-testid="pacing">
          <h2>这节课的内容量 · Pacing</h2>
          <div className="pacing-numbers">
            <div>
              <b>{pages}</b>
              <span>教材页 pages</span>
            </div>
            <div>
              <b>{p.perPage.toFixed(1)}</b>
              <span>分钟/页 min per page</span>
            </div>
            <div>
              <b>
                {budget.slideRange[0]}–{budget.slideRange[1]}
              </b>
              <span>预计幻灯片 slides</span>
            </div>
          </div>
          <div className={`density-bar ${p.level}`}>
            <span className="dot" /> {p.text}
          </div>
          <p className="muted small">
            大纲总时长允许在 {budget.minMinutes}–{budget.maxMinutes} 分钟之间（±15%），超出需要你再确认一次。 · The outline may total {budget.minMinutes}–{budget.maxMinutes} min.
          </p>
        </aside>
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="wizard-actions">
        <button className="btn ghost" onClick={() => nav(`/lessons/${view.lesson.id}/chapters`)}>
          ← 返回 Back
        </button>
        {view.version && (
          <button className="btn ghost" disabled={!!busy} onClick={() => go(true)}>
            重新生成大纲 Re-draft outline
          </button>
        )}
        <button className="btn primary" disabled={!!busy} onClick={() => go(false)}>
          {busy === "draft" ? "正在生成大纲… Drafting" : view.version ? "下一步：大纲 Next →" : "生成大纲 Draft outline →"}
        </button>
      </div>
    </div>
  );
}
