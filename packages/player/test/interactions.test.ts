import { describe, expect, it } from "vitest";
import type { SlideContent } from "@kj/schema";
import { sampleContent } from "@kj/templates";
import { applyStep, renderSlide, shuffledOrder } from "@kj/templates/render";
import { answerKey, keyAction, Player, strokeHits, type PlayerSlide } from "../src/index.ts";

const keys = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".kj-cards:not(.kj-cards-fixed) .kj-card")].map((c) => Number(c.dataset.key));

function pointer(el: Element, type: string, x = 0, y = 0) {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
}

describe("order / match", () => {
  it("never starts in the answer order, and is deterministic", () => {
    for (let n = 3; n <= 5; n++) {
      const p = shuffledOrder(Array.from({ length: n }, (_, i) => `card ${i}`));
      expect(p.some((v, i) => v === i)).toBe(false);
      expect(shuffledOrder(Array.from({ length: n }, (_, i) => `card ${i}`))).toEqual(p);
    }
  });

  it("tapping two cards swaps them; the reveal step marks the class's correct placements", () => {
    const r = renderSlide({ content: sampleContent("order"), sources: [] }, { theme: "classic", interactive: true });
    document.body.append(r.el);
    expect(r.steps).toBe(1);
    const before = keys(r.el);
    const cards = r.el.querySelectorAll(".kj-card");
    pointer(cards[0]!, "pointerdown");
    pointer(cards[0]!, "pointerup");
    expect(cards[0]!.classList.contains("kj-picked")).toBe(true);
    pointer(cards[1]!, "pointerdown");
    pointer(cards[1]!, "pointerup");
    const after = keys(r.el);
    expect(after).toEqual([before[1], before[0], ...before.slice(2)]);
    const right = [...r.el.querySelectorAll<HTMLElement>(".kj-card")].filter((c) => c.classList.contains("kj-right")).map((c) => Number(c.dataset.key));
    expect(right).toEqual(after.filter((k, i) => k === i));
    applyStep(r.el, 1);
    expect(r.el.dataset.stepNow).toBe("1");
    expect(r.el.querySelector(".kj-order-reveal")!.classList.contains("kj-step-hidden")).toBe(false);
    r.el.remove();
    r.dispose();
  });

  it("match mode keeps the left column fixed and shuffles the partners", () => {
    const content: SlideContent = {
      layout: "order",
      title: "Match each wave to its use",
      mode: "match",
      items: [
        { text: "Radio", match: "Broadcasting" },
        { text: "Microwave", match: "Cooking" },
        { text: "X-ray", match: "Bone imaging" },
      ],
    };
    const r = renderSlide({ content, sources: [] }, { theme: "classic", interactive: false });
    expect([...r.el.querySelectorAll(".kj-card-fixed")].map((c) => c.textContent)).toEqual(["Radio", "Microwave", "X-ray"]);
    expect(keys(r.el)).not.toEqual([0, 1, 2]);
    expect(answerKey(content)).toEqual(["Radio ↔ Broadcasting", "Microwave ↔ Cooking", "X-ray ↔ Bone imaging"]);
    r.dispose();
  });
});

describe("class tally", () => {
  const quiz: SlideContent = {
    layout: "quiz",
    question: "A wave's frequency doubles at constant speed. What happens to its wavelength?",
    options: [
      { text: "It doubles", misconception: "Thinks f and λ rise together" },
      { text: "It halves", misconception: "" },
      { text: "It stays the same", misconception: "Ignores v = fλ" },
    ],
    answer: 1,
    explain: "v = fλ, so λ = v / f halves.",
    poll: true,
  };

  it("a hinge question reveals the typed-in distribution before the answer", () => {
    const r = renderSlide({ content: quiz, sources: [] }, { theme: "classic", interactive: true, tally: [12, 9, 3] });
    expect(r.steps).toBe(2);
    expect(r.tally?.labels).toEqual(["A", "B", "C"]);
    expect([...r.el.querySelectorAll(".kj-tally-n")].map((n) => n.textContent)).toEqual(["12 · 50%", "9 · 38%", "3 · 13%"]);
    applyStep(r.el, 1);
    expect(r.el.querySelector(".kj-tally")!.classList.contains("kj-step-hidden")).toBe(false);
    expect(r.el.querySelector(".kj-answer")!.classList.contains("kj-step-hidden")).toBe(true);
    applyStep(r.el, 2);
    expect(r.el.querySelector(".kj-answer")!.classList.contains("kj-step-hidden")).toBe(false);
    r.tally!.set([0, 4, 0]);
    expect(r.el.querySelectorAll<HTMLElement>(".kj-tally-bar")[1]!.style.width).toBe("100%");
    expect((r.el.querySelector(".kj-option") as HTMLButtonElement).disabled).toBe(true);
    r.dispose();
  });

  it("the player's vote inputs update the slide and report the tally for the presenter channel", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const reported: [number, number[]][] = [];
    const slides: PlayerSlide[] = [
      { content: sampleContent("title"), sources: [], notes: "", pageType: "cover" },
      { content: quiz, sources: [], notes: "", pageType: "check" },
    ];
    const p = new Player(host, { slides, theme: "classic", showNotes: false, onTally: (i, c) => reported.push([i, c]) });
    expect((host.querySelector(".kj-tally-inputs") as HTMLElement).hidden).toBe(true);
    p.next();
    const inputs = host.querySelectorAll<HTMLInputElement>(".kj-tally-inputs input");
    expect(inputs.length).toBe(3);
    inputs[0]!.value = "5";
    inputs[0]!.dispatchEvent(new Event("input"));
    expect(reported.at(-1)).toEqual([1, [5, 0, 0]]);
    expect(host.querySelector(".kj-tally-n")!.textContent).toBe("5 · 100%");
    p.setTally(1, [1, 1, 2]);
    expect(host.querySelectorAll(".kj-tally-n")[2]!.textContent).toBe("2 · 50%");
    p.prev();
    p.next();
    expect(host.querySelectorAll(".kj-tally-n")[2]!.textContent).toBe("2 · 50%");
    p.dispose();
    host.remove();
  });

  it("experiment predictions get a tally and the confirmed outcome in the answer key", () => {
    const exp = sampleContent("experiment");
    if (exp.layout !== "experiment") throw new Error("layout");
    const r = renderSlide({ content: exp, sources: [] }, { theme: "classic", interactive: true });
    expect(r.tally?.labels.length).toBe(exp.predict.options.length);
    expect(r.el.querySelector('.kj-chip[data-outcome="true"]')).not.toBeNull();
    expect(answerKey(exp)[0]).toMatch(/^结果 Outcome: B\./);
    r.dispose();
  });
});

describe("pen annotations", () => {
  it("D toggles the pen, Escape leaves it; while drawing a tap does not advance; strokes stay per slide until cleared", () => {
    expect(keyAction("d")).toBe("ink");
    expect(keyAction("Escape")).toBe("escape");
    const host = document.createElement("div");
    document.body.append(host);
    const slides: PlayerSlide[] = [0, 1].map(() => ({ content: sampleContent("statement"), sources: [], notes: "", pageType: "concept" }));
    const p = new Player(host, { slides, theme: "classic", showNotes: false });
    const canvas = host.querySelector<HTMLCanvasElement>(".kj-ink")!;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "d" }));
    expect(p.inkTool).toBe("pen");
    expect((host.querySelector(".kj-ink-tools") as HTMLElement).hidden).toBe(false);
    const at = p.position;
    pointer(canvas, "pointerdown", 10, 10);
    pointer(canvas, "pointermove", 40, 40);
    pointer(canvas, "pointerup", 40, 40);
    canvas.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(p.position).toEqual(at);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }));
    expect(p.position).not.toEqual(at);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(p.inkTool).toBeNull();
    p.dispose();
    host.remove();
  });

  it("the eraser removes whole strokes it touches", () => {
    const s = { color: "#000", points: [[0, 0], [100, 0]] as [number, number][] };
    expect(strokeHits(s, [50, 10])).toBe(true);
    expect(strokeHits(s, [50, 60])).toBe(false);
  });
});
