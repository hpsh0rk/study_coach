import { applyBuildStep, fitText, renderSlide, setSlideNumber, type RenderContext, type RenderMode } from "@kj/renderer";
import { CANVAS, type Deck, type Slide, type ThemeTokens } from "@kj/schema";
import { channelName, clampPosition, fitStage, nextPosition, prevPosition, type Position, type SyncMessage } from "./navigation.ts";

export * from "./navigation.ts";

export interface ExperimentTarget {
  provider: string;
  componentId: string;
  locale: string;
  initial?: Record<string, string | number>;
}

export interface PlayerOptions {
  deck: Deck;
  theme: ThemeTokens;
  mode: "present" | "share";
  resolveAsset(assetId: string): string;
  resolveExperiment(target: ExperimentTarget): string | null;
  start?: Position;
  /** BroadcastChannel key shared with the speaker window. Omit to disable sync. */
  syncKey?: string;
  onChange?(pos: Position): void;
  onOpenSpeaker?(): void;
}

function waitFonts(doc: Document): Promise<unknown> {
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  return fonts?.ready ?? Promise.resolve();
}

export function renderScaled(container: HTMLElement, slide: Slide, ctx: RenderContext, step?: number): HTMLElement {
  container.replaceChildren();
  container.classList.add("kj-thumb");
  const root = renderSlide(slide, ctx);
  const wrap = document.createElement("div");
  wrap.className = "kj-thumb-inner";
  wrap.append(root);
  container.append(wrap);
  const apply = () => {
    const { scale } = fitStage(container.clientWidth || CANVAS.width, container.clientHeight || CANVAS.height);
    wrap.style.transform = `scale(${scale})`;
  };
  apply();
  new ResizeObserver(apply).observe(container);
  applyBuildStep(root, step ?? Number.MAX_SAFE_INTEGER);
  void waitFonts(document).then(() => fitText(root));
  return root;
}

export class Player {
  readonly root: HTMLElement;
  private stage: HTMLElement;
  private current: HTMLElement | null = null;
  private pos: Position;
  private channel: BroadcastChannel | null = null;
  private resizeObs: ResizeObserver;
  private disposers: (() => void)[] = [];
  private startedAt = Date.now();
  private counter: HTMLElement;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private container: HTMLElement,
    private opts: PlayerOptions,
  ) {
    this.pos = clampPosition(opts.deck.slides, opts.start ?? { index: 0, step: 0 });
    this.root = document.createElement("div");
    this.root.className = `kj-player kj-player-${opts.mode}`;
    this.root.tabIndex = 0;
    this.stage = document.createElement("div");
    this.stage.className = "kj-stage";
    this.stage.style.width = `${CANVAS.width}px`;
    this.stage.style.height = `${CANVAS.height}px`;
    this.root.append(this.stage);

    const controls = document.createElement("div");
    controls.className = "kj-controls";
    const btn = (label: string, title: string, fn: () => void, cls = "") => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.className = cls;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    this.counter = document.createElement("span");
    this.counter.className = "kj-counter";
    controls.append(btn("‹", "Previous (←)", () => this.prev(), "kj-prev"), this.counter, btn("›", "Next (→ / Space)", () => this.next(), "kj-next"));
    controls.append(btn("⛶", "Fullscreen (F)", () => void this.toggleFullscreen(), "kj-fullscreen"));
    if (opts.mode === "present" && opts.onOpenSpeaker) controls.append(btn("🗒", "Speaker view (S)", () => opts.onOpenSpeaker?.(), "kj-speaker"));
    this.root.append(controls);
    container.append(this.root);

    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.root);
    this.bindInput();
    if (opts.syncKey && typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(channelName(opts.syncKey));
      this.channel.onmessage = (ev: MessageEvent<SyncMessage>) => this.onSync(ev.data);
    }
    this.show(null);
    this.layout();
  }

  get position(): Position {
    return { ...this.pos };
  }

  next(): void {
    this.go(nextPosition(this.opts.deck.slides, this.pos));
  }

  prev(): void {
    this.go(prevPosition(this.opts.deck.slides, this.pos));
  }

  goto(index: number, step = 0): void {
    this.go(clampPosition(this.opts.deck.slides, { index, step }));
  }

  async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await this.root.requestFullscreen?.();
  }

  destroy(): void {
    this.resizeObs.disconnect();
    this.channel?.close();
    for (const d of this.disposers) d();
    clearTimeout(this.hideTimer);
    this.root.remove();
  }

  private go(target: Position): void {
    if (target.index === this.pos.index && target.step === this.pos.step) return;
    const direction = target.index === this.pos.index ? null : target.index > this.pos.index ? "forward" : "back";
    const prevIndex = this.pos.index;
    this.pos = target;
    if (target.index === prevIndex && this.current) {
      applyBuildStep(this.current, target.step);
      this.afterChange();
      return;
    }
    this.show(direction);
  }

  private ctx(mode: RenderMode): RenderContext {
    return { theme: this.opts.theme, mode, resolveAsset: this.opts.resolveAsset };
  }

  private show(direction: "forward" | "back" | null): void {
    const slide = this.opts.deck.slides[this.pos.index];
    if (!slide) {
      this.stage.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "kj-empty";
      empty.textContent = "No slides yet · 还没有页面";
      this.stage.append(empty);
      return;
    }
    const node = renderSlide(slide, this.ctx(this.opts.mode));
    node.dataset.layoutId = slide.layoutId;
    setSlideNumber(node, this.pos.index + 1, this.opts.deck.slides.length);
    applyBuildStep(node, this.pos.step);
    this.mountExperiments(node);

    const old = this.current;
    this.current = node;
    const transition = direction ? (slide.transition ?? "none") : "none";
    if (old && transition !== "none") {
      node.classList.add(`kj-enter-${transition}`, `kj-dir-${direction}`);
      old.classList.add(`kj-leave-${transition}`, `kj-dir-${direction}`);
      this.stage.append(node);
      const done = () => old.remove();
      old.addEventListener("animationend", done, { once: true });
      setTimeout(done, 700);
    } else {
      old?.remove();
      this.stage.append(node);
    }
    void waitFonts(document).then(() => fitText(node));
    this.afterChange();
  }

  private mountExperiments(node: HTMLElement): void {
    node.querySelectorAll<HTMLElement>(".kj-experiment").forEach((host) => {
      const target: ExperimentTarget = {
        provider: host.dataset.provider ?? "",
        componentId: host.dataset.component ?? "",
        locale: host.dataset.locale ?? "en",
        ...(host.dataset.initial ? { initial: JSON.parse(host.dataset.initial) } : {}),
      };
      const src = this.opts.resolveExperiment(target);
      if (!src) return;
      const iframe = document.createElement("iframe");
      // Sims are served from our own (separate, in production) origin; never from a third-party URL stored in the deck.
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-pointer-lock");
      iframe.setAttribute("allow", "fullscreen");
      iframe.title = `${target.provider}:${target.componentId}`;
      iframe.src = src;
      const toolbar = document.createElement("div");
      toolbar.className = "kj-exp-toolbar";
      const reset = document.createElement("button");
      reset.type = "button";
      reset.textContent = "↺ Reset";
      reset.addEventListener("click", (e) => {
        e.stopPropagation();
        iframe.src = src;
      });
      const full = document.createElement("button");
      full.type = "button";
      full.textContent = "⛶";
      full.title = "Fullscreen experiment";
      full.addEventListener("click", (e) => {
        e.stopPropagation();
        void host.requestFullscreen?.();
      });
      toolbar.append(reset, full);
      host.append(iframe, toolbar);
    });
  }

  private afterChange(): void {
    this.counter.textContent = `${this.pos.index + 1} / ${Math.max(1, this.opts.deck.slides.length)}`;
    this.opts.onChange?.(this.position);
    this.broadcast();
  }

  private broadcast(): void {
    this.channel?.postMessage({
      type: "state",
      index: this.pos.index,
      step: this.pos.step,
      total: this.opts.deck.slides.length,
      startedAt: this.startedAt,
    } satisfies SyncMessage);
  }

  private onSync(msg: SyncMessage): void {
    if (msg.type === "hello") this.broadcast();
    else if (msg.type === "command") {
      if (msg.action === "next") this.next();
      else if (msg.action === "prev") this.prev();
      else if (msg.action === "goto" && msg.index !== undefined) this.goto(msg.index, msg.step ?? 0);
    }
  }

  private layout(): void {
    const { scale, offsetX, offsetY } = fitStage(this.root.clientWidth, this.root.clientHeight);
    this.stage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  }

  private bindInput(): void {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
        case " ":
        case "Enter":
          e.preventDefault();
          this.next();
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
        case "Backspace":
          e.preventDefault();
          this.prev();
          break;
        case "Home":
          this.goto(0);
          break;
        case "End":
          this.goto(this.opts.deck.slides.length - 1);
          break;
        case "f":
        case "F":
          void this.toggleFullscreen();
          break;
        case "s":
        case "S":
          if (this.opts.mode === "present") this.opts.onOpenSpeaker?.();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    this.disposers.push(() => window.removeEventListener("keydown", onKey));

    let startX: number | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") startX = e.clientX;
    };
    const onUp = (e: PointerEvent) => {
      if (startX === null) return;
      const dx = e.clientX - startX;
      startX = null;
      if (Math.abs(dx) <= 50) return;
      if (dx < 0) this.next();
      else this.prev();
    };
    this.root.addEventListener("pointerdown", onDown);
    this.root.addEventListener("pointerup", onUp);

    const onMove = () => {
      this.root.classList.add("kj-controls-visible");
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => this.root.classList.remove("kj-controls-visible"), 2500);
    };
    this.root.addEventListener("pointermove", onMove);
    onMove();
  }
}

export interface SpeakerOptions {
  deck: Deck;
  theme: ThemeTokens;
  resolveAsset(assetId: string): string;
  syncKey: string;
}

/** Presenter window: current + next preview, bilingual notes, timer. Drives the audience window over BroadcastChannel. */
export class SpeakerView {
  private channel: BroadcastChannel;
  private pos: Position = { index: 0, step: 0 };
  private startedAt = Date.now();
  private timer: ReturnType<typeof setInterval>;
  private els: Record<"current" | "next" | "notes" | "clock" | "counter", HTMLElement>;
  private onKey: (e: KeyboardEvent) => void;

  constructor(
    private container: HTMLElement,
    private opts: SpeakerOptions,
  ) {
    container.classList.add("kj-speaker-view");
    container.innerHTML = `
      <div class="kj-sv-main"><div class="kj-sv-label">Current · 当前</div><div class="kj-sv-current"></div></div>
      <div class="kj-sv-side">
        <div class="kj-sv-label">Next · 下一页</div><div class="kj-sv-next"></div>
        <div class="kj-sv-bar"><span class="kj-sv-counter"></span><span class="kj-sv-clock">00:00</span>
          <button type="button" data-act="prev">‹</button><button type="button" data-act="next">›</button></div>
        <div class="kj-sv-label">Notes · 备注</div><div class="kj-sv-notes"></div>
      </div>`;
    const q = (sel: string) => container.querySelector<HTMLElement>(sel)!;
    this.els = { current: q(".kj-sv-current"), next: q(".kj-sv-next"), notes: q(".kj-sv-notes"), clock: q(".kj-sv-clock"), counter: q(".kj-sv-counter") };
    container.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) =>
      b.addEventListener("click", () => this.send({ type: "command", action: b.dataset.act as "next" | "prev" })),
    );
    this.onKey = (e) => {
      if (["ArrowRight", "PageDown", " "].includes(e.key)) this.send({ type: "command", action: "next" });
      if (["ArrowLeft", "PageUp"].includes(e.key)) this.send({ type: "command", action: "prev" });
    };
    window.addEventListener("keydown", this.onKey);
    this.channel = new BroadcastChannel(channelName(opts.syncKey));
    this.channel.onmessage = (ev: MessageEvent<SyncMessage>) => {
      if (ev.data.type === "state") {
        this.pos = { index: ev.data.index, step: ev.data.step };
        this.startedAt = ev.data.startedAt;
        this.render();
      }
    };
    this.timer = setInterval(() => this.tick(), 1000);
    this.render();
    this.send({ type: "hello" });
  }

  destroy(): void {
    clearInterval(this.timer);
    this.channel.close();
    window.removeEventListener("keydown", this.onKey);
  }

  private send(msg: SyncMessage): void {
    this.channel.postMessage(msg);
  }

  private tick(): void {
    const s = Math.floor((Date.now() - this.startedAt) / 1000);
    this.els.clock.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  private render(): void {
    const { slides } = this.opts.deck;
    const ctx: RenderContext = { theme: this.opts.theme, mode: "speaker", resolveAsset: this.opts.resolveAsset };
    const cur = slides[this.pos.index];
    const nxt = slides[this.pos.index + 1];
    if (cur) renderScaled(this.els.current, cur, ctx, this.pos.step);
    if (nxt) renderScaled(this.els.next, nxt, ctx, 0);
    else this.els.next.textContent = "End of deck · 结束";
    this.els.counter.textContent = `${this.pos.index + 1} / ${slides.length}`;
    this.els.notes.replaceChildren();
    if (cur) {
      const ul = document.createElement("ul");
      for (const n of cur.notes.en) {
        const li = document.createElement("li");
        li.textContent = n;
        ul.append(li);
      }
      const terms = document.createElement("dl");
      for (const t of cur.notes.zhTerms) {
        const dt = document.createElement("dt");
        dt.textContent = t.term;
        const dd = document.createElement("dd");
        dd.lang = "zh-CN";
        dd.textContent = t.note ? `${t.zh} — ${t.note}` : t.zh;
        terms.append(dt, dd);
      }
      this.els.notes.append(ul, terms);
    }
    this.tick();
  }
}
