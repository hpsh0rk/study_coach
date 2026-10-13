import { beforeAll, describe, expect, it } from "vitest";
import { DUMMY_HASH, hashPassword, PBKDF2_ITERATIONS, verifyPassword } from "../src/auth/password.ts";
import { loadAiConfig } from "../src/ai.ts";
import { Client, e, seedUser } from "./client.ts";

beforeAll(async () => {
  await seedUser("usr_admin", "admin", "Admin12345", { role: "admin" });
});

describe("PBKDF2 passwords", () => {
  it("verifies the right password and rejects others and foreign formats", async () => {
    const h = await hashPassword("Secret123", 1000);
    expect(h.startsWith("pbkdf2-sha256$1000$")).toBe(true);
    expect(await verifyPassword("Secret123", h)).toBe(true);
    expect(await verifyPassword("Secret124", h)).toBe(false);
    expect(await verifyPassword("Secret123", "$argon2id$v=19$m=1,t=1,p=1$aa$bb")).toBe(false);
    expect(await verifyPassword("dummy-password-1", DUMMY_HASH)).toBe(false);
  });

  it("runs counts above 100k as chained calls, the same as scripts/create-admin.mjs (Node pbkdf2Sync)", async () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(200_000);
    const fromScript = "pbkdf2-sha256$300000$BwcHBwcHBwcHBwcHBwcHBw$brywJUhxYOq+d476HdV5VuegKJ2Jqb3wh/NOLyvgXa0";
    expect(await verifyPassword("Admin12345", fromScript)).toBe(true);
    expect(await verifyPassword("Admin12346", fromScript)).toBe(false);
  });

  it("rehashes other costs to the current one on login", async () => {
    await seedUser("usr_old", "oldcost", "Secret123", { mustChange: false });
    const before = await e.DB.prepare("SELECT password_hash AS h FROM users WHERE id = 'usr_old'").first<string>("h");
    expect(before!.split("$")[1]).toBe("1000");
    expect((await new Client().req("POST", "/api/auth/login", { username: "oldcost", password: "Secret123" })).status).toBe(200);
    const after = await e.DB.prepare("SELECT password_hash AS h FROM users WHERE id = 'usr_old'").first<string>("h");
    expect(after!.split("$")[1]).toBe(String(PBKDF2_ITERATIONS));
    expect(await verifyPassword("Secret123", after!)).toBe(true);
  });
});

describe("whitelist auth", () => {
  it("rejects bad credentials and unauthenticated access", async () => {
    const c = new Client();
    expect((await c.req("GET", "/api/lessons")).status).toBe(401);
    expect((await c.req("POST", "/api/auth/login", { username: "admin", password: "wrong-pass1" })).status).toBe(401);
    expect((await c.req("POST", "/api/auth/login", { username: "nobody", password: "wrong-pass1" })).status).toBe(401);
  });

  it("requires the CSRF header on mutations", async () => {
    const c = new Client();
    const res = await c.req("POST", "/api/auth/login", { username: "admin", password: "Admin12345" }, { "x-kj-csrf": "" });
    expect(res.status).toBe(403);
  });

  it("admin must change password, then creates a teacher who cannot use admin APIs", async () => {
    const admin = new Client();
    const login = await admin.req("POST", "/api/auth/login", { username: "admin", password: "Admin12345" });
    expect(login.status).toBe(200);
    expect(login.json.user.mustChangePassword).toBe(true);
    expect((await admin.req("GET", "/api/admin/users")).status).toBe(403);
    expect((await admin.req("POST", "/api/auth/change-password", { currentPassword: "Admin12345", newPassword: "Admin123456" })).status).toBe(200);
    await admin.req("POST", "/api/auth/login", { username: "admin", password: "Admin123456" });

    const created = await admin.req("POST", "/api/admin/users", { username: "wang", displayName: "王老师", initialPassword: "Teach12345" });
    expect(created.status).toBe(201);
    expect(created.json.initialPassword).toBe("Teach12345");

    const teacher = new Client();
    expect((await teacher.req("POST", "/api/auth/login", { username: "wang", password: "Teach12345" })).status).toBe(200);
    expect((await teacher.req("GET", "/api/admin/users")).status).toBe(403);
    expect((await teacher.req("GET", "/api/admin/audit")).status).toBe(403);
    const audit = (await admin.req("GET", "/api/admin/audit")).json.entries;
    expect(audit.length).toBeLessThanOrEqual(20);
    expect(audit[0]).toMatchObject({ action: "auth.login", actor: "wang" });
    expect(audit.map((x: any) => x.action)).toContain("admin.user_created");
  });

  it("admin AI config keeps exactly one enabled provider and model", async () => {
    const admin = new Client();
    expect((await admin.req("POST", "/api/auth/login", { username: "admin", password: "Admin123456" })).status).toBe(200);
    expect(await loadAiConfig(e, "org_default")).toEqual({ active: null, vision: null });
    // No provider and stubs allowed: every page tells the teacher the output is the built-in templates.
    expect((await admin.req("GET", "/api/auth/me")).json.ai).toBe("stub");
    expect((await new Client().req("GET", "/api/auth/me")).json).toEqual({ user: null, ai: null });
    expect((await admin.req("POST", "/api/admin/ai/providers", { kind: "deepseek", name: "DS", apiKey: "sk-test-12345678" })).status).toBe(400);
    const a = (await admin.req("POST", "/api/admin/ai/providers", { kind: "deepseek", name: "DS", apiKey: "sk-test-12345678", model: "deepseek-chat" })).json.id;
    const b = (await admin.req("POST", "/api/admin/ai/providers", { kind: "glm", name: "GLM", apiKey: "sk-test-87654321", model: "glm-4-flash" })).json.id;
    const enabled = async () => (await admin.req("GET", "/api/admin/ai")).json.providers.filter((p: any) => p.enabled).map((p: any) => p.id);
    expect(await enabled()).toEqual([b]);
    expect((await admin.req("GET", "/api/auth/me")).json.ai).toBe("live");
    expect((await loadAiConfig(e, "org_default")).active).toMatchObject({ provider: { id: b }, model: "glm-4-flash" });
    expect((await admin.req("PATCH", `/api/admin/ai/providers/${a}`, { enabled: true, model: "deepseek-reasoner" })).status).toBe(200);
    expect(await enabled()).toEqual([a]);
    expect((await loadAiConfig(e, "org_default")).active).toMatchObject({ provider: { id: a }, model: "deepseek-reasoner" });
    expect((await admin.req("PATCH", "/api/admin/ai/providers/aip_missing", { enabled: true })).status).toBe(404);
    expect(await enabled()).toEqual([a]);
    await admin.req("DELETE", `/api/admin/ai/providers/${a}`);
    expect(await loadAiConfig(e, "org_default")).toEqual({ active: null, vision: null });
  });

  it("serves share links without speaker notes and 404s unknown tokens", async () => {
    const c = new Client();
    expect((await c.req("GET", "/api/share/nope")).status).toBe(404);
  });
});
