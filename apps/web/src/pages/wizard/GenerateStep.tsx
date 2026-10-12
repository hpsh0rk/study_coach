import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { PAGE_TYPES } from "@kj/pedagogy";
import type { Slide, SlideSpec } from "@kj/schema";
import { ApiError } from "../../api.ts";
import { SlotEditor } from "../../components/SlotEditor.tsx";
import { SlidePreview, SlideThumb } from "../../components/SlideView.tsx";
import { UnverifiedBadge, UnverifiedBox } from "../../components/Unverified.tsx";
import { documentApi, lessonApi, type LessonView } from "../../lessonApi.ts";
import { downloadOfflineHtml } from "../../offline/exportDeck.ts";
import { openPresenter } from "../PlayPages.tsx";
import { Stepper, StepIntro, type StepKey } from "./Stepper.tsx";

const CONCURRENCY = 2;

export function GenerateStep({ view, reached }: { view: LessonView; reached: StepKey }) {
  const nav = useNavigate();
  const confirmed = view.version?.confirmedAt ? view.version : null;
  const specs: SlideSpec[] = useMemo(() => confirmed?.outline.slides ?? [], [confirmed]);
  const [slides, setSlides] = useState<Record<string, Slide>>(() => Object.fromEntries(view.slides.map((s) => [s.specId, s])));
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(specs[0]?.id ?? null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [source, setSource] = useState<{ no: number; text: string; label: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState("");
  const [exportError, setExportError] = useState("");
  const stop = useRef(false);
  const theme = view.lesson.theme;

  const labels = view.pageLabels;
  const generateOne = useCallback(
    async (specId: string, regenerate = false) => {
      if (!confirmed) return;
      setRunning((r) => new Set(r).add(specId));
      setFailed(({ [specId]: _drop, ...rest }) => rest);
      try {
        const { slide } = await lessonApi.generate(view.lesson.id, confirmed.id, specId, regenerate);
        setSlides((m) => ({ ...m, [specId]: slide }));
      } catch (e) {
        setFailed((f) => ({ ...f, [specId]: e instanceof ApiError ? e.message : (e as Error).message }));
      } finally {
        setRunning((r) => {
          const n = new Set(r);
          n.delete(specId);
          return n;
        });
      }
    },
    [confirmed, view.lesson.id],
  );

  async function generateAll() {
    stop.current = false;
    const missing = specs.filter((s) => !slides[s.id]);
    // Worked examples first, so faded and practice pages can mirror their problem.
    for (const todo of [missing.filter((s) => s.pageType === "worked"), missing.filter((s) => s.pageType !== "worked")].map((l) => l.map((s) => s.id))) {
      let next = 0;
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          while (next < todo.length && !stop.current) await generateOne(todo[next++]!);
        }),
      );
    }
  }

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
          {!all ? (
            <button className="btn primary" disabled={running.size > 0} onClick={generateAll} data-testid="generate-all">
              {running.size ? "生成中… Generating" : done ? `继续生成剩下 ${specs.length - done} 页 Continue` : "生成全部幻灯片 Generate all"}
            </button>
          ) : (
            <button className="btn primary" onClick={() => nav(`/play/${view.lesson.id}`)} data-testid="present">
              ▶ 放映 Present
            </button>
          )}
          {!all && (
            <button className="btn ghost" disabled={done === 0} onClick={() => nav(`/play/${view.lesson.id}`)} data-testid="present-partial">
              ▶ 放映已生成的 Present
            </button>
          )}
          <button className="btn ghost" disabled={done === 0} onClick={() => openPresenter(view.lesson.id)} title="讲稿、下一页、计时和答案，在你自己的屏幕上 · notes, next slide, timer and answers on your own screen">
            演讲者视图 Presenter
          </button>
          <details className="menu">
            <summary className="btn ghost" aria-disabled={done === 0}>
              导出 / 分享 Export ▾
            </summary>
            <div className="menu-list card">
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
              <button
                className="btn ghost"
                disabled={done === 0}
                onClick={async () => {
                  const r = await lessonApi.share(view.lesson.id);
                  const url = `${location.origin}${r.path}`;
                  setShareUrl(url);
                  await navigator.clipboard?.writeText(url).catch(() => undefined);
                }}
              >
                学生分享链接 Share link
              </button>
            </div>
          </details>
        </div>
      </div>
      {exportError && <div className="alert error">导出失败 Export failed: {exportError}</div>}
      {shareUrl && (
        <div className="alert success">
          学生可以用这个链接查看（不含讲稿）· Read-only link (no speaker notes): <a href={shareUrl}>{shareUrl}</a>
        </div>
      )}
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
                }}
                data-testid="thumb"
              >
                {slide ? (
                  <SlideThumb slide={slide} theme={theme} index={i} pageLabels={labels} />
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
                  {slide && <UnverifiedBadge count={slide.unverified?.length ?? 0} />}
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
              <div className="row">
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
                <button className="btn small ghost" disabled={running.has(sel.id) || editing} onClick={() => generateOne(sel.id, !!selSlide)} data-testid="regenerate">
                  {selSlide ? "重新生成 Regenerate" : "生成这一页 Generate"}
                </button>
              </div>
            </div>
            {selSlide && editing ? (
              <SlotEditor
                key={selSlide.id}
                content={selSlide.content}
                notes={selSlide.notes}
                unverified={selSlide.unverified}
                onCancel={() => setEditing(false)}
                onSave={async (content, notes) => {
                  replaceSlide((await lessonApi.editSlide(view.lesson.id, selSlide.id, { content, notes })).slide);
                  setEditing(false);
                }}
              />
            ) : selSlide ? (
              <>
                <SlidePreview slide={selSlide} theme={theme} onSourceClick={openSource} pageLabels={labels} />
                <UnverifiedBox items={selSlide.unverified ?? []} sources={selSlide.sources} onSourceClick={openSource} />
                <h3>讲稿 Speaker notes</h3>
                <p className="notes">{selSlide.notes || "—"}</p>
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
      {source && (
        <div className="modal" onClick={() => setSource(null)}>
          <div className="modal-card card" onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h2>教材第 {source.label ?? source.no} 页 · Source page</h2>
              <button className="btn small ghost" onClick={() => setSource(null)}>
                关闭 Close
              </button>
            </div>
            <pre className="source-text">{source.text}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
