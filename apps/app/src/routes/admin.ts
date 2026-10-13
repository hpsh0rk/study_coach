import { and, count, desc, eq, isNull, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { maskSecret, openSecret, PROVIDER_PRESETS, ProviderKind, ProviderProtocol, sealSecret, testProvider, testVision } from "@kj/ai";
import { newId } from "@kj/schema";
import { aiCalls, aiProviders, auditLog, lessons, users } from "../db/schema.ts";
import { secret, type AppBindings, type Env } from "../env.ts";
import { HttpError, parseJson } from "../http.ts";
import { generatePassword, hashPassword, passwordProblem } from "../auth/password.ts";
import { destroyUserSessions, requireAdmin, requireUser } from "../auth/session.ts";
import { db } from "../db/index.ts";
import { dailyModelCalls, modelCallsToday, providerConfigOf, visionModelOf } from "../ai.ts";
import { textbookCount } from "../textbook/index.ts";
import {
  effectiveMode,
  externalState,
  maskUrl,
  normalizeBaseUrl,
  PARSE_LIMITS,
  parserSettingsOf,
  parseUsageToday,
  saveParserSettings,
  testExternalConnection,
  visionPriceOf,
} from "../textbook/parsers/settings.ts";

const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, "3-32 chars: letters, digits, . _ -");

/** "" removes it. */
/** Custom request headers a gateway may need; the transport headers stay ours. */
const HeaderMap = z
  .record(
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,64}$/)
      .refine((n) => !["authorization", "content-type", "content-length", "host", "accept"].includes(n.toLowerCase()), "reserved header"),
    z.string().trim().max(500),
  )
  .refine((h) => Object.keys(h).length <= 10, "at most 10 headers");

const MaxTokens = z.number().int().min(16).max(1_000_000);

/** Sealed JSON plus a hint of two characters per value (values can be short words); an empty map stores nothing. */
async function sealHeaders(env: Env, headers: Record<string, string>): Promise<{ headersSealed: string; headersHint: string }> {
  const entries = Object.entries(headers).filter(([, v]) => v);
  if (!entries.length) return { headersSealed: "", headersHint: "{}" };
  return {
    headersSealed: await sealSecret(JSON.stringify(Object.fromEntries(entries)), secret(env, "AI_CONFIG_KEY")),
    headersHint: JSON.stringify(Object.fromEntries(entries.map(([k, v]) => [k, `${v.slice(0, 2)}••••`]))),
  };
}

const VisionModel = z.string().trim().max(100);

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
  /** The 20 newest audit entries (logins, password changes, account and model changes, lesson deletes). */
  .get("/audit", async (c) => {
    const rows = await db(c.env)
      .select({ id: auditLog.id, action: auditLog.action, target: auditLog.target, createdAt: auditLog.createdAt, actor: users.username })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(eq(auditLog.orgId, c.get("user").orgId))
      .orderBy(desc(auditLog.id))
      .limit(20);
    return c.json({ entries: rows });
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

  /** "概览": what each key-backed feature does now and what it still lacks, plus a few counts. Names and model ids only, no secret or URL. */
  .get("/status", async (c) => {
    const orgId = c.get("user").orgId;
    const [providers, settings, userCount, lessonCount, textbooks, usage, modelCalls] = await Promise.all([
      db(c.env)
        .select({ purpose: aiProviders.purpose, name: aiProviders.name, model: aiProviders.model, visionModel: aiProviders.visionModel })
        .from(aiProviders)
        .where(and(eq(aiProviders.orgId, orgId), eq(aiProviders.enabled, true), ne(aiProviders.model, ""))),
      parserSettingsOf(c.env, orgId),
      db(c.env).select({ n: count() }).from(users).where(and(eq(users.orgId, orgId), isNull(users.disabledAt))),
      db(c.env).select({ n: count() }).from(lessons).where(and(eq(lessons.orgId, orgId), isNull(lessons.archivedAt))),
      textbookCount(c.env, orgId),
      parseUsageToday(c.env, orgId),
      modelCallsToday(c.env, orgId),
    ]);
    const text = providers.find((p) => p.purpose === "text");
    const vision = providers.find((p) => p.purpose === "vision");
    const visionModel = vision?.model || text?.visionModel || "";
    const visionPaidOff = !!visionModel && visionPriceOf(visionModel, settings).microYuanPerPage > 0 && !settings.paidEnabled;
    return c.json({
      ai: text ? { state: "live", provider: text.name, model: text.model } : { state: c.env.AI_ALLOW_STUB === "true" ? "stub" : "off" },
      vision: visionModel ? { state: visionPaidOff ? "paid_off" : "on", provider: (vision ?? text)!.name, model: visionModel, separate: !!vision } : { state: "none" },
      external: { ...externalState(c.env, settings), mode: settings.mineruMode, stub: effectiveMode(c.env, settings) === "stub" },
      counts: { users: userCount[0]?.n ?? 0, textbooks, lessons: lessonCount[0]?.n ?? 0, parsedPagesToday: usage.org, modelCallsToday: modelCalls, modelCallsPerDay: dailyModelCalls(c.env) },
    });
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
      providers: providers.map((p) => ({
        id: p.id,
        purpose: p.purpose,
        kind: p.kind,
        protocol: p.protocol,
        name: p.name,
        baseUrl: p.baseUrl,
        apiKeyHint: p.apiKeyHint,
        model: p.model,
        visionModel: p.visionModel,
        maxTokens: p.maxTokens,
        headerHints: JSON.parse(p.headersHint) as Record<string, string>,
        enabled: p.enabled,
      })),
      recentCalls: recent,
    });
  })
  .post("/ai/providers", async (c) => {
    const body = await parseJson(
      c,
      z.object({
        kind: ProviderKind,
        name: z.string().trim().min(1).max(64),
        baseUrl: z.string().url().optional(),
        apiKey: z.string().trim().min(8),
        model: z.string().trim().min(1).max(100),
        visionModel: VisionModel.default(""),
        /** `vision`: a separate provider that only reads page images; `model` is its vision model. */
        purpose: z.enum(["text", "vision"]).default("text"),
        protocol: ProviderProtocol.default("openai"),
        maxTokens: MaxTokens.nullable().default(null),
        headers: HeaderMap.default({}),
        enabled: z.boolean().default(true),
      }),
    );
    if (body.purpose === "vision" && body.visionModel) throw new HttpError(400, "VALIDATION", "A vision provider's model is its vision model · 单独的看图模型只填“模型”");
    const baseUrl = body.baseUrl || PROVIDER_PRESETS[body.kind].baseUrl;
    if (!baseUrl) throw new HttpError(400, "VALIDATION", "Custom providers need a base URL · 自定义提供方需要填写 Base URL");
    const me = c.get("user");
    const id = newId("aip");
    await db(c.env)
      .insert(aiProviders)
      .values({
        id,
        orgId: me.orgId,
        purpose: body.purpose,
        kind: body.kind,
        protocol: body.protocol,
        name: body.name,
        baseUrl,
        model: body.model,
        visionModel: body.visionModel,
        maxTokens: body.maxTokens,
        ...(await sealHeaders(c.env, body.headers)),
        apiKeySealed: await sealSecret(body.apiKey, secret(c.env, "AI_CONFIG_KEY")),
        apiKeyHint: maskSecret(body.apiKey),
        enabled: body.enabled,
      });
    if (body.enabled) await disableOthers(c.env, me.orgId, id, body.purpose);
    await db(c.env).insert(auditLog).values({ orgId: me.orgId, actorId: me.id, action: "admin.ai_provider_created", target: id });
    return c.json({ id }, 201);
  })
  .patch("/ai/providers/:id", async (c) => {
    const body = await parseJson(
      c,
      z.object({
        name: z.string().trim().min(1).max(64).optional(),
        baseUrl: z.string().url().optional(),
        apiKey: z.string().trim().min(8).optional(),
        model: z.string().trim().min(1).max(100).optional(),
        visionModel: VisionModel.optional(),
        protocol: ProviderProtocol.optional(),
        maxTokens: MaxTokens.nullable().optional(),
        /** The full set of headers to keep; a blank value keeps that header's stored value. */
        headers: HeaderMap.optional(),
        enabled: z.boolean().optional(),
      }),
    );
    const me = c.get("user");
    const id = c.req.param("id");
    const row = (
      await db(c.env)
        .select({ baseUrl: aiProviders.baseUrl, protocol: aiProviders.protocol, sealed: aiProviders.headersSealed })
        .from(aiProviders)
        .where(and(eq(aiProviders.id, id), eq(aiProviders.orgId, me.orgId)))
        .limit(1)
    )[0];
    if (!row) throw new HttpError(404, "NOT_FOUND", "Provider not found");
    // The stored key and header values only ever go where the admin first sent them: a new address or protocol
    // needs the key typed again, and stored header values are dropped.
    const moved = (body.baseUrl !== undefined && body.baseUrl !== row.baseUrl) || (body.protocol !== undefined && body.protocol !== row.protocol);
    if (moved && !body.apiKey) throw new HttpError(400, "KEY_REQUIRED", "改了 Base URL 或接口协议，请重新填写 API Key · Re-enter the API key when the address or protocol changes");
    const patch: Partial<typeof aiProviders.$inferInsert> = { updatedAt: Date.now() };
    if (body.protocol) patch.protocol = body.protocol;
    if (body.maxTokens !== undefined) patch.maxTokens = body.maxTokens;
    if (body.headers || moved) {
      const stored = row.sealed && !moved ? (JSON.parse(await openSecret(row.sealed, secret(c.env, "AI_CONFIG_KEY"))) as Record<string, string>) : {};
      Object.assign(patch, await sealHeaders(c.env, Object.fromEntries(Object.entries(body.headers ?? {}).map(([k, v]) => [k, v || stored[k] || ""]))));
    }
    if (body.name) patch.name = body.name;
    if (body.baseUrl) patch.baseUrl = body.baseUrl;
    if (body.model) patch.model = body.model;
    if (body.visionModel !== undefined) patch.visionModel = body.visionModel;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.apiKey) {
      patch.apiKeySealed = await sealSecret(body.apiKey, secret(c.env, "AI_CONFIG_KEY"));
      patch.apiKeyHint = maskSecret(body.apiKey);
    }
    const res = await db(c.env).update(aiProviders).set(patch).where(and(eq(aiProviders.id, id), eq(aiProviders.orgId, me.orgId))).returning({ id: aiProviders.id, purpose: aiProviders.purpose });
    if (!res.length) throw new HttpError(404, "NOT_FOUND", "Provider not found");
    if (body.enabled) await disableOthers(c.env, me.orgId, id, res[0]!.purpose);
    return c.json({ ok: true });
  })
  .delete("/ai/providers/:id", async (c) => {
    const me = c.get("user");
    await db(c.env).delete(aiProviders).where(and(eq(aiProviders.id, c.req.param("id")), eq(aiProviders.orgId, me.orgId)));
    return c.json({ ok: true });
  })
  .post("/ai/providers/:id/test", async (c) => {
    const me = c.get("user");
    /** `vision`: send one tiny image to the vision model instead of a text prompt to the model. */
    const body = await parseJson(c, z.object({ model: z.string().min(1).optional(), vision: z.boolean().default(false) }).default({ vision: false }));
    const row = (await db(c.env).select().from(aiProviders).where(and(eq(aiProviders.id, c.req.param("id")), eq(aiProviders.orgId, me.orgId))).limit(1))[0];
    if (!row) throw new HttpError(404, "NOT_FOUND", "Provider not found");
    const provider = await providerConfigOf(c.env, row);
    const vision = body.vision || row.purpose === "vision";
    if (!vision) return c.json(await testProvider(provider, body.model ?? row.model));
    const model = body.model ?? (row.purpose === "vision" ? row.model : row.visionModel);
    if (!model) throw new HttpError(400, "VALIDATION", "这个模型没有配置看图模型 · No vision model on this provider");
    return c.json(await testVision(provider, model));
  })
  // ---- external parser ----
  /**
   * "外部解析服务": whether pages the browser could not read (scans, formulas drawn as outlines, garbled text)
   * go to MinerU (online API or the school's own server). `auto` turns it on once the chosen API is configured.
   * Secrets (token, self-host URL and key) come back as hints only.
   */
  .get("/parsing", async (c) => {
    const orgId = c.get("user").orgId;
    const [settings, today, visionModel] = await Promise.all([parserSettingsOf(c.env, orgId), parseUsageToday(c.env, orgId), visionModelOf(c.env, orgId)]);
    return c.json({
      externalChoice: settings.externalChoice,
      external: externalState(c.env, settings),
      mineruMode: settings.mineruMode,
      tokenHint: settings.mineruTokenHint,
      envToken: !!c.env.MINERU_API_TOKEN,
      selfhostUrlHint: settings.selfhostUrlHint,
      selfhostKeyHint: settings.selfhostKeyHint,
      stub: effectiveMode(c.env, settings) === "stub",
      limits: PARSE_LIMITS,
      today,
      paidEnabled: settings.paidEnabled,
      monthlyBudgetMicroYuan: settings.monthlyBudgetMicroYuan,
      vision: visionModel ? { model: visionModel, ...visionPriceOf(visionModel, settings) } : null,
    });
  })
  /** Money in micro-yuan (1 元 = 1,000,000). Secrets: a string to store, null to remove, absent to keep. */
  .put("/parsing", async (c) => {
    const body = await parseJson(
      c,
      z.object({
        externalChoice: z.enum(["auto", "on", "off"]).optional(),
        mineruMode: z.enum(["agent", "token", "selfhost"]).optional(),
        token: z.string().trim().min(8).max(4000).nullable().optional(),
        selfhostUrl: z
          .string()
          .trim()
          .url()
          .max(500)
          .refine((u) => /^https?:\/\//i.test(u), "http(s) URL")
          .nullable()
          .optional(),
        selfhostKey: z.string().trim().min(1).max(4000).nullable().optional(),
        paidEnabled: z.boolean().optional(),
        monthlyBudgetMicroYuan: z.number().int().min(0).max(10_000 * 1_000_000).optional(),
        visionPriceMicroYuan: z.number().int().min(0).max(1_000_000).nullable().optional(),
      }),
    );
    const me = c.get("user");
    const key = secret(c.env, "AI_CONFIG_KEY");
    const seal = async (plain: string | null | undefined, hint: (s: string) => string) =>
      plain === undefined ? undefined : plain === null ? null : { sealed: await sealSecret(plain, key), hint: hint(plain) };
    const { token, selfhostUrl, selfhostKey, ...rest } = body;
    const url = selfhostUrl ? normalizeBaseUrl(selfhostUrl) : selfhostUrl;
    if (url && selfhostKey === undefined) {
      const stored = await parserSettingsOf(c.env, me.orgId);
      if (stored.selfhostKeySealed && (!stored.selfhostUrlSealed || (await openSecret(stored.selfhostUrlSealed, key)) !== url)) {
        throw new HttpError(400, "KEY_REQUIRED", "改了自部署地址，请重新填写 API Key（不需要 Key 就先删除已保存的 Key）· Re-enter the API key when the address changes");
      }
    }
    await saveParserSettings(c.env, me, {
      ...rest,
      token: await seal(token, maskSecret),
      selfhostUrl: await seal(url, maskUrl),
      selfhostKey: await seal(selfhostKey, maskSecret),
    });
    const target =
      body.externalChoice !== undefined
        ? `external_${body.externalChoice}`
        : body.mineruMode !== undefined
          ? `mode_${body.mineruMode}`
          : body.paidEnabled !== undefined
            ? body.paidEnabled
              ? "paid_on"
              : "paid_off"
            : selfhostUrl !== undefined || selfhostKey !== undefined
              ? "selfhost"
              : token !== undefined
                ? "token"
                : "settings";
    await db(c.env).insert(auditLog).values({ orgId: me.orgId, actorId: me.id, action: "admin.parser_settings", target });
    return c.json({ ok: true });
  })
  /** "测试连接" for the chosen MinerU API, whether or not the switch is on. Sends no page. */
  .post("/parsing/test", async (c) => {
    return c.json(await testExternalConnection(c.env, await parserSettingsOf(c.env, c.get("user").orgId)));
  });

async function disableOthers(env: Env, orgId: string, keepId: string, purpose: "text" | "vision"): Promise<void> {
  await db(env)
    .update(aiProviders)
    .set({ enabled: false, updatedAt: Date.now() })
    .where(and(eq(aiProviders.orgId, orgId), eq(aiProviders.purpose, purpose), ne(aiProviders.id, keepId)));
}
