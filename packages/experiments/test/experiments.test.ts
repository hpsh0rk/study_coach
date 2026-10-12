import { describe, expect, it } from "vitest";
import { createExperimentRegistry, createPhetProvider, PHET_CATALOG, phetR2Key } from "../src/index.ts";

describe("experiments", () => {
  const registry = createExperimentRegistry([createPhetProvider()]);

  it("resolves PhET components to our own origin, with attribution", () => {
    const res = registry.resolve("phet", { componentId: "wave-on-a-string", locale: "zh_CN" });
    expect(res?.src).toBe("/sim/phet/wave-on-a-string?locale=zh_CN");
    expect(res?.attribution).toContain("PhET");
  });

  it("returns null for unknown providers or components", () => {
    expect(registry.resolve("ai_sim", { componentId: "x", locale: "en" })).toBeNull();
    expect(registry.resolve("phet", { componentId: "nope", locale: "en" })).toBeNull();
  });

  it("builds stable R2 keys", () => {
    expect(phetR2Key(PHET_CATALOG[0]!, "en")).toBe("sims/phet/wave-on-a-string/wave-on-a-string_en.html");
  });
});
