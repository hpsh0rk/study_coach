import { describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.ts";

describe("textbook module boundary", () => {
  // dependency-cruiser sees files, not exports: a re-export from db/schema.ts would bypass textbook-tables-are-private.
  it("db/schema.ts does not re-export the textbook tables", () => {
    expect(Object.keys(schema).filter((k) => ["documents", "pages", "chapters"].includes(k))).toEqual([]);
  });
});
