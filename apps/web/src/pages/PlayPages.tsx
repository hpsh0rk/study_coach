import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Player, presenterSync, type PlayerSlide, type Position, type PresenterSync } from "@kj/player";
import type { ThemeId } from "@kj/schema";
import { api } from "../api.ts";
import { documentApi, lessonApi } from "../lessonApi.ts";

/**
 * The slide player. With `syncId` it joins the lesson's presenter channel: the audience window
 * and the presenter window follow each other (either can be driven by a clicker), pen strokes included.
 * No page-type badge: students see it on the projector and share links, it is an editing aid.
 */
export function PlayerHost({
  slides,
  theme,
  onSource,
  pageLabels,
  syncId,
  onPosition,
  onEscape,
}: {
  slides: PlayerSlide[];
  theme: ThemeId;
  onSource?: (page: number) => void;
  pageLabels?: Record<number, string>;
  syncId?: string;
  onPosition?: (pos: Position) => void;
  onEscape?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const report = useRef(onPosition);
  const escape = useRef(onEscape);
  useEffect(() => {
    report.current = onPosition;
    escape.current = onEscape;
  }, [onPosition, onEscape]);
  useEffect(() => {
    if (!host.current || !slides.length) return;
    let sync: PresenterSync | null = null;
    const p = new Player(host.current, {
      slides,
      theme,
      showNotes: false,
      onSourceClick: onSource,
      pageLabels,
      onChange: (pos) => {
        sync?.position(pos);
        report.current?.(pos);
      },
      onBlank: (on) => sync?.blank(on),
      onTally: (index, counts) => sync?.tally(index, counts),
      onInk: (index, strokes) => sync?.ink(index, strokes),
      onEscape: () => escape.current?.(),
    });
    if (syncId)
      sync = presenterSync(syncId, {
        onPosition: (pos) => p.go(pos),
        onBlank: (on) => p.setBlank(on),
        onTally: (index, counts) => p.setTally(index, counts),
        onInk: (index, strokes) => p.setStrokes(index, strokes),
        onHello: () => sync?.position(p.position, true),
      });
    return () => {
      sync?.close();
      p.dispose();
    };
  }, [slides, theme, onSource, pageLabels, syncId]);
  return <div ref={host} className="player-host" data-testid="player" />;
}

export function openPresenter(lessonId: string) {
  window.open(`/presenter/${lessonId}`, `kj-presenter-${lessonId}`, "popup,width=1400,height=860");
}

/** Audience view for the projector: slides only, never speaker notes or the answer key. */
export function PlayPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [exit] = useState(() => () => navigate(`/lessons/${id}/slides`));
  const [data, setData] = useState<{ slides: PlayerSlide[]; theme: ThemeId; documentId: string; pageLabels: Record<number, string> } | null>(null);
  const [error, setError] = useState("");
  const [source, setSource] = useState<{ no: number; text: string; label: string | null } | null>(null);
  useEffect(() => {
    lessonApi
      .get(id)
      .then((v) => setData({ slides: v.slides.map(({ notes: _n, ...s }) => ({ ...s, notes: "" })), theme: v.lesson.theme, documentId: v.lesson.documentId, pageLabels: v.pageLabels }))
      .catch((e) => setError((e as Error).message));
  }, [id]);
  const docId = useRef<string | null>(null);
  useEffect(() => {
    docId.current = data?.documentId ?? null;
  }, [data]);
  // Stable identity so opening a source page does not rebuild the player.
  const [stableSource] = useState(() => (no: number) => {
    if (docId.current) void documentApi.page(docId.current, no).then(setSource);
  });

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <div className="page-loading dark">Loading… 加载中</div>;
  if (!data.slides.length)
    return (
      <div className="card narrow">
        还没有生成幻灯片 · No slides yet. <Link to={`/lessons/${id}/slides`}>返回 Back</Link>
      </div>
    );
  return (
    <div className="play-page">
      <div className="play-top">
        <Link to={`/lessons/${id}/slides`} className="play-exit">
          ← 退出放映 Exit
        </Link>
        <button className="play-presenter" onClick={() => openPresenter(id)} data-testid="open-presenter" title="讲稿、计时和答案在单独的窗口里，投影上看不到 · Notes, timer and answers in a separate window">
          演讲者视图 Presenter view ↗
        </button>
      </div>
      <PlayerHost slides={data.slides} theme={data.theme} onSource={stableSource} pageLabels={data.pageLabels} syncId={id} onEscape={source ? undefined : exit} />
      {source && (
        <div className="modal" onClick={() => setSource(null)}>
          <div className="modal-card card" onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h2>教材第 {source.label ?? source.no} 页 · Source page</h2>
              <button className="btn small ghost" onClick={() => setSource(null)}>
                关闭 Close
              </button>
            </div>
            <pre className="source-text">{source.text}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

export function SharePage() {
  const { token = "" } = useParams();
  const [data, setData] = useState<{ slides: PlayerSlide[]; theme: ThemeId; title: string; pageLabels: Record<number, string> } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ lesson: { title: string; theme: ThemeId; pageLabels: Record<number, string> }; slides: PlayerSlide[] }>(`/api/share/${token}`)
      .then((r) => setData({ slides: r.slides, theme: r.lesson.theme, title: r.lesson.title, pageLabels: r.lesson.pageLabels }))
      .catch((e) => setError((e as Error).message));
  }, [token]);
  if (error) return <div className="card narrow">{error}</div>;
  if (!data) return <div className="page-loading dark">Loading… 加载中</div>;
  return (
    <div className="play-page">
      <PlayerHost slides={data.slides} theme={data.theme} pageLabels={data.pageLabels} />
    </div>
  );
}
