import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api.ts";
import { mediaApi, type MediaAssetDto } from "./api.ts";
import { rememberedFile, rememberedPageOffset, rememberFile } from "./external.ts";
import { cropNormalizedRegion, renderPdfPageCanvas, type NormalizedRect } from "./pdf.ts";

export function normalizeDragRect(start: { x: number; y: number }, end: { x: number; y: number }): NormalizedRect {
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const x0 = clamp01(Math.min(start.x, end.x));
  const y0 = clamp01(Math.min(start.y, end.y));
  const x1 = clamp01(Math.max(start.x, end.x));
  const y1 = clamp01(Math.max(start.y, end.y));
  return {
    x: x0,
    y: y0,
    w: Math.max(0, x1 - x0),
    h: Math.max(0, y1 - y0),
  };
}

/** Converts an uploaded/pasted browser image File/Blob into a bounded <= 1200px PNG/WebP data URL. */
export async function imageBlobToBoundedDataUrl(blob: Blob, maxSide = 1200): Promise<string> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = Math.max(1, img.naturalWidth || img.width);
    const h = Math.max(1, img.naturalHeight || img.height);
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, 0, 0, outW, outH);
    const webp = canvas.toDataURL("image/webp", 0.88);
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function PageCropper({
  documentId,
  pageNo,
  defaultLabel,
  onCropped,
  onCancel,
}: {
  documentId: string;
  pageNo: number;
  defaultLabel?: string;
  onCropped: (asset: MediaAssetDto) => void;
  onCancel?: () => void;
}) {
  const [pageInput, setPageInput] = useState(String(pageNo || 1));
  const [label, setLabel] = useState(defaultLabel ?? `p.${pageNo} 裁图`);
  const [caption, setCaption] = useState("");
  const [renderedCanvas, setRenderedCanvas] = useState<HTMLCanvasElement | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string>("");
  const [loadingPage, setLoadingPage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<NormalizedRect>({ x: 0.12, y: 0.2, w: 0.76, h: 0.45 });
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  const activePageNo = Math.max(1, Math.trunc(Number(pageInput) || pageNo || 1));

  async function renderTargetPage(file: Blob, targetNo: number) {
    setLoadingPage(true);
    setError("");
    try {
      const offset = rememberedPageOffset(documentId);
      const canvas = await renderPdfPageCanvas(file, targetNo, { scale: 2, pageOffset: offset });
      setRenderedCanvas(canvas);
      setPreviewSrc(canvas.toDataURL("image/jpeg", 0.82));
    } catch (e) {
      setError(`无法渲染第 ${targetNo} 页：${(e as Error).message}`);
    } finally {
      setLoadingPage(false);
    }
  }

  useEffect(() => {
    setPageInput(String(pageNo || 1));
    setLabel(defaultLabel ?? `p.${pageNo || 1} 裁图`);
    const kept = rememberedFile(documentId);
    if (kept) void renderTargetPage(kept, pageNo || 1);
    else {
      setRenderedCanvas(null);
      setPreviewSrc("");
    }
  }, [documentId, pageNo]);

  function pointerNorm(clientX: number, clientY: number): { x: number; y: number } {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  }

  async function confirmCrop() {
    if (!renderedCanvas) return;
    if (selection.w < 0.04 || selection.h < 0.04) {
      setError("请在页面上拖出一个稍大一点的框选区域 · Drag a larger crop region");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const cropped = cropNormalizedRegion(renderedCanvas, selection, { maxSide: 1200 });
      const res = await mediaApi.upload({
        documentId,
        pageNo: activePageNo,
        label: label.trim() || `p.${activePageNo}`,
        caption: caption.trim() || label.trim(),
        image: cropped.image,
      });
      onCropped(res.asset);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card stack" data-testid="page-cropper" style={{ padding: 12, marginTop: 8 }}>
      <div className="row between wrap">
        <b>✂ 从教材页拖框裁图（2× 合成层，保留矢量箭头与文字标注）</b>
        {onCancel && (
          <button type="button" className="btn small ghost" onClick={onCancel}>
            收起 Close
          </button>
        )}
      </div>

      <div className="row wrap" style={{ gap: 8, alignItems: "flex-end" }}>
        <label className="slot-field inline" style={{ margin: 0 }}>
          <span>页码 Page</span>
          <input
            type="number"
            min={1}
            max={3000}
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            style={{ width: 90 }}
            data-testid="cropper-page-input"
          />
        </label>
        <button
          type="button"
          className="btn small ghost"
          disabled={loadingPage}
          data-testid="cropper-load-page"
          onClick={() => {
            const kept = rememberedFile(documentId);
            if (kept) void renderTargetPage(kept, activePageNo);
            else pdfInputRef.current?.click();
          }}
        >
          {loadingPage ? "渲染中…" : rememberedFile(documentId) ? "切换该页 Render" : "选择原书 PDF 文件以渲染"}
        </button>
        <input
          ref={pdfInputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          data-testid="cropper-pdf-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              rememberFile(documentId, f);
              void renderTargetPage(f, activePageNo);
            }
            e.target.value = "";
          }}
        />
      </div>

      {!previewSrc && !loadingPage && (
        <p className="muted small">
          当前标签页还没有这份教材的本地 PDF 句柄（例如刷新过页面），点上方“选择原书 PDF 文件以渲染”即可在本地浏览器渲染并拖框裁图（文件不会上传）。
        </p>
      )}

      {previewSrc && (
        <>
          <p className="muted small" style={{ margin: 0 }}>
            在下方页面上按住鼠标拖动框选插图区域 · Drag across the page to select the diagram region:
          </p>
          <div
            ref={stageRef}
            data-testid="cropper-stage"
            style={{
              position: "relative",
              display: "inline-block",
              maxWidth: "100%",
              maxHeight: 420,
              overflow: "hidden",
              border: "1px solid var(--line)",
              borderRadius: 8,
              cursor: "crosshair",
              userSelect: "none",
              touchAction: "none",
              alignSelf: "flex-start",
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              const pt = pointerNorm(e.clientX, e.clientY);
              dragStartRef.current = pt;
              setSelection({ x: pt.x, y: pt.y, w: 0.01, h: 0.01 });
              e.currentTarget.setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!dragStartRef.current) return;
              const pt = pointerNorm(e.clientX, e.clientY);
              setSelection(normalizeDragRect(dragStartRef.current, pt));
            }}
            onPointerUp={(e) => {
              if (!dragStartRef.current) return;
              const pt = pointerNorm(e.clientX, e.clientY);
              const rect = normalizeDragRect(dragStartRef.current, pt);
              dragStartRef.current = null;
              if (rect.w >= 0.04 && rect.h >= 0.04) setSelection(rect);
            }}
          >
            <img
              src={previewSrc}
              alt={`Page ${activePageNo}`}
              draggable={false}
              style={{ display: "block", maxHeight: 418, maxWidth: "100%", width: "auto", height: "auto" }}
            />
            <div
              data-testid="cropper-selection"
              style={{
                position: "absolute",
                left: `${selection.x * 100}%`,
                top: `${selection.y * 100}%`,
                width: `${selection.w * 100}%`,
                height: `${selection.h * 100}%`,
                border: "2px solid #dc2626",
                background: "rgba(220, 38, 38, 0.14)",
                pointerEvents: "none",
              }}
            />
          </div>

          <div className="row wrap" style={{ gap: 8 }}>
            <label className="slot-field" style={{ flex: 1, minWidth: 140, margin: 0 }}>
              <span>图号 Label（可选）</span>
              <input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} data-testid="cropper-label" />
            </label>
            <label className="slot-field" style={{ flex: 2, minWidth: 200, margin: 0 }}>
              <span>图注说明 Caption（可选）</span>
              <input value={caption} maxLength={120} onChange={(e) => setCaption(e.target.value)} placeholder="例如：Fig 16.8 螺线管磁场" data-testid="cropper-caption" />
            </label>
          </div>
          <div className="row end">
            <button
              type="button"
              className="btn small primary"
              disabled={saving}
              onClick={() => void confirmCrop()}
              data-testid="cropper-save"
            >
              {saving ? "保存插图中…" : "保存裁剪插图 Save cropped figure"}
            </button>
          </div>
        </>
      )}

      {error && <div className="alert error">{error}</div>}
    </div>
  );
}
