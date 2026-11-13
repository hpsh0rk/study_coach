import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  cropNormalizedRegion,
  detectPageFigures,
  extractPdfFigures,
  GlobalWorkerOptions,
  inspectPdf,
  pageRenderer,
  parsePdf,
  renderPdfPageCanvas,
  type DetectedPageFigure,
  type ExtractedPdfFigure,
  type ExtractFiguresOptions,
  type InspectOptions,
  type NormalizedRect,
  type ParseOptions,
} from "@kj/textbook/browser";

GlobalWorkerOptions.workerSrc = workerUrl;

/** pdf.js in the browser, configured once; the only place the web app loads it. */
export {
  cropNormalizedRegion,
  detectPageFigures,
  extractPdfFigures,
  inspectPdf,
  pageRenderer,
  parsePdf,
  renderPdfPageCanvas,
  type DetectedPageFigure,
  type ExtractedPdfFigure,
  type ExtractFiguresOptions,
  type InspectOptions,
  type NormalizedRect,
  type ParseOptions,
};
