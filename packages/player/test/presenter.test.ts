import { afterEach, describe, expect, it } from "vitest";
import type { SlideContent } from "@kj/schema";
import { answerKey, presenterSync, type Position } from "../src/index.ts";

/** In-process BroadcastChannel: delivers to every other open channel with the same name. */
class FakeChannel {
  static open: FakeChannel[] = [];
  static sent = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(public name: string) {
    FakeChannel.open.push(this);
  }
  postMessage(data: unknown) {
    FakeChannel.sent++;
    for (const c of FakeChannel.open) if (c !== this && c.name === this.name) c.onmessage?.({ data } as MessageEvent);
  }
  close() {
    FakeChannel.open = FakeChannel.open.filter((c) => c !== this);
  }
}

const g = globalThis as { BroadcastChannel?: unknown };
const real = g.BroadcastChannel;
afterEach(() => {
  g.BroadcastChannel = real;
  FakeChannel.open = [];
  FakeChannel.sent = 0;
});

describe("presenterSync", () => {
  it("mirrors positions both ways without echo loops", () => {
    g.BroadcastChannel = FakeChannel;
    const seen = { a: [] as Position[], b: [] as Position[] };
    // Each side applies the remote position and reports it back as a local change, like Player.onChange does.
    const a = presenterSync("L1", { onPosition: (p) => (seen.a.push(p), a.position(p)) });
    const b = presenterSync("L1", { onPosition: (p) => (seen.b.push(p), b.position(p)) });
    const other = presenterSync("L2", { onPosition: () => expect.unreachable() });
    const afterHello = FakeChannel.sent;
    a.position({ index: 1, step: 0 });
    b.position({ index: 2, step: 1 });
    expect(seen.b).toEqual([{ index: 1, step: 0 }]);
    expect(seen.a).toEqual([{ index: 2, step: 1 }]);
    expect(FakeChannel.sent - afterHello).toBe(2);
    other.close();
  });

  it("syncs blanking and announces new windows", () => {
    g.BroadcastChannel = FakeChannel;
    let blank = false;
    let hellos = 0;
    const audience = presenterSync("L1", { onPosition: () => undefined, onBlank: (on) => (blank = on), onHello: () => hellos++ });
    const presenter = presenterSync("L1", { onPosition: () => undefined });
    expect(hellos).toBe(1);
    presenter.blank(true);
    expect(blank).toBe(true);
    audience.close();
  });

  it("is a no-op without BroadcastChannel", () => {
    g.BroadcastChannel = undefined;
    expect(() => presenterSync("L1", { onPosition: () => undefined }).position({ index: 1, step: 0 })).not.toThrow();
  });
});

describe("answerKey", () => {
  it("lists what students must not see ahead of time", () => {
    const quiz: SlideContent = { layout: "quiz", question: "Q?", options: [{ text: "Longer", misconception: "Mixes up f and λ" }, { text: "Shorter", misconception: "" }], answer: 1, explain: "v is fixed, so λ falls." };
    expect(answerKey(quiz)).toEqual(["答案 Answer: B. Shorter", "A: Mixes up f and λ", "v is fixed, so λ falls."]);
    const faded: SlideContent = { layout: "steps", title: "T", problem: "P", steps: [{ text: "a", why: "" }, { text: "b", why: "" }, { text: "c", why: "" }], fadeFrom: 2 };
    expect(answerKey(faded)).toEqual(["3. c"]);
    expect(answerKey({ layout: "summary", title: "S", nodes: [] })).toEqual([]);
  });
});
