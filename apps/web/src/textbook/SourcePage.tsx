import { useEffect, useId, useRef, useState } from "react";
import { isVisionParser, MINERU_AGENT_PARSER, MINERU_PARSER, PASTE_PARSER, PDFJS_PARSER } from "@kj/textbook";
import type { PdfSourceRole } from "@kj/schema";
import { activeLessonPdfSources, ApiError } from "../api.ts";
import { documentApi, type TextbookPage } from "./api.ts";

const ORIGIN: Record<string, string> = {
  [PASTE_PARSER]: "这一页的文字由老师粘贴 · Text pasted by the teacher",
  [MINERU_AGENT_PARSER]: "浏览器读不全这一页，文字由外部解析服务（MinerU）重新识别 · Re-read by the external parser (MinerU)",
  [MINERU_PARSER]: "浏览器读不全这一页，文字由外部解析服务（MinerU）重新识别 · Re-read by the external parser (MinerU)",
};

const ROLE_BADGE: Record<PdfSourceRole, string> = {
  textbook: "教材",
  past_paper: "真题",
  workbook: "练习册",
};

export interface SourceDocOption {
  documentId: string;
  title: string;
  role?: PdfSourceRole;
}

/** A cited textbook page, opened from a slide's source chip, with multi-PDF document switcher when multiple PDFs are attached. */
export function SourcePage({
  page,
  sources,
  onClose,
}: {
  page: TextbookPage;
  sources?: SourceDocOption[];
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const docOptions = sources && sources.length > 0 ? sources : activeLessonPdfSources(page.documentId);
  const [currentPage, setCurrentPage] = useState<TextbookPage>(page);
  const [activeDocId, setActiveDocId] = useState<string>(page.documentId ?? docOptions[0]?.documentId ?? "");
  const [switchError, setSwitchError] = useState("");
  const [loadingDoc, setLoadingDoc] = useState(false);

  useEffect(() => {
    setCurrentPage(page);
    setActiveDocId(page.documentId ?? docOptions[0]?.documentId ?? "");
    setSwitchError("");
  }, [page]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && cardRef.current) {
        const focusable = [...cardRef.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')];
        if (!focusable.length) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      prevFocus?.focus?.();
    };
  }, []);

  async function switchDoc(doc: SourceDocOption) {
    if (doc.documentId === activeDocId && !switchError) return;
    setActiveDocId(doc.documentId);
    setSwitchError("");
    setLoadingDoc(true);
    try {
      const next = await documentApi.page(doc.documentId, currentPage.no, { exactDocument: true });
      setCurrentPage({ ...next, documentId: doc.documentId, documentTitle: doc.title });
    } catch (err) {
      const notFound = err instanceof ApiError && err.status === 404;
      setSwitchError(
        notFound
          ? `“${doc.title}”中没有第 ${currentPage.no} 页（或尚未导入该页）· Page ${currentPage.no} is not in "${doc.title}"`
          : (err as Error).message,
      );
    } finally {
      setLoadingDoc(false);
    }
  }

  const origin =
    currentPage.parser === PDFJS_PARSER
      ? null
      : isVisionParser(currentPage.parser)
        ? "浏览器读不全这一页，文字由看图模型从页面图片识别，公式和数字请对照原书核对 · Read from the page image by a vision model: check the numbers"
        : (ORIGIN[currentPage.parser] ?? `文字来源 Text from: ${currentPage.parser}`);

  const activeDocTitle = currentPage.documentTitle ?? docOptions.find((d) => d.documentId === activeDocId)?.title;

  return (
    <div className="modal" onClick={onClose}>
      <div
        ref={cardRef}
        className="modal-card card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row between">
          <h2 id={titleId}>
            {activeDocTitle ? `${activeDocTitle} · ` : "教材"}第 {currentPage.label ?? currentPage.no} 页 · Source page
          </h2>
          <button ref={closeRef} type="button" className="btn small ghost" onClick={onClose}>
            关闭 Close
          </button>
        </div>
        {docOptions.length > 1 && (
          <div className="tabs" role="tablist" aria-label="切换来源文档 Switch source PDF" data-testid="source-doc-switcher" style={{ marginBottom: 10 }}>
            {docOptions.map((doc) => (
              <button
                key={doc.documentId}
                type="button"
                role="tab"
                aria-selected={doc.documentId === activeDocId}
                className={doc.documentId === activeDocId ? "active" : ""}
                disabled={loadingDoc}
                data-testid={`source-doc-tab-${doc.documentId}`}
                onClick={() => void switchDoc(doc)}
              >
                {doc.role ? `[${ROLE_BADGE[doc.role]}] ` : ""}
                {doc.title}
              </button>
            ))}
          </div>
        )}
        {switchError ? (
          <div className="alert warn" data-testid="source-doc-missing">
            {switchError}
          </div>
        ) : (
          <>
            {origin && (
              <p className="muted small" data-testid="source-origin">
                {origin}
              </p>
            )}
            <pre className="source-text">{currentPage.text}</pre>
          </>
        )}
      </div>
    </div>
  );
}
