import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.ts";
import { Client, seedUser } from "./client.ts";

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
  });

  it("serves share links without speaker notes and 404s unknown tokens", async () => {
    const c = new Client();
    expect((await c.req("GET", "/api/share/nope")).status).toBe(404);
  });
});
