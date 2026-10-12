/**
 * Experiment sources are swappable (owner decision: PhET now, AI-generated sims later).
 * Decks only store provider + componentId + params, never URLs.
 */

export interface ExperimentParams {
  componentId: string;
  locale: "en" | "zh_CN";
  initial?: Record<string, string | number>;
}

export type SimCapability = "locale" | "setState" | "getState";

export interface ResolvedExperiment {
  /** Path under our own origin (or the isolated sim subdomain in production). */
  src: string;
  capabilities: SimCapability[];
  attribution?: string;
}

export interface ExperimentProvider {
  id: "phet" | "ai_sim" | "url";
  resolve(params: ExperimentParams): ResolvedExperiment | null;
}

/** kj-sim postMessage protocol; PhET implements only `ready`/`reset` via reload. */
export type KjSimMessage =
  | { kjSim: 1; type: "init"; params: ExperimentParams }
  | { kjSim: 1; type: "ready" }
  | { kjSim: 1; type: "reset" }
  | { kjSim: 1; type: "getState" }
  | { kjSim: 1; type: "state"; state: unknown }
  | { kjSim: 1; type: "setState"; state: unknown }
  | { kjSim: 1; type: "resize"; width: number; height: number };

export const PHET_ATTRIBUTION = "PhET Interactive Simulations, University of Colorado Boulder (CC BY 4.0)";

export interface PhetComponent {
  id: string;
  title: { en: string; zh: string };
  /** File stem on phet.colorado.edu, e.g. wave-on-a-string -> wave-on-a-string_en.html */
  slug: string;
  locales: ("en" | "zh_CN")[];
  topics: string[];
}

export const PHET_CATALOG: PhetComponent[] = [
  { id: "wave-on-a-string", slug: "wave-on-a-string", title: { en: "Wave on a String", zh: "弦上的波" }, locales: ["en", "zh_CN"], topics: ["waves", "frequency", "amplitude", "tension", "damping"] },
  { id: "waves-intro", slug: "waves-intro", title: { en: "Waves Intro", zh: "波的介绍" }, locales: ["en", "zh_CN"], topics: ["waves", "sound", "light", "water"] },
  { id: "bending-light", slug: "bending-light", title: { en: "Bending Light", zh: "光的折射" }, locales: ["en", "zh_CN"], topics: ["refraction", "reflection", "light"] },
];

export function phetFileName(c: PhetComponent, locale: "en" | "zh_CN"): string {
  return `${c.slug}_${locale}.html`;
}

export function phetR2Key(c: PhetComponent, locale: "en" | "zh_CN"): string {
  return `sims/phet/${c.id}/${phetFileName(c, locale)}`;
}

export function createPhetProvider(simBase = "/sim"): ExperimentProvider {
  return {
    id: "phet",
    resolve(params) {
      const c = PHET_CATALOG.find((x) => x.id === params.componentId);
      if (!c) return null;
      const locale = c.locales.includes(params.locale) ? params.locale : "en";
      return { src: `${simBase}/phet/${c.id}?locale=${locale}`, capabilities: ["locale"], attribution: PHET_ATTRIBUTION };
    },
  };
}

export function createExperimentRegistry(providers: ExperimentProvider[]) {
  const byId = new Map(providers.map((p) => [p.id, p]));
  return {
    resolve(provider: string, params: ExperimentParams): ResolvedExperiment | null {
      return byId.get(provider as ExperimentProvider["id"])?.resolve(params) ?? null;
    },
  };
}
