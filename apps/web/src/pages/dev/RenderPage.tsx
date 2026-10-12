import { useEffect } from "react";
import { SlideContent, type ThemeId } from "@kj/schema";
import { applyStep, fitSlide, measureOverflow, renderSlide } from "@kj/templates/render";

declare global {
  interface Window {
    /** Lays out each slide at 1920×1080 (all reveals shown) and returns its overflowing slot ids. Used by `pnpm eval:render`. */
    kjMeasure?: (slides: { content: unknown; sources?: number[] }[], theme?: ThemeId) => Promise<(string[] | { error: string })[]>;
  }
}

export function RenderPage() {
  useEffect(() => {
    window.kjMeasure = async (slides, theme = "classic") => {
      const host = document.getElementById("kj-measure")!;
      const out: (string[] | { error: string })[] = [];
      for (const raw of slides) {
        const parsed = SlideContent.safeParse(raw.content);
        if (!parsed.success) {
          out.push({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
          continue;
        }
        host.replaceChildren();
        const r = renderSlide({ content: parsed.data, sources: raw.sources ?? [] }, { theme, interactive: true, index: 0, total: 1 });
        host.append(r.el);
        applyStep(r.el, r.steps);
        await document.fonts.ready;
        fitSlide(r.el);
        out.push(measureOverflow(r.el));
        r.dispose();
      }
      host.replaceChildren();
      return out;
    };
    document.body.dataset.measureReady = "1";
    return () => {
      delete window.kjMeasure;
    };
  }, []);
  return <div id="kj-measure" style={{ position: "absolute", left: 0, top: 0 }} />;
}
