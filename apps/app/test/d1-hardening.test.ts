import { beforeAll, describe, expect, it } from "vitest";
import { acquireSlideLock } from "../src/store.ts";
import { createTextbook } from "../src/textbook/write.ts";
import { Client, e, loggedIn, seedUser } from "./client.ts";

const TEXT =
  "Wave speed equals frequency multiplied by wavelength: v = f x lambda. Sound travels at 340 m/s in air and 1480 m/s in water.";

const chapterList = (n: number, duplicateLast = false) =>
  Array.from({ length: n }, (_, i) => ({
    id: duplicateLast && i === n - 1 ? "ch_0" : `ch_${i}`,
    parentId: null,
    level: 1 as const,
    ord: i,
    title: `${i + 1}. Section`,
    pageStart: 1,
    pageEnd: 4,
    words: 25,
  }));

let admin: Client;
let teacher: Client;

beforeAll(async () => {
  await seedUser("usr_d1_admin", "d1admin", "Admin12345", { role: "admin", mustChange: false });
  await seedUser("usr_d1_teacher", "d1teacher", "Teach12345", { role: "teacher", mustChange: false });
  admin = await loggedIn("d1admin", "Admin12345");
  teacher = await loggedIn("d1teacher", "Teach12345");
});

describe("D1 hardening: createTextbook batch and bound-parameter ceilings", () => {
  it("chunks 800-chapter textbook inserts to <= 40 statements per batch and < 100 params per statement", async () => {
    const batchSizes: number[] = [];
    const maxParamsPerBatch: number[] = [];
    const origBatch = e.DB.batch.bind(e.DB);
    e.DB.batch = (async <T = unknown>(statements: D1PreparedStatement[]) => {
      batchSizes.push(statements.length);
      const paramCounts = statements.map((stmt) => {
        const raw = stmt as unknown as { params?: unknown[]; bindings?: unknown[] };
        const bound = raw.params ?? raw.bindings;
        return Array.isArray(bound) ? bound.length : 0;
      });
      maxParamsPerBatch.push(Math.max(0, ...paramCounts));
      return origBatch<T>(statements);
    }) as typeof e.DB.batch;

    let docId = "";
    try {
      const res = await teacher.req("POST", "/api/documents", {
        filename: "encyclopedia-800.pdf",
        title: "800 Chapters Textbook",
        sizeBytes: 65536,
        pageCount: 4,
        chapters: chapterList(800),
      });
      expect(res.status).toBe(201);
      docId = res.json.id as string;
    } finally {
      e.DB.batch = origBatch;
    }

    expect(batchSizes.length).toBeGreaterThanOrEqual(2);
    for (const size of batchSizes) {
      expect(size).toBeLessThanOrEqual(40);
    }
    for (const maxParams of maxParamsPerBatch) {
      expect(maxParams).toBeLessThan(100);
    }

    const loaded = await teacher.req("GET", `/api/documents/${docId}`);
    expect(loaded.status).toBe(200);
    expect(loaded.json.chapters).toHaveLength(800);
    expect(loaded.json.chapters[0].id).toBe("ch_0");
    expect(loaded.json.chapters[799].id).toBe("ch_799");
  });

  it("cleans up partial document and chapters if a later batch chunk fails", async () => {
    await seedUser("usr_d1_rollback", "d1rollback", "Teach12345", { mustChange: false });
    const user = {
      id: "usr_d1_rollback",
      orgId: "org_default",
      username: "d1rollback",
      displayName: null,
      role: "teacher" as const,
      mustChangePassword: false,
    };
    await expect(
      createTextbook(
        e,
        user,
        { filename: "partial-800.pdf", title: "Partial 800", sizeBytes: 1024, pageCount: 4 },
        chapterList(800, true),
      ),
    ).rejects.toThrow();

    const docsLeft = await e.DB.prepare("SELECT COUNT(*) AS n FROM documents WHERE owner_id = 'usr_d1_rollback'").first<number>("n");
    expect(docsLeft).toBe(0);
  });
});

describe("D1 hardening: additive hot-path indexes", () => {
  it("creates missing indexes and uses them in SQLite query plans", async () => {
    const rows = await e.DB.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'").all<{ name: string; tbl_name: string }>();
    const names = new Set(rows.results.map((r) => r.name));
    expect(names.has("lessons_document_idx")).toBe(true);
    expect(names.has("ai_calls_user_time_idx")).toBe(true);
    expect(names.has("sessions_expires_idx")).toBe(true);
    expect(names.has("slide_locks_until_idx")).toBe(true);

    const explain = async (sqlText: string) => {
      const plan = await e.DB.prepare(`EXPLAIN QUERY PLAN ${sqlText}`).all<{ detail: string }>();
      return plan.results.map((r) => r.detail).join(" | ");
    };

    expect(await explain("SELECT COUNT(*) FROM lessons WHERE document_id = 'doc_1' AND archived_at IS NULL")).toContain("lessons_document_idx");
    expect(await explain("SELECT COUNT(*) FROM ai_calls WHERE org_id = 'org_default' AND user_id = 'usr_1' AND created_at >= 1000")).toContain(
      "ai_calls_user_time_idx",
    );
    expect(await explain("DELETE FROM sessions WHERE expires_at < 1000")).toContain("sessions_expires_idx");
    expect(await explain("DELETE FROM slide_locks WHERE until < 1000")).toContain("slide_locks_until_idx");
  });
});

describe("D1 hardening: opportunistic expired-row GC", () => {
  it("prunes expired sessions on createSession while keeping active sessions", async () => {
    const now = Date.now();
    await e.DB.batch([
      e.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('ses_expired_1', 'usr_d1_teacher', ?, ?)").bind(now - 20_000, now - 1_000),
      e.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('ses_active_1', 'usr_d1_teacher', ?, ?)").bind(now - 5_000, now + 600_000),
    ]);

    const c = new Client();
    expect((await c.req("POST", "/api/auth/login", { username: "d1teacher", password: "Teach12345" })).status).toBe(200);

    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = 'ses_expired_1'").first<number>("n")).toBe(0);
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = 'ses_active_1'").first<number>("n")).toBe(1);
  });

  it("prunes stale username and IP login_attempts on both login failure and login success", async () => {
    const now = Date.now();
    const staleWindow = now - 20 * 60_000;
    const activeWindow = now - 60_000;
    await e.DB.batch([
      e.DB.prepare("INSERT OR REPLACE INTO login_attempts (key, window_start, failures) VALUES ('ip:203.0.113.50', ?, 3)").bind(staleWindow),
      e.DB.prepare("INSERT OR REPLACE INTO login_attempts (key, window_start, failures) VALUES ('u:203.0.113.50:olduser', ?, 3)").bind(staleWindow),
      e.DB.prepare("INSERT OR REPLACE INTO login_attempts (key, window_start, failures) VALUES ('ip:198.51.100.77', ?, 2)").bind(activeWindow),
    ]);

    // 1) Failure path prunes expired IP & user keys while preserving active ones
    const fail = await new Client().req("POST", "/api/auth/login", { username: "d1teacher", password: "wrong-password-1" }, { "cf-connecting-ip": "192.0.2.10" });
    expect(fail.status).toBe(401);
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE key IN ('ip:203.0.113.50', 'u:203.0.113.50:olduser')").first<number>("n")).toBe(0);
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE key = 'ip:198.51.100.77'").first<number>("n")).toBe(1);

    // 2) Success path clears the user's attempt key AND prunes newly expired IP keys
    await e.DB.prepare("INSERT OR REPLACE INTO login_attempts (key, window_start, failures) VALUES ('ip:203.0.113.51', ?, 4)").bind(staleWindow).run();
    const ok = await new Client().req("POST", "/api/auth/login", { username: "d1teacher", password: "Teach12345" }, { "cf-connecting-ip": "192.0.2.10" });
    expect(ok.status).toBe(200);
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE key IN ('ip:203.0.113.51', 'u:192.0.2.10:d1teacher')").first<number>("n")).toBe(0);
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE key = 'ip:198.51.100.77'").first<number>("n")).toBe(1);
  });

  it("prunes expired slide_locks opportunistically while respecting active locks", async () => {
    const now = Date.now();
    await e.DB.batch([
      e.DB.prepare("INSERT OR REPLACE INTO slide_locks (outline_version_id, spec_id, until) VALUES ('ov_stale_gc', 'sp1', ?)").bind(now - 5_000),
      e.DB.prepare("INSERT OR REPLACE INTO slide_locks (outline_version_id, spec_id, until) VALUES ('ov_active_gc', 'sp2', ?)").bind(now + 120_000),
    ]);

    expect(await acquireSlideLock(e, "ov_target_gc", "sp1", now)).toBe(true);
    expect(await acquireSlideLock(e, "ov_target_gc", "sp1", now)).toBe(false);
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM slide_locks WHERE outline_version_id = 'ov_stale_gc'").first<number>("n")).toBe(0);
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM slide_locks WHERE outline_version_id = 'ov_active_gc'").first<number>("n")).toBe(1);
    await e.DB.prepare("DELETE FROM slide_locks WHERE outline_version_id IN ('ov_target_gc', 'ov_active_gc')").run();
  });
});

describe("D1 hardening: public share ETag & Cache-Control", () => {
  it("serves weak ETag + Cache-Control, returns 304 on If-None-Match, invalidates ETag on content/mode changes, and 404s immediately when revoked or disabled", async () => {
    await seedUser("usr_share_owner", "shareowner", "Teach12345", { mustChange: false });
    const owner = await loggedIn("shareowner", "Teach12345");

    const doc = await owner.req("POST", "/api/documents", {
      filename: "share-etag.pdf",
      title: "Share Caching Book",
      sizeBytes: 2048,
      pageCount: 2,
      chapters: [{ id: "c1", parentId: null, level: 1, ord: 0, title: "1 Waves", pageStart: 1, pageEnd: 2, words: 120 }],
    });
    const docId = doc.json.id as string;
    await owner.req("POST", `/api/documents/${docId}/pages`, {
      pages: [
        { no: 1, text: TEXT },
        { no: 2, text: TEXT },
      ],
    });

    const createdLesson = await owner.req("POST", "/api/lessons", { documentId: docId, chapterIds: ["c1"] });
    const lessonId = createdLesson.json.lesson.id as string;
    const drafted = await owner.req("POST", `/api/lessons/${lessonId}/outline`, {});
    const vid = drafted.json.version.id as string;
    const confirmed = await owner.req("POST", `/api/lessons/${lessonId}/outline-versions/${vid}/confirm`, {
      ackOverBudget: true,
      rev: drafted.json.version.rev,
    });
    // Confirming/generating via HTTP also sweeps expired slide_locks across all lessons via carryOverSlides
    await e.DB.prepare("INSERT OR REPLACE INTO slide_locks (outline_version_id, spec_id, until) VALUES ('ov_stale_http', 'sp9', ?)").bind(Date.now() - 10_000).run();
    const firstSpec = confirmed.json.version.outline.slides[0];
    const gen = await owner.req("POST", `/api/lessons/${lessonId}/outline-versions/${vid}/slides/${firstSpec.id}/generate`, {});
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM slide_locks WHERE outline_version_id = 'ov_stale_http'").first<number>("n")).toBe(0);
    const slideId = gen.json.slide.id as string;

    const shared = await owner.req("POST", `/api/lessons/${lessonId}/share`, { ack: true, answers: "hidden" });
    expect(shared.status).toBe(201);
    const sharePath = `/api/share/${(shared.json.path as string).replace(/^\/s\//, "")}`;

    const anon = new Client();
    const first = await anon.raw("GET", sharePath);
    expect(first.status).toBe(200);
    const etag1 = first.headers.get("etag");
    expect(etag1).toMatch(/^W\/"[0-9a-f]+"$/);
    expect(first.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=30, must-revalidate");
    const body1 = (await first.json()) as { lesson: { answers: string } };
    expect(body1.lesson.answers).toBe("hidden");

    // Conditional request with matching ETag -> 304 Not Modified
    const cached = await anon.raw("GET", sharePath, undefined, { "if-none-match": etag1! });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag1);
    expect(cached.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=30, must-revalidate");
    expect(await cached.text()).toBe("");

    // Multi-tag If-None-Match header also hits 304
    const cachedList = await anon.raw("GET", sharePath, undefined, { "if-none-match": `W/"deadbeef", ${etag1!}` });
    expect(cachedList.status).toBe(304);

    // Toggling answer mode changes ETag -> 200 OK even when sending old ETag
    expect((await owner.req("PATCH", `/api/lessons/${lessonId}/share`, { answers: "shown" })).status).toBe(200);
    const afterMode = await anon.raw("GET", sharePath, undefined, { "if-none-match": etag1! });
    expect(afterMode.status).toBe(200);
    const etag2 = afterMode.headers.get("etag");
    expect(etag2).toMatch(/^W\/"[0-9a-f]+"$/);
    expect(etag2).not.toBe(etag1);
    const body2 = (await afterMode.json()) as { lesson: { answers: string } };
    expect(body2.lesson.answers).toBe("shown");

    // Editing slide content updates updated_at -> changes ETag
    const editedContent = { ...gen.json.slide.content, title: "Updated Wave Title" };
    expect((await owner.req("PATCH", `/api/lessons/${lessonId}/slides/${slideId}`, { content: editedContent })).status).toBe(200);
    const afterEdit = await anon.raw("GET", sharePath, undefined, { "if-none-match": etag2! });
    expect(afterEdit.status).toBe(200);
    const etag3 = afterEdit.headers.get("etag");
    expect(etag3).not.toBe(etag2);

    // Disabling the owner account immediately returns 404 even when sending If-None-Match
    expect((await admin.req("POST", "/api/admin/users/usr_share_owner/disable")).status).toBe(200);
    const disabledRes = await anon.raw("GET", sharePath, undefined, { "if-none-match": etag3! });
    expect(disabledRes.status).toBe(404);
    expect((await admin.req("POST", "/api/admin/users/usr_share_owner/enable")).status).toBe(200);

    // Re-login after disable destroyed sessions; unsharing (revoking) immediately returns 404 even when sending If-None-Match
    const reauthed = await loggedIn("shareowner", "Teach12345");
    expect((await reauthed.req("DELETE", `/api/lessons/${lessonId}/share`)).status).toBe(200);
    const revokedRes = await anon.raw("GET", sharePath, undefined, { "if-none-match": etag3! });
    expect(revokedRes.status).toBe(404);
  });
});
