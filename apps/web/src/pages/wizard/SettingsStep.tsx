import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { countPages } from "@kj/textbook";
import { LANGUAGE_LABEL, LESSON_TYPE_LABEL, LEVEL_LABEL, planBudget, scopeAdvice, type ScopeAdvice } from "@kj/pedagogy";
import { MAX_FOCUS_CHARS, type LessonParams, type LessonSource, type PdfLessonSource, type SyllabusLessonSource, type ThemeId } from "@kj/schema";
import { THEMES } from "@kj/templates/render";
import { ApiError, lessonSourcesOf, multisourceLessonApi } from "../../api.ts";
import { lessonApi, type LessonView } from "../../lessonApi.ts";
import { fmtPages } from "./ChaptersStep.tsx";
import { DraftingProgress } from "./drafting.tsx";
import { Stepper, StepIntro, type StepKey } from "./Stepper.tsx";

const MINUTE_CHOICES = [30, 35, 40, 45, 60, 80, 90];

export function parseTypedLessonMinutes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 10 && n <= 120 ? n : null;
}

export function clampLessonMinutes(raw: string, fallback = 40): number {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(10, Math.min(120, Math.round(n)));
}

/** Keeps what the teacher types ("5" on the way to "50", or "") while typing; clamps/rounds to 10–120 only on blur. */
function LessonMinutesInput({ value, onChange }: { value: number; onChange: (minutes: number) => void }) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  return (
    <input
      type="number"
      min={10}
      max={120}
      step={1}
      value={focused ? text : String(value)}
      aria-label="自定义分钟 Custom minutes"
      className="minutes-input"
      onFocus={() => {
        setText(String(value));
        setFocused(true);
      }}
      onChange={(e) => {
        setText(e.target.value);
        const parsed = parseTypedLessonMinutes(e.target.value);
        if (parsed !== null) onChange(parsed);
      }}
      onBlur={() => {
        setFocused(false);
        const clamped = clampLessonMinutes(text, 40);
        if (clamped !== value) onChange(clamped);
      }}
    />
  );
}

function pacing(minutes: number, words: number, unreadPages = 0, unread = ""): ScopeAdvice & { level: "dense" | "ok" | "light"; text: string } {
  const a = scopeAdvice(words, minutes, unreadPages);
  if (a.unreadPages > 0) {
    return { ...a, level: "dense", text: `第 ${unread} 页读不进大纲（所选内容超过一份大纲能读的量），这些页不会被覆盖。建议拆成 ${a.lessons} 课时 · Some pages will not be read: split the lesson` };
  }
  if (a.tooMuch) return { ...a, level: "dense", text: `内容偏多：约需 ${a.lessons} 节课，建议拆成 ${a.lessons} 课时或少选几节 · Too much for one lesson: split it` };
  if (a.estimatedMinutes < minutes * 0.5) return { ...a, level: "light", text: "内容偏少：多出来的时间会安排成练习和讨论 · Light: the extra time goes to practice" };
  return { ...a, level: "ok", text: "内容量合适 · Good fit" };
}

function parseChecklistLines(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*(?:[-*•☐☑✓✔]|\d+[.)])\s*/, "").trim())
        .filter((line) => line.length >= 2)
        .map((line) => line.slice(0, 300)),
    ),
  ].slice(0, 60);
}

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("无法读取图片文件 · Could not read image file"));
    reader.readAsDataURL(file);
  });
}

export function SettingsStep({ view, reached }: { view: LessonView; reached: StepKey }) {
  const nav = useNavigate();
  const initialSources = lessonSourcesOf(view);
  const initialSyllabus = initialSources.find((s): s is SyllabusLessonSource => s.kind === "syllabus");
  const initialChecklistText = initialSyllabus ? (initialSyllabus.items?.length ? initialSyllabus.items.join("\n") : initialSyllabus.text) : "";

  const [params, setParams] = useState<LessonParams>(view.lesson.params);
  const [theme, setTheme] = useState<ThemeId>(view.lesson.theme);
  const [title, setTitle] = useState(view.lesson.title);
  const [syllabusTitle, setSyllabusTitle] = useState(initialSyllabus?.title ?? "考纲清单 Syllabus");
  const [syllabusText, setSyllabusText] = useState(initialChecklistText);
  const [transcribing, setTranscribing] = useState(false);
  const [syllabusNotice, setSyllabusNotice] = useState("");
  const syllabusInputRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);
  const [draftingSince, setDraftingSince] = useState<number | null>(view.drafting?.startedAt ?? null);
  const [error, setError] = useState("");

  const pdfSources = initialSources.filter((s): s is PdfLessonSource => s.kind === "pdf");
  const pages = pdfSources.length > 0 ? pdfSources.reduce((sum, s) => sum + countPages(s.ranges), 0) : countPages(view.lesson.scope.ranges);
  const labels = new Map(Object.entries(view.pageLabels).map(([k, v]) => [Number(k), v]));
  const { emptyPages, unreadPages, scopeWords } = view.lesson;
  const noText = scopeWords === 0 && emptyPages.length > 0;
  const p = pacing(params.minutes, scopeWords, unreadPages.length, fmtPages(unreadPages, labels));
  const v = view.draft ?? view.confirmed;
  const syllabusChanged = syllabusText.trim() !== initialChecklistText.trim();
  const stale =
    !!v &&
    (JSON.stringify(v.params) !== JSON.stringify(params) ||
      JSON.stringify(v.scope.ranges) !== JSON.stringify(view.lesson.scope.ranges) ||
      syllabusChanged);
  const budget = planBudget(params);
  const set = <K extends keyof LessonParams>(k: K, val: LessonParams[K]) => setParams({ ...params, [k]: val });

  const drafted = useCallback(
    (fresh: LessonView) => {
      setDraftingSince(null);
      if (fresh.draft) nav(`/lessons/${view.lesson.id}/outline`);
      else setError("大纲没有生成成功，请再试一次 · Drafting did not finish; try again");
    },
    [nav, view.lesson.id],
  );

  async function handleSyllabusImage(file: File) {
    if (!/^image\/(?:png|jpeg|webp)$/i.test(file.type)) {
      setSyllabusNotice("请选择或粘贴 PNG、JPEG 或 WebP 格式的考纲截图 · Please choose a PNG, JPEG or WebP screenshot");
      return;
    }
    setTranscribing(true);
    setSyllabusNotice("");
    try {
      const dataUrl = await fileToDataUrl(file);
      const res = await multisourceLessonApi.transcribeSyllabusImage(view.lesson.id, dataUrl, file.name || "Clipboard_Screenshot.png");
      const extracted = res.source.items?.length ? res.source.items.join("\n") : res.source.text;
      setSyllabusTitle(res.source.title);
      setSyllabusText((prev) => (prev.trim() ? `${prev.trim()}\n${extracted}` : extracted));
      setSyllabusNotice(`✓ 已通过看图模型（${res.model}）提取 ${res.source.items?.length ?? 1} 条考纲要求，可在下方核对微调`);
    } catch (e) {
      setSyllabusNotice(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setTranscribing(false);
    }
  }

  function buildUpdatedSources(): LessonSource[] | undefined {
    const items = parseChecklistLines(syllabusText);
    const nonSyllabus = initialSources.filter((s) => s.kind !== "syllabus");
    if (!items.length && !syllabusText.trim()) {
      return initialSources.length > 0 ? nonSyllabus : undefined;
    }
    const sylSource: SyllabusLessonSource = {
      id: initialSyllabus?.id ?? `src_syl_${Date.now().toString(36)}`,
      kind: "syllabus",
      title: syllabusTitle.trim() || "考纲清单 Syllabus",
      text: syllabusText.trim().slice(0, 20_000),
      ...(items.length ? { items } : {}),
    };
    return [...nonSyllabus, sylSource];
  }

  async function go(redraft: boolean) {
    setError("");
    setBusy(true);
    try {
      const nextSources = buildUpdatedSources();
      await multisourceLessonApi.patch<LessonView>(view.lesson.id, {
        params,
        theme,
        title,
        ...(nextSources !== undefined ? { sources: nextSources } : {}),
      });
      if (redraft || !v) {
        setDraftingSince(Date.now());
        await lessonApi.draft(view.lesson.id);
      }
      nav(`/lessons/${view.lesson.id}/outline`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "DRAFT_IN_PROGRESS") return;
      setDraftingSince(null);
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const checklistCount = parseChecklistLines(syllabusText).length;

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
            <LessonMinutesInput value={params.minutes} onChange={(minutes) => set("minutes", minutes)} />
          </fieldset>
          <label>
            学生水平 Student level
            <select value={params.level} onChange={(e) => set("level", e.target.value as LessonParams["level"])}>
              {Object.entries(LEVEL_LABEL).map(([k, val]) => (
                <option key={k} value={k}>
                  {val}
                </option>
              ))}
            </select>
          </label>
          <label>
            课型 Lesson type
            <select value={params.lessonType} onChange={(e) => set("lessonType", e.target.value as LessonParams["lessonType"])}>
              {Object.entries(LESSON_TYPE_LABEL).map(([k, val]) => (
                <option key={k} value={k}>
                  {val}
                </option>
              ))}
            </select>
          </label>
          <label>
            授课语言 Teaching language
            <select value={params.language} onChange={(e) => set("language", e.target.value as LessonParams["language"])}>
              {Object.entries(LANGUAGE_LABEL).map(([k, val]) => (
                <option key={k} value={k}>
                  {val}
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
          <label className="span2" style={{ gridColumn: "1 / -1" }}>
            <span className="row between">
              <span>教学指令与重点要求（可选）Teaching brief & focus</span>
              <span className="muted small" data-testid="focus-count">
                {params.focus.length} / {MAX_FOCUS_CHARS}
              </span>
            </span>
            <textarea
              rows={4}
              value={params.focus}
              onChange={(e) => set("focus", e.target.value)}
              maxLength={MAX_FOCUS_CHARS}
              data-testid="focus-input"
              placeholder="例如：G10 IG物理，严格覆盖考纲所有知识点，重点知识用红字加粗，文字精简，每隔15分钟安排真题练习或互动活动… · e.g. IGCSE G10 Physics, cover all syllabus points, concise text, exam-style practice every 15 min"
            />
          </label>

          <div
            className="span2"
            style={{ gridColumn: "1 / -1", borderTop: "1px solid var(--line)", paddingTop: 12 }}
            data-testid="syllabus-panel"
            onPaste={(e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              for (const item of items) {
                if (item.type.startsWith("image/")) {
                  const file = item.getAsFile();
                  if (file) {
                    e.preventDefault();
                    void handleSyllabusImage(file);
                    return;
                  }
                }
              }
            }}
          >
            <div className="row between wrap" style={{ marginBottom: 8 }}>
              <div>
                <b>📋 考纲截图识别与必讲清单（可选）Syllabus checklist</b>
                <div className="muted small">
                  支持在此处直接 <code>Ctrl/Cmd+V</code> 粘贴考纲截图（如 <code>Clipboard_Screenshot.png</code>）或上传图片，也可每行手动输入一条考纲目标
                </div>
              </div>
              <div className="row">
                <input
                  ref={syllabusInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  data-testid="syllabus-image-input"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleSyllabusImage(f);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="btn small"
                  disabled={transcribing}
                  onClick={() => syllabusInputRef.current?.click()}
                  data-testid="syllabus-upload-btn"
                >
                  {transcribing ? "正在识别考纲图… Reading" : "📷 上传考纲截图 Upload image"}
                </button>
              </div>
            </div>
            {syllabusNotice && (
              <div className={`alert ${syllabusNotice.startsWith("✓") ? "success" : "info"}`} data-testid="syllabus-vision-notice" style={{ marginBottom: 8 }}>
                {syllabusNotice}
              </div>
            )}
            <label>
              <span className="row between">
                <span className="small muted">考纲必覆盖条目（每行一条，大纲确认页将逐条核对覆盖情况）</span>
                {checklistCount > 0 && <span className="badge ready">{checklistCount} 条必覆盖</span>}
              </span>
              <textarea
                rows={4}
                value={syllabusText}
                onChange={(e) => setSyllabusText(e.target.value)}
                data-testid="syllabus-items-input"
                placeholder="每行一条考纲目标（或直接按 Ctrl/Cmd+V 粘贴考纲截图自动提取）· One syllabus objective per line, or paste a screenshot"
              />
            </label>
          </div>
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
          课时设置、考纲或教材范围改了：现有大纲仍按创建时的设置，点“重新生成大纲”才会按新设置来 · The current outline keeps the settings it was drafted with; re-draft to apply changes.
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
