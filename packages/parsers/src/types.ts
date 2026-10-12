import type { ParsedDocument } from "@kj/schema";

export type ParserId = "pdf-lite" | "heavy" | "mineru-api";

export interface PdfProbe {
  pageCount: number;
  hasOutline: boolean;
  textLayerRatio: number;
}

/** Runs inside the Worker step and returns the normalized result directly. */
export interface InlinePdfParser {
  id: ParserId;
  mode: "inline";
  version: string;
  parse(pdf: Uint8Array): Promise<ParsedDocument>;
}

export interface AsyncParseJob {
  documentId: string;
  /** Short-lived URL the job can GET the PDF from. */
  pdfUrl: string;
  /** Where the job POSTs the ParsedDocument JSON when done. */
  callbackUrl: string;
  callbackToken: string;
  pageRange?: [number, number];
}

/** Runs out of process (heavy container, MinerU) and reports back via callback -> Workflow event. */
export interface AsyncPdfParser {
  id: ParserId;
  mode: "async";
  start(job: AsyncParseJob): Promise<{ jobId: string }>;
}

export type PdfParser = InlinePdfParser | AsyncPdfParser;
