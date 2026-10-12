import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { buildChapterTree, createHeavyParser, pdfLiteParser, type HeavyEngine } from "@kj/parsers";
import { ParsedDocument } from "@kj/schema";
import type { Env } from "../env.ts";
import { callbackToken } from "../internal-token.ts";

export interface IngestParams {
  documentId: string;
  projectId: string;
  orgId: string;
  userId: string;
  r2Key: string;
  parser: "pdf-lite" | "heavy";
  leaseId?: string;
}

export const PARSE_DONE_EVENT = "parse-done";

export function parsedKey(documentId: string): string {
  return `parsed/${documentId}.json`;
}

export class IngestWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  override async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep): Promise<{ chapters: number }> {
    const p = event.payload;
    const project = () => this.env.PROJECT.get(this.env.PROJECT.idFromName(p.projectId));
    const setStatus = async (status: string, extra: Record<string, string | number | null> = {}) => {
      const cols = Object.keys(extra);
      await this.env.DB.prepare(`UPDATE documents SET status = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join("")} WHERE id = ?`)
        .bind(status, Date.now(), ...Object.values(extra), p.documentId)
        .run();
      await project().notify({ type: "ingest", documentId: p.documentId, status });
    };

    try {
      await step.do("mark-parsing", async () => setStatus("parsing", { parser_id: p.parser, workflow_instance_id: event.instanceId }));

      if (p.parser === "pdf-lite") {
        await step.do("parse", { retries: { limit: 1, delay: "5 seconds" }, timeout: "5 minutes" }, async () => {
          const obj = await this.env.FILES.get(p.r2Key);
          if (!obj) throw new NonRetryableError(`missing upload ${p.r2Key}`);
          const doc = await pdfLiteParser.parse(new Uint8Array(await obj.arrayBuffer()));
          await this.env.FILES.put(parsedKey(p.documentId), JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
          return { pages: doc.pageCount };
        });
      } else {
        await step.do("start-heavy", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, async () => {
          if (!this.env.HEAVY_URL || !this.env.CALLBACK_BASE_URL) throw new NonRetryableError("HEAVY_URL / CALLBACK_BASE_URL not configured");
          const token = await callbackToken(this.env, p.documentId);
          const base = this.env.CALLBACK_BASE_URL.replace(/\/+$/, "");
          const parser = createHeavyParser({ fetch: (u, i) => fetch(u, i), baseUrl: this.env.HEAVY_URL, engine: (this.env.HEAVY_ENGINE ?? "pypdfium2") as HeavyEngine });
          return parser.start({
            documentId: p.documentId,
            pdfUrl: `${base}/internal/documents/${p.documentId}/pdf?token=${encodeURIComponent(token)}`,
            callbackUrl: `${base}/internal/documents/${p.documentId}/parsed`,
            callbackToken: token,
          });
        });
        // The container POSTs its ParsedDocument to /internal/.../parsed, which stores it and sends this event.
        await step.waitForEvent<{ ok: boolean; error?: string }>("wait-parse", { type: PARSE_DONE_EVENT, timeout: "30 minutes" }).then((evt) => {
          if (!evt.payload.ok) throw new NonRetryableError(`heavy parser failed: ${evt.payload.error ?? "unknown"}`);
        });
      }

      const result = await step.do("build-tree", async () => {
        const obj = await this.env.FILES.get(parsedKey(p.documentId));
        if (!obj) throw new NonRetryableError("parsed document missing");
        const doc = ParsedDocument.parse(await obj.json());
        const nodes = buildChapterTree(doc);
        const stmts = [
          this.env.DB.prepare("DELETE FROM chapters WHERE document_id = ?").bind(p.documentId),
          ...nodes.map((n) =>
            this.env.DB.prepare(
              "INSERT INTO chapters (id, document_id, parent_id, ord, level, title, page_start, page_end, word_count, est_slides) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).bind(n.id, p.documentId, n.parentId, n.ord, n.level, n.title, n.pageStart, n.pageEnd, n.wordCount, n.estSlides),
          ),
        ];
        await this.env.DB.batch(stmts);
        return { chapters: nodes.length, pages: doc.pageCount };
      });

      await step.do("mark-ready", async () => {
        await setStatus("ready", { page_count: result.pages, parsed_key: parsedKey(p.documentId), error: null });
        if (p.leaseId) await this.env.USER_GATE.get(this.env.USER_GATE.idFromName(p.userId)).release(p.leaseId);
      });
      return { chapters: result.chapters };
    } catch (err) {
      await step.do("mark-failed", async () => {
        await setStatus("failed", { error: String((err as Error).message ?? err).slice(0, 500) });
        if (p.leaseId) await this.env.USER_GATE.get(this.env.USER_GATE.idFromName(p.userId)).release(p.leaseId);
      });
      throw err;
    }
  }
}
