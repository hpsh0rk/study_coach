export interface Position {
  index: number;
  step: number;
}

/** Pure navigation model over per-slide reveal step counts: reveals advance before the next slide. */
export function nextPosition(steps: number[], pos: Position): Position {
  const max = steps[pos.index];
  if (max === undefined) return pos;
  if (pos.step < max) return { index: pos.index, step: pos.step + 1 };
  if (pos.index < steps.length - 1) return { index: pos.index + 1, step: 0 };
  return pos;
}

export function prevPosition(steps: number[], pos: Position): Position {
  if (pos.step > 0) return { index: pos.index, step: pos.step - 1 };
  if (pos.index > 0) return { index: pos.index - 1, step: steps[pos.index - 1] ?? 0 };
  return pos;
}

export function clampPosition(steps: number[], pos: Position): Position {
  const index = Math.min(Math.max(0, pos.index), Math.max(0, steps.length - 1));
  const step = Math.min(Math.max(0, pos.step), steps[index] ?? 0);
  return { index, step };
}

/** Scale and letterbox offsets for fitting the 16:9 logical canvas into any viewport (e.g. 4:3 projectors). */
export function fitStage(viewW: number, viewH: number, stageW = 1920, stageH = 1080): { scale: number; offsetX: number; offsetY: number } {
  const scale = Math.max(0.01, Math.min(viewW / stageW, viewH / stageH));
  return { scale, offsetX: (viewW - stageW * scale) / 2, offsetY: (viewH - stageH * scale) / 2 };
}

export type KeyAction = "next" | "prev" | "first" | "last" | "fullscreen" | "blank" | "notes" | "ink" | "escape" | null;

/** Keyboard and presentation-clicker mapping (clickers send PageUp/PageDown, arrows, or "b"/"." for blank). */
export function keyAction(key: string): KeyAction {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
    case " ":
    case "Enter":
    case "n":
      return "next";
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
    case "Backspace":
    case "p":
      return "prev";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "f":
    case "F5":
      return "fullscreen";
    case "b":
    case "B":
    case ".":
      return "blank";
    case "s":
      return "notes";
    case "d":
    case "D":
      return "ink";
    case "Escape":
      return "escape";
    default:
      return null;
  }
}
