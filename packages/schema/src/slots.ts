import { z } from "zod";

/** What the LLM (or the stub) fills in. No coordinates, no ids (plan D6). */
export const SlideSlots = z.object({
  layout: z.enum(["title", "title-bullets", "title-bullets-terms"]),
  title: z.string().min(1).max(120),
  subtitle: z.string().max(200).optional(),
  bullets: z.array(z.string().min(1).max(300)).max(8).default([]),
  terms: z.array(z.object({ term: z.string().min(1), zh: z.string().min(1) })).max(6).default([]),
  notes: z.object({
    en: z.array(z.string()).default([]),
    zhTerms: z.array(z.object({ term: z.string(), zh: z.string(), note: z.string().optional() })).default([]),
  }),
});
export type SlideSlots = z.infer<typeof SlideSlots>;
