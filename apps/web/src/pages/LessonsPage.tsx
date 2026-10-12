import { useEffect, useState } from "react";
import { Link } from "react-router";
import { lessonApi, type LessonListItem } from "../lessonApi.ts";

const STATUS: Record<LessonListItem["status"], { label: string; step: string }> = {
  scoped: { label: "待设置 Settings", step: "settings" },
  outline: { label: "大纲草稿 Outline draft", step: "outline" },
  confirmed: { label: "待生成 Ready to generate", step: "slides" },
  slides: { label: "可放映 Ready", step: "slides" },
};

export function LessonsPage() {
  const [lessons, setLessons] = useState<LessonListItem[] | null>(null);
  useEffect(() => {
    lessonApi
      .list()
      .then((r) => setLessons(r.lessons))
      .catch(() => setLessons([]));
  }, []);
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
        <ul className="lesson-grid">
          {lessons.map((l) => (
            <li key={l.id} className="card lesson-card">
              <Link to={`/lessons/${l.id}/${STATUS[l.status].step}`}>
                <h3>{l.title}</h3>
                <p className="muted small">
                  {l.params.minutes} 分钟 · {l.status === "slides" ? `${l.slides}/${l.planned} 页` : STATUS[l.status].label}
                </p>
                <span className={`badge ${l.status}`}>{STATUS[l.status].label}</span>
              </Link>
              {l.status === "slides" && (
                <Link to={`/play/${l.id}`} className="btn small">
                  ▶ 放映
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
