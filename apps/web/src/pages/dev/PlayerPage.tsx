import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { Player } from "@kj/player";
import type { SlideContent, ThemeId } from "@kj/schema";
import { sampleContent } from "@kj/templates/testing";
import { CLASSROOM_FIXTURES } from "@kj/templates/testing/classroom";
import { measureOverflow, minBodyFontPx } from "@kj/templates/render";

declare global {
  interface Window {
    /** Current fixture-player geometry, using the same overflow helpers as the gallery. */
    kjPlayerMeasure?: () => {
      overflow: string[];
      minFont: number;
      hidden: number;
      clipped: string[];
      sourcesUnderControls: string[];
      deviceScaleFactor: number;
    };
  }
}

/**
 * Player with slides citing many source pages (a poll quiz widens the control bar with vote inputs),
 * so the overflow suite can check that no source chip sits under the control bar at any window size.
 */
export function PlayerPage() {
  const host = useRef<HTMLDivElement>(null);
  const [q] = useSearchParams();
  const fixtureId = q.get("fixture");
  const theme: ThemeId = q.get("theme") === "chalk" ? "chalk" : "classic";
  useEffect(() => {
    if (!host.current) return;
    document.body.dataset.playerReady = "0";
    const fixture = CLASSROOM_FIXTURES.find((item) => item.id === fixtureId);
    const quiz = sampleContent("quiz");
    const slides = fixture
      ? fixture.slides.map((slide) => ({ content: slide.content, sources: slide.sources, notes: slide.notes, pageType: slide.pageType }))
      : [
          { content: (quiz.layout === "quiz" ? { ...quiz, poll: true } : quiz) as SlideContent, sources: [3, 5, 8, 12, 15, 19, 22, 27, 31, 40, 44, 52] },
          { content: sampleContent("statement"), sources: [101, 103, 105, 107, 109, 111, 113] },
          { content: sampleContent("chart"), sources: [4, 5, 6, 7, 9] },
        ].map((s) => ({ ...s, notes: "", pageType: "concept" as const }));
    const p = new Player(host.current, {
      slides,
      theme,
      showNotes: false,
      onSourceClick: () => undefined,
      pageLabels: fixture ? undefined : { 101: "xii", 103: "xiv" },
      language: fixture?.params.language,
    });
    window.kjPlayerMeasure = () => {
      const slide = host.current!.querySelector<HTMLElement>(".kj-slide")!;
      const controls = host.current!.querySelector<HTMLElement>(".kj-controls")!.getBoundingClientRect();
      const sources = [...slide.querySelectorAll<HTMLElement>(".kj-source")].filter((source) => !source.hidden);
      return {
        overflow: measureOverflow(slide),
        minFont: minBodyFontPx(slide),
        hidden: slide.querySelectorAll(".kj-step-hidden").length,
        clipped: [...slide.querySelectorAll<HTMLElement>("[data-clip]")].filter((node) => node.scrollHeight > node.clientHeight + 1).map((node) => node.textContent ?? ""),
        sourcesUnderControls: sources
          .filter((source) => {
            const rect = source.getBoundingClientRect();
            return rect.right > controls.left && rect.bottom > controls.top && rect.top < controls.bottom;
          })
          .map((source) => source.textContent ?? ""),
        deviceScaleFactor: devicePixelRatio,
      };
    };
    void document.fonts.ready.then(() => {
      document.body.dataset.playerReady = "1";
    });
    return () => {
      delete window.kjPlayerMeasure;
      p.dispose();
    };
  }, [fixtureId, theme]);
  return <div ref={host} className="player-host" style={{ position: "fixed", inset: 0 }} data-testid="player" />;
}
