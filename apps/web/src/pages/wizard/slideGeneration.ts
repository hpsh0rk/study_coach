import type { Slide, SlideSpec } from "@kj/schema";
import { ApiError } from "../../api.ts";

export const INITIAL_SLIDE_CONCURRENCY = 4;
export const FALLBACK_SLIDE_CONCURRENCY = 2;
export const SLIDE_BUSY_POLL_MS = 4000;
export const SLIDE_BUSY_MAX_MS = 180_000;
export const MAX_REGENERATE_INSTRUCTION = 200;

export function buildGeneratePayload(regenerate: boolean, instruction?: string): { regenerate: boolean; instruction?: string } {
  const trimmed = instruction?.trim().slice(0, MAX_REGENERATE_INSTRUCTION) ?? "";
  return trimmed ? { regenerate, instruction: trimmed } : { regenerate };
}

export async function postGenerateSlide(
  lessonId: string,
  versionId: string,
  specId: string,
  regenerate: boolean,
  instruction?: string,
  signal?: AbortSignal,
): Promise<Slide> {
  const res = await fetch(`/api/lessons/${lessonId}/outline-versions/${versionId}/slides/${specId}/generate`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-kj-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify(buildGeneratePayload(regenerate, instruction)),
    signal,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; detail?: unknown } }).error;
    throw new ApiError(res.status, err?.code ?? "HTTP", err?.message ?? `HTTP ${res.status}`, err?.detail);
  }
  return (data as { slide: Slide }).slide;
}

export interface SlideRunCallbacks {
  request: (specId: string, regenerate: boolean, signal?: AbortSignal) => Promise<Slide>;
  onStart: (specId: string) => void;
  onSlide: (specId: string, slide: Slide) => void;
  onError: (specId: string, message: string) => void;
  onDone: (specId: string) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxWaitMs?: number;
}

export interface SlideRunResult {
  ok: boolean;
  rateLimited: boolean;
}

function abortableSleep(ms: number, signal?: AbortSignal, customSleep?: (ms: number) => Promise<void>): Promise<void> {
  if (signal?.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    return Promise.reject(err);
  }
  if (customSleep) return customSleep(ms);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const isAbortError = (e: unknown, signal?: AbortSignal) =>
  Boolean(signal?.aborted || (e instanceof Error && e.name === "AbortError"));

/**
 * Generates (or regenerates) one slide, polling when another tab holds the short per-spec lock.
 */
export async function generateSlideWithLock(
  specId: string,
  regenerate: boolean,
  cb: SlideRunCallbacks,
): Promise<SlideRunResult> {
  if (cb.signal?.aborted) return { ok: false, rateLimited: false };
  const pollMs = cb.pollMs ?? SLIDE_BUSY_POLL_MS;
  const maxWaitMs = cb.maxWaitMs ?? SLIDE_BUSY_MAX_MS;
  cb.onStart(specId);
  try {
    let slide: Slide | null = null;
    for (let wait = 0; !slide; wait += pollMs) {
      if (cb.signal?.aborted) return { ok: false, rateLimited: false };
      try {
        slide = await cb.request(specId, regenerate, cb.signal);
      } catch (e) {
        if (isAbortError(e, cb.signal)) return { ok: false, rateLimited: false };
        // Another tab is writing this slide: wait for its result instead of paying for a second one.
        if (!(e instanceof ApiError && e.code === "SLIDE_IN_PROGRESS") || wait > maxWaitMs) throw e;
        regenerate = false;
        await abortableSleep(pollMs, cb.signal, cb.sleep);
      }
    }
    cb.onSlide(specId, slide);
    return { ok: true, rateLimited: false };
  } catch (e) {
    if (isAbortError(e, cb.signal)) return { ok: false, rateLimited: false };
    cb.onError(specId, e instanceof ApiError ? e.message : (e as Error).message);
    return { ok: false, rateLimited: e instanceof ApiError && e.status === 429 };
  } finally {
    cb.onDone(specId);
  }
}

export interface BatchConcurrencyOptions {
  initialConcurrency?: number;
  fallbackConcurrency?: number;
  signal?: AbortSignal;
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
    if (opts.signal?.aborted) break;
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
            if (opts.signal?.aborted) next = todo.length;
            if (next >= todo.length && inFlight === 0) {
              settled = true;
              resolve();
            } else {
              while (!opts.signal?.aborted && inFlight < concurrency && next < todo.length) {
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
        const onAbort = () => pump();
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        pump();
      });
    }
  }

  return { finalConcurrency: concurrency };
}
