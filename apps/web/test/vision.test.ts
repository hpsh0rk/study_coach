import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api.ts";
import { readWithVision, type VisionDeps } from "../src/textbook/vision.ts";

function fakes(fail: Record<number, Error> = {}) {
  const rendered: number[] = [];
  const sent: { no: number; image: string }[] = [];
  const deps: VisionDeps = {
    async render(no) {
      rendered.push(no);
      return `data:image/jpeg;base64,page${no}`;
    },
    async read(no, image) {
      sent.push({ no, image });
      if (fail[no]) throw fail[no];
      return { page: { no, words: 30, chars: 200, flags: [], parser: "vlm:glm-4.6v-flash/1" }, reused: false };
    },
  };
  return { deps, rendered, sent };
}

describe("vision fallback in the browser", () => {
  it("renders and sends one page at a time, in order, reporting progress", async () => {
    const { deps, sent } = fakes();
    const progress: string[] = [];
    const out = await readWithVision([2, 5, 9], deps, (d, t) => progress.push(`${d}/${t}`));
    expect(sent).toEqual([2, 5, 9].map((no) => ({ no, image: `data:image/jpeg;base64,page${no}` })));
    expect(out).toEqual({ saved: [2, 5, 9].map((no) => expect.objectContaining({ no })), missed: [], stopped: null });
    expect(progress).toEqual(["0/3", "1/3", "2/3", "3/3"]);
  });

  it("skips a page the model could not read and goes on", async () => {
    const { deps } = fakes({ 5: new ApiError(502, "VISION_FAILED", "看图模型没有读出这一页") });
    const out = await readWithVision([2, 5, 9], deps);
    expect(out.saved.map((p) => p.no)).toEqual([2, 9]);
    expect(out).toMatchObject({ missed: [5], stopped: null });
  });

  it("stops at paid-off, budget, quota or a busy model; the rest are left for pasting", async () => {
    for (const status of [402, 403, 429, 503]) {
      const { deps, rendered } = fakes({ 5: new ApiError(status, "X", `stop ${status}`) });
      const out = await readWithVision([2, 5, 9], deps);
      expect(out).toMatchObject({ missed: [5, 9], stopped: `stop ${status}` });
      expect(rendered).toEqual([2, 5]);
    }
  });

  it("a page that cannot be rendered is missed, not fatal", async () => {
    const { deps } = fakes();
    const out = await readWithVision([1, 2], { ...deps, render: async (no) => (no === 1 ? Promise.reject(new Error("canvas")) : deps.render(no)) });
    expect(out).toMatchObject({ missed: [1], stopped: null });
    expect(out.saved.map((p) => p.no)).toEqual([2]);
  });
});
