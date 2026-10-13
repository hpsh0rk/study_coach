import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  countPages,
  isEmptyPage,
  isExternalParser,
  isMustFix,
  isVisionParser,
  labelOf,
  MUST_FIX_KINDS,
  normalizeRanges,
  PASTE_PARSER,
  PDFJS_PARSER,
  pageForLabel,
  pagesInRanges,
  rangesForChapters,
  REFINE_KINDS,
  sourceCut,
  subtreeIds,
  type PageFlag,
} from "@kj/textbook";
import { OUTLINE_SOURCE_CHARS, scopeAdvice } from "@kj/pedagogy";
import type { ChapterNode, PageKind, PageRange } from "@kj/schema";
import { ApiError } from "../../api.ts";
import { lessonApi, type LessonView, type UnitPreview } from "../../lessonApi.ts";
import { documentApi, type DocumentRow, type ExternalParserInfo, type PastedPage, type VisionParserInfo } from "../../textbook/api.ts";
import { parseExternally, pdfCutter, rememberedFile, rememberFile, type ExternalOutcome } from "../../textbook/external.ts";
import { pageRenderer } from "../../textbook/pdf.ts";
import { readWithVision } from "../../textbook/vision.ts";
import { sha256Hex, type IngestOutcome } from "../../textbook/ingest.ts";
import { Stepper, StepIntro, type StepKey } from "./Stepper.tsx";

/**
 * "112-118, 120" → ranges of page indexes. Numbers are the book's printed page labels when the
 * PDF has them (what teachers read in the table of contents). Returns null when invalid.
 */
function parseRanges(text: string, pageCount: number, labels: Map<number, string> = new Map()): PageRange[] | null {
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

/** Estimated teaching time of the selection against the lesson length, so teachers see the volume while ticking chapters. Never "fits" while pages are left unread. */
function VolumeMeter({ estimated, lessonMinutes, dropped }: { estimated: number; lessonMinutes: number; dropped: boolean }) {
  const scale = lessonMinutes * 1.6;
  const state = dropped || estimated > lessonMinutes * 1.2 ? "over" : estimated < lessonMinutes * 0.6 ? "under" : "ok";
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

const runsOf = (pages: number[]): PageRange[] => normalizeRanges(pages.map((p) => ({ start: p, end: p })), Math.max(1, ...pages));
export const fmtPages = (pages: number[], labels: Map<number, string>) => fmtRanges(runsOf(pages), labels);

/** What the outline will and will not read from the selected pages. */
function selectionStats(selected: number[], pageWords: number[], pageChars: number[]) {
  const empty = selected.filter((p) => isEmptyPage(pageWords[p - 1] ?? 0));
  const withText = selected.filter((p) => !isEmptyPage(pageWords[p - 1] ?? 0));
  return {
    words: withText.reduce((n, p) => n + (pageWords[p - 1] ?? 0), 0),
    empty,
    unread: sourceCut(
      withText.map((no) => ({ no, chars: pageChars[no - 1] ?? 0 })),
      OUTLINE_SOURCE_CHARS,
    ).omitted,
  };
}

/** Teachers paste the text of scanned pages; it is spread over the empty pages of the range. */
function PastePanel({ documentId, run, labels, onDone }: { documentId: string; run: PageRange; labels: Map<number, string>; onDone: (pages: PastedPage[]) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const span = run.start === run.end ? `p. ${labelOf(labels, run.start)}` : `p. ${labelOf(labels, run.start)}–${labelOf(labels, run.end)}`;
  async function save() {
    setBusy(true);
    setError("");
    try {
      onDone((await documentApi.paste(documentId, run.start, run.end, text)).pages);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="paste-panel" data-testid="paste-panel">
      <label>
        粘贴 {span} 的文字（从电子版、OCR 或手打都行）· Paste the text of {span}
        <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} data-testid="paste-text" />
      </label>
      {error && <div className="alert error">{error}</div>}
      <button className="btn" disabled={busy || text.trim().length < 20} onClick={save} data-testid="paste-save">
        {busy ? "保存中… Saving" : "保存文字 Save text"}
      </button>
    </div>
  );
}

const LOSSY: Partial<Record<PageKind, string>> = { "formula-lost": "公式没读出", scanned: "扫描", garbled: "乱码" };

/** Books whose must-fix pages were already sent automatically in this tab (once per book, even if the step remounts). */
const autoSent = new Set<string>();
const AUTO_LIMIT = 300;

type ParseRun = { kind: "running"; done: number; total: number } | ({ kind: "done" } & ExternalOutcome) | { kind: "error"; message: string };

const VIA = {
  external: { who: "外部解析服务", running: "正在重新读取", en: "the external parser", check: "" },
  vision: { who: "看图模型", running: "正在识别页面图片", en: "the vision model", check: "，读出的公式和数字请对照原书核对" },
} as const;

/** Progress and outcome of re-reading pages: `external` (MinerU) or `vision` (the provider's vision model). Test ids carry the prefix. */
function ParseStatus({ run, via }: { run: ParseRun; via: keyof typeof VIA }) {
  const v = VIA[via];
  if (run.kind === "running")
    return (
      <div className="alert info" data-testid={`${via}-progress`}>
        {v.who}
        {v.running} {run.done} / {run.total} 页…（只发送这几页，不发送整本书）· Re-reading pages with {v.en}
        <div className="progress">
          <div style={{ width: `${Math.round((run.done / Math.max(1, run.total)) * 100)}%` }} />
        </div>
      </div>
    );
  if (run.kind === "error")
    return (
      <div className="alert error" data-testid={`${via}-error`}>
        {run.message}
      </div>
    );
  const read = new Set(run.saved.map((p) => p.no)).size;
  return (
    <div className={`alert ${run.missed.length ? "warn" : "info"}`} data-testid={`${via}-done`} data-read={read} data-missed={run.missed.length}>
      {v.who}读好了 {read} 页{read > 0 && v.check}
      {run.missed.length > 0 && `；${run.missed.length} 页没读出来，选到这些页时可以粘贴文字补上`}
      {run.stopped && `（${run.stopped}）`}。· Re-read {read} page(s) with {v.en}{run.missed.length > 0 && `; ${run.missed.length} not read`}.
    </div>
  );
}

const REUSED: Partial<Record<IngestOutcome, string>> = {
  ready: "这份 PDF 之前上传过，直接用了上次读好的文字，没有重新解析 · Already uploaded: reused without parsing again",
  resumed: "上次没有传完，这次只补传了缺的页 · Finished the interrupted upload; only the missing pages were sent",
  restored: "已恢复之前删除的这份教材 · Restored the PDF you deleted earlier",
};

export function ChaptersStep({ documentId, lesson, reached }: { documentId: string; lesson?: LessonView; reached: StepKey }) {
  const nav = useNavigate();
  const reused = REUSED[(useLocation().state as { textbook?: IngestOutcome } | null)?.textbook ?? "new"];
  const [doc, setDoc] = useState<DocumentRow | null>(null);
  const [tree, setTree] = useState<ChapterNode[]>([]);
  const [labels, setLabels] = useState<Map<number, string>>(new Map());
  const [pageWords, setPageWords] = useState<number[]>([]);
  const [pageChars, setPageChars] = useState<number[]>([]);
  const [pageParsers, setPageParsers] = useState<Record<number, string>>({});
  const [pageFlags, setPageFlags] = useState<Record<number, PageFlag[]>>({});
  const [pageKinds, setPageKinds] = useState<Record<number, PageKind>>({});
  const [external, setExternal] = useState<ExternalParserInfo | null>(null);
  const [extRun, setExtRun] = useState<ParseRun | null>(null);
  const [vision, setVision] = useState<VisionParserInfo | null>(null);
  const [visRun, setVisRun] = useState<ParseRun | null>(null);
  const pickFor = useRef<((file: File) => void) | null>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState<PageRange | null>(null);
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
        setPageChars(r.pageChars);
        setPageParsers(r.pageParsers);
        setPageFlags(r.pageFlags);
        setPageKinds(r.pageKinds);
        setExternal(r.externalParser);
        setVision(r.visionParser);
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
  const stats = useMemo(() => selectionStats(pagesInRanges(ranges), pageWords, pageChars), [ranges, pageWords, pageChars]);
  const advice = scopeAdvice(stats.words, lessonMinutes, stats.unread.length);
  const emptyRuns = runsOf(stats.empty);
  const pagesOf = (c: ChapterNode) => pagesInRanges([{ start: c.pageStart, end: c.pageEnd }]);
  const emptyIn = (c: ChapterNode) => pagesOf(c).filter((p) => isEmptyPage(pageWords[p - 1] ?? 0)).length;
  const pastedIn = (c: ChapterNode) => pagesOf(c).filter((p) => pageParsers[p] === PASTE_PARSER).length;
  // Links and e-mails are common in textbook footers; only instruction-like text is worth a badge here.
  const flaggedIn = (c: ChapterNode) => pagesOf(c).filter((p) => pageFlags[p]?.includes("instruction"));

  // Must-fix pages whose pdf.js text is still the only text: scans, garbled fonts, formulas drawn as outlines.
  const unfixed = (p: number) => isMustFix(pageKinds[p]) && (pageParsers[p] ?? PDFJS_PARSER) === PDFJS_PARSER;
  const lossyIn = (c: ChapterNode) => pagesOf(c).filter((p) => unfixed(p) && !isEmptyPage(pageWords[p - 1] ?? 0));
  const bookLossy = MUST_FIX_KINDS.flatMap((kind) => {
    const count = Object.entries(pageKinds).filter(([no, k]) => k === kind && unfixed(Number(no))).length;
    return count ? [{ kind, count }] : [];
  });
  const lossyRuns = runsOf(pagesInRanges(ranges).filter((p) => unfixed(p) && !isEmptyPage(pageWords[p - 1] ?? 0)));
  const externalIn = (c: ChapterNode) => pagesOf(c).filter((p) => isExternalParser(pageParsers[p])).length;
  const visionIn = (c: ChapterNode) => pagesOf(c).filter((p) => isVisionParser(pageParsers[p])).length;
  const visionRuns = runsOf(pagesInRanges(ranges).filter((p) => isVisionParser(pageParsers[p])));
  const reading = extRun?.kind === "running" || visRun?.kind === "running";
  // "精修本章": pages the text layer read but not well (formula-heavy, tables), plus must-fix ones still unread.
  const refinable = (c: ChapterNode) => pagesOf(c).filter((p) => unfixed(p) || (REFINE_KINDS.includes(pageKinds[p]!) && (pageParsers[p] ?? PDFJS_PARSER) === PDFJS_PARSER));
  const unfixedPages = Object.keys(pageKinds)
    .map(Number)
    .filter(unfixed)
    .sort((a, b) => a - b);

  /** New facts for re-read pages (paste or external parser); functional updates, as a parser run outlives renders. */
  function applyFacts(rows: PastedPage[]) {
    setPageWords((w) => rows.reduce((n, r) => ((n[r.no - 1] = r.words), n), [...w]));
    setPageChars((ch) => rows.reduce((n, r) => ((n[r.no - 1] = r.chars), n), [...ch]));
    setPageParsers((ps) => rows.reduce((n, r) => ((n[r.no] = r.parser), n), { ...ps }));
    setPageFlags((fs) =>
      rows.reduce(
        (n, r) => {
          if (r.flags.length) n[r.no] = r.flags;
          else delete n[r.no];
          return n;
        },
        { ...fs },
      ),
    );
  }

  function pasted(rows: PastedPage[]) {
    applyFacts(rows);
    setPasting(null);
  }

  async function runExternal(nos: number[], reason: "auto" | "refine", file: Blob) {
    if (!external || !nos.length) return;
    setExtRun({ kind: "running", done: 0, total: nos.length });
    const out = await parseExternally(
      nos.map((no) => ({ no, kind: pageKinds[no] })),
      external,
      {
        create: (pages, ocr) => documentApi.parse(documentId, pages, reason, ocr),
        upload: async (job, pdf) => void (await documentApi.parseUpload(documentId, job, pdf)),
        poll: (job) => documentApi.parsePoll(documentId, job),
        result: (job) => documentApi.parseResult(documentId, job),
        save: async (job, pages) => (await documentApi.parseSave(documentId, job, pages)).pages,
        cut: pdfCutter(file),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      (done, total) => setExtRun({ kind: "running", done, total }),
    );
    applyFacts(out.saved);
    setExtRun({ kind: "done", ...out });
    if (out.missed.length) await runVision(out.missed, reason, file);
  }

  /** The fallback: page images through the provider's vision model, one page at a time. */
  async function runVision(nos: number[], reason: "auto" | "refine", file: Blob) {
    if (!vision || !nos.length) return;
    setVisRun({ kind: "running", done: 0, total: nos.length });
    const renderer = pageRenderer(file);
    try {
      const out = await readWithVision(nos, { render: (no) => renderer.render(no), read: (no, image) => documentApi.parseImage(documentId, no, image, reason) }, (done, total) =>
        setVisRun({ kind: "running", done, total }),
      );
      applyFacts(out.saved);
      setVisRun({ kind: "done", ...out });
    } finally {
      await renderer.close();
    }
  }

  /** The book's file: kept from the upload in this tab, or picked again (checked against the stored hash). */
  function withFile(then: (file: Blob) => void) {
    const kept = rememberedFile(documentId);
    if (kept) return then(kept);
    pickFor.current = async (file) => {
      if (doc?.fileSha256 && (await sha256Hex(await file.arrayBuffer())) !== doc.fileSha256) {
        return (external ? setExtRun : setVisRun)({ kind: "error", message: "选的不是这本教材的 PDF，请选上传时的同一个文件 · That is not the same PDF" });
      }
      rememberFile(documentId, file);
      then(file);
    };
    filePicker.current?.click();
  }

  // Right after an upload in this tab, must-fix pages are re-read without asking: by the external parser when it is
  // on (the vision model then takes what it missed), else by the vision model when one is configured.
  useEffect(() => {
    const file = rememberedFile(documentId);
    if ((!external && !vision) || !file || autoSent.has(documentId) || !unfixedPages.length) return;
    autoSent.add(documentId);
    const nos = unfixedPages.slice(0, AUTO_LIMIT);
    void (external ? runExternal(nos, "auto", file) : runVision(nos, "auto", file));
  }, [external, vision, documentId, unfixedPages.length]);

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

  // A selection far below one lesson (under 30 %) needs a second, explicit click, like an over-long outline.
  const thin = pages > 0 && stats.unread.length === 0 && advice.estimatedMinutes < lessonMinutes * 0.3;
  const [thinAck, setThinAck] = useState(false);

  async function next() {
    if (extra === null) return setError("页码格式不对，例如 3-8, 12 · Page ranges look wrong, e.g. 3-8, 12");
    if (!pages) return setError("请至少选择一个章节或输入页码 · Choose at least one chapter or page range");
    if (thin && !thinAck) return setThinAck(true);
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

  // `count` undefined: the server picks the fewest lessons that each fit the lesson length.
  const [unitPlan, setUnitPlan] = useState<{ count?: number; preview: UnitPreview } | null>(null);
  const selection = JSON.stringify([[...picked].sort(), extra]);
  useEffect(() => {
    setUnitPlan(null);
    setThinAck(false);
  }, [selection]);
  const unitRequest = (count?: number) => ({ documentId, chapterIds: [...picked], ranges: extra ?? [], count, lessonId: lesson?.lesson.id, params: lesson?.lesson.params });
  async function previewUnit(count?: number) {
    if (extra === null) return;
    setBusy(true);
    setError("");
    try {
      setUnitPlan({ count, preview: await lessonApi.previewUnit(unitRequest(count)) });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function planUnit() {
    if (extra === null || !unitPlan) return;
    setBusy(true);
    setError("");
    try {
      const res = await lessonApi.planUnit(unitRequest(unitPlan.count));
      nav(`/?unit=${res.unit.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="wizard">
      <Stepper current="chapters" reached={reached} lessonId={lesson?.lesson.id} />
      <StepIntro step="chapters" />
      {reused && (
        <div className="alert info" data-testid="textbook-reused">
          {reused}
        </div>
      )}
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
          {bookLossy.length > 0 && (
            <div className="alert info" data-testid="must-fix-summary" data-count={bookLossy.reduce((n, k) => n + k.count, 0)}>
              这本书有 {bookLossy.reduce((n, k) => n + k.count, 0)} 页可能没读全：{bookLossy.map((k) => `${LOSSY[k.kind]} ${k.count} 页`).join(" · ")}。浏览器只能读出文字层，扫描图和画成图形的公式读不到。
              {external ? (
                !reading && (
                  <span>
                    {" "}
                    可以用外部解析服务重新读这些页（只发送这几页），或选到这些页时粘贴文字补上。
                    <button className="btn small" onClick={() => withFile((f) => void runExternal(unfixedPages.slice(0, AUTO_LIMIT), "auto", f))} data-testid="external-run">
                      用外部解析服务读这 {Math.min(AUTO_LIMIT, unfixedPages.length)} 页
                    </button>
                  </span>
                )
              ) : vision ? (
                <>
                  <span data-testid="external-off"> 外部解析服务没有开启。</span>
                  {!reading && (
                    <span>
                      可以用看图模型（{vision.model}）识别这些页的图片（读出的数字要核对），或选到这些页时粘贴文字补上。
                      <button className="btn small" onClick={() => withFile((f) => void runVision(unfixedPages.slice(0, AUTO_LIMIT), "auto", f))} data-testid="vision-run">
                        用看图模型读这 {Math.min(AUTO_LIMIT, unfixedPages.length)} 页
                      </button>
                    </span>
                  )}
                </>
              ) : (
                <span data-testid="external-off">
                  {" "}
                  选到这些页时可以粘贴文字补上；管理员在后台开启“外部解析服务”或配置“看图模型”后，这些页可以自动识别。
                </span>
              )}{" "}
              · Some pages were not fully read (scans, formulas drawn as outlines)
              {external ? ": re-read them with the external parser, or paste their text." : vision ? ": read their images with the vision model, or paste their text." : "; paste their text where you need it."}
            </div>
          )}
          {extRun && <ParseStatus run={extRun} via="external" />}
          {visRun && <ParseStatus run={visRun} via="vision" />}
          <input
            ref={filePicker}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            data-testid="external-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) pickFor.current?.(f);
              e.target.value = "";
            }}
          />
          {pages === 0 ? (
            <div className="empty-inline" data-testid="chapters-empty">
              还没选内容：勾选下面的章节，或在下方输入页码。· Nothing selected yet: tick chapters below or type page ranges.
            </div>
          ) : (
            <VolumeMeter estimated={advice.estimatedMinutes} lessonMinutes={lessonMinutes} dropped={stats.unread.length > 0} />
          )}
          {pages > 0 && stats.empty.length > 0 && (
            <div className="alert warn" data-testid="empty-pages">
              {stats.empty.length === pages ? (
                <>所选的页都没有可读的文字（可能是扫描图），没法据此起草大纲。请把这些页的文字粘贴进来，或换别的章节。</>
              ) : (
                <>
                  第 {fmtRanges(emptyRuns, labels)} 页没有可读的文字（可能是扫描图），起草大纲时会跳过这些页。如果这些页要讲，请把文字粘贴进来。
                </>
              )}{" "}
              · Pages without text (scans) are skipped; paste their text to include them.
              <div className="row wrap">
                {emptyRuns.map((r) => (
                  <button key={r.start} className="btn small" onClick={() => setPasting(r)} data-testid="paste-open">
                    为 p. {r.start === r.end ? labelOf(labels, r.start) : `${labelOf(labels, r.start)}–${labelOf(labels, r.end)}`} 粘贴文字
                  </button>
                ))}
              </div>
            </div>
          )}
          {pages > 0 && lossyRuns.length > 0 && (
            <div className="alert warn" data-testid="lossy-pages">
              第 {fmtRanges(lossyRuns, labels)} 页的公式或数字可能没读出来（教材把它们画成了图形，或是扫描页），起草时只能读到残缺的文字。要讲这些页的话，请粘贴完整文字替换。· Formulas or numbers on these pages were not read; paste the full text to replace it.
              <div className="row wrap">
                {lossyRuns.map((r) => (
                  <button key={r.start} className="btn small" onClick={() => setPasting(r)} data-testid="paste-open-lossy">
                    为 p. {r.start === r.end ? labelOf(labels, r.start) : `${labelOf(labels, r.start)}–${labelOf(labels, r.end)}`} 粘贴文字
                  </button>
                ))}
              </div>
            </div>
          )}
          {pages > 0 && visionRuns.length > 0 && (
            <div className="alert info" data-testid="vision-pages">
              第 {fmtRanges(visionRuns, labels)} 页的文字是看图模型从页面图片识别的，公式和数字可能有误，请对照原书核对；有错可以粘贴正确的文字替换。· Read from page images by the vision model: check formulas and numbers; paste the correct text if needed.
              <div className="row wrap">
                {visionRuns.map((r) => (
                  <button key={r.start} className="btn small" onClick={() => setPasting(r)} data-testid="paste-open-vision">
                    为 p. {r.start === r.end ? labelOf(labels, r.start) : `${labelOf(labels, r.start)}–${labelOf(labels, r.end)}`} 粘贴文字
                  </button>
                ))}
              </div>
            </div>
          )}
          {pages > 0 && pasting && <PastePanel key={pasting.start} documentId={documentId} run={pasting} labels={labels} onDone={pasted} />}
          {pages > 0 && advice.tooMuch && (
            <div className="alert warn split-hint" data-testid="split-hint">
              <span>
              {stats.unread.length > 0 ? (
                <>
                  内容超出一份大纲能读的量：第 {fmtRanges(runsOf(stats.unread), labels)} 页读不进去，大纲不会覆盖这些页。建议拆成 {advice.lessons} 课时，或少选几节。· Pages beyond what one outline can read are left out: split the
                  selection.
                </>
              ) : (
                <>
                  内容偏多：按 {lessonMinutes} 分钟一节，大约需要 {advice.lessons} 节课。可以整单元规划成 {advice.lessons} 节课（按章节切分，每节课单独确认大纲），或只选前面几节；放不下的内容会列在大纲顶部的“未覆盖”里。· About {advice.lessons} lessons of {lessonMinutes} min:
                  consider splitting the selection.
                </>
              )}
              </span>
              <button className="btn small" disabled={busy || extra === null} onClick={() => previewUnit()} data-testid="plan-unit">
                整单元规划：先看怎么拆 Preview a unit plan
              </button>
            </div>
          )}
          {pages > 0 && unitPlan && (
            <div className="card unit-preview" data-testid="unit-preview">
              <h3>
                整单元规划预览 · {unitPlan.preview.lessons.length} 节课，每节 {unitPlan.preview.minutes} 分钟 <span className="muted small">（超过 {unitPlan.preview.maxMinutes} 分钟会标 ⚠）</span>
              </h3>
              <ol>
                {unitPlan.preview.lessons.map((l, i) => (
                  <li key={i} className={l.over ? "over" : ""} data-testid="unit-preview-lesson">
                    <b>{l.title}</b> <span className="muted small">p. {fmtRanges(l.ranges, labels)}</span> · 约 {l.estimatedMinutes} 分钟 {l.over && <span className="badge warn">⚠ 内容偏多 over</span>}
                  </li>
                ))}
              </ol>
              <div className="row">
                <button className="btn small ghost" disabled={busy || unitPlan.preview.lessons.length <= 2} onClick={() => previewUnit(unitPlan.preview.lessons.length - 1)} data-testid="unit-fewer">
                  − 少一节 Fewer
                </button>
                <button className="btn small ghost" disabled={busy || unitPlan.preview.lessons.length >= 12} onClick={() => previewUnit(unitPlan.preview.lessons.length + 1)} data-testid="unit-more">
                  ＋ 多一节 More
                </button>
                <button className="btn small ghost" disabled={busy} onClick={() => setUnitPlan(null)}>
                  取消 Cancel
                </button>
                <button className="btn primary small" disabled={busy} onClick={planUnit} data-testid="unit-confirm">
                  确定，建 {unitPlan.preview.lessons.length} 节课 Create lessons
                </button>
              </div>
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
                      {pageWords.length > 0 && emptyIn(c) > 0 && (
                        <span className="badge warn" data-testid="chapter-empty" title="这些页没有文字层，可能是扫描图 · No text layer">
                          {emptyIn(c)} 页无文字
                        </span>
                      )}
                      {MUST_FIX_KINDS.map((k) => {
                        const n = lossyIn(c).filter((p) => pageKinds[p] === k).length;
                        return n > 0 ? (
                          <span key={k} className="badge warn" data-testid="chapter-lossy" title="浏览器读不出这些页的公式、数字或扫描内容 · Content the text layer missed">
                            {n} 页{LOSSY[k]}
                          </span>
                        ) : null;
                      })}
                      {pastedIn(c) > 0 && (
                        <span className="badge note" data-testid="chapter-pasted" title="这些页的文字由老师粘贴 · Text pasted by the teacher">
                          {pastedIn(c)} 页老师粘贴
                        </span>
                      )}
                      {externalIn(c) > 0 && (
                        <span className="badge note" data-testid="chapter-external" title="浏览器读不全这些页，文字由外部解析服务重新识别 · Re-read by the external parser">
                          {externalIn(c)} 页外部解析
                        </span>
                      )}
                      {visionIn(c) > 0 && (
                        <span className="badge warn" data-testid="chapter-vision" title="这些页由看图模型从页面图片识别，公式和数字可能有误，请核对 · Read by the vision model: check the numbers">
                          {visionIn(c)} 页看图识别
                        </span>
                      )}
                      {flaggedIn(c).length > 0 && (
                        <span className="badge warn" data-testid="chapter-flagged" title="页面里有像“忽略之前的指令”这样的文字：生成时只当作教材内容，分享前请检查幻灯片 · Instruction-like text on these pages">
                          p.{flaggedIn(c).map((p) => labelOf(labels, p)).join(", ")} 含像指令的文字
                        </span>
                      )}
                    </label>
                    {external && !reading && refinable(c).some((p) => REFINE_KINDS.includes(pageKinds[p]!)) && (
                      <button
                        className="btn small ghost"
                        title="这一节的表格和公式读得不完整：只把这几页送去外部解析服务重新识别 · Re-read this section's tables and formulas"
                        onClick={() => withFile((f) => void runExternal(refinable(c).slice(0, 50), "refine", f))}
                        data-testid="refine-chapter"
                      >
                        精修本章
                      </button>
                    )}
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
      {thin && thinAck && (
        <div className="alert warn" role="alert" data-testid="thin-warning">
          只选了约 {advice.estimatedMinutes} 分钟的内容，一节课是 {lessonMinutes} 分钟：大纲会用很多练习和讨论来填满。可以再勾选几节，或者确定就这么多。· About {advice.estimatedMinutes} of {lessonMinutes} min — add more, or continue anyway.
        </div>
      )}
      <div className="wizard-actions">
        <button className="btn ghost" onClick={() => nav(lesson ? "/" : "/new")}>
          ← 返回 Back
        </button>
        <button className="btn primary" disabled={busy || !pages} onClick={next} data-testid="chapters-next">
          {thin && thinAck ? "仍然继续 Continue anyway →" : "下一步：课时设置 Next →"}
        </button>
      </div>
    </div>
  );
}
