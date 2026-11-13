import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { labelOf } from "@kj/textbook";
import { checkOutline, densityOf, outlineTiming, PAGE_TYPES, planBudget, TIME_TOLERANCE } from "@kj/pedagogy";
import { PAGE_TYPE_IDS, type LessonSource, type Outline, type PageType, type SlideSpec, type SyllabusLessonSource, type TeachingLanguage, type VisualKind } from "@kj/schema";
import { layoutForPageType, LAYOUTS, PAGE_TYPE_VISUALS } from "@kj/templates";
import { ApiError, lessonSourcesOf } from "../../api.ts";
import { RichText } from "../../components/RichText.tsx";
import { UnverifiedBadge } from "../../components/Unverified.tsx";
import { lessonApi, type LessonView, type VersionView } from "../../lessonApi.ts";
import { DraftingProgress } from "./drafting.tsx";
import { clearOutlineDraft, loadOutlineDraft, saveOutlineDraft } from "./outlineLocalDraft.ts";
import { Stepper, StepIntro, type StepKey } from "./Stepper.tsx";
import { UNSAVED_MESSAGE, useUnsavedGuard } from "./unsaved.ts";

const VISUAL_LABEL: Record<VisualKind, string> = { none: "无 None", chart: "图表 Chart", function: "函数图 Plot", flow: "流程 Flow", formula: "公式 Formula", sim: "模拟实验 Sim", table: "表格 Table" };
const visualLabel = (v: VisualKind, spec: SlideSpec) => (v === "none" && LAYOUTS[spec.layout].visual === "required" ? "图示待补 Visual to add" : VISUAL_LABEL[v]);
const cleanedOutline = (outline: Outline, language: TeachingLanguage = "en+zh"): Outline => ({
  ...outline,
  slides: outline.slides.map((s) => ({ ...s, title: s.title.trim() || (language === "en" ? "Untitled" : "未命名页面"), keyPoints: s.keyPoints.map((k) => k.trim()).filter(Boolean) })),
});

const COVERAGE_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "between",
  "into",
  "that",
  "this",
  "using",
  "state",
  "describe",
  "explain",
  "recall",
  "identify",
  "understand",
  "know",
  "how",
  "what",
  "when",
  "where",
]);

function keyTokensOf(text: string): string[] {
  const lower = text.toLowerCase();
  const latin = (lower.match(/[a-z]{4,}/g) ?? [])
    .filter((w) => !COVERAGE_STOPWORDS.has(w))
    .map((w) => w.replace(/(?:ing|ed|es|s)$/, ""));
  const cjkRuns = lower.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  const cjkPairs: string[] = [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i++) cjkPairs.push(run.slice(i, i + 2));
  }
  return [...new Set([...latin, ...cjkPairs])];
}

export interface SyllabusCoverageItem {
  item: string;
  covered: boolean;
  slides: number[];
}

/** Deterministic syllabus checklist coverage against outline objectives, slides, and notCovered. */
export function evaluateSyllabusCoverage(sources: LessonSource[], outline: Outline): SyllabusCoverageItem[] {
  const rawItems: string[] = [];
  for (const s of sources) {
    if (s.kind !== "syllabus") continue;
    const syl = s as SyllabusLessonSource;
    if (syl.items?.length) rawItems.push(...syl.items);
    else if (syl.text.trim()) {
      rawItems.push(
        ...syl.text
          .split(/\r?\n/)
          .map((l) => l.replace(/^\s*(?:[-*•☐☑✓]|\d+[.)])\s*/, "").trim())
          .filter(Boolean),
      );
    }
  }
  const items = [...new Set(rawItems)];
  if (!items.length) return [];

  const notCoveredTokens = outline.notCovered.map((nc) => ({ raw: nc.toLowerCase(), tokens: new Set(keyTokensOf(nc)) }));
  const slideTokenSets = outline.slides.map((s) => new Set(keyTokensOf(`${s.title} ${s.purpose} ${s.keyPoints.join(" ")}`)));
  const objectiveTokens = new Set(keyTokensOf(outline.objectives.join(" ")));

  return items.map((item) => {
    const tokens = keyTokensOf(item);
    const explicitlyOmitted = notCoveredTokens.some((nc) => {
      if (nc.raw.includes(item.toLowerCase()) || item.toLowerCase().includes(nc.raw)) return true;
      if (!tokens.length) return false;
      const overlap = tokens.filter((t) => nc.tokens.has(t)).length;
      return overlap / tokens.length >= 0.6;
    });
    if (explicitlyOmitted) return { item, covered: false, slides: [] };

    if (!tokens.length) return { item, covered: outline.slides.length > 0, slides: [] };
    const minHits = tokens.length <= 2 ? 1 : Math.max(2, Math.ceil(tokens.length * 0.4));
    const matchedSlides: number[] = [];
    slideTokenSets.forEach((set, idx) => {
      const hits = tokens.filter((t) => set.has(t)).length;
      if (hits >= minHits) matchedSlides.push(idx + 1);
    });
    const objHits = tokens.filter((t) => objectiveTokens.has(t)).length;
    const covered = matchedSlides.length > 0 || objHits >= minHits;
    return { item, covered, slides: matchedSlides };
  });
}

export function SyllabusCoverageCard({ sources, outline }: { sources: LessonSource[]; outline: Outline }) {
  const items = evaluateSyllabusCoverage(sources, outline);
  if (!items.length) return null;
  const coveredCount = items.filter((i) => i.covered).length;
  const allCovered = coveredCount === items.length;
  return (
    <div className={`alert ${allCovered ? "success" : "warn"}`} data-testid="syllabus-coverage" style={{ marginTop: 10 }}>
      <div className="row between wrap">
        <b>
          📋 考纲覆盖核对 Syllabus coverage: {coveredCount} / {items.length} 已覆盖
        </b>
        <span className="small">{allCovered ? "✓ 所有考纲条目均已落入大纲" : "⚠ 部分考纲条目尚未覆盖，可补充或调整页面要点"}</span>
      </div>
      <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
        {items.map((entry, idx) => (
          <li key={idx} data-testid="syllabus-coverage-item" data-covered={entry.covered ? "true" : "false"}>
            {entry.covered ? "✓" : "⚠"} {entry.item}{" "}
            {entry.slides.length > 0 && <span className="muted small">（第 {entry.slides.join(", ")} 页）</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatSourceCitations(sourcePages: number[], labels: Map<number, string>): string {
  if (!sourcePages.length) return "教材 p.—";
  const parts = sourcePages.map((p) => {
    const lbl = labelOf(labels, p);
    return lbl.includes(" p.") ? lbl : `p.${lbl}`;
  });
  return `教材 ${parts.join(", ")}`;
}

function TimeBudget({ outline, minutes }: { outline: Outline; minutes: number }) {
  const t = outlineTiming(outline, { minutes });
  const b = planBudget({ minutes });
  const max = minutes * 1.4;
  const pct = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  return (
    <div className={`budget ${t.status}`} data-testid="budget">
      <div className="budget-head">
        <b>
          总时长 {t.totalMinutes} / {minutes} 分钟
        </b>
        <span>
          {t.status === "ok" ? `✓ ${b.minMinutes}–${b.maxMinutes} 分钟为合适 · within budget` : t.status === "over" ? `超出 ${Math.round(t.deviation * 100)}% · over budget` : `不足 ${Math.round(-t.deviation * 100)}% · under budget`}
        </span>
        <span className="muted small">
          {t.slideCount} 页 · 讲授 {Math.round(t.lectureShare * 100)}% / 学生活动 {Math.round(t.activityShare * 100)}%
        </span>
      </div>
      <div className="budget-track">
        <div className="budget-band" style={{ left: pct(minutes * (1 - TIME_TOLERANCE)), width: `calc(${pct(minutes * (1 + TIME_TOLERANCE))} - ${pct(minutes * (1 - TIME_TOLERANCE))})` }} />
        <div className="budget-fill" style={{ width: pct(t.totalMinutes) }} />
        <div className="budget-target" style={{ left: pct(minutes) }} />
      </div>
    </div>
  );
}

function Row({
  spec,
  i,
  n,
  readOnly,
  labels,
  unverified,
  onChange,
  onMove,
  onDelete,
  onAdd,
}: {
  spec: SlideSpec;
  unverified: number;
  i: number;
  n: number;
  readOnly: boolean;
  labels: Map<number, string>;
  onChange: (s: SlideSpec) => void;
  onMove: (d: -1 | 1) => void;
  onDelete: () => void;
  onAdd: () => void;
}) {
  const d = densityOf(spec);
  const def = PAGE_TYPES[spec.pageType];
  const visuals = PAGE_TYPE_VISUALS[spec.pageType];
  return (
    <li className={`outline-row ${def.mode}`} data-testid="outline-row">
      <div className="row-num">{i + 1}</div>
      <div className="row-main">
        <div className="row-top">
          <select
            value={spec.pageType}
            disabled={readOnly}
            aria-label="页面类型 Page type"
            onChange={(e) => {
              const pageType = e.target.value as PageType;
              const v = PAGE_TYPE_VISUALS[pageType];
              onChange({ ...spec, pageType, layout: layoutForPageType(pageType), visual: v.includes(spec.visual) ? spec.visual : v[0]!, minutes: PAGE_TYPES[pageType].minutes });
            }}
          >
            {PAGE_TYPE_IDS.map((t) => (
              <option key={t} value={t}>
                {PAGE_TYPES[t].label.zh} · {PAGE_TYPES[t].label.en}
              </option>
            ))}
          </select>
          <input className="row-title" value={spec.title} disabled={readOnly} aria-label="标题 Title" maxLength={160} onChange={(e) => onChange({ ...spec, title: e.target.value })} />
          <label className="row-minutes">
            <MinutesInput value={spec.minutes} disabled={readOnly} onChange={(minutes) => onChange({ ...spec, minutes })} />
            分钟
          </label>
          <UnverifiedBadge count={unverified} />
          <span className={`density ${d.level}`} title={d.reasons.join("\n") || "内容量合适 · OK"} data-testid="density">
            {d.level === "ok" ? "● 合适" : d.level === "dense" ? "● 偏多" : "● 偏少"}
          </span>
        </div>
        <textarea
          className="row-points"
          rows={Math.max(2, spec.keyPoints.length)}
          disabled={readOnly}
          aria-label="要点 Key points"
          value={spec.keyPoints.join("\n")}
          placeholder="每行一个要点 · one key point per line"
          onChange={(e) => onChange({ ...spec, keyPoints: e.target.value.split("\n").slice(0, 6) })}
          onBlur={() => onChange({ ...spec, keyPoints: spec.keyPoints.map((k) => k.trim()).filter(Boolean) })}
        />
        <div className="row-meta muted small">
          <span>版式 {LAYOUTS[spec.layout].label.zh}</span>
          {visuals.length > 1 ? (
            <label>
              图示
              <select value={spec.visual} disabled={readOnly} onChange={(e) => onChange({ ...spec, visual: e.target.value as VisualKind })}>
                {visuals.map((v) => (
                  <option key={v} value={v}>
                    {visualLabel(v, spec)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <span>{formatSourceCitations(spec.sourcePages, labels)}</span>
          {d.reasons.length > 0 && <span className={`density-reason ${d.level}`}>{d.reasons[0]}</span>}
        </div>
      </div>
      {!readOnly && (
        <div className="row-actions">
          <button className="icon" disabled={i === 0} onClick={() => onMove(-1)} aria-label="上移 Move up">
            ↑
          </button>
          <button className="icon" disabled={i === n - 1} onClick={() => onMove(1)} aria-label="下移 Move down">
            ↓
          </button>
          <button className="icon" onClick={onAdd} aria-label="在下方插入 Insert below">
            ＋
          </button>
          <button className="icon danger" disabled={n <= 1} onClick={onDelete} aria-label="删除 Delete">
            ✕
          </button>
        </div>
      )}
    </li>
  );
}

const clampMinutes = (n: number) => Math.max(0.5, Math.min(15, n));

function MinutesInput({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (minutes: number) => void }) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  return (
    <input
      type="number"
      min={0.5}
      max={15}
      step={0.5}
      value={focused ? text : String(value)}
      disabled={disabled}
      aria-label="分钟 Minutes"
      onFocus={() => {
        setText(String(value));
        setFocused(true);
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n) && n >= 0.5 && n <= 15) onChange(n);
      }}
      onBlur={() => {
        setFocused(false);
        const n = clampMinutes(Number(text) || 0.5);
        if (n !== value) onChange(n);
      }}
    />
  );
}

export function OutlineStep({ view, reached, onChanged }: { view: LessonView; reached: StepKey; onChanged: () => Promise<void> }) {
  const nav = useNavigate();
  const copied = useSearchParams()[0].get("copied") === "1";
  const current = view.draft ?? view.confirmed;
  const [version, setVersion] = useState<VersionView | null>(current);
  const [outline, setOutline] = useState<Outline | null>(current?.outline ?? null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [recoverableDraft, setRecoverableDraft] = useState<Outline | null>(null);
  const [needAck, setNeedAck] = useState<string | null>(null);
  const [draftingSince, setDraftingSince] = useState<number | null>(view.drafting?.startedAt ?? null);
  const draftAbortRef = useRef<AbortController | null>(null);
  const params = version?.params ?? view.lesson.params;
  const activeSources = version?.scope.sources ?? lessonSourcesOf(view);
  const readOnly = !!version?.confirmedAt;
  const labels = useMemo(() => new Map(Object.entries(view.pageLabels).map(([k, v]) => [Number(k), v])), [view.pageLabels]);
  useUnsavedGuard(dirty);

  useEffect(() => {
    setVersion(current);
    setOutline(current?.outline ?? null);
    setDirty(false);
    setConflict(false);
    if (current) {
      const local = loadOutlineDraft(window.localStorage, view.lesson.id, current.id);
      setRecoverableDraft(local && JSON.stringify(local) !== JSON.stringify(current.outline) ? local : null);
    } else {
      setRecoverableDraft(null);
    }
  }, [current, view.lesson.id]);
  useEffect(() => setDraftingSince(view.drafting?.startedAt ?? null), [view.drafting]);
  const drafted = useCallback(async () => {
    setDraftingSince(null);
    await onChanged();
  }, [onChanged]);
  const leave = (to: string) => (!dirty || window.confirm(UNSAVED_MESSAGE)) && nav(to);

  const warnings = useMemo(() => (outline ? checkOutline(outline, params) : []), [outline, params]);
  const flagged = useMemo(() => new Map(view.slides.map((s) => [s.specId, s.unverified?.length ?? 0])), [view.slides]);

  function update(slides: SlideSpec[]) {
    if (!outline) return;
    setOutline({ ...outline, slides });
    setDirty(true);
    setNeedAck(null);
  }

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError("");
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return undefined;
      if (e instanceof ApiError && e.code === "OVER_BUDGET_ACK_REQUIRED") setNeedAck(e.message);
      else if (e instanceof ApiError && e.code === "DRAFT_IN_PROGRESS") setDraftingSince((s) => s ?? Date.now());
      else {
        const changed = e instanceof ApiError && e.code === "OUTLINE_CHANGED";
        const immutable = e instanceof ApiError && e.code === "OUTLINE_VERSION_IMMUTABLE";
        if (changed && version && outline) saveOutlineDraft(window.localStorage, view.lesson.id, version.id, cleanedOutline(outline, params.language));
        setConflict(changed || immutable);
        setError(changed ? `${e.message} 你的修改已保存在这台设备上。` : e instanceof ApiError ? e.message : (e as Error).message);
      }
      return undefined;
    } finally {
      setBusy("");
    }
  }

  async function save(): Promise<VersionView | null> {
    if (!version || !outline) return null;
    const cleaned = cleanedOutline(outline, params.language);
    const r = await lessonApi.save(view.lesson.id, version.id, cleaned, version.rev);
    clearOutlineDraft(window.localStorage, view.lesson.id, version.id);
    setRecoverableDraft(null);
    setVersion(r.version);
    setOutline(r.version.outline);
    setDirty(false);
    return r.version;
  }

  async function confirm(ack: boolean) {
    const ok = await run("confirm", async () => {
      const v = dirty ? await save() : version;
      if (!v) return false;
      await lessonApi.confirm(view.lesson.id, v.id, v.rev, ack);
      return true;
    });
    if (ok) {
      await onChanged();
      nav(`/lessons/${view.lesson.id}/slides?generate=1`);
    }
  }

  async function reload() {
    setDirty(false);
    setError("");
    setConflict(false);
    await onChanged();
  }

  if (!version || !outline) {
    return (
      <div className="wizard">
        <Stepper current="outline" reached={reached} lessonId={view.lesson.id} />
        <StepIntro step="outline" />
        {draftingSince !== null ? (
          <DraftingProgress
            lessonId={view.lesson.id}
            startedAt={draftingSince}
            onDone={drafted}
            onStop={() => {
              draftAbortRef.current?.abort();
              setDraftingSince(null);
              setBusy("");
            }}
          />
        ) : (
          <div className="card center">
            <p>还没有大纲 · No outline yet</p>
            <button
              className="btn primary"
              disabled={!!busy}
              onClick={() =>
                run("draft", async () => {
                  const ac = new AbortController();
                  draftAbortRef.current = ac;
                  setDraftingSince(Date.now());
                  try {
                    const res = await fetch(`/api/lessons/${view.lesson.id}/outline`, {
                      method: "POST",
                      credentials: "same-origin",
                      headers: { "x-kj-csrf": "1" },
                      signal: ac.signal,
                    });
                    if (!res.ok) {
                      const text = await res.text();
                      const data = text ? JSON.parse(text) : {};
                      const err = (data as { error?: { code?: string; message?: string; detail?: unknown } }).error;
                      throw new ApiError(res.status, err?.code ?? "HTTP", err?.message ?? `HTTP ${res.status}`, err?.detail);
                    }
                    await drafted();
                  } catch (e) {
                    if (ac.signal.aborted || (e instanceof Error && e.name === "AbortError")) {
                      setDraftingSince(null);
                      return;
                    }
                    if (!(e instanceof ApiError && e.code === "DRAFT_IN_PROGRESS")) setDraftingSince(null);
                    throw e;
                  }
                })
              }
            >
              生成大纲 Draft outline
            </button>
          </div>
        )}
        {error && <div className="alert error">{error}</div>}
      </div>
    );
  }

  const slides = outline.slides;
  return (
    <div className="wizard">
      <Stepper current="outline" reached={reached} lessonId={view.lesson.id} />
      <StepIntro step="outline" />
      {recoverableDraft && !readOnly && (
        <div className="alert info" data-testid="outline-draft-recovery">
          <p>已保留冲突前的本机草稿。你可以在最新版上恢复自己的修改。· Your local edits were kept and can be restored over the latest version.</p>
          <button
            className="btn small"
            onClick={() => {
              setOutline(recoverableDraft);
              setRecoverableDraft(null);
              setDirty(true);
            }}
            data-testid="outline-restore-draft"
          >
            恢复我的修改 · Restore my edits
          </button>
          <button
            className="btn small ghost"
            onClick={() => {
              clearOutlineDraft(window.localStorage, view.lesson.id, version.id);
              setRecoverableDraft(null);
            }}
            data-testid="outline-discard-draft"
          >
            放弃草稿 · Discard draft
          </button>
        </div>
      )}
      {copied && (
        <div className="alert info" data-testid="copied-hint">
          已复制到新学期：大纲和 {view.slides.length} 页幻灯片（包括你手动改过的）都沿用了。
          {readOnly ? "点下方“修改大纲”按新学期调整" : "原课里没确认的大纲草稿也一起复制了，可以直接改"}，确认后只有改动过的页需要重新生成。· Copied with every slide; revise the outline and only changed slides
          are regenerated.
        </div>
      )}
      <div className="card outline-head">
        <div className="row between">
          <div>
            <h2>{view.lesson.title}</h2>
            <p className="muted small">
              大纲第 {version.version} 版 · {readOnly ? "已确认（不可修改）· confirmed" : "草稿，可直接修改 · draft, edit freely"}
            </p>
            {!readOnly && view.confirmed && (
              <p className="muted small" data-testid="draft-note">
                已确认的第 {view.confirmed.version} 版和它的幻灯片照常可以放映、分享；这份草稿确认后才会替换它。· The confirmed version stays available until this draft is confirmed.{" "}
                <button className="link" onClick={() => leave(`/lessons/${view.lesson.id}/slides`)}>
                  去第 {view.confirmed.version} 版的幻灯片 →
                </button>
              </p>
            )}
          </div>
          <div className="objectives">
            {outline.objectives.map((o, i) => (
              <span key={i} className="objective">
                🎯 <RichText text={o} />
              </span>
            ))}
          </div>
        </div>
        <TimeBudget outline={outline} minutes={params.minutes} />
        <SyllabusCoverageCard sources={activeSources} outline={outline} />
        {outline.notCovered.length > 0 && (
          <div className="alert warn not-covered" data-testid="not-covered">
            <b>本节课没有覆盖 · Not covered:</b> {outline.notCovered.join("；")}
          </div>
        )}
        {outline.glossary.length > 0 && (
          <p className="muted small glossary" data-testid="glossary">
            术语表 Glossary: {outline.glossary.map((g) => (g.zh ? `${g.term} ${g.zh}` : g.term)).join(" · ")}
          </p>
        )}
        {warnings.length > 0 && (
          <ul className="warnings" data-testid="warnings">
            {warnings.slice(0, 6).map((w, i) => (
              <li key={i} className={w.level}>
                {w.level === "error" ? "⚠" : "ⓘ"} {w.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ol className="outline-list">
        {slides.map((s, i) => (
          <Row
            key={s.id}
            spec={s}
            i={i}
            n={slides.length}
            readOnly={readOnly}
            labels={labels}
            unverified={flagged.get(s.id) ?? 0}
            onChange={(next) => update(slides.map((x, j) => (j === i ? next : x)))}
            onMove={(dir) => {
              const arr = [...slides];
              const [m] = arr.splice(i, 1);
              arr.splice(i + dir, 0, m!);
              update(arr);
            }}
            onDelete={() => update(slides.filter((_, j) => j !== i))}
            onAdd={() => {
              const arr = [...slides];
              const defaultTitle = params.language === "en" ? "Practice questions" : params.language === "zh" ? "随堂练习" : "随堂练习 · Practice questions";
              arr.splice(i + 1, 0, {
                id: `new${Date.now().toString(36)}`,
                pageType: "practice",
                layout: "questions",
                title: defaultTitle,
                purpose: "",
                keyPoints: [],
                visual: "none",
                minutes: PAGE_TYPES.practice.minutes,
                sourcePages: s.sourcePages,
                loop: s.loop,
              });
              update(arr);
            }}
          />
        ))}
      </ol>
      {error && (
        <div className="alert error" role="alert" data-testid="outline-error">
          {error}
          {conflict && (
            <div>
              <button className="btn small" onClick={reload} data-testid="outline-reload">
                保留草稿，载入最新版 · Keep draft and reload
              </button>
            </div>
          )}
        </div>
      )}
      {needAck && (
        <div className="alert warn" role="alert" data-testid="ack-box">
          <p>{needAck}</p>
          <button className="btn primary" onClick={() => confirm(true)} disabled={!!busy}>
            我知道超时了，仍然确认 · Confirm anyway
          </button>
        </div>
      )}
      <div className="wizard-actions sticky">
        <button className="btn ghost" onClick={() => leave(`/lessons/${view.lesson.id}/settings`)}>
          ← 返回 Back
        </button>
        {readOnly ? (
          <>
            <button className="btn ghost" disabled={!!busy} onClick={() => run("revise", async () => (await lessonApi.revise(view.lesson.id, version.id), await onChanged()))}>
              修改大纲（新版本）Edit as new version
            </button>
            <button className="btn primary" onClick={() => nav(`/lessons/${view.lesson.id}/slides`)}>
              下一步：生成幻灯片 Next →
            </button>
          </>
        ) : (
          <>
            <button className="btn ghost" disabled={!dirty || !!busy} onClick={() => run("save", save)}>
              {dirty ? "保存修改 Save" : "已保存 Saved"}
            </button>
            <button className="btn primary" disabled={!!busy} onClick={() => confirm(false)} data-testid="confirm-outline">
              {busy === "confirm" ? "确认中… Confirming" : "确认大纲 Confirm outline ✓"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
