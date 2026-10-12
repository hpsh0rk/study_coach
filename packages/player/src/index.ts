import type { Slide, ThemeId } from "@kj/schema";
import { CANVAS, stepsOf } from "@kj/templates";
import { applyStep, fitSlide, renderSlide, type RenderedSlide } from "@kj/templates/render";
import { INK_COLORS, InkLayer, type Stroke } from "./ink.ts";
import { clampPosition, fitStage, keyAction, nextPosition, prevPosition, type Position } from "./navigation.ts";

export * from "./ink.ts";
export * from "./navigation.ts";
export * from "./presenter.ts";

export type PlayerSlide = Pick<Slide, "content" | "sources" | "notes" | "pageType">;

export interface PlayerOptions {
  slides: PlayerSlide[];
  theme: ThemeId;
  /** Speaker notes drawer is only available when notes are present (never on share links). */
  showNotes: boolean;
  start?: Position;
  badge?(slide: PlayerSlide): string;
  onChange?(pos: Position): void;
  /** The blank screen (B / .) was toggled. */
  onBlank?(on: boolean): void;
  onSourceClick?(page: number): void;
  pageLabels?: Record<number, string>;
  /** The teacher typed a class tally (votes per option) for slide `index`. */
  onTally?(index: number, counts: number[]): void;
  /** Pen strokes of slide `index` changed here (mirror them with `setStrokes` in the other window). */
  onInk?(index: number, strokes: Stroke[]): void;
  /** Escape pressed while the pen is off: leave the presentation. */
  onEscape?(): void;
}

const TALLY_KEYS = ["PageDown", "PageUp", "Enter", "ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"];
const TALLY_IDLE_MS = 1000;

function fontsReady(): Promise<unknown> {
  return (document as Document & { fonts?: FontFaceSet }).fonts?.ready ?? Promise.resolve();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  parent?.append(n);
  return n;
}

/** Keeps a 1920×1080 element scaled to its container. */
function scaleInto(container: HTMLElement, inner: HTMLElement): ResizeObserver {
  const apply = () => {
    const { scale, offsetX, offsetY } = fitStage(container.clientWidth || CANVAS.width, container.clientHeight || CANVAS.height, CANVAS.width, CANVAS.height);
    inner.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  };
  apply();
  const obs = new ResizeObserver(apply);
  obs.observe(container);
  return obs;
}

/** Static, fully revealed thumbnail. Returns a disposer. */
export function renderThumb(container: HTMLElement, slide: Pick<Slide, "content" | "sources">, theme: ThemeId, opts: { badge?: string; index?: number; pageLabels?: Record<number, string> } = {}): () => void {
  container.replaceChildren();
  container.classList.add("kj-thumb");
  const wrap = el("div", "kj-thumb-inner", container);
  const r = renderSlide(slide, { theme, interactive: false, badge: opts.badge, index: opts.index, pageLabels: opts.pageLabels });
  wrap.append(r.el);
  applyStep(r.el, r.steps);
  const obs = scaleInto(container, wrap);
  void fontsReady().then(() => fitSlide(r.el));
  return () => {
    obs.disconnect();
    r.dispose();
  };
}

export class Player {
  readonly root: HTMLElement;
  private stage: HTMLElement;
  private frame: HTMLElement;
  private counter: HTMLElement;
  private notes: HTMLElement;
  private blank: HTMLElement;
  private current: RenderedSlide | null = null;
  private pos: Position;
  private steps: number[];
  private obs: ResizeObserver;
  private disposers: (() => void)[] = [];
  private ink: InkLayer;
  private inkButton: HTMLButtonElement;
  private inkTools: HTMLElement;
  private tallyInputs: HTMLElement;
  private tallies = new Map<number, number[]>();

  constructor(
    private container: HTMLElement,
    private opts: PlayerOptions,
  ) {
    this.steps = opts.slides.map((s) => stepsOf(s.content));
    this.pos = clampPosition(this.steps, opts.start ?? { index: 0, step: 0 });

    this.root = el("div", "kj-player", container);
    this.root.tabIndex = 0;
    const main = el("div", "kj-player-main", this.root);
    this.frame = el("div", "kj-player-frame", main);
    this.stage = el("div", "kj-stage", this.frame);
    this.stage.style.width = `${CANVAS.width}px`;
    this.stage.style.height = `${CANVAS.height}px`;
    this.blank = el("div", "kj-blank", this.frame);
    this.blank.hidden = true;
    this.notes = el("aside", "kj-notes", this.root);
    this.notes.hidden = true;
    this.ink = new InkLayer(this.frame, this.stage, (index, strokes) => opts.onInk?.(index, strokes));

    const bar = el("div", "kj-controls", main);
    const btn = (label: string, title: string, fn: () => void) => {
      const b = el("button", "kj-ctl", bar);
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
        this.root.focus();
      });
      return b;
    };
    btn("‹", "Previous · 上一步 (←)", () => this.prev());
    this.counter = el("span", "kj-counter", bar);
    btn("›", "Next · 下一步 (→ / Space)", () => this.next());
    el("span", "kj-spacer", bar);
    this.tallyInputs = el("span", "kj-tally-inputs", bar);
    this.tallyInputs.hidden = true;
    this.inkButton = btn("✎ 画笔", "Pen · 画笔批注 (D)", () => this.setInk(this.ink.active ? null : "pen"));
    this.inkTools = el("span", "kj-ink-tools", bar);
    this.inkTools.hidden = true;
    const swatches = INK_COLORS.map((color) => {
      const b = el("button", "kj-ctl kj-swatch", this.inkTools);
      b.type = "button";
      b.style.background = color;
      b.title = `Pen colour ${color}`;
      b.setAttribute("aria-label", b.title);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.ink.color = color;
        this.setInk("pen");
      });
      return b;
    });
    const eraser = el("button", "kj-ctl", this.inkTools);
    eraser.type = "button";
    eraser.textContent = "橡皮 Erase";
    eraser.addEventListener("click", (e) => {
      e.stopPropagation();
      this.setInk("eraser");
    });
    const clear = el("button", "kj-ctl", this.inkTools);
    clear.type = "button";
    clear.textContent = "清除 Clear";
    clear.title = "Clear this slide's drawing · 清除本页笔迹";
    clear.addEventListener("click", (e) => {
      e.stopPropagation();
      this.ink.clear();
    });
    this.syncInkButtons = () => {
      const tool = this.ink.active;
      this.inkButton.setAttribute("aria-pressed", String(!!tool));
      this.inkTools.hidden = !tool;
      swatches.forEach((b, i) => b.setAttribute("aria-pressed", String(tool === "pen" && this.ink.color === INK_COLORS[i])));
      eraser.setAttribute("aria-pressed", String(tool === "eraser"));
    };
    if (opts.showNotes) btn("Notes 讲稿", "Speaker notes · 讲稿 (S)", () => this.toggleNotes());
    btn("⛶", "Fullscreen · 全屏 (F)", () => this.toggleFullscreen());

    const onKey = (e: KeyboardEvent) => {
      // Clickers send PageUp/PageDown or arrow keys: after typing votes they must still move on (Enter just leaves the box).
      if (e.target instanceof HTMLInputElement && e.target.closest(".kj-tally-inputs") && TALLY_KEYS.includes(e.key)) {
        e.target.blur();
        if (e.key === "Enter") return;
      } else if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const action = keyAction(e.key);
      if (!action) return;
      e.preventDefault();
      if (action === "next") this.next();
      else if (action === "prev") this.prev();
      else if (action === "first") this.go({ index: 0, step: 0 });
      else if (action === "last") this.go({ index: this.steps.length - 1, step: 0 });
      else if (action === "fullscreen") this.toggleFullscreen();
      else if (action === "blank") this.setBlank(this.blank.hidden);
      else if (action === "notes" && opts.showNotes) this.toggleNotes();
      else if (action === "ink") this.setInk(this.ink.active ? null : "pen");
      else if (action === "escape" && this.ink.active) this.setInk(null);
      else if (action === "escape" && !doc.fullscreenElement) opts.onEscape?.();
    };
    // On the document, so presentation clickers (PageUp/PageDown) work wherever focus is.
    const doc = container.ownerDocument;
    const onDocKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || (e.target instanceof HTMLElement && e.target.closest("select, [contenteditable=true], .modal"))) return;
      onKey(e);
    };
    doc.addEventListener("keydown", onDocKey);
    this.frame.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, input, a, select, iframe, .kj-widget")) return;
      if (!this.blank.hidden) this.setBlank(false);
      else this.next();
    });
    this.obs = scaleInto(this.frame, this.stage);
    this.disposers.push(() => doc.removeEventListener("keydown", onDocKey), () => this.ink.dispose());
    this.show();
    this.root.focus();
  }

  get position(): Position {
    return this.pos;
  }

  next(): void {
    this.go(nextPosition(this.steps, this.pos));
  }

  prev(): void {
    this.go(prevPosition(this.steps, this.pos));
  }

  go(pos: Position): void {
    const p = clampPosition(this.steps, pos);
    const changed = p.index !== this.pos.index;
    this.pos = p;
    if (changed || !this.current) this.show();
    else this.reveal();
  }

  get blanked(): boolean {
    return !this.blank.hidden;
  }

  setBlank(on: boolean): void {
    if (this.blank.hidden === !on) return;
    this.blank.hidden = !on;
    this.root.dataset.blank = on ? "1" : "0";
    this.opts.onBlank?.(on);
  }

  private syncInkButtons: () => void = () => undefined;

  /** Pen annotation mode: while on, touches draw instead of advancing; clicker keys still navigate. */
  setInk(tool: "pen" | "eraser" | null): void {
    this.ink.setTool(tool);
    this.syncInkButtons();
  }

  get inkTool(): "pen" | "eraser" | null {
    return this.ink.active;
  }

  /** Mirrors the pen strokes of slide `index` drawn in the other window. */
  setStrokes(index: number, strokes: Stroke[]): void {
    this.ink.setStrokes(index, strokes);
  }

  /** Sets the class tally of slide `index` (from the presenter window or the inputs in the control bar). */
  setTally(index: number, counts: number[]): void {
    this.tallies.set(index, counts);
    if (index !== this.pos.index || !this.current?.tally) return;
    this.current.tally.set(counts);
    this.tallyInputs.querySelectorAll("input").forEach((input, i) => {
      if (input.ownerDocument.activeElement !== input) input.value = counts[i] ? String(counts[i]) : "";
    });
  }

  toggleNotes(): void {
    this.notes.hidden = !this.notes.hidden;
    this.root.classList.toggle("kj-with-notes", !this.notes.hidden);
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void this.root.requestFullscreen?.().catch(() => undefined);
  }

  private show(): void {
    this.current?.dispose();
    const slide = this.opts.slides[this.pos.index];
    this.stage.replaceChildren();
    if (!slide) return;
    this.current = renderSlide(slide, {
      theme: this.opts.theme,
      interactive: true,
      badge: this.opts.badge?.(slide),
      index: this.pos.index,
      total: this.opts.slides.length,
      onSourceClick: this.opts.onSourceClick,
      pageLabels: this.opts.pageLabels,
      tally: this.tallies.get(this.pos.index),
    });
    this.buildTallyInputs();
    this.ink.setSlide(this.pos.index);
    this.stage.append(this.current.el);
    const root = this.current.el;
    fitSlide(root);
    void fontsReady().then(() => fitSlide(root));
    this.notes.textContent = slide.notes || "—";
    this.reveal();
  }

  private buildTallyInputs(): void {
    const tally = this.current?.tally;
    const index = this.pos.index;
    this.tallyInputs.replaceChildren();
    this.tallyInputs.hidden = !tally;
    if (!tally) return;
    const counts = this.tallies.get(index) ?? [];
    el("span", "kj-tally-label", this.tallyInputs).textContent = "人数 Votes";
    const inputs = tally.labels.map((label, i) => {
      const wrap = el("label", "", this.tallyInputs);
      wrap.append(label);
      const input = el("input", "", wrap);
      // Text, not number: arrow keys from a clicker must not silently change the count.
      input.type = "text";
      input.inputMode = "numeric";
      input.maxLength = 3;
      input.autocomplete = "off";
      input.value = counts[i] ? String(counts[i]) : "";
      input.setAttribute("aria-label", `Votes for ${label} · ${label} 的人数`);
      input.addEventListener("click", (e) => e.stopPropagation());
      return input;
    });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const update = (e: Event) => {
      const input = e.target as HTMLInputElement;
      const digits = input.value.replace(/\D+/g, "").slice(0, 3);
      if (digits !== input.value) input.value = digits;
      clearTimeout(idle);
      idle = setTimeout(() => {
        if (input.ownerDocument.activeElement === input) input.blur();
      }, TALLY_IDLE_MS);
      const next = inputs.map((x) => Math.max(0, Math.min(999, Math.floor(Number(x.value) || 0))));
      this.tallies.set(index, next);
      this.current?.tally?.set(next);
      this.opts.onTally?.(index, next);
    };
    inputs.forEach((x) => x.addEventListener("input", update));
  }

  private reveal(): void {
    if (this.current) applyStep(this.current.el, this.pos.step);
    const steps = this.steps[this.pos.index] ?? 0;
    this.counter.textContent = `${this.pos.index + 1} / ${this.steps.length}${steps ? ` · ${this.pos.step}/${steps}` : ""}`;
    this.root.dataset.index = String(this.pos.index);
    this.root.dataset.step = String(this.pos.step);
    this.opts.onChange?.(this.pos);
  }

  dispose(): void {
    this.current?.dispose();
    this.obs.disconnect();
    for (const d of this.disposers) d();
    this.root.remove();
  }
}
