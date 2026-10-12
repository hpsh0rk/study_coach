import { argon2id } from "@noble/hashes/argon2.js";

/** OWASP minimum for argon2id. Encoded in PHC format so parameters can change without migrations. */
export const ARGON2_PARAMS = { m: 19456, t: 2, p: 1 } as const;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, "");
}

function unb64(text: string): Uint8Array {
  const pad = text.length % 4 ? "=".repeat(4 - (text.length % 4)) : "";
  const bin = atob(text + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function hashPassword(password: string, params: { m: number; t: number; p: number } = ARGON2_PARAMS): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = argon2id(password, salt, { ...params, dkLen: 32 });
  return `$argon2id$v=19$m=${params.m},t=${params.t},p=${params.p}$${b64(salt)}$${b64(hash)}`;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split("$");
  // ["", "argon2id", "v=19", "m=..,t=..,p=..", salt, hash]
  if (parts.length !== 6 || parts[1] !== "argon2id") return false;
  const params = Object.fromEntries(parts[3]!.split(",").map((kv) => kv.split("=") as [string, string]));
  const m = Number(params.m);
  const t = Number(params.t);
  const p = Number(params.p);
  if (!m || !t || !p) return false;
  const expected = unb64(parts[5]!);
  const actual = argon2id(password, unb64(parts[4]!), { m, t, p, dkLen: expected.length });
  return timingSafeEqual(actual, expected);
}

export function passwordProblem(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters · 密码至少 8 位";
  if (password.length > 200) return "Password is too long";
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return "Use letters and numbers · 需包含字母和数字";
  return null;
}

export function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}7`;
}
