import { createContext, useContext, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { countWords, decodeSourcePage, SlideContent as SlideContentSchema, SOURCE_STRIDE, type ChartSpec, type PageType, type SlideContent, type ThemeId, type Unverified, type WidgetSpec } from "@kj/schema";
import { BUDGETS, type ListBudget, type TextBudget } from "@kj/templates";
import { describeIssue, slotIssues, widgetIssues, type SlotIssue } from "@kj/templates/issues";
import { resolveEmbed } from "@kj/widgets";
import { activeLessonPdfSources, ApiError } from "../api.ts";
import { mediaApi, type MediaAssetDto } from "../textbook/api.ts";
import { imageBlobToBoundedDataUrl, PageCropper } from "../textbook/PageCropper.tsx";
import { formatChartCategories, formatChartSeries, parseChartCategories, parseChartSeries } from "./chartForm.ts";
import { SlidePreview } from "./SlideView.tsx";
import { activeUnverified, FlagContext, isFlagged, UnverifiedBox } from "./Unverified.tsx";

type Obj = Record<string, any>;
type Path = (string | number)[];
type VisualKind = "formula" | "flow" | "table" | "function" | "chart" | "figure" | "placeholder";

interface FigureEditorEnv {
  lessonId?: string;
  documentId?: string;
  citedPages: number[];
  assets: MediaAssetDto[];
  addAsset: (asset: MediaAssetDto) => void;
}

const FigureEditorContext = createContext<FigureEditorEnv>({
  citedPages: [],
  assets: [],
  addAsset: () => undefined,
});

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
  | { type: "fadeFrom"; key: "fadeFrom" }
  | { type: "toggle"; key: string; label: string; hint: string }
  | { type: "select"; key: string; label: string; choices: { value: string; label: string }[] }
  /** Optional pick of one entry of the string list at `from` (e.g. the prediction the simulation bears out). */
  | { type: "pick"; key: string; label: string; from: Path };

const B = BUDGETS;
const title = (b: TextBudget): Def => ({ type: "text", key: "title", label: "标题 Title", budget: b });

/** The form of each layout, from its slot budgets: empty lists still know what an item looks like. */
const FORM: Record<SlideContent["layout"], Def[]> = {
  title: [title(B.title.title), { type: "text", key: "subtitle", label: "副标题 Subtitle", budget: B.title.subtitle }, { type: "lines", key: "objectives", label: "学习目标 Objectives", budget: B.title.objectives }],
  statement: [
    title(B.statement.title),
    { type: "lines", key: "bullets", label: "要点 Bullets", budget: B.statement.bullets, total: B.statement.bodyTotal },
    { type: "visual", key: "visual", label: "图示 Visual", kinds: ["formula", "flow", "table", "function", "chart", "figure", "placeholder"], narrow: true },
    { type: "items", key: "terms", label: "术语 Terms", budget: B.statement.terms, fields: [{ key: "term", label: "术语 Term", budget: B.statement.terms.item }, { key: "zh", label: "中文 Chinese", maxChars: 12 }] },
  ],
  chart: [
    title(B.chart.title),
    { type: "visual", key: "chart", label: "图表 Chart", kinds: ["chart", "table", "function", "figure", "placeholder"], narrow: false },
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
    { type: "pick", key: "outcome", label: "实验结果对应的预测 Prediction the simulation confirms", from: ["predict", "options"] },
  ],
  quiz: [
    { type: "text", key: "question", label: "问题 Question", budget: B.quiz.question },
    { type: "items", key: "options", label: "选项 Options", budget: B.quiz.options, fields: [{ key: "text", label: "选项 Option", budget: B.quiz.options.item }, { key: "misconception", label: "对应误区 Misconception", budget: B.quiz.misconception }] },
    { type: "answer", key: "answer" },
    { type: "toggle", key: "poll", label: "课堂投票（铰链题）Hinge question: vote first", hint: "放映时先举手投票，老师输入各选项人数，翻页先显示分布，再显示答案。" },
    { type: "text", key: "explain", label: "解释 Explain", budget: B.quiz.explain },
  ],
  questions: [
    title(B.questions.title),
    { type: "items", key: "items", label: "题目 Items", budget: B.questions.items, fields: [{ key: "q", label: "问 Question", budget: B.questions.items.item }, { key: "a", label: "答 Answer", budget: B.questions.answer }] },
  ],
  order: [
    title(B.order.title),
    {
      type: "select",
      key: "mode",
      label: "活动 Activity",
      choices: [
        { value: "order", label: "排序：按正确顺序填写，放映时打乱 · Order" },
        { value: "match", label: "配对：每张卡片写上对应的另一半 · Match" },
      ],
    },
    { type: "items", key: "items", label: "卡片（按正确答案填写）Cards, in the right order", budget: B.order.items, fields: [{ key: "text", label: "卡片 Card", budget: B.order.items.item }, { key: "match", label: "配对的另一半（仅配对）Match", budget: B.order.match }] },
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
  chart: "数据图表 Chart",
  figure: "原书插图 / 截图 Figure",
  placeholder: "图示待补 Visual to add",
};

function visualTemplate(kind: VisualKind, defaultFigure?: MediaAssetDto): WidgetSpec {
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
    case "figure": {
      const cap = defaultFigure ? [defaultFigure.label, defaultFigure.caption].filter(Boolean).join(": ").slice(0, 120) : "";
      return { kind, assetId: defaultFigure?.id ?? "", ...(cap ? { caption: cap } : {}) };
    }
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
  const serialized = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [raw, setRaw] = useState(serialized);
  const [bad, setBad] = useState(false);
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) {
      setRaw(serialized);
      setBad(false);
    }
  }, [serialized]);
  return (
    <>
      <textarea
        className={`slot-json ${bad ? "invalid" : ""}`}
        rows={6}
        value={raw}
        data-slot-path={path.join(".")}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={() => {
          focusedRef.current = false;
        }}
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

function ChartFields({ value, path, issues, onChange }: { value: Obj; path: Path; issues: SlotIssue[]; onChange: (p: Path, v: unknown) => void }) {
  const at = (k: string) => [...path, k];
  const chartType = (value.type as ChartSpec["type"]) ?? "bar";
  const seriesVal = ((value.series as ChartSpec["series"] | undefined) ?? [{ name: "", data: [1, 2] }]);
  const extCats = useMemo(() => formatChartCategories(value.categories as string[] | undefined), [value.categories]);
  const extSeries = useMemo(() => formatChartSeries(seriesVal), [seriesVal]);
  const [catsText, setCatsText] = useState(extCats);
  const [seriesText, setSeriesText] = useState(extSeries);
  const catsFocused = useRef(false);
  const seriesFocused = useRef(false);

  useEffect(() => {
    if (!catsFocused.current) setCatsText(extCats);
  }, [extCats]);
  useEffect(() => {
    if (!seriesFocused.current) setSeriesText(extSeries);
  }, [extSeries]);

  return (
    <>
      <label className="slot-field inline">
        <span>图表类型 Chart type</span>
        <select
          value={chartType}
          data-testid="chart-type"
          onChange={(e) => {
            const nextType = e.target.value as ChartSpec["type"];
            onChange(at("type"), nextType);
          }}
        >
          <option value="bar">柱状图 Bar</option>
          <option value="line">折线图 Line</option>
          <option value="scatter">散点图 Scatter</option>
        </select>
      </label>
      <div className="row">
        <label className="slot-field">
          <span>横轴名称 x label</span>
          <input value={String(value.xLabel ?? "")} onChange={(e) => onChange(at("xLabel"), e.target.value)} data-slot-path={at("xLabel").join(".")} />
        </label>
        <label className="slot-field">
          <span>纵轴名称 y label</span>
          <input value={String(value.yLabel ?? "")} onChange={(e) => onChange(at("yLabel"), e.target.value)} data-slot-path={at("yLabel").join(".")} />
        </label>
      </div>
      {chartType !== "scatter" && (
        <label className="slot-field">
          <span>横轴分类：用 | 分隔（建议 ≤ 7 项，散点/数值折线可留空）Categories</span>
          <input
            value={catsText}
            placeholder="例如：空气 | 水 | 钢铁"
            data-testid="chart-categories"
            onFocus={() => {
              catsFocused.current = true;
            }}
            onBlur={() => {
              catsFocused.current = false;
              setCatsText(formatChartCategories(parseChartCategories(catsText)));
            }}
            onChange={(e) => {
              const raw = e.target.value;
              setCatsText(raw);
              onChange(at("categories"), parseChartCategories(raw));
            }}
          />
        </label>
      )}
      <label className="slot-field">
        <span>数据系列：每行一组（1–4 组），“名称: 数值 | 数值”（散点写 x, y）Series</span>
        <textarea
          rows={Math.max(2, seriesVal.length)}
          value={seriesText}
          placeholder={chartType === "scatter" ? "甲车: 0, 0 | 1, 12 | 2, 24" : "声速: 340 | 1480 | 5960"}
          data-testid="chart-series"
          onFocus={() => {
            seriesFocused.current = true;
          }}
          onBlur={() => {
            seriesFocused.current = false;
            setSeriesText(formatChartSeries(parseChartSeries(seriesText)));
          }}
          onChange={(e) => {
            const raw = e.target.value;
            setSeriesText(raw);
            onChange(at("series"), parseChartSeries(raw));
          }}
        />
        <span className={`count ${seriesVal.length > 4 ? "over" : ""}`}>{seriesVal.length} / 4 组</span>
      </label>
      <FieldIssues issues={issues} path={at("categories")} />
      <FieldIssues issues={issues} path={at("series")} />
      <details className="slot-advanced" data-testid="chart-raw-json-toggle">
        <summary>高级 JSON · Raw JSON</summary>
        <JsonField value={value} path={path} onChange={onChange} />
      </details>
    </>
  );
}

const splitCells = (s: string) => s.split("|").map((c) => c.trim());

function FigureFields({ value, path, issues, onChange }: { value: Obj; path: Path; issues: SlotIssue[]; onChange: (p: Path, v: unknown) => void }) {
  const figEnv = useContext(FigureEditorContext);
  const at = (k: string) => [...path, k];
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [showCropper, setShowCropper] = useState(false);

  const citedSet = useMemo(() => new Set(figEnv.citedPages), [figEnv.citedPages]);
  const sortedAssets = useMemo(() => {
    const onCited: MediaAssetDto[] = [];
    const others: MediaAssetDto[] = [];
    for (const a of figEnv.assets) {
      const vNo = a.virtualPageNo ?? a.pageNo;
      if (vNo !== null && vNo !== undefined && citedSet.has(vNo)) onCited.push(a);
      else others.push(a);
    }
    return [...onCited, ...others];
  }, [figEnv.assets, citedSet]);

  const currentAssetId = String(value.assetId ?? "");

  function selectAsset(asset: MediaAssetDto) {
    const autoCaption = [asset.label, asset.caption].filter(Boolean).join(": ").slice(0, 120);
    onChange(path, {
      kind: "figure",
      assetId: asset.id,
      caption: String(value.caption ?? "").trim() || autoCaption || undefined,
      ...(value.alt ? { alt: String(value.alt) } : {}),
    });
  }

  async function handleImageBlob(blob: Blob, defaultLabel: string) {
    if (!figEnv.lessonId && !figEnv.documentId) return;
    setUploading(true);
    setUploadError("");
    try {
      const dataUrl = await imageBlobToBoundedDataUrl(blob, 1200);
      const res = await mediaApi.upload({
        ...(figEnv.lessonId ? { lessonId: figEnv.lessonId } : { documentId: figEnv.documentId }),
        label: defaultLabel.slice(0, 80),
        caption: String(value.caption ?? "").trim().slice(0, 120),
        image: dataUrl,
      });
      figEnv.addAsset(res.asset);
      onChange(path, {
        kind: "figure",
        assetId: res.asset.id,
        ...(String(value.caption ?? "").trim()
          ? { caption: String(value.caption).trim() }
          : res.asset.label
            ? { caption: res.asset.label }
            : {}),
        ...(value.alt ? { alt: String(value.alt) } : {}),
      });
    } catch (e) {
      setUploadError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  // Resolve primary or secondary PDF documentId + physical pageNo for drag-crop fallback:
  const firstCited = figEnv.citedPages[0] ?? 1;
  const pdfSources = activeLessonPdfSources(figEnv.documentId);
  let cropDocId = figEnv.documentId ?? "";
  let cropPageNo = firstCited;
  if (firstCited > SOURCE_STRIDE && pdfSources.length > 0) {
    const decoded = decodeSourcePage(firstCited);
    if (pdfSources[decoded.pdfIndex]) {
      cropDocId = pdfSources[decoded.pdfIndex]!.documentId;
      cropPageNo = decoded.pageNo;
    }
  }

  return (
    <div
      className="stack"
      style={{ gap: 10 }}
      data-testid="figure-slot-editor"
      onPaste={(e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of Array.from(items)) {
          if (item.type.startsWith("image/")) {
            const blob = item.getAsFile();
            if (blob) {
              e.preventDefault();
              void handleImageBlob(blob, "剪贴板截图");
              break;
            }
          }
        }
      }}
    >
      {sortedAssets.length > 0 ? (
        <div>
          <span className="small muted">
            选择本课已提取的教材原图或截图（本页引用优先）· Pick an extracted textbook figure:
          </span>
          <div className="row wrap" style={{ gap: 8, marginTop: 6 }} data-testid="figure-picker-grid">
            {sortedAssets.map((a) => {
              const selected = a.id === currentAssetId;
              const vNo = a.virtualPageNo ?? a.pageNo;
              const isCited = vNo !== null && vNo !== undefined && citedSet.has(vNo);
              return (
                <button
                  key={a.id}
                  type="button"
                  data-testid={`pick-figure-${a.id}`}
                  aria-pressed={selected}
                  onClick={() => selectAsset(a)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                    padding: 6,
                    width: 140,
                    borderRadius: 8,
                    border: selected ? "2px solid var(--accent, #2563eb)" : "1px solid var(--line)",
                    background: selected ? "rgba(37, 99, 235, 0.08)" : "#fff",
                    cursor: "pointer",
                  }}
                >
                  <img
                    src={`/api/media/${encodeURIComponent(a.id)}`}
                    alt={a.caption || a.label || "Figure"}
                    style={{ width: 124, height: 78, objectFit: "contain", display: "block" }}
                  />
                  <span className="small" style={{ fontWeight: selected ? 700 : 400, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {isCited ? "★ " : ""}
                    {a.label || (a.pageNo ? `p.${a.pageNo}` : "上传图片")}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>
          还没有提取到本页原书插图，可直接上传/粘贴截图（Ctrl/Cmd+V），或从教材页拖框裁取。
        </p>
      )}

      <div className="row wrap" style={{ gap: 8 }}>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/webp,image/jpeg"
          hidden
          data-testid="figure-upload-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImageBlob(f, f.name.replace(/\.[a-z0-9]+$/i, ""));
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="btn small ghost"
          disabled={uploading}
          data-testid="figure-upload-btn"
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? "上传中…" : "🖼 上传图片 / Ctrl+V 粘贴截图 Upload or paste"}
        </button>
        {cropDocId && (
          <button
            type="button"
            className="btn small ghost"
            data-testid="figure-crop-toggle"
            onClick={() => setShowCropper((v) => !v)}
          >
            {showCropper ? "收起教材裁图" : `✂ 从教材第 ${cropPageNo} 页拖框裁图 Crop from page`}
          </button>
        )}
      </div>

      {uploadError && <div className="alert error">{uploadError}</div>}

      {showCropper && cropDocId && (
        <PageCropper
          documentId={cropDocId}
          pageNo={cropPageNo}
          onCancel={() => setShowCropper(false)}
          onCropped={(asset) => {
            figEnv.addAsset(asset);
            selectAsset(asset);
            setShowCropper(false);
          }}
        />
      )}

      <TextField label="图注说明 Caption（可选，最多 120 字）" value={String(value.caption ?? "")} maxChars={120} path={at("caption")} issues={issues} onChange={onChange} />
      <TextField label="无障碍替代文字 Alt（可选）" value={String(value.alt ?? "")} maxChars={120} path={at("alt")} issues={issues} onChange={onChange} />
      <FieldIssues issues={issues} path={at("assetId")} />
    </div>
  );
}

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
    case "chart":
      return <ChartFields value={value} path={path} issues={issues} onChange={onChange} />;
    case "figure":
      return <FigureFields value={value} path={path} issues={issues} onChange={onChange} />;
    default:
      return <JsonField value={value} path={path} onChange={onChange} />;
  }
}

function VisualField({ def, value, path, issues, onChange }: { def: Extract<Def, { type: "visual" }>; value: Obj; path: Path; issues: SlotIssue[]; onChange: (p: Path, v: unknown) => void }) {
  const flags = useContext(FlagContext);
  const figEnv = useContext(FigureEditorContext);
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
            const citedSet = new Set(figEnv.citedPages);
            const preferredFig =
              figEnv.assets.find((a) => {
                const vNo = a.virtualPageNo ?? a.pageNo;
                return vNo !== null && vNo !== undefined && citedSet.has(vNo);
              }) ?? figEnv.assets[0];
            onChange(path, cache.current[next] ?? visualTemplate(next, preferredFig));
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
    case "toggle":
      return (
        <label key={def.key} className="slot-field inline toggle">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(path, e.target.checked || undefined)} data-testid={`toggle-${def.key}`} />
          <span>
            {def.label}
            <small className="muted"> {def.hint}</small>
          </span>
        </label>
      );
    case "select":
      return (
        <label key={def.key} className="slot-field inline">
          <span>{def.label}</span>
          <select value={String(value ?? def.choices[0]?.value)} onChange={(e) => onChange(path, e.target.value)} data-testid={`select-${def.key}`}>
            {def.choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      );
    case "pick": {
      const options = (def.from.reduce<any>((o, k) => o?.[k], draft) as string[] | undefined) ?? [];
      return (
        <label key={def.key} className="slot-field inline">
          <span>{def.label}</span>
          <select value={value === undefined ? "" : String(value)} onChange={(e) => onChange(path, e.target.value === "" ? undefined : Number(e.target.value))} data-testid={`pick-${def.key}`}>
            <option value="">不标出 · not marked</option>
            {options.map((o, i) => (
              <option key={i} value={i}>
                {LETTERS[i]}. {o || "（空）"}
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
  dismissedUnverified,
  onDismissUnverified,
  onRestoreUnverified,
  pageType,
  theme,
  lessonId,
  documentId,
  sources = [],
  onSave,
  onCancel,
}: {
  content: SlideContent;
  notes: string;
  unverified?: Unverified[];
  dismissedUnverified?: ReadonlySet<string>;
  onDismissUnverified?: (item: Unverified) => void;
  onRestoreUnverified?: (item: Unverified) => void;
  pageType: PageType;
  theme: ThemeId;
  lessonId?: string;
  documentId?: string;
  sources?: number[];
  onSave: (content: SlideContent, notes: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Obj>(() => structuredClone(content) as Obj);
  const [noteDraft, setNoteDraft] = useState(notes);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [lessonAssets, setLessonAssets] = useState<MediaAssetDto[]>([]);

  useEffect(() => {
    if (!lessonId && !documentId) return;
    let alive = true;
    const load = lessonId ? mediaApi.listForLesson(lessonId) : mediaApi.listForDocument(documentId!);
    load
      .then((r) => alive && setLessonAssets(r.assets))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [lessonId, documentId]);

  const figEnv = useMemo<FigureEditorEnv>(
    () => ({
      lessonId,
      documentId,
      citedPages: sources,
      assets: lessonAssets,
      addAsset: (asset) => setLessonAssets((prev) => (prev.some((x) => x.id === asset.id) ? prev : [...prev, asset])),
    }),
    [lessonId, documentId, sources, lessonAssets],
  );

  const change = (p: Path, v: unknown) => setDraft((d) => setIn(d, p, v));
  const issues = useMemo(() => [...slotIssues(draft as SlideContent), ...widgetIssues(draft as SlideContent)], [draft]);
  const deferred = useDeferredValue(draft);
  const previewSlide = useMemo(() => {
    const parsed = SlideContentSchema.safeParse(deferred);
    return parsed.success ? { content: parsed.data, sources: [], pageType } : null;
  }, [deferred, pageType]);
  const activeFlags = useMemo(() => activeUnverified(unverified, dismissedUnverified ?? new Set()), [unverified, dismissedUnverified]);
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
      <UnverifiedBox items={unverified} dismissed={dismissedUnverified} onDismiss={onDismissUnverified} onRestore={onRestoreUnverified} />
      <FigureEditorContext.Provider value={figEnv}>
        <FlagContext.Provider value={activeFlags.map((u) => u.text)}>{FORM[content.layout].map((d) => render(d, draft, [], issues, change))}</FlagContext.Provider>
      </FigureEditorContext.Provider>
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
      <div className="row slot-actions">
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
