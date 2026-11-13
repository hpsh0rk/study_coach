import { useEffect, useRef } from "react";
import { renderRichText } from "@kj/templates/render";

/** Renders plain text with inline `$...$` KaTeX math while preserving newlines and escaping HTML. */
export function RichText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) renderRichText(ref.current, text);
  }, [text]);
  return <span ref={ref} className={className}>{text}</span>;
}
