import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError } from "../../api.ts";
import { documentApi, type DocumentRow } from "../../textbook/api.ts";
import { fileProblem, ingestPdf, MAX_MB } from "../../textbook/ingest.ts";
import { parsePdf } from "../../textbook/pdf.ts";
import { Stepper, StepIntro } from "./Stepper.tsx";

type Phase = { kind: "idle" } | { kind: "parsing"; done: number; total: number } | { kind: "uploading"; done: number; total: number } | { kind: "error"; message: string };

export function UploadStep() {
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [drag, setDrag] = useState(false);
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [deleted, setDeleted] = useState<{ doc: DocumentRow; lessons: number } | null>(null);
  const [docError, setDocError] = useState("");

  const loadDocs = () =>
    documentApi
      .list()
      .then((r) => setDocs(r.documents.filter((d) => d.pagesReceived === d.pageCount)))
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

  async function handle(file: File) {
    const problem = fileProblem(file);
    if (problem) return setPhase({ kind: "error", message: problem });
    try {
      const id = await ingestPdf(file, { parse: (data, title, onProgress) => parsePdf(data, title, { onProgress }), create: documentApi.create, putPages: documentApi.putPages }, setPhase);
      nav(`/new/${id}`);
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof ApiError ? err.message : `无法读取这个 PDF · Could not read this PDF (${(err as Error).message})` });
    }
  }

  const busy = phase.kind === "parsing" || phase.kind === "uploading";
  const pct = busy ? Math.round((phase.done / Math.max(1, phase.total)) * 100) : 0;

  return (
    <div className="wizard">
      <Stepper current="upload" reached="upload" />
      <StepIntro step="upload" />
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
            <b>{phase.kind === "parsing" ? `正在读取第 ${phase.done} / ${phase.total} 页… Reading pages` : `正在上传文字 ${phase.done} / ${phase.total} 页… Uploading text`}</b>
            <div className="progress">
              <div style={{ width: `${pct}%` }} />
            </div>
            <span className="muted small">PDF 在你的浏览器里解析，只上传文字，不上传文件本身 · Parsed in your browser; only the text is uploaded</span>
          </>
        ) : (
          <>
            <b>把 PDF 拖到这里，或点击选择文件</b>
            <span className="muted">Drop a PDF here or click to choose · 电子版教材，最大 {MAX_MB} MB</span>
          </>
        )}
      </div>
      {phase.kind === "error" && (
        <div className="alert error" role="alert">
          {phase.message}
        </div>
      )}
      {deleted && (
        <div className="alert info row between" data-testid="doc-deleted-note">
          <span>
            已删除教材“{deleted.doc.title}”{deleted.lessons > 0 ? `，用它做的 ${deleted.lessons} 节课照常可用` : ""}。· PDF deleted{deleted.lessons > 0 ? `; ${deleted.lessons} lesson(s) made from it still work` : ""}.
          </span>
          <button className="btn small" onClick={undoDoc} data-testid="undo-doc-delete">
            撤销 Undo
          </button>
        </div>
      )}
      {docError && <div className="alert error">{docError}</div>}
      {docs.length > 0 && (
        <div className="card">
          <h2>或使用之前上传的教材 · Or reuse a PDF</h2>
          <ul className="doc-list">
            {docs.map((d) => (
              <li key={d.id} className="doc-item">
                <button className="btn ghost" onClick={() => nav(`/new/${d.id}`)}>
                  📘 {d.title} <span className="muted small">{d.pageCount} 页 pages</span>
                </button>
                <button className="btn small ghost danger-text" onClick={() => void removeDoc(d)} data-testid={`delete-doc-${d.id}`} title="删除这份教材（可以撤销）· Delete this PDF (undo available)" aria-label={`删除 ${d.title}`}>
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
