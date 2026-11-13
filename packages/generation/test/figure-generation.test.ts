import { describe, expect, it } from "vitest";
import { createAiLayer } from "@kj/ai";
import { DEFAULT_PARAMS, type FigureCatalogEntry, type Outline, type SlideSpec } from "@kj/schema";
import { fakeAi } from "../../ai/test/fake.ts";
import {
  buildOutlineMessages,
  buildSlideMessages,
  draftOutline,
  problemsOf,
  sanitizeWidgets,
  stubSlide,
  writeSlide,
} from "../src/index.ts";

const stubAi = () =>
  createAiLayer({
    config: { load: async () => ({ active: null }) },
    meter: { record: async () => undefined },
    allowStubFallback: true,
  });

const figures: FigureCatalogEntry[] = [
  {
    assetId: "med_solenoid704",
    pageNo: 704,
    pageLabel: "704",
    label: "Fig 16.8",
    caption: "Magnetic field around a solenoid",
  },
  {
    assetId: "med_relay705",
    pageNo: 705,
    pageLabel: "705",
    label: "Fig 16.9",
    caption: "Electromagnetic relay circuit",
  },
];

const pages = [
  { no: 704, text: "A current-carrying solenoid produces a magnetic field pattern similar to a bar magnet. Inside the solenoid the field lines are parallel and uniform." },
  { no: 705, text: "An electromagnetic relay uses a small current in an electromagnet coil to switch a much larger current in a starter motor circuit." },
];

describe("textbook figure catalog in outline & slide generation", () => {
  it("injects per-page figure catalog into outline prompt, plans figure visuals when focus asks for textbook images, and downgrades figure when no figures exist", async () => {
    const msgs = buildOutlineMessages({
      lessonTitle: "16.2 Magnetic fields",
      params: { ...DEFAULT_PARAMS, focus: "重点知识用红色字体加粗，直接用书本上的图片，文字精简" },
      sections: [{ title: "16.2 Magnetic fields", pageStart: 704, pageEnd: 705 }],
      pages,
      figures,
      ctx: { orgId: "o", userId: "u" },
    });
    expect(msgs[0]!.content).toMatch(/figure/i);
    expect(msgs[1]!.content).toContain("[p.704 Fig 16.8 (assetId: med_solenoid704): Magnetic field around a solenoid]");
    expect(msgs[1]!.content).toContain("[p.705 Fig 16.9 (assetId: med_relay705): Electromagnetic relay circuit]");

    // Stub planner selects visual: "figure" when textbook figures exist on section pages:
    const stubDraft = await draftOutline(stubAi(), {
      lessonTitle: "16.2 Magnetic fields",
      params: { ...DEFAULT_PARAMS, minutes: 30, focus: "直接用书本上的图片" },
      sections: [{ title: "16.2 Magnetic fields", pageStart: 704, pageEnd: 705 }],
      pages,
      figures,
      ctx: { orgId: "o", userId: "u" },
    });
    expect(stubDraft.outline.slides.some((s) => s.visual === "figure")).toBe(true);

    // Without figures, a model output requesting visual: "figure" normalizes back to default visual:
    const hallucinatedVisualOutline = {
      objectives: ["Describe solenoid fields"],
      slides: [
        { pageType: "cover", title: "Solenoids", minutes: 1, visual: "none", loop: 0 },
        { pageType: "concept", title: "Solenoid magnetic field", minutes: 3, visual: "figure", loop: 1, sourcePages: [704] },
        { pageType: "exit", title: "Exit check", minutes: 3, visual: "none", loop: 0, sourcePages: [704] },
      ],
    };
    const noFigDraft = await draftOutline(fakeAi([hallucinatedVisualOutline]).ai, {
      lessonTitle: "16.2 Magnetic fields",
      params: DEFAULT_PARAMS,
      sections: [{ title: "16.2 Magnetic fields", pageStart: 704, pageEnd: 705 }],
      pages,
      ctx: { orgId: "o", userId: "u" },
      options: { outlineCheckRetry: false },
    });
    expect(noFigDraft.outline.slides[1]!.visual).toBe("formula");
  });

  it("passes cited-page figures into slide prompt, supports stubSlide figure output, and retries/sanitizes hallucinated assetIds", async () => {
    const spec704: SlideSpec = {
      id: "sp2",
      pageType: "concept",
      layout: "statement",
      title: "A solenoid produces a bar-magnet field pattern",
      purpose: "Show solenoid field lines",
      keyPoints: ["Uniform parallel field inside", "Poles at ends"],
      visual: "figure",
      minutes: 3,
      sourcePages: [704],
      loop: 1,
    };
    const outline: Outline = {
      objectives: ["Sketch magnetic field around a solenoid"],
      slides: [spec704],
      glossary: [{ term: "solenoid", zh: "螺线管" }],
      notCovered: [],
    };

    const [sys, user] = buildSlideMessages(
      spec704,
      {
        lessonTitle: "16.2 Magnetic fields",
        params: { ...DEFAULT_PARAMS, focus: "多用书本原图 textbook figures" },
        pages,
        figures,
        ctx: { orgId: "o", userId: "u" },
      },
      outline,
    );
    expect(sys!.content).toContain('"kind":"figure"');
    expect(user!.content).toContain("[p.704 Fig 16.8 (assetId: med_solenoid704): Magnetic field around a solenoid]");
    // Page 705 figure is NOT cited on spec704, so cited-page filtering keeps context focused:
    expect(user!.content).not.toContain("med_relay705");

    // stubSlide picks the real figure on p.704:
    const stubOut = stubSlide({
      spec: spec704,
      outline,
      lessonTitle: "16.2 Magnetic fields",
      pages: [pages[0]!],
      figures,
    });
    expect(stubOut.content.layout === "statement" && stubOut.content.visual).toMatchObject({
      kind: "figure",
      assetId: "med_solenoid704",
    });
    expect(problemsOf(stubOut.content, "concept", stubOut.notes, { knownAssetIds: new Set(["med_solenoid704"]) }).errors).toEqual([]);

    // LLM hallucinates unknown assetId on turn 1 -> retries -> turn 2 uses valid assetId:
    const badReply = {
      content: {
        layout: "statement" as const,
        title: "Solenoid field lines are uniform inside",
        bullets: ["Field lines are parallel inside", "Outside resembles a bar magnet"],
        visual: { kind: "figure" as const, assetId: "med_Hallucinated99", caption: "Fig 16.8" },
        terms: [{ term: "solenoid", zh: "螺线管" }],
      },
      notes: "Point out the parallel field lines inside the coil (3 min).",
    };
    const goodReply = {
      ...badReply,
      content: {
        ...badReply.content,
        visual: { kind: "figure" as const, assetId: "med_solenoid704", caption: "Fig 16.8: Magnetic field around a solenoid" },
      },
    };
    const ai1 = fakeAi([badReply, goodReply]);
    const res1 = await writeSlide(ai1.ai, outline, "sp2", {
      lessonTitle: "16.2 Magnetic fields",
      params: DEFAULT_PARAMS,
      pages,
      figures,
      ctx: { orgId: "o", userId: "u" },
    });
    expect(ai1.requests).toHaveLength(2);
    expect(ai1.requests[1]!.at(-1)!.content).toContain("unknown figure assetId");
    expect(res1.content.layout === "statement" && res1.content.visual).toEqual({
      kind: "figure",
      assetId: "med_solenoid704",
      caption: "Fig 16.8: Magnetic field around a solenoid",
    });

    // LLM hallucinates unknown assetId on BOTH turns when lesson has NO figures on cited page -> falls back to placeholder:
    const ai2 = fakeAi([badReply, badReply]);
    const res2 = await writeSlide(ai2.ai, outline, "sp2", {
      lessonTitle: "16.2 Magnetic fields",
      params: DEFAULT_PARAMS,
      pages,
      figures: [],
      ctx: { orgId: "o", userId: "u" },
    });
    expect(res2.content.layout === "statement" && res2.content.visual.kind).toBe("placeholder");
    expect(res2.warnings.some((w) => w.includes("图示待补"))).toBe(true);

    // sanitizeWidgets snaps hallucinated assetId to single available figure on cited page when fallbackFigures provided:
    const snapped = sanitizeWidgets(badReply.content, {
      knownAssetIds: new Set(["med_solenoid704"]),
      fallbackFigures: [figures[0]!],
    });
    expect(snapped.content.layout === "statement" && snapped.content.visual).toMatchObject({
      kind: "figure",
      assetId: "med_solenoid704",
    });
  });
});
