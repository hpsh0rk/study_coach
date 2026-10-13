#!/usr/bin/env node
// Bootstraps (or resets) an admin account directly in D1. The admin must change the password on first login.
//   pnpm admin:create --username admin [--password 'Secret123'] [--keep] [--remote] [--persist-to .wrangler/state]
// Local D1 defaults to the documented password Admin12345; --remote always generates a random one unless given.
// --keep leaves an existing account untouched (pnpm setup:local can run again without resetting a changed password).
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const LOCAL_DEFAULT_PASSWORD = "Admin12345";

const { values } = parseArgs({
  options: {
    username: { type: "string", default: "admin" },
    password: { type: "string" },
    keep: { type: "boolean", default: false },
    remote: { type: "boolean", default: false },
    "persist-to": { type: "string" },
    config: { type: "string" },
  },
});

const username = values.username.trim().toLowerCase();
if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) throw new Error("username: 3-32 chars, letters/digits/._-");
const password = values.password ?? (values.remote ? `${randomBytes(9).toString("base64url")}7a` : LOCAL_DEFAULT_PASSWORD);
if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new Error("password needs 8+ chars with letters and digits");

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/app");
const where = values.remote ? "remote" : "local";

function d1(sql, json = false) {
  const args = ["wrangler", "d1", "execute", "DB", values.remote ? "--remote" : "--local", "--command", sql, "--yes"];
  if (json) args.push("--json");
  if (values["persist-to"]) args.push("--persist-to", resolve(values["persist-to"]));
  if (values.config) args.push("--config", values.config);
  return execFileSync("npx", args, { cwd: appDir, stdio: ["ignore", json ? "pipe" : "ignore", "inherit"], encoding: "utf8" });
}

if (values.keep) {
  const rows = JSON.parse(d1(`SELECT username FROM users WHERE username = ${q(username)}`, true))[0]?.results ?? [];
  if (rows.length) {
    console.log(`Admin account "${username}" already exists (${where} D1); password left unchanged.`);
    console.log(`  账号 ${username} 已存在，密码没有改动。忘了密码可以运行：pnpm admin:create --username ${username}`);
    process.exit(0);
  }
}

// Must match apps/app/src/auth/password.ts: chained calls of at most 100k iterations.
const ITERATIONS = 300_000;
const CALL_MAX = 100_000;
const b64 = (u8) => Buffer.from(u8).toString("base64").replace(/=+$/, "");
const salt = randomBytes(16);
let hash = Buffer.from(password);
for (let left = ITERATIONS; left > 0; left -= CALL_MAX) hash = pbkdf2Sync(hash, salt, Math.min(left, CALL_MAX), 32, "sha256");
const encoded = `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;

const id = `usr_${randomBytes(9).toString("base64url").replace(/[-_]/g, "x")}`;
const now = Date.now();
d1(`INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES ('org_default', 'Default', ${now});
INSERT INTO users (id, org_id, username, display_name, password_hash, role, must_change_password, disabled_at, created_at, updated_at)
VALUES (${q(id)}, 'org_default', ${q(username)}, ${q("Administrator")}, ${q(encoded)}, 'admin', 1, NULL, ${now}, ${now})
ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', must_change_password = 1, disabled_at = NULL, updated_at = excluded.updated_at;`);

console.log(`Admin account ready (${where} D1):`);
console.log(`  username: ${username}`);
console.log(`  password: ${password}   (must be changed at first login · 首次登录后必须改密码)`);
