import { useEffect, useRef, useState } from "react";
import type { LessonView } from "../../lessonApi.ts";

const POLL_MS = 3000;

/**
 * Shown while the server holds the lesson's drafting lock (also after a refresh or from another tab).
 * Polls the lesson until the lock is released and hands back the fresh view, with an AbortController cancel button.
 */
export function DraftingProgress({
  lessonId,
  startedAt,
  onDone,
  onStop,
}: {
  lessonId: string;
  startedAt: number;
  onDone: (view: LessonView) => void;
  onStop?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const pollAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const ac = new AbortController();
    pollAbortRef.current = ac;
    const poll = setInterval(() => {
      if (ac.signal.aborted) return;
      fetch(`/api/lessons/${lessonId}`, { credentials: "same-origin", headers: { "x-kj-csrf": "1" }, signal: ac.signal })
        .then((r) => (r.ok ? (r.json() as Promise<LessonView>) : null))
        .then((v) => v && !ac.signal.aborted && !v.drafting && onDone(v))
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      ac.abort();
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [lessonId, onDone]);
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <div className="alert info drafting row between wrap" role="status" data-testid="drafting">
      <span className="row">
        <span className="spinner" aria-hidden /> 正在生成大纲（已 {seconds} 秒，通常 30–90 秒）。可以离开这个页面，回来时会接着显示。· Drafting the outline ({seconds}s); you can leave and come back.
      </span>
      {onStop && (
        <button
          type="button"
          className="btn small ghost"
          data-testid="stop-drafting"
          onClick={() => {
            pollAbortRef.current?.abort();
            onStop();
          }}
        >
          停止等待 Cancel
        </button>
      )}
    </div>
  );
}
