#!/usr/bin/env node
// Fails if code outside packages/ai talks to a model endpoint directly.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCAN = ["apps", "packages", "fixtures", "scripts"];
const ALLOWED = [join("packages", "ai") + sep, join("scripts", "check-ai-boundary.mjs")];
const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler", "migrations"]);
const EXT = /\.(ts|tsx|js|mjs|cjs)$/;
const FORBIDDEN = [
  [/chat\/completions/, "direct chat/completions call"],
  [/api\.deepseek\.com/, "DeepSeek endpoint"],
  [/bigmodel\.cn/, "GLM endpoint"],
  [/gateway\.ai\.cloudflare\.com/, "AI Gateway endpoint"],
  [/\benv\.AI\b/, "Workers AI binding"],
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (EXT.test(name)) yield p;
  }
}

const problems = [];
for (const top of SCAN) {
  for (const file of walk(join(root, top))) {
    const rel = relative(root, file);
    if (ALLOWED.some((a) => rel.startsWith(a) || rel === a)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const [re, what] of FORBIDDEN) if (re.test(line)) problems.push(`${rel}:${i + 1}: ${what} outside packages/ai`);
    });
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("ai boundary ok");
