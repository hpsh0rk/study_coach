import { describe, expect, it } from "vitest";
import { clampPosition, fitStage, keyAction, nextPosition, prevPosition } from "../src/navigation.ts";

describe("navigation", () => {
  const steps = [0, 2, 0];

  it("steps through reveals before advancing and stops at the end", () => {
    let pos = { index: 0, step: 0 };
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      pos = nextPosition(steps, pos);
      seen.push(`${pos.index}.${pos.step}`);
    }
    expect(seen).toEqual(["1.0", "1.1", "1.2", "2.0", "2.0", "2.0"]);
  });

  it("going back lands on the fully revealed previous slide", () => {
    expect(prevPosition(steps, { index: 2, step: 0 })).toEqual({ index: 1, step: 2 });
    expect(prevPosition(steps, { index: 1, step: 1 })).toEqual({ index: 1, step: 0 });
    expect(prevPosition(steps, { index: 0, step: 0 })).toEqual({ index: 0, step: 0 });
  });

  it("clamps out-of-range positions", () => {
    expect(clampPosition(steps, { index: 9, step: 9 })).toEqual({ index: 2, step: 0 });
    expect(clampPosition(steps, { index: 1, step: 9 })).toEqual({ index: 1, step: 2 });
    expect(clampPosition([], { index: 3, step: 1 })).toEqual({ index: 0, step: 0 });
  });

  it("letterboxes 16:9 into a 4:3 projector", () => {
    const f = fitStage(1024, 768);
    expect(f.scale).toBeCloseTo(1024 / 1920);
    expect(f.offsetX).toBe(0);
    expect(f.offsetY).toBeCloseTo((768 - 1080 * f.scale) / 2);
  });

  it("maps clicker keys", () => {
    expect(keyAction("PageDown")).toBe("next");
    expect(keyAction("PageUp")).toBe("prev");
    expect(keyAction(" ")).toBe("next");
    expect(keyAction("b")).toBe("blank");
    expect(keyAction("F5")).toBe("fullscreen");
    expect(keyAction("x")).toBeNull();
  });
});
