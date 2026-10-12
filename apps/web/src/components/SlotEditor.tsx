import { useContext, useDeferredValue, useMemo, useRef, useState, type ReactNode } from "react";
import { countWords, SlideContent as SlideContentSchema, type PageType, type SlideContent, type ThemeId, type Unverified, type WidgetSpec } from "@kj/schema";
import { BUDGETS, type ListBudget, type TextBudget } from "@kj/templates";
import { describeIssue, slotIssues, widgetIssues, type SlotIssue } from "@kj/templates/issues";
import { resolveEmbed } from "@kj/widgets";
import { ApiError } from "../api.ts";
import { SlidePreview } from "./SlideView.tsx";
import { FlagContext, isFlagged, UnverifiedBox } from "./Unverified.tsx";

type Obj = Record<string, any>;
type Path = (string | number)[];
type VisualKind = "formula" | "flow" | "table" | "function" | "chart" | "placeholder";

interface SubField {
  key: string;
  label: string;
  budget?: TextBudget;
  maxChars?: number;
}
type Def =
  | { type: "text"; key: string; label: string; budget: TextBudget }
  | { type: "lines"; key: string; label: string; budget: ListBudget; total?: TextBudget }
  | { type: "items"; key: string; label: string; budget: ListBudget; fields: SubField[] }
  | { type: "group"; key: string; label: string; defs: Def[] }
  | { type: "visual"; key: "visual" | "chart"; label: string; kinds: VisualKind[]; narrow: boolean }
  | { type: "sim"; key: "sim" }
  | { type: "answer"; key: "answer" }
  | { type: "fadeFrom"; key: "fadeFrom" };

const B = BUDGETS;
const title = (b: TextBudget): Def => ({ type: "text", key: "title", label: "标题 Title", budget: b });

/** The form of each layout, from its slot budgets: empty lists still know what an item looks like. */
const FORM: Record<SlideContent["layout"], Def[]> = {
  title: [title(B.title.title), { type: "text", key: "subtitle", label: "副标题 Subtitle", budget: B.title.subtitle }, { type: "lines", key: "objectives", label: "学习目标 Objectives", budget: B.title.objectives }],
  statement: [
    title(B.statement.title),
    { type: "lines", key: "bullets", label: "要点 Bullets", budget: B.statement.bullets, total: B.statement.bodyTotal },
    { type: "visual", key: "visual", label: "图示 Visual", kinds: ["formula", "flow", "table", "function", "chart", "placeholder"], narrow: true },
    { type: "items", key: "terms", label: "术语 Terms", budget: B.statement.terms, fields: [{ key: "term", label: "术语 Term", budget: B.statement.terms.item }, { key: "zh", label: "中文 Chinese", maxChars: 12 }] },
  ],
  chart: [
    title(B.chart.title),
    { type: "visual", key: "chart", label: "图表 Chart", kinds: ["chart", "table", "function", "placeholder"], narrow: false },
    { type: "lines", key: "takeaways", label: "结论 Takeaways", budget: B.chart.takeaways },
    { type: "text", key: "source", label: "数据来源 Source", budget: B.chart.source },
  ],
  steps: [
    title(B.steps.title),
    { type: "text", key: "problem", label: "题目 Problem", budget: B.steps.problem },
    { type: "items", key: "steps", label: "步骤 Steps", budget: B.steps.steps, fields: [{ key: "text", label: "这一步 Step", budget: B.steps.steps.item }, { key: "why", label: "理由 Why", budget: B.steps.why }] },
    { type: "fadeFrom", key: "fadeFrom" },
  ],
  experiment: [
    title(B.experiment.title),
    { type: "group", key: "predict", label: "预测 Predict", defs: [{ type: "text", key: "question", label: "预测问题 Question", budget: B.experiment.question }, { type: "lines", key: "options", label: "选项 Options", budget: B.experiment.options }] },
    { type: "sim", key: "sim" },
    { type: "lines", key: "observe", label: "观察提示 Observe", budget: B.experiment.observe },
    { type: "text", key: "explain", label: "解释 Explain", budget: B.experiment.explain },
  ],
  quiz: [
    { type: "text", key: "question", label: "问题 Question", budget: B.quiz.question },
    { type: "items", key: "options", label: "选项 Options", budget: B.quiz.options, fields: [{ key: "text", label: "选项 Option", budget: B.quiz.options.item }, { key: "misconception", label: "对应误区 Misconception", budget: B.quiz.misconception }] },
    { type: "answer", key: "answer" },
    { type: "text", key: "explain", label: "解释 Explain", budget: B.quiz.explain },
  ],
  questions: [
    title(B.questions.title),
    { type: "items", key: "items", label: "题目 Items", budget: B.questions.items, fields: [{ key: "q", label: "问 Question", budget: B.questions.items.item }, { key: "a", label: "答 Answer", budget: B.questions.answer }] },
  ],
  summary: [
    title(B.summary.title),
    { type: "items", key: "nodes", label: "节点 Nodes", budget: B.summary.nodes, fields: [{ key: "head", label: "要点 Head", budget: B.summary.nodes.item }, { key: "detail", label: "说明 Detail", budget: B.summary.detail }] },
  ],
};

const VISUAL_LABEL: Record<VisualKind, string> = {
  formula: "公式 Formula",
  flow: "流程图 Flow",
  table: "表格 Table",
  function: "函数图像 Function plot",
  chart: "数据图表 Chart (JSON)",
  placeholder: "图示待补 Visual to add",
};

function visualTemplate(kind: VisualKind): WidgetSpec {
  switch (kind) {
    case "formula":
      return { kind, tex: "", caption: "" };
    case "flow":
      return { kind, steps: ["", ""] };
    case "table":
      return { kind, columns: ["", ""], rows: [["", ""]], caption: "" };
    case "function":
      return { kind, expr: "x", x: [0, 10], xLabel: "x", yLabel: "y", params: [] };
    case "chart":
      return { kind, type: "bar", xLabel: "", yLabel: "", categories: ["A", "B"], series: [{ name: "", data: [1, 2] }] };
    case "placeholder":
      return { kind, hint: "" };
  }
}

function setIn(root: unknown, path: Path, v: unknown): any {
  if (!path.length) return v;
  const [k, ...rest] = path;
  if (Array.isArray(root)) return root.map((x, i) => (i === k ? setIn(x, rest, v) : x));
  const obj = (root ?? {}) as Obj;
  if (v === undefined && !rest.length) {
    const { [k as string]: _drop, ...others } = obj;
    return others;
  }
  return { ...obj, [k as string]: setIn(obj[k as string], rest, v) };
}

const startsWith = (p: PropertyKey[], prefix: Path) => prefix.every((k, i) => p[i] === k);
const zhOf = (words: number) => Math.round(words * 1.7);

function FieldIssues({ issues, path, exact = false }: { issues: SlotIssue[]; path: Path; exact?: boolean }) {
  const mine = issues.filter((i) => (exact ? i.path.length === path.length : true) && startsWith(i.path, path));
  if (!mine.length) return null;
  return (
    <ul className="slot-issues" role="alert">
      {mine.map((i, k) => (
        <li key={k}>{describeIssue(i)}</li>
      ))}
    </ul>
  );
}

/** "已用 9 / 8 词（≈ 14 字）": red when over the hard limit, amber over the target. */
function Count({ text, budget, prefix = "" }: { text: string; budget: TextBudget; prefix?: string }) {
  const n = countWords(text);
  const cls = n > budget.max ? "over" : n > budget.soft ? "soft" : "";
  return (
    <span className={`count ${cls}`}>
      {prefix}已用 {n} / {budget.max} 词（≈ {zhOf(budget.max)} 字）
    </span>
  );
}

function TextField({ label, value, budget, maxChars, path, issues, onChange }: { label: string; value: string; budget?: TextBudget; maxChars?: number; path: Path; issues: SlotIssue[]; onChange: (p: Path, v: unknown) => void }) {
  const flags = useContext(FlagContext);
  const over = (budget && countWords(value) > budget.max) || (maxChars !== undefined && value.length > maxChars);
  return (
    <label className={`slot-field ${isFlagged(flags, value) ? "flagged" : ""} ${over ? "invalid" : ""}`}>
      <span>{label}</span>
      <textarea rows={Math.min(4, Math.max(1, Math.ceil(value.length / 50)))} value={value} onChange={(e) => onChange(path, e.target.value)} data-slot-path={path.join(".")} />
      {budget ? <Count text={value} budget={budget} /> : maxChars !== undefined ? <span className={`count ${value.length > maxChars ? "over" : ""}`}>{value.length} / {maxChars} 字</span> : null}
      <FieldIssues issues={issues} path={path} />
    </label>
  );
}

function LinesField({ def, value, path, issues, onChange }: { def: Extract<Def, { type: "lines" }>; value: string[]; path: Path; issues: SlotIssue[]; onChange: (p: Path, v: unknown) => void }) {
  const flags = useContext(FlagContext);
  const lines = value.filter((s) => s.trim());
  const tooMany = lines.length > def.budget.max;
  return (
    <label className={`slot-field ${isFlagged(flags, value.join("\n")) ? "flagged" : ""} ${tooMany ? "invalid" : ""}`}>
      <span>
        {def.label}（每行一条 one per line · {def.budget.min}–{def.budget.max} 条）
      </span>
      <textarea
        rows={Math.max(2, value.length)}
        value={value.join("\n")}
        onChange={(e) => onChange(path, e.target.value.split("\n"))}
        onBlur={(e) => onChange(path, e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
        data-slot-path={path.join(".")}
      />
      <span className="counts">
        {lines.map((s, i) => (
          <Count key={i} text={s} budget={def.budget.item} prefix={`第 ${i + 1} 条 `} />
        ))}
        {def.total && lines.length > 1 && <Count text={lines.join(" ")} budget={def.total} prefix="合计 " />}
        <span className={`count ${tooMany ? "over" : ""}`}>
          {lines.length} / {def.budget.max} 条
        </span>
      </span>
      <FieldIssues issues={issues} path={path} />
    </label>
  );
}

function ItemsField({ def, value, path, issues, onChange }: { def: Extract<Def, { type: "items" }>; value: Obj[]; path: Path; issues: SlotIssue[]; onChange: (p: Path, v: unknown) => void }) {
  const blank = Object.fromEntries(def.fields.map((f) => [f.key, ""]));
  return (
    <fieldset className="slot-group" data-slot-path={path.join(".")}>
      <legend>
        {def.label} · {value.length} / {def.budget.max}
      </legend>
      {value.length === 0 && <p className="muted small">还没有内容 · none yet</p>}
      {value.map((item, i) => (
        <div key={i} className="slot-item">
          <span className="slot-item-no">#{i + 1}</span>
          {def.fields.map((f) => (
            <TextField key={f.key} label={f.label} value={String(item[f.key] ?? "")} budget={f.budget} maxChars={f.maxChars} path={[...path, i, f.key]} issues={issues} onChange={onChange} />
          ))}
          <button type="button" className="btn small ghost" onClick={() => onChange(path, value.filter((_, j) => j !== i))}>
            删除 Remove
          </button>
        </div>
      ))}
      {value.length < def.budget.max && (
        <button type="button" className="btn small ghost" onClick={() => onChange(path, [...value, blank])} data-testid={`add-${path.join(".")}`}>
          + 添加 Add
        </button>
      )}
      <FieldIssues issues={issues} path={path} exact />
    </fieldset>
  );
}

function JsonField({ value, path, onChange }: { value: unknown; path: Path; onChange: (p: Path, v: unknown) => void }) {
  const [raw, setRaw] = useState(() => JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <>
      <textarea
        className={`slot-json ${bad ? "invalid" : ""}`}
        rows={6}
        value={raw}
        data-slot-path={path.join(".")}
        onChange={(e) => {
          setRaw(e.target.value);
          try {
            onChange(path, JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad && <span className="count over">JSON 格式不完整 · incomplete JSON</span>}
    </>
  );
}

const splitCells = (s: string) => s.split("|").map((c) => c.trim());

function VisualBody({ value, narrow, path, issues, onChange }: { value: Obj; narrow: boolean; path: Path; issues: SlotIssue[]; onChange: (p: Path, v: unknown) => void }) {
  const at = (k: string) => [...path, k];
  switch (value.kind as VisualKind) {
    case "formula":
      return (
        <>
          <label className="slot-field">
            <span>公式（LaTeX，例如 v = f\lambda）Formula</span>
            <input className="mono" value={String(value.tex ?? "")} onChange={(e) => onChange(at("tex"), e.target.value)} data-slot-path={at("tex").join(".")} />
          </label>
          <TextField label="说明文字 Caption" value={String(value.caption ?? "")} maxChars={80} path={at("caption")} issues={issues} onChange={onChange} />
        </>
      );
    case "flow": {
      const steps = (value.steps as string[]) ?? [];
      return (
        <label className="slot-field">
          <span>
            流程图：每行一步（{B.flow.min}–{B.flow.max} 步）Flow, one step per line
          </span>
          <textarea
            rows={Math.max(3, steps.length)}
            value={steps.join("\n")}
            onChange={(e) => onChange(at("steps"), e.target.value.split("\n"))}
            onBlur={(e) => onChange(at("steps"), e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
            data-slot-path={at("steps").join(".")}
          />
          <span className="counts">
            {steps
              .filter((s) => s.trim())
              .map((s, i) => (
                <Count key={i} text={s} budget={B.flow.item} prefix={`第 ${i + 1} 步 `} />
              ))}
            <span className={`count ${steps.filter((s) => s.trim()).length > B.flow.max ? "over" : ""}`}>
              {steps.filter((s) => s.trim()).length} / {B.flow.max} 步
            </span>
          </span>
          <FieldIssues issues={issues} path={at("steps")} />
        </label>
      );
    }
    case "table": {
      const b = narrow ? B.tableNarrow : B.table;
      const columns = (value.columns as string[]) ?? [];
      const rows = (value.rows as string[][]) ?? [];
      return (
        <>
          <label className="slot-field">
            <span>
              表头：用 | 分隔（{b.columns.min === b.columns.max ? `${b.columns.max} 列` : `${b.columns.min}–${b.columns.max} 列`}）Columns
            </span>
            <input value={columns.join(" | ")} onChange={(e) => onChange(at("columns"), splitCells(e.target.value))} data-slot-path={at("columns").join(".")} />
          </label>
          <label className="slot-field">
            <span>表格行：每行一行，格子之间用 |（最多 {b.rows.max} 行，每格 1–2 个词）Rows</span>
            <textarea
              rows={Math.max(2, rows.length)}
              value={rows.map((r) => r.join(" | ")).join("\n")}
              onChange={(e) => onChange(at("rows"), e.target.value.split("\n").map(splitCells))}
              onBlur={(e) => onChange(at("rows"), e.target.value.split("\n").filter((l) => l.trim()).map(splitCells))}
              data-slot-path={at("rows").join(".")}
            />
            <span className={`count ${rows.length > b.rows.max ? "over" : ""}`}>
              {rows.length} / {b.rows.max} 行 · {columns.length} 列
            </span>
          </label>
          <TextField label="说明文字 Caption" value={String(value.caption ?? "")} budget={b.caption} path={at("caption")} issues={issues} onChange={onChange} />
        </>
      );
    }
    case "function": {
      const x = (value.x as [number, number]) ?? [0, 10];
      return (
        <>
          <label className="slot-field">
            <span>表达式（用 x 和参数名，例如 A*sin(2*pi*x/L)）Expression</span>
            <input className="mono" value={String(value.expr ?? "")} onChange={(e) => onChange(at("expr"), e.target.value)} data-slot-path={at("expr").join(".")} />
          </label>
          <div className="row">
            <label className="slot-field inline">
              <span>x 从 from</span>
              <input type="number" value={x[0]} onChange={(e) => onChange(at("x"), [Number(e.target.value), x[1]])} />
            </label>
            <label className="slot-field inline">
              <span>到 to</span>
              <input type="number" value={x[1]} onChange={(e) => onChange(at("x"), [x[0], Number(e.target.value)])} />
            </label>
          </div>
          <div className="row">
            <label className="slot-field">
              <span>横轴名称 x label</span>
              <input value={String(value.xLabel ?? "")} onChange={(e) => onChange(at("xLabel"), e.target.value)} />
            </label>
            <label className="slot-field">
              <span>纵轴名称 y label</span>
              <input value={String(value.yLabel ?? "")} onChange={(e) => onChange(at("yLabel"), e.target.value)} />
            </label>
          </div>
          <details className="slot-advanced">
            <summary>滑块参数（高级，JSON）Sliders</summary>
            <JsonField value={value.params ?? []} path={at("params")} onChange={onChange} />
          </details>
        </>
      );
    }
    case "placeholder":
      return <TextField label="需要补什么图（老师上课前自己加）Hint" value={String(value.hint ?? "")} budget={B.placeholder.hint} path={at("hint")} issues={issues} onChange={onChange} />;
    default:
      return <JsonField value={value} path={path} onChange={onChange} />;
  }
}

function VisualField({ def, value, path, issues, onChange }: { def: Extract<Def, { type: "visual" }>; value: Obj; path: Path; issues: SlotIssue[]; onChange: (p: Path, v: unknown) => void }) {
  const flags = useContext(FlagContext);
  const cache = useRef<Record<string, Obj>>({ [String(value.kind)]: value });
  const kind = String(value.kind) as VisualKind;
  return (
    <fieldset className={`slot-group ${isFlagged(flags, JSON.stringify(value)) ? "flagged" : ""}`} data-slot-path={path.join(".")}>
      <legend>{def.label}</legend>
      <label className="slot-field inline">
        <span>类型 Kind</span>
        <select
          value={kind}
          data-testid="visual-kind"
          onChange={(e) => {
            cache.current[kind] = value;
            const next = e.target.value as VisualKind;
            onChange(path, cache.current[next] ?? visualTemplate(next));
          }}
        >
          {(def.kinds.includes(kind) ? def.kinds : [kind, ...def.kinds]).map((k) => (
            <option key={k} value={k}>
              {VISUAL_LABEL[k] ?? k}
            </option>
          ))}
        </select>
      </label>
      <VisualBody key={kind} value={value} narrow={def.narrow} path={path} issues={issues} onChange={onChange} />
      <FieldIssues issues={issues} path={path} exact />
    </fieldset>
  );
}

const LETTERS = "ABCDEFGH";

function render(def: Def, draft: Obj, base: Path, issues: SlotIssue[], onChange: (p: Path, v: unknown) => void): ReactNode {
  const path = [...base, def.key];
  const value = path.reduce<any>((o, k) => o?.[k], draft);
  switch (def.type) {
    case "text":
      return <TextField key={def.key} label={def.label} value={String(value ?? "")} budget={def.budget} path={path} issues={issues} onChange={onChange} />;
    case "lines":
      return <LinesField key={def.key} def={def} value={(value as string[]) ?? []} path={path} issues={issues} onChange={onChange} />;
    case "items":
      return <ItemsField key={def.key} def={def} value={(value as Obj[]) ?? []} path={path} issues={issues} onChange={onChange} />;
    case "group":
      return (
        <fieldset key={def.key} className="slot-group">
          <legend>{def.label}</legend>
          {def.defs.map((d) => render(d, draft, path, issues, onChange))}
        </fieldset>
      );
    case "visual":
      return <VisualField key={def.key} def={def} value={(value as Obj) ?? visualTemplate("placeholder")} path={path} issues={issues} onChange={onChange} />;
    case "sim": {
      const sim = value as Obj | undefined;
      if (sim?.kind === "function") return <VisualField key="sim" def={{ type: "visual", key: "chart", label: "实验图像 Plot", kinds: ["function"], narrow: false }} value={sim} path={path} issues={issues} onChange={onChange} />;
      const entry = sim?.kind === "sim" ? resolveEmbed(String(sim.embedId)) : undefined;
      return (
        <div key="sim" className="slot-field">
          <span>实验模拟 Simulation</span>
          <p className="small">{entry ? `${entry.title.zh} · ${entry.title.en}` : String(sim?.embedId ?? "—")}（按教材内容从模拟库自动匹配，这里不能改）</p>
        </div>
      );
    }
    case "answer": {
      const options = (draft.options as Obj[]) ?? [];
      return (
        <fieldset key="answer" className="slot-group" data-slot-path="answer">
          <legend>正确选项 Correct answer</legend>
          <div className="answer-choices">
            {options.map((o, i) => (
              <label key={i} className={`answer-choice ${value === i ? "on" : ""}`}>
                <input type="radio" name="slot-answer" checked={value === i} onChange={() => onChange(path, i)} data-testid={`answer-${LETTERS[i]}`} />
                <b>{LETTERS[i]}</b> {String(o.text ?? "") || "（空选项）"}
              </label>
            ))}
          </div>
          <FieldIssues issues={issues} path={path} />
        </fieldset>
      );
    }
    case "fadeFrom": {
      const steps = (draft.steps as Obj[]) ?? [];
      return (
        <label key="fadeFrom" className="slot-field inline">
          <span>学生完成的步骤 Steps left blank</span>
          <select value={value === undefined ? "" : String(value)} onChange={(e) => onChange(path, e.target.value === "" ? undefined : Number(e.target.value))} data-testid="fade-from">
            <option value="">不留空（完整示范）none</option>
            {steps.slice(1).map((_, i) => (
              <option key={i + 1} value={i + 1}>
                从第 {i + 2} 步起留空 · from step {i + 2}
              </option>
            ))}
          </select>
          <FieldIssues issues={issues} path={path} />
        </label>
      );
    }
  }
}

function errorLines(err: unknown): string[] {
  if (err instanceof ApiError && Array.isArray(err.detail) && err.detail.length) {
    return (err.detail as SlotIssue[]).filter((i) => i && Array.isArray(i.path)).map(describeIssue);
  }
  return [(err as Error).message];
}

/** Form for a slide's slots, derived from its layout: live word counts, Chinese messages, live preview. */
export function SlotEditor({
  content,
  notes,
  unverified = [],
  pageType,
  theme,
  onSave,
  onCancel,
}: {
  content: SlideContent;
  notes: string;
  unverified?: Unverified[];
  pageType: PageType;
  theme: ThemeId;
  onSave: (content: SlideContent, notes: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Obj>(() => structuredClone(content) as Obj);
  const [noteDraft, setNoteDraft] = useState(notes);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const change = (p: Path, v: unknown) => setDraft((d) => setIn(d, p, v));
  const issues = useMemo(() => [...slotIssues(draft as SlideContent), ...widgetIssues(draft as SlideContent)], [draft]);
  const deferred = useDeferredValue(draft);
  const previewSlide = useMemo(() => {
    const parsed = SlideContentSchema.safeParse(deferred);
    return parsed.success ? { content: parsed.data, sources: [], pageType } : null;
  }, [deferred, pageType]);
  return (
    <form
      className="slot-editor"
      data-testid="slot-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        if (issues.length) {
          setErrors(issues.map(describeIssue));
          return;
        }
        setSaving(true);
        setErrors([]);
        try {
          await onSave(draft as SlideContent, noteDraft);
        } catch (err) {
          setErrors(errorLines(err));
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="slot-preview">
        {previewSlide ? <SlidePreview slide={previewSlide} theme={theme} /> : <div className="slide-preview kj-thumb empty">预览暂不可用 · preview unavailable</div>}
        <span className="muted small">实时预览 Live preview</span>
      </div>
      <UnverifiedBox items={unverified} />
      <FlagContext.Provider value={unverified.map((u) => u.text)}>{FORM[content.layout].map((d) => render(d, draft, [], issues, change))}</FlagContext.Provider>
      <label className="slot-field">
        <span>讲稿 Speaker notes</span>
        <textarea rows={5} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} />
      </label>
      {errors.length > 0 && (
        <div className="alert error" data-testid="slot-errors">
          <b>还有 {errors.length} 处要改 · fix before saving</b>
          <ul>
            {errors.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="row">
        <button className="btn primary" disabled={saving} data-testid="save-slide">
          保存 Save
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          取消 Cancel
        </button>
        {issues.length > 0 && <span className="count over">{issues.length} 处超出或缺少 · issues</span>}
      </div>
    </form>
  );
}
