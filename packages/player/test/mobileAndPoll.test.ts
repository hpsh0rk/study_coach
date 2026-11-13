import { describe, expect, it } from "vitest";
import type { SlideContent } from "@kj/schema";
import * as templateRender from "@kj/templates/render";
import { fitSlide, fitSources, renderSlide } from "@kj/templates/render";
import { sampleContent } from "@kj/templates/testing";
import { Player, type PlayerSlide } from "../src/index.ts";

function touch(el: Element, type: "touchstart" | "touchmove" | "touchend", points: [number, number][]) {
  const list = points.map(([clientX, clientY], identifier) => ({ identifier, clientX, clientY, target: el }));
  const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    touches: typeof list;
    changedTouches: typeof list;
  };
  ev.touches = type === "touchend" ? [] : list;
  ev.changedTouches = list;
  el.dispatchEvent(ev);
}

describe("display formula DOM auto-fit, rotated fitSources, and renderRichText", () => {
  const wideFormulaSlide: SlideContent = {
    layout: "statement",
    title: "复杂物理与化学公式对比",
    bullets: ["求根公式与分段函数"],
    visual: {
      kind: "formula",
      tex: "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a},\\quad f(x)=\\begin{cases}x^2,&x\\ge 0\\\\-x,&x<0\\end{cases}",
      caption: "求根公式与分段函数",
    },
    terms: [],
  };

  it("scales down .kj-formula-tex in fitSlide when scrollWidth > clientWidth and clamps at 48px", () => {
    const r = renderSlide({ content: wideFormulaSlide, sources: [] }, { theme: "classic", interactive: false });
    const tex = r.el.querySelector<HTMLElement>(".kj-formula-tex")!;
    let currentScale = 1;
    const origSetProperty = tex.style.setProperty.bind(tex.style);
    tex.style.setProperty = (prop: string, value: string | null, priority?: string) => {
      if (prop === "--kj-formula-scale") currentScale = Number(value ?? 1);
      origSetProperty(prop, value, priority);
    };
    Object.defineProperty(tex, "clientWidth", { configurable: true, get: () => 700 });
    Object.defineProperty(tex, "scrollWidth", { configurable: true, get: () => Math.ceil(1120 * currentScale) });

    fitSlide(r.el);
    const scale = Number(tex.style.getPropertyValue("--kj-formula-scale"));
    expect(scale).toBeGreaterThanOrEqual(48 / 104 - 0.002);
    expect(Math.ceil(1120 * scale)).toBeLessThanOrEqual(701);

    Object.defineProperty(tex, "scrollWidth", { configurable: true, get: () => Math.ceil(3000 * currentScale) });
    fitSlide(r.el);
    const clamped = Number(tex.style.getPropertyValue("--kj-formula-scale"));
    expect(clamped * 104).toBeGreaterThanOrEqual(48 - 0.2);
    r.dispose();
  });

  it("fitSources hides overlapping source chips in rotated 90deg screen coordinates, and renderRichText renders multiline KaTeX", () => {
    const r = renderSlide({ content: wideFormulaSlide, sources: [1, 3, 5, 7] }, { theme: "classic", interactive: true });
    const chips = [...r.el.querySelectorAll<HTMLElement>(".kj-source")];
    chips.forEach((chip, idx) => {
      chip.getBoundingClientRect = () =>
        ({ left: 12, right: 32, top: 80 + idx * 90, bottom: 150 + idx * 90, width: 20, height: 70, x: 12, y: 80 + idx * 90, toJSON: () => ({}) }) as DOMRect;
    });
    const avoid = { left: 8, right: 40, top: 250, bottom: 580, width: 32, height: 330, x: 8, y: 250, toJSON: () => ({}) } as DOMRect;
    fitSources(r.el, avoid);
    expect(chips.filter((c) => c.hidden).length).toBeGreaterThan(0);
    r.dispose();

    const renderRich = (templateRender as Record<string, unknown>).renderRichText as (el: HTMLElement, s: string) => HTMLElement;
    const host = document.createElement("div");
    renderRich(host, "第一行：$v = f\\lambda$\n第二行：$\\lambda = 6$ m");
    expect(host.querySelectorAll(".kj-math").length).toBe(2);
    expect(host.textContent).not.toContain("$");
    expect(host.textContent).toContain("\n第二行：");
  });
});

describe("poll quiz zero-vote step skip & touchboard option click", () => {
  const pollQuiz: SlideContent = {
    layout: "quiz",
    question: "At constant wave speed, doubling frequency changes wavelength how?",
    options: [
      { text: "Doubles", misconception: "Direct proportion confusion" },
      { text: "Halves", misconception: "" },
      { text: "Unchanged", misconception: "Ignores v = fλ" },
    ],
    answer: 1,
    explain: "Because $v = f\\lambda$, wavelength halves.",
    poll: true,
  };

  it("keeps poll options disabled in non-player previews, but enables touchboard click & skips empty tally step in Player", () => {
    const preview = renderSlide({ content: pollQuiz, sources: [] }, { theme: "classic", interactive: true });
    expect((preview.el.querySelector(".kj-option") as HTMLButtonElement).disabled).toBe(true);
    preview.dispose();

    const host = document.createElement("div");
    document.body.append(host);
    const slides: PlayerSlide[] = [
      { content: pollQuiz, sources: [], notes: "Use $v = f\\lambda$.", pageType: "check" },
      { content: sampleContent("title"), sources: [], notes: "", pageType: "cover" },
    ];
    const p = new Player(host, { slides, theme: "classic", showNotes: true });

    expect(p.position).toEqual({ index: 0, step: 0 });
    const firstOpt = host.querySelector<HTMLButtonElement>(".kj-option")!;
    expect(firstOpt.disabled).toBe(false);
    firstOpt.click();
    expect(host.querySelector(".kj-quiz-feedback")?.textContent).toContain("Direct proportion confusion");
    expect(p.position).toEqual({ index: 0, step: 0 });

    // Next skips step 1 (empty '–' tally) and reveals answer at step 2.
    p.next();
    expect(p.position).toEqual({ index: 0, step: 2 });
    expect(host.querySelector(".kj-answer")!.classList.contains("kj-step-hidden")).toBe(false);

    // Prev from step 2 skips step 1 back to step 0.
    p.prev();
    expect(p.position).toEqual({ index: 0, step: 0 });

    // Once votes are entered, next stops at step 1 first, then step 2.
    p.setTally(0, [2, 8, 1]);
    expect(firstOpt.disabled).toBe(true);
    p.next();
    expect(p.position).toEqual({ index: 0, step: 1 });
    p.next();
    expect(p.position).toEqual({ index: 0, step: 2 });

    // Built-in notes drawer renders math spans via renderRichText instead of raw $...$
    expect(host.querySelector(".kj-notes .kj-math")).not.toBeNull();
    expect(host.querySelector(".kj-notes")?.textContent).not.toContain("$");

    p.dispose();
    host.remove();
  });
});

describe("mobile swipe, rotate landscape, and localized ink labels", () => {
  it("supports single-finger horizontal swipe while ignoring pinch-zoom, vertical scroll, and active ink", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const slides: PlayerSlide[] = [
      { content: sampleContent("title"), sources: [], notes: "", pageType: "cover" },
      { content: sampleContent("statement"), sources: [], notes: "", pageType: "concept" },
    ];
    const p = new Player(host, { slides, theme: "classic", showNotes: false });
    const frame = host.querySelector<HTMLElement>(".kj-player-frame")!;

    const swatchLabels = [...host.querySelectorAll<HTMLButtonElement>(".kj-swatch")].map((b) => b.getAttribute("aria-label"));
    expect(swatchLabels).toEqual(["红色画笔 · Red pen", "蓝色画笔 · Blue pen", "绿色画笔 · Green pen"]);

    // Left swipe -> next()
    touch(frame, "touchstart", [[300, 200]]);
    touch(frame, "touchend", [[120, 208]]);
    expect(p.position).toEqual({ index: 1, step: 0 });

    // Right swipe -> prev(), and trailing synthetic click does NOT re-advance
    touch(frame, "touchstart", [[100, 200]]);
    touch(frame, "touchend", [[280, 205]]);
    frame.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(p.position).toEqual({ index: 0, step: 0 });

    // Multi-touch pinch -> ignored
    touch(frame, "touchstart", [
      [300, 200],
      [100, 200],
    ]);
    touch(frame, "touchend", [[120, 200]]);
    expect(p.position).toEqual({ index: 0, step: 0 });

    // Vertical scroll -> ignored
    touch(frame, "touchstart", [[200, 320]]);
    touch(frame, "touchend", [[130, 120]]);
    expect(p.position).toEqual({ index: 0, step: 0 });

    // Active ink -> swipe ignored
    p.setInk("pen");
    touch(frame, "touchstart", [[300, 200]]);
    touch(frame, "touchend", [[100, 200]]);
    expect(p.position).toEqual({ index: 0, step: 0 });
    p.setInk(null);

    p.dispose();
    host.remove();
  });

  it("toggles CSS rotated landscape mode via [data-testid='player-rotate'] and exits rotated mode on Escape before leaving", () => {
    const host = document.createElement("div");
    document.body.append(host);
    let escaped = 0;
    const p = new Player(host, {
      slides: [{ content: sampleContent("title"), sources: [], notes: "", pageType: "cover" }],
      theme: "classic",
      showNotes: false,
      onEscape: () => escaped++,
    });
    const rotateBtn = host.querySelector<HTMLButtonElement>('[data-testid="player-rotate"]');
    expect(rotateBtn).not.toBeNull();
    expect(p.root.classList.contains("kj-rotated")).toBe(false);

    rotateBtn!.click();
    expect(p.root.classList.contains("kj-rotated")).toBe(true);
    expect(rotateBtn!.getAttribute("aria-pressed")).toBe("true");

    // First Escape exits rotated landscape mode rather than calling onEscape
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(p.root.classList.contains("kj-rotated")).toBe(false);
    expect(escaped).toBe(0);

    // Second Escape calls onEscape
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(escaped).toBe(1);

    p.dispose();
    host.remove();
  });
});
