import type { AsyncPdfParser } from "./types.ts";

export type HeavyEngine = "pypdfium2" | "docling";

/**
 * Adapter for containers/heavy. The same image runs under Docker locally (HEAVY_URL) and as a
 * Cloudflare Container in production; callers pass the matching fetch (plain fetch or the container binding).
 */
export function createHeavyParser(opts: { fetch: (url: string, init: RequestInit) => Promise<Response>; baseUrl: string; engine: HeavyEngine }): AsyncPdfParser {
  return {
    id: "heavy",
    mode: "async",
    async start(job) {
      const res = await opts.fetch(`${opts.baseUrl.replace(/\/+$/, "")}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document_id: job.documentId,
          pdf_url: job.pdfUrl,
          callback_url: job.callbackUrl,
          callback_token: job.callbackToken,
          engine: opts.engine,
          page_range: job.pageRange ?? null,
        }),
      });
      if (!res.ok) throw new Error(`heavy container rejected job: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { job_id: string };
      return { jobId: data.job_id };
    },
  };
}

/** MinerU online API adapter lands in M1a-2; kept here so the registry shape is final. */
export const mineruApiParser: AsyncPdfParser = {
  id: "mineru-api",
  mode: "async",
  async start() {
    throw new Error("mineru-api adapter is not implemented yet (milestone M1a-2)");
  },
};
