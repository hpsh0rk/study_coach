import { beforeAll, describe, expect, it } from "vitest";
import { Client, e, loggedIn, seedUser } from "./client.ts";

const PAGE_TEXT = [
  "Waves carry energy from one place to another without moving matter. A transverse wave moves perpendicular to the direction of propagation.",
  "The wave speed equals frequency times wavelength, v = f λ. A longitudinal wave oscillates along the direction of propagation.",
  "Amplitude is the maximum displacement from equilibrium. The period T is the time for one complete oscillation; f = 1/T.",
  "Superposition: when two waves meet, displacements add. Constructive interference doubles amplitude; destructive interference cancels it.",
];

async function uploadDoc(c: Client) {
  const pageCount = 8;
  const created = await c.req("POST", "/api/documents", {
    filename: "waves.pdf",
    title: "Waves",
    sizeBytes: 12345,
    pageCount,
    hasTextLayer: true,
    chapters: [
      { id: "c0", parentId: null, level: 1, ord: 0, title: "13 Waves", pageStart: 1, pageEnd: 8, words: 400 },
      { id: "c1", parentId: "c0", level: 2, ord: 1, title: "13.1 Types of Waves", pageStart: 1, pageEnd: 4, words: 200 },
      { id: "c2", parentId: "c0", level: 2, ord: 2, title: "13.2 Wave Properties", pageStart: 5, pageEnd: 8, words: 200 },
    ],
  });
  expect(created.status).toBe(201);
  const id = created.json.id as string;
  const pages = Array.from({ length: pageCount }, (_, i) => ({ no: i + 1, text: PAGE_TEXT[i % PAGE_TEXT.length]! }));
  const half = await c.req("POST", `/api/documents/${id}/pages`, { pages: pages.slice(0, 4) });
  expect(half.json.complete).toBe(false);
  const early = await c.req("POST", "/api/lessons", { documentId: id, chapterIds: ["c1"] });
  expect(early.status).toBe(409);
  const rest = await c.req("POST", `/api/documents/${id}/pages`, { pages: pages.slice(4) });
  expect(rest.json.complete).toBe(true);
  return id;
}

let teacher: Client;
let docId: string;

beforeAll(async () => {
  await seedUser("usr_t1", "teacher1", "Teach12345", { mustChange: false });
  await seedUser("usr_t2", "teacher2", "Teach12345", { mustChange: false });
  teacher = await loggedIn("teacher1", "Teach12345");
  docId = await uploadDoc(teacher);
});

describe("documents", () => {
  it("rejects scanned PDFs and keeps documents private", async () => {
    const scanned = await teacher.req("POST", "/api/documents", { filename: "s.pdf", title: "S", sizeBytes: 1, pageCount: 1, hasTextLayer: false, chapters: [] });
    expect(scanned.status).toBe(422);
    const other = await loggedIn("teacher2", "Teach12345");
    expect((await other.req("GET", `/api/documents/${docId}`)).status).toBe(404);
    const mine = await teacher.req("GET", `/api/documents/${docId}`);
    expect(mine.json.chapters).toHaveLength(3);
    expect(mine.json.pageWords).toHaveLength(8);
    expect(mine.json.pageWords[0]).toBeGreaterThan(10);
    expect((await teacher.req("GET", `/api/documents/${docId}/pages/2`)).json.text).toContain("v = f λ");
  });
});

describe("outline gate", () => {
  it("scopes chapters, drafts an outline and refuses generation until confirmed", async () => {
    const created = await teacher.req("POST", "/api/lessons", { documentId: docId, chapterIds: ["c1", "c2"] });
    expect(created.status).toBe(201);
    const lessonId = created.json.lesson.id as string;
    expect(created.json.lesson.scope.ranges).toEqual([{ start: 1, end: 8 }]);

    const params = { minutes: 40, level: "intermediate", lessonType: "new", language: "en+zh", focus: "" };
    expect((await teacher.req("PATCH", `/api/lessons/${lessonId}`, { params })).status).toBe(200);

    const drafted = await teacher.req("POST", `/api/lessons/${lessonId}/outline`);
    expect(drafted.status).toBe(201);
    const v = drafted.json.version;
    expect(v.confirmedAt).toBeNull();
    expect(v.timing.needsAck).toBe(false);
    const spec = v.outline.slides[2];

    // Gate 1: no slides from a draft outline.
    const early = await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/slides/${spec.id}/generate`);
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe("OUTLINE_NOT_CONFIRMED");

    // Gate 2: beyond ±15% needs an explicit acknowledgement.
    const stretched = { ...v.outline, slides: v.outline.slides.map((s: any) => (s.pageType === "practice" ? { ...s, minutes: 15 } : s)) };
    const edited = await teacher.req("PUT", `/api/lessons/${lessonId}/outline-versions/${v.id}`, { outline: stretched });
    expect(edited.status).toBe(200);
    expect(edited.json.version.timing.needsAck).toBe(true);
    const noAck = await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/confirm`, {});
    expect(noAck.status).toBe(409);
    expect(noAck.json.error.code).toBe("OVER_BUDGET_ACK_REQUIRED");
    const acked = await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/confirm`, { ackOverBudget: true });
    expect(acked.status).toBe(200);
    expect(acked.json.version.confirmedAt).toBeTypeOf("number");

    // Confirmed versions are immutable, through the API and in SQL.
    expect((await teacher.req("PUT", `/api/lessons/${lessonId}/outline-versions/${v.id}`, { outline: v.outline })).status).toBe(409);
    await expect(e.DB.prepare("UPDATE outline_versions SET outline = '{}' WHERE id = ?").bind(v.id).run()).rejects.toThrow(/OUTLINE_VERSION_IMMUTABLE/);
    await expect(e.DB.prepare("DELETE FROM outline_versions WHERE id = ?").bind(v.id).run()).rejects.toThrow(/OUTLINE_VERSION_IMMUTABLE/);

    // Generation now works and slides carry pageType + minutes.
    const gen = await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/slides/${spec.id}/generate`);
    expect(gen.status).toBe(200);
    expect(gen.json.slide.specId).toBe(spec.id);
    expect(gen.json.slide.pageType).toBe(spec.pageType);
    expect(gen.json.slide.minutes).toBe(spec.minutes);
    expect(gen.json.slide.content.layout).toBe(spec.layout);

    // A new draft version (revise) cannot generate until it is confirmed too.
    const revised = await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/revise`);
    expect(revised.status).toBe(201);
    const r = revised.json.version;
    expect(r.version).toBe(2);
    expect((await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${r.id}/slides/${spec.id}/generate`)).status).toBe(409);
    await expect(
      e.DB.prepare("INSERT INTO slides (id, lesson_id, outline_version_id, spec_id, spec_hash, layout, page_type, minutes, content, notes, sources, warnings, provider_id, updated_at) VALUES ('x', ?, ?, 'sp1', 'h', 'title', 'cover', 1, '{}', '', '[]', '[]', 'stub', 0)")
        .bind(lessonId, r.id)
        .run(),
    ).rejects.toThrow(/OUTLINE_NOT_CONFIRMED/);

    // Export + share (share hides speaker notes) + privacy.
    const deck = await teacher.req("GET", `/api/lessons/${lessonId}/deck`);
    expect(deck.json.slides).toHaveLength(1);
    expect(deck.json.slides[0].notes.length).toBeGreaterThan(0);
    const share = await teacher.req("POST", `/api/lessons/${lessonId}/share`);
    const pub = await new Client().req("GET", `/api/share/${share.json.token}`);
    expect(pub.status).toBe(200);
    expect(pub.json.slides[0].notes).toBe("");
    await teacher.req("DELETE", `/api/lessons/${lessonId}/share`);
    expect((await new Client().req("GET", `/api/share/${share.json.token}`)).status).toBe(404);
    const other = await loggedIn("teacher2", "Teach12345");
    expect((await other.req("GET", `/api/lessons/${lessonId}`)).status).toBe(404);
    expect((await other.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/slides/${spec.id}/generate`)).status).toBe(404);
  });

  it("falls back to page ranges when there are no chapters", async () => {
    const created = await teacher.req("POST", "/api/lessons", { documentId: docId, ranges: [{ start: 3, end: 5 }, { start: 5, end: 6 }] });
    expect(created.status).toBe(201);
    expect(created.json.lesson.scope.ranges).toEqual([{ start: 3, end: 6 }]);
    expect((await teacher.req("POST", "/api/lessons", { documentId: docId })).status).toBe(400);
  });
});

async function confirmedLesson(minutes = 40) {
  const created = await teacher.req("POST", "/api/lessons", { documentId: docId, chapterIds: ["c1", "c2"] });
  const lessonId = created.json.lesson.id as string;
  await teacher.req("PATCH", `/api/lessons/${lessonId}`, { params: { minutes, level: "intermediate", lessonType: "new", language: "en+zh", focus: "" } });
  const v = (await teacher.req("POST", `/api/lessons/${lessonId}/outline`)).json.version;
  expect((await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/confirm`, {})).status).toBe(200);
  return { lessonId, v };
}

const aiCalls = async (lessonId: string) => (await e.DB.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE lesson_id = ? AND capability = 'slide.write'").bind(lessonId).first<{ n: number }>())!.n;

describe("slide reuse, editing and snapshots", () => {
  it("generate is idempotent and revised versions keep unchanged slides", async () => {
    const { lessonId, v } = await confirmedLesson();
    const [a, b] = v.outline.slides.slice(1, 3);
    const url = (vid: string, sid: string) => `/api/lessons/${lessonId}/outline-versions/${vid}/slides/${sid}/generate`;
    const first = await teacher.req("POST", url(v.id, a.id));
    await teacher.req("POST", url(v.id, b.id));
    const calls = await aiCalls(lessonId);
    const again = await teacher.req("POST", url(v.id, a.id));
    expect(again.json.reused).toBe(true);
    expect(again.json.slide.id).toBe(first.json.slide.id);
    expect(await aiCalls(lessonId)).toBe(calls);

    // Revise: retitle slide b only, confirm. Slide a carries over without a model call; b does not.
    const r = (await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/revise`)).json.version;
    const outline = { ...r.outline, slides: r.outline.slides.map((s: any) => (s.id === b.id ? { ...s, title: `${s.title} (edited)` } : s)) };
    await teacher.req("PUT", `/api/lessons/${lessonId}/outline-versions/${r.id}`, { outline });
    const confirmed = await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${r.id}/confirm`, {});
    expect(confirmed.json.slides.map((s: any) => s.specId)).toEqual([a.id]);
    expect(confirmed.json.slides[0].content).toEqual(first.json.slide.content);
    expect((await teacher.req("POST", url(r.id, a.id))).json.reused).toBe(true);
    expect(await aiCalls(lessonId)).toBe(calls);
    expect((await teacher.req("POST", url(r.id, b.id))).json.reused).toBe(false);
    expect(await aiCalls(lessonId)).toBe(calls + 1);
  });

  it("edits slots with validation, regenerates on request and undoes one level", async () => {
    const { lessonId, v } = await confirmedLesson();
    const spec = v.outline.slides.find((s: any) => s.layout === "statement") ?? v.outline.slides[1];
    const url = `/api/lessons/${lessonId}/outline-versions/${v.id}/slides/${spec.id}/generate`;
    const slide = (await teacher.req("POST", url)).json.slide;
    expect(slide.canUndo).toBe(false);

    const bad = await teacher.req("PATCH", `/api/lessons/${lessonId}/slides/${slide.id}`, { content: { ...slide.content, layout: "quiz" } });
    expect(bad.status).toBe(422);
    const content = { ...slide.content, title: "Hand-edited title" };
    const edited = await teacher.req("PATCH", `/api/lessons/${lessonId}/slides/${slide.id}`, { content, notes: "My notes" });
    expect(edited.status).toBe(200);
    expect(edited.json.slide.content.title).toBe("Hand-edited title");
    expect(edited.json.slide.notes).toBe("My notes");
    expect(edited.json.slide.canUndo).toBe(true);

    const undone = await teacher.req("POST", `/api/lessons/${lessonId}/slides/${slide.id}/undo`);
    expect(undone.json.slide.content.title).toBe(slide.content.title);
    const redone = await teacher.req("POST", `/api/lessons/${lessonId}/slides/${slide.id}/undo`);
    expect(redone.json.slide.content.title).toBe("Hand-edited title");

    const regen = await teacher.req("POST", url, { regenerate: true });
    expect(regen.json.reused).toBe(false);
    expect(regen.json.slide.canUndo).toBe(true);
    const back = await teacher.req("POST", `/api/lessons/${lessonId}/slides/${slide.id}/undo`);
    expect(back.json.slide.content.title).toBe("Hand-edited title");
  });

  it("flags numbers that are not on the cited pages (待核实) and re-checks after edits and undo", async () => {
    const { lessonId, v } = await confirmedLesson();
    const spec = v.outline.slides.find((s: any) => s.layout === "statement");
    const slide = (await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/slides/${spec.id}/generate`)).json.slide;
    expect(Array.isArray(slide.unverified)).toBe(true);
    const content = { ...slide.content, bullets: ["Sound travels at 343 m/s in air"] };
    const edited = (await teacher.req("PATCH", `/api/lessons/${lessonId}/slides/${slide.id}`, { content, notes: "Check: d = 343 × 2 = 600 m" })).json.slide;
    expect(edited.unverified.map((u: any) => u.kind).sort()).toEqual(["calc", "number"]);
    expect(edited.unverified.find((u: any) => u.kind === "number").text).toBe("343");
    const deck = (await teacher.req("GET", `/api/lessons/${lessonId}/deck`)).json;
    expect(deck.slides.find((s: any) => s.id === slide.id).unverified).toHaveLength(2);
    const undone = (await teacher.req("POST", `/api/lessons/${lessonId}/slides/${slide.id}/undo`)).json.slide;
    expect(undone.unverified).toEqual(slide.unverified);
  });

  it("confirm and generate read the version's params snapshot, not later lesson settings", async () => {
    const { lessonId, v } = await confirmedLesson(40);
    expect(v.params.minutes).toBe(40);
    await teacher.req("PATCH", `/api/lessons/${lessonId}`, { params: { minutes: 90, level: "advanced", lessonType: "new", language: "en", focus: "" } });
    const view = (await teacher.req("GET", `/api/lessons/${lessonId}`)).json;
    expect(view.version.params.minutes).toBe(40);
    expect(view.version.timing.needsAck).toBe(false);
    const gen = await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/slides/${v.outline.slides[1].id}/generate`);
    expect(gen.status).toBe(200);
    const list = (await teacher.req("GET", "/api/lessons")).json.lessons;
    const row = list.find((l: any) => l.id === lessonId);
    expect(row.status).toBe("slides");
    expect(row.slides).toBe(1);
    expect(row.planned).toBe(v.outline.slides.length);
  });
});

describe("review #2 regressions", () => {
  const params = (focus: string) => ({ minutes: 40, level: "intermediate", lessonType: "new", language: "en+zh", focus });

  it("editing the focus (one punctuation mark) keeps every slide, hand-edited ones included, on revise and on a new draft", async () => {
    const created = await teacher.req("POST", "/api/lessons", { documentId: docId, chapterIds: ["c1", "c2"] });
    const lessonId = created.json.lesson.id as string;
    await teacher.req("PATCH", `/api/lessons/${lessonId}`, { params: params("重点讲 v = fλ 的计算") });
    const v = (await teacher.req("POST", `/api/lessons/${lessonId}/outline`)).json.version;
    await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/confirm`, { ackOverBudget: true });
    for (const s of v.outline.slides) expect((await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/slides/${s.id}/generate`)).status).toBe(200);
    const all = (await teacher.req("GET", `/api/lessons/${lessonId}`)).json.slides;
    expect(all).toHaveLength(v.outline.slides.length);
    const target = all.find((s: any) => s.layout === "statement");
    const edited = (await teacher.req("PATCH", `/api/lessons/${lessonId}/slides/${target.id}`, { content: { ...target.content, title: "惯性 inertia 是物体保持运动状态的性质" } })).json.slide;
    const calls = await aiCalls(lessonId);

    await teacher.req("PATCH", `/api/lessons/${lessonId}`, { params: params("重点讲 v = fλ 的计算。") });
    const r = (await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/revise`)).json.version;
    expect(r.params.focus).toBe("重点讲 v = fλ 的计算");
    const revised = (await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${r.id}/confirm`, { ackOverBudget: true })).json;
    expect(revised.slides).toHaveLength(v.outline.slides.length);
    expect(revised.slides.find((s: any) => s.specId === target.specId).content).toEqual(edited.content);

    const fresh = (await teacher.req("POST", `/api/lessons/${lessonId}/outline`)).json.version;
    expect(fresh.params.focus).toBe("重点讲 v = fλ 的计算。");
    const redrafted = (await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${fresh.id}/confirm`, { ackOverBudget: true })).json;
    expect(redrafted.slides).toHaveLength(fresh.outline.slides.length);
    expect(redrafted.slides.find((s: any) => s.specId === target.specId).content.title).toBe("惯性 inertia 是物体保持运动状态的性质");
    expect(await aiCalls(lessonId)).toBe(calls);
    expect((await teacher.req("GET", `/api/lessons/${lessonId}/deck`)).json.slides).toHaveLength(fresh.outline.slides.length);
  });

  it("PATCH rejects a visual that cannot be drawn and reports item errors behind a too-long list", async () => {
    const { lessonId, v } = await confirmedLesson();
    const spec = v.outline.slides.find((s: any) => s.layout === "statement");
    const slide = (await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/slides/${spec.id}/generate`)).json.slide;
    const visual = { kind: "function", expr: "sin(2*pi*x", x: [0, 4], xLabel: "x", yLabel: "y", params: [] };
    const broken = await teacher.req("PATCH", `/api/lessons/${lessonId}/slides/${slide.id}`, { content: { ...slide.content, visual } });
    expect(broken.status).toBe(422);
    expect(broken.json.error.detail[0].path).toEqual(["visual"]);
    const long = await teacher.req("PATCH", `/api/lessons/${lessonId}/slides/${slide.id}`, { content: { ...slide.content, bullets: ["a", "b", "c", "This bullet is much too long for the eight word budget"] } });
    expect(long.status).toBe(422);
    const paths = long.json.error.detail.map((i: any) => i.path.join("."));
    expect(paths).toContain("bullets");
    expect(paths).toContain("bullets.3");
  });

  it("flags edited out-of-range source pages as 待核实; the teacher can clear a flag but not forge one", async () => {
    const created = await teacher.req("POST", "/api/lessons", { documentId: docId, chapterIds: ["c1"] });
    const lessonId = created.json.lesson.id as string;
    const v = (await teacher.req("POST", `/api/lessons/${lessonId}/outline`)).json.version;
    const target = v.outline.slides.find((s: any) => s.pageType === "concept");
    const put = (slides: any[]) => teacher.req("PUT", `/api/lessons/${lessonId}/outline-versions/${v.id}`, { outline: { ...v.outline, slides } });
    const moved = (await put(v.outline.slides.map((s: any) => (s.id === target.id ? { ...s, sourcePages: [7] } : s)))).json.version;
    const flagged = moved.outline.slides.find((s: any) => s.id === target.id);
    expect(flagged.sourceIssue).toMatchObject({ kind: "out-of-range", cited: [7] });
    expect(flagged.sourcePages.every((p: number) => p >= 1 && p <= 4)).toBe(true);
    const other = moved.outline.slides.find((s: any) => s.id !== target.id && s.sourcePages.length);
    const forged = (await put(moved.outline.slides.map((s: any) => (s.id === other.id ? { ...s, sourceIssue: { kind: "mismatch", cited: [1], suggested: [2] } } : s)))).json.version;
    expect(forged.outline.slides.find((s: any) => s.id === other.id).sourceIssue).toBeUndefined();
    const cleared = (await put(forged.outline.slides.map((s: any) => (s.id === target.id ? { ...s, sourceIssue: undefined } : s)))).json.version;
    expect(cleared.outline.slides.find((s: any) => s.id === target.id).sourceIssue).toBeUndefined();
  });
});
