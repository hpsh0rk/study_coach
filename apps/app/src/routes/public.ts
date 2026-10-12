import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createPhetProvider, PHET_ATTRIBUTION, PHET_CATALOG, phetR2Key } from "@kj/experiments";
import { BUILTIN_THEMES, DEFAULT_THEME, ParsedDocument, sha256Hex, stripNotes, type Deck } from "@kj/schema";
import { documents, projects, shareLinks } from "../db/schema.ts";
import type { AppBindings } from "../env.ts";
import { HttpError } from "../http.ts";
import { db } from "../auth/session.ts";
import { verifyCallbackToken } from "../internal-token.ts";
import { PARSE_DONE_EVENT, parsedKey } from "../workflows/ingest.ts";

/** Student share view: no login, read-only, notes stripped, revocable and expiring. */
export const shareRoutes = new Hono<AppBindings>().get("/:token", async (c) => {
  const token = c.req.param("token");
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(404, "NOT_FOUND", "Link not found");
  const link = (await db(c.env).select().from(shareLinks).where(eq(shareLinks.tokenHash, await sha256Hex(token))).limit(1))[0];
  if (!link || link.revokedAt) throw new HttpError(404, "NOT_FOUND", "This link is no longer available · 链接已失效");
  if (link.expiresAt && link.expiresAt < Date.now()) throw new HttpError(410, "EXPIRED", "This link has expired · 链接已过期");
  const project = (await db(c.env).select({ title: projects.title }).from(projects).where(eq(projects.id, link.projectId)).limit(1))[0];
  const deck = (await c.env.PROJECT.get(c.env.PROJECT.idFromName(link.projectId)).getDeck()) as Deck | null;
  if (!deck) throw new HttpError(404, "EMPTY", "Nothing to show yet · 课件尚未生成");
  c.header("cache-control", "private, no-store");
  return c.json({ title: project?.title ?? "", deck: stripNotes(deck), theme: BUILTIN_THEMES[deck.theme.themeId] ?? DEFAULT_THEME });
});

const phet = createPhetProvider();

/**
 * Self-hosted PhET sims (CC BY 4.0, attribution shown on the slide). Served from our origin so
 * schools only need to allow one domain; in production this moves to an isolated sim subdomain.
 */
export const simRoutes = new Hono<AppBindings>()
  .get("/catalog", (c) => c.json({ phet: PHET_CATALOG.map((p) => ({ ...p, attribution: PHET_ATTRIBUTION, resolved: phet.resolve({ componentId: p.id, locale: "en" }) })) }))
  .get("/phet/:componentId", async (c) => {
    const component = PHET_CATALOG.find((p) => p.id === c.req.param("componentId"));
    if (!component) throw new HttpError(404, "NOT_FOUND", "Unknown simulation");
    const locale = c.req.query("locale") === "zh_CN" && component.locales.includes("zh_CN") ? "zh_CN" : "en";
    const obj = (await c.env.FILES.get(phetR2Key(component, locale))) ?? (await c.env.FILES.get(phetR2Key(component, "en")));
    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      // Sims must not phone home; everything they need is inlined in the HTML file.
      "content-security-policy": "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' data: blob:",
      "x-content-type-options": "nosniff",
    });
    if (!obj) {
      headers.set("cache-control", "no-store");
      return new Response(
        `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0;text-align:center">
<div><h2>${component.title.en} · ${component.title.zh}</h2><p>Simulation files are not installed yet.<br>Run <code>pnpm seed:sims</code> to self-host them.</p><p style="opacity:.6">${PHET_ATTRIBUTION}</p></div>`,
        { status: 200, headers },
      );
    }
    headers.set("cache-control", "public, max-age=86400");
    return new Response(obj.body, { headers });
  });

/** Callbacks from containers/heavy (Docker locally, Cloudflare Containers later). */
export const internalRoutes = new Hono<AppBindings>()
  .get("/documents/:id/pdf", async (c) => {
    const id = c.req.param("id");
    if (!(await verifyCallbackToken(c.env, id, c.req.query("token")))) throw new HttpError(403, "FORBIDDEN", "bad token");
    const doc = (await db(c.env).select().from(documents).where(eq(documents.id, id)).limit(1))[0];
    const obj = doc && (await c.env.FILES.get(doc.r2Key));
    if (!obj) throw new HttpError(404, "NOT_FOUND", "missing");
    return new Response(obj.body, { headers: { "content-type": "application/pdf" } });
  })
  .post("/documents/:id/parsed", async (c) => {
    const id = c.req.param("id");
    const auth = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!(await verifyCallbackToken(c.env, id, auth))) throw new HttpError(403, "FORBIDDEN", "bad token");
    const doc = (await db(c.env).select().from(documents).where(eq(documents.id, id)).limit(1))[0];
    if (!doc?.workflowInstanceId) throw new HttpError(404, "NOT_FOUND", "unknown document");
    const body = (await c.req.json()) as { ok: boolean; error?: string; document?: unknown };
    const instance = await c.env.INGEST_WF.get(doc.workflowInstanceId);
    if (!body.ok) {
      await instance.sendEvent({ type: PARSE_DONE_EVENT, payload: { ok: false, error: String(body.error ?? "unknown") } });
      return c.json({ ok: true });
    }
    const parsed = ParsedDocument.safeParse(body.document);
    if (!parsed.success) {
      await instance.sendEvent({ type: PARSE_DONE_EVENT, payload: { ok: false, error: "invalid ParsedDocument from container" } });
      throw new HttpError(400, "VALIDATION", "invalid ParsedDocument", parsed.error.issues.slice(0, 10));
    }
    await c.env.FILES.put(parsedKey(id), JSON.stringify(parsed.data), { httpMetadata: { contentType: "application/json" } });
    await instance.sendEvent({ type: PARSE_DONE_EVENT, payload: { ok: true } });
    return c.json({ ok: true });
  });
