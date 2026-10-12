import { beforeAll, describe, expect, it } from "vitest";
import { e, loggedIn, seedUser, type Client } from "./client.ts";

const TEXT = [
  "Waves carry energy from one place to another without moving matter. A transverse wave moves perpendicular to the direction of propagation.",
  "The wave speed equals frequency times wavelength, v = f λ. A longitudinal wave oscillates along the direction of propagation.",
  "Amplitude is the maximum displacement from equilibrium. The period T is the time for one complete oscillation; f = 1/T.",
  "Superposition: when two waves meet, displacements add. Constructive interference doubles amplitude; destructive interference cancels it.",
];

let teacher: Client;
let docId: string;

beforeAll(async () => {
  await seedUser("usr_r1", "reuse1", "Teach12345", { mustChange: false });
  await seedUser("usr_r2", "reuse2", "Teach12345", { mustChange: false });
  teacher = await loggedIn("reuse1", "Teach12345");
  const created = await teacher.req("POST", "/api/documents", {
    filename: "waves.pdf",
    title: "Waves",
    sizeBytes: 12345,
    pageCount: 12,
    hasTextLayer: true,
    chapters: [
      { id: "c0", parentId: null, level: 1, ord: 0, title: "13 Waves", pageStart: 1, pageEnd: 12, words: 600 },
      { id: "c1", parentId: "c0", level: 2, ord: 1, title: "13.1 Types of Waves", pageStart: 1, pageEnd: 4, words: 200 },
      { id: "c2", parentId: "c0", level: 2, ord: 2, title: "13.2 Wave Properties", pageStart: 5, pageEnd: 8, words: 200 },
      { id: "c3", parentId: "c0", level: 2, ord: 3, title: "13.3 Superposition", pageStart: 9, pageEnd: 12, words: 200 },
    ],
  });
  docId = created.json.id as string;
  await teacher.req("POST", `/api/documents/${docId}/pages`, { pages: Array.from({ length: 12 }, (_, i) => ({ no: i + 1, text: TEXT[i % TEXT.length]! })) });
});

const aiCalls = async (lessonId: string) => (await e.DB.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE lesson_id = ? AND capability = 'slide.write'").bind(lessonId).first<{ n: number }>())!.n;

describe("复制这节课到新学期 (duplicate)", () => {
  it("copies the confirmed outline and every slide (hand edits kept); revising regenerates only the changed slide", async () => {
    const lessonId = (await teacher.req("POST", "/api/lessons", { documentId: docId, chapterIds: ["c1", "c2"] })).json.lesson.id as string;
    const drafted = (await teacher.req("POST", `/api/lessons/${lessonId}/outline`)).json.version;
    const v = (await teacher.req("PUT", `/api/lessons/${lessonId}/outline-versions/${drafted.id}`, { outline: drafted.outline, rev: drafted.rev })).json.version;
    expect(v.rev).toBe(1);
    await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/confirm`, { ackOverBudget: true });
    for (const s of v.outline.slides) await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/slides/${s.id}/generate`);
    const slides = (await teacher.req("GET", `/api/lessons/${lessonId}`)).json.slides;
    const target = slides.find((s: any) => s.layout === "statement");
    const edited = (await teacher.req("PATCH", `/api/lessons/${lessonId}/slides/${target.id}`, { content: { ...target.content, title: "Hand-edited for this class" } })).json.slide;

    const share = await teacher.req("POST", `/api/lessons/${lessonId}/share`, { ack: true });
    expect(share.status).toBe(201);

    const other = await loggedIn("reuse2", "Teach12345");
    expect((await other.req("POST", `/api/lessons/${lessonId}/duplicate`, {})).status).toBe(404);

    const dup = await teacher.req("POST", `/api/lessons/${lessonId}/duplicate`, {});
    expect(dup.status).toBe(201);
    const copyId = dup.json.lesson.id as string;
    expect(copyId).not.toBe(lessonId);
    expect(dup.json.lesson.title).toBe(`${(await teacher.req("GET", `/api/lessons/${lessonId}`)).json.lesson.title}（新学期）`);
    expect(dup.json.confirmed.confirmedAt).not.toBeNull();
    expect(dup.json.confirmed.outline).toEqual(v.outline);
    expect(dup.json.confirmed.rev).toBe(0);
    expect(dup.json.share).toBeNull();
    expect((await e.DB.prepare("SELECT COUNT(*) AS n FROM share_links WHERE lesson_id = ?").bind(copyId).first<{ n: number }>())!.n).toBe(0);
    expect((await teacher.req("GET", `/api/lessons/${lessonId}`)).json.share.path).toBe(share.json.path);
    expect(dup.json.slides).toHaveLength(slides.length);
    expect(dup.json.slides.find((s: any) => s.specId === target.specId).content).toEqual(edited.content);
    expect(dup.json.slides.every((s: any) => s.canUndo === false)).toBe(true);
    expect(await aiCalls(copyId)).toBe(0);

    // Editing the copy never touches the original.
    const copied = dup.json.slides.find((s: any) => s.specId === target.specId);
    await teacher.req("PATCH", `/api/lessons/${copyId}/slides/${copied.id}`, { content: { ...copied.content, title: "New term wording" } });
    expect((await teacher.req("GET", `/api/lessons/${lessonId}`)).json.slides.find((s: any) => s.specId === target.specId).content.title).toBe("Hand-edited for this class");

    // Incremental revision of the copy: retitle one other slide; only that one needs the model.
    const changed = v.outline.slides.find((s: any) => s.layout === "statement" && s.id !== target.specId) ?? v.outline.slides.find((s: any) => s.id !== target.specId && s.layout !== "title");
    const r = (await teacher.req("POST", `/api/lessons/${copyId}/outline-versions/${dup.json.confirmed.id}/revise`)).json.version;
    const outline = { ...r.outline, slides: r.outline.slides.map((s: any) => (s.id === changed.id ? { ...s, title: `${s.title} — new term` } : s)) };
    await teacher.req("PUT", `/api/lessons/${copyId}/outline-versions/${r.id}`, { outline, rev: r.rev });
    const confirmed = (await teacher.req("POST", `/api/lessons/${copyId}/outline-versions/${r.id}/confirm`, { ackOverBudget: true })).json;
    expect(confirmed.slides).toHaveLength(slides.length - 1);
    expect(confirmed.slides.find((s: any) => s.specId === target.specId).content.title).toBe("New term wording");
    for (const s of outline.slides) await teacher.req("POST", `/api/lessons/${copyId}/outline-versions/${r.id}/slides/${s.id}/generate`);
    expect(await aiCalls(copyId)).toBe(1);
  });

  it("a lesson with only a draft copies the draft", async () => {
    const lessonId = (await teacher.req("POST", "/api/lessons", { documentId: docId, chapterIds: ["c3"] })).json.lesson.id as string;
    await teacher.req("POST", `/api/lessons/${lessonId}/outline`);
    const dup = await teacher.req("POST", `/api/lessons/${lessonId}/duplicate`, { title: "Superposition 2027" });
    expect(dup.json.lesson.title).toBe("Superposition 2027");
    expect(dup.json.confirmed).toBeNull();
    expect(dup.json.draft.rev).toBe(0);
    expect(dup.json.slides).toEqual([]);
  });
});

describe("整单元规划 (unit)", () => {
  it("plans one chapter range as several lessons, chapters kept whole, reusing the wizard's empty lesson", async () => {
    const draft = (await teacher.req("POST", "/api/lessons", { documentId: docId, chapterIds: ["c0"] })).json.lesson.id as string;
    const before = (await teacher.req("GET", "/api/lessons")).json.lessons.length;
    // A dry run previews the split and creates nothing.
    const preview = await teacher.req("POST", "/api/lessons/unit?dryRun=1", { documentId: docId, chapterIds: ["c0", "c1", "c2", "c3"], count: 3, lessonId: draft, title: "13 Waves" });
    expect(preview.status).toBe(200);
    expect(preview.json.lessons).toHaveLength(3);
    expect(preview.json.lessons[0]).toMatchObject({ ranges: [{ start: 1, end: 4 }], estimatedMinutes: expect.any(Number), over: expect.any(Boolean) });
    expect((await teacher.req("GET", "/api/lessons")).json.lessons.length).toBe(before);
    expect((await teacher.req("GET", `/api/lessons/${draft}`)).json.lesson.scope.unit).toBeUndefined();
    const res = await teacher.req("POST", "/api/lessons/unit", { documentId: docId, chapterIds: ["c0", "c1", "c2", "c3"], count: 3, lessonId: draft, title: "13 Waves" });
    expect(res.status).toBe(201);
    expect(res.json.unit.count).toBe(3);
    expect(res.json.lessons.map((l: any) => l.ranges)).toEqual([[{ start: 1, end: 4 }], [{ start: 5, end: 8 }], [{ start: 9, end: 12 }]]);
    expect(res.json.lessons[0].id).toBe(draft);
    expect(res.json.lessons[1].title).toBe("13 Waves · 13.2 Wave Properties");
    expect(res.json.lessons.map((l: any) => l.title).join()).not.toMatch(/第 \d/);
    const second = (await teacher.req("GET", `/api/lessons/${res.json.lessons[1].id}`)).json.lesson;
    expect(second.scope.chapterIds).toEqual(["c2"]);
    expect(second.scope.unit).toMatchObject({ title: "13 Waves", index: 2, count: 3 });
    const list = (await teacher.req("GET", "/api/lessons")).json.lessons;
    expect(list.filter((l: any) => l.unit?.id === res.json.unit.id).map((l: any) => l.unit.index).sort()).toEqual([1, 2, 3]);

    // Changing a unit lesson's chapters keeps it in the unit.
    await teacher.req("PATCH", `/api/lessons/${second.id}`, { chapterIds: ["c2"], ranges: [{ start: 8, end: 9 }] });
    expect((await teacher.req("GET", `/api/lessons/${second.id}`)).json.lesson.scope.unit.index).toBe(2);
  });

  it("refuses to split a lesson that already has an outline, or a selection that fits one lesson", async () => {
    const lessonId = (await teacher.req("POST", "/api/lessons", { documentId: docId, chapterIds: ["c1"] })).json.lesson.id as string;
    await teacher.req("POST", `/api/lessons/${lessonId}/outline`);
    expect((await teacher.req("POST", "/api/lessons/unit", { documentId: docId, chapterIds: ["c1", "c2"], count: 2, lessonId })).status).toBe(409);
    expect((await teacher.req("POST", "/api/lessons/unit", { documentId: docId, chapterIds: ["c1"] })).status).toBe(400);
    const busy = (await teacher.req("POST", "/api/lessons", { documentId: docId, chapterIds: ["c2"] })).json.lesson.id as string;
    await e.DB.prepare("UPDATE lessons SET drafting_until = ? WHERE id = ?").bind(Date.now() + 60_000, busy).run();
    expect((await teacher.req("POST", "/api/lessons/unit", { documentId: docId, chapterIds: ["c1", "c2"], count: 2, lessonId: busy })).status).toBe(409);
  });
});
