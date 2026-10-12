import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS } from "@kj/generation";
import { DEFAULT_FLAGS, parseFlags, pipelineOptions } from "../src/flags.ts";

describe("ablation flags", () => {
  it("defaults to the full pipeline", () => {
    expect(parseFlags(undefined)).toEqual(DEFAULT_FLAGS);
    expect(pipelineOptions(parseFlags(""))).toEqual(DEFAULT_OPTIONS);
  });

  it("parses booleans and choices, and passes only pipeline keys to the pipeline", () => {
    const f = parseFlags("writerSource=none, slideCheckRetry=false,outline=skip");
    expect(f).toMatchObject({ writerSource: "none", slideCheckRetry: false, outline: "skip" });
    expect(pipelineOptions(f)).toEqual({ ...DEFAULT_OPTIONS, writerSource: "none", slideCheckRetry: false });
  });

  it("rejects unknown flags and bad values", () => {
    expect(() => parseFlags("nope=true")).toThrow(/unknown flag/);
    expect(() => parseFlags("phases=yes")).toThrow(/true or false/);
    expect(() => parseFlags("writerSource=some")).toThrow(/one of/);
  });
});
