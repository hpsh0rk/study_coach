/**
 * Exports deck JSONs (tools/eval output, or the templates gallery with --gallery) to .pptx files.
 *
 *   tsx packages/pptx/scripts/export-decks.ts --out <dir> [--gallery] [deck.json ...]
 *
 * Prints a JSON summary per file: slide count, degraded slides, estimated overflow.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { galleryCells } from "@kj/templates/testing";
import type { ThemeId } from "@kj/schema";
import { exportPptx, type PptxDeck } from "../src/index.ts";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1]! : "pptx-out";
const files = args.filter((a, i) => !a.startsWith("--") && i !== outIdx + 1);
fs.mkdirSync(out, { recursive: true });

const decks: { name: string; deck: PptxDeck }[] = [];
if (args.includes("--gallery"))
  for (const theme of ["classic", "chalk"] as ThemeId[])
    decks.push({
      name: `gallery-${theme}`,
      deck: { title: `Gallery ${theme}`, theme, slides: galleryCells().map((c) => ({ content: c.content, notes: c.id, sources: [12], pageType: "concept" })) },
    });
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  decks.push({ name: path.basename(f, ".json"), deck: { title: d.lesson?.title ?? d.title ?? path.basename(f), theme: d.lesson?.theme ?? d.theme ?? "classic", pageLabels: d.lesson?.pageLabels ?? {}, slides: d.slides } });
}

for (const { name, deck } of decks) {
  const r = await exportPptx(deck);
  fs.writeFileSync(path.join(out, `${name}.pptx`), r.data);
  console.log(JSON.stringify({ name, slides: r.plans.length, bytes: r.data.byteLength, degraded: r.degraded.length, overflow: r.overflow }));
}
