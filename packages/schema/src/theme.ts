import { z } from "zod";

const FontPair = z.object({ latin: z.string(), ea: z.string() });

export const ThemeTokens = z.object({
  id: z.string(),
  version: z.number().int().nonnegative(),
  name: z.string(),
  color: z.object({
    primary: z.string(),
    secondary: z.string(),
    accent: z.string(),
    background: z.string(),
    surface: z.string(),
    text: z.string(),
    textMuted: z.string(),
    textOnPrimary: z.string(),
    success: z.string(),
    warning: z.string(),
    danger: z.string(),
    link: z.string(),
  }),
  font: z.object({ heading: FontPair, body: FontPair, mono: z.string() }),
  typeScale: z.object({
    title: z.number(),
    h1: z.number(),
    h2: z.number(),
    body: z.number(),
    small: z.number(),
    caption: z.number(),
    minimum: z.number(),
  }),
  lineHeight: z.object({ heading: z.number(), body: z.number() }),
  spacing: z.object({ slidePadding: z.number(), gap: z.number(), paragraphAfter: z.number() }),
  shape: z.object({ radius: z.number(), borderWidth: z.number() }),
  bilingual: z.object({
    termStyle: z.enum(["zhInParens", "zhBelowSmall", "sideNote"]),
    zhScale: z.number(),
    zhColor: z.string(),
  }),
  motion: z.object({ buildEffect: z.enum(["appear", "fade"]), transition: z.enum(["none", "fade", "push"]) }),
  layouts: z.array(z.string()),
  branding: z.object({ logoText: z.string().optional(), footer: z.string().optional(), slideNumber: z.boolean() }),
});
export type ThemeTokens = z.infer<typeof ThemeTokens>;

export const DEFAULT_THEME: ThemeTokens = {
  id: "classic-blue",
  version: 1,
  name: "Classic Blue · 经典蓝",
  color: {
    primary: "#1d4ed8",
    secondary: "#0f766e",
    accent: "#f59e0b",
    background: "#ffffff",
    surface: "#f1f5f9",
    text: "#0f172a",
    textMuted: "#475569",
    textOnPrimary: "#ffffff",
    success: "#16a34a",
    warning: "#d97706",
    danger: "#dc2626",
    link: "#2563eb",
  },
  font: {
    heading: { latin: "Arimo", ea: "Noto Sans SC" },
    body: { latin: "Arimo", ea: "Noto Sans SC" },
    mono: "ui-monospace, Menlo, monospace",
  },
  typeScale: { title: 40, h1: 32, h2: 26, body: 20, small: 16, caption: 14, minimum: 14 },
  lineHeight: { heading: 1.15, body: 1.3 },
  spacing: { slidePadding: 48, gap: 16, paragraphAfter: 6 },
  shape: { radius: 10, borderWidth: 1.5 },
  bilingual: { termStyle: "zhInParens", zhScale: 0.85, zhColor: "#0f766e" },
  motion: { buildEffect: "fade", transition: "fade" },
  layouts: ["title", "title-bullets", "title-bullets-terms", "two-column", "experiment"],
  branding: { footer: "AI 课件工坊", slideNumber: true },
};

export const BUILTIN_THEMES: Record<string, ThemeTokens> = { [DEFAULT_THEME.id]: DEFAULT_THEME };

export function getTheme(id: string): ThemeTokens | undefined {
  return BUILTIN_THEMES[id];
}
