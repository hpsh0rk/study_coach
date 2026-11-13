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

export type RichInline =
  | { kind: "text"; text: string }
  | { kind: "math"; tex: string; display: boolean; raw: string };

export type RichToken =
  | RichInline
  | { kind: "bold"; text: string; children: RichInline[] }
  | { kind: "highlight"; text: string; children: RichInline[] };

const BOLD_BODY = String.raw`[^\s*\n](?:(?:(?!\*\*)[^\n])*?[^\s*\n])??`;
const HIGHLIGHT_BODY = String.raw`[^\s=\n](?:(?:(?!==)[^\n])*?[^\s=\n])??`;
const BOLD_INNER_RE = new RegExp(String.raw`\*\*(${BOLD_BODY})\*\*`, "g");
const HIGHLIGHT_INNER_RE = new RegExp(String.raw`==(${HIGHLIGHT_BODY})==`, "g");
const EMPHASIS_RE = new RegExp(
  String.raw`\*\*==(${HIGHLIGHT_BODY})==\*\*|==\*\*(${BOLD_BODY})\*\*==|==(${HIGHLIGHT_BODY})==|\*\*(${BOLD_BODY})\*\*`,
  "g",
);

/**
 * Tokenizes `$...$` / `$$...$$` math FIRST so `**` and `==` inside LaTeX are never altered, then splits
 * balanced single-line `==...==` (red-bold highlight) and `**...**` (bold) markers outside math.
 */
export function tokenizeRichText(text: string): RichToken[] {
  if (!text) return [];
  let openMark = "\uE010";
  while (text.includes(openMark)) openMark += "\uE010";
  let closeMark = "\uE011";
  while (text.includes(closeMark)) closeMark += "\uE011";

  const mathAtoms: Extract<RichInline, { kind: "math" }>[] = [];
  const carrier = text.replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]{1,200})\$/g, (raw, displayTex?: string, inlineTex?: string) => {
    const id = mathAtoms.length;
    mathAtoms.push({
      kind: "math",
      tex: displayTex ?? inlineTex ?? "",
      display: displayTex !== undefined,
      raw,
    });
    return `${openMark}${id}${closeMark}`;
  });

  const sentinelRe = new RegExp(`${openMark}(\\d+)${closeMark}`, "g");
  const expandInlines = (segment: string): RichInline[] => {
    if (!segment) return [];
    const inlines: RichInline[] = [];
    let last = 0;
    for (const m of segment.matchAll(sentinelRe)) {
      const idx = m.index!;
      if (idx > last) inlines.push({ kind: "text", text: segment.slice(last, idx) });
      const atom = mathAtoms[Number(m[1])];
      if (atom) inlines.push(atom);
      last = idx + m[0].length;
    }
    if (last < segment.length) inlines.push({ kind: "text", text: segment.slice(last) });
    return inlines;
  };
  const rawOf = (children: RichInline[]) => children.map((c) => (c.kind === "math" ? c.raw : c.text)).join("");

  const out: RichToken[] = [];
  const pushPlain = (segment: string) => {
    for (const item of expandInlines(segment)) out.push(item);
  };
  const pushEmph = (kind: "bold" | "highlight", segment: string) => {
    const children = expandInlines(segment);
    if (!children.length) return;
    out.push({ kind, text: rawOf(children), children });
  };

  let cursor = 0;
  for (const m of carrier.matchAll(EMPHASIS_RE)) {
    const idx = m.index!;
    if (idx > cursor) pushPlain(carrier.slice(cursor, idx));
    const nestedHighlight = m[1] ?? m[2];
    if (nestedHighlight !== undefined) {
      pushEmph("highlight", nestedHighlight.replace(BOLD_INNER_RE, "$1").replace(HIGHLIGHT_INNER_RE, "$1"));
    } else if (m[3] !== undefined) {
      pushEmph("highlight", m[3].replace(BOLD_INNER_RE, "$1"));
    } else if (m[4] !== undefined) {
      const boldBody = m[4];
      let subCursor = 0;
      let hasInnerHighlight = false;
      for (const hm of boldBody.matchAll(HIGHLIGHT_INNER_RE)) {
        hasInnerHighlight = true;
        const hIdx = hm.index!;
        if (hIdx > subCursor) pushEmph("bold", boldBody.slice(subCursor, hIdx));
        pushEmph("highlight", hm[1]!);
        subCursor = hIdx + hm[0].length;
      }
      if (!hasInnerHighlight) pushEmph("bold", boldBody);
      else if (subCursor < boldBody.length) pushEmph("bold", boldBody.slice(subCursor));
    }
    cursor = idx + m[0].length;
  }
  if (cursor < carrier.length) pushPlain(carrier.slice(cursor));
  return out;
}

/** Removes balanced `**...**` and `==...==` emphasis delimiters while keeping `$...$` math untouched. */
export function stripRichMarkers(text: string): string {
  if (!text || (!text.includes("**") && !text.includes("=="))) return text;
  return tokenizeRichText(text)
    .map((t) => (t.kind === "math" ? t.raw : t.text))
    .join("");
}

/**
 * Word-equivalents for mixed Chinese/English text: Latin words count 1 each, and
 * 1.7 CJK characters count as one word (pedagogy-rules §4). URLs and `**`/`==` emphasis markers
 * do not count, and inline `$...$` LaTeX is measured by its compact rendered tokens rather than macro names.
 */
export function countWords(text: string): number {
  const stripped = stripRichMarkers(text);
  const mathExpanded = stripped.replace(/\$\$?([^$]+)\$\$?/g, (_, tex: string) => compactMath(tex));
  const plain = mathExpanded.replace(URLISH, " ");
  const cjk = (plain.match(CJK) ?? []).length;
  const latin = plain.replace(CJK, " ").match(/[A-Za-z0-9\u0370-\u03ff][A-Za-z0-9\u0370-\u03ff'’\-.]*/g)?.length ?? 0;
  return Math.round(latin + cjk / 1.7);
}

/** Word-equivalents wrapped in `==...==` red-bold highlight spans on a string. */
export function countHighlightedWords(text: string): number {
  if (!text || !text.includes("==")) return 0;
  return tokenizeRichText(text).reduce((sum, token) => sum + (token.kind === "highlight" ? countWords(token.text) : 0), 0);
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
