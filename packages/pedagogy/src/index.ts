import { countWords, type LayoutId, type LessonParams, type Outline, type PageType, type SlideContent, type SlideSpec } from "@kj/schema";
import { BUDGETS, layoutForPageType, type ListBudget } from "@kj/templates";

export interface PageTypeDef {
  id: PageType;
  label: { zh: string; en: string };
  /** Default minutes and the sensible range (pedagogy-rules §3). */
  minutes: number;
  range: [number, number];
  /** Lecture vs student activity, for L-04 and L-09. */
  mode: "lecture" | "practice" | "none";
}

export const PAGE_TYPES: Record<PageType, PageTypeDef> = {
  cover: { id: "cover", label: { zh: "封面与目标", en: "Cover" }, minutes: 0.5, range: [0.3, 1], mode: "none" },
  retrieval: { id: "retrieval", label: { zh: "回顾提取", en: "Retrieval" }, minutes: 4, range: [3, 6], mode: "practice" },
  concept: { id: "concept", label: { zh: "概念讲解", en: "Concept" }, minutes: 2.5, range: [1.5, 3.5], mode: "lecture" },
  process: { id: "process", label: { zh: "过程机制", en: "Process" }, minutes: 3, range: [2, 4], mode: "lecture" },
  data: { id: "data", label: { zh: "数据图表", en: "Data" }, minutes: 2.5, range: [1.5, 3.5], mode: "lecture" },
  worked: { id: "worked", label: { zh: "例题示范", en: "Worked example" }, minutes: 4, range: [3, 5], mode: "lecture" },
  faded: { id: "faded", label: { zh: "渐隐练习", en: "Faded example" }, minutes: 3.5, range: [2.5, 4.5], mode: "practice" },
  practice: { id: "practice", label: { zh: "独立练习", en: "Practice" }, minutes: 6, range: [4, 8], mode: "practice" },
  experiment: { id: "experiment", label: { zh: "实验（预测-观察-解释）", en: "Experiment" }, minutes: 8, range: [6, 10], mode: "practice" },
  check: { id: "check", label: { zh: "检查理解", en: "Check" }, minutes: 2, range: [1.5, 3], mode: "practice" },
  summary: { id: "summary", label: { zh: "结构小结", en: "Summary" }, minutes: 2.5, range: [2, 3], mode: "lecture" },
  exit: { id: "exit", label: { zh: "出门条", en: "Exit ticket" }, minutes: 3, range: [2, 4], mode: "practice" },
};

/** L-03: total minutes may deviate ±15% before an extra confirmation is required. */
export const TIME_TOLERANCE = 0.15;
/** L-04: continuous lecture minutes before a check-for-understanding is due. */
export const MAX_LECTURE_RUN = 10;

export interface Budget {
  minutes: number;
  tolerance: number;
  minMinutes: number;
  maxMinutes: number;
}

export function planBudget(params: Pick<LessonParams, "minutes">): Budget {
  const m = params.minutes;
  return {
    minutes: m,
    tolerance: TIME_TOLERANCE,
    minMinutes: Math.round(m * (1 - TIME_TOLERANCE) * 10) / 10,
    maxMinutes: Math.round(m * (1 + TIME_TOLERANCE) * 10) / 10,
  };
}

export interface Timing {
  totalMinutes: number;
  /** (total − lesson) / lesson */
  deviation: number;
  status: "under" | "ok" | "over";
  /** Outside ±15%: confirming needs an explicit second click (F-03), enforced by the server. */
  needsAck: boolean;
  slideCount: number;
  lectureShare: number;
  activityShare: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function outlineTiming(outline: Pick<Outline, "slides">, params: Pick<LessonParams, "minutes">): Timing {
  const budget = planBudget(params);
  const total = outline.slides.reduce((n, s) => n + s.minutes, 0);
  const lecture = outline.slides.filter((s) => PAGE_TYPES[s.pageType].mode === "lecture").reduce((n, s) => n + s.minutes, 0);
  const activity = outline.slides.filter((s) => PAGE_TYPES[s.pageType].mode === "practice").reduce((n, s) => n + s.minutes, 0);
  const deviation = (total - budget.minutes) / budget.minutes;
  return {
    totalMinutes: round1(total),
    deviation: Math.round(deviation * 1000) / 1000,
    status: deviation > TIME_TOLERANCE ? "over" : deviation < -TIME_TOLERANCE ? "under" : "ok",
    needsAck: Math.abs(deviation) > TIME_TOLERANCE + 1e-9,
    slideCount: outline.slides.length,
    lectureShare: total ? round1((lecture / total) * 100) / 100 : 0,
    activityShare: total ? round1((activity / total) * 100) / 100 : 0,
  };
}

/** Rough teaching time for a selection: about 6 minutes per 1000 words of textbook text (F-01). */
export const MINUTES_PER_1000_WORDS = 6;

export interface ScopeAdvice {
  estimatedMinutes: number;
  /** Lessons of the chosen length the selection would need. */
  lessons: number;
  tooMuch: boolean;
}

export function scopeAdvice(words: number, lessonMinutes: number): ScopeAdvice {
  const estimatedMinutes = Math.round((words / 1000) * MINUTES_PER_1000_WORDS);
  return {
    estimatedMinutes,
    lessons: Math.max(1, Math.ceil(estimatedMinutes / lessonMinutes - 0.2)),
    tooMuch: estimatedMinutes > lessonMinutes * 1.2,
  };
}

export interface Violation {
  level: "error" | "warning";
  code: string;
  message: string;
  slideId?: string;
}

const LIST_OF: Record<LayoutId, ListBudget> = {
  title: BUDGETS.title.objectives,
  statement: BUDGETS.statement.bullets,
  chart: BUDGETS.chart.takeaways,
  steps: BUDGETS.steps.steps,
  experiment: BUDGETS.experiment.observe,
  quiz: BUDGETS.quiz.options,
  questions: BUDGETS.questions.items,
  summary: BUDGETS.summary.nodes,
};

export interface Density {
  level: "sparse" | "ok" | "dense";
  reasons: string[];
}

/** Planning-time density light for one outline row (F-05 / gate 1 of the overflow defences). */
export function densityOf(spec: SlideSpec): Density {
  const def = PAGE_TYPES[spec.pageType];
  const list = LIST_OF[spec.layout] ?? BUDGETS.statement.bullets;
  const reasons: string[] = [];
  const points = spec.keyPoints.length;
  const longest = Math.max(0, ...spec.keyPoints.map(countWords));
  if (points > list.max) reasons.push(`要点 ${points} 条，超过上限 ${list.max} 条，建议拆成两页 · too many points`);
  if (longest > list.item.max + 4) reasons.push(`有要点过长（${longest} 词），上屏放不下 · a point is too long`);
  if (spec.minutes > def.range[1] + 1e-9) reasons.push(`${spec.minutes} 分钟偏长（${def.label.zh}一般 ≤ ${def.range[1]} 分钟）· too long for one page`);
  if (reasons.length) return { level: "dense", reasons };
  if (def.mode !== "none") {
    if (points < list.min && spec.layout !== "quiz") reasons.push(`要点少于 ${list.min} 条，这页可能没东西可讲 · too little content`);
    if (spec.minutes < 0.75) reasons.push("不到 45 秒，建议与相邻页合并 · under 45 seconds");
    if (spec.sourcePages.length === 0 && def.mode === "lecture") reasons.push("没有教材来源页 · no source page");
  }
  return { level: reasons.length ? "sparse" : "ok", reasons };
}

/** Outline rules: L-03 timing, L-04 check cadence, L-09 talk/practice balance, I-06 example triad, P-07 visuals. */
export function checkOutline(outline: Outline, params: LessonParams): Violation[] {
  const v: Violation[] = [];
  const timing = outlineTiming(outline, params);
  const budget = planBudget(params);
  if (timing.needsAck) {
    v.push({
      level: "error",
      code: "time-budget",
      message: `预计 ${timing.totalMinutes} 分钟，超出课时 ${params.minutes} 分钟的 ±15%（${budget.minMinutes}–${budget.maxMinutes}）· total time outside ±15% of the lesson`,
    });
  }

  let run = 0;
  for (const s of outline.slides) {
    if (s.layout !== layoutForPageType(s.pageType)) v.push({ level: "error", code: "layout", message: `版式 ${s.layout} 不适用于页型 ${s.pageType}`, slideId: s.id });
    const mode = PAGE_TYPES[s.pageType].mode;
    if (mode === "lecture") {
      run += s.minutes;
      if (run > MAX_LECTURE_RUN + 1e-9) {
        v.push({ level: "warning", code: "check-cadence", message: `连续讲授超过 ${MAX_LECTURE_RUN} 分钟，建议在此之前插入检查理解题 · add a check before this page`, slideId: s.id });
        run = 0;
      }
    } else if (mode === "practice") run = 0;
    if (["concept", "process", "data"].includes(s.pageType) && s.visual === "none") v.push({ level: "warning", code: "visual", message: "讲解页需要一个有意义的图示 · explanation pages need a visual", slideId: s.id });
    const d = densityOf(s);
    if (d.level === "dense") v.push({ level: "warning", code: "dense", message: d.reasons.join("；"), slideId: s.id });
  }

  if (params.level !== "advanced") {
    outline.slides.forEach((s, i) => {
      const next = outline.slides[i + 1];
      if (s.pageType === "worked" && next && !["faded", "practice"].includes(next.pageType)) {
        v.push({ level: "warning", code: "example-triad", message: "例题之后应紧跟渐隐练习或独立练习 · follow a worked example with practice", slideId: s.id });
      }
    });
  }
  if (timing.lectureShare > 0.5 + 1e-9) v.push({ level: "warning", code: "talk-ratio", message: `讲授占 ${Math.round(timing.lectureShare * 100)}%，建议 ≤ 50% · too much lecture` });
  if (timing.activityShare < 0.4 - 1e-9) v.push({ level: "warning", code: "activity-ratio", message: `学生活动占 ${Math.round(timing.activityShare * 100)}%，建议 ≥ 40% · too little student activity` });
  if (outline.slides[0]?.pageType !== "cover") v.push({ level: "warning", code: "skeleton", message: "第一页应为封面与目标 · start with a cover" });
  const last = outline.slides[outline.slides.length - 1];
  if (last && !["exit", "summary"].includes(last.pageType)) v.push({ level: "warning", code: "skeleton", message: "最后应以小结或出门条收尾 · end with a summary or exit ticket" });
  return v;
}

/** P-10 / P-11: teacher talk and AI clichés never go on screen. */
export const BANNED_PHRASES = [
  "in this lesson",
  "let's",
  "let us",
  "dive into",
  "delve",
  "unlock",
  "crucial role",
  "it is important to note",
  "深入理解",
  "至关重要",
  "让我们一起",
  "下面我们来看",
  "我们将学习",
  "本节课我们",
];

function screenText(c: SlideContent): string[] {
  switch (c.layout) {
    case "title":
      return [c.title, c.subtitle, ...c.objectives];
    case "statement":
      return [c.title, ...c.bullets];
    case "chart":
      return [c.title, ...c.takeaways];
    case "steps":
      return [c.title, c.problem, ...c.steps.map((s) => s.text)];
    case "experiment":
      return [c.title, c.predict.question, ...c.observe, c.explain];
    case "quiz":
      return [c.question, ...c.options.map((o) => o.text), c.explain];
    case "questions":
      return [c.title, ...c.items.flatMap((i) => [i.q, i.a])];
    case "summary":
      return [c.title, ...c.nodes.flatMap((n) => [n.head, n.detail])];
  }
}

/** Soft-budget and wording checks on generated content (hard budgets are enforced by the slot schema). */
export function checkSlide(c: SlideContent): Violation[] {
  const v: Violation[] = [];
  const all = screenText(c).join(" \n ").toLowerCase();
  for (const p of BANNED_PHRASES) if (all.includes(p)) v.push({ level: "error", code: "cliche", message: `屏幕上不应出现“${p}”（放进备注）· move teacher talk to notes` });
  const list = LIST_OF[c.layout];
  const items =
    c.layout === "statement" ? c.bullets : c.layout === "chart" ? c.takeaways : c.layout === "steps" ? c.steps.map((s) => s.text) : c.layout === "questions" ? c.items.map((i) => i.q) : c.layout === "summary" ? c.nodes.map((n) => n.head) : [];
  if (items.length > list.soft) v.push({ level: "warning", code: "list-length", message: `${items.length} 条，建议 ≤ ${list.soft} 条 · list longer than the default` });
  const longItem = items.find((s) => countWords(s) > list.item.soft);
  if (longItem) v.push({ level: "warning", code: "item-length", message: `“${longItem.slice(0, 30)}…”偏长 · item longer than the default` });
  if (c.layout === "statement") {
    const body = c.bullets.reduce((n, s) => n + countWords(s), 0);
    if (body > BUDGETS.statement.bodyTotal.soft) v.push({ level: "warning", code: "body-words", message: `正文约 ${body} 词，建议 ≤ ${BUDGETS.statement.bodyTotal.soft} · body text above the default` });
  }
  return v;
}

export const LEVEL_LABEL = { basic: "基础 Basic", intermediate: "中等 Intermediate", advanced: "较强 Advanced" } as const;
export const LESSON_TYPE_LABEL = { new: "新授课 New content", review: "复习课 Review", lab: "实验课 Lab" } as const;
export const LANGUAGE_LABEL = { en: "英文授课 English", zh: "中文授课 Chinese", "en+zh": "英文授课 + 中文术语 English + 中文术语" } as const;
