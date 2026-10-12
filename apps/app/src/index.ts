import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AppBindings, Env } from "./env.ts";
import { HttpError } from "./http.ts";
import { csrfGuard } from "./auth/session.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { projectRoutes } from "./routes/projects.ts";
import { internalRoutes, shareRoutes, simRoutes } from "./routes/public.ts";

export { ProjectDO } from "./do/project-do.ts";
export { UserGateDO } from "./do/user-gate-do.ts";
export { GenerateWorkflow } from "./workflows/generate.ts";
export { IngestWorkflow } from "./workflows/ingest.ts";

export const app = new Hono<AppBindings>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, detail: err.detail } }, err.status);
  console.error("unhandled", err);
  return c.json({ error: { code: "INTERNAL", message: "Something went wrong · 服务器错误" } }, 500);
});

app.use("/api/*", secureHeaders({ crossOriginResourcePolicy: "same-origin" }));
app.use("/api/*", csrfGuard);

app.get("/api/health", (c) => c.json({ ok: true, env: c.env.ENVIRONMENT, parser: c.env.PARSER }));
app.route("/api/auth", authRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/share", shareRoutes);
app.route("/sim", simRoutes);
app.route("/internal", internalRoutes);
app.all("/api/*", (c) => c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404));

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
