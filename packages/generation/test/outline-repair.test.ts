import { describe, expect, it } from "vitest";
import { checkOutline, MAX_LECTURE_RUN, PAGE_TYPES } from "@kj/pedagogy";
import { DEFAULT_PARAMS, type PageType, type SlideSpec } from "@kj/schema";
import { checkSourcePages, enforceCheckCadence, normalizeOutline, rebalanceMinutes } from "../src/index.ts";

const spec = (id: string, pageType: PageType, minutes: number, extra: Partial<SlideSpec> = {}): SlideSpec => ({
  id,
  pageType,
  layout: "statement",
  title: `Slide ${id}`,
  purpose: "",
  keyPoints: [],
  visual: "none",
  minutes,
  sourcePages: [1],
  loop: 1,
  ...extra,
});

const longestLectureRun = (slides: SlideSpec[]) => {
  let run = 0;
  let max = 0;
  for (const s of slides) {
    const mode = PAGE_TYPES[s.pageType].mode;
    if (mode === "lecture") max = Math.max(max, (run += s.minutes));
    else if (mode === "practice") run = 0;
  }
  return max;
};

describe("check cadence (planner-enforced)", () => {
  it("inserts a check page before a lecture page that would push the run past 10 minutes", () => {
    const slides = [spec("a", "cover", 0.5), spec("b", "concept", 3.5), spec("c", "process", 4), spec("d", "worked", 4, { title: "Worked: wave speed" }), spec("e", "exit", 3)];
    const out = enforceCheckCadence(slides);
    expect(out.map((s) => s.pageType)).toEqual(["cover", "concept", "process", "check", "worked", "exit"]);
    const cfu = out[3]!;
    expect(cfu.id).toBe("cfu1");
    expect(cfu.layout).toBe("quiz");
    expect(cfu.title).toBe("Check: Slide c");
    expect(cfu.minutes).toBe(PAGE_TYPES.check.minutes);
    expect(longestLectureRun(out)).toBeLessThanOrEqual(MAX_LECTURE_RUN);
  });

  it("titles the check in Chinese for a Chinese lesson and keeps ids unique", () => {
    const slides = [spec("cfu1", "concept", 3.5, { title: "机械波" }), spec("x", "process", 4, { title: "横波与纵波" }), spec("y", "concept", 3.5)];
    const out = enforceCheckCadence(slides);
    expect(out[2]!.title).toBe("检查理解：横波与纵波");
    expect(new Set(out.map((s) => s.id)).size).toBe(out.length);
  });

  it("leaves an outline alone when practice pages already break the runs", () => {
    const slides = [spec("a", "concept", 3.5), spec("b", "process", 4), spec("c", "check", 2), spec("d", "worked", 4), spec("e", "concept", 3.5)];
    expect(enforceCheckCadence(slides)).toEqual(slides);
  });

  it("normalize and rebalance both leave no check-cadence warning", () => {
    const draft = {
      objectives: ["Describe waves"],
      slides: (["cover", "concept", "concept", "process", "data", "worked", "summary", "exit"] as const).map((pageType, i) => ({
        pageType,
        title: `Page ${i}`,
        purpose: "",
        keyPoints: [],
        visual: "none" as const,
        minutes: PAGE_TYPES[pageType].range[1],
        sourcePages: [1],
        loop: 1,
      })),
    };
    const outline = normalizeOutline(draft, { validPages: [1], simAvailable: false });
    expect(checkOutline(outline, DEFAULT_PARAMS).filter((v) => v.code === "check-cadence")).toEqual([]);
    const balanced = rebalanceMinutes(outline, { ...DEFAULT_PARAMS, minutes: 80 });
    expect(longestLectureRun(balanced.slides)).toBeLessThanOrEqual(MAX_LECTURE_RUN);
  });
});

const pages = [
  { no: 4, text: "Transverse waves: particles oscillate perpendicular to the direction of travel, as on a rope or string." },
  { no: 5, text: "Longitudinal waves: compressions and rarefactions travel through air; sound is a longitudinal wave." },
  { no: 6, text: "The wave equation relates speed, frequency and wavelength: v = f λ. Frequency is measured in hertz." },
];

describe("source-page check (待核实, never silent)", () => {
  it("flags an out-of-range page and suggests the best-matching page of the selection", () => {
    const [s] = checkSourcePages([spec("a", "concept", 3, { title: "Sound is a longitudinal wave", keyPoints: ["compressions and rarefactions travel through air"], sourcePages: [185] })], [4, 5, 6], pages);
    expect(s!.sourcePages).toEqual([5]);
    expect(s!.sourceIssue).toEqual({ kind: "out-of-range", cited: [185], suggested: [5] });
  });

  it("keeps valid pages when only some are out of range, and still flags", () => {
    const [s] = checkSourcePages([spec("a", "concept", 3, { sourcePages: [6, 99] })], [4, 5, 6], pages);
    expect(s!.sourcePages).toEqual([6]);
    expect(s!.sourceIssue?.kind).toBe("out-of-range");
    expect(s!.sourceIssue?.cited).toEqual([99]);
  });

  it("flags a shifted page whose text does not match while another page clearly does", () => {
    const [s] = checkSourcePages(
      [spec("a", "concept", 3, { title: "Wave equation: speed, frequency and wavelength", keyPoints: ["Frequency measured in hertz"], sourcePages: [4] })],
      [4, 5, 6],
      pages,
    );
    expect(s!.sourcePages).toEqual([4]);
    expect(s!.sourceIssue).toEqual({ kind: "mismatch", cited: [4], suggested: [6] });
  });

  it("does not flag correctly cited pages, spreading pages or slides with too little text", () => {
    const slides = [
      spec("a", "concept", 3, { title: "Wave equation: speed, frequency and wavelength", keyPoints: ["Frequency measured in hertz"], sourcePages: [6] }),
      spec("b", "concept", 3, { title: "Transverse waves on a rope", keyPoints: ["particles oscillate perpendicular to travel"], sourcePages: [4, 5] }),
      spec("c", "summary", 2, { title: "Sound is a longitudinal wave", keyPoints: ["compressions and rarefactions"], sourcePages: [4] }),
      spec("d", "concept", 3, { title: "Hertz", sourcePages: [4] }),
    ];
    expect(checkSourcePages(slides, [4, 5, 6], pages).map((s) => s.sourceIssue)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("without page text, falls back to the previous slide's pages for an out-of-range citation", () => {
    const out = checkSourcePages([spec("a", "concept", 3, { sourcePages: [5] }), spec("b", "concept", 3, { sourcePages: [300] })], [4, 5, 6]);
    expect(out[1]!.sourcePages).toEqual([5]);
    expect(out[1]!.sourceIssue).toEqual({ kind: "out-of-range", cited: [300], suggested: [5] });
  });
});
