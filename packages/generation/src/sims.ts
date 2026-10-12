import { findEmbed, type EmbedEntry } from "@kj/widgets";
import type { DraftInput } from "./types.ts";

/** The catalog simulation that fits the selection, if any. Experiment pages are only planned when one exists. */
export function simFor(input: Pick<DraftInput, "sections" | "pages">): EmbedEntry | undefined {
  const text = `${input.sections.map((s) => s.title).join(" ")} ${input.pages.map((p) => p.text).join(" ")}`;
  return findEmbed(text, 2);
}
