import { useEffect, useState } from "react";
import { lessonApi, type LessonView } from "../../lessonApi.ts";

const POLL_MS = 3000;

/**
 * Shown while the server holds the lesson's drafting lock (also after a refresh or from another tab).
 * Polls the lesson until the lock is released and hands back the fresh view.
 */
export function DraftingProgress({ lessonId, startedAt, onDone }: { lessonId: string; startedAt: number; onDone: (view: LessonView) => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    let live = true;
    const poll = setInterval(() => {
      lessonApi
        .get(lessonId)
        .then((v) => live && !v.drafting && onDone(v))
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [lessonId, onDone]);
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <div className="alert info drafting" role="status" data-testid="drafting">
      <span className="spinner" aria-hidden /> 正在生成大纲（已 {seconds} 秒，通常 30–90 秒）。可以离开这个页面，回来时会接着显示。· Drafting the outline ({seconds}s); you can leave and come back.
    </div>
  );
}
