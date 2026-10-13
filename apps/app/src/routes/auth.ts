import { and, count, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { auditLog, loginAttempts, users } from "../db/schema.ts";
import type { AppBindings, Env } from "../env.ts";
import { HttpError, parseJson } from "../http.ts";
import { DUMMY_HASH, hashPassword, needsRehash, passwordProblem, verifyPassword } from "../auth/password.ts";
import { createSession, destroySession, destroyUserSessions, loadSessionUser, requireUser } from "../auth/session.ts";
import { db } from "../db/index.ts";
import { aiMode } from "../ai.ts";

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 8;
/** Per IP, and per username from that IP only: a stranger's wrong guesses never lock the real user out. */
const attemptKeys = (ip: string, username: string) => [`ip:${ip}`, `u:${ip}:${username}`];

async function tooManyAttempts(env: Env, keys: string[]): Promise<boolean> {
  const rows = await db(env)
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(inArray(loginAttempts.key, keys), gt(loginAttempts.windowStart, Date.now() - WINDOW_MS), gte(loginAttempts.failures, MAX_FAILURES)));
  return (rows[0]?.n ?? 0) > 0;
}

/** One upsert per key, so concurrent failures all count. */
async function recordFailure(env: Env, keys: string[]): Promise<void> {
  const now = Date.now();
  const expired = sql`${loginAttempts.windowStart} <= ${now - WINDOW_MS}`;
  const d = db(env);
  const [first, ...rest] = keys.map((key) =>
    d
      .insert(loginAttempts)
      .values({ key, windowStart: now, failures: 1 })
      .onConflictDoUpdate({
        target: loginAttempts.key,
        set: {
          failures: sql`CASE WHEN ${expired} THEN 1 ELSE ${loginAttempts.failures} + 1 END`,
          windowStart: sql`CASE WHEN ${expired} THEN ${now} ELSE ${loginAttempts.windowStart} END`,
        },
      }),
  );
  await d.batch([first!, ...rest]);
}

export const authRoutes = new Hono<AppBindings>()
  .post("/login", async (c) => {
    const body = await parseJson(c, z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(200) }));
    const username = body.username.toLowerCase();
    const ip = c.req.header("cf-connecting-ip") ?? "local";
    const keys = attemptKeys(ip, username);
    if (await tooManyAttempts(c.env, keys)) throw new HttpError(429, "RATE_LIMITED", "Too many attempts, try again in 15 minutes · 尝试次数过多，请 15 分钟后再试");
    const user = (await db(c.env).select().from(users).where(eq(users.username, username)).limit(1))[0];
    const ok = (await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH)) && !!user && !user.disabledAt;
    if (!ok || !user) {
      await recordFailure(c.env, keys);
      throw new HttpError(401, "INVALID_CREDENTIALS", "Wrong username or password · 用户名或密码错误");
    }
    if (needsRehash(user.passwordHash)) {
      await db(c.env).update(users).set({ passwordHash: await hashPassword(body.password) }).where(eq(users.id, user.id));
    }
    await db(c.env).delete(loginAttempts).where(eq(loginAttempts.key, keys[1]!));
    await createSession(c, user.id);
    await db(c.env).insert(auditLog).values({ orgId: user.orgId, actorId: user.id, action: "auth.login" });
    return c.json({ user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role, mustChangePassword: user.mustChangePassword } });
  })
  .post("/logout", async (c) => {
    await destroySession(c);
    return c.json({ ok: true });
  })
  .get("/me", async (c) => {
    const user = await loadSessionUser(c);
    return c.json({ user, ai: user ? await aiMode(c.env, user.orgId) : null });
  })
  .post("/change-password", requireUser({ allowPasswordChange: true }), async (c) => {
    const body = await parseJson(c, z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) }));
    const me = c.get("user");
    const row = (await db(c.env).select().from(users).where(eq(users.id, me.id)).limit(1))[0]!;
    if (!(await verifyPassword(body.currentPassword, row.passwordHash))) throw new HttpError(400, "INVALID_CREDENTIALS", "Current password is wrong · 当前密码错误");
    const problem = passwordProblem(body.newPassword);
    if (problem) throw new HttpError(400, "WEAK_PASSWORD", problem);
    if (body.newPassword === body.currentPassword) throw new HttpError(400, "WEAK_PASSWORD", "Choose a different password · 新密码不能与旧密码相同");
    await db(c.env).update(users).set({ passwordHash: await hashPassword(body.newPassword), mustChangePassword: false, updatedAt: Date.now() }).where(eq(users.id, me.id));
    await destroyUserSessions(c.env, me.id);
    await createSession(c, me.id);
    await db(c.env).insert(auditLog).values({ orgId: me.orgId, actorId: me.id, action: "auth.password_changed" });
    return c.json({ ok: true });
  });
