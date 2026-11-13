// @vitest-environment happy-dom
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inlineMedia } from "@kj/widgets/render";
import { renderSlide } from "../src/render/index.ts";

const CSS_PATH = path.resolve(__dirname, "../src/render/slides.css");

afterEach(() => {
  inlineMedia({});
});

describe("figure widget rendering across live web, student share, and offline inline media", () => {
  it("renders <figure class='kj-figure'> with object-fit: contain <img> and rich-text <figcaption>", () => {
    const css = fs.readFileSync(CSS_PATH, "utf8");
    expect(css).toMatch(/\.kj-figure-img\s*\{[\s\S]*?object-fit:\s*contain/i);

    const rendered = renderSlide(
      {
        content: {
          layout: "statement",
          title: "Solenoid magnetic field resembles a bar magnet",
          bullets: ["Parallel uniform field inside"],
          visual: {
            kind: "figure",
            assetId: "med_solenoid704",
            caption: "**Fig 16.8**: Magnetic field around a ==solenoid== ($B$)",
            alt: "Solenoid field diagram",
          },
          terms: [],
        },
        sources: [704],
      },
      { theme: "classic", interactive: true },
    );

    const fig = rendered.el.querySelector("figure.kj-figure");
    expect(fig).not.toBeNull();
    const img = fig!.querySelector("img.kj-figure-img") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("/api/media/med_solenoid704");
    expect(img.getAttribute("alt")).toBe("Solenoid field diagram");

    const cap = fig!.querySelector("figcaption.kj-figure-caption");
    expect(cap).not.toBeNull();
    expect(cap!.querySelector("strong.kj-em-red")?.textContent).toBe("solenoid");
    expect(cap!.querySelector(".kj-math")).not.toBeNull();
  });

  it("appends ?share=<token> when shareToken is provided in RenderOptions, and prefers inlineMedia data URLs when offline", () => {
    const shared = renderSlide(
      {
        content: {
          layout: "chart",
          title: "Plotting compass trace",
          chart: { kind: "figure", assetId: "med_compass703", caption: "Fig 16.4" },
          takeaways: ["Field runs North to South"],
          source: "p.703",
        },
        sources: [703],
      },
      { theme: "classic", interactive: true, shareToken: "shr_tok_abc123" },
    );
    const sharedImg = shared.el.querySelector("img.kj-figure-img")!;
    expect(sharedImg.getAttribute("src")).toBe("/api/media/med_compass703?share=shr_tok_abc123");

    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    inlineMedia({ med_compass703: dataUrl });
    const offline = renderSlide(
      {
        content: {
          layout: "chart",
          title: "Plotting compass trace",
          chart: { kind: "figure", assetId: "med_compass703", caption: "Fig 16.4" },
          takeaways: ["Field runs North to South"],
          source: "p.703",
        },
        sources: [703],
      },
      { theme: "classic", interactive: true },
    );
    expect(offline.el.querySelector("img.kj-figure-img")!.getAttribute("src")).toBe(dataUrl);
  });
});
