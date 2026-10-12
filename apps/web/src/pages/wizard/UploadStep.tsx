import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { buildChapterTree } from "@kj/pdf-structure";
import { GlobalWorkerOptions, parsePdf } from "@kj/pdf-structure/browser";
import { api, ApiError } from "../../api.ts";
import { documentApi, type DocumentRow } from "../../lessonApi.ts";
import { Stepper, StepIntro } from "./Stepper.tsx";

GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_MB = 200;

type Phase = { kind: "idle" } | { kind: "parsing"; done: number; total: number } | { kind: "uploading"; done: number; total: number } | { kind: "error"; message: string };

export function UploadStep() {
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [drag, setDrag] = useState(false);
  const [docs, setDocs] = useState<DocumentRow[]>([]);

  useEffect(() => {
    documentApi
      .list()
      .then((r) => setDocs(r.documents.filter((d) => d.pagesReceived === d.pageCount)))
      .catch(() => undefined);
  }, []);

  async function handle(file: File) {
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return setPhase({ kind: "error", message: "请选择 PDF 文件 · Please choose a PDF file" });
    if (file.size > MAX_MB * 1024 * 1024) return setPhase({ kind: "error", message: `文件超过 ${MAX_MB} MB · File is larger than ${MAX_MB} MB` });
    try {
      setPhase({ kind: "parsing", done: 0, total: 1 });
      const parsed = await parsePdf(await file.arrayBuffer(), file.name.replace(/\.pdf$/i, ""), { onProgress: (done, total) => setPhase({ kind: "parsing", done, total }) });
      const chapters = buildChapterTree(parsed.toc, parsed.pageCount, parsed.pages);
      const { id, pageBatch } = await api<{ id: string; pageBatch: number }>("/api/documents", {
        body: { filename: file.name, title: parsed.title, sizeBytes: file.size, pageCount: parsed.pageCount, chapters },
      });
      for (let i = 0; i < parsed.pages.length; i += pageBatch) {
        setPhase({ kind: "uploading", done: i, total: parsed.pages.length });
        await api(`/api/documents/${id}/pages`, { body: { pages: parsed.pages.slice(i, i + pageBatch) } });
      }
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
      {docs.length > 0 && (
        <div className="card">
          <h2>或使用之前上传的教材 · Or reuse a PDF</h2>
          <ul className="doc-list">
            {docs.map((d) => (
              <li key={d.id}>
                <button className="btn ghost" onClick={() => nav(`/new/${d.id}`)}>
                  📘 {d.title} <span className="muted small">{d.pageCount} 页 pages</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
