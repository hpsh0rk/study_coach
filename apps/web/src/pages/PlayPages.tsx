import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { Player, type PlayerSlide } from "@kj/player";
import type { ThemeId } from "@kj/schema";
import { api } from "../api.ts";
import { badgeOf } from "../components/SlideView.tsx";
import { documentApi, lessonApi } from "../lessonApi.ts";

function PlayerHost({
  slides,
  theme,
  showNotes,
  onSource,
  pageLabels,
}: {
  slides: PlayerSlide[];
  theme: ThemeId;
  showNotes: boolean;
  onSource?: (page: number) => void;
  pageLabels?: Record<number, string>;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || !slides.length) return;
    const p = new Player(host.current, { slides, theme, showNotes, badge: (s) => badgeOf(s.pageType), onSourceClick: onSource, pageLabels });
    return () => p.dispose();
  }, [slides, theme, showNotes, onSource, pageLabels]);
  return <div ref={host} className="player-host" data-testid="player" />;
}

export function PlayPage() {
  const { id = "" } = useParams();
  const [data, setData] = useState<{ slides: PlayerSlide[]; theme: ThemeId; documentId: string; pageLabels: Record<number, string> } | null>(null);
  const [error, setError] = useState("");
  const [source, setSource] = useState<{ no: number; text: string; label: string | null } | null>(null);
  useEffect(() => {
    lessonApi
      .get(id)
      .then((v) => setData({ slides: v.slides, theme: v.lesson.theme, documentId: v.lesson.documentId, pageLabels: v.pageLabels }))
      .catch((e) => setError((e as Error).message));
  }, [id]);
  const docId = useRef<string | null>(null);
  docId.current = data?.documentId ?? null;
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
      <Link to={`/lessons/${id}/slides`} className="play-exit">
        ← 退出放映 Exit
      </Link>
      <PlayerHost slides={data.slides} theme={data.theme} showNotes onSource={stableSource} pageLabels={data.pageLabels} />
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
      <PlayerHost slides={data.slides} theme={data.theme} showNotes={false} pageLabels={data.pageLabels} />
    </div>
  );
}
