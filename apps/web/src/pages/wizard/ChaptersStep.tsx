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
  pageFacts,
  pageForLabel,
  pagesInRanges,
  rangesForChapters,
  REFINE_KINDS,
  sourceCut,
  subtreeIds,
  type PageFlag,
} from "@kj/textbook";
import { OUTLINE_SOURCE_CHARS, scopeAdvice } from "@kj/pedagogy";
import { DEFAULT_PARAMS, type ChapterNode, type LessonSource, type PageKind, type PageRange, type PdfLessonSource, type PdfSourceRole } from "@kj/schema";
import { ApiError, lessonSourcesOf, multisourceLessonApi } from "../../api.ts";
import { lessonApi, type LessonView, type UnitPreview } from "../../lessonApi.ts";
import { documentApi, mediaApi, type DocumentRow, type ExternalParserInfo, type PastedPage, type ReaderNotes, type VisionParserInfo } from "../../textbook/api.ts";
import { parseExternally, pdfCutter, rememberedFile, rememberedPageOffset, rememberFile, type ExternalOutcome } from "../../textbook/external.ts";
import { extractPdfFigures, pageRenderer, parsePdf } from "../../textbook/pdf.ts";
import { readWithVision } from "../../textbook/vision.ts";
import { fileProblem, ingestPdf, sha256Hex, type IngestOutcome } from "../../textbook/ingest.ts";
import { Stepper, StepIntro, type StepKey } from "./Stepper.tsx";

const DURATION_CHOICES = [40, 45, 60, 90] as const;

const ROLE_LABELS: Record<PdfSourceRole, string> = {
  past_paper: "真题卷 Past paper",
  workbook: "练习册 Workbook",
  textbook: "补充教材 Textbook",
};

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

const runsOf = (pages: number[]): PageRange[] => (pages.length ? normalizeRanges(pages.map((p) => ({ start: p, end: p })), Math.max(1, ...pages)) : []);
export const fmtPages = (pages: number[], labels: Map<number, string>) => fmtRanges(runsOf(pages), labels);

/** What the outline will and will not read from the selected pages. */
function selectionStats(selected: number[], pageWords: number[], pageChars: number[], importedSet?: ReadonlySet<number>) {
  const imported = importedSet ? selected.filter((p) => importedSet.has(p)) : selected;
  const missing = importedSet ? selected.filter((p) => !importedSet.has(p)) : [];
  const empty = imported.filter((p) => isEmptyPage(pageWords[p - 1] ?? 0));
  const withText = imported.filter((p) => !isEmptyPage(pageWords[p - 1] ?? 0));
  return {
    words: withText.reduce((n, p) => n + (pageWords[p - 1] ?? 0), 0),
    empty,
    missing,
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

export function ChapterBadges({
  chapter,
  pageWords,
  pageParsers,
  pageKinds,
  pageFlags,
  labels,
  importedSet,
}: {
  chapter: ChapterNode;
  pageWords: number[];
  pageParsers: Record<number, string>;
  pageKinds: Record<number, PageKind>;
  pageFlags: Record<number, PageFlag[]>;
  labels: Map<number, string>;
  importedSet?: ReadonlySet<number>;
}) {
  const allNos = pagesInRanges([{ start: chapter.pageStart, end: chapter.pageEnd }]);
  const nos = importedSet ? allNos.filter((p) => importedSet.has(p)) : allNos;
  const unimported = importedSet ? allNos.length - nos.length : 0;
  const unfixed = (p: number) => isMustFix(pageKinds[p]) && (pageParsers[p] ?? PDFJS_PARSER) === PDFJS_PARSER;
  const empty = nos.filter((p) => isEmptyPage(pageWords[p - 1] ?? 0)).length;
  const lossy = nos.filter((p) => unfixed(p) && !isEmptyPage(pageWords[p - 1] ?? 0));
  const pasted = nos.filter((p) => pageParsers[p] === PASTE_PARSER && !isEmptyPage(pageWords[p - 1] ?? 0)).length;
  const external = nos.filter((p) => isExternalParser(pageParsers[p]) && !isEmptyPage(pageWords[p - 1] ?? 0)).length;
  const vision = nos.filter((p) => isVisionParser(pageParsers[p]) && !isEmptyPage(pageWords[p - 1] ?? 0)).length;
  const flagged = nos.filter((p) => pageFlags[p]?.includes("instruction"));
  return (
    <>
      {unimported > 0 && (
        <span className="badge note" data-testid="chapter-unimported" title="这些页尚未从原 PDF 导入，勾选后可按需补传 · Pages not imported yet">
          {unimported} 页未导入
        </span>
      )}
      {pageWords.length > 0 && empty > 0 && (
        <span className="badge warn" data-testid="chapter-empty" title="这些页没有文字层，可能是扫描图 · No text layer">
          {empty} 页无文字
        </span>
      )}
      {MUST_FIX_KINDS.map((k) => {
        const n = lossy.filter((p) => pageKinds[p] === k).length;
        return n > 0 ? (
          <span key={k} className="badge warn" data-testid="chapter-lossy" title="浏览器读不出这些页的公式、数字或扫描内容 · Content the text layer missed">
            {n} 页{LOSSY[k]}
          </span>
        ) : null;
      })}
      {pasted > 0 && (
        <span className="badge note" data-testid="chapter-pasted" title="这些页的文字由老师粘贴 · Text pasted by the teacher">
          {pasted} 页老师粘贴
        </span>
      )}
      {external > 0 && (
        <span className="badge note" data-testid="chapter-external" title="浏览器读不全这些页，文字由外部解析服务重新识别 · Re-read by the external parser">
          {external} 页外部解析
        </span>
      )}
      {vision > 0 && (
        <span className="badge warn" data-testid="chapter-vision" title="这些页由看图模型从页面图片识别，公式和数字可能有误，请核对 · Read by the vision model: check the numbers">
          {vision} 页看图识别
        </span>
      )}
      {flagged.length > 0 && (
        <span className="badge warn" data-testid="chapter-flagged" title="页面里有像“忽略之前的指令”这样的文字：生成时只当作教材内容，分享前请检查幻灯片 · Instruction-like text on these pages">
          p.{flagged.map((p) => labelOf(labels, p)).join(", ")} 含像指令的文字
        </span>
      )}
    </>
  );
}

/** Per-document pages whose must-fix content was already sent automatically in this tab. */
const autoSentByDoc = new Map<string, Set<number>>();
const AUTO_LIMIT = 300;
const SMALL_BOOK_AUTO_MAX = 120;

/**
 * Computes which must-fix pages should be auto-re-read:
 * - When pages are selected, strictly `selectedPages ∩ unfixedPages` (never burning daily quota on unselected chapters!).
 * - When nothing is selected yet, only small self-contained PDFs (`<= 120` pages) auto-run; large textbooks wait for a selection.
 */
export function autoParseTargets(opts: {
  pageCount: number;
  selectedPages: number[];
  unfixedPages: number[];
  alreadySent: ReadonlySet<number>;
}): number[] {
  const { pageCount, selectedPages, unfixedPages, alreadySent } = opts;
  if (!unfixedPages.length) return [];
  if (selectedPages.length > 0) {
    const sel = new Set(selectedPages);
    return unfixedPages.filter((p) => sel.has(p) && !alreadySent.has(p)).slice(0, AUTO_LIMIT);
  }
  if (pageCount > 0 && pageCount <= SMALL_BOOK_AUTO_MAX) {
    return unfixedPages.filter((p) => !alreadySent.has(p)).slice(0, AUTO_LIMIT);
  }
  return [];
}

type ParseRun = { kind: "running"; done: number; total: number } | ({ kind: "done" } & ExternalOutcome) | { kind: "error"; message: string };

const VIA = {
  external: { who: "外部解析服务", running: "正在重新读取", en: "the external parser", check: "" },
  vision: { who: "看图模型", running: "正在识别页面图片", en: "the vision model", check: "，读出的公式和数字请对照原书核对" },
} as const;

function ParseStatus({ run, via, next }: { run: ParseRun; via: keyof typeof VIA; next?: string | null }) {
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
  const read = new Set(run.saved.filter((p) => p.words > 0).map((p) => p.no)).size;
  const blank = new Set(run.saved.filter((p) => p.words === 0).map((p) => p.no)).size;
  const why = run.stopped ?? ("failure" in run && run.missed.length ? run.failure : null);
  return (
    <div className={`alert ${run.missed.length ? "warn" : "info"}`} data-testid={`${via}-done`} data-read={read} data-missed={run.missed.length}>
      {v.who}读好了 {read} 页{read > 0 && v.check}
      {blank > 0 && `；${blank} 页还是没有文字（可能是空白页或图片），要讲的话可以粘贴`}
      {run.missed.length > 0 && `；${run.missed.length} 页没读出来，选到这些页时可以粘贴文字补上`}
      {why && `（${why}）`}。· Re-read {read} page(s) with {v.en}
      {run.missed.length > 0 && `; ${run.missed.length} not read`}.
      {run.missed.length > 0 && next && (
        <div className="small" data-testid={`${via}-next`}>
          {next}
        </div>
      )}
    </div>
  );
}

const REUSED: Partial<Record<IngestOutcome, string>> = {
  ready: "这份 PDF 之前上传过，直接用了上次读好的文字，没有重新解析 · Already uploaded: reused without parsing again",
  resumed: "已按需补传所选页面 · Uploaded the missing pages",
  restored: "已恢复之前删除的这份教材 · Restored the PDF you deleted earlier",
};

interface ExtraPdfDraft {
  id: string;
  documentId: string;
  title: string;
  pageCount: number;
  role: PdfSourceRole;
  rangeText: string;
  ranges: PageRange[];
  words: number;
}

export function ChaptersStep({ documentId, lesson, reached }: { documentId: string; lesson?: LessonView; reached: StepKey }) {
  const nav = useNavigate();
  const locState = useLocation().state as { textbook?: IngestOutcome; initialRanges?: PageRange[] } | null;
  const reused = REUSED[locState?.textbook ?? "new"];
  const [doc, setDoc] = useState<DocumentRow | null>(null);
  const [tree, setTree] = useState<ChapterNode[]>([]);
  const [labels, setLabels] = useState<Map<number, string>>(new Map());
  const [pageWords, setPageWords] = useState<number[]>([]);
  const [pageChars, setPageChars] = useState<number[]>([]);
  const [pageParsers, setPageParsers] = useState<Record<number, string>>({});
  const [pageFlags, setPageFlags] = useState<Record<number, PageFlag[]>>({});
  const [pageKinds, setPageKinds] = useState<Record<number, PageKind>>({});
  const [importedRanges, setImportedRanges] = useState<PageRange[] | null>(null);
  const [external, setExternal] = useState<ExternalParserInfo | null>(null);
  const [extRun, setExtRun] = useState<ParseRun | null>(null);
  const [vision, setVision] = useState<VisionParserInfo | null>(null);
  const [visRun, setVisRun] = useState<ParseRun | null>(null);
  const [notes, setNotes] = useState<ReaderNotes>({ external: null, vision: null });
  const pickFor = useRef<((file: File) => void) | null>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const extraFilePicker = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState<PageRange | null>(null);
  const [preview, setPreview] = useState<{ start: string; end: string } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set(lesson?.lesson.scope.chapterIds ?? []));
  const [rangeText, setRangeText] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [targetMinutes, setTargetMinutes] = useState<number>(lesson?.lesson.params.minutes ?? 40);
  const [importingMissing, setImportingMissing] = useState(false);

  // Extra PDF sources state:
  const [allDocs, setAllDocs] = useState<DocumentRow[]>([]);
  const [extraSources, setExtraSources] = useState<ExtraPdfDraft[]>([]);
  const [addingExtra, setAddingExtra] = useState(false);
  const [extraDocId, setExtraDocId] = useState("");
  const [extraRole, setExtraRole] = useState<PdfSourceRole>("past_paper");
  const [extraRangeInput, setExtraRangeInput] = useState("");
  const [extraUploading, setExtraUploading] = useState(false);

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (lesson) setTargetMinutes(lesson.lesson.params.minutes);
  }, [lesson?.lesson.params.minutes]);

  useEffect(() => {
    documentApi
      .list()
      .then((r) => setAllDocs(r.documents.filter((d) => d.pagesReceived > 0)))
      .catch(() => undefined);
  }, [documentId]);

  // Hydrate existing secondary PDF sources when editing a lesson:
  useEffect(() => {
    if (!lesson) return;
    const pdfs = lessonSourcesOf(lesson).filter((s): s is PdfLessonSource => s.kind === "pdf");
    if (pdfs.length <= 1) {
      setExtraSources([]);
      return;
    }
    let alive = true;
    void Promise.all(
      pdfs.slice(1).map(async (s) => {
        try {
          const info = await documentApi.get(s.documentId);
          const lbl = new Map(Object.entries(info.pageLabels).map(([k, v]) => [Number(k), v]));
          const w = pagesInRanges(s.ranges).reduce((sum, no) => sum + (info.pageWords[no - 1] ?? 0), 0);
          return {
            id: s.id,
            documentId: s.documentId,
            title: s.title || info.document.title,
            pageCount: info.document.pageCount,
            role: s.role,
            rangeText: fmtRanges(s.ranges, lbl),
            ranges: s.ranges,
            words: w,
          } satisfies ExtraPdfDraft;
        } catch {
          return {
            id: s.id,
            documentId: s.documentId,
            title: s.title,
            pageCount: Math.max(1, ...s.ranges.map((r) => r.end)),
            role: s.role,
            rangeText: fmtRanges(s.ranges, new Map()),
            ranges: s.ranges,
            words: 0,
          } satisfies ExtraPdfDraft;
        }
      }),
    ).then((loaded) => alive && setExtraSources(loaded));
    return () => {
      alive = false;
    };
  }, [lesson?.lesson.id]);

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
        setImportedRanges(r.importedRanges ?? [{ start: 1, end: r.document.pageCount }]);
        setExternal(r.externalParser);
        setVision(r.visionParser);
        setNotes(r.readers);
        setCollapsed(new Set(r.chapters.filter((c) => c.level >= 2 && r.chapters.some((k) => k.parentId === c.id)).map((c) => c.id)));
        if (lesson && !lesson.lesson.scope.chapterIds.length) {
          setRangeText(fmtRanges(lesson.lesson.scope.ranges, map));
        } else if (!lesson && locState?.initialRanges?.length) {
          setRangeText(fmtRanges(locState.initialRanges, map));
        }
      })
      .catch((e) => setError((e as Error).message));
  }, [documentId, lesson]);

  const pageCount = doc?.pageCount ?? 0;
  const importedSet = useMemo(() => {
    if (!doc || !importedRanges) return undefined;
    if (doc.pagesReceived >= doc.pageCount) return undefined;
    return new Set(pagesInRanges(importedRanges));
  }, [doc, importedRanges]);

  const extra = useMemo(() => parseRanges(rangeText, pageCount || 1, labels), [rangeText, pageCount, labels]);
  const ranges = useMemo(() => normalizeRanges([...rangesForChapters(tree, [...picked], pageCount || 1), ...(extra ?? [])], pageCount || 1), [tree, picked, extra, pageCount]);
  const primaryPages = countPages(ranges);
  const extraPagesCount = extraSources.reduce((sum, s) => sum + countPages(s.ranges), 0);
  const pages = primaryPages + extraPagesCount;
  const selectedNos = useMemo(() => pagesInRanges(ranges), [ranges]);
  const stats = useMemo(() => selectionStats(selectedNos, pageWords, pageChars, importedSet), [selectedNos, pageWords, pageChars, importedSet]);
  const totalWords = stats.words + extraSources.reduce((sum, s) => sum + s.words, 0);
  const advice = scopeAdvice(totalWords, targetMinutes, stats.unread.length);
  const emptyRuns = runsOf(stats.empty);
  const missingRuns = runsOf(stats.missing);
  const pagesOf = (c: ChapterNode) => pagesInRanges([{ start: c.pageStart, end: c.pageEnd }]);

  const unfixed = (p: number) => (!importedSet || importedSet.has(p)) && isMustFix(pageKinds[p]) && (pageParsers[p] ?? PDFJS_PARSER) === PDFJS_PARSER;
  const bookLossy = MUST_FIX_KINDS.flatMap((kind) => {
    const count = Object.entries(pageKinds).filter(([no, k]) => k === kind && unfixed(Number(no))).length;
    return count ? [{ kind, count }] : [];
  });
  const lossyRuns = runsOf(selectedNos.filter((p) => unfixed(p) && !isEmptyPage(pageWords[p - 1] ?? 0)));
  const visionRuns = runsOf(selectedNos.filter((p) => (!importedSet || importedSet.has(p)) && isVisionParser(pageParsers[p]) && !isEmptyPage(pageWords[p - 1] ?? 0)));
  const reading = extRun?.kind === "running" || visRun?.kind === "running";
  const refinable = (c: ChapterNode) =>
    pagesOf(c).filter((p) => (!importedSet || importedSet.has(p)) && (unfixed(p) || (REFINE_KINDS.includes(pageKinds[p]!) && (pageParsers[p] ?? PDFJS_PARSER) === PDFJS_PARSER)));
  const unfixedPages = Object.keys(pageKinds)
    .map(Number)
    .filter(unfixed)
    .sort((a, b) => a - b);

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
        create: (pgs, ocr) => documentApi.parse(documentId, pgs, reason, ocr),
        upload: async (job, pdf) => void (await documentApi.parseUpload(documentId, job, pdf)),
        poll: (job) => documentApi.parsePoll(documentId, job),
        result: (job) => documentApi.parseResult(documentId, job),
        save: async (job, pgs) => (await documentApi.parseSave(documentId, job, pgs)).pages,
        cut: pdfCutter(file),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      (done, total) => setExtRun({ kind: "running", done, total }),
    );
    applyFacts(out.saved);
    setExtRun({ kind: "done", ...out });
    if (out.missed.length) await runVision(out.missed, reason, file);
  }

  async function runVision(nos: number[], reason: "auto" | "refine", file: Blob) {
    if (!vision || !nos.length) return;
    setVisRun({ kind: "running", done: 0, total: nos.length });
    const renderer = pageRenderer(file);
    try {
      const out = await readWithVision(
        nos,
        { render: (no) => renderer.render(no), read: (no, image) => documentApi.parseImage(documentId, no, image, reason) },
        (done, total) => setVisRun({ kind: "running", done, total }),
      );
      applyFacts(out.saved);
      setVisRun({ kind: "done", ...out });
    } finally {
      await renderer.close();
    }
  }

  function withFile(then: (file: Blob) => void, onMismatch?: (msg: string) => void) {
    const kept = rememberedFile(documentId);
    if (kept) return then(kept);
    pickFor.current = async (file) => {
      if (doc?.fileSha256 && (await sha256Hex(await file.arrayBuffer())) !== doc.fileSha256) {
        const msg = "选的不是这本教材的 PDF，请选上传时的同一个文件 · That is not the same PDF";
        if (onMismatch) return onMismatch(msg);
        if (external) return setExtRun({ kind: "error", message: msg });
        if (vision) return setVisRun({ kind: "error", message: msg });
        return setError(msg);
      }
      rememberFile(documentId, file);
      then(file);
    };
    filePicker.current?.click();
  }

  async function importMissingSelected(file: Blob) {
    if (!doc || !stats.missing.length) return;
    setImportingMissing(true);
    setError("");
    try {
      const buf = await file.arrayBuffer();
      const offset = rememberedPageOffset(documentId);
      const parsed = await parsePdf(buf, doc.title, { pageNumbers: stats.missing, ...(offset > 1 ? { pageOffset: offset } : {}) });
      const batchSize = 40;
      let latestReceived = doc.pagesReceived;
      for (let i = 0; i < parsed.pages.length; i += batchSize) {
        const res = await documentApi.putPages(documentId, parsed.pages.slice(i, i + batchSize));
        latestReceived = res.received;
      }
      try {
        const figs = await extractPdfFigures(buf, { pageNumbers: stats.missing.slice(0, 45), ...(offset > 1 ? { pageOffset: offset } : {}) });
        for (let i = 0; i < figs.length; i += 8) {
          await mediaApi.uploadBatch(
            documentId,
            figs.slice(i, i + 8).map(({ pageNo, label, caption, image }) => ({ pageNo, label, caption, image })),
          );
        }
      } catch {}
      setDoc((prev) => (prev ? { ...prev, pagesReceived: latestReceived } : prev));
      setImportedRanges((prev) =>
        normalizeRanges([...(prev ?? []), ...parsed.pages.map((p) => ({ start: p.no, end: p.no }))], doc.pageCount),
      );
      setPageWords((w) => {
        const next = [...w];
        for (const p of parsed.pages) next[p.no - 1] = pageFacts(p.text).words;
        return next;
      });
      setPageChars((ch) => {
        const next = [...ch];
        for (const p of parsed.pages) next[p.no - 1] = p.text.length;
        return next;
      });
      setPageKinds((ks) => {
        const next = { ...ks };
        for (const p of parsed.pages) if (p.kind && p.kind !== "text" && p.kind !== "blank") next[p.no] = p.kind;
        return next;
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setImportingMissing(false);
    }
  }

  // Strictly restrict auto-parsing to selectedPages ∩ unfixedPages on large books so daily quota is never burned on p.1..300.
  useEffect(() => {
    const file = rememberedFile(documentId);
    if ((!external && !vision) || !file || reading || !doc) return;
    let sentSet = autoSentByDoc.get(documentId);
    if (!sentSet) {
      sentSet = new Set<number>();
      autoSentByDoc.set(documentId, sentSet);
    }
    const targets = autoParseTargets({
      pageCount: doc.pageCount,
      selectedPages: selectedNos,
      unfixedPages,
      alreadySent: sentSet,
    });
    if (!targets.length) return;
    for (const no of targets) sentSet.add(no);
    void (external ? runExternal(targets, "auto", file) : runVision(targets, "auto", file));
  }, [external, vision, documentId, doc?.pageCount, selectedNos.join(","), unfixedPages.length]);

  useEffect(() => {
    const first = extra?.[0]?.start;
    const last = extra?.[extra.length - 1]?.end;
    if (!first || !last || (importedSet && (!importedSet.has(first) || !importedSet.has(last)))) return setPreview(null);
    let live = true;
    const firstLine = (t: string) => t.split("\n").find((l) => l.trim().length > 3)?.slice(0, 80) ?? "";
    void Promise.all([documentApi.page(documentId, first), documentApi.page(documentId, last)])
      .then(([a, b]) => live && setPreview({ start: firstLine(a.text), end: firstLine(b.text) }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [extra, documentId, importedSet]);

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

  async function handleExtraPdfUpload(file: File) {
    const problem = fileProblem(file);
    if (problem) return setError(problem);
    setExtraUploading(true);
    setError("");
    try {
      const { id } = await ingestPdf(file, {
        hash: sha256Hex,
        lookup: documentApi.lookup,
        parse: (data, title, onProgress, opts) => parsePdf(data, title, { onProgress, ...opts }),
        create: documentApi.create,
        putPages: documentApi.putPages,
        restore: documentApi.restore,
        confirmRestore: () => true,
        extractFigures: (data, opts) => extractPdfFigures(data, opts),
        putFigures: (docId, items) => mediaApi.uploadBatch(docId, items),
      });
      rememberFile(id, file);
      const list = (await documentApi.list()).documents.filter((d) => d.pagesReceived > 0);
      setAllDocs(list);
      setExtraDocId(id);
      const createdDoc = list.find((d) => d.id === id);
      if (createdDoc) setExtraRangeInput(`1-${Math.min(10, createdDoc.pageCount)}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setExtraUploading(false);
    }
  }

  async function confirmAddExtraPdf() {
    if (!extraDocId) return setError("请选择一份补充 PDF · Choose a PDF to attach");
    setError("");
    try {
      const info = await documentApi.get(extraDocId);
      const lbl = new Map(Object.entries(info.pageLabels).map(([k, v]) => [Number(k), v]));
      const parsed = parseRanges(extraRangeInput, info.document.pageCount, lbl);
      if (!parsed || !parsed.length) {
        return setError(`请输入有效的页码范围（1–${info.document.pageCount}），例如 1-6 · Enter a valid page range`);
      }
      const w = pagesInRanges(parsed).reduce((sum, no) => sum + (info.pageWords[no - 1] ?? 0), 0);
      setExtraSources((prev) => [
        ...prev,
        {
          id: `src_${Date.now().toString(36)}_${prev.length + 1}`,
          documentId: extraDocId,
          title: info.document.title,
          pageCount: info.document.pageCount,
          role: extraRole,
          rangeText: fmtRanges(parsed, lbl),
          ranges: parsed,
          words: w,
        },
      ]);
      setAddingExtra(false);
      setExtraDocId("");
      setExtraRangeInput("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  const visible = tree.filter((c) => {
    let p = c.parentId;
    while (p) {
      if (collapsed.has(p)) return false;
      p = tree.find((x) => x.id === p)?.parentId ?? null;
    }
    return true;
  });

  const thin = pages > 0 && stats.missing.length === 0 && stats.unread.length === 0 && advice.estimatedMinutes < targetMinutes * 0.3;
  const [thinAck, setThinAck] = useState(false);

  async function next() {
    if (extra === null) return setError("页码格式不对，例如 3-8, 12 · Page ranges look wrong, e.g. 3-8, 12");
    if (!primaryPages) return setError("请至少在主教材中选择一个章节或输入页码 · Choose at least one chapter or page range");
    if (stats.missing.length > 0) {
      return setError("所选范围包含尚未导入的页，请先点击上方“从原 PDF 补传所选页” · Import the selected missing pages first");
    }
    if (thin && !thinAck) return setThinAck(true);
    setBusy(true);
    setError("");
    try {
      const chapterIds = [...picked];
      const baseParams = lesson?.lesson.params ?? DEFAULT_PARAMS;
      const nextParams = { ...baseParams, minutes: targetMinutes };
      const existingNonPdf = lesson ? lessonSourcesOf(lesson).filter((s) => s.kind !== "pdf") : [];
      const hasMultiSources = extraSources.length > 0 || existingNonPdf.length > 0 || (lesson ? lessonSourcesOf(lesson).length > 0 : false);
      const sourcesPayload: LessonSource[] | undefined = hasMultiSources
        ? [
            {
              id: "src_primary",
              kind: "pdf",
              documentId,
              title: doc?.title || "主教材",
              ...(chapterIds.length ? { chapterIds } : {}),
              ranges,
              role: "textbook",
            },
            ...extraSources.map(
              (s): PdfLessonSource => ({
                id: s.id,
                kind: "pdf",
                documentId: s.documentId,
                title: s.title,
                ranges: s.ranges,
                role: s.role,
              }),
            ),
            ...existingNonPdf,
          ]
        : undefined;

      // Ensure composite 2x figures exist for selected pages when the PDF is still in this tab (e.g. teacher initially imported full book > 45 pages, then picked Ch 16):
      const memFile = rememberedFile(documentId);
      if (memFile && selectedNos.length > 0 && selectedNos.length <= 45) {
        try {
          const existingMedia = await mediaApi.listForDocument(documentId, selectedNos);
          if (existingMedia.assets.length === 0) {
            const offset = rememberedPageOffset(documentId);
            const figs = await extractPdfFigures(await memFile.arrayBuffer(), {
              pageNumbers: selectedNos,
              ...(offset > 1 ? { pageOffset: offset } : {}),
            });
            for (let i = 0; i < figs.length; i += 8) {
              await mediaApi.uploadBatch(
                documentId,
                figs.slice(i, i + 8).map(({ pageNo, label, caption, image }) => ({ pageNo, label, caption, image })),
              );
            }
          }
        } catch {}
      }

      const view = lesson
        ? await multisourceLessonApi.patch<LessonView>(lesson.lesson.id, {
            chapterIds,
            ranges: extra,
            params: nextParams,
            ...(sourcesPayload ? { sources: sourcesPayload } : {}),
          })
        : await multisourceLessonApi.create<LessonView>({
            documentId,
            chapterIds,
            ranges: extra,
            params: nextParams,
            ...(sourcesPayload ? { sources: sourcesPayload } : {}),
          });
      nav(`/lessons/${view.lesson.id}/settings`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  }

  const [unitPlan, setUnitPlan] = useState<{ count?: number; preview: UnitPreview } | null>(null);
  const selection = JSON.stringify([[...picked].sort(), extra, targetMinutes, extraSources.map((s) => [s.documentId, s.ranges])]);
  useEffect(() => {
    setUnitPlan(null);
    setThinAck(false);
  }, [selection]);
  const unitRequest = (count?: number) => ({
    documentId,
    chapterIds: [...picked],
    ranges: extra ?? [],
    count,
    lessonId: lesson?.lesson.id,
    params: { ...(lesson?.lesson.params ?? DEFAULT_PARAMS), minutes: targetMinutes },
  });
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

  const candidateExtraDocs = allDocs.filter((d) => d.id !== documentId);

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
          <div className="row between wrap">
            <div>
              <h2>📘 {doc.title}</h2>
              <p className="muted small">
                {doc.pagesReceived < doc.pageCount ? `已导入 ${doc.pagesReceived} / ${doc.pageCount} 页 · ` : `共 ${doc.pageCount} 页 · `}
                {tree.length ? `${tree.length} 个书签章节 bookmarks` : "这个 PDF 没有书签目录，请直接输入页码 · No bookmarks: enter page ranges"}
              </p>
            </div>
            <div className="selection-pill" data-testid="selection">
              已选 <b>{pages}</b> 页 pages{" "}
              {ranges.length > 0 && (
                <span className="muted small">
                  （主教材 p. {fmtRanges(ranges, labels)}
                  {extraSources.length > 0 ? ` ＋ ${extraSources.length} 份补充 PDF` : ""}）
                </span>
              )}
              {pages > 0 && (
                <div className="muted small" data-testid="scope-estimate">
                  按字数估计约需 {advice.estimatedMinutes} 分钟 · about {advice.estimatedMinutes} min to teach
                </div>
              )}
            </div>
          </div>

          <div className="row wrap" data-testid="chapters-minutes" style={{ marginBottom: 10 }}>
            <span className="muted small">目标课时 Duration:</span>
            {DURATION_CHOICES.map((m) => (
              <button
                key={m}
                type="button"
                className={`btn small ${targetMinutes === m ? "primary" : "ghost"}`}
                data-testid={`chapters-minutes-${m}`}
                onClick={() => setTargetMinutes(m)}
              >
                {m} 分钟
              </button>
            ))}
          </div>

          {bookLossy.length > 0 && (
            <div className="alert info" data-testid="must-fix-summary" data-count={bookLossy.reduce((n, k) => n + k.count, 0)}>
              这本书已导入部分有 {bookLossy.reduce((n, k) => n + k.count, 0)} 页可能没读全：{bookLossy.map((k) => `${LOSSY[k.kind]} ${k.count} 页`).join(" · ")}。浏览器只能读出文字层，扫描图和画成图形的公式读不到。
              {external ? (
                !reading && (
                  <span>
                    {" "}
                    可以用外部解析服务重新读这些页（只发送所选页），或选到这些页时粘贴文字补上。
                    <button
                      className="btn small"
                      onClick={() => {
                        const target = selectedNos.length ? selectedNos.filter(unfixed) : unfixedPages;
                        withFile((f) => void runExternal((target.length ? target : unfixedPages).slice(0, AUTO_LIMIT), "auto", f));
                      }}
                      data-testid="external-run"
                    >
                      用外部解析服务读这 {Math.min(AUTO_LIMIT, (selectedNos.length ? selectedNos.filter(unfixed) : unfixedPages).length || unfixedPages.length)} 页
                    </button>
                  </span>
                )
              ) : vision ? (
                <>
                  <span data-testid="external-off"> {notes.external ?? "外部解析服务没有开启。"}</span>
                  {!reading && (
                    <span>
                      可以用看图模型（{vision.model}）识别这些页的图片（读出的数字要核对），或选到这些页时粘贴文字补上。
                      <button
                        className="btn small"
                        onClick={() => {
                          const target = selectedNos.length ? selectedNos.filter(unfixed) : unfixedPages;
                          withFile((f) => void runVision((target.length ? target : unfixedPages).slice(0, AUTO_LIMIT), "auto", f));
                        }}
                        data-testid="vision-run"
                      >
                        用看图模型读这 {Math.min(AUTO_LIMIT, (selectedNos.length ? selectedNos.filter(unfixed) : unfixedPages).length || unfixedPages.length)} 页
                      </button>
                    </span>
                  )}
                </>
              ) : (
                <>
                  {" "}
                  选到这些页时可以粘贴文字补上。
                  <span className="reader-notes">
                    <span className="block" data-testid="external-off">
                      {notes.external ?? "外部解析服务没有开启。"}
                    </span>
                    <span className="block" data-testid="vision-off">
                      {notes.vision ?? "没有可用的看图模型。"}
                    </span>
                  </span>
                </>
              )}{" "}
              · Some pages were not fully read (scans, formulas drawn as outlines)
              {external ? ": re-read them with the external parser, or paste their text." : vision ? ": read their images with the vision model, or paste their text." : "; paste their text where you need it."}
            </div>
          )}
          {extRun && <ParseStatus run={extRun} via="external" next={vision ? null : notes.vision} />}
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
            <VolumeMeter estimated={advice.estimatedMinutes} lessonMinutes={targetMinutes} dropped={stats.unread.length > 0} />
          )}

          {stats.missing.length > 0 && (
            <div className="alert warn row between wrap" data-testid="missing-pages-alert">
              <span>
                第 {fmtRanges(missingRuns, labels)} 页（共 {stats.missing.length} 页）尚未从原 PDF 导入。点击右侧按钮即可按需解析补传这几页。·{" "}
                {stats.missing.length} selected page(s) have not been imported yet.
              </span>
              <button
                type="button"
                className="btn small primary"
                disabled={importingMissing}
                data-testid="import-missing-pages"
                onClick={() => withFile((f) => void importMissingSelected(f), setError)}
              >
                {importingMissing ? "正在补传… Importing" : `从原 PDF 补传这 ${stats.missing.length} 页`}
              </button>
            </div>
          )}

          {pages > 0 && stats.empty.length > 0 && (
            <div className="alert warn" data-testid="empty-pages">
              {stats.empty.length === primaryPages && extraPagesCount === 0 ? (
                <>所选的页都没有可读的文字（可能是扫描图），没法据此起草大纲。请把这些页的文字粘贴进来，或换别的章节。</>
              ) : (
                <>第 {fmtRanges(emptyRuns, labels)} 页没有可读的文字（可能是扫描图），起草大纲时会跳过这些页。如果这些页要讲，请把文字粘贴进来。</>
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
                    内容偏多：按 {targetMinutes} 分钟一节，大约需要 {advice.lessons} 节课。可以整单元规划成 {advice.lessons} 节课（按章节切分，每节课单独确认大纲），或只选前面几节；放不下的内容会列在大纲顶部的“未覆盖”里。· About {advice.lessons} lessons of{" "}
                    {targetMinutes} min: consider splitting the selection.
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
                      <ChapterBadges chapter={c} pageWords={pageWords} pageParsers={pageParsers} pageKinds={pageKinds} pageFlags={pageFlags} labels={labels} importedSet={importedSet} />
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

      {/* Multi-PDF attachment panel */}
      <div className="card" data-testid="extra-sources-panel">
        <div className="row between wrap">
          <div>
            <h3>📎 补充备课 PDF（真题卷 / 练习册 / 第二教材，可选）</h3>
            <p className="muted small">可同时关联多份 PDF 的指定页段，大纲和练习页会自动融合并按虚拟页码精确标注来源 · Attach past papers or workbooks</p>
          </div>
          {!addingExtra && (
            <button type="button" className="btn small" onClick={() => setAddingExtra(true)} data-testid="add-extra-pdf">
              ＋ 添加补充 PDF Add PDF
            </button>
          )}
        </div>

        {extraSources.length > 0 && (
          <ul className="doc-list" style={{ marginTop: 10 }}>
            {extraSources.map((src, idx) => (
              <li key={src.id} className="doc-item" data-testid="extra-source-item">
                <span>
                  <span className="badge">{ROLE_LABELS[src.role]}</span> <b>{src.title}</b>{" "}
                  <span className="muted small">p. {src.rangeText}</span>
                </span>
                <button
                  type="button"
                  className="btn small ghost danger-text"
                  data-testid={`remove-extra-pdf-${idx}`}
                  onClick={() => setExtraSources((prev) => prev.filter((x) => x.id !== src.id))}
                >
                  移除 ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        {addingExtra && (
          <div className="form-grid" style={{ marginTop: 12 }}>
            <label className="span2">
              选择已上传 PDF（或上传新文件）· PDF document
              <div className="row">
                <select
                  value={extraDocId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setExtraDocId(id);
                    const pickedDoc = candidateExtraDocs.find((d) => d.id === id);
                    if (pickedDoc && !extraRangeInput) setExtraRangeInput(`1-${Math.min(10, pickedDoc.pageCount)}`);
                  }}
                  data-testid="extra-pdf-select"
                  style={{ flex: 1 }}
                >
                  <option value="">— 选择 PDF —</option>
                  {candidateExtraDocs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}（{d.pageCount} 页）
                    </option>
                  ))}
                </select>
                <input
                  ref={extraFilePicker}
                  type="file"
                  accept="application/pdf,.pdf"
                  hidden
                  data-testid="extra-pdf-file-input"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleExtraPdfUpload(f);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="btn small"
                  disabled={extraUploading}
                  onClick={() => extraFilePicker.current?.click()}
                  data-testid="extra-pdf-upload-btn"
                >
                  {extraUploading ? "上传中…" : "上传新 PDF"}
                </button>
              </div>
            </label>
            <label>
              用途 Role
              <select value={extraRole} onChange={(e) => setExtraRole(e.target.value as PdfSourceRole)} data-testid="extra-pdf-role">
                <option value="past_paper">真题卷 Past paper</option>
                <option value="workbook">练习册 Workbook</option>
                <option value="textbook">补充教材 Textbook</option>
              </select>
            </label>
            <label>
              选用页码 Page ranges
              <input
                value={extraRangeInput}
                onChange={(e) => setExtraRangeInput(e.target.value)}
                placeholder="例如 1-6"
                data-testid="extra-pdf-ranges"
              />
            </label>
            <div className="form-actions" style={{ gap: 8 }}>
              <button type="button" className="btn small ghost" onClick={() => setAddingExtra(false)}>
                取消 Cancel
              </button>
              <button
                type="button"
                className="btn small primary"
                disabled={!extraDocId || !extraRangeInput.trim() || extraUploading}
                onClick={() => void confirmAddExtraPdf()}
                data-testid="confirm-extra-pdf"
              >
                关联这份 PDF Attach
              </button>
            </div>
          </div>
        )}
      </div>

      {error && <div className="alert error">{error}</div>}
      {thin && thinAck && (
        <div className="alert warn" role="alert" data-testid="thin-warning">
          只选了约 {advice.estimatedMinutes} 分钟的内容，一节课是 {targetMinutes} 分钟：大纲会用很多练习和讨论来填满。可以再勾选几节，或者确定就这么多。· About {advice.estimatedMinutes} of {targetMinutes} min — add more, or continue anyway.
        </div>
      )}
      <div className="wizard-actions">
        <button className="btn ghost" onClick={() => nav(lesson ? "/" : "/new")}>
          ← 返回 Back
        </button>
        <button className="btn primary" disabled={busy || !primaryPages} onClick={next} data-testid="chapters-next">
          {thin && thinAck ? "仍然继续 Continue anyway →" : "下一步：课时设置 Next →"}
        </button>
      </div>
    </div>
  );
}
