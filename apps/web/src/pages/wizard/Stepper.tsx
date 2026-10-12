import { Link } from "react-router";

export const STEPS = [
  { key: "upload", zh: "上传教材", en: "Upload PDF", hint: "选一份电子版 PDF 教材" },
  { key: "chapters", zh: "选章节", en: "Choose chapters", hint: "勾选这节课要讲的内容" },
  { key: "settings", zh: "课时设置", en: "Lesson settings", hint: "时长、学生水平、授课语言" },
  { key: "outline", zh: "确认大纲", en: "Confirm outline", hint: "检查每页讲什么、多长时间" },
  { key: "slides", zh: "生成与放映", en: "Generate & present", hint: "逐页生成，然后上课放映" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];

/** Numbered wizard header. Steps before `reached` are links so teachers can go back. */
export function Stepper({ current, reached, lessonId }: { current: StepKey; reached: StepKey; lessonId?: string }) {
  const reachedIdx = STEPS.findIndex((s) => s.key === reached);
  const curIdx = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="stepper" aria-label="步骤 Steps">
      {STEPS.map((s, i) => {
        const state = i === curIdx ? "current" : i < curIdx || i <= reachedIdx ? "done" : "todo";
        const href = lessonId && i > 0 && i <= reachedIdx ? `/lessons/${lessonId}/${s.key}` : null;
        const body = (
          <>
            <span className="step-n">{state === "done" && i !== curIdx ? "✓" : i + 1}</span>
            <span className="step-text">
              <b>{s.zh}</b>
              <small>{s.en}</small>
            </span>
          </>
        );
        return (
          <li key={s.key} className={`step ${state}`} aria-current={i === curIdx ? "step" : undefined} data-step={s.key}>
            {href && i !== curIdx ? <Link to={href}>{body}</Link> : <span>{body}</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function StepIntro({ step }: { step: StepKey }) {
  const i = STEPS.findIndex((s) => s.key === step);
  const s = STEPS[i]!;
  return (
    <div className="step-intro">
      <h1>
        第 {i + 1} 步 · {s.zh} <span className="muted">{s.en}</span>
      </h1>
      <p className="muted">{s.hint}</p>
    </div>
  );
}
