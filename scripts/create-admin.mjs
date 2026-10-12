#!/usr/bin/env node
// Bootstraps (or resets) an admin account directly in D1. The admin must change the password on first login.
//   pnpm admin:create --username admin [--password 'Secret123'] [--remote] [--persist-to .wrangler/state]
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { argon2id } from "@noble/hashes/argon2.js";

const { values } = parseArgs({
  options: {
    username: { type: "string", default: "admin" },
    password: { type: "string" },
    remote: { type: "boolean", default: false },
    "persist-to": { type: "string" },
    config: { type: "string" },
  },
});

const username = values.username.trim().toLowerCase();
if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) throw new Error("username: 3-32 chars, letters/digits/._-");
const password = values.password ?? `${randomBytes(9).toString("base64url")}7a`;
if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new Error("password needs 8+ chars with letters and digits");

// Must match apps/app/src/auth/password.ts (PHC string, argon2id m=19456 t=2 p=1).
const b64 = (u8) => Buffer.from(u8).toString("base64").replace(/=+$/, "");
const salt = randomBytes(16);
const hash = argon2id(password, salt, { m: 19456, t: 2, p: 1, dkLen: 32 });
const encoded = `$argon2id$v=19$m=19456,t=2,p=1$${b64(salt)}$${b64(hash)}`;

const id = `usr_${randomBytes(9).toString("base64url").replace(/[-_]/g, "x")}`;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const now = Date.now();
const sql = `INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES ('org_default', 'Default', ${now});
INSERT INTO users (id, org_id, username, display_name, password_hash, role, must_change_password, disabled_at, created_at, updated_at)
VALUES (${q(id)}, 'org_default', ${q(username)}, ${q("Administrator")}, ${q(encoded)}, 'admin', 1, NULL, ${now}, ${now})
ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', must_change_password = 1, disabled_at = NULL, updated_at = excluded.updated_at;`;

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/app");
const args = ["wrangler", "d1", "execute", "DB", values.remote ? "--remote" : "--local", "--command", sql, "--yes"];
if (values["persist-to"]) args.push("--persist-to", resolve(values["persist-to"]));
if (values.config) args.push("--config", values.config);
execFileSync("npx", args, { cwd: appDir, stdio: ["ignore", "ignore", "inherit"] });

console.log(`Admin account ready (${values.remote ? "remote" : "local"} D1):`);
console.log(`  username: ${username}`);
console.log(`  password: ${password}   (must be changed at first login)`);
