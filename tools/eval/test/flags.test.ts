import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS } from "@kj/generation";
import { DEFAULT_FLAGS, parseFlags, pipelineOptions } from "../src/flags.ts";
import { providerFromEnv } from "../src/run.ts";

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

describe("real eval provider configuration", () => {
  it("supports the same Messages protocol, max-token, and custom-header settings as production", () => {
    const configured = providerFromEnv({
      KJ_EVAL_API_KEY: "local-secret",
      KJ_EVAL_PROVIDER: "custom",
      KJ_EVAL_MODEL: "model-1",
      KJ_EVAL_BASE_URL: "https://gateway.example/v1",
      KJ_EVAL_PROTOCOL: "messages",
      KJ_EVAL_MAX_TOKENS: "8192",
      KJ_EVAL_HEADERS_JSON: '{"x-source":"manual-eval"}',
    });
    expect(configured).toMatchObject({
      label: "custom/model-1 (messages)",
      config: {
        active: {
          model: "model-1",
          provider: {
            baseUrl: "https://gateway.example/v1",
            protocol: "messages",
            maxTokens: 8192,
            headers: { "x-source": "manual-eval" },
          },
        },
      },
    });
  });

  it("rejects malformed protocol and header configuration before making calls", () => {
    const base = { KJ_EVAL_API_KEY: "x", KJ_EVAL_PROVIDER: "custom", KJ_EVAL_MODEL: "m", KJ_EVAL_BASE_URL: "https://gateway.example" };
    expect(() => providerFromEnv({ ...base, KJ_EVAL_PROTOCOL: "other" })).toThrow();
    expect(() => providerFromEnv({ ...base, KJ_EVAL_HEADERS_JSON: '["not","an","object"]' })).toThrow();
  });
});
