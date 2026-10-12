const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g;

/**
 * Word-equivalents for mixed Chinese/English text: Latin words count 1 each, and
 * 1.7 CJK characters count as one word (pedagogy-rules §4).
 */
export function countWords(text: string): number {
  const cjk = (text.match(CJK) ?? []).length;
  const latin = text.replace(CJK, " ").match(/[A-Za-z0-9][A-Za-z0-9'’\-.]*/g)?.length ?? 0;
  return Math.round(latin + cjk / 1.7);
}

export function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

export interface SuspiciousSpan {
  kind: "instruction" | "link" | "email" | "file";
  text: string;
}

const STOP = `[^\\s"'<>，。；）)\\]]`;
const SUSPICIOUS: [SuspiciousSpan["kind"], RegExp][] = [
  ["instruction", /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}?\b(instructions?|prompts?|rules|directions)\b/i],
  ["instruction", /\bsystem\s*(prompt|override|message)\b|\byou are now\b|<\s*\/?\s*(source|system|instructions?)\s*>/i],
  ["instruction", /(忽略|无视|忘记|覆盖).{0,12}?(指令|指示|提示|要求|规则)|系统提示|你现在是/],
  ["email", /[\w.+-]+@[\w-]+(\.[\w-]+)+/],
  ["file", /\b[\w-]+\.(apk|exe|msi|dmg|bat|cmd|scr|ipa)\b/i],
  ["link", new RegExp(`\\bhttps?://${STOP}+|\\bwww\\.${STOP}+|\\b[a-z0-9][a-z0-9-]*(\\.[a-z0-9-]+)*\\.(com|net|org|io|cn|xyz|top|app|info|site|online|ru|me|co|example)(/${STOP}*)?(?![a-z0-9])`, "i")],
];

/**
 * Links, e-mail addresses, downloads and prompt-injection phrases. Textbook pages and slides rarely
 * need them, so a hit is shown to the teacher before anything is shared (and marks pages to scan for hidden text).
 */
export function suspiciousSpans(text: string): SuspiciousSpan[] {
  const out: SuspiciousSpan[] = [];
  for (const [kind, re] of SUSPICIOUS) {
    const m = re.exec(text);
    if (m && !out.some((o) => o.kind === kind || o.text.includes(m[0]) || m[0].includes(o.text))) out.push({ kind, text: m[0].slice(0, 80) });
  }
  return out;
}
