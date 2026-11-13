import type { ImageItem, PptxDeck, PptxExport, PptxFontScale } from "@kj/pptx";
import type { Slide, TeachingLanguage, ThemeId } from "@kj/schema";
import { renderWidget } from "@kj/widgets/render";
import { lessonApi } from "../lessonApi.ts";

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function parseRangeBounds(range: string): [number, number][] {
  return range
    .split(",")
    .map((r) => r.trim().replace(/^U\+/i, ""))
    .filter(Boolean)
    .map((r) => {
      if (r.includes("?")) return [parseInt(r.replace(/\?/g, "0"), 16), parseInt(r.replace(/\?/g, "F"), 16)];
      const [a, b] = r.split("-");
      return [parseInt(a!, 16), parseInt(b ?? a!, 16)];
    });
}

const fontBytesCache = new Map<string, Promise<string | null>>();
function fetchFontBase64(url: string): Promise<string | null> {
  let hit = fontBytesCache.get(url);
  if (!hit) {
    hit = fetch(url)
      .then(async (r) => (r.ok ? arrayBufferToBase64(await r.arrayBuffer()) : null))
      .catch(() => null);
    fontBytesCache.set(url, hit);
  }
  return hit;
}

async function formulaFontCss(tex: string): Promise<string> {
  const codePoints = new Set<number>();
  for (const ch of tex) codePoints.add(ch.codePointAt(0)!);
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
      const family = rule.style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, "");
      const isKatex = /^KaTeX_(Main|Math|Size[1-4]|AMS)$/i.test(family);
      const isText = family === "Noto Sans SC" || family === "Arimo";
      if (!isKatex && !isText) continue;
      const uRange = rule.style.getPropertyValue("unicode-range");
      if (isText && uRange && !parseRangeBounds(uRange).some(([a, b]) => [...codePoints].some((c) => c >= a && c <= b))) continue;
      const m = /url\(\s*["']?([^"')]+\.woff2)["']?\s*\)/.exec(rule.style.getPropertyValue("src"));
      if (m) picked.push({ rule, url: new URL(m[1]!, sheet.href ?? location.href).href });
    }
  }
  const faces = await Promise.all(
    picked.map(async ({ rule, url }) => {
      const b64 = await fetchFontBase64(url);
      if (!b64) return "";
      const s = rule.style;
      const family = s.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, "");
      const uRange = s.getPropertyValue("unicode-range");
      return `@font-face{font-family:"${family}";font-style:${s.getPropertyValue("font-style") || "normal"};font-weight:${s.getPropertyValue("font-weight") || "400"};src:url(data:font/woff2;base64,${b64}) format("woff2")${uRange ? `;unicode-range:${uRange}` : ""}}`;
    }),
  );
  return faces.filter(Boolean).join("\n");
}

function inlineDomStyles(srcNode: Element, dstNode: Element): void {
  const cs = getComputedStyle(srcNode);
  if (srcNode instanceof HTMLElement && dstNode instanceof HTMLElement) {
    let cssText = "";
    for (let i = 0; i < cs.length; i++) {
      const prop = cs[i]!;
      cssText += `${prop}:${cs.getPropertyValue(prop)};`;
    }
    dstNode.setAttribute("style", cssText);
  } else if (srcNode instanceof SVGElement && dstNode instanceof SVGElement) {
    const color = cs.getPropertyValue("color");
    const width = cs.getPropertyValue("width");
    const height = cs.getPropertyValue("height");
    dstNode.setAttribute("style", `color:${color};fill:currentColor;width:${width};height:${height};`);
  }
  for (let i = 0; i < srcNode.children.length; i++) {
    inlineDomStyles(srcNode.children[i]!, dstNode.children[i]!);
  }
}

async function svgMarkupTo2xPng(svgMarkup: string, width: number, height: number): Promise<string> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width * 2;
  canvas.height = height * 2;
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

async function fetchFigurePngDataUrl(assetId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/media/${encodeURIComponent(assetId)}`, { credentials: "same-origin" });
    if (!res.ok) return null;
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    const buf = await res.arrayBuffer();
    if (mime === "image/png" || mime === "image/jpeg") {
      return `data:${mime};base64,${arrayBufferToBase64(buf)}`;
    }
    // Convert WebP (or any browser-decodable raster) to PNG so PowerPoint / Keynote / LibreOffice open it universally.
    const blobUrl = URL.createObjectURL(new Blob([buf], { type: mime }));
    try {
      const img = new Image();
      img.src = blobUrl;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, img.naturalWidth || img.width);
      canvas.height = Math.max(1, img.naturalHeight || img.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  } catch {
    return null;
  }
}

/** 2× PNG snapshot for ECharts plots, non-exact KaTeX display formula cards, and native PNG data URLs for extracted textbook figures. */
function chartSnapshot(theme: ThemeId) {
  const figureCache = new Map<string, Promise<string | null>>();
  return async (item: ImageItem): Promise<string | null> => {
    if (item.spec.kind === "figure") {
      let hit = figureCache.get(item.spec.assetId);
      if (!hit) {
        hit = fetchFigurePngDataUrl(item.spec.assetId);
        figureCache.set(item.spec.assetId, hit);
      }
      return hit;
    }
    const frame = document.createElement("div");
    frame.className = `kj-slide kj-theme-${theme}`;
    Object.assign(frame.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      width: `${item.rect.w}px`,
      height: `${item.rect.h}px`,
      padding: "0",
      display: "block",
      background: "transparent",
    });
    const host = document.createElement("div");
    Object.assign(host.style, { width: "100%", height: "100%" });
    frame.append(host);
    document.body.append(frame);
    const widgetSpec = item.spec.kind === "formula" ? { kind: "formula" as const, tex: item.spec.tex } : item.spec;
    const handle = renderWidget(widgetSpec, host, { interactive: false });
    try {
      await (document.fonts?.ready ?? Promise.resolve());
      await nextFrame();
      await nextFrame();
      if (item.spec.kind === "formula") {
        Object.assign(host.style, {
          boxSizing: "border-box",
          borderRadius: "28px",
          border: "3px solid var(--kj-panel-line)",
          background: "var(--kj-panel)",
          color: "var(--kj-text)",
          padding: "20px 28px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        });
        const texEl = host.querySelector<HTMLElement>(".kj-formula-tex");
        if (texEl) {
          let fontPx = 88;
          texEl.style.fontSize = `${fontPx}px`;
          while (fontPx > 32 && (texEl.scrollWidth > host.clientWidth - 56 || texEl.scrollHeight > host.clientHeight - 40)) {
            fontPx -= 2;
            texEl.style.fontSize = `${fontPx}px`;
          }
        }
        const clone = host.cloneNode(true) as HTMLElement;
        inlineDomStyles(host, clone);
        clone.querySelectorAll(".katex-mathml").forEach((n) => n.remove());
        clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
        const fontCss = await formulaFontCss(item.spec.tex);
        const svgMarkup =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${item.rect.w}" height="${item.rect.h}">` +
          (fontCss ? `<defs><style>${fontCss}</style></defs>` : "") +
          `<foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(clone)}</foreignObject>` +
          `</svg>`;
        return await svgMarkupTo2xPng(svgMarkup, item.rect.w, item.rect.h);
      }
      const svg = host.querySelector("svg");
      if (!svg) return null;
      return await svgMarkupTo2xPng(new XMLSerializer().serializeToString(svg), item.rect.w, item.rect.h);
    } catch {
      return null;
    } finally {
      handle.dispose();
      frame.remove();
    }
  };
}

export interface DownloadPptxOptions {
  fontScale?: PptxFontScale;
  focus?: string;
}

/** Editable .pptx for WPS / PowerPoint / Keynote; the HTML deck stays the primary format. */
export async function downloadPptx(lessonId: string, opts: DownloadPptxOptions = {}): Promise<PptxExport> {
  const [{ exportPptx, resolveFontScale }, deck, lessonView] = await Promise.all([
    import("@kj/pptx"),
    lessonApi.deck(lessonId) as unknown as Promise<{
      lesson: { title: string; theme: ThemeId; language?: TeachingLanguage; focus?: string; pageLabels: Record<number, string> };
      slides: Slide[];
    }>,
    opts.fontScale !== undefined || opts.focus !== undefined ? Promise.resolve(null) : lessonApi.get(lessonId).catch(() => null),
  ]);
  const focus = opts.focus ?? deck.lesson.focus ?? lessonView?.confirmed?.params.focus ?? lessonView?.lesson.params.focus;
  const fontScale = resolveFontScale({ fontScale: opts.fontScale, focus });
  const input: PptxDeck = {
    title: deck.lesson.title,
    theme: deck.lesson.theme,
    language: deck.lesson.language,
    fontScale,
    focus,
    pageLabels: deck.lesson.pageLabels,
    slides: deck.slides,
  };
  const file = await exportPptx(input, { chartImage: chartSnapshot(deck.lesson.theme), fontScale });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([file.data as BlobPart], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
  a.download = file.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return file;
}
