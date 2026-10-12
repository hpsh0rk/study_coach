import * as fs from "node:fs";
import * as path from "node:path";
import { AblationFlags } from "@kj/schema";

export function parseArgs(argv: string[]): { positional: string[]; opts: Record<string, string> } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (inline !== undefined) opts[k] = inline;
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) opts[k] = argv[++i]!;
    else opts[k] = "true";
  }
  return { positional, opts };
}

/** "writerSource=none,slideCheckRetry=false" → validated AblationFlags (unspecified keys = full pipeline). */
export function parseFlags(spec: string | undefined): AblationFlags {
  const raw: Record<string, unknown> = {};
  for (const part of (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split("=", 2) as [string, string | undefined];
    if (!(k in AblationFlags.shape)) throw new Error(`unknown flag "${k}"; known: ${Object.keys(AblationFlags.shape).join(", ")}`);
    raw[k] = v === "true" ? true : v === "false" ? false : v;
  }
  return AblationFlags.parse(raw);
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** Deck files in a results directory (one per scenario × run). */
export function deckFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^S\d+.*\.json$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}
