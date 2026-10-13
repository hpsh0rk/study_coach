import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { visionParserId } from "@kj/pdf-structure";
import { e, loggedIn, seedUser, type Client } from "./client.ts";

const TEXT = "Waves carry energy from one place to another without moving matter. The wave speed equals frequency times wavelength.";
const LOSSY = "3.1 Equations of motion For an object that starts with velocity u the final velocity and the displacement are given below.";
const IMAGE = `data:image/jpeg;base64,${"/9j/4AAQSkZJRgABAQ".repeat(20)}`;
const READ = "## 3.1 Equations of motion\n$$v = u + at$$\n$$s = ut + \\frac{1}{2}at^2$$";

let admin: Client;
let teacher: Client;
let colleague: Client;

/** The provider's HTTP endpoint, as the Worker calls it; nothing leaves the test. */
function provider(reply: () => Response) {
  const asked: { url: string; body: any }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://vision.test/")) throw new Error(`unexpected fetch ${url}`);
    asked.push({ url, body: JSON.parse(String(init?.body)) });
    return reply();
  });
  return asked;
}
const answer = (content: string) => () => new Response(JSON.stringify({ model: "m", choices: [{ message: { content } }], usage: { prompt_tokens: 1200, completion_tokens: 900 } }), { headers: { "content-type": "application/json" } });

async function newBook(sha: string, owner = teacher): Promise<string> {
  const id = (
    await owner.req("POST", "/api/documents", {
      filename: "kinematics.pdf",
      title: "Kinematics",
      sizeBytes: 4000,
      pageCount: 4,
      chapters: [{ id: "c0", parentId: null, level: 1, ord: 0, title: "3 Motion", pageStart: 1, pageEnd: 4, words: 80 }],
      sha256: sha,
    })
  ).json.id as string;
  await owner.req("POST", `/api/documents/${id}/pages`, {
    pages: [
      { no: 1, text: TEXT, kind: "text" },
      { no: 2, text: LOSSY, kind: "formula-lost" },
      { no: 3, text: TEXT, kind: "table" },
      { no: 4, text: LOSSY, kind: "scanned" },
    ],
  });
  return id;
}

const readImage = (id: string, no: number, image = IMAGE, as = teacher) => as.req("POST", `/api/documents/${id}/parse-image`, { no, image, reason: "auto" });

async function setVisionModel(visionModel: string) {
  const providers = (await admin.req("GET", "/api/admin/ai")).json.providers as { id: string }[];
  if (providers[0]) return admin.req("PATCH", `/api/admin/ai/providers/${providers[0].id}`, { visionModel });
  return admin.req("POST", "/api/admin/ai/providers", { kind: "custom", name: "Vision test", baseUrl: "https://vision.test/v1", apiKey: "sk-vision-test-key", model: "chat-model", visionModel });
}

beforeAll(async () => {
  await seedUser("usr_va", "visionadmin", "Admin12345", { role: "admin", mustChange: false });
  await seedUser("usr_vt", "visionteacher", "Teach12345", { mustChange: false });
  await seedUser("usr_vc", "visioncolleague", "Teach12345", { mustChange: false });
  admin = await loggedIn("visionadmin", "Admin12345");
  teacher = await loggedIn("visionteacher", "Teach12345");
  colleague = await loggedIn("visioncolleague", "Teach12345");
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await e.DB.prepare("DELETE FROM ai_providers").run();
});

describe("vision-model fallback (看图模型)", () => {
  it("without a vision model nothing is sent, and the stub never pretends to read a page", async () => {
    const asked = provider(answer(READ));
    const id = await newBook("b".repeat(64));
    expect((await teacher.req("GET", `/api/documents/${id}`)).json.visionParser).toBeNull();
    expect((await readImage(id, 2)).json.error.code).toBe("VISION_OFF");
    await setVisionModel("");
    expect((await readImage(id, 2)).status).toBe(403);
    expect(asked).toHaveLength(0);
  });

  it("a paid model stays off until paid parsing is allowed, then stops at the monthly budget", async () => {
    const asked = provider(answer("```markdown\n" + READ + "\n```"));
    expect((await setVisionModel("qwen-vl-ocr")).status).toBe(200);
    const id = await newBook("c".repeat(64));
    expect((await teacher.req("GET", `/api/documents/${id}`)).json.visionParser).toBeNull();
    const off = await readImage(id, 2);
    expect(off.status).toBe(402);
    expect(off.json.error).toMatchObject({ code: "PARSE_BUDGET", detail: { scope: "off" } });
    expect((await admin.req("GET", "/api/admin/parsing")).json).toMatchObject({ paidEnabled: false, monthlyBudgetMicroYuan: 0, vision: { model: "qwen-vl-ocr", microYuanPerPage: 900, source: "list" } });

    expect((await admin.req("PUT", "/api/admin/parsing", { paidEnabled: true, monthlyBudgetMicroYuan: 1_000 })).status).toBe(200);
    expect((await teacher.req("GET", `/api/documents/${id}`)).json.visionParser).toEqual({ parser: visionParserId("qwen-vl-ocr"), model: "qwen-vl-ocr", microYuanPerPage: 900 });
    const read = await readImage(id, 2);
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ reused: false, page: { no: 2, parser: "vlm:qwen-vl-ocr/1" } });
    expect(asked[0]!.url).toMatch(/^https:\/\/vision\.test\/v1\/chat\/\w+$/);
    expect(asked[0]!.body).toMatchObject({ model: "qwen-vl-ocr", messages: [{ content: [{ type: "image_url", image_url: { url: IMAGE } }, { type: "text" }] }] });
    expect((await teacher.req("GET", `/api/documents/${id}/pages/2`)).json).toMatchObject({ text: READ, parser: "vlm:qwen-vl-ocr/1" });

    const over = await readImage(id, 4);
    expect(over.json.error).toMatchObject({ code: "PARSE_BUDGET", detail: { scope: "month", remaining: 100 } });
    expect(asked).toHaveLength(1);
    const usage = await e.DB.prepare("SELECT parser, cost_micro_yuan AS cost, state FROM parse_usage WHERE document_id = ?").bind(id).all();
    expect(usage.results).toEqual([{ parser: "vlm:qwen-vl-ocr/1", cost: 900, state: "done" }]);
    const calls = await e.DB.prepare("SELECT capability, model, status FROM ai_calls WHERE capability = 'page.read'").all();
    expect(calls.results).toEqual([{ capability: "page.read", model: "m", status: "ok" }]);
    const audit = await e.DB.prepare("SELECT target FROM audit_log WHERE action = 'admin.parser_settings' ORDER BY id").all<{ target: string }>();
    expect(audit.results.map((r) => r.target)).toEqual(["paid_on"]);
  });

  it("a free model (or one the admin prices at 0) runs with paid parsing off; failures are counted, not stored", async () => {
    await admin.req("PUT", "/api/admin/parsing", { paidEnabled: false });
    await setVisionModel("glm-4.6v-flash");
    const id = await newBook("d".repeat(64));
    expect((await teacher.req("GET", `/api/documents/${id}`)).json.visionParser).toMatchObject({ model: "glm-4.6v-flash", microYuanPerPage: 0 });

    const busy = provider(() => new Response("rate limited", { status: 429 }));
    expect((await readImage(id, 4)).json.error.code).toBe("PARSER_BUSY");
    expect(busy).toHaveLength(1);
    expect((await teacher.req("GET", `/api/documents/${id}/pages/4`)).json.parser).toBe("pdfjs/1");
    vi.restoreAllMocks();

    provider(answer("   "));
    expect((await readImage(id, 4)).json.error.code).toBe("VISION_FAILED");
    vi.restoreAllMocks();

    await setVisionModel("my-own-vl");
    expect((await admin.req("GET", "/api/admin/parsing")).json.vision).toEqual({ model: "my-own-vl", microYuanPerPage: 11_000, source: "unknown" });
    expect((await teacher.req("GET", `/api/documents/${id}`)).json.visionParser).toBeNull();
    await admin.req("PUT", "/api/admin/parsing", { visionPriceMicroYuan: 0 });
    provider(answer(READ));
    expect((await readImage(id, 4)).json.page).toMatchObject({ no: 4, parser: "vlm:my-own-vl/1" });
    const states = await e.DB.prepare("SELECT state FROM parse_usage WHERE document_id = ? ORDER BY created_at, rowid").bind(id).all<{ state: string }>();
    expect(states.results.map((r) => r.state)).toEqual(["failed", "failed", "done"]);
  });

  it("only pages that need it, only real images; a copy of the same file reuses the reading", async () => {
    const asked = provider(answer(READ));
    const id = await newBook("e".repeat(64));
    expect((await readImage(id, 1)).json.error.code).toBe("PAGES_NOT_ELIGIBLE");
    expect((await readImage(id, 3)).status).toBe(409);
    expect((await readImage(id, 2, "data:text/html;base64,PHNjcmlwdD4=")).status).toBe(400);
    expect((await readImage(id, 2)).json.reused).toBe(false);
    expect((await readImage(id, 2)).status).toBe(409);

    const copy = await newBook("e".repeat(64), colleague);
    expect((await readImage(copy, 2, IMAGE, colleague)).json).toMatchObject({ reused: true, page: { parser: "vlm:my-own-vl/1" } });
    expect(asked).toHaveLength(1);
  });

  it("the teacher's paste replaces what the model read; the pasted page is not sent again", async () => {
    provider(answer(READ));
    const id = await newBook("f".repeat(64));
    await readImage(id, 2);
    const pasted = await teacher.req("POST", `/api/documents/${id}/pages/paste`, { start: 2, end: 2, text: "3.1 Equations of motion: v = u + at and s = ut + at²/2 for constant acceleration." });
    expect(pasted.json.pages).toEqual([expect.objectContaining({ no: 2, parser: "paste" })]);
    expect((await readImage(id, 2)).status).toBe(409);
  });
});
