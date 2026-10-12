import type { ContentOf, Slide, SlideContent, ThemeId } from "@kj/schema";
import { renderRichText, renderWidget, type WidgetHandle } from "@kj/widgets/render";
import { CANVAS, FONT } from "../budgets.ts";
import { stepsOf } from "../index.ts";

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: "classic", label: "经典蓝 Classic" },
  { id: "chalk", label: "黑板绿 Chalk" },
];

export interface RenderOptions {
  theme: ThemeId;
  /** Present/edit: sliders, quiz clicks and sims are live. Thumbnails: static. */
  interactive: boolean;
  /** Page-type badge shown at a fixed position (T-08). */
  badge?: string;
  index?: number;
  total?: number;
  onSourceClick?: (page: number) => void;
  /** Printed page labels by page index, for the source chips. */
  pageLabels?: Record<number, string>;
  /** Class tally (votes per option) typed in by the teacher, for poll quizzes and experiment predictions. */
  tally?: number[];
}

export interface Tally {
  /** Option letters, one per count. */
  labels: string[];
  set(counts: number[]): void;
}

export interface RenderedSlide {
  el: HTMLElement;
  steps: number;
  /** Present when the slide shows a class tally the teacher fills in. */
  tally?: Tally;
  dispose(): void;
}

type Builder = { root: HTMLElement; handles: WidgetHandle[]; opts: RenderOptions; tally?: Tally };

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  parent?.append(n);
  return n;
}

function text<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, value: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const n = node(tag, cls, parent);
  renderRichText(n, value);
  return n;
}

/** A slot is a fixed box: overflow inside it is measured, never allowed to push other slots. */
function slot(name: string, parent: HTMLElement, cls = ""): HTMLDivElement {
  const s = node("div", `kj-slot kj-slot-${name} ${cls}`.trim(), parent);
  s.dataset.slot = name;
  return s;
}

function step<T extends HTMLElement>(el: T, k: number): T {
  if (k > 0) el.dataset.step = String(k);
  return el;
}

function widget(b: Builder, host: HTMLElement, spec: Parameters<typeof renderWidget>[0]): void {
  b.handles.push(renderWidget(spec, host, { interactive: b.opts.interactive }));
}

function title(b: Builder, value: string): void {
  const s = slot("title", b.root, "kj-fit");
  s.dataset.min = String(60 / FONT.title);
  text("h1", "kj-title", value, s);
}

const LETTERS = "ABCD";

/** Vote bars inside each option, revealed at step `k`; counts come from the teacher (RenderOptions.tally). `compact` shows counts only. */
function tally(b: Builder, hosts: HTMLElement[], k: number, compact = false): void {
  const parts = hosts.map((host) => {
    host.classList.add("kj-tallied");
    const box = step(node("span", "kj-tally", host), k);
    const bar = node("span", "kj-tally-bar", box);
    const n = node("span", "kj-tally-n", box);
    return { bar, n };
  });
  const set = (counts: number[]) => {
    const total = counts.reduce((s, x) => s + Math.max(0, x || 0), 0);
    parts.forEach((p, i) => {
      const v = Math.max(0, counts[i] || 0);
      const pct = total ? Math.round((v / total) * 100) : 0;
      p.bar.style.width = `${pct}%`;
      p.n.textContent = !total ? "–" : compact ? String(v) : `${v} · ${pct}%`;
    });
  };
  set(b.opts.tally ?? []);
  b.tally = { labels: hosts.map((_, i) => LETTERS[i] ?? String(i + 1)), set };
}

/** Deterministic shuffle that moves every card when it can (the starting order never gives the answer away). */
export function shuffledOrder(keys: string[]): number[] {
  const n = keys.length;
  let seed = [...keys.join("|")].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let attempt = 0; attempt < 20; attempt++) {
    const p = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j]!, p[i]!];
    }
    if (p.every((v, i) => v !== i)) return p;
  }
  return Array.from({ length: n }, (_, i) => (i + 1) % n);
}

/**
 * Cards in `list` can be swapped by dragging one onto another or by tapping two in turn (touch screens and mice);
 * `.kj-right` marks cards already in their correct place, shown once the answer is revealed.
 */
function swappable(list: HTMLElement): void {
  const cards = () => [...list.querySelectorAll<HTMLElement>(":scope > .kj-card")];
  const mark = () => cards().forEach((c, i) => c.classList.toggle("kj-right", Number(c.dataset.key) === i));
  const swap = (a: HTMLElement, b: HTMLElement) => {
    const mark2 = document.createElement("span");
    a.replaceWith(mark2);
    b.replaceWith(a);
    mark2.replaceWith(b);
    mark();
  };
  let picked: HTMLElement | null = null;
  let drag: { card: HTMLElement; x: number; y: number; moved: boolean } | null = null;
  for (const card of cards()) {
    card.addEventListener("click", (e) => e.stopPropagation());
    card.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      drag = { card, x: e.clientX, y: e.clientY, moved: false };
      card.setPointerCapture?.(e.pointerId);
    });
    card.addEventListener("pointermove", (e) => {
      if (drag?.card !== card) return;
      const scale = card.getBoundingClientRect().width / (card.offsetWidth || 1) || 1;
      const dx = (e.clientX - drag.x) / scale;
      const dy = (e.clientY - drag.y) / scale;
      if (Math.abs(dx) + Math.abs(dy) > 12) drag.moved = true;
      if (drag.moved) card.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    const end = (e: PointerEvent) => {
      if (drag?.card !== card) return;
      const moved = drag.moved;
      drag = null;
      card.style.transform = "";
      if (moved) {
        card.style.visibility = "hidden";
        const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".kj-card");
        card.style.visibility = "";
        if (under && under !== card && under.parentElement === list) swap(card, under);
        picked?.classList.remove("kj-picked");
        picked = null;
      } else if (picked && picked !== card) {
        picked.classList.remove("kj-picked");
        swap(picked, card);
        picked = null;
      } else {
        card.classList.toggle("kj-picked", picked !== card);
        picked = picked === card ? null : card;
      }
    };
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", () => {
      if (drag?.card === card) card.style.transform = "";
      drag = null;
    });
  }
  mark();
}

const RENDERERS: { [L in SlideContent["layout"]]: (b: Builder, c: ContentOf<L>) => void } = {
  title(b, c) {
    const s = slot("cover", b.root, "kj-fit");
    text("h1", "kj-cover-title", c.title, s);
    if (c.subtitle) text("p", "kj-cover-subtitle", c.subtitle, s);
    if (c.objectives.length) {
      const box = node("div", "kj-objectives", s);
      node("div", "kj-objectives-label", box).textContent = "Learning objectives · 学习目标";
      const ul = node("ul", "kj-list", box);
      for (const o of c.objectives) text("li", "", o, ul);
    }
  },

  statement(b, c) {
    title(b, c.title);
    const body = node("div", "kj-body kj-grid-2", b.root);
    const left = node("div", "kj-col", body);
    const bullets = slot("bullets", left, "kj-fit kj-grow");
    const ul = node("ul", "kj-list", bullets);
    c.bullets.forEach((t, i) => step(text("li", "", t, ul), i));
    if (c.terms.length) {
      const terms = slot("terms", left, "kj-fit");
      for (const t of c.terms) {
        const chip = node("span", "kj-term", terms);
        text("b", "", t.term, chip);
        if (t.zh) node("span", "kj-term-zh", chip).textContent = t.zh;
      }
    }
    widget(b, slot("visual", body), c.visual);
  },

  chart(b, c) {
    title(b, c.title);
    const body = node("div", "kj-body kj-grid-chart", b.root);
    widget(b, slot("chart", body), c.chart);
    const right = node("div", "kj-col", body);
    const tk = slot("takeaways", right, "kj-fit kj-grow");
    const ul = node("ul", "kj-list kj-takeaways", tk);
    c.takeaways.forEach((t, i) => step(text("li", "", t, ul), i + 1));
    if (c.source) text("div", "kj-chart-source", c.source, slot("source", right));
  },

  steps(b, c) {
    title(b, c.title);
    const body = node("div", "kj-body kj-col", b.root);
    text("div", "kj-problem", c.problem, slot("problem", body, "kj-fit"));
    const list = slot("steps", body, "kj-fit kj-grow");
    const ol = node("ol", "kj-steps", list);
    const fade = c.fadeFrom ?? 0;
    c.steps.forEach((s, i) => {
      const li = node("li", "kj-step", ol);
      node("span", "kj-step-n", li).textContent = String(i + 1);
      const wrap = node("div", "kj-step-body", li);
      text("span", "kj-step-text", s.text, wrap);
      if (s.why) text("span", "kj-step-why", s.why, wrap);
      if (i >= fade) {
        step(li, i - fade + 1);
        if (c.fadeFrom !== undefined) li.classList.add("kj-fade");
      }
    });
  },

  experiment(b, c) {
    title(b, c.title);
    const body = node("div", "kj-body kj-grid-exp", b.root);
    const left = node("div", "kj-col", body);
    const predict = slot("predict", left, "kj-fit");
    const q = node("div", "kj-phase", predict);
    node("span", "kj-phase-tag", q).textContent = "① Predict 预测";
    text("span", "kj-phase-text", c.predict.question, q);
    const opts = node("div", "kj-chips", predict);
    const chips = c.predict.options.map((o, i) => {
      const chip = node("button", "kj-chip", opts);
      chip.type = "button";
      if (c.outcome !== undefined) chip.dataset.outcome = String(i === c.outcome);
      node("b", "", chip).textContent = LETTERS[i] ?? String(i + 1);
      text("span", "", o, chip);
      chip.disabled = !b.opts.interactive;
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        opts.querySelectorAll(".kj-chip").forEach((x) => x.classList.toggle("selected", x === chip));
      });
      return chip;
    });
    tally(b, chips, 1, true);
    const observe = step(slot("observe", left, "kj-fit kj-grow"), 1);
    const oh = node("div", "kj-phase", observe);
    node("span", "kj-phase-tag", oh).textContent = "② Observe 观察";
    const ul = node("ul", "kj-list kj-list-sm", observe);
    for (const o of c.observe) text("li", "", o, ul);
    const right = node("div", "kj-col", body);
    widget(b, step(slot("sim", right, "kj-grow"), 1), c.sim);
    const explain = step(slot("explain", right, "kj-fit"), 2);
    const eh = node("div", "kj-phase", explain);
    node("span", "kj-phase-tag", eh).textContent = "③ Explain 解释";
    text("div", "kj-explain", c.explain, explain);
  },

  quiz(b, c) {
    const qs = slot("question", b.root, "kj-fit");
    node("div", "kj-quiz-tag", qs).textContent = c.poll ? "Check · 检查理解 · Vote first 先举手投票" : "Check · 检查理解";
    text("h1", "kj-quiz-q", c.question, qs);
    const body = node("div", "kj-body kj-col", b.root);
    const grid = slot("options", body, "kj-fit kj-grow kj-quiz-grid");
    const feedback = node("div", "kj-quiz-feedback", grid);
    if (c.poll) b.root.classList.add("kj-poll");
    const buttons = c.options.map((o, i) => {
      const btn = node("button", "kj-option", grid);
      btn.type = "button";
      btn.dataset.correct = String(i === c.answer);
      node("b", "kj-option-letter", btn).textContent = LETTERS[i] ?? String(i + 1);
      text("span", "kj-option-text", o.text, btn);
      // A hinge question is teacher-led: one tap must not give the answer away before the vote.
      btn.disabled = !b.opts.interactive || !!c.poll;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        grid.querySelectorAll(".kj-option").forEach((x) => x.classList.remove("picked"));
        btn.classList.add("picked");
        b.root.classList.add("kj-answered");
        feedback.textContent = i === c.answer ? "✓ Correct · 正确" : `✗ ${o.misconception || "Not quite · 再想想"}`;
        feedback.dataset.ok = String(i === c.answer);
      });
      return btn;
    });
    if (c.poll) tally(b, buttons, 1);
    grid.prepend(feedback);
    const ex = step(slot("explain", body, "kj-fit"), c.poll ? 2 : 1);
    ex.classList.add("kj-answer");
    text("div", "kj-explain", c.explain, ex);
  },

  questions(b, c) {
    title(b, c.title);
    const body = node("div", "kj-body kj-col", b.root);
    const list = slot("items", body, "kj-fit kj-grow");
    const ol = node("ol", "kj-qa", list);
    c.items.forEach((it, i) => {
      const li = node("li", "kj-qa-item", ol);
      node("span", "kj-qa-n", li).textContent = String(i + 1);
      text("span", "kj-qa-q", it.q, li);
      step(text("span", "kj-qa-a", it.a, li), i + 1);
    });
  },

  order(b, c) {
    title(b, c.title);
    const body = node("div", "kj-body kj-col", b.root);
    const board = slot("cards", body, `kj-fit kj-grow kj-order kj-order-${c.mode}`);
    board.style.setProperty("--kj-cards", String(c.items.length));
    node("div", "kj-order-hint", board).textContent = c.mode === "match" ? "Drag to match · 拖动配对" : "Drag into order · 拖动排序";
    const cols = node("div", "kj-order-cols", board);
    if (c.mode === "match") {
      const left = node("ol", "kj-cards kj-cards-fixed", cols);
      c.items.forEach((it) => text("li", "kj-card kj-card-fixed", it.text, left));
    }
    const list = node("ol", "kj-cards", cols);
    const perm = shuffledOrder(c.items.map((it) => it.text + it.match));
    for (const key of perm) {
      const it = c.items[key]!;
      const card = node("button", "kj-card", list);
      card.type = "button";
      card.dataset.key = String(key);
      card.style.setProperty("--kj-key", String(key));
      card.disabled = !b.opts.interactive;
      if (c.mode === "order") node("b", "kj-card-n", card).textContent = String(key + 1);
      text("span", "kj-card-text", c.mode === "match" ? it.match : it.text, card);
    }
    if (b.opts.interactive) swappable(list);
    else list.querySelectorAll<HTMLElement>(".kj-card").forEach((card, i) => card.classList.toggle("kj-right", Number(card.dataset.key) === i));
    // Reveal: cards move to their correct places (CSS order), so the clicker alone can show the answer.
    step(node("div", "kj-order-reveal", board), 1).textContent = c.mode === "match" ? "✓ Answer · 正确配对" : "✓ Answer · 正确顺序";
  },

  summary(b, c) {
    title(b, c.title);
    const body = node("div", "kj-body", b.root);
    const map = slot("nodes", body, "kj-fit kj-grow kj-map");
    map.style.setProperty("--kj-nodes", String(c.nodes.length));
    c.nodes.forEach((n, i) => {
      const box = step(node("div", "kj-node", map), i);
      text("div", "kj-node-head", n.head, box);
      if (n.detail) text("div", "kj-node-detail", n.detail, box);
    });
  },
};

/** Renders one slide into a detached 1920×1080 element. Call fitSlide() once it is in the DOM. */
export function renderSlide(slide: Pick<Slide, "content" | "sources">, opts: RenderOptions): RenderedSlide {
  const root = document.createElement("section");
  root.className = `kj-slide kj-theme-${opts.theme} kj-layout-${slide.content.layout}`;
  root.dataset.layout = slide.content.layout;
  root.style.width = `${CANVAS.width}px`;
  root.style.height = `${CANVAS.height}px`;
  const b: Builder = { root, handles: [], opts };
  if (opts.badge) node("div", "kj-badge", root).textContent = opts.badge;
  (RENDERERS[slide.content.layout] as (b: Builder, c: SlideContent) => void)(b, slide.content);

  const foot = node("footer", "kj-foot", root);
  const src = node("div", "kj-sources", foot);
  if (slide.sources.length) {
    node("span", "kj-sources-label", src).textContent = "Source 教材";
    for (const p of slide.sources) {
      const chip = node("button", "kj-source", src);
      chip.type = "button";
      chip.textContent = `p.${opts.pageLabels?.[p] ?? p}`;
      chip.dataset.page = String(p);
      if (opts.onSourceClick) {
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          opts.onSourceClick?.(p);
        });
      } else chip.disabled = true;
    }
  }
  if (opts.index !== undefined) node("div", "kj-num", foot).textContent = opts.total ? `${opts.index + 1} / ${opts.total}` : String(opts.index + 1);

  return {
    el: root,
    steps: stepsOf(slide.content),
    ...(b.tally ? { tally: b.tally } : {}),
    dispose: () => b.handles.forEach((h) => h.dispose()),
  };
}

/** Shows elements up to reveal step `k` (visibility only, so layout and measurements stay stable). */
export function applyStep(root: HTMLElement, k: number): void {
  root.querySelectorAll<HTMLElement>("[data-step]").forEach((n) => n.classList.toggle("kj-step-hidden", Number(n.dataset.step) > k));
  root.dataset.stepNow = String(k);
}

function overflows(n: HTMLElement): boolean {
  if (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1) return true;
  // Bottom-aligned content (titles) spills upwards, which scrollHeight does not report.
  const box = n.getBoundingClientRect();
  const scale = box.height / (n.offsetHeight || 1) || 1;
  return [...n.children].some((c) => {
    const r = c.getBoundingClientRect();
    return r.height > 0 && r.top < box.top - scale;
  });
}

/** Bounded font step-down (56px → 48px body, 72px → 60px title) for slots that overflow. */
export function fitSlide(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(".kj-fit").forEach((s) => {
    s.style.setProperty("--kj-scale", "1");
    const min = Number(s.dataset.min ?? FONT.bodyMin / FONT.body);
    let scale = 1;
    while (overflows(s) && scale > min + 1e-6) {
      scale = Math.max(min, scale - 0.025);
      s.style.setProperty("--kj-scale", (Math.ceil(scale * 1000) / 1000).toFixed(3));
    }
  });
}

/** Slot names whose content still overflows its box. Empty = the slide fits. */
export function measureOverflow(root: HTMLElement): string[] {
  const out: string[] = [];
  root.querySelectorAll<HTMLElement>("[data-slot]").forEach((s) => {
    if (overflows(s)) out.push(s.dataset.slot!);
  });
  return out;
}

/** Smallest computed font size of body text inside fitted slots (for T-02 checks). */
export function minBodyFontPx(root: HTMLElement): number {
  let min = Infinity;
  root.querySelectorAll<HTMLElement>(".kj-slot li, .kj-slot p, .kj-problem, .kj-explain, .kj-option-text, .kj-qa-q, .kj-node-detail, .kj-phase-text, .kj-step-text, .kj-step-why, .kj-chip, .kj-flow-step, .kj-term, .kj-table td, .kj-table th, .kj-card-text, .kj-card-fixed").forEach((n) => {
    min = Math.min(min, parseFloat(getComputedStyle(n).fontSize));
  });
  return min;
}
