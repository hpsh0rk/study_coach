import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api.ts";

interface ProjectRow {
  id: string;
  title: string;
  slideCount: number;
  updatedAt: number;
}

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [title, setTitle] = useState("");
  const nav = useNavigate();

  useEffect(() => {
    api<{ projects: ProjectRow[] }>("/api/projects").then((r) => setProjects(r.projects));
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    const { id } = await api<{ id: string }>("/api/projects", { body: { title } });
    nav(`/projects/${id}`);
  }

  return (
    <div className="stack">
      <section className="hero card">
        <div>
          <h1>新建备课 New lesson</h1>
          <p className="muted">上传教材 PDF → 圈选章节 → 确认大纲 → 生成页面 → 网页放映与分享</p>
        </div>
        <form className="row" onSubmit={create}>
          <input placeholder="课题，例如 Waves · 波 (Lesson 1)" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} name="title" />
          <button className="btn primary">创建 Create</button>
        </form>
      </section>
      <section>
        <h2>我的备课 My lessons</h2>
        {projects === null ? (
          <p className="muted">Loading…</p>
        ) : projects.length === 0 ? (
          <div className="card empty">还没有备课项目。No lessons yet — create one above.</div>
        ) : (
          <div className="grid cards">
            {projects.map((p) => (
              <Link key={p.id} to={`/projects/${p.id}`} className="card project-card">
                <h3>{p.title}</h3>
                <p className="muted small">
                  {p.slideCount} 页 slides · {new Date(p.updatedAt).toLocaleString()}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
