import { useEffect, useState } from "react";
import { useParams } from "react-router";
import type { Deck, ThemeTokens } from "@kj/schema";
import { api, ApiError } from "../api.ts";
import { DeckPlayer } from "../components/deck.tsx";

export function SharePage() {
  const { token = "" } = useParams();
  const [data, setData] = useState<{ title: string; deck: Deck; theme: ThemeTokens } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ title: string; deck: Deck; theme: ThemeTokens }>(`/api/share/${token}`)
      .then((d) => {
        setData(d);
        document.title = `${d.title} · AI 课件工坊`;
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Error"));
  }, [token]);
  if (error)
    return (
      <div className="page-loading dark" data-testid="share-error">
        {error}
      </div>
    );
  if (!data) return <div className="page-loading dark">Loading…</div>;
  return (
    <div className="fullscreen">
      <DeckPlayer deck={data.deck} theme={data.theme} mode="share" />
    </div>
  );
}
