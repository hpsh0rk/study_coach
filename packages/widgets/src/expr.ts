/**
 * Tiny arithmetic expression compiler for function plots. Never uses eval/Function:
 * the grammar only allows numbers, whitelisted variables, + - * / ^, parentheses and
 * a fixed set of math functions.
 */

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  floor: Math.floor,
  min: Math.min,
  max: Math.max,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Token = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    if ("+-*/^(),".includes(ch)) {
      out.push({ t: "op", v: ch });
      i++;
      continue;
    }
    throw new ExprError(`unexpected character "${ch}"`);
  }
  return out;
}

type Node = (vars: Record<string, number>) => number;

export function compileExpr(src: string, variables: string[]): Node {
  if (src.length > 200) throw new ExprError("expression too long");
  const tokens = tokenize(src);
  const allowed = new Set(variables);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => {
    const t = peek();
    return t?.t === "op" && t.v === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`expected "${v}"`);
    pos++;
  };

  function expr(): Node {
    let left = term();
    while (isOp("+") || isOp("-")) {
      const op = (tokens[pos++] as { v: string }).v;
      const l = left;
      const r = term();
      left = op === "+" ? (v) => l(v) + r(v) : (v) => l(v) - r(v);
    }
    return left;
  }
  function term(): Node {
    let left = unary();
    while (isOp("*") || isOp("/")) {
      const op = (tokens[pos++] as { v: string }).v;
      const l = left;
      const r = unary();
      left = op === "*" ? (v) => l(v) * r(v) : (v) => l(v) / r(v);
    }
    return left;
  }
  function unary(): Node {
    if (isOp("-")) {
      pos++;
      const n = unary();
      return (v) => -n(v);
    }
    if (isOp("+")) {
      pos++;
      return unary();
    }
    return power();
  }
  function power(): Node {
    const base = atom();
    if (isOp("^")) {
      pos++;
      const exp = unary();
      return (v) => Math.pow(base(v), exp(v));
    }
    return base;
  }
  function atom(): Node {
    const t = peek();
    if (!t) throw new ExprError("unexpected end of expression");
    if (t.t === "num") {
      pos++;
      const value = t.v;
      return () => value;
    }
    if (t.t === "id") {
      pos++;
      if (isOp("(")) {
        const fn = Object.hasOwn(FUNCS, t.v) ? FUNCS[t.v] : undefined;
        if (!fn) throw new ExprError(`unknown function "${t.v}"`);
        pos++;
        const args: Node[] = [expr()];
        while (isOp(",")) {
          pos++;
          args.push(expr());
        }
        expect(")");
        return (v) => fn(...args.map((a) => a(v)));
      }
      if (Object.hasOwn(CONSTS, t.v)) {
        const c = CONSTS[t.v]!;
        return () => c;
      }
      if (!allowed.has(t.v)) throw new ExprError(`unknown variable "${t.v}"`);
      const name = t.v;
      return (v) => (Object.hasOwn(v, name) ? v[name]! : NaN);
    }
    if (t.v === "(") {
      pos++;
      const inner = expr();
      expect(")");
      return inner;
    }
    throw new ExprError(`unexpected "${t.v}"`);
  }

  const root = expr();
  if (pos !== tokens.length) throw new ExprError(`unexpected "${(tokens[pos] as { v: unknown }).v}"`);
  return root;
}

/** Samples y = f(x) for plotting; non-finite values become null (gaps). */
export function sampleFunction(src: string, x: [number, number], params: Record<string, number>, n = 200): [number, number | null][] {
  const f = compileExpr(src, ["x", ...Object.keys(params)]);
  const [a, b] = x;
  const out: [number, number | null][] = [];
  for (let i = 0; i <= n; i++) {
    const xv = a + ((b - a) * i) / n;
    const y = f({ ...params, x: xv });
    out.push([Number(xv.toFixed(6)), Number.isFinite(y) ? Number(y.toFixed(6)) : null]);
  }
  return out;
}
