import type { Slide, SlideSpec } from "@kj/schema";
import { ApiError } from "../../api.ts";

export const INITIAL_SLIDE_CONCURRENCY = 4;
export const FALLBACK_SLIDE_CONCURRENCY = 2;
export const SLIDE_BUSY_POLL_MS = 4000;
export const SLIDE_BUSY_MAX_MS = 180_000;

export interface SlideRunCallbacks {
  request: (specId: string, regenerate: boolean) => Promise<Slide>;
  onStart: (specId: string) => void;
  onSlide: (specId: string, slide: Slide) => void;
  onError: (specId: string, message: string) => void;
  onDone: (specId: string) => void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxWaitMs?: number;
}

export interface SlideRunResult {
  ok: boolean;
  rateLimited: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Generates (or regenerates) one slide, polling when another tab holds the short per-spec lock.
 */
export async function generateSlideWithLock(
  specId: string,
  regenerate: boolean,
  cb: SlideRunCallbacks,
): Promise<SlideRunResult> {
  const pollMs = cb.pollMs ?? SLIDE_BUSY_POLL_MS;
  const maxWaitMs = cb.maxWaitMs ?? SLIDE_BUSY_MAX_MS;
  const sleep = cb.sleep ?? defaultSleep;
  cb.onStart(specId);
  try {
    let slide: Slide | null = null;
    for (let wait = 0; !slide; wait += pollMs) {
      try {
        slide = await cb.request(specId, regenerate);
      } catch (e) {
        // Another tab is writing this slide: wait for its result instead of paying for a second one.
        if (!(e instanceof ApiError && e.code === "SLIDE_IN_PROGRESS") || wait > maxWaitMs) throw e;
        regenerate = false;
        await sleep(pollMs);
      }
    }
    cb.onSlide(specId, slide);
    return { ok: true, rateLimited: false };
  } catch (e) {
    cb.onError(specId, e instanceof ApiError ? e.message : (e as Error).message);
    return { ok: false, rateLimited: e instanceof ApiError && e.status === 429 };
  } finally {
    cb.onDone(specId);
  }
}

export interface BatchConcurrencyOptions {
  initialConcurrency?: number;
  fallbackConcurrency?: number;
}

/**
 * Generates missing slides (`worked` examples first so faded and practice pages can mirror their problem),
 * starting at 4 concurrent requests and falling back to 2 for the remainder of the run after hitting HTTP 429.
 */
export async function generateMissingSlides(
  specs: readonly Pick<SlideSpec, "id" | "pageType">[],
  existingIds: ReadonlySet<string>,
  runOne: (specId: string) => Promise<SlideRunResult>,
  opts: BatchConcurrencyOptions = {},
): Promise<{ finalConcurrency: number }> {
  const missing = specs.filter((s) => !existingIds.has(s.id));
  let concurrency = opts.initialConcurrency ?? INITIAL_SLIDE_CONCURRENCY;
  const fallback = opts.fallbackConcurrency ?? FALLBACK_SLIDE_CONCURRENCY;

  const phases = [
    missing.filter((s) => s.pageType === "worked").map((s) => s.id),
    missing.filter((s) => s.pageType !== "worked").map((s) => s.id),
  ];

  for (const todo of phases) {
    if (todo.length > 0) {
      let next = 0;
      let inFlight = 0;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (err: unknown) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        };
        const pump = () => {
          if (!settled) {
            if (next >= todo.length && inFlight === 0) {
              settled = true;
              resolve();
            } else {
              while (inFlight < concurrency && next < todo.length) {
                const specId = todo[next++]!;
                inFlight++;
                Promise.resolve()
                  .then(() => runOne(specId))
                  .then((res) => {
                    inFlight--;
                    if (res.rateLimited && concurrency > fallback) concurrency = fallback;
                    pump();
                  }, fail);
              }
            }
          }
        };
        pump();
      });
    }
  }

  return { finalConcurrency: concurrency };
}
