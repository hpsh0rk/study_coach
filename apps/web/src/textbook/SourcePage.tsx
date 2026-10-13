import { isVisionParser, MINERU_AGENT_PARSER, MINERU_PARSER, PASTE_PARSER, PDFJS_PARSER } from "@kj/textbook";
import type { TextbookPage } from "./api.ts";

const ORIGIN: Record<string, string> = {
  [PASTE_PARSER]: "这一页的文字由老师粘贴 · Text pasted by the teacher",
  [MINERU_AGENT_PARSER]: "浏览器读不全这一页，文字由外部解析服务（MinerU）重新识别 · Re-read by the external parser (MinerU)",
  [MINERU_PARSER]: "浏览器读不全这一页，文字由外部解析服务（MinerU）重新识别 · Re-read by the external parser (MinerU)",
};

/** A cited textbook page, opened from a slide's source chip. */
export function SourcePage({ page, onClose }: { page: TextbookPage; onClose: () => void }) {
  const origin =
    page.parser === PDFJS_PARSER
      ? null
      : isVisionParser(page.parser)
        ? "浏览器读不全这一页，文字由看图模型从页面图片识别，公式和数字请对照原书核对 · Read from the page image by a vision model: check the numbers"
        : (ORIGIN[page.parser] ?? `文字来源 Text from: ${page.parser}`);
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
