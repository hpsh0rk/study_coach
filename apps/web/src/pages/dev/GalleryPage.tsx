import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import type { LayoutId, ThemeId } from "@kj/schema";
import { CANVAS, galleryCells, LAYOUTS } from "@kj/templates";
import { applyStep, fitSlide, measureOverflow, minBodyFontPx, renderSlide } from "@kj/templates/render";

/**
 * Every layout with sample and max-budget content. Each slide is laid out at full 1920×1080 and
 * reports measured overflow / smallest body font as data attributes (read by the Playwright test).
 */
export function GalleryPage() {
  const [q] = useSearchParams();
  const theme = (q.get("theme") as ThemeId) || "classic";
  const only = q.get("layout") as LayoutId | null;
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    root.replaceChildren();
    document.body.dataset.galleryReady = "0";
    const disposers: (() => void)[] = [];
    const cells: { cell: HTMLElement; slide: HTMLElement }[] = [];
    for (const g of galleryCells().filter((g) => !only || g.layout === only)) {
      const cell = document.createElement("figure");
      cell.className = "gallery-cell";
      cell.dataset.testid = `slide-${g.id}`;
      const frame = document.createElement("div");
      frame.className = "gallery-frame";
      const r = renderSlide({ content: g.content, sources: [3, 4] }, { theme, interactive: true, badge: LAYOUTS[g.layout].label.en, index: 0, total: 1 });
      applyStep(r.el, r.steps);
      frame.append(r.el);
      const cap = document.createElement("figcaption");
      cap.textContent = g.id;
      cell.append(frame, cap);
      root.append(cell);
      cells.push({ cell, slide: r.el });
      disposers.push(r.dispose);
    }
    void (async () => {
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      for (const { cell, slide } of cells) {
        fitSlide(slide);
        cell.dataset.overflow = measureOverflow(slide).join(",");
        cell.dataset.minFont = String(minBodyFontPx(slide));
        const cap = cell.querySelector("figcaption")!;
        cap.textContent += cell.dataset.overflow ? ` · ⚠ overflow: ${cell.dataset.overflow}` : " · ✓ fits";
      }
      document.body.dataset.galleryReady = "1";
    })();
    return () => disposers.forEach((d) => d());
  }, [theme, only]);

  return (
    <div className="gallery-page" style={{ ["--canvas-w" as string]: `${CANVAS.width}px` }}>
      <h1>Layout gallery · 版式样张</h1>
      <p className="muted">
        8 layouts × (sample, max budget EN, max budget ZH) + table and placeholder visuals · theme {theme} · <a href="?theme=classic">classic</a> · <a href="?theme=chalk">chalk</a>
      </p>
      <div ref={host} className="gallery-grid" />
    </div>
  );
}
