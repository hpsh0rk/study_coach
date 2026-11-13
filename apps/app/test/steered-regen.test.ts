import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { e, loggedIn, seedUser, type Client } from "./client.ts";

let admin: Client;
let teacher: Client;

beforeAll(async () => {
  await seedUser("usr_sr_admin", "sradmin", "Admin12345", { role: "admin", mustChange: false });
  await seedUser("usr_sr_teach", "srteach", "Teach12345", { mustChange: false });
  admin = await loggedIn("sradmin", "Admin12345");
  teacher = await loggedIn("srteach", "Teach12345");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await e.DB.prepare("DELETE FROM ai_providers").run();
});

async function createConfirmedLesson(c: Client) {
  const doc = await c.req("POST", "/api/documents", {
    filename: "waves-regen.pdf",
    title: "Waves",
    sizeBytes: 4096,
    pageCount: 2,
    chapters: [{ id: "c1", parentId: null, level: 1, ord: 0, title: "1 Waves", pageStart: 1, pageEnd: 2, words: 80 }],
  });
  const docId = doc.json.id as string;
  await c.req("POST", `/api/documents/${docId}/pages`, {
    pages: [
      { no: 1, text: "Waves transfer energy without transferring matter. Wave speed equals frequency times wavelength, v = f x lambda." },
      { no: 2, text: "Sound travels at 340 m/s in air and 1500 m/s in water. Ultrasound has frequency above 20 000 Hz." },
    ],
  });
  const created = await c.req("POST", "/api/lessons", { documentId: docId, chapterIds: ["c1"] });
  const lessonId = created.json.lesson.id as string;
  const drafted = await c.req("POST", `/api/lessons/${lessonId}/outline`);
  const versionId = drafted.json.version.id as string;
  const rev = drafted.json.version.rev as number;
  const confirmed = await c.req("POST", `/api/lessons/${lessonId}/outline-versions/${versionId}/confirm`, { rev, ackOverBudget: true });
  const specs = confirmed.json.version.outline.slides as { id: string; layout: string; pageType: string }[];
  const workedOrConcept = specs.find((s) => s.layout === "statement") ?? specs[1]!;
  return { lessonId, versionId, specId: workedOrConcept.id };
}

describe("steered single-slide regeneration", () => {
  it("passes trimmed 200-char-capped teacher instruction to the model on both versioned and lesson-level generate endpoints", async () => {
    const { lessonId, versionId, specId } = await createConfirmedLesson(teacher);

    // Initial stub generation
    const initial = await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${versionId}/slides/${specId}/generate`, { regenerate: false });
    expect(initial.status).toBe(200);
    expect(initial.json.reused).toBe(false);

    // Configure mock live provider so we can inspect the exact outgoing prompt
    await admin.req("POST", "/api/admin/ai/providers", {
      kind: "custom",
      name: "SteeredMock",
      baseUrl: "https://mock-llm.local/v1",
      apiKey: "sk-test-steered-0000",
      model: "mock-writer",
    });

    const capturedPrompts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const reqBody = JSON.parse(String(init?.body ?? "{}")) as { messages?: { role: string; content: string }[] };
      capturedPrompts.push(reqBody.messages?.map((m) => m.content).join("\n") ?? "");
      const payload = JSON.stringify({
        content: {
          layout: "statement",
          title: "Sound travels faster in water than air",
          bullets: ["Air speed is 340 m/s", "Water speed is 1500 m/s"],
          visual: { kind: "formula", tex: "v = f\\lambda", caption: "" },
          terms: [],
        },
        notes: "Compare air (340 m/s) and water (1500 m/s) speeds with the class.",
      });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: payload }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 40 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const longInstruction = `   Compare air and water speeds clearly! ${"X".repeat(240)}   `;
    const regen1 = await teacher.req("POST", `/api/lessons/${lessonId}/outline-versions/${versionId}/slides/${specId}/generate`, {
      regenerate: true,
      instruction: longInstruction,
    });
    expect(regen1.status).toBe(200);
    expect(regen1.json.reused).toBe(false);
    expect(regen1.json.slide.canUndo).toBe(true);
    expect(regen1.json.slide.content.title).toBe("Sound travels faster in water than air");
    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toContain("Compare air and water speeds clearly!");
    // Capped at 200 chars after trim
    const xRun = /Compare air and water speeds clearly! (X+)/.exec(capturedPrompts[0]!)?.[1] ?? "";
    expect("Compare air and water speeds clearly! ".length + xRun.length).toBe(200);

    // Also works via lesson-level shorthand POST /api/lessons/:id/slides/:specId/generate
    const regen2 = await teacher.req("POST", `/api/lessons/${lessonId}/slides/${specId}/generate`, {
      regenerate: true,
      instruction: "Focus on ultrasound above 20 kHz",
    });
    expect(regen2.status).toBe(200);
    expect(regen2.json.reused).toBe(false);
    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[1]).toContain("Focus on ultrasound above 20 kHz");
  });
});
