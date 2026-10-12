import { useState } from "react";
import type { SlideContent } from "@kj/schema";

type Value = string | number | boolean | null | undefined | Value[] | { [k: string]: Value };
type Path = (string | number)[];

const LABELS: Record<string, string> = {
  title: "标题 Title",
  subtitle: "副标题 Subtitle",
  objectives: "学习目标 Objectives",
  bullets: "要点 Bullets",
  terms: "术语 Terms",
  term: "术语 Term",
  zh: "中文 Chinese",
  visual: "图示 Visual (JSON)",
  chart: "图表 Chart (JSON)",
  sim: "实验 Simulation (JSON)",
  takeaways: "结论 Takeaways",
  source: "数据来源 Source",
  problem: "题目 Problem",
  steps: "步骤 Steps",
  text: "内容 Text",
  why: "理由 Why",
  fadeFrom: "从第几步开始留空（0 起）fadeFrom",
  predict: "预测 Predict",
  question: "问题 Question",
  options: "选项 Options",
  observe: "观察 Observe",
  explain: "解释 Explain",
  misconception: "对应误区 Misconception",
  answer: "正确选项（0 起）Answer index",
  items: "题目 Items",
  q: "问 Q",
  a: "答 A",
  nodes: "节点 Nodes",
  head: "要点 Head",
  detail: "说明 Detail",
};

const label = (k: string | number) => (typeof k === "number" ? `#${k + 1}` : (LABELS[k] ?? k));

function setIn(root: Value, path: Path, v: Value): Value {
  if (!path.length) return v;
  const [k, ...rest] = path;
  if (Array.isArray(root)) return root.map((x, i) => (i === k ? setIn(x, rest, v) : x));
  const obj = (root ?? {}) as Record<string, Value>;
  return { ...obj, [k as string]: setIn(obj[k as string], rest, v) };
}

function blankLike(v: Value): Value {
  if (typeof v === "string") return "";
  if (Array.isArray(v)) return [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blankLike(x)]));
  return v;
}

function JsonField({ value, onChange }: { value: Value; onChange: (v: Value) => void }) {
  const [raw, setRaw] = useState(() => JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <textarea
      className={`slot-json ${bad ? "invalid" : ""}`}
      rows={6}
      value={raw}
      onChange={(e) => {
        setRaw(e.target.value);
        try {
          onChange(JSON.parse(e.target.value) as Value);
          setBad(false);
        } catch {
          setBad(true);
        }
      }}
    />
  );
}

function Field({ name, value, path, onChange }: { name: string | number; value: Value; path: Path; onChange: (p: Path, v: Value) => void }) {
  const set = (v: Value) => onChange(path, v);
  if (value && typeof value === "object" && !Array.isArray(value) && "kind" in value) {
    return (
      <label className="slot-field">
        <span>{label(name)}</span>
        <JsonField value={value} onChange={set} />
      </label>
    );
  }
  if (typeof value === "string") {
    return (
      <label className="slot-field">
        <span>{label(name)}</span>
        <textarea rows={Math.min(4, Math.max(1, Math.ceil(value.length / 60)))} value={value} onChange={(e) => set(e.target.value)} data-slot-path={path.join(".")} />
      </label>
    );
  }
  if (typeof value === "number") {
    return (
      <label className="slot-field inline">
        <span>{label(name)}</span>
        <input type="number" min={0} value={value} onChange={(e) => set(Number(e.target.value))} />
      </label>
    );
  }
  if (Array.isArray(value)) {
    if (value.every((x) => typeof x === "string")) {
      return (
        <label className="slot-field">
          <span>{label(name)}（每行一条 one per line）</span>
          <textarea
            rows={Math.max(2, value.length)}
            value={(value as string[]).join("\n")}
            onChange={(e) => set(e.target.value.split("\n"))}
            onBlur={(e) => set(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
            data-slot-path={path.join(".")}
          />
        </label>
      );
    }
    return (
      <fieldset className="slot-group">
        <legend>{label(name)}</legend>
        {value.map((item, i) => (
          <div key={i} className="slot-item">
            <Field name={i} value={item} path={[...path, i]} onChange={onChange} />
            <button type="button" className="btn small ghost" onClick={() => set(value.filter((_, j) => j !== i))}>
              删除 Remove
            </button>
          </div>
        ))}
        {value.length > 0 && (
          <button type="button" className="btn small ghost" onClick={() => set([...value, blankLike(value[value.length - 1])])}>
            + 添加 Add
          </button>
        )}
      </fieldset>
    );
  }
  if (value && typeof value === "object") {
    return (
      <fieldset className="slot-group">
        <legend>{label(name)}</legend>
        {Object.entries(value).map(([k, v]) => (
          <Field key={k} name={k} value={v} path={[...path, k]} onChange={onChange} />
        ))}
      </fieldset>
    );
  }
  return null;
}

/** Form generated from the slide's slot content: the layout is fixed, so every slot is a field. */
export function SlotEditor({
  content,
  notes,
  onSave,
  onCancel,
}: {
  content: SlideContent;
  notes: string;
  onSave: (content: SlideContent, notes: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Value>(() => structuredClone(content) as unknown as Value);
  const [noteDraft, setNoteDraft] = useState(notes);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const change = (p: Path, v: Value) => setDraft((d) => setIn(d, p, v));
  return (
    <form
      className="slot-editor"
      data-testid="slot-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        setError(null);
        try {
          await onSave(draft as unknown as SlideContent, noteDraft);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setSaving(false);
        }
      }}
    >
      {Object.entries(draft as Record<string, Value>)
        .filter(([k]) => k !== "layout")
        .map(([k, v]) => (
          <Field key={k} name={k} value={v} path={[k]} onChange={change} />
        ))}
      <label className="slot-field">
        <span>讲稿 Speaker notes</span>
        <textarea rows={5} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} />
      </label>
      {error && <div className="alert error">{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={saving} data-testid="save-slide">
          保存 Save
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          取消 Cancel
        </button>
      </div>
    </form>
  );
}
