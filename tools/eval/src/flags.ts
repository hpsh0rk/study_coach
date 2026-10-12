import { DEFAULT_OPTIONS, type PipelineOptions } from "@kj/generation";

/** ablation-plan §2: the pipeline options plus the switches that only exist in the eval driver. */
export interface AblationFlags extends PipelineOptions {
  scope: "selected" | "wholeDocument";
  outline: "on" | "skip";
  renderMode: "templates" | "freeHtml";
  autoConfirm: boolean;
}

export const DEFAULT_FLAGS: Readonly<AblationFlags> = Object.freeze({
  ...DEFAULT_OPTIONS,
  scope: "selected",
  outline: "on",
  renderMode: "templates",
  autoConfirm: true,
});

const CHOICES: Partial<Record<keyof AblationFlags, readonly string[]>> = {
  scope: ["selected", "wholeDocument"],
  outline: ["on", "skip"],
  renderMode: ["templates", "freeHtml"],
  visualPlanning: ["outline", "writer"],
  writerSource: ["pages", "none", "all"],
};

/** "writerSource=none,slideCheckRetry=false" → validated flags (unspecified keys = full pipeline). */
export function parseFlags(spec: string | undefined): AblationFlags {
  const flags: Record<string, unknown> = { ...DEFAULT_FLAGS };
  for (const part of (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, v = ""] = part.split("=", 2) as [keyof AblationFlags, string | undefined];
    if (!(k in DEFAULT_FLAGS)) throw new Error(`unknown flag "${k}"; known: ${Object.keys(DEFAULT_FLAGS).join(", ")}`);
    if (typeof DEFAULT_FLAGS[k] === "boolean") {
      if (v !== "true" && v !== "false") throw new Error(`flag ${k} must be true or false`);
      flags[k] = v === "true";
    } else {
      if (!CHOICES[k]!.includes(v)) throw new Error(`flag ${k} must be one of ${CHOICES[k]!.join(", ")}`);
      flags[k] = v;
    }
  }
  return flags as unknown as AblationFlags;
}

export function pipelineOptions(f: AblationFlags): PipelineOptions {
  const { scope: _s, outline: _o, renderMode: _r, autoConfirm: _a, ...options } = f;
  return options;
}
