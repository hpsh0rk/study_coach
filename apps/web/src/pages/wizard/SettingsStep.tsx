import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { countPages } from "@kj/pdf-structure";
import { LANGUAGE_LABEL, LESSON_TYPE_LABEL, LEVEL_LABEL, planBudget, scopeAdvice, type ScopeAdvice } from "@kj/pedagogy";
import type { LessonParams, ThemeId } from "@kj/schema";
import { THEMES } from "@kj/templates/render";
import { ApiError } from "../../api.ts";
import { lessonApi, type LessonView } from "../../lessonApi.ts";
import { fmtPages } from "./ChaptersStep.tsx";
import { DraftingProgress } from "./drafting.tsx";
import { Stepper, StepIntro, type StepKey } from "./Stepper.tsx";

const MINUTE_CHOICES = [30, 35, 40, 45, 60, 80, 90];

/**
 * Selection size vs lesson length (words-based estimate); drives the hint before any model call.
 * `unread`: pages the outline cannot read (formatted), which rules out "good fit".
 */
function pacing(minutes: number, words: number, unreadPages = 0, unread = ""): ScopeAdvice & { level: "dense" | "ok" | "light"; text: string } {
  const a = scopeAdvice(words, minutes, unreadPages);
  if (a.unreadPages > 0) {
    return { ...a, level: "dense", text: `第 ${unread} 页读不进大纲（所选内容超过一份大纲能读的量），这些页不会被覆盖。建议拆成 ${a.lessons} 课时 · Some pages will not be read: split the lesson` };
  }
  if (a.tooMuch) return { ...a, level: "dense", text: `内容偏多：约需 ${a.lessons} 节课，建议拆成 ${a.lessons} 课时或少选几节 · Too much for one lesson: split it` };
  if (a.estimatedMinutes < minutes * 0.5) return { ...a, level: "light", text: "内容偏少：多出来的时间会安排成练习和讨论 · Light: the extra time goes to practice" };
  return { ...a, level: "ok", text: "内容量合适 · Good fit" };
}

export function SettingsStep({ view, reached }: { view: LessonView; reached: StepKey }) {
  const nav = useNavigate();
  const [params, setParams] = useState<LessonParams>(view.lesson.params);
  const [theme, setTheme] = useState<ThemeId>(view.lesson.theme);
  const [title, setTitle] = useState(view.lesson.title);
  const [busy, setBusy] = useState(false);
  const [draftingSince, setDraftingSince] = useState<number | null>(view.drafting?.startedAt ?? null);
  const [error, setError] = useState("");
  const pages = countPages(view.lesson.scope.ranges);
  const labels = new Map(Object.entries(view.pageLabels).map(([k, v]) => [Number(k), v]));
  const { emptyPages, unreadPages, scopeWords } = view.lesson;
  const noText = scopeWords === 0 && emptyPages.length > 0;
  const p = pacing(params.minutes, scopeWords, unreadPages.length, fmtPages(unreadPages, labels));
  const v = view.draft ?? view.confirmed;
  const stale = !!v && (JSON.stringify(v.params) !== JSON.stringify(params) || JSON.stringify(v.scope.ranges) !== JSON.stringify(view.lesson.scope.ranges));
  const budget = planBudget(params);
  const set = <K extends keyof LessonParams>(k: K, v: LessonParams[K]) => setParams({ ...params, [k]: v });

  const drafted = useCallback(
    (fresh: LessonView) => {
      setDraftingSince(null);
      if (fresh.draft) nav(`/lessons/${view.lesson.id}/outline`);
      else setError("大纲没有生成成功，请再试一次 · Drafting did not finish; try again");
    },
    [nav, view.lesson.id],
  );

  async function go(redraft: boolean) {
    setError("");
    setBusy(true);
    try {
      await lessonApi.patch(view.lesson.id, { params, theme, title });
      if (redraft || !v) {
        setDraftingSince(Date.now());
        await lessonApi.draft(view.lesson.id);
      }
      nav(`/lessons/${view.lesson.id}/outline`);
    } catch (e) {
      // Another tab or an earlier click is already drafting: keep showing progress until it ends.
      if (e instanceof ApiError && e.code === "DRAFT_IN_PROGRESS") return;
      setDraftingSince(null);
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
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
              <b>{p.estimatedMinutes}</b>
              <span>约需分钟 min needed</span>
            </div>
            <div>
              <b>{params.minutes}</b>
              <span>课时 lesson min</span>
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
      {noText ? (
        <div className="alert error" data-testid="no-text">
          所选的页都没有可读的文字（可能是扫描图），不能凭空起草大纲。请回到“选章节”，为这些页粘贴文字。· The selected pages have no text: paste it on the chapters step.
        </div>
      ) : (
        emptyPages.length > 0 && (
          <div className="alert warn" data-testid="empty-pages">
            第 {fmtPages(emptyPages, labels)} 页没有文字（可能是扫描图），起草时会跳过；可以回到“选章节”粘贴这些页的文字。· Pages without text are skipped.
          </div>
        )
      )}
      {stale && (
        <div className="alert warn" data-testid="stale-outline">
          课时设置或教材范围改了：现有大纲仍按创建时的设置，点“重新生成大纲”才会按新设置来 · The current outline keeps the settings it was drafted with; re-draft to apply changes.
        </div>
      )}
      {draftingSince !== null && <DraftingProgress lessonId={view.lesson.id} startedAt={draftingSince} onDone={drafted} />}
      {error && <div className="alert error">{error}</div>}
      <div className="wizard-actions">
        <button className="btn ghost" onClick={() => nav(`/lessons/${view.lesson.id}/chapters`)}>
          ← 返回 Back
        </button>
        {v && (
          <button className="btn ghost" disabled={busy || draftingSince !== null || noText} onClick={() => go(true)}>
            重新生成大纲 Re-draft outline
          </button>
        )}
        <button className="btn primary" disabled={busy || draftingSince !== null || (noText && !v)} onClick={() => go(false)}>
          {draftingSince !== null ? "正在生成大纲… Drafting" : v ? "下一步：大纲 Next →" : "生成大纲 Draft outline →"}
        </button>
      </div>
    </div>
  );
}
