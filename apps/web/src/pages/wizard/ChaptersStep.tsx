import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { countPages, labelOf, normalizeRanges, pageForLabel, pagesInRanges, rangesForChapters, subtreeIds } from "@kj/pdf-structure";
import { scopeAdvice } from "@kj/pedagogy";
import type { ChapterNode, PageRange } from "@kj/schema";
import { ApiError } from "../../api.ts";
import { documentApi, lessonApi, type DocumentRow, type LessonView } from "../../lessonApi.ts";
import { Stepper, StepIntro, type StepKey } from "./Stepper.tsx";

/**
 * "112-118, 120" → ranges of page indexes. Numbers are the book's printed page labels when the
 * PDF has them (what teachers read in the table of contents). Returns null when invalid.
 */
export function parseRanges(text: string, pageCount: number, labels: Map<number, string> = new Map()): PageRange[] | null {
  const parts = text.split(/[,，;；\s]+/).filter(Boolean);
  const out: PageRange[] = [];
  for (const p of parts) {
    const m = /^([^-–~]+?)(?:\s*[-–~]\s*([^-–~]+))?$/.exec(p);
    if (!m) return null;
    const a = pageForLabel(labels, m[1]!, pageCount);
    const b = pageForLabel(labels, m[2] ?? m[1]!, pageCount);
    if (a === null || b === null) return null;
    out.push({ start: Math.min(a, b), end: Math.max(a, b) });
  }
  return normalizeRanges(out, pageCount);
}

const fmtRanges = (r: PageRange[], labels: Map<number, string>) =>
  r.map((x) => (x.start === x.end ? labelOf(labels, x.start) : `${labelOf(labels, x.start)}–${labelOf(labels, x.end)}`)).join(", ");

/** Estimated teaching time of the selection against the lesson length, so teachers see the volume while ticking chapters. */
function VolumeMeter({ estimated, lessonMinutes }: { estimated: number; lessonMinutes: number }) {
  const scale = lessonMinutes * 1.6;
  const state = estimated > lessonMinutes * 1.2 ? "over" : estimated < lessonMinutes * 0.6 ? "under" : "ok";
  const text = {
    over: "内容偏多 · more than one lesson",
    under: "内容偏少 · 课上会多出练习时间 · leaves time for practice",
    ok: "内容量合适 · fits the lesson",
  }[state];
  return (
    <div className={`volume-meter ${state}`} data-testid="volume-meter">
      <div className="volume-bar" aria-hidden>
        <span className="volume-fill" style={{ width: `${Math.min(100, (estimated / scale) * 100)}%` }} />
        <span className="volume-mark" style={{ left: `${(lessonMinutes / scale) * 100}%` }} />
      </div>
      <span className="small">
        约 {estimated} / {lessonMinutes} 分钟 · {text}
      </span>
    </div>
  );
}

export function ChaptersStep({ documentId, lesson, reached }: { documentId: string; lesson?: LessonView; reached: StepKey }) {
  const nav = useNavigate();
  const [doc, setDoc] = useState<DocumentRow | null>(null);
  const [tree, setTree] = useState<ChapterNode[]>([]);
  const [labels, setLabels] = useState<Map<number, string>>(new Map());
  const [pageWords, setPageWords] = useState<number[]>([]);
  const [preview, setPreview] = useState<{ start: string; end: string } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set(lesson?.lesson.scope.chapterIds ?? []));
  const [rangeText, setRangeText] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    documentApi
      .get(documentId)
      .then((r) => {
        const map = new Map(Object.entries(r.pageLabels).map(([k, v]) => [Number(k), v]));
        setDoc(r.document);
        setTree(r.chapters);
        setLabels(map);
        setPageWords(r.pageWords);
        setCollapsed(new Set(r.chapters.filter((c) => c.level >= 2 && r.chapters.some((k) => k.parentId === c.id)).map((c) => c.id)));
        if (lesson && !lesson.lesson.scope.chapterIds.length) setRangeText(fmtRanges(lesson.lesson.scope.ranges, map));
      })
      .catch((e) => setError((e as Error).message));
  }, [documentId, lesson]);

  const pageCount = doc?.pageCount ?? 0;
  const extra = useMemo(() => parseRanges(rangeText, pageCount || 1, labels), [rangeText, pageCount, labels]);
  const ranges = useMemo(() => normalizeRanges([...rangesForChapters(tree, [...picked], pageCount || 1), ...(extra ?? [])], pageCount || 1), [tree, picked, extra, pageCount]);
  const pages = countPages(ranges);
  const lessonMinutes = lesson?.lesson.params.minutes ?? 40;
  const advice = scopeAdvice(
    pagesInRanges(ranges).reduce((n, p) => n + (pageWords[p - 1] ?? 0), 0),
    lessonMinutes,
  );

  // First line of the first and last typed page, so teachers can check the numbers match their book.
  useEffect(() => {
    const first = extra?.[0]?.start;
    const last = extra?.[extra.length - 1]?.end;
    if (!first || !last) return setPreview(null);
    let live = true;
    const firstLine = (t: string) => t.split("\n").find((l) => l.trim().length > 3)?.slice(0, 80) ?? "";
    void Promise.all([documentApi.page(documentId, first), documentApi.page(documentId, last)])
      .then(([a, b]) => live && setPreview({ start: firstLine(a.text), end: firstLine(b.text) }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [extra, documentId]);

  function toggle(id: string) {
    const ids = subtreeIds(tree, id);
    const next = new Set(picked);
    const on = !picked.has(id);
    for (const x of ids) {
      if (on) next.add(x);
      else next.delete(x);
    }
    setPicked(next);
  }

  const visible = tree.filter((c) => {
    let p = c.parentId;
    while (p) {
      if (collapsed.has(p)) return false;
      p = tree.find((x) => x.id === p)?.parentId ?? null;
    }
    return true;
  });

  async function next() {
    if (extra === null) return setError("页码格式不对，例如 3-8, 12 · Page ranges look wrong, e.g. 3-8, 12");
    if (!pages) return setError("请至少选择一个章节或输入页码 · Choose at least one chapter or page range");
    setBusy(true);
    setError("");
    try {
      const chapterIds = [...picked];
      const view = lesson ? await lessonApi.patch(lesson.lesson.id, { chapterIds, ranges: extra }) : await lessonApi.create(documentId, chapterIds, extra);
      nav(`/lessons/${view.lesson.id}/settings`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="wizard">
      <Stepper current="chapters" reached={reached} lessonId={lesson?.lesson.id} />
      <StepIntro step="chapters" />
      {doc && (
        <div className="card">
          <div className="row between">
            <div>
              <h2>📘 {doc.title}</h2>
              <p className="muted small">
                共 {doc.pageCount} 页 · {tree.length ? `${tree.length} 个书签章节 bookmarks` : "这个 PDF 没有书签目录，请直接输入页码 · No bookmarks: enter page ranges"}
              </p>
            </div>
            <div className="selection-pill" data-testid="selection">
              已选 <b>{pages}</b> 页 pages {ranges.length > 0 && <span className="muted small">（p. {fmtRanges(ranges, labels)}）</span>}
              {pages > 0 && (
                <div className="muted small" data-testid="scope-estimate">
                  按字数估计约需 {advice.estimatedMinutes} 分钟 · about {advice.estimatedMinutes} min to teach
                </div>
              )}
            </div>
          </div>
          {pages === 0 ? (
            <div className="empty-inline" data-testid="chapters-empty">
              还没选内容：勾选下面的章节，或在下方输入页码。· Nothing selected yet: tick chapters below or type page ranges.
            </div>
          ) : (
            <VolumeMeter estimated={advice.estimatedMinutes} lessonMinutes={lessonMinutes} />
          )}
          {pages > 0 && advice.tooMuch && (
            <div className="alert warn" data-testid="split-hint">
              内容偏多：按 {lessonMinutes} 分钟一节，大约需要 {advice.lessons} 节课。建议拆成 {advice.lessons} 课时，或只选前面几节；放不下的内容会列在大纲顶部的“未覆盖”里。· About {advice.lessons} lessons of {lessonMinutes} min:
              consider splitting the selection.
            </div>
          )}
          {tree.length > 0 && (
            <ul className="tree" role="tree">
              {visible.map((c) => {
                const hasKids = tree.some((k) => k.parentId === c.id);
                return (
                  <li key={c.id} role="treeitem" aria-selected={picked.has(c.id)} style={{ paddingLeft: (c.level - 1) * 22 }}>
                    {hasKids ? (
                      <button
                        className="tree-toggle"
                        aria-label={collapsed.has(c.id) ? "展开 Expand" : "收起 Collapse"}
                        onClick={() => {
                          const n = new Set(collapsed);
                          if (n.has(c.id)) n.delete(c.id);
                          else n.add(c.id);
                          setCollapsed(n);
                        }}
                      >
                        {collapsed.has(c.id) ? "▸" : "▾"}
                      </button>
                    ) : (
                      <span className="tree-toggle" />
                    )}
                    <label className="tree-label">
                      <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                      <span>{c.title}</span>
                      <span className="muted small">
                        p.{labelOf(labels, c.pageStart)}–{labelOf(labels, c.pageEnd)} · {c.pageEnd - c.pageStart + 1} 页
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <label className="range-input">
            {tree.length ? "也可以补充页码（可选）· Extra page ranges (optional)" : "页码范围 · Page ranges"}
            <input value={rangeText} onChange={(e) => setRangeText(e.target.value)} placeholder="例如 e.g. 3-8, 12" data-testid="ranges" />
            {labels.size > 0 && <span className="muted small">按书上印的页码输入 · use the page numbers printed in the book</span>}
          </label>
          {preview && (
            <p className="muted small range-preview" data-testid="range-preview">
              起始页：“{preview.start}” · 结束页：“{preview.end}”
            </p>
          )}
        </div>
      )}
      {error && <div className="alert error">{error}</div>}
      <div className="wizard-actions">
        <button className="btn ghost" onClick={() => nav(lesson ? "/" : "/new")}>
          ← 返回 Back
        </button>
        <button className="btn primary" disabled={busy || !pages} onClick={next}>
          下一步：课时设置 Next →
        </button>
      </div>
    </div>
  );
}
