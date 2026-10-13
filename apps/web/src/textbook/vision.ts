import { ApiError } from "../api.ts";
import type { PastedPage } from "./api.ts";

export interface VisionDeps {
  /** The page as a JPEG data URL. */
  render(no: number): Promise<string>;
  read(no: number, image: string): Promise<{ page: PastedPage; reused: boolean }>;
}

export interface VisionOutcome {
  saved: PastedPage[];
  /** Pages the model did not read; the teacher can still paste them. */
  missed: number[];
  /** Why the run stopped early (paid parsing off, budget, quota, model busy), in the server's words. */
  stopped: string | null;
}

const STOPS = new Set([402, 403, 429, 503]);

/**
 * Reads pages one at a time through the vision model (the free models take one request at a time). A page
 * that fails is skipped; a refusal that will not change soon stops the run.
 */
export async function readWithVision(nos: number[], deps: VisionDeps, onProgress: (done: number, total: number) => void = () => undefined): Promise<VisionOutcome> {
  const out: VisionOutcome = { saved: [], missed: [], stopped: null };
  onProgress(0, nos.length);
  for (const [i, no] of nos.entries()) {
    try {
      out.saved.push((await deps.read(no, await deps.render(no))).page);
    } catch (err) {
      out.missed.push(no);
      if (err instanceof ApiError && STOPS.has(err.status)) {
        out.stopped = err.message;
        out.missed.push(...nos.slice(i + 1));
        break;
      }
    }
    onProgress(i + 1, nos.length);
  }
  return out;
}
