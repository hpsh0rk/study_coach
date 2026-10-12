import type { Slide, TeachingLanguage, ThemeId } from "@kj/schema";
import { resolveEmbed } from "@kj/widgets";
import { lessonApi, type AnswerMode } from "../lessonApi.ts";
import type { OfflineDeck } from "./runtime.ts";

/** Families the slides use; KaTeX faces only when the deck has math. */
const TEXT_FAMILIES = ["Arimo", "Noto Sans SC"];
const KATEX_FACES = /^KaTeX_(Main|Math|Size1|Size2|AMS)$/;
/** Player chrome and the ASCII range are always covered. */
const ALWAYS = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~·—–‹›⛶讲稿上一步下一步全屏";

async function text(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** "U+4E00-9FFF, U+20" → [[0x4e00, 0x9fff], [0x20, 0x20]] */
function parseUnicodeRange(range: string): [number, number][] {
  return range
    .split(",")
    .map((r) => r.trim().replace(/^U\+/i, ""))
    .filter(Boolean)
    .map((r) => {
      if (r.includes("?")) return [parseInt(r.replace(/\?/g, "0"), 16), parseInt(r.replace(/\?/g, "F"), 16)] as [number, number];
      const [a, b] = r.split("-");
      return [parseInt(a!, 16), parseInt(b ?? a!, 16)] as [number, number];
    });
}

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");

/**
 * Subsets fonts the way the app serves them: of every @font-face loaded on this page, keeps only
 * the unicode-range chunks that contain a character of the deck, and inlines them as data URLs.
 */
async function inlineFontFaces(chars: Set<number>, math: boolean): Promise<{ css: string; files: number; bytes: number }> {
  const picked: { rule: CSSFontFaceRule; url: string }[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = unquote(rule.style.getPropertyValue("font-family"));
      const isText = TEXT_FAMILIES.includes(family);
      if (!isText && !(math && KATEX_FACES.test(family))) continue;
      const range = rule.style.getPropertyValue("unicode-range");
      if (isText && range && !parseUnicodeRange(range).some(([a, b]) => [...chars].some((c) => c >= a && c <= b))) continue;
      const src = rule.style.getPropertyValue("src");
      const m = /url\(\s*["']?([^"')]+\.woff2)["']?\s*\)/.exec(src);
      if (!m) continue;
      picked.push({ rule, url: new URL(m[1]!, sheet.href ?? location.href).href });
    }
  }
  let bytes = 0;
  const faces = await Promise.all(
    picked.map(async ({ rule, url }) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      bytes += buf.byteLength;
      const s = rule.style;
      const decl = [
        `font-family:"${unquote(s.getPropertyValue("font-family"))}"`,
        `font-style:${s.getPropertyValue("font-style") || "normal"}`,
        `font-weight:${s.getPropertyValue("font-weight") || "400"}`,
        "font-display:block",
        `src:url(data:font/woff2;base64,${base64(buf)}) format("woff2")`,
        s.getPropertyValue("unicode-range") ? `unicode-range:${s.getPropertyValue("unicode-range")}` : "",
      ].filter(Boolean);
      return `@font-face{${decl.join(";")}}`;
    }),
  );
  return { css: faces.join("\n"), files: faces.length, bytes };
}

const hasMath = (slides: Slide[]) => slides.some((s) => /\$[^$]+\$|"kind":"formula"/.test(JSON.stringify(s.content)));

function simIds(slides: Slide[]): string[] {
  const ids = new Set<string>();
  for (const s of slides) if (s.content.layout === "experiment" && s.content.sim.kind === "sim") ids.add(s.content.sim.embedId);
  return [...ids];
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

interface OfflineFile {
  html: string;
  filename: string;
  fontFiles: number;
}

export type OfflineAudience = "teacher" | "student";

/**
 * One self-contained HTML file: deck + player runtime + catalog sims + the font chunks it needs. No network at all when opened.
 * `student`: the server strips notes and misconception labels (as for the share link), and answers unless `answers` is `shown`. `teacher`: notes open only in a separate presenter window.
 */
async function buildOfflineHtml(lessonId: string, audience: OfflineAudience, answers: AnswerMode): Promise<OfflineFile> {
  const deck = (await lessonApi.deck(lessonId, audience, answers)) as unknown as {
    lesson: { title: string; theme: ThemeId; pageLabels: Record<number, string>; language: TeachingLanguage; answers: AnswerMode };
    slides: Slide[];
  };
  const [js, css] = await Promise.all([text("/offline/runtime.js"), text("/offline/runtime.css")]);
  const sims: Record<string, string> = {};
  for (const id of simIds(deck.slides)) {
    const entry = resolveEmbed(id);
    if (entry) sims[id] = await text(entry.src);
  }
  const data: OfflineDeck = {
    title: deck.lesson.title,
    audience,
    answers: deck.lesson.answers,
    theme: deck.lesson.theme,
    language: deck.lesson.language,
    pageLabels: deck.lesson.pageLabels,
    slides: deck.slides.map((s) => ({ content: s.content, sources: s.sources, notes: audience === "student" ? "" : s.notes, pageType: s.pageType })),
    sims,
  };
  const json = JSON.stringify(data);
  const chars = new Set<number>();
  for (const ch of json + ALWAYS) chars.add(ch.codePointAt(0)!);
  const fonts = await inlineFontFaces(chars, hasMath(deck.slides));
  const html = [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="AI 课件工坊 offline export">`,
    `<title>${escapeHtml(deck.lesson.title)}</title>`,
    `<style>${fonts.css}</style>`,
    `<style>${css}</style>`,
    "</head><body>",
    '<div id="kj-root"></div>',
    `<script type="application/json" id="kj-deck">${json.replace(/</g, "\\u003c")}</script>`,
    `<script>${js.replace(/<\/script/gi, "<\\/script")}</script>`,
    "</body></html>",
  ].join("\n");
  // Dots go too: "… · 4.1 Force" would otherwise end in a fake ".1 Force" extension.
  const base = deck.lesson.title.replace(/[\\/:*?"<>|.]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "lesson";
  return { html, filename: `${base}${audience === "student" ? (deck.lesson.answers === "hidden" ? "（学生版·预习）" : "（学生版·复习）") : ""}.html`, fontFiles: fonts.files };
}

export async function downloadOfflineHtml(lessonId: string, audience: OfflineAudience = "teacher", answers: AnswerMode = "hidden"): Promise<OfflineFile> {
  const file = await buildOfflineHtml(lessonId, audience, answers);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([file.html], { type: "text/html;charset=utf-8" }));
  a.download = file.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return file;
}
