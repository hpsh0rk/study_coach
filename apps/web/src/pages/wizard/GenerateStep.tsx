import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { PAGE_TYPES } from "@kj/pedagogy";
import type { Slide, SlideSpec, ThemeId, Unverified } from "@kj/schema";
import { THEMES } from "@kj/templates/render";
import { ApiError } from "../../api.ts";
import { RichText } from "../../components/RichText.tsx";
import { SlotEditor } from "../../components/SlotEditor.tsx";
import { SlidePreview, SlideThumb } from "../../components/SlideView.tsx";
import {
  activeUnverified,
  loadDismissedUnverified,
  saveDismissedUnverified,
  UnverifiedBadge,
  UnverifiedBox,
  unverifiedItemKey,
} from "../../components/Unverified.tsx";
import { lessonApi, type AnswerMode, type FlaggedSlide, type LessonView, type ShareView } from "../../lessonApi.ts";
import { documentApi, type TextbookPage } from "../../textbook/api.ts";
import { SourcePage } from "../../textbook/SourcePage.tsx";
import { downloadOfflineHtml } from "../../offline/exportDeck.ts";
import { downloadPptx } from "../../offline/exportPptx.ts";
import type { HandoutCopy } from "../../offline/handout/model.ts";
import { generateMissingSlides, generateSlideWithLock, MAX_REGENERATE_INSTRUCTION, postGenerateSlide } from "./slideGeneration.ts";
import { Stepper, StepIntro, type StepKey } from "./Stepper.tsx";

/**
 * Share link status: copy, unshare, move to the current version, and the pre-share review of flagged pages.
 * The answer mode (课前预习 without answers by default, or 课后复习) applies to the link and the student file.
 */
function SharePanel({ lessonId, initial, current, canShare }: { lessonId: string; initial: ShareView | null; current: { id: string; version: number }; canShare: boolean }) {
  const [share, setShare] = useState(initial);
  const [answers, setAnswers] = useState<AnswerMode>(initial?.answers ?? "hidden");
  const [review, setReview] = useState<{ body: { versionId?: string }; pages: FlaggedSlide[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const url = share ? `${location.origin}${share.path}` : "";

  async function doShare(body: { versionId?: string }, ack = false) {
    setError("");
    try {
      const next = await lessonApi.share(lessonId, { ...body, ack, answers });
      setShare(next);
      setReview(null);
      await navigator.clipboard?.writeText(`${location.origin}${next.path}`).then(
        () => setCopied(true),
        () => undefined,
      );
    } catch (e) {
      if (e instanceof ApiError && e.code === "SHARE_REVIEW_REQUIRED") setReview({ body, pages: e.detail as FlaggedSlide[] });
      else setError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  const [packing, setPacking] = useState(false);
  async function studentFile() {
    setPacking(true);
    setError("");
    try {
      await downloadOfflineHtml(lessonId, "student", answers);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPacking(false);
    }
  }

  async function pickAnswers(next: AnswerMode) {
    setAnswers(next);
    if (!share) return;
    setError("");
    try {
      setShare(await lessonApi.shareAnswers(lessonId, next));
    } catch (e) {
      setAnswers(share.answers);
      setError((e as Error).message);
    }
  }

  async function unshare() {
    if (!window.confirm("取消分享后，学生手里的链接会立即失效。确定吗？· Students' link stops working. Unshare?")) return;
    setError("");
    try {
      await lessonApi.unshare(lessonId);
      setShare(null);
      setCopied(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="answer-mode" role="radiogroup" aria-label="学生看到的内容 · What students see" data-testid="answer-mode">
        <span className="muted">学生版 Student copy:</span>
        <label>
          <input type="radio" name="answer-mode" checked={answers === "hidden"} onChange={() => void pickAnswers("hidden")} data-testid="answers-hidden" /> 课前预习（无答案）
        </label>
        <label>
          <input type="radio" name="answer-mode" checked={answers === "shown"} onChange={() => void pickAnswers("shown")} data-testid="answers-shown" /> 课后复习（含答案）
        </label>
      </div>
      {!share ? (
        <button className="btn ghost" disabled={!canShare} onClick={() => doShare({})} data-testid="share">
          分享链接 Share
        </button>
      ) : (
        <div className="alert success share-box" data-testid="share-box">
          已分享第 {share.version} 版 · 学生可以用这个链接查看（不含讲稿和误区提示{share.answers === "hidden" ? "，答案课后公布" : "，含答案"}）：
          <a href={url} target="_blank" rel="noreferrer" data-testid="share-url">
            {url}
          </a>
          <div className="row wrap">
            <button className="btn small" onClick={() => navigator.clipboard?.writeText(url).then(() => setCopied(true), () => undefined)}>
              {copied ? "已复制 Copied" : "复制链接 Copy"}
            </button>
            {share.versionId !== current.id && (
              <button className="btn small" onClick={() => doShare({ versionId: current.id })} data-testid="share-update">
                改为分享第 {current.version} 版 · Share version {current.version}
              </button>
            )}
            <button className="btn small ghost" onClick={unshare} data-testid="unshare">
              取消分享 Unshare
            </button>
          </div>
          {share.held.length > 0 && (
            <p className="small" data-testid="share-held">
              第 {share.held.join("、")} 页在分享之后改过，并且含有网址或像指令的文字，学生暂时看不到。检查后点
              <button className="link" onClick={() => doShare({ versionId: share.versionId })}>
                重新分享
              </button>
              。
            </p>
          )}
        </div>
      )}
      {review && (
        <div className="alert warn" role="alert" data-testid="share-review">
          <p>这些页含有网址、邮箱或像指令的文字，学生会看到。请先检查（可能来自教材，也可能是被人插入的内容）：· Check these pages before sharing:</p>
          <ul>
            {review.pages.map((p) => (
              <li key={p.page}>
                第 {p.page} 页「{p.title}」：{p.issues.join("；")}
              </li>
            ))}
          </ul>
          <button className="btn small" onClick={() => doShare(review.body, true)} data-testid="share-ack">
            已检查，仍然分享 · Share anyway
          </button>{" "}
          <button className="btn small ghost" onClick={() => setReview(null)}>
            先不分享 Cancel
          </button>
        </div>
      )}
      <button className="btn ghost small" disabled={!canShare || packing} onClick={studentFile} data-testid="export-student" title="不含讲稿、误区提示和检查标记，可以发到班级群；答案按上面的选择 · No notes or misconception labels; answers as chosen above">
        {packing ? "打包中… Packing" : "下载学生版离线文件 Student offline file"}
      </button>
      {error && <div className="alert error">{error}</div>}
    </>
  );
}

export function GenerateStep({ view, reached }: { view: LessonView; reached: StepKey }) {
  const nav = useNavigate();
  const confirmed = view.confirmed;
  const specs: SlideSpec[] = useMemo(() => confirmed?.outline.slides ?? [], [confirmed]);
  const [slides, setSlides] = useState<Record<string, Slide>>(() => Object.fromEntries(view.slides.map((s) => [s.specId, s])));
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(specs[0]?.id ?? null);
  const [source, setSource] = useState<TextbookPage | null>(null);
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState("");
  const [exportError, setExportError] = useState("");
  const [handoutCopy, setHandoutCopy] = useState<HandoutCopy>("student");
  const [theme, setTheme] = useState<ThemeId>(view.lesson.theme);
  const [showRegenHint, setShowRegenHint] = useState(false);
  const [regenHint, setRegenHint] = useState("");
  const [dismissedMap, setDismissedMap] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    for (const s of view.slides) {
      const saved = loadDismissedUnverified(typeof window !== "undefined" ? window.localStorage : null, view.lesson.id, s.id);
      if (saved.size) init[s.id] = [...saved];
    }
    return init;
  });
  const batchAbortRef = useRef<AbortController | null>(null);
  const language = (confirmed?.params ?? view.lesson.params).language;

  useEffect(() => {
    setTheme(view.lesson.theme);
  }, [view.lesson.theme]);

  useEffect(() => () => batchAbortRef.current?.abort(), []);

  const dismissedSetFor = useCallback(
    (slideId: string) => {
      const cached = dismissedMap[slideId];
      if (cached) return new Set(cached);
      return loadDismissedUnverified(typeof window !== "undefined" ? window.localStorage : null, view.lesson.id, slideId);
    },
    [dismissedMap, view.lesson.id],
  );

  const toggleDismissed = useCallback(
    (slideId: string, item: Unverified, hide: boolean) => {
      setDismissedMap((prev) => {
        const nextSet = new Set(prev[slideId] ?? [...loadDismissedUnverified(window.localStorage, view.lesson.id, slideId)]);
        const key = unverifiedItemKey(item);
        if (hide) nextSet.add(key);
        else nextSet.delete(key);
        saveDismissedUnverified(window.localStorage, view.lesson.id, slideId, nextSet);
        return { ...prev, [slideId]: [...nextSet] };
      });
    },
    [view.lesson.id],
  );

  async function pickTheme(nextTheme: ThemeId) {
    if (nextTheme === theme) return;
    const prevTheme = theme;
    setTheme(nextTheme);
    try {
      await lessonApi.patch(view.lesson.id, { theme: nextTheme });
    } catch (e) {
      setTheme(prevTheme);
      setExportError((e as Error).message);
    }
  }

  const labels = view.pageLabels;
  const generateOne = useCallback(
    async (specId: string, regenerate = false, instruction?: string, signal?: AbortSignal) => {
      if (!confirmed) return { ok: false, rateLimited: false };
      return generateSlideWithLock(specId, regenerate, {
        signal,
        request: (id, regen, reqSignal) => postGenerateSlide(view.lesson.id, confirmed.id, id, regen, regen ? instruction : undefined, reqSignal),
        onStart: (id) => {
          setRunning((r) => new Set(r).add(id));
          setFailed(({ [id]: _drop, ...rest }) => rest);
        },
        onSlide: (id, slide) => setSlides((m) => ({ ...m, [id]: slide })),
        onError: (id, msg) => setFailed((f) => ({ ...f, [id]: msg })),
        onDone: (id) =>
          setRunning((r) => {
            const n = new Set(r);
            n.delete(id);
            return n;
          }),
      });
    },
    [confirmed, view.lesson.id],
  );

  async function generateAll() {
    batchAbortRef.current?.abort();
    const ac = new AbortController();
    batchAbortRef.current = ac;
    const existing = new Set(specs.filter((s) => slides[s.id]).map((s) => s.id));
    try {
      await generateMissingSlides(specs, existing, (specId) => generateOne(specId, false, undefined, ac.signal), { signal: ac.signal });
    } finally {
      if (batchAbortRef.current === ac) batchAbortRef.current = null;
    }
  }

  function stopGeneration() {
    batchAbortRef.current?.abort();
    batchAbortRef.current = null;
  }

  // Arriving from "confirm outline" (?generate=1) starts generation; a reload or a later visit does not.
  const [search, setSearch] = useSearchParams();
  const autoStarted = useRef(false);
  useEffect(() => {
    if (search.get("generate") !== "1" || autoStarted.current) return;
    autoStarted.current = true;
    setSearch({}, { replace: true });
    void generateAll();
  });

  const replaceSlide = (slide: Slide) => setSlides((m) => ({ ...m, [slide.specId]: slide }));

  const openSource = useCallback(async (no: number) => setSource(await documentApi.page(view.lesson.documentId, no)), [view.lesson.documentId]);

  if (!confirmed) {
    return (
      <div className="wizard">
        <Stepper current="slides" reached={reached} lessonId={view.lesson.id} />
        <StepIntro step="slides" />
        <div className="alert warn">
          大纲还没有确认，不能生成幻灯片 · Confirm the outline before generating slides.{" "}
          <button className="btn small" onClick={() => nav(`/lessons/${view.lesson.id}/outline`)}>
            去确认大纲 Go to outline
          </button>
        </div>
      </div>
    );
  }

  const done = specs.filter((s) => slides[s.id]).length;
  const all = done === specs.length;
  const sel = specs.find((s) => s.id === selected);
  const selSlide = sel ? slides[sel.id] : undefined;

  return (
    <div className="wizard wide">
      <Stepper current="slides" reached={reached} lessonId={view.lesson.id} />
      <StepIntro step="slides" />
      <div className="card gen-head">
        <div>
          <b data-testid="gen-progress">
            已生成 {done} / {specs.length} 页 · generated
          </b>
          <div className="progress">
            <div style={{ width: `${(done / Math.max(1, specs.length)) * 100}%` }} />
          </div>
        </div>
        <div className="gen-actions">
          <div className="theme-switch" role="group" aria-label="幻灯片主题 Theme" data-testid="theme-switcher">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={theme === t.id ? "active" : ""}
                aria-pressed={theme === t.id}
                data-testid={`theme-${t.id}`}
                onClick={() => void pickTheme(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {!all ? (
            <button className="btn primary" disabled={running.size > 0} onClick={generateAll} data-testid="generate-all">
              {running.size ? "生成中… Generating" : done ? `继续生成剩下 ${specs.length - done} 页 Continue` : "生成全部幻灯片 Generate all"}
            </button>
          ) : (
            <button className="btn primary" onClick={() => nav(`/play/${view.lesson.id}`)} data-testid="present">
              ▶ 放映 Present
            </button>
          )}
          {running.size > 0 && (
            <button type="button" className="btn ghost" onClick={stopGeneration} data-testid="stop-generate">
              停止生成 Stop
            </button>
          )}
          {!all && (
            <button className="btn ghost" disabled={done === 0} onClick={() => nav(`/play/${view.lesson.id}`)} data-testid="present-partial">
              ▶ 放映已生成的 Present
            </button>
          )}
          <details className="menu">
            <summary className="btn ghost" aria-disabled={done === 0}>
              导出 Export ▾
            </summary>
            <div className="menu-list card" style={{ width: 340, maxWidth: "calc(100vw - 32px)" }}>
              <button
                className="btn ghost"
                disabled={done === 0 || !!exporting}
                data-testid="export-offline"
                onClick={async () => {
                  setExporting("offline");
                  setExportError("");
                  try {
                    await downloadOfflineHtml(view.lesson.id);
                  } catch (e) {
                    setExportError((e as Error).message);
                  } finally {
                    setExporting("");
                  }
                }}
              >
                {exporting === "offline" ? "打包中… Packing" : "离线放映文件（单个 HTML）Offline file"}
              </button>
              <span className="muted small">无网络也能放映：幻灯片、模拟实验、字体都在一个文件里 · runs with no internet</span>
              <button
                className="btn ghost"
                disabled={done === 0 || !!exporting}
                data-testid="export-pptx"
                onClick={async () => {
                  setExporting("pptx");
                  setExportError("");
                  try {
                    await downloadPptx(view.lesson.id);
                  } catch (e) {
                    setExportError((e as Error).message);
                  } finally {
                    setExporting("");
                  }
                }}
              >
                {exporting === "pptx" ? "生成中… Building" : "可编辑 PPT（.pptx）Editable PPTX"}
              </button>
              <span className="muted small">
                给 WPS / PowerPoint / Keynote 用：文字、表格、图表都可编辑；互动（实验、投票、排序）变成静态版，做法和答案写在讲稿里。字体用苹方（Mac 自带，不嵌入）· interactions become static, answers go to speaker notes
              </span>
              <div className="row between" style={{ borderTop: "1px solid var(--line)", paddingTop: 8, marginTop: 4 }}>
                <span className="muted small">配套讲义 Handout:</span>
                <div className="theme-switch" role="group" aria-label="配套讲义版本 Handout copy" data-testid="handout-copy-toggle">
                  <button
                    type="button"
                    className={handoutCopy === "student" ? "active" : ""}
                    aria-pressed={handoutCopy === "student"}
                    data-testid="handout-copy-student"
                    onClick={() => setHandoutCopy("student")}
                  >
                    学生版
                  </button>
                  <button
                    type="button"
                    className={handoutCopy === "teacher" ? "active" : ""}
                    aria-pressed={handoutCopy === "teacher"}
                    data-testid="handout-copy-teacher"
                    onClick={() => setHandoutCopy("teacher")}
                  >
                    教师答案版
                  </button>
                </div>
              </div>
              <button
                className="btn ghost"
                disabled={done === 0 || !!exporting}
                data-testid="export-handout-html"
                onClick={async () => {
                  setExporting("handout-html");
                  setExportError("");
                  try {
                    const { downloadHandoutHtml } = await import("../../offline/handout/index.ts");
                    await downloadHandoutHtml(view.lesson.id, handoutCopy);
                  } catch (e) {
                    setExportError((e as Error).message);
                  } finally {
                    setExporting("");
                  }
                }}
              >
                {exporting === "handout-html"
                  ? "生成中… Building"
                  : `配套讲义 · 打印版 HTML/PDF（${handoutCopy === "student" ? "学生版" : "教师答案版"}）`}
              </button>
              <button
                className="btn ghost"
                disabled={done === 0 || !!exporting}
                data-testid="export-handout-docx"
                onClick={async () => {
                  setExporting("handout-docx");
                  setExportError("");
                  try {
                    const { downloadHandoutDocx } = await import("../../offline/handout/index.ts");
                    await downloadHandoutDocx(view.lesson.id, handoutCopy);
                  } catch (e) {
                    setExportError((e as Error).message);
                  } finally {
                    setExporting("");
                  }
                }}
              >
                {exporting === "handout-docx"
                  ? "生成中… Building"
                  : `配套讲义 · Word (.docx)（${handoutCopy === "student" ? "学生版" : "教师答案版"}）`}
              </button>
              <span className="muted small">
                与幻灯片同源：含导学填空、例题演算框与真题练习；学生版留白，教师答案版附红字重点与参考答案 · A4 print PDF &amp; editable Word
              </span>
              <button
                className="btn ghost"
                disabled={done === 0}
                onClick={async () => {
                  const deck = await lessonApi.deck(view.lesson.id);
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(new Blob([JSON.stringify(deck, null, 2)], { type: "application/json" }));
                  a.download = `${view.lesson.title.slice(0, 60)}.json`;
                  a.click();
                }}
              >
                数据 JSON
              </button>
            </div>
          </details>
        </div>
      </div>
      {exportError && <div className="alert error">导出失败 Export failed: {exportError}</div>}
      {view.draft && (
        <div className="alert info" data-testid="draft-banner">
          这里是已确认的第 {confirmed.version} 版。还有一份未确认的新大纲（第 {view.draft.version} 版），确认后才会用到它。· A newer outline draft is waiting for confirmation.{" "}
          <button className="btn small" onClick={() => nav(`/lessons/${view.lesson.id}/outline`)}>
            去确认新大纲 →
          </button>
        </div>
      )}
      <div className="share-row">
        <SharePanel lessonId={view.lesson.id} initial={view.share} current={confirmed} canShare={done > 0} />
      </div>
      <div className="gen-body">
        <ol className="thumb-grid">
          {specs.map((s, i) => {
            const slide = slides[s.id];
            return (
              <li
                key={s.id}
                className={`thumb-card ${selected === s.id ? "selected" : ""}`}
                onClick={() => {
                  setSelected(s.id);
                  setEditing(false);
                  setShowRegenHint(false);
                }}
                data-testid="thumb"
              >
                {slide ? (
                  <SlideThumb slide={slide} theme={theme} index={i} pageLabels={labels} language={language} />
                ) : (
                  <div className="thumb-empty">
                    {running.has(s.id) ? <span className="spinner" /> : failed[s.id] ? "⚠ 失败 failed" : "未生成 not yet"}
                  </div>
                )}
                <div className="thumb-caption">
                  <span className="muted small">
                    {i + 1}. {PAGE_TYPES[s.pageType].label.zh} · {s.minutes} 分钟
                  </span>
                  <span className="thumb-title">{s.title}</span>
                  {slide && <UnverifiedBadge count={activeUnverified(slide.unverified, dismissedSetFor(slide.id)).length} />}
                </div>
              </li>
            );
          })}
        </ol>
        {sel && (
          <aside className="preview-pane card">
            <div className="row between">
              <b>
                {specs.indexOf(sel) + 1}. {sel.title}
              </b>
              <div className="row wrap">
                {selSlide && !editing && (
                  <button className="btn small ghost" onClick={() => setEditing(true)} data-testid="edit-slide">
                    编辑 Edit
                  </button>
                )}
                {selSlide?.canUndo && !editing && (
                  <button className="btn small ghost" onClick={async () => replaceSlide((await lessonApi.undoSlide(view.lesson.id, selSlide.id)).slide)} data-testid="undo-slide">
                    撤销 Undo
                  </button>
                )}
                {selSlide && !editing && (
                  <button
                    type="button"
                    className={`btn small ghost ${showRegenHint ? "active" : ""}`}
                    disabled={running.has(sel.id)}
                    aria-expanded={showRegenHint}
                    onClick={() => setShowRegenHint((v) => !v)}
                    data-testid="toggle-regen-hint"
                    title="输入一句修改要求后再重新生成 · Optional hint for regeneration"
                  >
                    微调要求 Hint
                  </button>
                )}
                <button
                  className="btn small ghost"
                  disabled={running.has(sel.id) || editing}
                  onClick={async () => {
                    const hint = selSlide ? regenHint : undefined;
                    const res = await generateOne(sel.id, !!selSlide, hint);
                    if (res.ok) setShowRegenHint(false);
                  }}
                  data-testid="regenerate"
                >
                  {selSlide ? "重新生成 Regenerate" : "生成这一页 Generate"}
                </button>
              </div>
            </div>
            {selSlide && !editing && showRegenHint && (
              <div className="regen-hint-row">
                <input
                  value={regenHint}
                  maxLength={MAX_REGENERATE_INSTRUCTION}
                  placeholder="可选微调指令：例如“换一组数字”或“改成概念辨析题” · Optional hint (≤200 chars)"
                  aria-label="重新生成微调指令 Regeneration hint"
                  data-testid="regenerate-instruction"
                  onChange={(e) => setRegenHint(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !running.has(sel.id)) {
                      e.preventDefault();
                      void generateOne(sel.id, true, regenHint).then((r) => r.ok && setShowRegenHint(false));
                    }
                  }}
                />
              </div>
            )}
            {selSlide && editing ? (
              <SlotEditor
                key={selSlide.id}
                content={selSlide.content}
                notes={selSlide.notes}
                unverified={selSlide.unverified}
                dismissedUnverified={dismissedSetFor(selSlide.id)}
                onDismissUnverified={(item) => toggleDismissed(selSlide.id, item, true)}
                onRestoreUnverified={(item) => toggleDismissed(selSlide.id, item, false)}
                pageType={selSlide.pageType}
                theme={theme}
                onCancel={() => setEditing(false)}
                onSave={async (content, notes) => {
                  replaceSlide((await lessonApi.editSlide(view.lesson.id, selSlide.id, { content, notes })).slide);
                  setEditing(false);
                }}
              />
            ) : selSlide ? (
              <>
                <SlidePreview slide={selSlide} theme={theme} onSourceClick={openSource} pageLabels={labels} language={language} />
                <UnverifiedBox
                  items={selSlide.unverified ?? []}
                  sources={selSlide.sources}
                  onSourceClick={openSource}
                  dismissed={dismissedSetFor(selSlide.id)}
                  onDismiss={(item) => toggleDismissed(selSlide.id, item, true)}
                  onRestore={(item) => toggleDismissed(selSlide.id, item, false)}
                />
                <h3>讲稿 Speaker notes</h3>
                <p className="notes">
                  <RichText text={selSlide.notes || "—"} />
                </p>
                {selSlide.warnings.length > 0 && (
                  <details className="muted small">
                    <summary>检查提示 {selSlide.warnings.length} 条 · checks</summary>
                    <ul>
                      {selSlide.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            ) : (
              <p className="muted">{failed[sel.id] ?? "这一页还没有生成 · Not generated yet"}</p>
            )}
          </aside>
        )}
      </div>
      {source && <SourcePage page={source} onClose={() => setSource(null)} />}
    </div>
  );
}
