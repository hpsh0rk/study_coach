import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ScopeChapter } from "../src/do/project-do.ts";
import type { Env } from "../src/env.ts";

const e = env as unknown as Env;
const chapters: ScopeChapter[] = [
  { id: "ch_a", title: "Chapter 1 Waves", pageStart: 1, pageEnd: 5, childTitles: ["Describing waves", "Wave speed"] },
  { id: "ch_b", title: "Chapter 2 Sound", pageStart: 6, pageEnd: 8, childTitles: ["Echoes"] },
];

function project(name: string) {
  return e.PROJECT.get(e.PROJECT.idFromName(name));
}

describe("ProjectDO outline gate", () => {
  it("refuses to generate before the outline is confirmed and the theme locked", async () => {
    const p = project("prj_gate1");
    await p.init("prj_gate1", "org_default", "Gate");
    expect(await p.startGeneration({ userId: "usr_t", orgId: "org_default" })).toMatchObject({ ok: false, code: "NO_OUTLINE" });

    const outline = await p.setScope("doc_1", chapters);
    expect(outline.items).toHaveLength(2);
    expect(outline.items[0]?.points).toEqual(["Describing waves", "Wave speed"]);
    expect(await p.startGeneration({ userId: "usr_t", orgId: "org_default" })).toMatchObject({ ok: false, code: "OUTLINE_NOT_CONFIRMED" });

    expect(await p.confirmOutline(outline.id, "usr_t")).toMatchObject({ ok: true });
    expect(await p.startGeneration({ userId: "usr_t", orgId: "org_default" })).toMatchObject({ ok: false, code: "THEME_NOT_LOCKED" });
  });

  it("a scope change invalidates an earlier confirmation", async () => {
    const p = project("prj_gate2");
    await p.init("prj_gate2", "org_default", "Gate");
    const v1 = await p.setScope("doc_1", chapters);
    await p.confirmOutline(v1.id, "usr_t");
    await p.lockTheme("classic-blue", "usr_t");
    const v2 = await p.setScope("doc_1", chapters.slice(0, 1));
    expect(v2.version).toBe(2);
    expect(await p.confirmOutline(v1.id, "usr_t")).toMatchObject({ ok: false, code: "OUTLINE_CHANGED" });
    expect(await p.startGeneration({ userId: "usr_t", orgId: "org_default" })).toMatchObject({ ok: false, code: "OUTLINE_NOT_CONFIRMED" });
  });

  it("starts exactly one run once gated, and the per-step gate rejects foreign items", async () => {
    const p = project("prj_gate3");
    await p.init("prj_gate3", "org_default", "Gate");
    const v1 = await p.setScope("doc_1", chapters);
    await p.confirmOutline(v1.id, "usr_t");
    await p.lockTheme("classic-blue", "usr_t");
    expect(await p.startGeneration({ userId: "usr_t", orgId: "org_default", itemIds: ["oi_nope"] })).toMatchObject({ ok: false, code: "UNKNOWN_ITEMS" });

    const [a, b] = await Promise.all([
      p.startGeneration({ userId: "usr_t", orgId: "org_default" }),
      p.startGeneration({ userId: "usr_t", orgId: "org_default" }),
    ]);
    const started = [a, b].filter((r) => r.ok);
    expect(started).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ code: "GENERATION_IN_PROGRESS" });

    const run = started[0] as { ok: true; runId: string; itemIds: string[] };
    expect(await p.assertGate(run.runId, v1.id, run.itemIds[0]!)).toMatchObject({ ok: true });
    expect(await p.assertGate(run.runId, v1.id, "oi_other")).toMatchObject({ ok: false, code: "UNKNOWN_ITEMS" });
    expect(await p.assertGate(run.runId, "ol_stale", run.itemIds[0]!)).toMatchObject({ ok: false, code: "OUTLINE_CHANGED" });
  });
});
