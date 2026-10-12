import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { answerKey, type Position } from "@kj/player";
import type { Slide, TeachingLanguage, ThemeId } from "@kj/schema";
import { SlideThumb } from "../components/SlideView.tsx";
import { lessonApi } from "../lessonApi.ts";
import { PlayerHost } from "./PlayPages.tsx";

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/** Elapsed time with pause; restarts from zero on reset. */
function useTimer() {
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const elapsed = ((pausedAt ?? now) - startedAt) / 1000;
  return {
    elapsed: Math.max(0, elapsed),
    paused: pausedAt !== null,
    toggle: () => {
      if (pausedAt === null) setPausedAt(Date.now());
      else {
        setStartedAt((s) => s + (Date.now() - pausedAt));
        setPausedAt(null);
      }
    },
    reset: () => {
      setStartedAt(Date.now());
      setPausedAt((p) => (p === null ? null : Date.now()));
    },
  };
}

/**
 * Presenter window: current slide (drives or follows the audience window), next slide, notes,
 * answer key and a timer against the planned minutes. Opened from the audience view; never projected.
 */
export function PresenterPage() {
  const { id = "" } = useParams();
  const [data, setData] = useState<{ title: string; slides: Slide[]; theme: ThemeId; minutes: number; pageLabels: Record<number, string>; language: TeachingLanguage } | null>(null);
  const [error, setError] = useState("");
  const [pos, setPos] = useState<Position>({ index: 0, step: 0 });
  const timer = useTimer();
  useEffect(() => {
    lessonApi
      .get(id)
      .then((v) => setData({ title: v.lesson.title, slides: v.slides, theme: v.lesson.theme, minutes: v.confirmed?.params.minutes ?? v.lesson.params.minutes, pageLabels: v.pageLabels, language: (v.confirmed?.params ?? v.lesson.params).language }))
      .catch((e) => setError((e as Error).message));
  }, [id]);
  useEffect(() => {
    if (data) document.title = `演讲者视图 · ${data.title}`;
  }, [data]);
  const plannedBefore = useMemo(() => {
    let acc = 0;
    return (data?.slides ?? []).map((s) => ((acc += s.minutes), acc - s.minutes));
  }, [data]);

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <div className="page-loading dark">Loading… 加载中</div>;
  if (!data.slides.length) return <div className="card narrow">还没有生成幻灯片 · No slides yet.</div>;

  const slide = data.slides[pos.index]!;
  const next = data.slides[pos.index + 1];
  const keys = answerKey(slide.content);
  const elapsedMin = timer.elapsed / 60;
  const start = plannedBefore[pos.index] ?? 0;
  const end = start + slide.minutes;
  const pace = elapsedMin > end + 0.5 ? "behind" : elapsedMin < start - 1 ? "ahead" : "on";
  const paceText = pace === "behind" ? `落后 ${Math.round(elapsedMin - end)} 分钟 · behind` : pace === "ahead" ? `提前 ${Math.round(start - elapsedMin)} 分钟 · ahead` : "进度正常 · on time";

  return (
    <div className="presenter" data-testid="presenter">
      <header className="presenter-bar">
        <b className="presenter-title">{data.title}</b>
        <span className="presenter-clock" data-testid="presenter-timer">
          {mmss(timer.elapsed)} <span className="muted">/ {data.minutes}:00</span>
        </span>
        <span className={`presenter-pace ${pace}`}>{paceText}</span>
        <span className="muted">
          第 {pos.index + 1} / {data.slides.length} 页 · 本页建议 {slide.minutes} 分钟（{mmss(start * 60)}–{mmss(end * 60)}）
        </span>
        <span className="presenter-spacer" />
        <button className="btn small ghost dark" onClick={timer.toggle}>
          {timer.paused ? "▶ 继续 Resume" : "⏸ 暂停 Pause"}
        </button>
        <button className="btn small ghost dark" onClick={timer.reset}>
          ↺ 重新计时 Reset
        </button>
        <a className="btn small ghost dark" href={`/play/${id}`} target={`kj-audience-${id}`} data-testid="open-audience">
          观众窗口 Audience window ↗
        </a>
        <Link className="btn small ghost dark" to={`/lessons/${id}/slides`}>
          退出 Exit
        </Link>
      </header>
      <div className="presenter-grid">
        <section className="presenter-current">
          <PlayerHost slides={data.slides} theme={data.theme} pageLabels={data.pageLabels} syncId={id} onPosition={setPos} language={data.language} />
        </section>
        <aside className="presenter-side">
          <div className="presenter-next" data-testid="presenter-next">
            <h3>下一页 Next</h3>
            {next ? <SlideThumb slide={next} theme={data.theme} index={pos.index + 1} pageLabels={data.pageLabels} language={data.language} /> : <p className="muted">最后一页 · Last slide</p>}
          </div>
          <div className="presenter-notes" data-testid="presenter-notes">
            <h3>讲稿 Speaker notes</h3>
            <p>{slide.notes || "—"}</p>
          </div>
          {keys.length > 0 && (
            <div className="presenter-answers" data-testid="presenter-answers">
              <h3>答案 Answer key</h3>
              <ul>
                {keys.map((k, i) => (
                  <li key={i}>{k}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="presenter-help muted small">翻页笔 / 键盘：→ PageDown 空格 下一步 · ← PageUp 上一步 · B 黑屏 · D 画笔 · 两个窗口都可以翻页 · 投票题在下方控制栏输入各选项人数，观众窗口同步显示</p>
        </aside>
      </div>
    </div>
  );
}
