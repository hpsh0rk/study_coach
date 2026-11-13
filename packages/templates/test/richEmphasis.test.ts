// @vitest-environment happy-dom
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { renderRichText, renderSlide } from "../src/render/index.ts";

const CSS_PATH = path.resolve(__dirname, "../src/render/slides.css");

describe("renderRichText & slides.css inline emphasis", () => {
  it("renders ==...== as <strong class='kj-em-red'> and **...** as <strong> while tokenizing $...$ math first", () => {
    const host = document.createElement("div");
    renderRichText(host, "Compare $x^{**} + y == 0$ with ==magnetic field lines== and **north pole**.");

    const mathNodes = host.querySelectorAll(".kj-math");
    expect(mathNodes).toHaveLength(1);

    const redStrong = host.querySelectorAll("strong.kj-em-red");
    expect(redStrong).toHaveLength(1);
    expect(redStrong[0]!.textContent).toBe("magnetic field lines");

    const allStrong = [...host.querySelectorAll("strong")];
    expect(allStrong).toHaveLength(2);
    expect(allStrong[1]!.classList.contains("kj-em-red")).toBe(false);
    expect(allStrong[1]!.textContent).toBe("north pole");
    const nonMathText = [...host.childNodes]
      .filter((n) => !(n instanceof HTMLElement && n.classList.contains("kj-math")))
      .map((n) => n.textContent)
      .join("");
    expect(nonMathText).not.toContain("==");
    expect(nonMathText).not.toContain("**");
    expect(mathNodes[0]!.textContent).toContain("0");
  });

  it("renders inline $...$ KaTeX math nested inside ==...== and **...** spans", () => {
    const host = document.createElement("div");
    renderRichText(host, "Core law: ==Force $F = ma$== and **wave speed $v = f\\lambda$**");

    const red = host.querySelector("strong.kj-em-red");
    expect(red).not.toBeNull();
    expect(red!.querySelector(".kj-math")).not.toBeNull();
    expect(red!.textContent).toContain("Force ");

    const bold = [...host.querySelectorAll("strong")].find((el) => !el.classList.contains("kj-em-red"));
    expect(bold).toBeDefined();
    expect(bold!.querySelector(".kj-math")).not.toBeNull();
  });

  it("builds DOM nodes with zero innerHTML injection risk on untrusted HTML strings", () => {
    const host = document.createElement("div");
    renderRichText(host, "==<img src=x onerror=alert(1)>== and **<script>window.__xss=1</script>** & <b>raw</b>");

    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("b")).toBeNull();
    expect(host.querySelector("strong.kj-em-red")!.textContent).toBe("<img src=x onerror=alert(1)>");
    const bold = [...host.querySelectorAll("strong")].find((el) => !el.classList.contains("kj-em-red"))!;
    expect(bold.textContent).toBe("<script>window.__xss=1</script>");
    expect(host.textContent).toContain("& <b>raw</b>");
  });

  it("defines theme-aware #c81e1e (classic) and #ff7b72 (chalk) colors for .kj-em-red in slides.css and renders across slide slots", () => {
    const css = fs.readFileSync(CSS_PATH, "utf8");
    expect(css).toMatch(/\.kj-theme-classic\s*\{[\s\S]*?--kj-em-red:\s*#c81e1e/i);
    expect(css).toMatch(/\.kj-theme-chalk\s*\{[\s\S]*?--kj-em-red:\s*#ff7b72/i);
    expect(css).toMatch(/\.kj-em-red\s*\{[\s\S]*?color:\s*var\(--kj-em-red/i);

    const rendered = renderSlide(
      {
        content: {
          layout: "statement",
          title: "Permanent magnets",
          bullets: ["==Steel== retains magnetism", "**Soft iron** loses magnetism quickly"],
          visual: { kind: "table", columns: ["Material", "Property"], rows: [["==Steel==", "**Hard**"]] },
          terms: [{ term: "coercivity", zh: "矫顽力" }],
        },
        sources: [698],
      },
      { theme: "classic", interactive: false },
    );
    expect(rendered.el.querySelectorAll("strong.kj-em-red")).toHaveLength(2);
    expect(rendered.el.querySelectorAll("strong")).toHaveLength(4);
    rendered.dispose();
  });
});
