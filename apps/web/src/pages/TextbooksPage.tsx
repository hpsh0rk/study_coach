import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError } from "../api.ts";
import { documentApi, type LibraryRow } from "../textbook/api.ts";

function status(r: LibraryRow): { text: string; tone: "ready" | "warn" | "parsing" } {
  if (r.pagesReceived < r.pageCount) return { text: `上传未完成 ${r.pagesReceived} / ${r.pageCount} 页`, tone: "parsing" };
  if (r.flaggedPages > 0) return { text: `${r.flaggedPages} 页还没读好`, tone: "warn" };
  return { text: "已读好", tone: "ready" };
}

/** 教材管理: every uploaded PDF, to rename, archive, delete when unused, and open its pages to re-read or start a lesson. */
export function TextbooksPage() {
  const nav = useNavigate();
  const [rows, setRows] = useState<LibraryRow[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => setRows((await documentApi.library()).textbooks), []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
      if (done) setNotice(done);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  if (!rows) return <p className="muted">Loading…</p>;
  const visible = rows.filter((r) => showArchived || r.archivedAt === null);
  const archivedCount = rows.filter((r) => r.archivedAt !== null).length;

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <h1>教材管理 Textbooks</h1>
          <p className="muted">上传过的 PDF 都在这里：改名、归档、查看每页读出来的文字，或直接拿来备一节新课，不用再上传。· Your uploaded PDFs.</p>
        </div>
        <Link to="/new" className="btn primary" data-testid="library-upload">
          ＋ 上传新教材 Upload
        </Link>
      </div>
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}
      <div className="card">
        <div className="row between">
          <h2>我的教材 · {visible.length}</h2>
          <label className="inline-check small muted">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} data-testid="show-archived" />
            显示已归档（{archivedCount}）
          </label>
        </div>
        {visible.length === 0 ? (
          <p className="muted" data-testid="library-empty">
            还没有教材。<Link to="/new">上传一份 PDF</Link> 开始。
          </p>
        ) : (
          <table className="table library-table">
            <thead>
              <tr>
                <th>书名 Title</th>
                <th>页数</th>
                <th>读取情况</th>
                <th>用它做的课</th>
                <th>上传时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const s = status(r);
                const archived = r.archivedAt !== null;
                return (
                  <tr key={r.id} data-testid="library-row" data-id={r.id} className={archived ? "muted" : ""}>
                    <td>
                      {editing?.id === r.id ? (
                        <form
                          className="row"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void run(async () => {
                              await documentApi.rename(r.id, editing.title);
                              setEditing(null);
                            }, "已改名 · Renamed");
                          }}
                        >
                          <input value={editing.title} onChange={(e) => setEditing({ id: r.id, title: e.target.value })} required maxLength={300} autoFocus data-testid="library-title-input" />
                          <button className="btn small primary" data-testid="library-rename-save">
                            保存
                          </button>
                          <button type="button" className="btn small ghost" onClick={() => setEditing(null)}>
                            取消
                          </button>
                        </form>
                      ) : (
                        <>
                          <strong data-testid="library-title">{r.title}</strong> {archived && <span className="badge">已归档</span>}
                          <div className="muted small">{r.filename}</div>
                        </>
                      )}
                    </td>
                    <td>{r.pageCount} 页</td>
                    <td>
                      <span className={`badge ${s.tone}`} data-testid="library-status">
                        {s.text}
                      </span>
                    </td>
                    <td data-testid="library-lessons">{r.lessons > 0 ? `${r.lessons} 节` : "—"}</td>
                    <td className="muted small">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="row end">
                      {!archived && r.pagesReceived === r.pageCount && (
                        <button className="btn small" onClick={() => nav(`/new/${r.id}`)} data-testid="library-open" title="查看每页读出来的文字，重新读没读好的页，或选章节备一节新课">
                          查看页面 / 备课
                        </button>
                      )}
                      <button className="btn small ghost" onClick={() => setEditing({ id: r.id, title: r.title })} data-testid="library-rename">
                        改名
                      </button>
                      {archived ? (
                        <button className="btn small ghost" onClick={() => run(() => documentApi.restore(r.id), `已恢复“${r.title}” · Restored`)} data-testid="library-restore">
                          恢复
                        </button>
                      ) : (
                        <button
                          className="btn small ghost"
                          onClick={() => run(() => documentApi.archive(r.id), `已归档“${r.title}”：不再出现在备课列表里，用它做好的课照常可用。· Archived`)}
                          data-testid="library-archive"
                        >
                          归档
                        </button>
                      )}
                      <button
                        className="btn small ghost danger-text"
                        disabled={r.lessonsAll > 0}
                        title={r.lessonsAll > 0 ? `还有 ${r.lessonsAll} 节课用它（包括已删除的课），不能彻底删除，可以归档` : "彻底删除这份教材的文字和章节"}
                        onClick={() => {
                          if (window.confirm(`彻底删除“${r.title}”？读出来的文字和章节都会删掉，不能撤销。· Delete for good?`)) void run(() => documentApi.purge(r.id), `已彻底删除“${r.title}” · Deleted`);
                        }}
                        data-testid="library-purge"
                      >
                        彻底删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
