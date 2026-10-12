import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Deck } from "../src/deck.ts";
import { ParsedDocument } from "../src/ingest.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = resolve(root, "containers/heavy/schema");
mkdirSync(outDir, { recursive: true });

for (const [name, schema] of [
  ["deck", Deck],
  ["parsed-document", ParsedDocument],
] as const) {
  const json = z.toJSONSchema(schema, { unrepresentable: "any" });
  writeFileSync(resolve(outDir, `${name}.schema.json`), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`wrote containers/heavy/schema/${name}.schema.json`);
}
