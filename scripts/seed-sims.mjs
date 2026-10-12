#!/usr/bin/env node
// Downloads the PhET catalog (en + zh_CN single-file HTML builds) and stores it in R2 so sims are
// served from our own origin; phet.colorado.edu is not reliably reachable from mainland China.
//   pnpm seed:sims [--remote] [--persist-to .wrangler/state] [--only wave-on-a-string] [--config path]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PHET_CATALOG, phetFileName, phetR2Key } from "../packages/experiments/src/index.ts";

const { values } = parseArgs({
  options: {
    remote: { type: "boolean", default: false },
    "persist-to": { type: "string" },
    only: { type: "string", multiple: true },
    config: { type: "string" },
    bucket: { type: "string", default: "study-coach-files" },
    refresh: { type: "boolean", default: false },
  },
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps/app");
const cacheDir = join(root, ".cache/phet");
mkdirSync(cacheDir, { recursive: true });

const items = PHET_CATALOG.filter((c) => !values.only || values.only.includes(c.id));
if (!items.length) throw new Error(`no catalog entries match --only ${values.only}`);

for (const c of items) {
  for (const locale of c.locales) {
    const file = phetFileName(c, locale);
    const local = join(cacheDir, file);
    if (values.refresh || !existsSync(local) || statSync(local).size === 0) {
      const url = `https://phet.colorado.edu/sims/html/${c.slug}/latest/${file}`;
      process.stdout.write(`download ${url} ... `);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      writeFileSync(local, Buffer.from(await res.arrayBuffer()));
      console.log(`${(statSync(local).size / 1e6).toFixed(1)} MB`);
    }
    const key = phetR2Key(c, locale);
    const args = ["wrangler", "r2", "object", "put", `${values.bucket}/${key}`, "--file", local, "--content-type", "text/html; charset=utf-8", values.remote ? "--remote" : "--local"];
    if (values["persist-to"]) args.push("--persist-to", resolve(values["persist-to"]));
    if (values.config) args.push("--config", values.config);
    execFileSync("npx", args, { cwd: appDir, stdio: ["ignore", "ignore", "inherit"] });
    console.log(`put r2://${values.bucket}/${key}`);
  }
}
console.log(`Seeded ${items.length} PhET sims (${values.remote ? "remote" : "local"} R2).`);
