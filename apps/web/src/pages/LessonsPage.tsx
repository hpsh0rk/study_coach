import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { lessonApi, type LessonListItem } from "../lessonApi.ts";

const STATUS: Record<LessonListItem["status"], { label: string; step: string }> = {
  scoped: { label: "待设置 Settings", step: "settings" },
  outline: { label: "大纲草稿 Outline draft", step: "outline" },
  confirmed: { label: "待生成 Ready to generate", step: "slides" },
  slides: { label: "可放映 Ready", step: "slides" },
};

/** Lessons of one unit sit together (in lesson order) where the unit's first lesson appears; other lessons share grids. */
function grouped(lessons: LessonListItem[]): { unit: LessonListItem["unit"]; lessons: LessonListItem[] }[] {
  const out: { unit: LessonListItem["unit"]; lessons: LessonListItem[] }[] = [];
  const byUnit = new Map<string, LessonListItem[]>();
  for (const l of lessons) {
    if (!l.unit) {
      const last = out[out.length - 1];
      if (last && !last.unit) last.lessons.push(l);
      else out.push({ unit: null, lessons: [l] });
      continue;
    }
    const list = byUnit.get(l.unit.id);
    if (list) list.push(l);
    else {
      const fresh = [l];
      byUnit.set(l.unit.id, fresh);
      out.push({ unit: l.unit, lessons: fresh });
    }
  }
  for (const g of out) g.lessons.sort((a, b) => (a.unit?.index ?? 0) - (b.unit?.index ?? 0));
  return out;
}

function LessonCard({ l, onDuplicate, onDelete, busy }: { l: LessonListItem; onDuplicate: () => void; onDelete: () => void; busy: boolean }) {
  return (
    <li className="card lesson-card" data-testid="lesson-card">
      <Link to={`/lessons/${l.id}/${STATUS[l.status].step}`}>
        <h3>{l.title}</h3>
        <p className="muted small">
          {l.params.minutes} 分钟 · {l.status === "slides" ? `${l.slides}/${l.planned} 页` : STATUS[l.status].label}
        </p>
        <span className={`badge ${l.status}`}>{STATUS[l.status].label}</span>
      </Link>
      <div className="row">
        {l.status === "slides" && (
          <Link to={`/play/${l.id}`} className="btn small">
            ▶ 放映
          </Link>
        )}
        {l.status !== "scoped" && (
          <button
            className="btn small ghost"
            disabled={busy}
            onClick={onDuplicate}
            data-testid={`duplicate-${l.id}`}
            title="复制大纲和全部幻灯片（含你的修改），再按新学期改动；没改的页不会重新生成 · Copy outline and slides, then revise"
          >
            ⧉ 复制到新学期
          </button>
        )}
        <button className="btn small ghost danger-text" disabled={busy} onClick={onDelete} data-testid={`delete-${l.id}`} title="删除这节课；分享链接立即失效，可以撤销 · Delete (undo available)">
          删除 Delete
        </button>
      </div>
    </li>
  );
}

export function LessonsPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [lessons, setLessons] = useState<LessonListItem[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [deleted, setDeleted] = useState<LessonListItem | null>(null);
  const reload = () =>
    lessonApi
      .list()
      .then((r) => setLessons(r.lessons))
      .catch(() => setLessons([]));
  useEffect(() => {
    void reload();
  }, []);
  async function remove(l: LessonListItem) {
    if (!window.confirm(`删除“${l.title}”？分享出去的链接会立即失效。· Delete this lesson? Its share link stops working.`)) return;
    setBusy(l.id);
    setError("");
    try {
      await lessonApi.archive(l.id);
      setDeleted(l);
      setLessons((list) => list?.filter((x) => x.id !== l.id) ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function undo() {
    if (!deleted) return;
    setError("");
    try {
      await lessonApi.restore(deleted.id);
      setDeleted(null);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function duplicate(id: string) {
    setBusy(id);
    setError("");
    try {
      const copy = await lessonApi.duplicate(id);
      nav(`/lessons/${copy.lesson.id}/outline?copied=1`);
    } catch (e) {
      setError((e as Error).message);
      setBusy("");
    }
  }
  const newUnit = params.get("unit");
  return (
    <div className="lessons-page">
      <div className="row between">
        <div>
          <h1>我的课 · My lessons</h1>
          <p className="muted">上传教材 PDF → 选章节 → 设课时 → 确认大纲 → 生成并放映。· Five steps from textbook to slides.</p>
        </div>
        <Link to="/new" className="btn primary" data-testid="new-lesson">
          ＋ 新建一节课 New lesson
        </Link>
      </div>
      {error && <div className="alert error">{error}</div>}
      {deleted && (
        <div className="alert info row between" data-testid="deleted-note">
          <span>已删除“{deleted.title}”，分享链接已失效。· Deleted; the share link no longer works.</span>
          <button className="btn small" onClick={undo} data-testid="undo-delete">
            撤销 Undo
          </button>
        </div>
      )}
      {lessons === null ? (
        <div className="page-loading">Loading… 加载中</div>
      ) : lessons.length === 0 ? (
        <div className="card empty">
          <div className="empty-icon">📚</div>
          <h2>还没有课 · No lessons yet</h2>
          <p className="muted">从一份电子版教材 PDF 开始，大约 5 分钟得到一套可以直接上课的幻灯片。</p>
          <Link to="/new" className="btn primary">
            开始第一节课 Start
          </Link>
        </div>
      ) : (
        grouped(lessons).map((g) =>
          g.unit ? (
            <section key={g.unit.id} className={`unit-group ${newUnit === g.unit.id ? "fresh" : ""}`} data-testid="unit-group">
              <h2 className="unit-title">
                单元 Unit：{g.unit.title} <span className="muted small">· {g.unit.count} 节课，按顺序逐节确认大纲 · plan each lesson in turn</span>
              </h2>
              <ul className="lesson-grid">
                {g.lessons.map((l) => (
                  <LessonCard key={l.id} l={l} busy={!!busy} onDuplicate={() => duplicate(l.id)} onDelete={() => remove(l)} />
                ))}
              </ul>
            </section>
          ) : (
            <ul key={g.lessons[0]!.id} className="lesson-grid">
              {g.lessons.map((l) => (
                <LessonCard key={l.id} l={l} busy={!!busy} onDuplicate={() => duplicate(l.id)} onDelete={() => remove(l)} />
              ))}
            </ul>
          ),
        )
      )}
    </div>
  );
}
