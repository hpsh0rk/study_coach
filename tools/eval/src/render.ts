/**
 * Renders every slide of every deck in a results directory in Chromium (the real templates + fonts)
 * and writes the measured overflowing slot ids back to slides[].overflow ([] = fits).
 *
 *   pnpm eval:render results/B0 [more dirs or deck files...] [--theme classic|chalk] [--no-build]
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium } from "@playwright/test";
import { deckFiles, parseArgs, readJson, writeJson } from "./common.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const DIST = path.join(ROOT, "apps/web/dist");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".svg": "image/svg+xml" };

function serveDist(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    let file = path.join(DIST, url);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

type Measure = (slides: { content: unknown; sources: number[] }[], theme: string) => Promise<(string[] | { error: string })[]>;
type Deck = { lesson?: { theme?: string }; slides: { content: unknown; sources?: number[]; overflow?: string[]; overflowError?: string }[] };

async function main(argv: string[]) {
  const { positional, opts } = parseArgs(argv);
  if (!positional.length) throw new Error("usage: pnpm eval:render <results dir | deck.json>... [--theme classic] [--no-build]");
  const files = positional.flatMap((p) => (fs.statSync(p).isDirectory() ? deckFiles(p) : [p]));
  // /dev/render only exists in builds made with KJ_DEV_PAGES=1.
  const hasRenderPage = fs.existsSync(path.join(DIST, "assets")) && fs.readdirSync(path.join(DIST, "assets")).some((f) => f.startsWith("RenderPage"));
  if (!opts["no-build"] || !hasRenderPage) {
    console.log("building apps/web …");
    execFileSync("pnpm", ["--filter", "@kj/web", "build"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, KJ_DEV_PAGES: "1" } });
  }
  const server = await serveDist();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  try {
    await page.goto(`${base}/dev/render`);
    await page.waitForFunction(() => document.body.dataset.measureReady === "1");
    let total = 0;
    let overflowing = 0;
    for (const file of files) {
      const deck = readJson<Deck>(file);
      const theme = (opts.theme ?? deck.lesson?.theme ?? "classic") as string;
      const input = deck.slides.map((s) => ({ content: s.content, sources: s.sources ?? [] }));
      const measure = (slides: typeof input) => page.evaluate(([s, t]) => (window as unknown as { kjMeasure: Measure }).kjMeasure(s, t), [slides, theme] as const);
      let results: Awaited<ReturnType<typeof measure>>;
      try {
        results = await measure(input);
      } catch {
        // A slide whose renderer throws (e.g. an invalid function expression) must not hide the rest.
        results = [];
        for (const slide of input) results.push(await measure([slide]).then((r) => r[0]!, (e: Error) => ({ error: `render threw: ${e.message.split("\n")[0]}` })));
      }
      let bad = 0;
      deck.slides.forEach((s, i) => {
        const r = results[i]!;
        if (Array.isArray(r)) {
          s.overflow = r;
          delete s.overflowError;
          if (r.length) bad++;
        } else {
          delete s.overflow;
          s.overflowError = r.error;
        }
      });
      writeJson(file, deck);
      total += deck.slides.length;
      overflowing += bad;
      console.log(`  ${path.basename(file)}: ${bad}/${deck.slides.length} slides overflow`);
    }
    console.log(`eval:render ${files.length} decks, ${overflowing}/${total} slides overflow (written to slides[].overflow)`);
  } finally {
    await browser.close();
    server.close();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
