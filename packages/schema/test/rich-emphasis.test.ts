import { describe, expect, it } from "vitest";
import { countHighlightedWords, countWords, stripRichMarkers, tokenizeRichText } from "../src/index.ts";

describe("rich inline emphasis tokenizer & word budgets", () => {
  it("tokenizes $...$ and $$...$$ math FIRST so ** and == inside math are never altered", () => {
    const tokens = tokenizeRichText("Check $x^{**} + y == 0$ and $a == 1$, plus ==key rule== and **bold term**.");
    expect(tokens).toEqual([
      { kind: "text", text: "Check " },
      { kind: "math", tex: "x^{**} + y == 0", display: false, raw: "$x^{**} + y == 0$" },
      { kind: "text", text: " and " },
      { kind: "math", tex: "a == 1", display: false, raw: "$a == 1$" },
      { kind: "text", text: ", plus " },
      { kind: "highlight", text: "key rule", children: [{ kind: "text", text: "key rule" }] },
      { kind: "text", text: " and " },
      { kind: "bold", text: "bold term", children: [{ kind: "text", text: "bold term" }] },
      { kind: "text", text: "." },
    ]);
  });

  it("supports inline $...$ math inside ==...== and **...** spans and unwraps nested **==...==** / ==**...**==", () => {
    const withMath = tokenizeRichText("Law: ==Force $F = ma$== and **speed $v = f\\lambda$**");
    expect(withMath).toEqual([
      { kind: "text", text: "Law: " },
      {
        kind: "highlight",
        text: "Force $F = ma$",
        children: [
          { kind: "text", text: "Force " },
          { kind: "math", tex: "F = ma", display: false, raw: "$F = ma$" },
        ],
      },
      { kind: "text", text: " and " },
      {
        kind: "bold",
        text: "speed $v = f\\lambda$",
        children: [
          { kind: "text", text: "speed " },
          { kind: "math", tex: "v = f\\lambda", display: false, raw: "$v = f\\lambda$" },
        ],
      },
    ]);

    expect(tokenizeRichText("**==重点规律==** 与 ==**牛顿第二定律**==")).toEqual([
      { kind: "highlight", text: "重点规律", children: [{ kind: "text", text: "重点规律" }] },
      { kind: "text", text: " 与 " },
      { kind: "highlight", text: "牛顿第二定律", children: [{ kind: "text", text: "牛顿第二定律" }] },
    ]);
  });

  it("keeps unclosed markers, spaced operators (a == b == c), empty ==== / ****, and multiline breaks as literal text", () => {
    expect(tokenizeRichText("a == b == c and 2 * 3 * 4")).toEqual([{ kind: "text", text: "a == b == c and 2 * 3 * 4" }]);
    expect(tokenizeRichText("unclosed ==phrase and **bold")).toEqual([{ kind: "text", text: "unclosed ==phrase and **bold" }]);
    expect(tokenizeRichText("==== and ****")).toEqual([{ kind: "text", text: "==== and ****" }]);
    expect(tokenizeRichText("==line 1\nline 2==")).toEqual([{ kind: "text", text: "==line 1\nline 2==" }]);
  });

  it("strips ** and == emphasis markers cleanly while preserving $...$ math and literal HTML characters", () => {
    expect(stripRichMarkers("==Magnetic field lines== run **N** to **S** ($B == \\mu_0 n I$)")).toBe(
      "Magnetic field lines run N to S ($B == \\mu_0 n I$)",
    );
    expect(tokenizeRichText("==A== to ==B== and **unclosed **valid**")).toEqual([
      { kind: "highlight", text: "A", children: [{ kind: "text", text: "A" }] },
      { kind: "text", text: " to " },
      { kind: "highlight", text: "B", children: [{ kind: "text", text: "B" }] },
      { kind: "text", text: " and **unclosed " },
      { kind: "bold", text: "valid", children: [{ kind: "text", text: "valid" }] },
    ]);
    expect(stripRichMarkers("==<img src=x onerror=alert(1)>==")).toBe("<img src=x onerror=alert(1)>");
  });

  it("ignores ** and == delimiters in countWords and counts highlighted word-equivalents accurately", () => {
    const plainWords = countWords("Steel is a hard magnetic material");
    expect(countWords("Steel is a ==hard magnetic material==")).toBe(plainWords);
    expect(countWords("**Steel** is a ==hard magnetic== material")).toBe(plainWords);
    expect(countWords("==牛顿第二定律==")).toBe(countWords("牛顿第二定律"));
    expect(countWords("==牛顿第二定律==")).toBe(4);

    expect(countHighlightedWords("Steel is a ==hard magnetic material==")).toBe(3);
    expect(countHighlightedWords("普通文字 **仅加粗** ==重点红字==")).toBe(countWords("重点红字"));
  });
});
