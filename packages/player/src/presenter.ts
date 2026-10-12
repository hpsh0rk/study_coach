import type { SlideContent } from "@kj/schema";
import type { Position } from "./navigation.ts";

export type SyncMessage = { type: "pos"; index: number; step: number } | { type: "blank"; on: boolean } | { type: "tally"; index: number; counts: number[] } | { type: "hello" };

export interface PresenterSync {
  /** Report a local change; ignored if it only echoes the last position received (unless `force`). */
  position(pos: Position, force?: boolean): void;
  blank(on: boolean): void;
  /** Class tally for slide `index`, typed in either window. */
  tally(index: number, counts: number[]): void;
  close(): void;
}

/**
 * Keeps an audience window and a presenter window on the same slide via BroadcastChannel
 * (same origin, same browser; no server). Either window can drive; echoes are suppressed.
 */
export function presenterSync(
  lessonId: string,
  handlers: { onPosition(pos: Position): void; onBlank?(on: boolean): void; onTally?(index: number, counts: number[]): void; onHello?(): void },
): PresenterSync {
  const Channel = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (!Channel) return { position() {}, blank() {}, tally() {}, close() {} };
  const ch = new Channel(`kj-present-${lessonId}`);
  let last = "";
  const key = (p: Position) => `${p.index}:${p.step}`;
  ch.onmessage = (e: MessageEvent<SyncMessage>) => {
    const m = e.data;
    if (m?.type === "pos") {
      last = key(m);
      handlers.onPosition({ index: m.index, step: m.step });
    } else if (m?.type === "blank") handlers.onBlank?.(m.on);
    else if (m?.type === "tally" && Array.isArray(m.counts)) handlers.onTally?.(m.index, m.counts.slice(0, 8).map((n) => Math.max(0, Math.min(9999, Number(n) || 0))));
    else if (m?.type === "hello") handlers.onHello?.();
  };
  ch.postMessage({ type: "hello" } satisfies SyncMessage);
  return {
    position(pos, force = false) {
      if (key(pos) === last && !force) return;
      last = key(pos);
      ch.postMessage({ type: "pos", index: pos.index, step: pos.step } satisfies SyncMessage);
    },
    blank(on) {
      ch.postMessage({ type: "blank", on } satisfies SyncMessage);
    },
    tally(index, counts) {
      ch.postMessage({ type: "tally", index, counts } satisfies SyncMessage);
    },
    close() {
      ch.close();
    },
  };
}

const LETTERS = "ABCDEFGH";

/** What only the teacher should see in advance: correct options, expected answers, hidden steps. */
export function answerKey(c: SlideContent): string[] {
  switch (c.layout) {
    case "quiz": {
      const right = c.options[c.answer];
      return [`答案 Answer: ${LETTERS[c.answer] ?? c.answer + 1}. ${right?.text ?? ""}`, ...c.options.flatMap((o, i) => (i !== c.answer && o.misconception ? [`${LETTERS[i]}: ${o.misconception}`] : [])), c.explain];
    }
    case "questions":
      return c.items.map((it, i) => `${i + 1}. ${it.a}`);
    case "steps":
      return c.fadeFrom !== undefined ? c.steps.slice(c.fadeFrom).map((s, i) => `${(c.fadeFrom ?? 0) + i + 1}. ${s.text}`) : [];
    case "experiment":
      return [...(c.outcome !== undefined ? [`结果 Outcome: ${LETTERS[c.outcome] ?? c.outcome + 1}. ${c.predict.options[c.outcome] ?? ""}`] : []), c.explain];
    case "order":
      return c.mode === "match" ? c.items.map((it) => `${it.text} ↔ ${it.match}`) : c.items.map((it, i) => `${i + 1}. ${it.text}`);
    default:
      return [];
  }
}
