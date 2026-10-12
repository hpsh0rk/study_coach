const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export type IdPrefix = "deck" | "sl" | "el" | "p" | "r" | "b" | "col" | "row" | "cell" | "ol" | "oi" | "olc" | "run" | "prj" | "usr" | "doc" | "ch" | "shr" | "ai" | "aip" | "org" | "ast";

/** Server-side id allocation. LLM output never carries ids (plan D6). */
export function newId(prefix: IdPrefix, size = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
