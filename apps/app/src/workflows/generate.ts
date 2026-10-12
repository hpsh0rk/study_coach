import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { AiGateError } from "@kj/ai";
import { layoutSlide } from "@kj/layout";
import { pageText } from "@kj/parsers";
import { canonicalJson, DEFAULT_THEME, getTheme, ParsedDocument, sha256Hex, type OutlineItem, type SlideSlots } from "@kj/schema";
import { makeAi } from "../ai.ts";
import type { Env } from "../env.ts";

export interface GenerateParams {
  projectId: string;
  orgId: string;
  userId: string;
  runId: string;
  outlineVersionId: string;
  gateToken: string;
  itemIds: string[];
  leaseId?: string;
}

const MAX_SOURCE_CHARS = 8000;

export class GenerateWorkflow extends WorkflowEntrypoint<Env, GenerateParams> {
  override async run(event: WorkflowEvent<GenerateParams>, step: WorkflowStep): Promise<{ slides: number }> {
    const p = event.payload;
    const project = () => this.env.PROJECT.get(this.env.PROJECT.idFromName(p.projectId));
    try {
      await step.do("mark-running", async () => {
        await project().markRun(p.runId, "running");
      });

      for (const itemId of p.itemIds) {
        const gate = await step.do(`gate:${itemId}`, async () => {
          const res = await project().assertGate(p.runId, p.outlineVersionId, itemId);
          if (!res.ok) throw new NonRetryableError(`${res.code}: ${res.message}`);
          return { item: res.item as OutlineItem, documentId: res.documentId, themeId: res.themeId };
        });

        const generated = await step.do(
          `generate:${itemId}`,
          { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" },
          async () => {
            const item = gate.item as OutlineItem;
            let sourceText = "";
            if (gate.documentId && item.pageRange) {
              const obj = await this.env.FILES.get(`parsed/${gate.documentId}.json`);
              if (obj) {
                const parsed = ParsedDocument.parse(await obj.json());
                sourceText = pageText(parsed, item.pageRange[0], item.pageRange[1]).slice(0, MAX_SOURCE_CHARS);
              }
            }
            try {
              const res = await makeAi(this.env, p.orgId).call(
                "slide.generate",
                { outlineItem: item, sourceText },
                { orgId: p.orgId, userId: p.userId, projectId: p.projectId, gateToken: p.gateToken },
              );
              return { slots: res.output as SlideSlots, aiCallId: res.callId, specHash: await sha256Hex(canonicalJson({ item, sourceText })) };
            } catch (err) {
              if (err instanceof AiGateError) throw new NonRetryableError(err.message);
              throw err;
            }
          },
        );

        await step.do(`commit:${itemId}`, async () => {
          const theme = getTheme(gate.themeId) ?? DEFAULT_THEME;
          const slide = layoutSlide({ slots: generated.slots, theme, outlineItemId: itemId, aiCallId: generated.aiCallId, specHash: generated.specHash });
          await project().commitSlide(p.runId, p.outlineVersionId, slide);
          await project().notify({ type: "run", runId: p.runId, status: "running", itemId, message: "slide ready" });
        });
      }

      await step.do("finish", async () => {
        await project().markRun(p.runId, "done");
        if (p.leaseId) await this.env.USER_GATE.get(this.env.USER_GATE.idFromName(p.userId)).release(p.leaseId);
      });
      return { slides: p.itemIds.length };
    } catch (err) {
      await step.do("mark-failed", async () => {
        await project().markRun(p.runId, "failed", String((err as Error).message ?? err).slice(0, 500));
        if (p.leaseId) await this.env.USER_GATE.get(this.env.USER_GATE.idFromName(p.userId)).release(p.leaseId);
      });
      throw err;
    }
  }
}
