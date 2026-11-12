import { describe, expect, it } from "vitest";
import type { PageType } from "@kj/schema";
import { runSlidePool } from "../src/run.ts";

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

describe("eval slide pool concurrency and 429 step-down", () => {
  it("runs worked slides first, starts at concurrency 4, and steps down to 2 across phases on 429", async () => {
    const specs: { id: string; pageType: PageType }[] = [
      { id: "c1", pageType: "concept" },
      { id: "w1", pageType: "worked" },
      { id: "w2", pageType: "worked" },
      { id: "w3", pageType: "worked" },
      { id: "w4", pageType: "worked" },
      { id: "w5", pageType: "worked" },
      { id: "c2", pageType: "concept" },
      { id: "c3", pageType: "concept" },
      { id: "c4", pageType: "concept" },
    ];
    const running = new Set<string>();
    const pending = new Map<string, Deferred<{ rateLimited: boolean }>>();

    const run = runSlidePool(
      specs,
      async (spec) => {
        running.add(spec.id);
        const d = deferred<{ rateLimited: boolean }>();
        pending.set(spec.id, d);
        try {
          return await d.promise;
        } finally {
          running.delete(spec.id);
        }
      },
      { initialConcurrency: 4 },
    );
    await flush();

    // Worked examples run first at concurrency 4.
    expect([...running]).toEqual(["w1", "w2", "w3", "w4"]);

    // w2 hits rate limit while 3 others remain in flight: concurrency drops to 2, so w5 waits.
    pending.get("w2")!.resolve({ rateLimited: true });
    await flush();
    expect([...running]).toEqual(["w1", "w3", "w4"]);

    // w1 finishes -> 2 remain in flight (w3, w4), matching fallback concurrency 2, so w5 still waits.
    pending.get("w1")!.resolve({ rateLimited: false });
    await flush();
    expect([...running]).toEqual(["w3", "w4"]);

    // w3 finishes -> 1 in flight, so w5 starts.
    pending.get("w3")!.resolve({ rateLimited: false });
    await flush();
    expect([...running]).toEqual(["w4", "w5"]);

    pending.get("w4")!.resolve({ rateLimited: false });
    pending.get("w5")!.resolve({ rateLimited: false });
    await flush();

    // Non-worked phase inherits the stepped-down concurrency of 2.
    expect([...running]).toEqual(["c1", "c2"]);
    pending.get("c1")!.resolve({ rateLimited: false });
    await flush();
    expect([...running]).toEqual(["c2", "c3"]);

    pending.get("c2")!.resolve({ rateLimited: false });
    await flush();
    expect([...running]).toEqual(["c3", "c4"]);

    pending.get("c3")!.resolve({ rateLimited: false });
    pending.get("c4")!.resolve({ rateLimited: false });

    expect(await run).toEqual({ finalConcurrency: 2 });
  });

  it("keeps concurrency at 4 without 429 and never raises concurrency above initialConcurrency", async () => {
    const specs: { id: string; pageType: PageType }[] = [
      { id: "c1", pageType: "concept" },
      { id: "c2", pageType: "concept" },
      { id: "c3", pageType: "concept" },
    ];
    let maxRunning = 0;
    let current = 0;
    const res1 = await runSlidePool(
      specs,
      async (s) => {
        current++;
        maxRunning = Math.max(maxRunning, current);
        await Promise.resolve();
        current--;
        return { rateLimited: s.id === "c1" };
      },
      { initialConcurrency: 1 },
    );
    expect(res1.finalConcurrency).toBe(1);
    expect(maxRunning).toBe(1);

    const res4 = await runSlidePool(specs, async () => ({ rateLimited: false }), { initialConcurrency: 4 });
    expect(res4.finalConcurrency).toBe(4);
  });
});
