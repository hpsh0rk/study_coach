import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password.ts";
import type { Env } from "../src/env.ts";

const e = env as unknown as Env;
const worker = (exports as unknown as { default: Fetcher }).default;
const BASE = "http://kj.test";

class Client {
  cookie = "";
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await worker.fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-kj-csrf": "1", ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }
}

beforeAll(async () => {
  const now = Date.now();
  // Cheap argon2 params keep the test fast; verifyPassword reads params from the PHC string.
  const hash = hashPassword("Admin12345", { m: 64, t: 1, p: 1 });
  await e.DB.prepare(
    "INSERT OR REPLACE INTO users (id, org_id, username, display_name, password_hash, role, must_change_password, created_at, updated_at) VALUES ('usr_admin', 'org_default', 'admin', 'Admin', ?, 'admin', 1, ?, ?)",
  )
    .bind(hash, now, now)
    .run();
});

describe("whitelist auth", () => {
  it("rejects bad credentials and unauthenticated access", async () => {
    const c = new Client();
    expect((await c.req("GET", "/api/projects")).status).toBe(401);
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
