import { beforeAll, describe, expect, it } from "vitest";
import { scopeAdvice } from "@kj/pedagogy";
import { pagesInRanges } from "@kj/textbook";
import { scopeStats, selectionPages } from "../src/textbook/index.ts";
import { e, loggedIn, seedUser, type Client } from "./client.ts";

const USABLE = "one two three four five six";

let teacher: Client;
let documentId: string;

beforeAll(async () => {
  await seedUser("usr_scope", "scopefixture", "Teach12345", { mustChange: false });
  teacher = await loggedIn("scopefixture", "Teach12345");
  const created = await teacher.req("POST", "/api/documents", {
    filename: "bilingual-scope.pdf",
    title: "力与运动 · Force and Motion",
    sizeBytes: 2048,
    pageCount: 8,
    sha256: "f".repeat(64),
    chapters: [
      { id: "root", parentId: null, level: 1, ord: 0, title: "第1章 力与运动", pageStart: 3, pageEnd: 8, words: 30 },
      { id: "middle", parentId: "root", level: 2, ord: 1, title: "1.1 Force", pageStart: 4, pageEnd: 6, words: 18 },
      { id: "deep", parentId: "middle", level: 3, ord: 2, title: "基础概念 Concepts", pageStart: 5, pageEnd: 5, words: 6 },
      { id: "sibling", parentId: "root", level: 2, ord: 3, title: "1.2 运动 Motion", pageStart: 7, pageEnd: 8, words: 6 },
    ],
  });
  expect(created.status).toBe(201);
  documentId = created.json.id as string;
  const pages = [
    { no: 1, text: "", label: "i" },
    { no: 2, text: "roman preface", label: "ii" },
    ...[3, 4, 5, 6].map((no) => ({ no, text: USABLE, label: String(no - 2) })),
    { no: 7, text: "", label: "5" },
    { no: 8, text: USABLE, label: "6" },
  ];
  expect((await teacher.req("POST", `/api/documents/${documentId}/pages`, { pages })).json.complete).toBe(true);
});

describe("lesson scope fixture matrix", () => {
  it("excludes blank and near-empty pages from both model input and teaching-time words, and predicts the exact source cut", async () => {
    const ranges = [{ start: 1, end: 6 }];
    expect((await selectionPages(e, documentId, ranges)).map((page) => page.no)).toEqual([3, 4, 5, 6]);
    const stats = await scopeStats(e, documentId, ranges, { sourceBudget: 70 });
    expect(stats).toEqual({
      words: 24,
      emptyPages: [1, 2],
      unreadPages: [5, 6],
    });
    expect(scopeAdvice(stats.words, 40, stats.unreadPages.length)).toEqual({
      estimatedMinutes: 0,
      lessons: 2,
      tooMuch: true,
      unreadPages: 2,
    });
  });

  it("merges overlapping manual ranges with a nested chapter into an exact physical page set", async () => {
    const created = await teacher.req("POST", "/api/lessons", {
      documentId,
      chapterIds: ["deep"],
      ranges: [
        { start: 4, end: 6 },
        { start: 6, end: 7 },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.json.lesson.scope).toEqual({ chapterIds: ["deep"], ranges: [{ start: 4, end: 7 }] });
    expect(pagesInRanges(created.json.lesson.scope.ranges)).toEqual([4, 5, 6, 7]);
    expect(created.json.lesson.title).toBe("基础概念 Concepts");
  });

  it("keeps sparse nested scope semantics when an archived textbook lesson is re-scoped and reused", async () => {
    const created = await teacher.req("POST", "/api/lessons", {
      documentId,
      chapterIds: ["root", "deep"],
      ranges: [
        { start: 1, end: 2 },
        { start: 2, end: 4 },
      ],
    });
    expect(created.status).toBe(201);
    const lessonId = created.json.lesson.id as string;
    expect(created.json.lesson.scope).toEqual({ chapterIds: ["root", "deep"], ranges: [{ start: 1, end: 8 }] });
    expect(created.json.lesson.title).toBe("第1章 力与运动");

    expect((await teacher.req("POST", `/api/documents/${documentId}/archive`)).status).toBe(200);
    expect((await teacher.req("POST", "/api/lessons", { documentId, chapterIds: ["deep"] })).status).toBe(404);
    const rescoped = await teacher.req("PATCH", `/api/lessons/${lessonId}`, {
      chapterIds: ["root", "deep"],
      ranges: [
        { start: 1, end: 2 },
        { start: 2, end: 4 },
      ],
    });
    expect(rescoped.status).toBe(200);
    expect(rescoped.json.lesson.scope).toEqual({ chapterIds: ["root", "deep"], ranges: [{ start: 1, end: 8 }] });
    expect(rescoped.json.lesson.title).toBe("第1章 力与运动");

    const duplicate = await teacher.req("POST", `/api/lessons/${lessonId}/duplicate`, { title: "复用：力与运动" });
    expect(duplicate.status).toBe(201);
    expect(duplicate.json.lesson.scope).toEqual({ chapterIds: ["root", "deep"], ranges: [{ start: 1, end: 8 }] });
    expect(duplicate.json.lesson.title).toBe("复用：力与运动");
  });
});
