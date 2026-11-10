import type { LessonParams, Outline, PageText, PageType, SlideContent } from "@kj/schema";

export interface ClassroomSlide {
  specId: string;
  pageType: PageType;
  content: SlideContent;
  notes: string;
  sources: number[];
}

export interface ClassroomFixture {
  id: string;
  title: string;
  params: LessonParams;
  pages: PageText[];
  outline: Outline;
  slides: ClassroomSlide[];
  oracle: {
    claims: { specId: string; text: string; supportedBy: number[] }[];
    dependencies: { before: string; after: string }[];
    objectives: { objective: string; instruction: string; learnerAction: string; assessment: string }[];
    teacherOnlyCanaries: string[];
  };
}

const english: ClassroomFixture = {
  id: "waves-en",
  title: "Wave speed",
  params: { minutes: 40, level: "intermediate", lessonType: "new", language: "en", focus: "" },
  pages: [
    { no: 11, text: "Waves transfer energy without transferring matter. Wave speed equals frequency times wavelength: v = f x lambda. Frequency is measured in hertz (Hz), wavelength in metres (m), and speed in metres per second (m/s). A measured wave travels at 120 m/s." },
    { no: 12, text: "Worked example: use v = f x lambda. A wave has frequency 5 Hz and wavelength 0.4 m. Its speed is v = 5 x 0.4 = 2 m/s." },
  ],
  outline: {
    objectives: ["Use v = fλ to calculate wave speed"],
    glossary: [],
    notCovered: [],
    slides: [
      { id: "en-cover", pageType: "cover", layout: "title", title: "Wave speed links frequency and wavelength", purpose: "Introduce the lesson", keyPoints: [], visual: "none", minutes: 1, sourcePages: [], loop: 0 },
      { id: "en-retrieval", pageType: "retrieval", layout: "questions", title: "Recall motion quantities", purpose: "Activate prerequisite knowledge", keyPoints: ["Recall speed, distance and time"], visual: "none", minutes: 4, sourcePages: [], loop: 0 },
      { id: "en-concept", pageType: "concept", layout: "statement", title: "Wave speed equals frequency times wavelength", purpose: "Introduce the relationship", keyPoints: ["Frequency is measured in hertz", "Wavelength is measured in metres"], visual: "formula", minutes: 3, sourcePages: [11], loop: 1 },
      { id: "en-worked", pageType: "worked", layout: "steps", title: "Substitute values with their units", purpose: "Model the calculation", keyPoints: ["Use v = fλ", "Calculate 5 × 0.4"], visual: "formula", minutes: 4, sourcePages: [12], loop: 1 },
      { id: "en-faded", pageType: "faded", layout: "steps", title: "Complete a wave-speed calculation", purpose: "Faded practice", keyPoints: ["Use the same method"], visual: "formula", minutes: 3, sourcePages: [12], loop: 1 },
      { id: "en-check", pageType: "check", layout: "quiz", title: "Check the frequency–wavelength relationship", purpose: "Hinge question", keyPoints: ["At fixed speed, frequency and wavelength vary inversely"], visual: "none", minutes: 2, sourcePages: [11], loop: 1 },
      { id: "en-exit", pageType: "exit", layout: "questions", title: "Explain the wave equation", purpose: "Assess the objective", keyPoints: ["State the relationship"], visual: "none", minutes: 3, sourcePages: [11], loop: 0 },
    ],
  },
  slides: [
    { specId: "en-cover", pageType: "cover", sources: [], notes: "Introduce the objective.", content: { layout: "title", title: "Wave speed links frequency and wavelength", subtitle: "Wave speed", objectives: ["Use v = fλ to calculate wave speed"] } },
    { specId: "en-retrieval", pageType: "retrieval", sources: [], notes: "Accept words or symbols.", content: { layout: "questions", title: "Recall motion quantities", items: [{ q: "How do you calculate speed?", a: "distance ÷ time" }, { q: "Name a unit of time.", a: "seconds" }] } },
    { specId: "en-concept", pageType: "concept", sources: [11], notes: "Trace each quantity to its unit.", content: { layout: "statement", title: "Wave speed equals frequency times wavelength", bullets: ["Frequency is measured in hertz", "Wavelength is measured in metres"], visual: { kind: "formula", tex: "v=f\\lambda", caption: "v in m/s, f in Hz, λ in m" }, terms: [] } },
    { specId: "en-worked", pageType: "worked", sources: [12], notes: "Model substitution before calculating.", content: { layout: "steps", title: "Substitute values with their units", problem: "Find v when f = 5 Hz and λ = 0.4 m.", steps: [{ text: "Write $v=f\\lambda$", why: "Choose equation" }, { text: "Substitute $v=5\\times0.4$", why: "Keep values" }, { text: "Calculate $v=2$ m/s", why: "Include units" }] } },
    { specId: "en-faded", pageType: "faded", sources: [12], notes: "The final step is teacher-only.", content: { layout: "steps", title: "Complete a wave-speed calculation", problem: "Find v when f = 5 Hz and λ = 0.4 m.", steps: [{ text: "Write $v=f\\lambda$", why: "Choose equation" }, { text: "Substitute $v=5\\times0.4$", why: "Use values" }, { text: "$v=2$ m/s", why: "KEY-EN" }], fadeFrom: 2 } },
    { specId: "en-check", pageType: "check", sources: [11], notes: "TEACHER-NOTE-EN: listen for inverse reasoning.", content: { layout: "quiz", question: "At fixed speed, what happens if frequency doubles?", options: [{ text: "Wavelength doubles", misconception: "TEACHER-MISCONCEPTION: direct proportion" }, { text: "Wavelength halves", misconception: "" }, { text: "Wavelength stays constant", misconception: "Ignores the wave equation" }], answer: 1, explain: "TEACHER-KEY-EN: wavelength halves.", poll: true } },
    { specId: "en-exit", pageType: "exit", sources: [11], notes: "Collect before dismissal.", content: { layout: "questions", title: "Explain the wave equation", items: [{ q: "How are v, f and λ related?", a: "TEACHER-EXIT-EN: v = fλ" }, { q: "What is the unit of frequency?", a: "hertz" }] } },
  ],
  oracle: {
    claims: [
      { specId: "en-concept", text: "Wave speed equals frequency times wavelength", supportedBy: [11] },
      { specId: "en-worked", text: "5 Hz and wavelength 0.4 m", supportedBy: [12] },
    ],
    dependencies: [
      { before: "en-retrieval", after: "en-concept" },
      { before: "en-concept", after: "en-worked" },
      { before: "en-worked", after: "en-faded" },
      { before: "en-faded", after: "en-check" },
    ],
    objectives: [{ objective: "Use v = fλ to calculate wave speed", instruction: "en-concept", learnerAction: "en-faded", assessment: "en-check" }],
    teacherOnlyCanaries: ["KEY-EN", "TEACHER-NOTE-EN", "TEACHER-MISCONCEPTION", "TEACHER-KEY-EN", "TEACHER-EXIT-EN"],
  },
};

const chinese: ClassroomFixture = {
  id: "newton-zh",
  title: "牛顿第二定律",
  params: { minutes: 40, level: "intermediate", lessonType: "new", language: "zh", focus: "" },
  pages: [
    { no: 21, text: "力可以改变物体的运动状态。惯性描述物体保持原有运动状态的性质。" },
    { no: 22, text: "牛顿第二定律写作 F = m x a。质量为3千克的物体受到12牛顿合力时，加速度为4米/秒²。" },
  ],
  outline: {
    objectives: ["用 F=ma 计算加速度"],
    glossary: [],
    notCovered: [],
    slides: [
      { id: "zh-cover", pageType: "cover", layout: "title", title: "合力决定物体的加速度", purpose: "呈现学习目标", keyPoints: [], visual: "none", minutes: 1, sourcePages: [], loop: 0 },
      { id: "zh-retrieval", pageType: "retrieval", layout: "questions", title: "回顾运动状态", purpose: "激活前置知识", keyPoints: ["回顾速度变化"], visual: "none", minutes: 4, sourcePages: [], loop: 0 },
      { id: "zh-concept", pageType: "concept", layout: "statement", title: "合力、质量和加速度满足 F=ma", purpose: "讲解定律", keyPoints: ["合力增大时加速度增大", "质量增大时加速度减小"], visual: "formula", minutes: 3, sourcePages: [22], loop: 1 },
      { id: "zh-practice", pageType: "faded", layout: "steps", title: "根据合力和质量求加速度", purpose: "渐隐练习", keyPoints: ["变形得到 a=F/m"], visual: "formula", minutes: 3, sourcePages: [22], loop: 1 },
      { id: "zh-check", pageType: "check", layout: "quiz", title: "检查单位和计算结果", purpose: "关键检查题", keyPoints: ["数值和单位都要正确"], visual: "none", minutes: 2, sourcePages: [22], loop: 1 },
      { id: "zh-exit", pageType: "exit", layout: "questions", title: "说明质量如何影响加速度", purpose: "评估学习目标", keyPoints: ["应用牛顿第二定律"], visual: "none", minutes: 3, sourcePages: [22], loop: 0 },
    ],
  },
  slides: [
    { specId: "zh-cover", pageType: "cover", sources: [], notes: "呈现学习目标。", content: { layout: "title", title: "合力决定物体的加速度", subtitle: "牛顿第二定律", objectives: ["用 F=ma 计算加速度"] } },
    { specId: "zh-retrieval", pageType: "retrieval", sources: [], notes: "只回顾前置概念。", content: { layout: "questions", title: "回顾运动状态", items: [{ q: "速度变化说明什么？", a: "物体有加速度" }, { q: "速度的单位是什么？", a: "米每秒" }] } },
    { specId: "zh-concept", pageType: "concept", sources: [22], notes: "区分合力和单个力。", content: { layout: "statement", title: "合力、质量和加速度满足 F=ma", bullets: ["合力增大时加速度增大", "质量增大时加速度减小"], visual: { kind: "formula", tex: "F=ma", caption: "F：牛顿，m：千克，a：米/秒²" }, terms: [] } },
    { specId: "zh-practice", pageType: "faded", sources: [22], notes: "最后一步由学生完成。", content: { layout: "steps", title: "根据合力和质量求加速度", problem: "质量3千克，合力12牛顿，求加速度。", steps: [{ text: "写出 $F=ma$", why: "选择定律" }, { text: "变形 $a=F/m$", why: "求加速度" }, { text: "$a=4$ 米/秒²", why: "KEY-ZH" }], fadeFrom: 2 } },
    { specId: "zh-check", pageType: "check", sources: [22], notes: "TEACHER-NOTE-ZH：先投票再揭晓。", content: { layout: "quiz", question: "3千克物体受12牛顿合力，加速度是多少？", options: [{ text: "4米/秒²", misconception: "" }, { text: "36米/秒²", misconception: "把除法写成乘法" }, { text: "0.25米/秒²", misconception: "TEACHER-MISCONCEPTION-ZH" }], answer: 0, explain: "TEACHER-KEY-ZH：a=12÷3=4米/秒²。", poll: true } },
    { specId: "zh-exit", pageType: "exit", sources: [22], notes: "收齐后下课。", content: { layout: "questions", title: "说明质量如何影响加速度", items: [{ q: "合力不变时，质量增大会怎样？", a: "TEACHER-EXIT-ZH：加速度减小" }, { q: "加速度的单位是什么？", a: "米/秒²" }] } },
  ],
  oracle: {
    claims: [
      { specId: "zh-concept", text: "F = m x a", supportedBy: [22] },
      { specId: "zh-check", text: "3千克的物体受到12牛顿合力时，加速度为4米/秒²", supportedBy: [22] },
    ],
    dependencies: [
      { before: "zh-retrieval", after: "zh-concept" },
      { before: "zh-concept", after: "zh-practice" },
      { before: "zh-practice", after: "zh-check" },
    ],
    objectives: [{ objective: "用 F=ma 计算加速度", instruction: "zh-concept", learnerAction: "zh-practice", assessment: "zh-check" }],
    teacherOnlyCanaries: ["KEY-ZH", "TEACHER-NOTE-ZH", "TEACHER-MISCONCEPTION-ZH", "TEACHER-KEY-ZH", "TEACHER-EXIT-ZH"],
  },
};

export const CLASSROOM_FIXTURES: ClassroomFixture[] = [english, chinese];

export function classroomFixtureCells() {
  return CLASSROOM_FIXTURES.flatMap((fixture) =>
    fixture.slides.map((slide) => ({
      id: `classroom-${fixture.id}-${slide.specId}`,
      layout: slide.content.layout,
      content: slide.content,
    })),
  );
}
