import { secret, type Env } from "./env.ts";

async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Per-document token the heavy container uses to fetch the PDF and post results back. */
export async function callbackToken(env: Env, documentId: string): Promise<string> {
  return hmac(secret(env, "INTERNAL_SECRET"), `doc:${documentId}`);
}

export async function verifyCallbackToken(env: Env, documentId: string, token: string | null | undefined): Promise<boolean> {
  if (!token) return false;
  const expected = await callbackToken(env, documentId);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
