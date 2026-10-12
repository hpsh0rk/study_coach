import { z } from "zod";

const label = z.string().trim().max(60);

export const ChartSpec = z.object({
  kind: z.literal("chart"),
  type: z.enum(["bar", "line", "scatter"]),
  xLabel: label,
  yLabel: label,
  /** Category labels for bar/line charts; omitted for numeric x (scatter, numeric line). */
  categories: z.array(z.string().max(24)).max(12).optional(),
  series: z
    .array(
      z.object({
        name: z.string().max(40),
        /** Plain values align with `categories`; [x, y] pairs plot on a numeric x axis. */
        data: z.array(z.union([z.number(), z.tuple([z.number(), z.number()])])).min(1).max(200),
      }),
    )
    .min(1)
    .max(4),
  /** Index of the series to emphasise; the others are greyed (V-04). */
  focus: z.number().int().min(0).optional(),
});
export type ChartSpec = z.infer<typeof ChartSpec>;

export const FunctionParam = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,11}$/),
  label: z.string().max(30),
  min: z.number(),
  max: z.number(),
  step: z.number().positive(),
  value: z.number(),
});
export type FunctionParam = z.infer<typeof FunctionParam>;

/** y = f(x; params). With params it becomes an interactive slider plot. */
export const FunctionSpec = z.object({
  kind: z.literal("function"),
  expr: z.string().max(200),
  x: z.tuple([z.number(), z.number()]),
  y: z.tuple([z.number(), z.number()]).optional(),
  xLabel: label,
  yLabel: label,
  params: z.array(FunctionParam).max(3).default([]),
});
export type FunctionSpec = z.infer<typeof FunctionSpec>;

export const FlowSpec = z.object({
  kind: z.literal("flow"),
  steps: z.array(z.string().trim().min(1).max(40)).min(2).max(6),
});
export type FlowSpec = z.infer<typeof FlowSpec>;

export const FormulaSpec = z.object({
  kind: z.literal("formula"),
  /** KaTeX source, e.g. "v = f\\lambda". */
  tex: z.string().max(200),
  caption: z.string().max(80).optional(),
});
export type FormulaSpec = z.infer<typeof FormulaSpec>;

export const SimSpec = z.object({
  kind: z.literal("sim"),
  /** Key into EMBED_CATALOG; decks never store URLs. */
  embedId: z.string().max(60),
  caption: z.string().max(80).optional(),
});
export type SimSpec = z.infer<typeof SimSpec>;

export const VisualSpec = z.discriminatedUnion("kind", [ChartSpec, FunctionSpec, FlowSpec, FormulaSpec]);
export type VisualSpec = z.infer<typeof VisualSpec>;

export const ExperimentSim = z.discriminatedUnion("kind", [FunctionSpec, SimSpec]);
export type ExperimentSim = z.infer<typeof ExperimentSim>;

export const WidgetSpec = z.discriminatedUnion("kind", [ChartSpec, FunctionSpec, FlowSpec, FormulaSpec, SimSpec]);
export type WidgetSpec = z.infer<typeof WidgetSpec>;
