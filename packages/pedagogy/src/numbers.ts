import { stripRichMarkers, type PageType, type SlideContent, type Unverified, type WidgetSpec } from "@kj/schema";

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
  maxSignificantFigures?: number;
  exactFraction?: boolean;
}

// CJK normally has no spaces around quantities ("12牛顿"), while Latin chemical tokens (CO2/H2O) stay excluded.
const NUM_RE = /(?<![A-Za-z\d_.])([-−]?)(\d{1,3}(?:[,\u00a0\u202f ]\d{3})+(?!\d)|\d+)(?:\.(\d+))?(?:\s*(?:×|x|\*)\s*10\s*\^\s*\(?([-−]?\d+)\)?)?/g;
const FRAC_RE = /(?<![A-Za-z\d_./])([-−]?)\(?\s*(\d{1,2})\s*\)?\s*\/\s*\(?\s*([1-9]\d?)\s*\)?(?![A-Za-z\d_./])/g;

function sigFigRange(text: string): { min: number; max: number } {
  const mantissa = text.split(/\s*(?:×|x|\*)\s*10\s*\^/i)[0]!.replace(/[-−+,\u00a0\u202f ]/g, "");
  const decimal = mantissa.includes(".");
  const stripped = mantissa.replace(".", "").replace(/^0+/, "");
  if (!stripped) return { min: 1, max: 1 };
  if (decimal) return { min: stripped.length, max: stripped.length };
  const min = Math.max(1, stripped.replace(/0+$/, "").length);
  return { min, max: stripped.length };
}

/** Numbers in prose or plain math, with thousands separators ("20 000", "3,000") and "a × 10^b". */
export function numbersIn(raw: string): FoundNumber[] {
  const s = texToPlain(stripRichMarkers(raw))
    .replace(/\bp\.\s*\d+/gi, " ")
    .replace(/(?<![\d.]\s*(?:×|x|\*)\s*)\b10\s*\^\s*\(?([-−]?\d+)\)?/g, "1 × 10^$1");
  const out: FoundNumber[] = [];
  for (const m of s.matchAll(NUM_RE)) {
    const [whole, sign, int, frac, exp] = m;
    let value = Number(`${int!.replace(/[^\d]/g, "")}${frac ? `.${frac}` : ""}`);
    if (exp) value *= 10 ** Number(exp.replace("−", "-"));
    if (sign) value = -value;
    if (!Number.isFinite(value)) continue;
    const range = sigFigRange(whole);
    out.push({ text: whole.trim(), value, decimals: exp ? 0 : (frac?.length ?? 0), significantFigures: range.min, maxSignificantFigures: range.max });
  }
  return out;
}

function fractionNumbersIn(raw: string): FoundNumber[] {
  const s = texToPlain(stripRichMarkers(raw)).replace(/\bp\.\s*\d+/gi, " ");
  const out: FoundNumber[] = [];
  for (const m of s.matchAll(FRAC_RE)) {
    const [, sign, numStr, denStr] = m;
    const p = Number(numStr);
    const q = Number(denStr);
    if (!q || q < 2 || q > 20 || p < 1 || p > 20) continue;
    const value = (sign ? -1 : 1) * (p / q);
    const decPart = String(Math.abs(value)).split(".")[1] ?? "";
    out.push({ text: `${sign ?? ""}${p}/${q}`, value, decimals: decPart.length, significantFigures: 1, maxSignificantFigures: 4, exactFraction: true });
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
  /([-−]?(?:(?:\(\s*\d{1,2}\s*\)\s*\/\s*\(\s*[1-9]\d?\s*\)|\d{1,2}\s*\/\s*[1-9]\d?)|(?:\d{1,3}(?:[,\u00a0\u202f ]\d{3})+|\d+)(?:\.\d+)?(?:\s*(?:×|x|\*)\s*10\s*\^\s*\(?[-−]?\d+\)?)?))\s*(kJ\s*\/\s*mol|J\s*\/\s*mol|千焦\s*\/\s*摩(?:尔)?|焦(?:耳)?\s*\/\s*摩(?:尔)?|kilometres?\s+per\s+second|kilometers?\s+per\s+second|metres?\s+per\s+second|meters?\s+per\s+second|km\s*\/\s*s|m\s*\/\s*s(?:²|\^2)?|cm\s*\/\s*s|米\s*\/\s*秒(?:²|\^2)?|千米\s*\/\s*秒|厘米\s*\/\s*秒|kilohertz|kHz|千赫|hertz|Hz|赫兹|kilograms?|kg|千克|grams?|g|克|kilonewtons?|kN|千牛|newtons?|N|牛顿|牛|megajoules?|MJ|兆焦|kilojoules?|kJ|千焦|joules?|J|焦耳|焦|megawatts?|MW|兆瓦|kilowatts?|kW|千瓦|watts?|W|瓦特|瓦|kilovolts?|kV|千伏|millivolts?|mV|毫伏|volts?|V|伏特|伏|milliamperes?|milliamps?|mA|毫安|amperes?|amps?|A|安培|安|kiloohms?|kilohms?|kΩ|千欧|ohms?|Ω|欧姆|欧|megapascals?|MPa|兆帕|kilopascal?s?|kPa|千帕|pascals?|Pa|帕斯卡|帕|degrees?\s+celsius|celsius|°C|℃|摄氏度|kelvins?|K|开尔文|moles?|mol|摩尔|摩|millilitres?|milliliters?|mL|毫升|litres?|liters?|L|升|millicoulombs?|mC|毫库|coulombs?|C|库仑|库|kilometres?|kilometers?|km|千米|公里|centimetres?|centimeters?|cm|厘米|millimetres?|millimeters?|mm|毫米|metres?|meters?|m|米|seconds?|s|秒)(?![A-Za-z²³^/])(?!(?:\s*[×·*])?\s*[A-Za-zα-ωΑ-Ω]\s*(?:\^|[²³]|_))/giu;

function normalizedUnit(raw: string): { dimension: string; factor: number } | undefined {
  const exact = raw.replace(/\s+/g, "");
  const unit = exact.toLowerCase();
  if (["kj/mol", "千焦/摩", "千焦/摩尔"].includes(unit)) return { dimension: "molar_energy", factor: 1e3 };
  if (["j/mol", "焦/摩", "焦/摩尔", "焦耳/摩", "焦耳/摩尔"].includes(unit)) return { dimension: "molar_energy", factor: 1 };
  if (["kilometrespersecond", "kilometerspersecond", "km/s", "千米/秒"].includes(unit)) return { dimension: "speed", factor: 1e3 };
  if (["metrespersecond", "meterspersecond", "m/s", "米/秒"].includes(unit)) return { dimension: "speed", factor: 1 };
  if (["cm/s", "厘米/秒"].includes(unit)) return { dimension: "speed", factor: 1e-2 };
  if (["m/s²", "m/s^2", "米/秒²", "米/秒^2"].includes(unit)) return { dimension: "acceleration", factor: 1 };
  if (["kilohertz", "khz", "千赫"].includes(unit)) return { dimension: "frequency", factor: 1e3 };
  if (["hertz", "hz", "赫兹"].includes(unit)) return { dimension: "frequency", factor: 1 };
  if (["kilogram", "kilograms", "kg", "千克"].includes(unit)) return { dimension: "mass", factor: 1 };
  if (["gram", "grams", "克"].includes(unit) || exact === "g") return { dimension: "mass", factor: 1e-3 };
  if (["kilonewton", "kilonewtons", "千牛"].includes(unit) || exact === "kN") return { dimension: "force", factor: 1e3 };
  if (["newton", "newtons", "牛顿", "牛"].includes(unit) || exact === "N") return { dimension: "force", factor: 1 };
  if (["megajoule", "megajoules", "兆焦"].includes(unit) || exact === "MJ") return { dimension: "energy", factor: 1e6 };
  if (["kilojoule", "kilojoules", "千焦"].includes(unit) || exact === "kJ") return { dimension: "energy", factor: 1e3 };
  if (["joule", "joules", "焦耳", "焦"].includes(unit) || exact === "J") return { dimension: "energy", factor: 1 };
  if (["megawatt", "megawatts", "兆瓦"].includes(unit) || exact === "MW") return { dimension: "power", factor: 1e6 };
  if (["kilowatt", "kilowatts", "千瓦"].includes(unit) || exact === "kW") return { dimension: "power", factor: 1e3 };
  if (["watt", "watts", "瓦特", "瓦"].includes(unit) || exact === "W") return { dimension: "power", factor: 1 };
  if (["kilovolt", "kilovolts", "千伏"].includes(unit) || exact === "kV") return { dimension: "voltage", factor: 1e3 };
  if (["millivolt", "millivolts", "毫伏"].includes(unit) || exact === "mV") return { dimension: "voltage", factor: 1e-3 };
  if (["volt", "volts", "伏特", "伏"].includes(unit) || exact === "V") return { dimension: "voltage", factor: 1 };
  if (["milliampere", "milliamperes", "milliamps", "毫安"].includes(unit) || exact === "mA") return { dimension: "current", factor: 1e-3 };
  if (["ampere", "amperes", "amp", "amps", "安培", "安"].includes(unit) || exact === "A") return { dimension: "current", factor: 1 };
  if (["kiloohm", "kiloohms", "kilohm", "kilohms", "千欧"].includes(unit) || exact === "kΩ") return { dimension: "resistance", factor: 1e3 };
  if (["ohm", "ohms", "Ω", "ω", "欧姆", "欧"].includes(unit) && (exact !== "ω")) return { dimension: "resistance", factor: 1 };
  if (["megapascal", "megapascals", "兆帕"].includes(unit) || exact === "MPa") return { dimension: "pressure", factor: 1e6 };
  if (["kilopascal", "kilopascals", "千帕"].includes(unit) || exact === "kPa") return { dimension: "pressure", factor: 1e3 };
  if (["pascal", "pascals", "帕斯卡", "帕"].includes(unit) || exact === "Pa") return { dimension: "pressure", factor: 1 };
  if (["degreescelsius", "degreecelsius", "celsius", "°c", "℃", "摄氏度"].includes(unit)) return { dimension: "temperature_c", factor: 1 };
  if (["kelvin", "kelvins", "开尔文"].includes(unit) || exact === "K") return { dimension: "temperature_k", factor: 1 };
  if (["mole", "moles", "mol", "摩尔", "摩"].includes(unit)) return { dimension: "amount", factor: 1 };
  if (["millilitre", "millilitres", "milliliter", "milliliters", "毫升"].includes(unit) || exact === "mL" || exact === "ml") return { dimension: "volume", factor: 1e-3 };
  if (["litre", "litres", "liter", "liters", "升"].includes(unit) || exact === "L") return { dimension: "volume", factor: 1 };
  if (["millicoulomb", "millicoulombs", "毫库"].includes(unit) || exact === "mC") return { dimension: "charge", factor: 1e-3 };
  if (["coulomb", "coulombs", "库仑", "库"].includes(unit) || exact === "C") return { dimension: "charge", factor: 1 };
  if (["kilometre", "kilometres", "kilometer", "kilometers", "km", "千米", "公里"].includes(unit)) return { dimension: "length", factor: 1e3 };
  if (["centimetre", "centimetres", "centimeter", "centimeters", "cm", "厘米"].includes(unit)) return { dimension: "length", factor: 1e-2 };
  if (["millimetre", "millimetres", "millimeter", "millimeters", "mm", "毫米"].includes(unit)) return { dimension: "length", factor: 1e-3 };
  if (["metre", "metres", "meter", "meters", "米"].includes(unit) || exact === "m") return { dimension: "length", factor: 1 };
  if (["second", "seconds", "秒"].includes(unit) || exact === "s") return { dimension: "time", factor: 1 };
}

function quantitiesIn(raw: string): FoundQuantity[] {
  const out: FoundQuantity[] = [];
  for (const match of texToPlain(stripRichMarkers(raw)).matchAll(QUANTITY_RE)) {
    const number = fractionNumbersIn(match[1]!)[0] ?? numbersIn(match[1]!)[0];
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
    for (const piece of stripRichMarkers(raw).split("$")) {
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

const MATH_SPAN_CHARS = /[A-Za-zα-ωΑ-Ω\d.+\-−*×·/÷^()²³\s]/;
const OP_EDGE_END = /[+\-−*×·/÷^(]$/;
const OP_EDGE_START = /^[+\-−*×·/÷^)]/;

function isMathProductToken(word: string): boolean {
  if (/[α-ωΑ-Ω]/.test(word)) return true;
  if (word.length <= 3) return true;
  return word.length === 4 && /[A-Z]/.test(word.slice(1));
}

function juxtaposedEquationSymbols(s: string, out: Set<string>): void {
  for (let at = s.indexOf("="); at >= 0; at = s.indexOf("=", at + 1)) {
    let l = at;
    while (l > 0 && MATH_SPAN_CHARS.test(s[l - 1]!)) l--;
    const leftTokens = s.slice(l, at).trim().split(/\s+/).filter(Boolean);
    const picked: string[] = [];
    if (leftTokens.length) {
      picked.push(leftTokens[leftTokens.length - 1]!);
      for (let i = leftTokens.length - 2; i >= 0; i--) {
        const prev = leftTokens[i]!;
        const curr = leftTokens[i + 1]!;
        if (OP_EDGE_END.test(prev) || OP_EDGE_START.test(curr) || prev === "x" || curr === "x") picked.push(prev);
        else break;
      }
    }
    let r = at + 1;
    while (r < s.length && MATH_SPAN_CHARS.test(s[r]!)) r++;
    const rightTokens = s.slice(at + 1, r).trim().split(/\s+/).filter(Boolean);
    if (rightTokens.length) {
      picked.push(rightTokens[0]!);
      for (let i = 1; i < rightTokens.length; i++) {
        const prev = rightTokens[i - 1]!;
        const next = rightTokens[i]!;
        if (OP_EDGE_END.test(prev) || OP_EDGE_START.test(next) || prev === "x" || next === "x" || /^[\d.()/²³^+-]+$/.test(prev)) picked.push(next);
        else break;
      }
    }
    for (const token of picked) {
      for (const word of token.split(/[^A-Za-zα-ωΑ-Ω]+/)) {
        if (word.length >= 2 && isMathProductToken(word)) {
          for (const ch of word) out.add(ch);
        }
      }
    }
  }
}

/** Symbols of a formula: single letters (TeX juxtaposition = product), Greek as Unicode, subscripts dropped. */
export function symbolsOf(formula: string, tex: boolean): Set<string> {
  let s = tex ? texToPlain(formula) : stripRichMarkers(formula);
  s = s.replace(GREEK_WORDS, (w) => GREEK[w] ?? GREEK[w.toLowerCase()] ?? w).replace(LATIN_FUNCS, " ").replace(/_\s*\(?[\p{L}\d]+\)?/gu, "");
  const out = new Set<string>();
  if (tex) for (const ch of s.replace(/\b(?:sin|cos|tan|log|ln|sqrt|exp)\b/g, "")) if (/[A-Za-zα-ωΑ-Ω]/.test(ch)) out.add(ch);
  if (!tex) {
    for (const w of s.split(/[^A-Za-zα-ωΑ-Ω]+/)) if (w.length === 1) out.add(w);
    juxtaposedEquationSymbols(s, out);
  }
  return out;
}

function stripSubscripts(s: string): string {
  return s.replace(/_\s*\(?[A-Za-zα-ωΑ-Ω\d]+\)?/gu, "");
}

function monomialOf(raw: string): Map<string, number> | undefined {
  const text = stripSubscripts(texToPlain(raw))
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

function splitSignedTerms(raw: string): { sign: 1 | -1; body: string }[] | undefined {
  const normalized = raw.replace(/[−–]/g, "-").trim();
  if (!normalized) return undefined;
  const terms: { sign: 1 | -1; body: string }[] = [];
  let depth = 0;
  let start = 0;
  let sign: 1 | -1 = 1;
  let i = 0;
  if (normalized[0] === "+" || normalized[0] === "-") {
    sign = normalized[0] === "-" ? -1 : 1;
    i = 1;
    start = 1;
  }
  for (; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (ch === "(" || ch === "{") depth++;
    else if (ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === "+" || ch === "-") && normalized[i - 1] !== "^") {
      const body = normalized.slice(start, i).trim();
      if (!body) return undefined;
      terms.push({ sign, body });
      sign = ch === "-" ? -1 : 1;
      start = i + 1;
    }
  }
  const tail = normalized.slice(start).trim();
  if (!tail) return undefined;
  terms.push({ sign, body: tail });
  return terms;
}

function additiveTermOf(raw: string): { coeff: number; vars: string } | undefined {
  const text = texToPlain(raw)
    .replace(GREEK_WORDS, (word) => GREEK[word] ?? GREEK[word.toLowerCase()] ?? word)
    .replace(/\((\d+(?:\.\d+)?)\)\s*\/\s*\((\d+(?:\.\d+)?)\)/g, (_, a: string, b: string) => `${Number(a) / Number(b)}*`)
    .replace(/_\s*\(?([A-Za-z\d]+)\)?/g, (_, sub: string) => (/^\d+$/.test(sub) ? `_${sub}` : ""))
    .replace(/\s+x\s+/gi, "*")
    .replace(/[×·]/g, "*")
    .replace(/[(){}\s]/g, "");
  if (!text || /[+=]/.test(text) || /-(?!\d)/.test(text)) return undefined;
  const powers = new Map<string, number>();
  let coeff = 1;
  let direction = 1;
  for (let i = 0; i < text.length; ) {
    const char = text[i]!;
    if (char === "*") {
      direction = 1;
      i++;
      continue;
    }
    if (char === "/") {
      direction = -1;
      i++;
      continue;
    }
    const numMatch = /^\d+(?:\.\d+)?/.exec(text.slice(i));
    if (numMatch) {
      const n = Number(numMatch[0]);
      if (!n || !Number.isFinite(n)) return undefined;
      coeff = direction === 1 ? coeff * n : coeff / n;
      direction = 1;
      i += numMatch[0].length;
      continue;
    }
    const symMatch = /^[A-Za-zα-ωΑ-Ω](?:_\d+)?/.exec(text.slice(i));
    if (!symMatch) return undefined;
    const sym = symMatch[0];
    i += sym.length;
    let exponent = 1;
    const rest = text.slice(i);
    const explicit = /^\^(-?\d+)/.exec(rest);
    if (explicit) {
      exponent = Number(explicit[1]);
      i += explicit[0].length;
    } else if (rest[0] === "²" || rest[0] === "³") {
      exponent = rest[0] === "²" ? 2 : 3;
      i++;
    }
    powers.set(sym, (powers.get(sym) ?? 0) + direction * exponent);
    direction = 1;
  }
  const entries = [...powers].filter(([, e]) => e !== 0).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return undefined;
  return { coeff, vars: entries.map(([s, e]) => `${s}:${e}`).join("*") };
}

function extractAdditiveLhs(beforeEq: string): string | undefined {
  const tokens = beforeEq.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return undefined;
  const picked = [tokens[tokens.length - 1]!];
  for (let i = tokens.length - 2; i >= 0; i--) {
    const prev = tokens[i]!;
    const curr = tokens[i + 1]!;
    if (/[+\-−*×·/÷^]$/.test(prev) || /^[+\-−*×·/÷^]/.test(curr)) picked.unshift(prev);
    else break;
  }
  return picked.join(" ");
}

function additiveFingerprint(lhsRaw: string, rhsRaw: string): string | undefined {
  const lhsTerms = splitSignedTerms(lhsRaw);
  const rhsTerms = splitSignedTerms(rhsRaw);
  if (!lhsTerms || !rhsTerms || (lhsTerms.length === 1 && rhsTerms.length === 1)) return undefined;
  const net = new Map<string, number>();
  for (const [sideSign, list] of [
    [1, lhsTerms],
    [-1, rhsTerms],
  ] as const) {
    for (const term of list) {
      const parsed = additiveTermOf(term.body);
      if (!parsed) return undefined;
      net.set(parsed.vars, (net.get(parsed.vars) ?? 0) + sideSign * term.sign * parsed.coeff);
    }
  }
  const entries = [...net].filter(([, c]) => Math.abs(c) > 1e-9).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length < 2) return undefined;
  const scale = entries[0]![1];
  return `sum:${entries.map(([vars, c]) => `${vars}=${Math.round((c / scale) * 1e6) / 1e6}`).join("|")}`;
}

/** Canonical law fingerprint: F=ma ↔ a=F/m (not a=Fm), and v=u+at ↔ u=v-at (not v=u-at). */
function formulaFingerprint(raw: string): string | undefined {
  const plain = texToPlain(stripRichMarkers(raw));
  const at = plain.indexOf("=");
  if (at < 0) return undefined;
  const right = plain
    .slice(at + 1)
    .split(/[=≈.;,，。；！？（:\uff1a\p{Script=Han}]|(?:\s{2,})/u)[0]!
    .trim();
  const lhsToken = /(?<![A-Za-zα-ωΑ-Ω\d.])([A-Za-zα-ωΑ-Ω](?:_\s*\(?[A-Za-z\d]+\)?)?)\s*$/.exec(plain.slice(0, at))?.[1];
  if (lhsToken) {
    const lhs = monomialOf(lhsToken);
    const rhs = monomialOf(right);
    if (lhs && rhs) {
      const powers = new Map(lhs);
      for (const [symbol, exponent] of rhs) powers.set(symbol, (powers.get(symbol) ?? 0) - exponent);
      for (const [symbol, exponent] of powers) if (exponent === 0) powers.delete(symbol);
      const entries = [...powers].sort(([a], [b]) => a.localeCompare(b));
      if (!entries.length) return undefined;
      if (entries[0]![1] < 0) entries.forEach((entry) => (entry[1] *= -1));
      return entries.map(([symbol, exponent]) => `${symbol}:${exponent}`).join("|");
    }
  }
  const lhsExpr = extractAdditiveLhs(plain.slice(0, at));
  return lhsExpr ? additiveFingerprint(lhsExpr, right) : undefined;
}

interface SourceFormula {
  symbols: Set<string>;
  fingerprint?: string;
}

function sourceFormulas(source: string): SourceFormula[] {
  const cleanSource = stripRichMarkers(source);
  const mathSpans = [...cleanSource.matchAll(/\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$/g)]
    .map((m) => (m[1] ?? m[2] ?? "").trim())
    .filter((s) => /=/.test(s))
    .map((text) => ({ symbols: symbolsOf(text, true), fingerprint: formulaFingerprint(text) }));
  const proseLines = cleanSource
    .split(/(?<=[.!?;])\s+|(?<=[。；！？])\s*|[,，]\s*(?=[^,，\n]*=)|[\p{Script=Han}：（）]+|\n/u)
    .filter((s) => /=/.test(s))
    .map((text) => ({ symbols: symbolsOf(text, false), fingerprint: formulaFingerprint(text) }));
  return [...mathSpans, ...proseLines];
}

/** Equations that are symbolic (no digits on the right-hand side): candidates for the formula check. */
function formulasOf(texts: { text: string; tex: boolean }[]): { text: string; tex: boolean }[] {
  const out: { text: string; tex: boolean }[] = [];
  for (const t of texts) {
    const pieces = t.tex ? [t.text] : stripRichMarkers(t.text).split("$").filter((_, i) => i % 2 === 1);
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
  /** Cited source page numbers, when known (`[]` skips source-page flags on synthesis/problem slides). */
  sources?: readonly number[];
}

function sigFigsCompatible(candidate: FoundNumber, source: FoundNumber): boolean {
  if (candidate.exactFraction || source.exactFraction) return true;
  const cMin = candidate.significantFigures;
  const cMax = candidate.maxSignificantFigures ?? cMin;
  const sMin = source.significantFigures;
  const sMax = source.maxSignificantFigures ?? sMin;
  if (cMin <= sMax && sMin <= cMax) return true;
  const cleanC = candidate.text.replace(/[-−+,\u00a0\u202f ]/g, "");
  const cleanS = source.text.replace(/[-−+,\u00a0\u202f ]/g, "");
  return (
    close(candidate.value, source.value, 1e-9) &&
    ((/^[1-9]\d*0\.0+$/.test(cleanC) && /^[1-9]\d*0$/.test(cleanS)) || (/^[1-9]\d*0$/.test(cleanC) && /^[1-9]\d*0\.0+$/.test(cleanS)))
  );
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
  const synthesis = content.layout === "title" || content.layout === "summary" || opts.pageType === "cover" || opts.pageType === "summary";
  const uncitedSkip = (opts.sources !== undefined && opts.sources.length === 0) || (!source.trim() && (synthesis || problem));
  if (uncitedSkip) return out.slice(0, MAX_FLAGS);

  if (!problem) {
    const sourceFound = [...numbersIn(source), ...fractionNumbersIn(source)];
    const sourceNums = sourceFound.map((n) => n.value);
    const verified = [...sourceNums, ...calc.results];
    const textCandidates = [...prose, ...tex].flatMap(numbersIn);
    const candidates = textCandidates.concat(
      data.map((v) => {
        const range = sigFigRange(String(v));
        return { text: String(v), value: v, decimals: (String(v).split(".")[1] ?? "").length, significantFigures: range.min, maxSignificantFigures: range.max };
      }),
    );
    for (const n of candidates) {
      if (isTrivial(n)) continue;
      const sourceMatches = matchingSourceNumbers(n, sourceFound);
      if (sourceMatches.length || inSource(n, calc.results)) {
        if (textCandidates.includes(n) && sourceMatches.length && !sourceMatches.some((match) => sigFigsCompatible(n, match))) {
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
