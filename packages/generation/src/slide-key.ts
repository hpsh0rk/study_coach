import type { LessonParams, SlideSpec } from "@kj/schema";

/**
 * Everything `writeSlide` reads from a spec and the lesson params, in a fixed order. Two specs with the same
 * key would be written the same way, so a slide is reused across outline versions by this key. Lesson
 * length, type and focus are planner inputs only; the spec id, learning loop and 待核实 flag do not reach the writer.
 */
export function slideKeyInput(spec: SlideSpec, params: Pick<LessonParams, "level" | "language">): string {
  return JSON.stringify([spec.pageType, spec.layout, spec.title, spec.purpose, spec.keyPoints, spec.visual, spec.minutes, [...spec.sourcePages].sort((a, b) => a - b), params.level, params.language]);
}

export async function slideKey(spec: SlideSpec, params: Pick<LessonParams, "level" | "language">): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(slideKeyInput(spec, params)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
