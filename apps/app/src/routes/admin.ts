import { and, desc, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { maskSecret, openSecret, PROVIDER_PRESETS, ProviderKind, sealSecret, testProvider } from "@kj/ai";
import { newId } from "@kj/schema";
import { aiCalls, aiProviders, auditLog, users } from "../db/schema.ts";
import { secret, type AppBindings, type Env } from "../env.ts";
import { HttpError, parseJson } from "../http.ts";
import { generatePassword, hashPassword, passwordProblem } from "../auth/password.ts";
import { db, destroyUserSessions, requireAdmin, requireUser } from "../auth/session.ts";

const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, "3-32 chars: letters, digits, . _ -");

function publicUser(u: typeof users.$inferSelect) {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, mustChangePassword: u.mustChangePassword, disabled: !!u.disabledAt, createdAt: u.createdAt };
}

export const adminRoutes = new Hono<AppBindings>()
  .use(requireUser(), requireAdmin)

  // ---- whitelist accounts ----
  .get("/users", async (c) => {
    const rows = await db(c.env).select().from(users).where(eq(users.orgId, c.get("user").orgId)).orderBy(users.createdAt);
    return c.json({ users: rows.map(publicUser) });
  })
  .post("/users", async (c) => {
    const body = await parseJson(
      c,
      z.object({ username: Username, displayName: z.string().trim().max(64).optional(), role: z.enum(["admin", "teacher"]).default("teacher"), initialPassword: z.string().optional() }),
    );
    const me = c.get("user");
    const password = body.initialPassword || generatePassword();
    const problem = passwordProblem(password);
    if (problem) throw new HttpError(400, "WEAK_PASSWORD", problem);
    const exists = await db(c.env).select({ id: users.id }).from(users).where(eq(users.username, body.username)).limit(1);
    if (exists.length) throw new HttpError(409, "USERNAME_TAKEN", "Username already exists · 用户名已存在");
    const id = newId("usr");
    await db(c.env)
      .insert(users)
      .values({ id, orgId: me.orgId, username: body.username, displayName: body.displayName ?? null, passwordHash: await hashPassword(password), role: body.role, mustChangePassword: true });
    await db(c.env).insert(auditLog).values({ orgId: me.orgId, actorId: me.id, action: "admin.user_created", target: id });
    const row = (await db(c.env).select().from(users).where(eq(users.id, id)))[0]!;
    // The initial password is shown to the admin exactly once.
    return c.json({ user: publicUser(row), initialPassword: password }, 201);
  })
  .post("/users/:id/reset-password", async (c) => {
    const me = c.get("user");
    const id = c.req.param("id");
    const password = generatePassword();
    const res = await db(c.env)
      .update(users)
      .set({ passwordHash: await hashPassword(password), mustChangePassword: true, updatedAt: Date.now() })
      .where(and(eq(users.id, id), eq(users.orgId, me.orgId)))
      .returning({ id: users.id });
    if (!res.length) throw new HttpError(404, "NOT_FOUND", "User not found");
    await destroyUserSessions(c.env, id);
    await db(c.env).insert(auditLog).values({ orgId: me.orgId, actorId: me.id, action: "admin.password_reset", target: id });
    return c.json({ initialPassword: password });
  })
  .post("/users/:id/disable", async (c) => {
    const me = c.get("user");
    const id = c.req.param("id");
    if (id === me.id) throw new HttpError(400, "SELF", "You cannot disable yourself");
    await db(c.env).update(users).set({ disabledAt: Date.now(), updatedAt: Date.now() }).where(and(eq(users.id, id), eq(users.orgId, me.orgId)));
    await destroyUserSessions(c.env, id);
    await db(c.env).insert(auditLog).values({ orgId: me.orgId, actorId: me.id, action: "admin.user_disabled", target: id });
    return c.json({ ok: true });
  })
  .post("/users/:id/enable", async (c) => {
    const me = c.get("user");
    await db(c.env).update(users).set({ disabledAt: null, updatedAt: Date.now() }).where(and(eq(users.id, c.req.param("id")), eq(users.orgId, me.orgId)));
    return c.json({ ok: true });
  })

  // ---- AI provider (owner decision: configured here, not in env). One enabled provider + model serves every call. ----
  .get("/ai", async (c) => {
    const orgId = c.get("user").orgId;
    const [providers, recent] = await Promise.all([
      db(c.env).select().from(aiProviders).where(eq(aiProviders.orgId, orgId)).orderBy(aiProviders.createdAt),
      db(c.env).select().from(aiCalls).where(eq(aiCalls.orgId, orgId)).orderBy(desc(aiCalls.createdAt)).limit(20),
    ]);
    return c.json({
      presets: PROVIDER_PRESETS,
      stubFallback: c.env.AI_ALLOW_STUB === "true",
      providers: providers.map((p) => ({ id: p.id, kind: p.kind, name: p.name, baseUrl: p.baseUrl, apiKeyHint: p.apiKeyHint, model: p.model, enabled: p.enabled })),
      recentCalls: recent,
    });
  })
  .post("/ai/providers", async (c) => {
    const body = await parseJson(
      c,
      z.object({ kind: ProviderKind, name: z.string().trim().min(1).max(64), baseUrl: z.string().url().optional(), apiKey: z.string().trim().min(8), model: z.string().trim().min(1).max(100), enabled: z.boolean().default(true) }),
    );
    const baseUrl = body.baseUrl || PROVIDER_PRESETS[body.kind].baseUrl;
    if (!baseUrl) throw new HttpError(400, "VALIDATION", "Custom providers need a base URL · 自定义提供方需要填写 Base URL");
    const me = c.get("user");
    const id = newId("aip");
    await db(c.env)
      .insert(aiProviders)
      .values({ id, orgId: me.orgId, kind: body.kind, name: body.name, baseUrl, model: body.model, apiKeySealed: await sealSecret(body.apiKey, secret(c.env, "AI_CONFIG_KEY")), apiKeyHint: maskSecret(body.apiKey), enabled: body.enabled });
    if (body.enabled) await disableOthers(c.env, me.orgId, id);
    await db(c.env).insert(auditLog).values({ orgId: me.orgId, actorId: me.id, action: "admin.ai_provider_created", target: id });
    return c.json({ id }, 201);
  })
  .patch("/ai/providers/:id", async (c) => {
    const body = await parseJson(
      c,
      z.object({ name: z.string().trim().min(1).max(64).optional(), baseUrl: z.string().url().optional(), apiKey: z.string().trim().min(8).optional(), model: z.string().trim().min(1).max(100).optional(), enabled: z.boolean().optional() }),
    );
    const me = c.get("user");
    const id = c.req.param("id");
    const patch: Partial<typeof aiProviders.$inferInsert> = { updatedAt: Date.now() };
    if (body.name) patch.name = body.name;
    if (body.baseUrl) patch.baseUrl = body.baseUrl;
    if (body.model) patch.model = body.model;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.apiKey) {
      patch.apiKeySealed = await sealSecret(body.apiKey, secret(c.env, "AI_CONFIG_KEY"));
      patch.apiKeyHint = maskSecret(body.apiKey);
    }
    const res = await db(c.env).update(aiProviders).set(patch).where(and(eq(aiProviders.id, id), eq(aiProviders.orgId, me.orgId))).returning({ id: aiProviders.id });
    if (!res.length) throw new HttpError(404, "NOT_FOUND", "Provider not found");
    if (body.enabled) await disableOthers(c.env, me.orgId, id);
    return c.json({ ok: true });
  })
  .delete("/ai/providers/:id", async (c) => {
    const me = c.get("user");
    await db(c.env).delete(aiProviders).where(and(eq(aiProviders.id, c.req.param("id")), eq(aiProviders.orgId, me.orgId)));
    return c.json({ ok: true });
  })
  .post("/ai/providers/:id/test", async (c) => {
    const me = c.get("user");
    const body = await parseJson(c, z.object({ model: z.string().min(1).optional() }).default({}));
    const row = (await db(c.env).select().from(aiProviders).where(and(eq(aiProviders.id, c.req.param("id")), eq(aiProviders.orgId, me.orgId))).limit(1))[0];
    if (!row) throw new HttpError(404, "NOT_FOUND", "Provider not found");
    const provider = { id: row.id, kind: row.kind, name: row.name, baseUrl: row.baseUrl, apiKey: await openSecret(row.apiKeySealed, secret(c.env, "AI_CONFIG_KEY")) };
    return c.json(await testProvider(provider, body.model ?? row.model));
  });

async function disableOthers(env: Env, orgId: string, keepId: string): Promise<void> {
  await db(env).update(aiProviders).set({ enabled: false, updatedAt: Date.now() }).where(and(eq(aiProviders.orgId, orgId), ne(aiProviders.id, keepId)));
}
