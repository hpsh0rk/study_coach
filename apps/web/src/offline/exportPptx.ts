import type { ImageItem, PptxDeck, PptxExport } from "@kj/pptx";
import type { Slide, ThemeId } from "@kj/schema";
import { renderWidget } from "@kj/widgets/render";
import { lessonApi } from "../lessonApi.ts";

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

/** PNG of the ECharts plot, for the charts a native PPTX chart cannot express (mixed x values, broken curves). */
function chartSnapshot(theme: ThemeId) {
  return async (item: ImageItem): Promise<string | null> => {
    const frame = document.createElement("div");
    frame.className = `kj-theme-${theme}`;
    Object.assign(frame.style, { position: "fixed", left: "-10000px", top: "0", width: `${item.rect.w}px`, height: `${item.rect.h}px`, background: "transparent" });
    const host = document.createElement("div");
    Object.assign(host.style, { width: "100%", height: "100%" });
    frame.append(host);
    document.body.append(frame);
    const handle = renderWidget(item.spec, host, { interactive: false });
    try {
      await nextFrame();
      await nextFrame();
      const svg = host.querySelector("svg");
      if (!svg) return null;
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = item.rect.w * 2;
      canvas.height = item.rect.h * 2;
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    } finally {
      handle.dispose();
      frame.remove();
    }
  };
}

/** Editable .pptx for WPS / PowerPoint / Keynote; the HTML deck stays the primary format. */
export async function downloadPptx(lessonId: string): Promise<PptxExport> {
  const [{ exportPptx }, deck] = await Promise.all([import("@kj/pptx"), lessonApi.deck(lessonId) as unknown as Promise<{ lesson: { title: string; theme: ThemeId; pageLabels: Record<number, string> }; slides: Slide[] }>]);
  const input: PptxDeck = { title: deck.lesson.title, theme: deck.lesson.theme, pageLabels: deck.lesson.pageLabels, slides: deck.slides };
  const file = await exportPptx(input, { chartImage: chartSnapshot(deck.lesson.theme) });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([file.data as BlobPart], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
  a.download = file.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return file;
}
