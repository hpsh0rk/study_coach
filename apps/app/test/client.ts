import { env, exports } from "cloudflare:workers";
import { hashPassword } from "../src/auth/password.ts";
import type { Env } from "../src/env.ts";

export const e = env as unknown as Env;
const worker = (exports as unknown as { default: Fetcher }).default;
const BASE = "http://kj.test";

export class Client {
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

/** Inserts a user directly (cheap PBKDF2 cost keeps tests fast; the cost is read from the stored hash). */
export async function seedUser(id: string, username: string, password: string, opts: { role?: "admin" | "teacher"; mustChange?: boolean } = {}) {
  const now = Date.now();
  await e.DB.prepare(
    "INSERT OR REPLACE INTO users (id, org_id, username, display_name, password_hash, role, must_change_password, created_at, updated_at) VALUES (?, 'org_default', ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, username, username, await hashPassword(password, 1000), opts.role ?? "teacher", opts.mustChange === false ? 0 : 1, now, now)
    .run();
}

export async function loggedIn(username: string, password: string): Promise<Client> {
  const c = new Client();
  const res = await c.req("POST", "/api/auth/login", { username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.json)}`);
  return c;
}
