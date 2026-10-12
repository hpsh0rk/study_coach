import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { Deck, ThemeTokens } from "@kj/schema";
import { api } from "../api.ts";
import { DeckPlayer, DeckSpeaker } from "../components/deck.tsx";

function useDeck(id: string) {
  const [data, setData] = useState<{ deck: Deck | null; theme: ThemeTokens } | null>(null);
  useEffect(() => {
    api<{ deck: Deck | null; theme: ThemeTokens }>(`/api/projects/${id}/deck`).then(setData);
  }, [id]);
  return data;
}

export function PlayPage() {
  const { id = "" } = useParams();
  const data = useDeck(id);
  if (!data) return <div className="page-loading dark">Loading…</div>;
  if (!data.deck) return <div className="page-loading dark">还没有页面 · <Link to={`/projects/${id}`}>返回</Link></div>;
  return (
    <div className="fullscreen">
      <DeckPlayer deck={data.deck} theme={data.theme} mode="present" syncKey={id} speakerUrl={`/speaker/${id}`} />
      <Link className="exit-link" to={`/projects/${id}`}>
        ✕
      </Link>
    </div>
  );
}

export function SpeakerPage() {
  const { id = "" } = useParams();
  const data = useDeck(id);
  if (!data?.deck) return <div className="page-loading dark">Loading…</div>;
  return (
    <div className="fullscreen">
      <DeckSpeaker deck={data.deck} theme={data.theme} syncKey={id} />
    </div>
  );
}
