import { useEffect, useRef } from "react";
import { createPhetProvider, createExperimentRegistry } from "@kj/experiments";
import { Player, renderScaled, SpeakerView, type Position } from "@kj/player";
import type { Deck, Slide, ThemeTokens } from "@kj/schema";

const experiments = createExperimentRegistry([createPhetProvider("/sim")]);

export function resolveExperiment(t: { provider: string; componentId: string; locale: string }): string | null {
  return experiments.resolve(t.provider, { componentId: t.componentId, locale: t.locale === "zh_CN" ? "zh_CN" : "en" })?.src ?? null;
}

export function makeAssetResolver(map: Record<string, string> = {}) {
  return (assetId: string) => map[assetId] ?? `/api/assets/${assetId}`;
}

export function DeckPlayer(props: {
  deck: Deck;
  theme: ThemeTokens;
  mode: "present" | "share";
  assets?: Record<string, string>;
  syncKey?: string;
  speakerUrl?: string;
  start?: Position;
  onChange?(pos: Position): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { deck, theme, mode, assets, syncKey, speakerUrl, start, onChange } = props;
  useEffect(() => {
    if (!ref.current) return;
    const player = new Player(ref.current, {
      deck,
      theme,
      mode,
      resolveAsset: makeAssetResolver(assets),
      resolveExperiment,
      ...(start ? { start } : {}),
      ...(syncKey ? { syncKey } : {}),
      ...(onChange ? { onChange } : {}),
      ...(speakerUrl ? { onOpenSpeaker: () => window.open(speakerUrl, "kj-speaker", "width=1200,height=760") } : {}),
    });
    player.root.focus();
    (window as unknown as { __kjPlayer?: Player }).__kjPlayer = player;
    return () => player.destroy();
    // Rebuilt only when the deck itself changes; callbacks and start position are read once.
  }, [deck, theme, mode]);
  return <div className="deck-player" ref={ref} data-testid="deck-player" />;
}

export function DeckSpeaker(props: { deck: Deck; theme: ThemeTokens; assets?: Record<string, string>; syncKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const view = new SpeakerView(ref.current, { deck: props.deck, theme: props.theme, resolveAsset: makeAssetResolver(props.assets), syncKey: props.syncKey });
    return () => view.destroy();
  }, [props.deck, props.theme, props.assets, props.syncKey]);
  return <div className="deck-speaker" ref={ref} />;
}

export function SlideThumb(props: { slide: Slide; theme: ThemeTokens; assets?: Record<string, string>; onClick?(): void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) renderScaled(ref.current, props.slide, { theme: props.theme, mode: "thumbnail", resolveAsset: makeAssetResolver(props.assets) });
  }, [props.slide, props.theme, props.assets]);
  return (
    <figure className="slide-thumb" onClick={props.onClick}>
      <div ref={ref} />
      {props.label && <figcaption>{props.label}</figcaption>}
    </figure>
  );
}
