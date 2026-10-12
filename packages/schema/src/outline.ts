import { z } from "zod";
import { Id } from "./deck.ts";

export const OutlineItem = z.object({
  id: Id,
  kind: z.enum(["title", "content", "experiment", "summary"]),
  title: z.string().min(1),
  points: z.array(z.string()),
  chapterIds: z.array(z.string()),
  pageRange: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
});
export type OutlineItem = z.infer<typeof OutlineItem>;

export const OutlineVersion = z.object({
  id: Id,
  version: z.number().int().positive(),
  items: z.array(OutlineItem).min(1),
  contentHash: z.string(),
  source: z.enum(["fixed", "ai", "teacher"]),
  createdAt: z.number(),
});
export type OutlineVersion = z.infer<typeof OutlineVersion>;

/** Canonical JSON so that the confirmation hash is stable regardless of key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function outlineContentHash(items: OutlineItem[]): Promise<string> {
  return sha256Hex(canonicalJson(items));
}
