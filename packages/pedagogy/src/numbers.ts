import type { PageType, SlideContent, Unverified, WidgetSpec } from "@kj/schema";

/**
 * "待核实" check: every number and formula on a slide should appear in its cited source pages, and
 * every worked calculation should compute. Pure and deterministic; it flags, it never blocks.
 */

/** Problem layouts invent their own numbers by design; only their arithmetic is checked. */
const PROBLEM_LAYOUTS = new Set<SlideContent["layout"]>(["steps", "quiz", "questions"]);
const PROBLEM_TYPES = new Set<PageType>(["worked", "faded", "practice", "check", "exit", "retrieval"]);
/** Small integers are counts, list positions and step numbers, not claims. */
const TRIVIAL_MAX = 10;
const MAX_FLAGS = 8;

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", theta: "θ", lambda: "λ", mu: "μ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", omega: "ω",
  Delta: "Δ", Sigma: "Σ", Omega: "Ω", Phi: "Φ",
};

/** TeX to plain text: Greek letters to Unicode, operators to symbols, \frac{a}{b} to (a)/(b). */
export function texToPlain(s: string): string {
  let t = s;
  for (let i = 0; i < 4 && /\\[dt]?frac\s*\{/.test(t); i++) t = t.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)");
  return t
    .replace(/\\(?:text|mathrm|mathit|mathtt|mathsf|mathbf|operatorname|textrm)\s*\{([^{}]*)\}/g, " $1 ")
    .replace(/\\([A-Za-z]+)/g, (m, name: string) => (GREEK[name] ? GREEK[name]! : name === "times" || name === "cdot" ? "×" : name === "div" ? "÷" : name === "approx" ? "≈" : ["sin", "cos", "tan", "log", "ln", "sqrt", "exp"].includes(name) ? ` ${name} ` : " "))
    .replace(/\s*\^\s*\{\s*([^{}]*?)\s*\}/g, "^$1")
    .replace(/\\[,;:! ]|~/g, " ")
    .replace(/[{}$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface FoundNumber {
  text: string;
  value: number;
  decimals: number;
  significantFigures: number;
}

// CJK normally has no spaces around quantities ("12牛顿"), while Latin chemical tokens (CO2/H2O) stay excluded.
const NUM_RE = /(?<![A-Za-z\d_.])([-−]?)(\d{1,3}(?:[,\u00a0\u202f ]\d{3})+(?!\d)|\d+)(?:\.(\d+))?(?:\s*(?:×|x|\*)\s*10\s*\^\s*\(?([-−]?\d+)\)?)?/g;

function significantFigures(text: string): number {
  const mantissa = text.split(/\s*(?:×|x|\*)\s*10\s*\^/i)[0]!.replace(/[-−+,\u00a0\u202f ]/g, "");
  const decimal = mantissa.includes(".");
  let digits = mantissa.replace(".", "").replace(/^0+/, "");
  if (!decimal) digits = digits.replace(/0+$/, "");
  return Math.max(1, digits.length);
}

/** Numbers in prose or plain math, with thousands separators ("20 000", "3,000") and "a × 10^b". */
export function numbersIn(raw: string): FoundNumber[] {
  const s = texToPlain(raw)
    .replace(/\bp\.\s*\d+/gi, " ")
    .replace(/(?<![\d.]\s*(?:×|x|\*)\s*)\b10\s*\^\s*\(?([-−]?\d+)\)?/g, "1 × 10^$1");
  const out: FoundNumber[] = [];
  for (const m of s.matchAll(NUM_RE)) {
    const [whole, sign, int, frac, exp] = m;
    let value = Number(`${int!.replace(/[^\d]/g, "")}${frac ? `.${frac}` : ""}`);
    if (exp) value *= 10 ** Number(exp.replace("−", "-"));
    if (sign) value = -value;
    if (!Number.isFinite(value)) continue;
    out.push({ text: whole.trim(), value, decimals: exp ? 0 : (frac?.length ?? 0), significantFigures: significantFigures(whole) });
  }
  return out;
}

interface FoundQuantity {
  text: string;
  number: FoundNumber;
  dimension: string;
  baseValue: number;
}

const QUANTITY_RE =
  /([-−]?(?:\d{1,3}(?:[,\u00a0\u202f ]\d{3})+|\d+)(?:\.\d+)?(?:\s*(?:×|x|\*)\s*10\s*\^\s*\(?[-−]?\d+\)?)?)\s*(kilometres?\s+per\s+second|meters?\s+per\s+second|metres?\s+per\s+second|km\s*\/\s*s|m\s*\/\s*s(?:²|\^2)?|米\s*\/\s*秒(?:²|\^2)?|千米\s*\/\s*秒|kilohertz|kHz|hertz|Hz|赫兹|kilograms?|kg|千克|grams?|g|newtons?|N|牛顿|centimetres?|centimeters?|cm|millimetres?|millimeters?|mm|kilometres?|kilometers?|km|metres?|meters?|m|米|seconds?|s|秒)(?![A-Za-z])/giu;

function normalizedUnit(raw: string): { dimension: string; factor: number } | undefined {
  const unit = raw.toLowerCase().replace(/\s+/g, "");
  if (["kilometrespersecond", "kilometerspersecond", "km/s", "千米/秒"].includes(unit)) return { dimension: "speed", factor: 1e3 };
  if (["metrespersecond", "meterspersecond", "m/s", "米/秒"].includes(unit)) return { dimension: "speed", factor: 1 };
  if (["m/s²", "m/s^2", "米/秒²", "米/秒^2"].includes(unit)) return { dimension: "acceleration", factor: 1 };
  if (["kilohertz", "khz"].includes(unit)) return { dimension: "frequency", factor: 1e3 };
  if (["hertz", "hz", "赫兹"].includes(unit)) return { dimension: "frequency", factor: 1 };
  if (["kilogram", "kilograms", "kg", "千克"].includes(unit)) return { dimension: "mass", factor: 1 };
  if (["gram", "grams", "g"].includes(unit)) return { dimension: "mass", factor: 1e-3 };
  if (["newton", "newtons", "n", "牛顿"].includes(unit)) return { dimension: "force", factor: 1 };
  if (["kilometre", "kilometres", "kilometer", "kilometers", "km"].includes(unit)) return { dimension: "length", factor: 1e3 };
  if (["centimetre", "centimetres", "centimeter", "centimeters", "cm"].includes(unit)) return { dimension: "length", factor: 1e-2 };
  if (["millimetre", "millimetres", "millimeter", "millimeters", "mm"].includes(unit)) return { dimension: "length", factor: 1e-3 };
  if (["metre", "metres", "meter", "meters", "m", "米"].includes(unit)) return { dimension: "length", factor: 1 };
  if (["second", "seconds", "s", "秒"].includes(unit)) return { dimension: "time", factor: 1 };
}

function quantitiesIn(raw: string): FoundQuantity[] {
  const out: FoundQuantity[] = [];
  for (const match of texToPlain(raw).matchAll(QUANTITY_RE)) {
    const number = numbersIn(match[1]!)[0];
    const unit = normalizedUnit(match[2]!);
    if (!number || !unit) continue;
    out.push({ text: match[0].trim(), number, dimension: unit.dimension, baseValue: number.value * unit.factor });
  }
  return out;
}

const SCALES = [1, 1e3, 1e-3, 1e6, 1e-6, 100, 0.01];
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

function inSource(n: FoundNumber, source: number[]): boolean {
  const tol = Math.max(Math.abs(n.value) * 1e-9, 1e-12);
  return source.some((v) => SCALES.some((k) => close(n.value, v * k, tol * Math.max(1, k))));
}

function matchingSourceNumbers(n: FoundNumber, source: FoundNumber[]): FoundNumber[] {
  const tol = Math.max(Math.abs(n.value) * 1e-9, 1e-12);
  return source.filter((candidate) => SCALES.some((k) => close(n.value, candidate.value * k, tol * Math.max(1, k))));
}

const isTrivial = (n: FoundNumber) => n.decimals === 0 && Number.isInteger(n.value) && Math.abs(n.value) <= TRIVIAL_MAX;

/** A tiny safe arithmetic evaluator: numbers, + − × ÷ * / ^, parentheses. Undefined when anything else is left. */
export function evalArithmetic(expr: string): number | undefined {
  const src = expr.replace(/[−–]/g, "-").replace(/[×·]/g, "*").replace(/÷/g, "/").replace(/(?<=\d)\s+(?=\d{3}(?!\d))/g, "").replace(/\s+/g, "");
  if (!src || /[^0-9.+\-*/^()e]/.test(src)) return undefined;
  let i = 0;
  const peek = () => src[i];
  const num = (): number | undefined => {
    const m = /^\d+(?:\.\d+)?(?:e[-+]?\d+)?/.exec(src.slice(i));
    if (!m) return undefined;
    i += m[0].length;
    return Number(m[0]);
  };
  const atom = (): number | undefined => {
    if (peek() === "-") {
      i++;
      const v = atom();
      return v === undefined ? undefined : -v;
    }
    if (peek() === "(") {
      i++;
      const v = sum();
      if (peek() !== ")") return undefined;
      i++;
      return v;
    }
    return num();
  };
  const pow = (): number | undefined => {
    const b = atom();
    if (b === undefined) return undefined;
    if (peek() === "^") {
      i++;
      const e = pow();
      return e === undefined ? undefined : b ** e;
    }
    return b;
  };
  const prod = (): number | undefined => {
    let v = pow();
    while (v !== undefined && (peek() === "*" || peek() === "/")) {
      const op = src[i++];
      const r = pow();
      if (r === undefined) return undefined;
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number | undefined => {
    let v = prod();
    while (v !== undefined && (peek() === "+" || peek() === "-")) {
      const op = src[i++];
      const r = prod();
      if (r === undefined) return undefined;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  return i === src.length && v !== undefined && Number.isFinite(v) ? v : undefined;
}

const UNIT = String.raw`(?:k|M|m|c|μ|n)?(?:m|s|g|N|J|W|Hz|A|V|Ω|K|Pa|mol|L|h|min)(?:\s*\/\s*(?:k|M|m|c)?(?:m|s|g|h|min|mol|L)(?:²|³|\^2|\^3)?)?(?:²|³|\^2|\^3)?|°C|°|%`;
const UNIT_RE = new RegExp(String.raw`(?<=[\d)\s])(?:${UNIT})(?![\p{L}])`, "gu");

/** Strips units after numbers; undefined if other letters (variables) remain. */
function arithmeticOf(part: string): string | undefined {
  const s = part.replace(/(?<=\d)\s*x\s*(?=\d)/g, "×").replace(UNIT_RE, " ").trim();
  if (/[\p{L}]/u.test(s.replace(/e(?=[-+]?\d)/g, ""))) return undefined;
  return s;
}

const hasOperator = (s: string) => /\d\s*[-−+×*/÷^]\s*[\d(]|\)\s*[×*/÷]/.test(s);

type Side = { kind: "number"; n: FoundNumber } | { kind: "expr"; expr: string; value: number } | { kind: "symbolic" };

/** One side of an equation: a single number (units stripped), an arithmetic expression, or anything else. */
function sideOf(part: string): Side {
  const ar = arithmeticOf(part.replace(/^[≈~]\s*/, ""));
  if (ar === undefined || !ar) return { kind: "symbolic" };
  const nums = numbersIn(ar);
  if (nums.length === 1 && ar.replace(/\s+/g, "") === nums[0]!.text.replace(/\s+/g, "")) return { kind: "number", n: nums[0]! };
  if (!hasOperator(ar)) return { kind: "symbolic" };
  const value = evalArithmetic(ar);
  return value === undefined ? { kind: "symbolic" } : { kind: "expr", expr: ar, value };
}

/**
 * Calculations in the texts: "v = 4 × 0.5 = 2 m/s" checks 4 × 0.5 against 2; a line "v = 5 × 0.4"
 * followed later by "v = 2" checks across lines (worked-example steps).
 */
function calcIssues(texts: string[]): { issues: Unverified[]; results: number[] } {
  const issues: Unverified[] = [];
  const results: number[] = [];
  const pending = new Map<string, { expr: string; value: number }>();
  const check = (text: string, value: number, r: FoundNumber) => {
    const tol = Math.max(Math.abs(r.value) * 0.01, 0.5 * 10 ** -r.decimals);
    if (close(value, r.value, tol)) results.push(r.value);
    else issues.push({ kind: "calc", text: text.slice(0, 120), detail: `计算结果应约为 ${round(value)} · computes to ${round(value)}` });
  };
  for (const raw of texts) {
    for (const piece of raw.split("$")) {
      const plain = texToPlain(piece);
      if (!plain.includes("=")) continue;
      const parts = plain.split(/=|≈/).map((p) => p.trim());
      const lhs = /(?:^|\s)([\p{L}][\p{L}_\d]{0,2})$/u.exec(parts[0] ?? "")?.[1];
      const sides = parts.map(sideOf);
      for (let k = 0; k + 1 < sides.length; k++) {
        const a = sides[k]!;
        const b = sides[k + 1]!;
        if (a.kind === "expr" && b.kind === "number") check(`${a.expr} = ${b.n.text}`, a.value, b.n);
      }
      if (lhs && sides.length === 2) {
        const r = sides[1]!;
        if (r.kind === "expr") pending.set(lhs, { expr: r.expr, value: r.value });
        else if (r.kind === "number" && pending.has(lhs)) {
          const p = pending.get(lhs)!;
          pending.delete(lhs);
          check(`${lhs} = ${p.expr} = ${r.n.text}`, p.value, r.n);
        }
      }
    }
  }
  return { issues, results };
}

const round = (v: number) => (Math.abs(v) >= 1e6 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : String(Math.round(v * 1e4) / 1e4));

const LATIN_FUNCS = /\b(?:sin|cos|tan|log|ln|sqrt|exp|max|min)\b/g;
const GREEK_WORDS = new RegExp(String.raw`\b(${Object.keys(GREEK).join("|")})\b`, "gi");

/** Symbols of a formula: single letters (TeX juxtaposition = product), Greek as Unicode, subscripts dropped. */
export function symbolsOf(formula: string, tex: boolean): Set<string> {
  let s = tex ? texToPlain(formula) : formula;
  s = s.replace(GREEK_WORDS, (w) => GREEK[w] ?? GREEK[w.toLowerCase()] ?? w).replace(LATIN_FUNCS, " ").replace(/_\s*\(?[\p{L}\d]+\)?/gu, "");
  const out = new Set<string>();
  if (tex) for (const ch of s.replace(/\b(?:sin|cos|tan|log|ln|sqrt|exp)\b/g, "")) if (/[A-Za-zα-ωΑ-Ω]/.test(ch)) out.add(ch);
  if (!tex) for (const w of s.split(/[^A-Za-zα-ωΑ-Ω]+/)) if (w.length === 1) out.add(w);
  return out;
}

function monomialOf(raw: string): Map<string, number> | undefined {
  const text = texToPlain(raw)
    .replace(GREEK_WORDS, (word) => GREEK[word] ?? GREEK[word.toLowerCase()] ?? word)
    .replace(/\s+x\s+/gi, "*")
    .replace(/[×·]/g, "*")
    .replace(/[(){}\s]/g, "");
  if (!text || /[+=]/.test(text) || /-(?!\d)/.test(text)) return undefined;
  const powers = new Map<string, number>();
  let direction = 1;
  for (let i = 0; i < text.length; ) {
    const char = text[i]!;
    if (char === "*" || char === "·") {
      direction = 1;
      i++;
      continue;
    }
    if (char === "/") {
      direction = -1;
      i++;
      continue;
    }
    if (/\d|\./.test(char)) {
      i++;
      continue;
    }
    if (!/[A-Za-zα-ωΑ-Ω]/.test(char)) return undefined;
    let exponent = 1;
    const rest = text.slice(i + 1);
    const explicit = /^\^(-?\d+)/.exec(rest);
    if (explicit) {
      exponent = Number(explicit[1]);
      i += explicit[0].length;
    } else if (rest[0] === "²" || rest[0] === "³") {
      exponent = rest[0] === "²" ? 2 : 3;
      i++;
    }
    powers.set(char, (powers.get(char) ?? 0) + direction * exponent);
    direction = 1;
    i++;
  }
  return powers.size ? powers : undefined;
}

/** Canonical multiplicative-law fingerprint: F=ma and a=F/m are equal; a=Fm is not. */
function formulaFingerprint(raw: string): string | undefined {
  const plain = texToPlain(raw);
  const at = plain.indexOf("=");
  if (at < 0) return undefined;
  const lhsToken = /(?:^|[\s:])([A-Za-zα-ωΑ-Ω])\s*$/.exec(plain.slice(0, at))?.[1];
  if (!lhsToken) return undefined;
  const right = plain
    .slice(at + 1)
    .split(/[.;,，。；]|(?:\s{2,})/)[0]!
    .trim();
  const lhs = monomialOf(lhsToken);
  const rhs = monomialOf(right);
  if (!lhs || !rhs) return undefined;
  const powers = new Map(lhs);
  for (const [symbol, exponent] of rhs) powers.set(symbol, (powers.get(symbol) ?? 0) - exponent);
  for (const [symbol, exponent] of powers) if (exponent === 0) powers.delete(symbol);
  const entries = [...powers].sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return undefined;
  if (entries[0]![1] < 0) entries.forEach((entry) => (entry[1] *= -1));
  return entries.map(([symbol, exponent]) => `${symbol}:${exponent}`).join("|");
}

interface SourceFormula {
  symbols: Set<string>;
  fingerprint?: string;
}

function sourceFormulas(source: string): SourceFormula[] {
  const mathSpans = [...source.matchAll(/\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$/g)]
    .map((m) => (m[1] ?? m[2] ?? "").trim())
    .filter((s) => /=/.test(s))
    .map((text) => ({ symbols: symbolsOf(text, true), fingerprint: formulaFingerprint(text) }));
  const proseLines = source
    .split(/(?<=[.!?。！？])\s+|\n/)
    .filter((s) => /=/.test(s))
    .map((text) => ({ symbols: symbolsOf(text, false), fingerprint: formulaFingerprint(text) }));
  return [...mathSpans, ...proseLines];
}

/** Equations that are symbolic (no digits on the right-hand side): candidates for the formula check. */
function formulasOf(texts: { text: string; tex: boolean }[]): { text: string; tex: boolean }[] {
  const out: { text: string; tex: boolean }[] = [];
  for (const t of texts) {
    const pieces = t.tex ? [t.text] : t.text.split("$").filter((_, i) => i % 2 === 1);
    for (const p of pieces) {
      const parts = p.split("=");
      if (parts.length < 2) continue;
      if (parts.slice(1).every((x) => sideOf(texToPlain(x)).kind !== "symbolic")) continue;
      if (symbolsOf(p, true).size < 2) continue;
      out.push({ text: p.trim(), tex: true });
    }
  }
  return out;
}

function widgetTexts(w: WidgetSpec | undefined): { prose: string[]; tex: string[]; data: number[] } {
  if (!w) return { prose: [], tex: [], data: [] };
  switch (w.kind) {
    case "formula":
      return { prose: w.caption ? [w.caption] : [], tex: [w.tex], data: [] };
    case "chart":
      return { prose: [w.xLabel, w.yLabel, ...(w.categories ?? []), ...w.series.map((s) => s.name)], tex: [], data: w.series.flatMap((s) => s.data.flatMap((v) => (typeof v === "number" ? [v] : v))) };
    case "table":
      return { prose: [...w.columns, ...w.rows.flat(), w.caption ?? ""], tex: [], data: [] };
    case "flow":
      return { prose: w.steps, tex: [], data: [] };
    default:
      return { prose: [], tex: [], data: [] };
  }
}

function slideTexts(c: SlideContent): { prose: string[]; tex: string[]; data: number[] } {
  const w = (x: WidgetSpec) => widgetTexts(x);
  let prose: string[];
  let extra = { prose: [] as string[], tex: [] as string[], data: [] as number[] };
  switch (c.layout) {
    case "title":
      prose = [c.title, c.subtitle, ...c.objectives];
      break;
    case "statement":
      prose = [c.title, ...c.bullets, ...c.terms.map((t) => t.term)];
      extra = w(c.visual);
      break;
    case "chart":
      prose = [c.title, ...c.takeaways];
      extra = w(c.chart);
      break;
    case "steps":
      prose = [c.title, c.problem, ...c.steps.flatMap((s) => [s.text, s.why])];
      break;
    case "experiment":
      prose = [c.title, c.predict.question, ...c.predict.options, ...c.observe, c.explain];
      break;
    case "quiz":
      prose = [c.question, ...c.options.map((o) => o.text), c.explain];
      break;
    case "questions":
      prose = [c.title, ...c.items.flatMap((i) => [i.q, i.a])];
      break;
    case "order":
      prose = [c.title, ...c.items.flatMap((i) => [i.text, i.match])];
      break;
    case "summary":
      prose = [c.title, ...c.nodes.flatMap((n) => [n.head, n.detail])];
      break;
  }
  return { prose: [...prose, ...extra.prose].filter(Boolean), tex: extra.tex, data: extra.data };
}

export interface VerifyOptions {
  pageType?: PageType;
  /** Speaker notes: their calculations (answer keys) are re-checked too. */
  notes?: string;
}

/** Numbers, formulas and calculations on a slide that the cited source text does not support. */
export function verifyNumbers(content: SlideContent, source: string, opts: VerifyOptions = {}): Unverified[] {
  const { prose, tex, data } = slideTexts(content);
  const out: Unverified[] = [];
  const seen = new Set<string>();
  const add = (u: Unverified) => {
    const key = `${u.kind}:${u.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(u);
  };

  const calc = calcIssues([...prose, ...tex, ...(opts.notes ? opts.notes.split(/\n/) : [])]);
  calc.issues.forEach(add);

  const problem = PROBLEM_LAYOUTS.has(content.layout) || (opts.pageType !== undefined && PROBLEM_TYPES.has(opts.pageType));
  if (!problem) {
    const sourceFound = numbersIn(source);
    const sourceNums = sourceFound.map((n) => n.value);
    const verified = [...sourceNums, ...calc.results];
    const textCandidates = [...prose, ...tex].flatMap(numbersIn);
    const candidates = textCandidates.concat(
      data.map((v) => ({ text: String(v), value: v, decimals: (String(v).split(".")[1] ?? "").length, significantFigures: significantFigures(String(v)) })),
    );
    for (const n of candidates) {
      if (isTrivial(n)) continue;
      const sourceMatches = matchingSourceNumbers(n, sourceFound);
      if (sourceMatches.length || inSource(n, calc.results)) {
        if (textCandidates.includes(n) && sourceMatches.length && !sourceMatches.some((match) => match.significantFigures === n.significantFigures)) {
          add({ kind: "number", text: n.text, detail: "引用页中的有效数字精度不同 · significant figures do not match the cited pages" });
        }
        continue;
      }
      if (inSource(n, verified)) continue;
      add({ kind: "number", text: n.text, detail: "引用页中没有找到这个数 · not found on the cited pages" });
    }
    const sourceQuantities = quantitiesIn(source);
    for (const quantity of [...prose, ...tex].flatMap(quantitiesIn)) {
      // The literal/scaled number exists, but the cited page does not support this value-unit pair.
      if (!inSource(quantity.number, sourceNums)) continue;
      const supported = sourceQuantities.some((candidate) => {
        const tolerance = Math.max(Math.abs(quantity.baseValue) * 1e-9, 1e-12);
        return candidate.dimension === quantity.dimension && close(candidate.baseValue, quantity.baseValue, tolerance);
      });
      if (!supported) add({ kind: "number", text: quantity.text, detail: "引用页中的单位或量纲不一致 · unit or dimension does not match the cited pages" });
    }
  }

  const srcFormulas = sourceFormulas(source);
  const formulaTexts = formulasOf([...prose.map((text) => ({ text, tex: false })), ...tex.map((text) => ({ text, tex: true }))]);
  for (const f of formulaTexts) {
    const syms = symbolsOf(f.text, true);
    const fingerprint = formulaFingerprint(f.text);
    const comparable = srcFormulas.filter((candidate) => [...syms].every((symbol) => candidate.symbols.has(symbol)));
    const ok = comparable.some((candidate) => !fingerprint || !candidate.fingerprint || candidate.fingerprint === fingerprint);
    if (!ok) add({ kind: "formula", text: f.text.slice(0, 120), detail: "引用页中没有找到这个公式 · formula not found on the cited pages" });
  }
  return out.slice(0, MAX_FLAGS);
}
