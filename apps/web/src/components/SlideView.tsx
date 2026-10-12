import { useEffect, useRef } from "react";
import { PAGE_TYPES } from "@kj/pedagogy";
import { renderThumb } from "@kj/player";
import type { PageType, Slide, TeachingLanguage, ThemeId } from "@kj/schema";
import { CANVAS } from "@kj/templates";
import { applyStep, fitSlide, renderSlide } from "@kj/templates/render";

export const badgeOf = (pageType: PageType) => `${PAGE_TYPES[pageType].label.zh} · ${PAGE_TYPES[pageType].label.en}`;

/** Static thumbnail of a slide (fully revealed). */
export function SlideThumb({
  slide,
  theme,
  index,
  pageLabels,
  language,
}: {
  slide: Pick<Slide, "content" | "sources" | "pageType">;
  theme: ThemeId;
  index?: number;
  pageLabels?: Record<number, string>;
  language?: TeachingLanguage;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return renderThumb(ref.current, slide, theme, { badge: badgeOf(slide.pageType), index, pageLabels, language });
  }, [slide, theme, index, pageLabels, language]);
  return <div ref={ref} className="slide-thumb" />;
}

/** Interactive preview (sliders, quiz, sims live), scaled to its container. */
export function SlidePreview({
  slide,
  theme,
  onSourceClick,
  pageLabels,
  language,
}: {
  slide: Pick<Slide, "content" | "sources" | "pageType">;
  theme: ThemeId;
  onSourceClick?: (page: number) => void;
  pageLabels?: Record<number, string>;
  language?: TeachingLanguage;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = host.current;
    if (!box) return;
    box.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "kj-thumb-inner";
    box.append(wrap);
    const r = renderSlide(slide, { theme, interactive: true, badge: badgeOf(slide.pageType), onSourceClick, pageLabels, language });
    wrap.append(r.el);
    applyStep(r.el, r.steps);
    const apply = () => {
      const s = Math.min(box.clientWidth / CANVAS.width, box.clientHeight / CANVAS.height) || 0.3;
      wrap.style.transform = `scale(${s})`;
    };
    apply();
    const obs = new ResizeObserver(apply);
    obs.observe(box);
    fitSlide(r.el);
    void document.fonts?.ready.then(() => fitSlide(r.el));
    return () => {
      obs.disconnect();
      r.dispose();
    };
  }, [slide, theme, onSourceClick, pageLabels, language]);
  return <div ref={host} className="slide-preview kj-thumb" />;
}
