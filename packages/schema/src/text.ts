const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g;

/** Links and multi-segment lowercase URL path footers: not words a student reads, so budgets ignore them. */
const URLISH = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[A-Za-z0-9][A-Za-z0-9-]*\.[a-z]{2,}\/\S*|(?:^|(?<=\s))[a-z0-9_-]{2,}(?:\/[a-z0-9_.-]{2,}){2,}[)]?(?=\s|$)/g;

const GREEK_MACRO =
  /\\(?:alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)\b/g;

function compactMath(tex: string): string {
  let s = tex.replace(/\\x(?:right|left)arrow(?:\[([^\]]*)\])?\s*\{([^{}]*)\}/g, " $1 $2 ");
  for (let i = 0; i < 4 && /\\[dt]?frac\s*\{/.test(s); i++) {
    s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1/$2");
  }
  const unwrapRe =
    /\\(?:mathrm|textrm|textbf|textit|textsf|texttt|mathbf|mathit|mathsf|mathtt|mathcal|mathbb|boldsymbol|operatorname|text|mbox|vec|overrightarrow|overline|underline|hat|bar|tilde|dot|ddot|sqrt)\s*\{([^{}]*)\}/g;
  for (let i = 0; i < 4 && unwrapRe.test(s); i++) {
    unwrapRe.lastIndex = 0;
    s = s.replace(unwrapRe, "$1");
  }
  return s
    .replace(/\\cdot\b/g, ".")
    .replace(GREEK_MACRO, "α")
    .replace(/\\[,!]/g, "")
    .replace(/\\(?:begin|end)\s*\{[^{}]*\}/g, " ")
    .replace(/\\[A-Za-z]+|\\[^A-Za-z0-9]/g, " ")
    .replace(/~/g, " ")
    .replace(/[{}^_]/g, "");
}

/**
 * Word-equivalents for mixed Chinese/English text: Latin words count 1 each, and
 * 1.7 CJK characters count as one word (pedagogy-rules §4). URLs do not count, and
 * inline `$...$` LaTeX is measured by its compact rendered tokens rather than macro names.
 */
export function countWords(text: string): number {
  const mathExpanded = text.replace(/\$\$?([^$]+)\$\$?/g, (_, tex: string) => compactMath(tex));
  const plain = mathExpanded.replace(URLISH, " ");
  const cjk = (plain.match(CJK) ?? []).length;
  const latin = plain.replace(CJK, " ").match(/[A-Za-z0-9\u0370-\u03ff][A-Za-z0-9\u0370-\u03ff'’\-.]*/g)?.length ?? 0;
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
