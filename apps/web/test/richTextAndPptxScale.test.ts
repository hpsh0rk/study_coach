// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { RichText } from "../src/components/RichText.tsx";
import { lessonApi } from "../src/lessonApi.ts";
import { downloadPptx } from "../src/offline/exportPptx.ts";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("Web RichText & downloadPptx classroom fontScale", () => {
  it("renders ==red-bold==, **bold**, and $...$ math safely in <RichText /> and updates cleanly across prop changes", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(createElement(RichText, { text: "Rule: ==Force $F = ma$== and **north pole** <img src=x onerror=alert(1)>" }));
    });

    expect(container.querySelector("img")).toBeNull();
    const red = container.querySelector("strong.kj-em-red");
    expect(red).not.toBeNull();
    expect(red!.querySelector(".kj-math")).not.toBeNull();
    const bold = [...container.querySelectorAll("strong")].find((el) => !el.classList.contains("kj-em-red"));
    expect(bold?.textContent).toBe("north pole");

    // Prop update from ==...== to **...** and plain text should never fail React DOM reconciliation
    act(() => {
      root.render(createElement(RichText, { text: "Updated: ==30pt font== only" }));
    });
    expect(container.querySelectorAll("strong.kj-em-red")).toHaveLength(1);
    expect(container.querySelector("strong.kj-em-red")!.textContent).toBe("30pt font");

    act(() => root.unmount());
    container.remove();
  });

  it("auto-selects 30pt 'large' fontScale in downloadPptx when lesson focus asks for 30号 / large font, or when explicitly passed", async () => {
    const deckPayload = {
      lesson: {
        id: "les_1",
        title: "Chapter 16 Magnetism",
        theme: "classic",
        language: "en+zh",
        pageLabels: { 693: "693" },
      },
      slides: [
        {
          id: "sl_1",
          specId: "sp1",
          outlineVersionId: "ov_1",
          layout: "statement",
          pageType: "concept",
          minutes: 3,
          content: {
            layout: "statement",
            title: "Permanent magnets",
            bullets: ["==Steel== retains magnetism", "Soft iron demagnetises easily"],
            visual: { kind: "placeholder", hint: "Bar magnet" },
            terms: [{ term: "magnet", zh: "磁体" }],
          },
          notes: "Explain coercivity.",
          sources: [693],
          warnings: [],
        },
      ],
    };

    const deckSpy = vi.spyOn(lessonApi, "deck").mockResolvedValue(deckPayload as Record<string, unknown>);
    const getSpy = vi.spyOn(lessonApi, "get").mockResolvedValue({
      lesson: {
        id: "les_1",
        title: "Chapter 16 Magnetism",
        documentId: "doc_1",
        theme: "classic",
        params: { minutes: 60, level: "intermediate", lessonType: "new", language: "en+zh", focus: "整体大概在30号字体左右，重点知识用红色字体加粗" },
        scope: { chapterIds: [], ranges: [{ start: 693, end: 726 }] },
        scopeWords: 4900,
        emptyPages: [],
        unreadPages: [],
        createdAt: 1,
        updatedAt: 1,
      },
      draft: null,
      confirmed: null,
      slides: [],
      pageLabels: { 693: "693" },
      share: null,
      drafting: null,
    });
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock-pptx");
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    try {
      const autoResult = await downloadPptx("les_1");
      const autoBullets = autoResult.plans[0]!.items.find((i) => i.kind === "text" && i.slot === "bullets");
      expect(autoBullets?.kind === "text" && autoBullets.fontPx).toBe(60); // 30pt!
      expect(autoBullets?.kind === "text" && autoBullets.paras[0]!.runs[0]).toEqual({
        text: "Steel",
        bold: true,
        color: "C81E1E",
      });

      // Explicit override to "standard" keeps 56px (28pt) even when lesson focus mentions 30号
      const stdResult = await downloadPptx("les_1", { fontScale: "standard" });
      const stdBullets = stdResult.plans[0]!.items.find((i) => i.kind === "text" && i.slot === "bullets");
      expect(stdBullets?.kind === "text" && stdBullets.fontPx).toBe(56);
    } finally {
      deckSpy.mockRestore();
      getSpy.mockRestore();
      clickSpy.mockRestore();
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });
});
