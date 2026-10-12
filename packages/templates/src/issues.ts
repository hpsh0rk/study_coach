import type { SlideContent, WidgetSpec } from "@kj/schema";
import { validateWidget } from "@kj/widgets";
import { SLOT_SCHEMAS } from "./index.ts";

export interface SlotIssue {
  path: PropertyKey[];
  message: string;
}

const getIn = (o: unknown, path: PropertyKey[]): unknown => path.reduce<unknown>((x, k) => (x as Record<PropertyKey, unknown> | undefined)?.[k], o);
function setIn<T>(o: T, path: PropertyKey[], v: unknown): T {
  const copy = structuredClone(o) as Record<PropertyKey, unknown>;
  let x = copy;
  for (const k of path.slice(0, -1)) x = x[k] as Record<PropertyKey, unknown>;
  x[path[path.length - 1]!] = v;
  return copy as T;
}

/**
 * A list over its item limit hides its items' own errors (zod stops at the length check), so a retry or a
 * teacher would only hear "too many items". Re-checks the items in windows of the allowed size.
 */
function maskedItemIssues(c: SlideContent, issues: SlotIssue[]): SlotIssue[] {
  const out: SlotIssue[] = [];
  for (const i of issues) {
    const max = /expected array to have <=\s*(\d+)/.exec(i.message)?.[1];
    const arr = getIn(c, i.path);
    if (!max || !Array.isArray(arr)) continue;
    const n = Number(max);
    if (n < 1) continue;
    for (let k = 0; k < arr.length; k += n) {
      const start = Math.max(0, Math.min(k, arr.length - n));
      const r = SLOT_SCHEMAS[c.layout].safeParse(setIn(c, i.path, arr.slice(start, start + n)));
      if (r.success) continue;
      for (const j of r.error.issues) {
        const inside = j.path.length > i.path.length && i.path.every((p, d) => j.path[d] === p) && typeof j.path[i.path.length] === "number";
        if (!inside) continue;
        const path = [...j.path];
        path[i.path.length] = (path[i.path.length] as number) + start;
        out.push({ path, message: j.message });
      }
    }
  }
  return out;
}

/** Slot-schema issues of content for its layout, including the item issues a too-long list hides (deduplicated). */
export function slotIssues(c: SlideContent): SlotIssue[] {
  const schema = SLOT_SCHEMAS[(c as { layout?: unknown }).layout as SlideContent["layout"]];
  if (!schema) return [{ path: ["layout"], message: "unknown layout" }];
  const strict = schema.safeParse(c);
  if (strict.success) return [];
  const all = [...strict.error.issues.map((i) => ({ path: i.path, message: i.message })), ...maskedItemIssues(c, strict.error.issues)];
  return [...new Map(all.map((i) => [`${i.path.join(".")}: ${i.message}`, i])).values()];
}

/** The visual slot of a layout, if it has one. */
export function visualSlotOf(layout: SlideContent["layout"]): "visual" | "chart" | "sim" | undefined {
  return layout === "statement" ? "visual" : layout === "chart" ? "chart" : layout === "experiment" ? "sim" : undefined;
}

/** Widget errors (e.g. an expression that does not compile) as slot issues on the visual slot. */
export function widgetIssues(c: SlideContent): SlotIssue[] {
  const slot = visualSlotOf(c.layout);
  const w = slot ? ((c as Record<string, unknown>)[slot] as WidgetSpec | undefined) : undefined;
  if (!slot || !w || typeof w !== "object" || !("kind" in w)) return [];
  try {
    return validateWidget(w)
      .filter((i) => i.level === "error")
      .map((i) => ({ path: [slot], message: i.message }));
  } catch (e) {
    return [{ path: [slot], message: (e as Error).message }];
  }
}

const SLOT_LABELS: Record<string, string> = {
  title: "标题",
  subtitle: "副标题",
  objectives: "学习目标",
  bullets: "要点",
  terms: "术语",
  term: "术语",
  zh: "中文",
  visual: "图示",
  chart: "图表",
  sim: "实验模拟",
  takeaways: "结论",
  source: "数据来源",
  problem: "题目",
  steps: "步骤",
  text: "内容",
  why: "理由",
  fadeFrom: "留空的步骤",
  predict: "预测",
  question: "问题",
  options: "选项",
  observe: "观察",
  explain: "解释",
  misconception: "对应误区",
  answer: "正确选项",
  items: "题目",
  q: "问",
  a: "答",
  nodes: "节点",
  head: "要点",
  detail: "说明",
  columns: "表头",
  rows: "表格行",
  caption: "说明文字",
  tex: "公式",
  expr: "表达式",
  hint: "需要补的图",
  layout: "版式",
};

/** "要点 第 2 条" for ["bullets", 1]; "选项 第 1 条 · 对应误区" for ["options", 0, "misconception"]. */
export function slotLabel(path: PropertyKey[]): string {
  const parts: string[] = [];
  for (const k of path) {
    if (typeof k === "number") parts[parts.length - 1] = `${parts[parts.length - 1] ?? ""} 第 ${k + 1} 条`.trim();
    else parts.push(SLOT_LABELS[String(k)] ?? String(k));
  }
  return parts.join(" · ") || "内容";
}

const zhChars = (words: number) => Math.round(words * 1.7);

/** Chinese wording of a slot or widget issue (budget messages come from SLOT_SCHEMAS, widget ones from validateWidget). */
export function issueText(message: string): string {
  let m: RegExpExecArray | null;
  if ((m = /at most (\d+) words in total/.exec(message))) return `合计太长：最多 ${m[1]} 个英文词（约 ${zhChars(Number(m[1]))} 个汉字）`;
  if ((m = /at most (\d+) words/.exec(message))) return `太长：最多 ${m[1]} 个英文词（约 ${zhChars(Number(m[1]))} 个汉字）`;
  if ((m = /expected array to have <=\s*(\d+)/.exec(message))) return `太多：最多 ${m[1]} 条`;
  if ((m = /expected array to have >=\s*(\d+)/.exec(message))) return `太少：至少 ${m[1]} 条`;
  if (/expected string to have >=\s*1 /.test(message)) return "不能为空";
  if ((m = /expected string to have <=\s*(\d+)/.exec(message))) return `太长：最多 ${m[1]} 个字符`;
  if (/one cell per column/.test(message)) return "每一行的格数要和表头的列数一样";
  if (/answer must index an option/.test(message)) return "请选出正确选项";
  if ((m = /invalid expression: (.*)$/.exec(message))) return `表达式算不出来（${m[1]}）：只能用 x、参数名、数字、+ - * / ^、括号、pi、e 和 sin cos tan sqrt abs exp ln log min max`;
  if (/x range must be increasing/.test(message)) return "横轴范围要从小到大";
  if (/y range must be increasing/.test(message)) return "纵轴范围要从小到大";
  if ((m = /param (\S+): max must exceed min/.exec(message))) return `滑块 ${m[1]}：最大值要大于最小值`;
  if ((m = /param (\S+): value out of range/.exec(message))) return `滑块 ${m[1]}：初始值不在范围内`;
  if (/forbidden TeX command/.test(message)) return "公式里有不允许的命令";
  if ((m = /series (.+?): (\d+) values for (\d+) categories/.exec(message))) return `数据系列 ${m[1]}：有 ${m[2]} 个数值，但有 ${m[3]} 个类别`;
  if (/expected object, received string/.test(message)) return "格式不对：这里需要分成几个小项填写";
  if (/Invalid input|expected/i.test(message)) return `格式不对（${message}）`;
  return message;
}

/** One line per issue for a teacher: "要点 第 2 条：太长：最多 8 个英文词（约 14 个汉字）". */
export function describeIssue(i: SlotIssue): string {
  return `${slotLabel(i.path)}：${issueText(i.message)}`;
}
