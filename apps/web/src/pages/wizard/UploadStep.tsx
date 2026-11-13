import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { buildChapterTree, normalizeRanges, pageForLabel, pagesInRanges, shiftToc } from "@kj/textbook";
import type { PageRange, PdfInspection } from "@kj/schema";
import { ApiError } from "../../api.ts";
import { documentApi, type DocumentRow } from "../../textbook/api.ts";
import { rememberFile } from "../../textbook/external.ts";
import { fileProblem, ingestPdf, MAX_MB, sha256Hex } from "../../textbook/ingest.ts";
import { inspectPdf, parsePdf } from "../../textbook/pdf.ts";
import { Stepper, StepIntro } from "./Stepper.tsx";

export const LARGE_PDF_THRESHOLD = 120;

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "parsing"; done: number; total: number }
  | { kind: "uploading"; done: number; total: number }
  | { kind: "error"; message: string };

interface PreflightState {
  file: File;
  info: PdfInspection;
}

function parsePreflightRanges(text: string, pageCount: number, labels: Map<number, string>): PageRange[] | null {
  const parts = text.split(/[,，;；\s]+/).filter(Boolean);
  if (!parts.length) return [];
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

export function UploadStep() {
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [drag, setDrag] = useState(false);
  const [partialMode, setPartialMode] = useState(false);
  const [preflight, setPreflight] = useState<PreflightState | null>(null);
  const [rangeInput, setRangeInput] = useState("");
  const [offsetInput, setOffsetInput] = useState("1");
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [deleted, setDeleted] = useState<{ doc: DocumentRow; lessons: number } | null>(null);
  const [docError, setDocError] = useState("");

  const loadDocs = () =>
    documentApi
      .list()
      .then((r) => setDocs(r.documents.filter((d) => d.pagesReceived > 0)))
      .catch(() => undefined);
  useEffect(() => {
    void loadDocs();
  }, []);

  async function removeDoc(d: DocumentRow) {
    if (!window.confirm(`删除教材“${d.title}”？用它做好的课不受影响，可以撤销。· Delete this PDF? Existing lessons keep working.`)) return;
    setDocError("");
    try {
      const r = await documentApi.archive(d.id);
      setDeleted({ doc: d, lessons: r.lessons });
      setDocs((list) => list.filter((x) => x.id !== d.id));
    } catch (e) {
      setDocError((e as Error).message);
    }
  }

  async function undoDoc() {
    if (!deleted) return;
    try {
      await documentApi.restore(deleted.doc.id);
      setDeleted(null);
      await loadDocs();
    } catch (e) {
      setDocError((e as Error).message);
    }
  }

  async function runIngest(
    file: File,
    opts?: { pageNumbers?: number[]; pageOffset?: number; fullToc?: PdfInspection["toc"]; initialRanges?: PageRange[] },
  ) {
    try {
      const { id, outcome } = await ingestPdf(
        file,
        {
          hash: sha256Hex,
          lookup: documentApi.lookup,
          parse: (data, title, onProgress, parseOpts) =>
            parsePdf(data, title, {
              onProgress,
              ...(parseOpts?.pageNumbers ? { pageNumbers: parseOpts.pageNumbers } : {}),
              ...(parseOpts?.pageOffset ? { pageOffset: parseOpts.pageOffset } : {}),
            }),
          create: documentApi.create,
          putPages: documentApi.putPages,
          restore: documentApi.restore,
          confirmRestore: (d) =>
            window.confirm(
              `这份 PDF 之前上传过（“${d.title}”），后来删除了。恢复它？选“取消”会重新上传一份。· You deleted this PDF earlier. Restore it? Cancel uploads it again.`,
            ),
        },
        setPhase,
        {
          ...(opts?.pageNumbers ? { pageNumbers: opts.pageNumbers } : {}),
          ...(opts?.pageOffset && opts.pageOffset > 1 ? { pageOffset: opts.pageOffset } : {}),
          ...(opts?.fullToc ? { fullToc: opts.fullToc } : {}),
        },
      );
      if (!opts?.pageOffset || opts.pageOffset <= 1) rememberFile(id, file);
      setPreflight(null);
      nav(`/new/${id}`, {
        state: {
          textbook: outcome,
          ...(opts?.initialRanges?.length ? { initialRanges: opts.initialRanges } : {}),
        },
      });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof ApiError ? err.message : `无法读取这个 PDF · Could not read this PDF (${(err as Error).message})`,
      });
    }
  }

  async function handle(file: File) {
    const problem = fileProblem(file);
    if (problem) return setPhase({ kind: "error", message: problem });
    setPhase({ kind: "checking" });
    try {
      const buf = await file.arrayBuffer();
      const info = await inspectPdf(buf, file.name.replace(/\.pdf$/i, ""));
      if (info.pageCount > LARGE_PDF_THRESHOLD || partialMode) {
        setPreflight({ file, info });
        setOffsetInput("1");
        const topChapters = buildChapterTree(info.toc, info.pageCount).filter((c) => c.level === 1);
        if (topChapters[0] && info.pageCount > LARGE_PDF_THRESHOLD) {
          setRangeInput(`${topChapters[0].pageStart}-${topChapters[0].pageEnd}`);
        } else {
          setRangeInput(`1-${Math.min(40, info.pageCount)}`);
        }
        setPhase({ kind: "idle" });
        return;
      }
      await runIngest(file);
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof ApiError ? err.message : `无法读取这个 PDF · Could not read this PDF (${(err as Error).message})`,
      });
    }
  }

  const pageOffset = useMemo(() => {
    const n = Number(offsetInput.trim());
    return Number.isInteger(n) && n >= 1 && n <= 2500 ? n : 1;
  }, [offsetInput]);

  const effectivePreflight = useMemo(() => {
    if (!preflight) return null;
    const shift = pageOffset - 1;
    const pageCount = preflight.info.pageCount + shift;
    const toc = shiftToc(preflight.info.toc, shift);
    const tree = buildChapterTree(toc, pageCount);
    const labels = new Map<number, string>();
    for (const [k, v] of Object.entries(preflight.info.pageLabels)) {
      const shiftedNo = Number(k) + shift;
      if (Number.isInteger(shiftedNo) && shiftedNo >= 1) labels.set(shiftedNo, v);
    }
    const parsedRanges = parsePreflightRanges(rangeInput, pageCount, labels);
    return { pageCount, toc, tree, labels, parsedRanges };
  }, [preflight, pageOffset, rangeInput]);

  function handleOffsetChange(raw: string) {
    setOffsetInput(raw);
    if (!preflight) return;
    const nextOffset = Number(raw.trim());
    if (Number.isInteger(nextOffset) && nextOffset >= 1 && nextOffset <= 2500) {
      const start = nextOffset;
      const end = nextOffset + preflight.info.pageCount - 1;
      if (!preflight.info.toc.length) {
        setRangeInput(start === end ? `${start}` : `${start}-${end}`);
      }
    }
  }

  const busy = phase.kind === "checking" || phase.kind === "parsing" || phase.kind === "uploading";
  const pct = phase.kind === "parsing" || phase.kind === "uploading" ? Math.round((phase.done / Math.max(1, phase.total)) * 100) : 0;

  return (
    <div className="wizard">
      <Stepper current="upload" reached="upload" />
      <StepIntro step="upload" />
      <div className="row between wrap">
        <label className="row small muted" style={{ flexDirection: "row", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={partialMode}
            onChange={(e) => setPartialMode(e.target.checked)}
            data-testid="partial-mode-toggle"
          />
          <span>按章节/页码区间局部导入，或校准已裁切 PDF 的起始原书页码 · Partial range import / page offset</span>
        </label>
      </div>
      <div
        className={`dropzone card ${drag ? "drag" : ""} ${busy ? "busy" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files[0];
          if (f && !busy) void handle(f);
        }}
        onClick={() => !busy && input.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="上传 PDF Upload PDF"
      >
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          data-testid="pdf-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handle(f);
            e.target.value = "";
          }}
        />
        <div className="dropzone-icon">📄</div>
        {busy ? (
          <>
            <b data-testid="ingest-phase" data-phase={phase.kind}>
              {phase.kind === "checking"
                ? "正在预检 PDF 目录与页数… Inspecting PDF"
                : phase.kind === "parsing"
                  ? `正在读取第 ${phase.done} / ${phase.total} 页… Reading pages`
                  : `正在上传文字 ${phase.done} / ${phase.total} 页… Uploading text`}
            </b>
            <div className="progress">
              <div style={{ width: `${pct}%` }} />
            </div>
            <span className="muted small">PDF 在你的浏览器里解析，只上传文字，不上传文件本身 · Parsed in your browser; only the text is uploaded</span>
          </>
        ) : (
          <>
            <b>把 PDF 拖到这里，或点击选择文件</b>
            <span className="muted">Drop a PDF here or click to choose · 电子版教材（支持千页整书与按页段极速导入），最大 {MAX_MB} MB</span>
          </>
        )}
      </div>

      {preflight && effectivePreflight && !busy && (
        <div className="card stack" data-testid="pdf-preflight">
          <div className="row between wrap">
            <div>
              <h2>📘 {preflight.info.title}</h2>
              <p className="muted small">
                物理页数 {preflight.info.pageCount} 页
                {pageOffset > 1 ? ` · 校准后页码 p.${pageOffset}–${effectivePreflight.pageCount}` : ""} ·{" "}
                {effectivePreflight.tree.length > 0
                  ? `${effectivePreflight.tree.length} 个目录书签（已完成秒级预检）`
                  : "无书签目录（可直接输入页码区间或起始原书页码）"}
              </p>
            </div>
            <button type="button" className="btn small ghost" onClick={() => setPreflight(null)}>
              换一份 PDF Cancel
            </button>
          </div>

          {effectivePreflight.tree.length > 0 && (
            <div>
              <p className="small muted" style={{ margin: "0 0 8px" }}>
                点选章节快速填入页码区间 · Pick a chapter to fill its page range:
              </p>
              <div className="row wrap" data-testid="preflight-chapters" style={{ maxHeight: 180, overflowY: "auto" }}>
                {effectivePreflight.tree
                  .filter((c) => c.level <= 3)
                  .slice(0, 60)
                  .map((c) => {
                    const span = c.pageStart === c.pageEnd ? `${c.pageStart}` : `${c.pageStart}-${c.pageEnd}`;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className={`btn small ${rangeInput.trim() === span ? "primary" : ""}`}
                        onClick={() => setRangeInput(span)}
                        data-testid={`preflight-chapter-${c.id}`}
                      >
                        {c.title} <span className="muted small">p.{span}</span>
                      </button>
                    );
                  })}
              </div>
            </div>
          )}

          <div className="form-grid">
            <label className="span2">
              要导入的页码区间（保留原书真实页码与目录）· Page range to import
              <input
                value={rangeInput}
                onChange={(e) => setRangeInput(e.target.value)}
                placeholder="例如 e.g. 693-726"
                data-testid="preflight-ranges"
              />
            </label>
            <label className="span2">
              起始原书页码（可选：用于已裁切小 PDF，如第 1 页对应原书 p.693）· Starting page number
              <input
                type="number"
                min={1}
                max={2500}
                value={offsetInput}
                onChange={(e) => handleOffsetChange(e.target.value)}
                data-testid="preflight-page-offset"
              />
            </label>
          </div>

          {effectivePreflight.parsedRanges === null && (
            <div className="alert error">页码区间格式有误，或超出了文档页码范围（1–{effectivePreflight.pageCount}）· Invalid page range</div>
          )}

          <div className="row wrap end">
            <button
              type="button"
              className="btn ghost"
              disabled={effectivePreflight.pageCount > 2500}
              data-testid="import-full-btn"
              onClick={() =>
                void runIngest(preflight.file, {
                  ...(pageOffset > 1 ? { pageOffset } : {}),
                  fullToc: effectivePreflight.toc,
                })
              }
            >
              导入整本书（共 {preflight.info.pageCount} 页）Import full PDF
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!effectivePreflight.parsedRanges || effectivePreflight.parsedRanges.length === 0 || effectivePreflight.pageCount > 2500}
              data-testid="import-range-btn"
              onClick={() => {
                if (!effectivePreflight.parsedRanges?.length) return;
                const pageNumbers = pagesInRanges(effectivePreflight.parsedRanges);
                void runIngest(preflight.file, {
                  pageNumbers,
                  ...(pageOffset > 1 ? { pageOffset } : {}),
                  fullToc: effectivePreflight.toc,
                  initialRanges: effectivePreflight.parsedRanges,
                });
              }}
            >
              仅极速导入所选页段（{effectivePreflight.parsedRanges ? pagesInRanges(effectivePreflight.parsedRanges).length : 0} 页）Import selected range →
            </button>
          </div>
        </div>
      )}

      {phase.kind === "error" && (
        <div className="alert error" role="alert">
          {phase.message}
        </div>
      )}
      {deleted && (
        <div className="alert info row between" data-testid="doc-deleted-note">
          <span>
            已删除教材“{deleted.doc.title}”{deleted.lessons > 0 ? `，用它做的 ${deleted.lessons} 节课照常可用` : ""}。· PDF deleted
            {deleted.lessons > 0 ? `; ${deleted.lessons} lesson(s) made from it still work` : ""}.
          </span>
          <button className="btn small" onClick={undoDoc} data-testid="undo-doc-delete">
            撤销 Undo
          </button>
        </div>
      )}
      {docError && <div className="alert error">{docError}</div>}
      {docs.length > 0 && (
        <div className="card">
          <div className="row between">
            <h2>或使用之前上传的教材 · Or reuse a PDF</h2>
            <Link to="/textbooks" className="small" data-testid="manage-textbooks">
              管理教材 →
            </Link>
          </div>
          <ul className="doc-list">
            {docs.map((d) => (
              <li key={d.id} className="doc-item">
                <button className="btn ghost" onClick={() => nav(`/new/${d.id}`)}>
                  📘 {d.title}{" "}
                  <span className="muted small">
                    {d.pagesReceived < d.pageCount ? `已导入 ${d.pagesReceived} / ${d.pageCount} 页` : `${d.pageCount} 页 pages`}
                  </span>
                </button>
                <button
                  className="btn small ghost danger-text"
                  onClick={() => void removeDoc(d)}
                  data-testid={`delete-doc-${d.id}`}
                  title="删除这份教材（可以撤销）· Delete this PDF (undo available)"
                  aria-label={`删除 ${d.title}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
