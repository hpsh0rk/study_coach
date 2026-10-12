#!/usr/bin/env node
// Measures PBKDF2-SHA256 (WebCrypto, the same primitive the Worker uses) per iteration count.
// Usage: node scripts/bench-pbkdf2.mjs [iterations...]
const counts = process.argv.slice(2).map(Number).filter(Boolean);
const list = counts.length ? counts : [10_000, 20_000, 30_000, 50_000, 100_000];
const enc = new TextEncoder();
const salt = crypto.getRandomValues(new Uint8Array(16));

async function derive(iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode("correct horse 1"), "PBKDF2", false, ["deriveBits"]);
  await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

await derive(1000);
console.log("iterations  median ms  p90 ms");
for (const n of list) {
  const times = [];
  for (let i = 0; i < 25; i++) {
    const t = performance.now();
    await derive(n);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(`${String(n).padStart(10)}  ${times[12].toFixed(2).padStart(9)}  ${times[22].toFixed(2).padStart(6)}`);
}
