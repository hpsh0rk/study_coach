import { PASTE_PARSER, PDFJS_PARSER } from "@kj/pdf-structure";
import type { TextbookPage } from "./api.ts";

const ORIGIN: Record<string, string> = {
  [PASTE_PARSER]: "这一页是扫描图，文字由老师粘贴 · Text pasted by the teacher (scanned page)",
};

/** A cited textbook page, opened from a slide's source chip. */
export function SourcePage({ page, onClose }: { page: TextbookPage; onClose: () => void }) {
  const origin = page.parser === PDFJS_PARSER ? null : (ORIGIN[page.parser] ?? `文字来源 Text from: ${page.parser}`);
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card card" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>教材第 {page.label ?? page.no} 页 · Source page</h2>
          <button className="btn small ghost" onClick={onClose}>
            关闭 Close
          </button>
        </div>
        {origin && (
          <p className="muted small" data-testid="source-origin">
            {origin}
          </p>
        )}
        <pre className="source-text">{page.text}</pre>
      </div>
    </div>
  );
}
