/**
 * PBKDF2-SHA256 via WebCrypto (no WASM, fits the Workers CPU budget).
 * Stored as "pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>" so the cost can change without a migration.
 */
export const PBKDF2_ITERATIONS = 100_000;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, "");
}

function unb64(text: string): Uint8Array {
  const pad = text.length % 4 ? "=".repeat(4 - (text.length % 4)) : "";
  return Uint8Array.from(atob(text + pad), (c) => c.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, iterations: number, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, bytes * 8);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(await derive(password, salt, iterations, 32))}`;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) return false;
  const expected = unb64(parts[3]!);
  return timingSafeEqual(await derive(password, unb64(parts[2]!), iterations, expected.length), expected);
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
