import { beforeAll, describe, expect, it } from "vitest";
import { MAX_TEXTBOOKS } from "../src/textbook/write.ts";
import { e, loggedIn, seedUser, type Client } from "./client.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const TEXT = "Waves carry energy from one place to another without moving matter. The wave speed equals frequency times wavelength.";

const book = (sha256: string | undefined, pageCount = 6) => ({
  filename: "waves.pdf",
  title: "Waves",
  sizeBytes: 12345,
  pageCount,
  chapters: [{ id: "c0", parentId: null, level: 1, ord: 0, title: "13 Waves", pageStart: 1, pageEnd: pageCount, words: 300 }],
  ...(sha256 ? { sha256 } : {}),
});
const pagesOf = (nos: number[]) => ({ pages: nos.map((no) => ({ no, text: TEXT })) });

let t4: Client;
let t5: Client;

beforeAll(async () => {
  await seedUser("usr_t4", "teacher4", "Teach12345", { mustChange: false });
  await seedUser("usr_t5", "teacher5", "Teach12345", { mustChange: false });
  await seedUser("usr_t6", "teacher6", "Teach12345", { mustChange: false });
  t4 = await loggedIn("teacher4", "Teach12345");
  t5 = await loggedIn("teacher5", "Teach12345");
});

describe("textbook file hash: one copy per teacher, resumable uploads", () => {
  it("lookup goes none → incomplete (missing pages) → ready, and only for the owner", async () => {
    expect((await t4.req("POST", "/api/documents/lookup", { sha256: SHA_A })).json).toEqual({ status: "none", pageBatch: 40 });
    expect((await t4.req("POST", "/api/documents/lookup", { sha256: "not-a-hash" })).status).toBe(400);

    const created = await t4.req("POST", "/api/documents", book(SHA_A));
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    await t4.req("POST", `/api/documents/${id}/pages`, pagesOf([1, 3, 4]));

    const partial = await t4.req("POST", "/api/documents/lookup", { sha256: SHA_A });
    expect(partial.json).toMatchObject({ status: "incomplete", document: { id, pagesReceived: 3 }, missing: [{ start: 2, end: 2 }, { start: 5, end: 6 }] });

    await t4.req("POST", `/api/documents/${id}/pages`, pagesOf([2, 5, 6]));
    expect((await t4.req("POST", "/api/documents/lookup", { sha256: SHA_A })).json).toMatchObject({ status: "ready", document: { id, pageCount: 6, pagesReceived: 6 } });
    expect((await t5.req("POST", "/api/documents/lookup", { sha256: SHA_A })).json.status).toBe("none");
  });

  it("the same file twice is refused with the existing id; another teacher may upload it", async () => {
    const first = (await t4.req("POST", "/api/documents/lookup", { sha256: SHA_A })).json.document.id as string;
    const again = await t4.req("POST", "/api/documents", book(SHA_A));
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ code: "DOCUMENT_EXISTS", detail: { id: first } });
    expect((await t5.req("POST", "/api/documents", book(SHA_A))).status).toBe(201);
    // Uploads without a hash (older clients) are not deduplicated.
    expect((await t4.req("POST", "/api/documents", book(undefined))).status).toBe(201);
  });

  it("a deleted copy is found as archived; restoring it is refused while a new copy is live", async () => {
    const created = await t4.req("POST", "/api/documents", book(SHA_B));
    const oldId = created.json.id as string;
    expect((await t4.req("DELETE", `/api/documents/${oldId}`)).status).toBe(200);
    expect((await t4.req("POST", "/api/documents/lookup", { sha256: SHA_B })).json).toMatchObject({ status: "archived", document: { id: oldId } });

    const fresh = await t4.req("POST", "/api/documents", book(SHA_B));
    expect(fresh.status).toBe(201);
    const restore = await t4.req("POST", `/api/documents/${oldId}/restore`, {});
    expect(restore.status).toBe(409);
    expect(restore.json.error).toMatchObject({ code: "DOCUMENT_EXISTS", detail: { id: fresh.json.id } });

    expect((await t4.req("DELETE", `/api/documents/${fresh.json.id}`)).status).toBe(200);
    expect((await t4.req("POST", `/api/documents/${oldId}/restore`, {})).status).toBe(200);
    expect((await t4.req("POST", "/api/documents/lookup", { sha256: SHA_B })).json).toMatchObject({ status: "incomplete", document: { id: oldId } });
  });

  it("caps live textbooks per teacher; deleting one frees a slot", async () => {
    const now = Date.now();
    const insert = e.DB.prepare(
      "INSERT INTO documents (id, org_id, owner_id, filename, title, size_bytes, page_count, pages_received, has_bookmarks, created_at) VALUES (?, 'org_default', 'usr_t6', 'x.pdf', 'X', 1, 10, 10, 0, ?)",
    );
    await e.DB.batch(Array.from({ length: MAX_TEXTBOOKS }, (_, i) => insert.bind(`doc_q${i}`, now + i)));
    const t6 = await loggedIn("teacher6", "Teach12345");
    const full = await t6.req("POST", "/api/documents", book(undefined));
    expect(full.status).toBe(409);
    expect(full.json.error.code).toBe("TEXTBOOK_QUOTA");
    expect((await t6.req("DELETE", "/api/documents/doc_q0")).status).toBe(200);
    expect((await t6.req("POST", "/api/documents", book(undefined))).status).toBe(201);
  });
});
