/** Width estimates (in em) for wrapping text before a renderer measures it; deliberately on the wide side. */
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

function charEm(ch: string): number {
  if (CJK.test(ch)) return 1;
  if (ch === " ") return 0.28;
  if (/[il.,:;'|!]/.test(ch)) return 0.3;
  if (/[mwMW]/.test(ch)) return 0.9;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[0-9]/.test(ch)) return 0.58;
  if (/[a-z]/.test(ch)) return 0.56;
  return 0.62;
}

export function textEm(s: string): number {
  let n = 0;
  for (const ch of s) n += charEm(ch);
  return n;
}

/** Latin words stay whole; every CJK character is its own break opportunity. */
function tokens(s: string): string[] {
  return s.match(/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]|[^\s\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]+\s*|\s+/g) ?? [];
}

/** Greedy line count for one paragraph in a box `widthEm` wide. */
export function lineCount(s: string, widthEm: number): number {
  if (!s) return 1;
  let lines = 1;
  let used = 0;
  for (const t of tokens(s)) {
    const w = textEm(t.trimEnd());
    const full = textEm(t);
    if (used > 0 && used + w > widthEm) {
      lines++;
      used = 0;
    }
    if (w > widthEm) {
      lines += Math.ceil(w / widthEm) - 1;
      used = w % widthEm;
    } else used += full;
  }
  return lines;
}

export const hasCjk = (s: string) => CJK.test(s);

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", theta: "θ", lambda: "λ", mu: "μ", nu: "ν", pi: "π",
  rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", varphi: "φ", omega: "ω", eta: "η", kappa: "κ", xi: "ξ", chi: "χ", psi: "ψ", zeta: "ζ",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Omega: "Ω", Psi: "Ψ",
};
const SYMBOLS: Record<string, string> = {
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", approx: "≈", neq: "≠", ne: "≠", le: "≤", leq: "≤", ge: "≥", geq: "≥", to: "→",
  rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", infty: "∞", propto: "∝", degree: "°", circ: "°", sum: "Σ", int: "∫", partial: "∂",
  nabla: "∇", sim: "~", ldots: "…", cdots: "⋯", quad: " ", qquad: "  ", rightleftharpoons: "⇌", longrightarrow: "⟶", ell: "ℓ", hbar: "ħ",
};
const SUP: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", "°": "°", i: "ⁱ", n: "ⁿ", T: "ᵀ",
  "⁰": "⁰", "¹": "¹", "²": "²", "³": "³", "⁴": "⁴", "⁵": "⁵", "⁶": "⁶", "⁷": "⁷", "⁸": "⁸", "⁹": "⁹",
};
const SUB: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
  "₀": "₀", "₁": "₁", "₂": "₂", "₃": "₃", "₄": "₄", "₅": "₅", "₆": "₆", "₇": "₇", "₈": "₈", "₉": "₉",
};

function group(src: string, i: number): [string, number] {
  while (src[i] === " ") i++;
  if (src[i] === "{") {
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) return [src.slice(i + 1, j), j + 1];
    }
    return [src.slice(i + 1), src.length];
  }
  if (src[i] === "\\") {
    const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
    return [m![0], i + m![0].length];
  }
  return [src[i] ?? "", i + 1];
}

function bracketGroup(src: string, i: number): [string | null, number] {
  let k = i;
  while (src[k] === " ") k++;
  if (src[k] !== "[") return [null, i];
  let depth = 0;
  for (let j = k; j < src.length; j++) {
    if (src[j] === "[") depth++;
    else if (src[j] === "]" && --depth === 0) return [src.slice(k + 1, j), j + 1];
  }
  return [src.slice(k + 1), src.length];
}

function script(s: string, table: Record<string, string>, mark: string): string {
  const plainText = texToText(s).text;
  if (!plainText) return "";
  if ([...plainText].every((c) => table[c])) return [...plainText].map((c) => table[c]).join("");
  if (mark === "_" && /^[\u3400-\u9fff]+$/u.test(plainText)) return plainText;
  if (mark === "_") return `(${plainText})`;
  return `${mark}(${plainText})`;
}

function formatEnv(env: string, body: string): string {
  const rows = body
    .split(/\\\\/)
    .map((row) =>
      row
        .split("&")
        .map((cell) => texToText(cell).text.replace(/[,;]\s*$/, "").trim())
        .filter(Boolean)
        .join(", "),
    )
    .filter(Boolean);
  const joined = rows.join("; ");
  if (env === "cases" || env === "dcases") return `{ ${joined} }`;
  if (env === "pmatrix") return `( ${joined} )`;
  if (env === "bmatrix") return `[ ${joined} ]`;
  return joined;
}

/**
 * KaTeX source → readable Unicode text (λ, ², ₁, a/b, √). `exact` is false when something had no
 * exact 1D plain-text layout, so the caller keeps the original TeX in notes and can rasterize display cards.
 */
export function texToText(src: string): { text: string; exact: boolean } {
  let out = "";
  let exact = true;
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\") {
      const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
      const name = m ? m[1]! : "";
      i += m ? m[0].length : 1;
      if (name === "begin") {
        const [env, j] = group(src, i);
        const endTag = `\\end{${env.trim()}}`;
        const endIdx = src.indexOf(endTag, j);
        const body = endIdx >= 0 ? src.slice(j, endIdx) : src.slice(j);
        i = endIdx >= 0 ? endIdx + endTag.length : src.length;
        exact = false;
        out += ` ${formatEnv(env.trim(), body)} `;
      } else if (name === "end") {
        const [, j] = group(src, i);
        i = j;
      } else if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const [a, j] = group(src, i);
        const [b, k2] = group(src, j);
        i = k2;
        const wrap = (s: string) => (/^[\w.αβγδθλμπρσωΔ]+$/u.test(s) ? s : `(${s})`);
        const ta = texToText(a), tb = texToText(b);
        exact &&= ta.exact && tb.exact;
        out += `${wrap(ta.text)}/${wrap(tb.text)}`;
      } else if (name === "sqrt") {
        const [deg, afterDeg] = bracketGroup(src, i);
        const [a, j] = group(src, afterDeg);
        i = j;
        const t = texToText(a);
        exact &&= t.exact && deg === null;
        const prefix = deg ? `${script(deg, SUP, "^")}√` : "√";
        out += t.text.length > 1 ? `${prefix}(${t.text})` : `${prefix}${t.text}`;
      } else if (name === "vec" || name === "overrightarrow") {
        const [a, j] = group(src, i);
        i = j;
        const t = texToText(a);
        exact = false;
        out += `${t.text}\u20d7`;
      } else if (name === "xrightarrow" || name === "xleftarrow") {
        const [subRaw, afterSub] = bracketGroup(src, i);
        const [supRaw, j] = group(src, afterSub);
        i = j;
        const sup = texToText(supRaw).text;
        const sub = subRaw !== null ? texToText(subRaw).text : "";
        const label = [sup, sub].filter(Boolean).join(" / ");
        exact = false;
        out += name === "xrightarrow" ? (label ? ` —[${label}]→ ` : " → ") : label ? ` ←[${label}]— ` : " ← ";
      } else if (["text", "mathrm", "textrm", "textbf", "textit", "textsf", "texttt", "mathbf", "mathit", "mathsf", "mathtt", "operatorname", "mbox", "boldsymbol", "overline", "hat", "bar"].includes(name)) {
        const [a, j] = group(src, i);
        i = j;
        const t = texToText(a);
        exact &&= t.exact && !["overline", "hat", "bar"].includes(name);
        out += t.text;
      } else if (name === "left" || name === "right" || name === "big" || name === "Big" || name === "bigg" || name === "Bigg" || name === "displaystyle") {
        /* sizing only */
      } else if (name === "," || name === ";" || name === ":" || name === "!" || name === " ") out += name === "!" ? "" : " ";
      else if (name === "{" || name === "}" || name === "%" || name === "$" || name === "_" || name === "#") out += name;
      else if (name === "\\") out += " ";
      else if (GREEK[name]) out += GREEK[name];
      else if (SYMBOLS[name]) out += SYMBOLS[name];
      else if (/^(sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|log|ln|exp|lim|max|min)$/.test(name)) out += name;
      else {
        exact = false;
        out += name;
      }
    } else if (ch === "^" || ch === "_") {
      const [a, j] = group(src, i + 1);
      i = j;
      out += script(a, ch === "^" ? SUP : SUB, ch);
    } else if (ch === "{" || ch === "}") i++;
    else if (ch === "~") {
      out += " ";
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return { text: out.replace(/\s+/g, " ").trim(), exact };
}

/** Text with inline `$...$` and `$$...$$` math made readable while preserving line breaks. */
export function plain(s: string): string {
  return s.replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+)\$/g, (_, block?: string, inline?: string) => texToText(block ?? inline ?? "").text);
}

export const hasInlineMath = (s: string) => /\$[^$]+\$/.test(s);
