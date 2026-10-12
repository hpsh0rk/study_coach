import type { Slide, ThemeId } from "@kj/schema";
import { CANVAS, stepsOf } from "@kj/templates";
import { applyStep, fitSlide, renderSlide, type RenderedSlide } from "@kj/templates/render";
import { clampPosition, fitStage, keyAction, nextPosition, prevPosition, type Position } from "./navigation.ts";

export * from "./navigation.ts";

export type PlayerSlide = Pick<Slide, "content" | "sources" | "notes" | "pageType">;

export interface PlayerOptions {
  slides: PlayerSlide[];
  theme: ThemeId;
  /** Speaker notes drawer is only available when notes are present (never on share links). */
  showNotes: boolean;
  start?: Position;
  badge?(slide: PlayerSlide): string;
  onChange?(pos: Position): void;
  onSourceClick?(page: number): void;
  pageLabels?: Record<number, string>;
}

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
    if (opts.showNotes) btn("Notes 讲稿", "Speaker notes · 讲稿 (S)", () => this.toggleNotes());
    btn("⛶", "Fullscreen · 全屏 (F)", () => this.toggleFullscreen());

    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const action = keyAction(e.key);
      if (!action) return;
      e.preventDefault();
      if (action === "next") this.next();
      else if (action === "prev") this.prev();
      else if (action === "first") this.go({ index: 0, step: 0 });
      else if (action === "last") this.go({ index: this.steps.length - 1, step: this.steps[this.steps.length - 1] ?? 0 });
      else if (action === "fullscreen") this.toggleFullscreen();
      else if (action === "blank") this.blank.hidden = !this.blank.hidden;
      else if (action === "notes" && opts.showNotes) this.toggleNotes();
    };
    this.root.addEventListener("keydown", onKey);
    this.frame.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, input, a, select, iframe, .kj-widget")) return;
      if (!this.blank.hidden) this.blank.hidden = true;
      else this.next();
    });
    this.obs = scaleInto(this.frame, this.stage);
    this.disposers.push(() => this.root.removeEventListener("keydown", onKey));
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
    });
    this.stage.append(this.current.el);
    const root = this.current.el;
    fitSlide(root);
    void fontsReady().then(() => fitSlide(root));
    this.notes.textContent = slide.notes || "—";
    this.reveal();
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
