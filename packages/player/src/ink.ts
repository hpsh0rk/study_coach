import { CANVAS } from "@kj/templates";

export type InkTool = "pen" | "eraser";

export interface Stroke {
  color: string;
  /** Points in logical 1920×1080 slide coordinates, so strokes survive resizing and fullscreen. */
  points: [number, number][];
}

export const INK_COLORS = ["#e11d48", "#2563eb", "#16a34a"] as const;
const PEN_WIDTH = 6;
const ERASER_RADIUS = 28;

/** Distance from point p to segment ab (logical px). */
function segmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether a stroke passes within `r` of point p. */
export function strokeHits(s: Stroke, p: [number, number], r = ERASER_RADIUS): boolean {
  if (s.points.length === 1) return Math.hypot(p[0] - s.points[0]![0], p[1] - s.points[0]![1]) <= r;
  for (let i = 1; i < s.points.length; i++) if (segmentDistance(p, s.points[i - 1]!, s.points[i]!) <= r) return true;
  return false;
}

/**
 * Pen annotations over the slide for touch screens and 一体机: draw, erase whole strokes, clear the slide.
 * Strokes are kept per slide for this session only (never saved or sent anywhere).
 */
export class InkLayer {
  readonly canvas: HTMLCanvasElement;
  private strokes = new Map<number, Stroke[]>();
  private index = 0;
  private tool: InkTool | null = null;
  color: string = INK_COLORS[0];
  private drawing: Stroke | null = null;
  private obs: ResizeObserver;

  constructor(
    private frame: HTMLElement,
    private stage: HTMLElement,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "kj-ink";
    frame.append(this.canvas);
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", () => this.up());
    this.canvas.addEventListener("pointercancel", () => this.up());
    this.canvas.addEventListener("click", (e) => e.stopPropagation());
    this.obs = new ResizeObserver(() => this.redraw());
    this.obs.observe(frame);
  }

  get active(): InkTool | null {
    return this.tool;
  }

  setTool(tool: InkTool | null): void {
    this.tool = tool;
    this.canvas.dataset.tool = tool ?? "";
    this.frame.classList.toggle("kj-inking", !!tool);
  }

  setSlide(index: number): void {
    this.index = index;
    this.drawing = null;
    this.redraw();
  }

  /** Strokes on the current slide. */
  get current(): Stroke[] {
    return this.strokes.get(this.index) ?? [];
  }

  clear(): void {
    this.strokes.delete(this.index);
    this.redraw();
  }

  dispose(): void {
    this.obs.disconnect();
    this.canvas.remove();
  }

  private toLogical(e: PointerEvent): [number, number] {
    const r = this.stage.getBoundingClientRect();
    return [((e.clientX - r.left) / (r.width || 1)) * CANVAS.width, ((e.clientY - r.top) / (r.height || 1)) * CANVAS.height];
  }

  private down(e: PointerEvent): void {
    if (!this.tool) return;
    e.preventDefault();
    e.stopPropagation();
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this.toLogical(e);
    if (this.tool === "eraser") {
      this.erase(p);
      this.drawing = { color: "", points: [] };
      return;
    }
    this.drawing = { color: this.color, points: [p] };
    this.strokes.set(this.index, [...this.current, this.drawing]);
    this.redraw();
  }

  private move(e: PointerEvent): void {
    if (!this.drawing || !this.tool) return;
    const p = this.toLogical(e);
    if (this.tool === "eraser") this.erase(p);
    else {
      this.drawing.points.push(p);
      this.redraw();
    }
  }

  private up(): void {
    this.drawing = null;
  }

  private erase(p: [number, number]): void {
    const kept = this.current.filter((s) => !strokeHits(s, p));
    if (kept.length !== this.current.length) {
      this.strokes.set(this.index, kept);
      this.redraw();
    }
  }

  private redraw(): void {
    const dpr = globalThis.devicePixelRatio || 1;
    const w = this.frame.clientWidth;
    const h = this.frame.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.canvas.getContext?.("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const fr = this.frame.getBoundingClientRect();
    const sr = this.stage.getBoundingClientRect();
    const sx = (sr.width || w) / CANVAS.width;
    const sy = (sr.height || h) / CANVAS.height;
    ctx.setTransform(dpr * sx, 0, 0, dpr * sy, dpr * (sr.left - fr.left), dpr * (sr.top - fr.top));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = PEN_WIDTH;
    for (const s of this.current) {
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (s.points.length === 1) ctx.lineTo(s.points[0]![0] + 0.1, s.points[0]![1]);
      ctx.stroke();
    }
  }
}
