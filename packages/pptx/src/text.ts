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
const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", n: "ⁿ", "(": "⁽", ")": "⁾" };
const SUB: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "(": "₍", ")": "₎" };

function group(src: string, i: number): [string, number] {
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

function script(s: string, table: Record<string, string>, mark: string): string {
  const plain = texToText(s).text;
  return [...plain].every((c) => table[c]) ? [...plain].map((c) => table[c]).join("") : `${mark}(${plain})`;
}

/**
 * KaTeX source → readable Unicode text (λ, ², ₁, a/b, √). `exact` is false when something had no
 * plain-text form, so the caller keeps the original TeX in the speaker notes.
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
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        while (src[i] === " ") i++;
        const [a, j] = group(src, i);
        let k = j;
        while (src[k] === " ") k++;
        const [b, k2] = group(src, k);
        i = k2;
        const wrap = (s: string) => (/^[\w.αβγδθλμπρσωΔ]+$/u.test(s) ? s : `(${s})`);
        const ta = texToText(a), tb = texToText(b);
        exact &&= ta.exact && tb.exact;
        out += `${wrap(ta.text)}/${wrap(tb.text)}`;
      } else if (name === "sqrt") {
        const [a, j] = group(src, i);
        i = j;
        const t = texToText(a);
        exact &&= t.exact;
        out += t.text.length > 1 ? `√(${t.text})` : `√${t.text}`;
      } else if (["text", "mathrm", "textrm", "mathbf", "mathit", "operatorname", "mbox", "boldsymbol", "vec", "overline", "hat", "bar"].includes(name)) {
        const [a, j] = group(src, i);
        i = j;
        const t = texToText(a);
        exact &&= t.exact && !["vec", "overline", "hat", "bar"].includes(name);
        out += t.text;
      } else if (name === "left" || name === "right" || name === "big" || name === "Big" || name === "displaystyle") {
        /* sizing only */
      } else if (name === "," || name === ";" || name === ":" || name === "!" || name === " ") out += name === "!" ? "" : " ";
      else if (name === "{" || name === "}" || name === "%" || name === "$" || name === "_" || name === "#") out += name;
      else if (name === "\\") out += " ";
      else if (GREEK[name]) out += GREEK[name];
      else if (SYMBOLS[name]) out += SYMBOLS[name];
      else if (/^(sin|cos|tan|log|ln|exp|lim|max|min)$/.test(name)) out += name;
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

/** Slot text with inline `$...$` math made readable. */
export function plain(s: string): string {
  return s.replace(/\$([^$]+)\$/g, (_, tex: string) => texToText(tex).text);
}

export const hasInlineMath = (s: string) => /\$[^$]+\$/.test(s);
