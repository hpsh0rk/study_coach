import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { countPages, normalizeRanges, rangesForChapters, subtreeIds } from "@kj/pdf-structure";
import type { ChapterNode, PageRange } from "@kj/schema";
import { ApiError } from "../../api.ts";
import { documentApi, lessonApi, type DocumentRow, type LessonView } from "../../lessonApi.ts";
import { Stepper, StepIntro, type StepKey } from "./Stepper.tsx";

/** "1-5, 8, 10-12" → ranges; returns null when the text is not valid. */
export function parseRanges(text: string, pageCount: number): PageRange[] | null {
  const parts = text.split(/[,，;；\s]+/).filter(Boolean);
  const out: PageRange[] = [];
  for (const p of parts) {
    const m = /^(\d+)(?:\s*[-–~]\s*(\d+))?$/.exec(p);
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    if (a < 1 || b < 1 || a > pageCount || b > pageCount) return null;
    out.push({ start: Math.min(a, b), end: Math.max(a, b) });
  }
  return normalizeRanges(out, pageCount);
}

const fmtRanges = (r: PageRange[]) => r.map((x) => (x.start === x.end ? `${x.start}` : `${x.start}–${x.end}`)).join(", ");

export function ChaptersStep({ documentId, lesson, reached }: { documentId: string; lesson?: LessonView; reached: StepKey }) {
  const nav = useNavigate();
  const [doc, setDoc] = useState<DocumentRow | null>(null);
  const [tree, setTree] = useState<ChapterNode[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set(lesson?.lesson.scope.chapterIds ?? []));
  const [rangeText, setRangeText] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    documentApi
      .get(documentId)
      .then((r) => {
        setDoc(r.document);
        setTree(r.chapters);
        setCollapsed(new Set(r.chapters.filter((c) => c.level >= 2 && r.chapters.some((k) => k.parentId === c.id)).map((c) => c.id)));
        if (lesson && !lesson.lesson.scope.chapterIds.length) setRangeText(fmtRanges(lesson.lesson.scope.ranges));
      })
      .catch((e) => setError((e as Error).message));
  }, [documentId, lesson]);

  const pageCount = doc?.pageCount ?? 0;
  const extra = parseRanges(rangeText, pageCount || 1);
  const ranges = useMemo(() => normalizeRanges([...rangesForChapters(tree, [...picked], pageCount || 1), ...(extra ?? [])], pageCount || 1), [tree, picked, extra, pageCount]);
  const pages = countPages(ranges);

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
              已选 <b>{pages}</b> 页 pages {ranges.length > 0 && <span className="muted small">（p. {fmtRanges(ranges)}）</span>}
            </div>
          </div>
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
                        p.{c.pageStart}–{c.pageEnd} · {c.pageEnd - c.pageStart + 1} 页
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
          </label>
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
