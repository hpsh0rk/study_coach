export { DEFAULT_OPTIONS, optionsOf, type PipelineOptions } from "./options.ts";
export type { DraftInput, PlannerSection } from "./types.ts";
export { buildMessages as buildOutlineMessages, draftOutline, normalizeOutline, OUTLINE_PROMPT_VERSION, OUTLINE_SOURCE_CHARS, rebalanceMinutes, type DraftResult } from "./outline.ts";
export { stubOutline } from "./outline-stub.ts";
export { simFor } from "./sims.ts";
export { buildMessages as buildSlideMessages, SLIDE_PROMPT_VERSION, SLIDE_SOURCE_CHARS, sourcePagesFor, SpecNotFoundError, workedSpecFor, writeSlide, type WriteInput, type WriteResult } from "./slide.ts";
export { findFormula, stubSlide } from "./slide-stub.ts";
export { applyGlossary, problemsOf, truncateLists } from "./checks.ts";
export { clip, sentencesOf } from "./text.ts";
