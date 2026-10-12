import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import type { Deck, OutlineItem, ThemeTokens } from "@kj/schema";
import { api, ApiError } from "../api.ts";
import { SlideThumb } from "../components/deck.tsx";

interface Chapter {
  id: string;
  parentId: string | null;
  level: number;
  title: string;
  pageStart: number;
  pageEnd: number;
  wordCount: number;
  estSlides: number;
}
interface Doc {
  id: string;
  filename: string;
  status: "uploaded" | "parsing" | "ready" | "failed";
  parserId: string | null;
  pageCount: number | null;
  error: string | null;
  chapters: Chapter[];
}
interface Run {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  itemIds: string[];
  error: string | null;
}
interface ProjectView {
  project: { id: string; title: string };
  documents: Doc[];
  themes: { id: string; name: string }[];
  state: {
    scope: { documentId: string; chapterIds: string[] } | null;
    outline: { id: string; version: number; items: OutlineItem[]; confirmation: { id: string; at: number } | null } | null;
    themeLock: { themeId: string } | null;
    runs: Run[];
    deck: { version: number; slideCount: number } | null;
  };
}
interface Share {
  id: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

function useProject(id: string) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [deck, setDeck] = useState<{ deck: Deck | null; theme: ThemeTokens } | null>(null);
  const reload = useCallback(async () => {
    const [v, d] = await Promise.all([api<ProjectView>(`/api/projects/${id}`), api<{ deck: Deck | null; theme: ThemeTokens }>(`/api/projects/${id}/deck`)]);
    setView(v);
    setDeck(d);
  }, [id]);

  useEffect(() => {
    void reload();
    let ws: WebSocket | null = null;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/projects/${id}/ws`);
      ws.onmessage = () => void reload();
      ws.onclose = () => {
        if (!closed) setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [id, reload]);

  // Polling fallback while background work is pending (WebSockets can be flaky on school/China networks).
  const busy = !!view && (view.documents.some((d) => d.status === "uploaded" || d.status === "parsing") || view.state.runs.some((r) => r.status === "queued" || r.status === "running"));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void reload(), 2500);
    return () => clearInterval(t);
  }, [busy, reload]);

  return { view, deck, reload };
}

function Step({ n, title, done, children, active }: { n: number; title: string; done?: boolean; active?: boolean; children: React.ReactNode }) {
  return (
    <section className={`card step ${done ? "done" : ""} ${active ? "active" : ""}`}>
      <header>
        <span className="step-n">{done ? "✓" : n}</span>
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}

export function ProjectPage() {
  const { id = "" } = useParams();
  const { view, deck, reload } = useProject(id);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [themeId, setThemeId] = useState("classic-blue");
  const [shares, setShares] = useState<Share[]>([]);
  const [newShare, setNewShare] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const doc = view?.documents[0];
  const outline = view?.state.outline ?? null;
  const confirmed = !!outline?.confirmation;
  const themeLocked = !!view?.state.themeLock;
  const lastRun = view?.state.runs[0];
  const generating = lastRun?.status === "queued" || lastRun?.status === "running";

  useEffect(() => {
    if (view?.state.scope) setSelected(new Set(view.state.scope.chapterIds));
  }, [view?.state.scope]);

  const loadShares = useCallback(async () => {
    const r = await api<{ shares: Share[] }>(`/api/projects/${id}/shares`);
    setShares(r.shares);
  }, [id]);
  useEffect(() => {
    void loadShares();
  }, [loadShares]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message} (${e.code})` : String(e));
    }
  };

  const upload = (file: File) =>
    act(async () => {
      setUploading(true);
      try {
        await api(`/api/projects/${id}/documents`, { body: file, headers: { "content-type": "application/pdf", "x-filename": encodeURIComponent(file.name) } });
      } finally {
        setUploading(false);
      }
    });

  const tree = useMemo(() => doc?.chapters ?? [], [doc]);
  const selectedStats = tree.filter((c) => selected.has(c.id)).reduce((s, c) => ({ pages: s.pages + (c.pageEnd - c.pageStart + 1), slides: s.slides + c.estSlides, words: s.words + c.wordCount }), { pages: 0, slides: 0, words: 0 });

  if (!view) return <div className="page-loading">Loading… 加载中</div>;

  return (
    <div className="project">
      <div className="project-head">
        <div>
          <Link to="/" className="muted small">
            ← 备课列表
          </Link>
          <h1>{view.project.title}</h1>
        </div>
        <div className="row">
          {deck?.deck && deck.deck.slides.length > 0 && (
            <Link className="btn primary" to={`/play/${id}`} data-testid="play-link">
              ▶ 放映 Present
            </Link>
          )}
        </div>
      </div>
      {error && <div className="alert error">{error}</div>}

      <div className="steps">
        <Step n={1} title="上传教材 Upload textbook PDF" done={doc?.status === "ready"} active={!doc}>
          {doc ? (
            <div className="doc-status">
              <strong>{doc.filename}</strong>
              <span className={`badge ${doc.status}`} data-testid="doc-status">
                {doc.status === "ready" ? `已解析 ${doc.pageCount} 页 · ${tree.length} 个章节` : doc.status === "failed" ? `失败 ${doc.error ?? ""}` : "解析中 Parsing…"}
              </span>
              <span className="muted small">parser: {doc.parserId}</span>
            </div>
          ) : (
            <div
              className="dropzone"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f) void upload(f);
              }}
            >
              <p>{uploading ? "上传中 Uploading…" : "点击或拖拽 PDF 到这里 · Click or drop a PDF"}</p>
              <p className="muted small">带书签的电子版教材会自动生成章节树</p>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            hidden
            data-testid="pdf-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
        </Step>

        <Step n={2} title="圈选章节 Select chapters" done={!!view.state.scope} active={doc?.status === "ready" && !view.state.scope}>
          {doc?.status === "ready" ? (
            <>
              <ul className="tree">
                {tree.map((c) => (
                  <li key={c.id} style={{ paddingLeft: (c.level - 1) * 22 }}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(c.id);
                          else next.delete(c.id);
                          setSelected(next);
                        }}
                      />
                      <span className={c.level === 1 ? "tree-chapter" : ""}>{c.title}</span>
                      <span className="muted small">
                        p.{c.pageStart}–{c.pageEnd} · {c.wordCount} words · ≈{c.estSlides} 页
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="row between">
                <span className="muted small">
                  已选 {selected.size} 节 · {selectedStats.pages} 页教材 · 约 {selectedStats.slides} 页课件
                </span>
                <button
                  className="btn"
                  disabled={!selected.size}
                  onClick={() => act(() => api(`/api/projects/${id}/scope`, { method: "PUT", body: { documentId: doc.id, chapterIds: [...selected] } }))}
                >
                  生成大纲 Build outline
                </button>
              </div>
            </>
          ) : (
            <p className="muted">上传并解析教材后可圈选。</p>
          )}
        </Step>

        <Step n={3} title="确认大纲 Confirm outline（唯一强制卡点）" done={confirmed && themeLocked} active={!!outline && !(confirmed && themeLocked)}>
          {outline ? (
            <>
              <ol className="outline">
                {outline.items.map((it) => (
                  <li key={it.id}>
                    <strong>{it.title}</strong>
                    {it.pageRange && <span className="muted small"> · p.{it.pageRange[0]}–{it.pageRange[1]}</span>}
                    {it.points.length > 0 && (
                      <ul>
                        {it.points.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
              <div className="row between wrap">
                <span className={`badge ${confirmed ? "ready" : "parsing"}`} data-testid="outline-status">
                  v{outline.version} · {confirmed ? "已确认 Confirmed" : "待确认 Not confirmed"}
                </span>
                <div className="row">
                  <select value={view.state.themeLock?.themeId ?? themeId} onChange={(e) => setThemeId(e.target.value)} disabled={themeLocked}>
                    {view.themes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <button className="btn" disabled={themeLocked} onClick={() => act(() => api(`/api/projects/${id}/theme/lock`, { body: { themeId } }))}>
                    {themeLocked ? "模板已锁定 Locked" : "锁定模板 Lock theme"}
                  </button>
                  <button className="btn primary" disabled={confirmed} onClick={() => act(() => api(`/api/projects/${id}/outline/confirm`, { body: { versionId: outline.id } }))}>
                    {confirmed ? "已确认" : "确认大纲 Confirm"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="muted">圈选章节后自动生成固定大纲（AI 修订在 M1a-4）。</p>
          )}
        </Step>

        <Step n={4} title="生成页面 Generate slides" done={!!deck?.deck?.slides.length} active={confirmed && themeLocked && !deck?.deck}>
          <div className="row wrap">
            <button className="btn primary" disabled={generating || !outline} onClick={() => act(() => api(`/api/projects/${id}/generate`, { body: {} }))} data-testid="generate-one">
              生成第 1 页 Generate first slide
            </button>
            <button className="btn" disabled={generating || !outline} onClick={() => act(() => api(`/api/projects/${id}/generate`, { body: { itemIds: outline?.items.map((i) => i.id) } }))}>
              生成全部 {outline?.items.length ?? 0} 页
            </button>
            {lastRun && (
              <span className={`badge ${lastRun.status === "done" ? "ready" : lastRun.status === "failed" ? "failed" : "parsing"}`} data-testid="run-status">
                {lastRun.status} {lastRun.error ?? ""}
              </span>
            )}
          </div>
          {!confirmed && outline && <p className="muted small">大纲未确认时服务端会拒绝生成（409 OUTLINE_NOT_CONFIRMED）。</p>}
          {deck?.deck && deck.deck.slides.length > 0 && (
            <div className="grid thumbs">
              {deck.deck.slides.map((s, i) => (
                <SlideThumb key={s.id} slide={s} theme={deck.theme} label={`${i + 1}. ${outline?.items.find((x) => x.id === s.outlineItemId)?.title ?? ""}`} />
              ))}
            </div>
          )}
        </Step>

        <Step n={5} title="学生分享链接 Student share link" done={shares.some((s) => !s.revokedAt)} active={!!deck?.deck}>
          <p className="muted small">只读、免登录、不含演讲备注；可设置有效期，可随时撤销。</p>
          <div className="row">
            <button
              className="btn"
              disabled={!deck?.deck}
              data-testid="create-share"
              onClick={() =>
                act(async () => {
                  const r = await api<{ path: string }>(`/api/projects/${id}/shares`, { body: { expiresInDays: 30 } });
                  setNewShare(`${location.origin}${r.path}`);
                  await loadShares();
                })
              }
            >
              创建链接 Create link（30 天）
            </button>
          </div>
          {newShare && (
            <div className="share-new">
              <input readOnly value={newShare} data-testid="share-url" onFocus={(e) => e.target.select()} />
              <button className="btn small" onClick={() => navigator.clipboard?.writeText(newShare)}>
                复制 Copy
              </button>
              <span className="muted small">链接只显示一次 · shown once</span>
            </div>
          )}
          {shares.length > 0 && (
            <table className="table">
              <tbody>
                {shares.map((s) => (
                  <tr key={s.id}>
                    <td>{new Date(s.createdAt).toLocaleString()}</td>
                    <td>{s.expiresAt ? `expires ${new Date(s.expiresAt).toLocaleDateString()}` : "no expiry"}</td>
                    <td>{s.revokedAt ? <span className="badge failed">已撤销 revoked</span> : <span className="badge ready">active</span>}</td>
                    <td>
                      {!s.revokedAt && (
                        <button className="btn ghost small" onClick={() => act(async () => (await api(`/api/projects/${id}/shares/${s.id}`, { method: "DELETE" }), await loadShares()))}>
                          撤销 Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Step>
      </div>
    </div>
  );
}
