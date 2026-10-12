import { useEffect, useRef } from "react";
import { Player } from "@kj/player";
import type { SlideContent } from "@kj/schema";
import { sampleContent } from "@kj/templates/testing";

/**
 * Player with slides citing many source pages (a poll quiz widens the control bar with vote inputs),
 * so the overflow suite can check that no source chip sits under the control bar at any window size.
 */
export function PlayerPage() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const quiz = sampleContent("quiz");
    const slides = [
      { content: (quiz.layout === "quiz" ? { ...quiz, poll: true } : quiz) as SlideContent, sources: [3, 5, 8, 12, 15, 19, 22, 27, 31, 40, 44, 52] },
      { content: sampleContent("statement"), sources: [101, 103, 105, 107, 109, 111, 113] },
      { content: sampleContent("chart"), sources: [4, 5, 6, 7, 9] },
    ].map((s) => ({ ...s, notes: "", pageType: "concept" as const }));
    const p = new Player(host.current, { slides, theme: "classic", showNotes: false, onSourceClick: () => undefined, pageLabels: { 101: "xii", 103: "xiv" } });
    void document.fonts.ready.then(() => (document.body.dataset.playerReady = "1"));
    return () => p.dispose();
  }, []);
  return <div ref={host} className="player-host" style={{ position: "fixed", inset: 0 }} data-testid="player" />;
}
