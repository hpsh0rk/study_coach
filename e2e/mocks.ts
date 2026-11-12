import * as http from "node:http";
import { PDFDocument } from "pdf-lib";

/** An OpenAI-compatible endpoint on this machine standing in for the provider's vision model. */
export async function mockVisionProvider(reply: string) {
  const asked: { model: string; image: string; auth: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      asked.push({ model: parsed.model, image: parsed.messages?.[0]?.content?.[0]?.image_url?.url ?? "", auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: parsed.model, choices: [{ message: { content: reply } }], usage: { prompt_tokens: 1200, completion_tokens: 300 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}/v1`, asked, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A Messages-dialect gateway that requires the expected Bearer key and x-source header. */
export async function mockMessagesGateway() {
  const asked: { url: string; auth?: string; source?: string; body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      asked.push({ url: req.url ?? "", auth: req.headers.authorization, source: req.headers["x-source"] as string | undefined, body: parsed });
      if (req.url !== "/v1/messages" || req.headers.authorization !== "Bearer sk-gateway-key" || req.headers["x-source"] !== "tensorhawk") {
        res.statusCode = 401;
        res.end('{"error":"unauthorized"}');
        return;
      }
      res.setHeader("content-type", "text/event-stream");
      const send = (e: Record<string, unknown>) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      send({ type: "message_start", message: { model: parsed.model, usage: { input_tokens: 9, output_tokens: 1 } } });
      for (const piece of ['{"ok"', ":true}"]) send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
      send({ type: "message_delta", usage: { output_tokens: 4 } });
      send({ type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}`, asked, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * A self-hosted MinerU 4 server: /v1/health, then /v1/tasks with the raw
 * sub-PDF, its status and its JSON result.
 */
export async function mockSelfhostMinerU(key: string) {
  const asked: { path: string; query: string; auth: string | undefined; pages?: number }[] = [];
  const tasks = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const send = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };
      const entry: (typeof asked)[number] = { path: url.pathname, query: url.search, auth: req.headers.authorization };
      asked.push(entry);
      if (url.pathname === "/v1/health") return send(200, { version: "4.0.12" });
      if (req.headers.authorization !== `Bearer ${key}`) return send(401, { error: { code: "invalid_api_key", message: "Invalid or missing API key" } });
      if (url.pathname === "/v1/tasks" && req.method === "POST") {
        const pdf = await PDFDocument.load(Buffer.concat(chunks));
        entry.pages = pdf.getPageCount() / 2;
        const id = `task-${tasks.size + 1}`;
        tasks.set(id, entry.pages);
        return send(202, { task_id: id, status: "queued" });
      }
      const m = /^\/v1\/tasks\/([^/]+)(\/result)?$/.exec(url.pathname);
      const count = m ? tasks.get(m[1]!) : undefined;
      if (!m || count === undefined) return send(404, { error: { code: "not_found", message: "Task not found" } });
      if (!m[2]) return send(200, { task_id: m[1], status: "completed", files: [{ status: "completed" }] });
      const markdown = Array.from({ length: count }, (_, i) => `KJPAGE ${i + 1}\n\n## 3.1 Equations of motion (school server)\n\n$$v = u + at$$\n`).join("\n");
      return send(200, { task_id: m[1], status: "completed", files: [{ status: "completed", content: { markdown } }] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}`, asked, close: () => new Promise((resolve) => server.close(resolve)) };
}
