import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { ProviderError } from "@kj/ai";
import type { AppBindings, Env } from "./env.ts";
import { HttpError } from "./http.ts";
import { csrfGuard } from "./auth/session.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { documentRoutes } from "./routes/documents.ts";
import { lessonRoutes } from "./routes/lessons.ts";
import { reuseRoutes } from "./routes/reuse.ts";
import { shareRoutes } from "./routes/share.ts";

export const app = new Hono<AppBindings>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, detail: err.detail } }, err.status);
  if (err instanceof ProviderError) return c.json({ error: { code: "AI_PROVIDER", message: err.publicMessage } }, 502);
  console.error("unhandled", err);
  return c.json({ error: { code: "INTERNAL", message: "Something went wrong · 服务器错误" } }, 500);
});

app.use("/api/*", secureHeaders({ crossOriginResourcePolicy: "same-origin" }));
app.use("/api/*", csrfGuard);

app.get("/api/health", (c) => c.json({ ok: true, env: c.env.ENVIRONMENT }));
app.route("/api/auth", authRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/documents", documentRoutes);
app.route("/api/lessons", reuseRoutes);
app.route("/api/lessons", lessonRoutes);
app.route("/api/share", shareRoutes);
app.all("/api/*", (c) => c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404));

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
