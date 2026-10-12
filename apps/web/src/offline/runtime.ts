import "katex/dist/katex.min.css";
import "@kj/templates/slides.css";
import "@kj/player/player.css";
import "./runtime.css";
import { Player, type PlayerSlide } from "@kj/player";
import type { ThemeId } from "@kj/schema";
import { inlineEmbeds } from "@kj/widgets/render";

/** Deck data embedded in an offline file by `buildOfflineHtml`. */
export interface OfflineDeck {
  title: string;
  theme: ThemeId;
  pageLabels: Record<number, string>;
  slides: (PlayerSlide & { badge: string })[];
  /** Catalog simulation HTML by embed id, loaded via srcdoc. */
  sims: Record<string, string>;
}

const deck = JSON.parse(document.getElementById("kj-deck")!.textContent!) as OfflineDeck;
inlineEmbeds(deck.sims);
document.title = deck.title;
new Player(document.getElementById("kj-root")!, {
  slides: deck.slides,
  theme: deck.theme,
  showNotes: true,
  badge: (s) => (s as OfflineDeck["slides"][number]).badge,
  pageLabels: deck.pageLabels,
});
void document.fonts.ready.then(() => (document.body.dataset.ready = "1"));
