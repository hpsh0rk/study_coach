import { describe, expect, it } from "vitest";
import type { PageType, Slide } from "@kj/schema";
import { ApiError } from "../src/api.ts";
import {
  FALLBACK_SLIDE_CONCURRENCY,
  generateMissingSlides,
  generateSlideWithLock,
  INITIAL_SLIDE_CONCURRENCY,
} from "../src/pages/wizard/slideGeneration.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function fakeSlide(specId: string, pageType: PageType = "concept"): Slide {
  return {
    id: `sl_${specId}`,
    specId,
    outlineVersionId: "ov_1",
    layout: "statement",
    pageType,
    minutes: 3,
    content: { layout: "statement", title: specId, bullets: ["Point"], visual: { kind: "flow", steps: ["A", "B"] }, terms: [] },
    notes: "",
    sources: [1],
    warnings: [],
    unverified: [],
    canUndo: false,
  };
}

function createHarness(onRequest?: (specId: string, regenerate: boolean) => Promise<Slide>) {
  const running = new Set<string>();
  const slides = new Map<string, Slide>();
  const failed = new Map<string, string>();
  const sleeps: number[] = [];
  const pending = new Map<string, Deferred<Slide>>();
  const calls: { specId: string; regenerate: boolean; inFlightAtStart: number }[] = [];
  let maxInFlight = 0;

  const request =
    onRequest ??
    ((specId: string, regenerate: boolean) => {
      calls.push({ specId, regenerate, inFlightAtStart: running.size });
      maxInFlight = Math.max(maxInFlight, running.size);
      const d = deferred<Slide>();
      pending.set(specId, d);
      return d.promise;
    });

  const runOne = (specId: string, regenerate = false, maxWaitMs = 10_000) =>
    generateSlideWithLock(specId, regenerate, {
      request,
      onStart: (id) => {
        running.add(id);
        failed.delete(id);
      },
      onSlide: (id, slide) => {
        slides.set(id, slide);
      },
      onError: (id, msg) => {
        failed.set(id, msg);
      },
      onDone: (id) => {
        running.delete(id);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pollMs: 4000,
      maxWaitMs,
    });

  return {
    running,
    slides,
    failed,
    sleeps,
    pending,
    calls,
    maxInFlight: () => maxInFlight,
    runOne,
  };
}

describe("GenerateStep slide concurrency and 429 fallback", () => {
  it("starts at concurrency 4 and completes worked examples before starting other slides", async () => {
    expect(INITIAL_SLIDE_CONCURRENCY).toBe(4);
    expect(FALLBACK_SLIDE_CONCURRENCY).toBe(2);

    const specs: { id: string; pageType: PageType }[] = [
      { id: "c1", pageType: "concept" },
      { id: "w1", pageType: "worked" },
      { id: "f1", pageType: "faded" },
      { id: "w2", pageType: "worked" },
      { id: "c2", pageType: "concept" },
      { id: "c3", pageType: "concept" },
      { id: "c4", pageType: "concept" },
      { id: "c5", pageType: "concept" },
      { id: "already", pageType: "concept" },
    ];
    const h = createHarness();
    const run = generateMissingSlides(specs, new Set(["already"]), (id) => h.runOne(id));
    await flush();

    // Phase 1 runs only worked slides first.
    expect([...h.running]).toEqual(["w1", "w2"]);
    h.pending.get("w1")!.resolve(fakeSlide("w1", "worked"));
    await flush();
    expect([...h.running]).toEqual(["w2"]);

    h.pending.get("w2")!.resolve(fakeSlide("w2", "worked"));
    await flush();

    // Phase 2 launches 4 slides concurrently (c1, f1, c2, c3), holding c4 and c5 queued.
    expect([...h.running]).toEqual(["c1", "f1", "c2", "c3"]);
    expect(h.maxInFlight()).toBe(4);

    h.pending.get("c1")!.resolve(fakeSlide("c1"));
    await flush();
    expect([...h.running]).toEqual(["f1", "c2", "c3", "c4"]);

    for (const id of ["f1", "c2", "c3", "c4"]) h.pending.get(id)!.resolve(fakeSlide(id));
    await flush();
    expect([...h.running]).toEqual(["c5"]);
    h.pending.get("c5")!.resolve(fakeSlide("c5"));

    const result = await run;
    expect(result.finalConcurrency).toBe(4);
    expect(h.slides.size).toBe(8);
    expect(h.failed.size).toBe(0);
    expect(h.calls.some((c) => c.specId === "already")).toBe(false);
  });

  it("drops from 4 to 2 for the remainder of the run (across phases) after hitting HTTP 429", async () => {
    const specs: { id: string; pageType: PageType }[] = [
      { id: "w1", pageType: "worked" },
      { id: "w2", pageType: "worked" },
      { id: "w3", pageType: "worked" },
      { id: "w4", pageType: "worked" },
      { id: "w5", pageType: "worked" },
      { id: "w6", pageType: "worked" },
      { id: "c1", pageType: "concept" },
      { id: "c2", pageType: "concept" },
      { id: "c3", pageType: "concept" },
      { id: "c4", pageType: "concept" },
    ];
    const h = createHarness();
    const run = generateMissingSlides(specs, new Set(), (id) => h.runOne(id));
    await flush();

    // Initially 4 worked slides are in flight.
    expect([...h.running]).toEqual(["w1", "w2", "w3", "w4"]);

    // w2 hits HTTP 429 while w1, w3, w4 (3 slides) remain in flight -> concurrency drops to 2, so w5 must NOT start yet.
    h.pending.get("w2")!.reject(new ApiError(429, "AI_PROVIDER", "AI 模型正忙（限流），请稍后再试"));
    await flush();
    expect([...h.running]).toEqual(["w1", "w3", "w4"]);
    expect(h.failed.get("w2")).toContain("限流");

    // w1 finishes -> 2 remain in flight (w3, w4), matching fallback limit 2, so w5 still waits.
    h.pending.get("w1")!.resolve(fakeSlide("w1", "worked"));
    await flush();
    expect([...h.running]).toEqual(["w3", "w4"]);

    // w3 finishes -> 1 remains in flight (w4), so w5 starts (back up to 2 in flight, never 3 or 4).
    h.pending.get("w3")!.resolve(fakeSlide("w3", "worked"));
    await flush();
    expect([...h.running]).toEqual(["w4", "w5"]);

    h.pending.get("w4")!.resolve(fakeSlide("w4", "worked"));
    await flush();
    expect([...h.running]).toEqual(["w5", "w6"]);

    h.pending.get("w5")!.resolve(fakeSlide("w5", "worked"));
    h.pending.get("w6")!.resolve(fakeSlide("w6", "worked"));
    await flush();

    // Phase 2 (non-worked slides) stays at concurrency 2 for the remainder of the run.
    expect([...h.running]).toEqual(["c1", "c2"]);
    h.pending.get("c1")!.resolve(fakeSlide("c1"));
    await flush();
    expect([...h.running]).toEqual(["c2", "c3"]);

    h.pending.get("c2")!.resolve(fakeSlide("c2"));
    await flush();
    expect([...h.running]).toEqual(["c3", "c4"]);

    h.pending.get("c3")!.resolve(fakeSlide("c3"));
    h.pending.get("c4")!.resolve(fakeSlide("c4"));

    const result = await run;
    expect(result.finalConcurrency).toBe(2);
    expect(h.slides.size).toBe(9);
    expect([...h.failed.keys()]).toEqual(["w2"]);
  });

  it("keeps concurrency at 4 on non-429 errors and preserves SLIDE_IN_PROGRESS lock polling", async () => {
    const specs: { id: string; pageType: PageType }[] = Array.from({ length: 6 }, (_, i) => ({ id: `s${i + 1}`, pageType: "concept" }));
    const h = createHarness();
    const run = generateMissingSlides(specs, new Set(), (id) => h.runOne(id));
    await flush();
    expect([...h.running]).toEqual(["s1", "s2", "s3", "s4"]);

    // Non-429 error records the failure without throttling concurrency.
    h.pending.get("s1")!.reject(new ApiError(502, "SLIDE_INVALID", "这一页没能生成合格的内容"));
    await flush();
    expect([...h.running]).toEqual(["s2", "s3", "s4", "s5"]);

    for (const id of ["s2", "s3", "s4", "s5"]) h.pending.get(id)!.resolve(fakeSlide(id));
    await flush();
    h.pending.get("s6")!.resolve(fakeSlide("s6"));
    expect((await run).finalConcurrency).toBe(4);
    expect(h.failed.get("s1")).toContain("没能生成");

    // Lock polling: first two attempts return 409 SLIDE_IN_PROGRESS, regenerate drops to false, third succeeds.
    const seenRegen: boolean[] = [];
    const pollHarness = createHarness(async (specId, regenerate) => {
      seenRegen.push(regenerate);
      if (seenRegen.length < 3) throw new ApiError(409, "SLIDE_IN_PROGRESS", "正在另一个窗口里生成");
      return fakeSlide(specId);
    });
    const ok = await pollHarness.runOne("locked", true, 10_000);
    expect(ok).toEqual({ ok: true, rateLimited: false });
    expect(seenRegen).toEqual([true, false, false]);
    expect(pollHarness.sleeps).toEqual([4000, 4000]);
    expect(pollHarness.slides.has("locked")).toBe(true);

    // Lock timeout: stops polling once wait > maxWaitMs.
    const timeoutHarness = createHarness(async () => {
      throw new ApiError(409, "SLIDE_IN_PROGRESS", "一直占着锁");
    });
    const timedOut = await timeoutHarness.runOne("stuck", false, 8_000);
    expect(timedOut).toEqual({ ok: false, rateLimited: false });
    expect(timeoutHarness.sleeps).toEqual([4000, 4000, 4000]);
    expect(timeoutHarness.failed.get("stuck")).toContain("一直占着锁");
  });
});
