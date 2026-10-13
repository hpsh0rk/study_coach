import { beforeAll, describe, expect, it } from "vitest";
import { loggedIn, seedUser, type Client } from "./client.ts";

const TEXT = "Waves carry energy from one place to another without moving matter. The wave speed equals frequency times wavelength.";

let t7: Client;
let t8: Client;

beforeAll(async () => {
  await seedUser("usr_t7", "teacher7", "Teach12345", { mustChange: false });
  await seedUser("usr_t8", "teacher8", "Teach12345", { mustChange: false });
  t7 = await loggedIn("teacher7", "Teach12345");
  t8 = await loggedIn("teacher8", "Teach12345");
});

async function upload(c: Client, title: string, sha: string): Promise<string> {
  const created = await c.req("POST", "/api/documents", {
    filename: `${title}.pdf`,
    title,
    sizeBytes: 999,
    pageCount: 3,
    sha256: sha,
    chapters: [{ id: "c1", parentId: null, level: 1, ord: 0, title: "1 Waves", pageStart: 1, pageEnd: 3, words: 300 }],
  });
  expect(created.status).toBe(201);
  const id = created.json.id as string;
  // Page 3 is empty: flagged as missing text.
  await c.req("POST", `/api/documents/${id}/pages`, { pages: [1, 2].map((no) => ({ no, text: TEXT })).concat([{ no: 3, text: "" }]) });
  return id;
}

type Row = { id: string; title: string; pageCount: number; pagesReceived: number; flaggedPages: number; archivedAt: number | null; lessons: number; lessonsAll: number };
const library = async (c: Client) => (await c.req("GET", "/api/documents/library")).json.textbooks as Row[];

describe("教材管理 API", () => {
  it("lists textbooks with pages, flagged pages and lesson counts; rename; archive and restore", async () => {
    const id = await upload(t7, "Waves", "1".repeat(64));
    expect((await library(t7)).find((r) => r.id === id)).toMatchObject({ title: "Waves", pageCount: 3, pagesReceived: 3, flaggedPages: 1, archivedAt: null, lessons: 0, lessonsAll: 0 });

    expect((await t7.req("PATCH", `/api/documents/${id}`, { title: "  波动 第13章 " })).status).toBe(200);
    expect((await library(t7)).find((r) => r.id === id)!.title).toBe("波动 第13章");
    expect((await t7.req("PATCH", `/api/documents/${id}`, { title: " " })).status).toBe(400);

    expect((await t7.req("POST", `/api/documents/${id}/archive`)).status).toBe(200);
    expect((await library(t7)).find((r) => r.id === id)!.archivedAt).toEqual(expect.any(Number));
    expect(((await t7.req("GET", "/api/documents")).json.documents as { id: string }[]).map((d) => d.id)).not.toContain(id);
    expect((await t7.req("PATCH", `/api/documents/${id}`, { title: "Renamed while archived" })).status).toBe(200);
    expect((await t7.req("POST", `/api/documents/${id}/restore`)).status).toBe(200);
    expect((await library(t7)).find((r) => r.id === id)).toMatchObject({ archivedAt: null, title: "Renamed while archived" });
  });

  it("deletes for good only when no lesson (archived or not) uses it; the same file can then be uploaded again", async () => {
    const used = await upload(t7, "Used", "2".repeat(64));
    const lesson = await t7.req("POST", "/api/lessons", { documentId: used, chapterIds: ["c1"] });
    expect(lesson.status).toBe(201);
    expect((await library(t7)).find((r) => r.id === used)).toMatchObject({ lessons: 1, lessonsAll: 1 });
    const refused = await t7.req("DELETE", `/api/documents/${used}/permanent`);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.json)).toContain("还有 1 节课在用");
    await t7.req("DELETE", `/api/lessons/${lesson.json.lesson.id as string}`);
    expect((await library(t7)).find((r) => r.id === used)).toMatchObject({ lessons: 0, lessonsAll: 1 });
    expect((await t7.req("DELETE", `/api/documents/${used}/permanent`)).status).toBe(409);

    const unused = await upload(t7, "Unused", "3".repeat(64));
    expect((await t7.req("DELETE", `/api/documents/${unused}/permanent`)).status).toBe(200);
    expect((await library(t7)).map((r) => r.id)).not.toContain(unused);
    expect((await t7.req("GET", `/api/documents/${unused}`)).status).toBe(404);
    expect((await t7.req("POST", `/api/documents/${unused}/restore`)).status).toBe(404);
    expect((await t7.req("POST", "/api/documents/lookup", { sha256: "3".repeat(64) })).json).toMatchObject({ status: "none" });
    await upload(t7, "Unused again", "3".repeat(64));
  });

  it("another teacher sees nothing and can change nothing", async () => {
    const id = await upload(t7, "Mine", "4".repeat(64));
    expect((await library(t8)).map((r) => r.id)).not.toContain(id);
    for (const [method, path, body] of [
      ["PATCH", `/api/documents/${id}`, { title: "x" }],
      ["POST", `/api/documents/${id}/archive`, undefined],
      ["DELETE", `/api/documents/${id}/permanent`, undefined],
    ] as const) {
      expect((await t8.req(method, path, body)).status).toBe(404);
    }
  });
});
