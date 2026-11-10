import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import type { LayoutId, ThemeId } from "@kj/schema";
import { CANVAS, LAYOUTS } from "@kj/templates";
import { galleryCells } from "@kj/templates/testing";
import { classroomFixtureCells } from "@kj/templates/testing/classroom";
import { applyStep, fitSlide, measureOverflow, minBodyFontPx, renderSlide } from "@kj/templates/render";

/**
 * Every layout with sample and max-budget content. Each slide is laid out at full 1920×1080 and
 * reports measured overflow / smallest body font as data attributes (read by the Playwright test).
 */
export function GalleryPage() {
  const [q] = useSearchParams();
  const theme = (q.get("theme") as ThemeId) || "classic";
  const only = q.get("layout") as LayoutId | null;
  const matrixOnly = q.get("fixture") === "classroom";
  const reveal = q.get("reveal");
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    root.replaceChildren();
    document.body.dataset.galleryReady = "0";
    const disposers: (() => void)[] = [];
    const cells: { cell: HTMLElement; slide: HTMLElement }[] = [];
    const examples = matrixOnly ? classroomFixtureCells() : [...galleryCells(), ...classroomFixtureCells()];
    for (const g of examples.filter((g) => !only || g.layout === only)) {
      const cell = document.createElement("figure");
      cell.className = "gallery-cell";
      cell.dataset.testid = `slide-${g.id}`;
      const frame = document.createElement("div");
      frame.className = "gallery-frame";
      const r = renderSlide({ content: g.content, sources: [3, 4] }, { theme, interactive: true, badge: LAYOUTS[g.layout].label.en, index: 0, total: 1 });
      const step = reveal === null ? r.steps : Math.min(r.steps, Math.max(0, Number(reveal) || 0));
      applyStep(r.el, step);
      cell.dataset.steps = String(r.steps);
      cell.dataset.reveal = String(step);
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
  }, [theme, only, matrixOnly, reveal]);

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
