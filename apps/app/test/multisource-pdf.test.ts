import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeSourcePage, type LessonSource } from "@kj/schema";
import { MAX_PAGES } from "../src/routes/documents.ts";
import { e, loggedIn, seedUser, type Client } from "./client.ts";

const PNG_DATA_URL = `data:image/png;base64,${"iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB".repeat(4)}`;

let admin: Client;
let teacher: Client;

beforeAll(async () => {
  await seedUser("usr_ms_admin", "msadmin", "Admin12345", { role: "admin", mustChange: false });
  await seedUser("usr_ms_t1", "msteacher1", "Teach12345", { mustChange: false });
  admin = await loggedIn("msadmin", "Admin12345");
  teacher = await loggedIn("msteacher1", "Teach12345");
});

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await e.DB.prepare("DELETE FROM ai_providers").run();
});

describe("P0: MAX_PAGES = 2500, readable validation errors & sparse/incremental PDF import", () => {
  it("raises MAX_PAGES to 2500 and surfaces readable Chinese validation details instead of bare 'Invalid request'", async () => {
    expect(MAX_PAGES).toBe(2500);

    const tooMany = await teacher.req("POST", "/api/documents", {
      filename: "huge.pdf",
      title: "Huge Book",
      sizeBytes: 1000,
      pageCount: 2501,
      chapters: [],
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.json.error.code).toBe("VALIDATION");
    expect(tooMany.json.error.message).not.toBe("Invalid request");
    expect(tooMany.json.error.message).toMatch(/页数|pageCount/);
  });

  it("supports sparse partial import (p.693..696 of a 1,122-page book) and later incremental page upsert", async () => {
    const created = await teacher.req("POST", "/api/documents", {
      filename: "igcse-physics.pdf",
      title: "Cambridge IGCSE Physics",
      sizeBytes: 39_106_792,
      pageCount: 1122,
      chapters: [
        { id: "c16", parentId: null, level: 1, ord: 0, title: "16 Magnetism", pageStart: 693, pageEnd: 696, words: 80 },
        { id: "c17", parentId: null, level: 1, ord: 1, title: "17 Static electricity", pageStart: 697, pageEnd: 700, words: 0 },
      ],
    });
    expect(created.status).toBe(201);
    const docId = created.json.id as string;

    const up1 = await teacher.req("POST", `/api/documents/${docId}/pages`, {
      pages: [
        { no: 693, text: "Chapter 16 Magnetism: Like magnetic poles repel and unlike poles attract each other." },
        { no: 694, text: "16.1 Permanent magnets: Soft iron magnetises easily; steel retains magnetism permanently." },
        { no: 695, text: "16.2 Magnetic fields: Magnetic field lines run from the North pole to the South pole." },
        { no: 696, text: "EXAM-STYLE QUESTIONS: Question 1 [2 marks] Describe how to plot field lines with a compass." },
      ],
    });
    expect(up1.status).toBe(200);
    expect(up1.json).toEqual({ received: 4, pageCount: 1122, complete: false });

    const docInfo = (await teacher.req("GET", `/api/documents/${docId}`)).json;
    expect(docInfo.importedRanges).toEqual([{ start: 693, end: 696 }]);

    // Creating a lesson on the imported Chapter 16 succeeds immediately without waiting for 1,122 pages:
    const okLesson = await teacher.req("POST", "/api/lessons", { documentId: docId, chapterIds: ["c16"] });
    expect(okLesson.status).toBe(201);
    expect(okLesson.json.lesson.scope.ranges).toEqual([{ start: 693, end: 696 }]);

    // Creating a lesson on unimported Chapter 17 is rejected with 409 DOCUMENT_INCOMPLETE:
    const unimportedLesson = await teacher.req("POST", "/api/lessons", { documentId: docId, chapterIds: ["c17"] });
    expect(unimportedLesson.status).toBe(409);
    expect(unimportedLesson.json.error.code).toBe("DOCUMENT_INCOMPLETE");

    // Incremental page upsert for Chapter 17 (p.697..700):
    const up2 = await teacher.req("POST", `/api/documents/${docId}/pages`, {
      pages: [
        { no: 697, text: "Chapter 17 Static electricity: Charging by friction transfers electrons between insulators." },
        { no: 698, text: "17.1 Electric charge: Positive and negative charges attract; like charges repel." },
        { no: 699, text: "17.2 Electric fields: An electric field is a region in which an electric charge experiences a force." },
        { no: 700, text: "Summary of static electricity and conductors versus insulators." },
      ],
    });
    expect(up2.status).toBe(200);
    expect(up2.json.received).toBe(8);

    const afterInfo = (await teacher.req("GET", `/api/documents/${docId}`)).json;
    expect(afterInfo.importedRanges).toEqual([{ start: 693, end: 700 }]);
    expect(afterInfo.chapters.find((c: { id: string }) => c.id === "c17").words).toBeGreaterThan(20);

    const ch17Lesson = await teacher.req("POST", "/api/lessons", { documentId: docId, chapterIds: ["c17"] });
    expect(ch17Lesson.status).toBe(201);
  });
});

describe("P1: Multi-PDF sources_json, 1500-char focus, syllabus vision transcription & delete protection", () => {
  it("syncs primary document_id, validates multi-PDF virtual pages & numbers, protects secondary PDFs from purge, and duplicates sources_json", async () => {
    const tb = await teacher.req("POST", "/api/documents", {
      filename: "coursebook.pdf",
      title: "IGCSE Coursebook",
      sizeBytes: 2000,
      pageCount: 800,
      chapters: [{ id: "c16", parentId: null, level: 1, ord: 0, title: "16 Magnetism", pageStart: 693, pageEnd: 694, words: 40 }],
    });
    const tbId = tb.json.id as string;
    await teacher.req("POST", `/api/documents/${tbId}/pages`, {
      pages: [
        { no: 693, text: "Chapter 16 Magnetism: Iron, cobalt and nickel are ferromagnetic materials. Poles attract and repel." },
        { no: 694, text: "16.2 Solenoid magnetic field strength increases when current or number of turns increases." },
      ],
    });

    const pp = await teacher.req("POST", "/api/documents", {
      filename: "0625_s25_qp_42.pdf",
      title: "2025 Past Paper 42",
      sizeBytes: 1500,
      pageCount: 16,
      chapters: [],
    });
    const ppId = pp.json.id as string;
    await teacher.req("POST", `/api/documents/${ppId}/pages`, {
      pages: [
        { no: 5, text: "Question 5 [3 marks]: A hall probe measures a flux density of 420 mT inside a laboratory solenoid carrying 2.5 A." },
        { no: 6, text: "Question 6 [2 marks]: State two ways to increase the magnetic field strength of an electromagnet." },
      ],
    });

    const sources: LessonSource[] = [
      { id: "src_tb", kind: "pdf", documentId: tbId, title: "IGCSE Coursebook", chapterIds: ["c16"], ranges: [{ start: 693, end: 694 }], role: "textbook" },
      { id: "src_pp", kind: "pdf", documentId: ppId, title: "2025 Past Paper 42", ranges: [{ start: 5, end: 6 }], role: "past_paper" },
      {
        id: "src_syl",
        kind: "syllabus",
        title: "Clipboard_Screenshot.png",
        text: "4.1 Simple phenomena of magnetism",
        items: ["Identify magnetic materials", "State two ways to strengthen an electromagnet"],
      },
    ];

    const brief =
      "我现在是一个G10的物理老师，给IG班学生上课，用这本书第16章p693-726页结合真题卷制作一份60分钟的英文课件（重要专业词汇配中文）。严格覆盖考纲所有知识点，重点知识用红色字体加粗，文字精简在30号字左右，每隔15分钟安排做题或活动，产出PPT和配套讲义。";
    expect(brief.length).toBeGreaterThan(100);

    const created = await teacher.req("POST", "/api/lessons", {
      documentId: tbId,
      chapterIds: ["c16"],
      sources,
    });
    expect(created.status).toBe(201);
    const lessonId = created.json.lesson.id as string;
    expect(created.json.lesson.documentId).toBe(tbId);
    expect(created.json.lesson.sources).toHaveLength(3);

    const patched = await teacher.req("PATCH", `/api/lessons/${lessonId}`, {
      params: { minutes: 60, level: "intermediate", lessonType: "new", language: "en+zh", focus: brief },
    });
    expect(patched.status).toBe(200);
    expect(patched.json.lesson.params.focus).toBe(brief);

    // Secondary PDF is protected from permanent purge (409 IN_USE) and counted in library:
    const lib = (await teacher.req("GET", "/api/documents/library")).json.textbooks as { id: string; lessons: number; lessonsAll: number }[];
    expect(lib.find((r) => r.id === ppId)).toMatchObject({ lessons: 1, lessonsAll: 1 });
    const purgeSecondary = await teacher.req("DELETE", `/api/documents/${ppId}/permanent`);
    expect(purgeSecondary.status).toBe(409);
    expect(purgeSecondary.json.error.code).toBe("IN_USE");

    // Draft outline, cite virtual page 100005 (Past Paper p.5), confirm, generate slide, and edit with 420 mT from Past Paper p.5:
    const drafted = await teacher.req("POST", `/api/lessons/${lessonId}/outline`);
    expect(drafted.status).toBe(201);
    const v = drafted.json.version;

    const virtualP5 = encodeSourcePage(1, 5);
    const targetSpec = v.outline.slides.find((s: { layout: string }) => s.layout === "statement") ?? v.outline.slides[1];
    const updatedSlides = v.outline.slides.map((s: { id: string }) =>
      s.id === targetSpec.id
        ? { ...s, title: "Solenoid magnetic field strength and hall probe flux density", keyPoints: ["Current and turns increase solenoid field", "420 mT hall probe"], sourcePages: [694, virtualP5] }
        : s,
    );
    const saved = await teacher.req("PUT", `/api/lessons/${lessonId}/outline-versions/${v.id}`, {
      outline: { ...v.outline, slides: updatedSlides },
      rev: v.rev,
    });
    expect(saved.status).toBe(200);
    const savedSpec = saved.json.version.outline.slides.find((s: { id: string }) => s.id === targetSpec.id);
    expect(savedSpec.sourcePages).toEqual([694, virtualP5]);
    expect(savedSpec.sourceIssue).toBeUndefined();

    const confirmed = await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/confirm`, {
      rev: saved.json.version.rev,
      ackOverBudget: true,
    });
    expect(confirmed.status).toBe(200);

    const gen = await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${v.id}/slides/${targetSpec.id}/generate`);
    expect(gen.status).toBe(200);
    const slide = gen.json.slide;

    // Edit slide to cite 420 mT from secondary PDF page 5 (100005) — verifyNumbers checks across attached PDFs:
    const edited = await teacher.req("PATCH", `/api/lessons/${lessonId}/slides/${slide.id}`, {
      content: { ...slide.content, bullets: ["Solenoid flux density is 420 mT"] },
    });
    expect(edited.status).toBe(200);
    expect(edited.json.slide.unverified).toEqual([]);

    // Lesson view & deck export expose formatted pageLabels for secondary PDF virtual page 100005:
    const view = (await teacher.req("GET", `/api/lessons/${lessonId}`)).json;
    expect(view.pageLabels[String(virtualP5)]).toBe("2025 Past Paper 42 p.5");

    const deck = (await teacher.req("GET", `/api/lessons/${lessonId}/deck`)).json;
    expect(deck.lesson.pageLabels[String(virtualP5)]).toBe("2025 Past Paper 42 p.5");

    // Duplicate lesson preserves sources_json:
    const copy = await teacher.req("POST", `/api/lessons/${lessonId}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.json.lesson.sources).toHaveLength(3);
  });

  it("transcribes pasted syllabus screenshots via configured vision model and returns graceful Chinese message when unconfigured", async () => {
    const tb = await teacher.req("POST", "/api/documents", {
      filename: "mini.pdf",
      title: "Mini Physics",
      sizeBytes: 500,
      pageCount: 2,
      chapters: [],
    });
    const docId = tb.json.id as string;
    await teacher.req("POST", `/api/documents/${docId}/pages`, {
      pages: [
        { no: 1, text: "Magnetism: like poles repel and unlike poles attract." },
        { no: 2, text: "Magnetic field lines point from N to S." },
      ],
    });
    const lesson = await teacher.req("POST", "/api/lessons", { documentId: docId, ranges: [{ start: 1, end: 2 }] });
    const lessonId = lesson.json.lesson.id as string;

    // 1. Vision unconfigured -> graceful Chinese 403 VISION_OFF
    const off = await teacher.req("POST", `/api/lessons/${lessonId}/syllabus-image`, {
      image: PNG_DATA_URL,
      title: "Clipboard_Screenshot.png",
    });
    expect(off.status).toBe(403);
    expect(off.json.error.code).toBe("VISION_OFF");
    expect(off.json.error.message).toContain("看图模型");

    // 2. Configure free vision model and transcribe syllabus image
    const added = await admin.req("POST", "/api/admin/ai/providers", {
      kind: "glm",
      name: "GLM Vision",
      baseUrl: "https://vision-syllabus.test/v4",
      apiKey: "sk-test-syllabus-key",
      model: "glm-4.6v-flash",
      purpose: "vision",
    });
    expect(added.status).toBe(201);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://vision-syllabus.test/")) throw new Error(`unexpected fetch ${url}`);
      return new Response(
        JSON.stringify({
          model: "glm-4.6v-flash",
          choices: [
            {
              message: {
                content: [
                  "- Describe the forces between magnetic poles and between magnets and magnetic materials",
                  "- State the differences between the properties of temporary magnets (soft iron) and permanent magnets (steel)",
                  "- Describe how to plot magnetic field lines with a compass",
                ].join("\n"),
              },
            },
          ],
          usage: { prompt_tokens: 400, completion_tokens: 120 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const ok = await teacher.req("POST", `/api/lessons/${lessonId}/syllabus-image`, {
      image: PNG_DATA_URL,
      title: "Clipboard_Screenshot.png",
    });
    expect(ok.status).toBe(200);
    expect(ok.json.source).toMatchObject({
      kind: "syllabus",
      title: "Clipboard_Screenshot.png",
    });
    expect(ok.json.source.items).toEqual([
      "Describe the forces between magnetic poles and between magnets and magnetic materials",
      "State the differences between the properties of temporary magnets (soft iron) and permanent magnets (steel)",
      "Describe how to plot magnetic field lines with a compass",
    ]);
  });
});
