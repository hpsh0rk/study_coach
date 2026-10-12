import { and, eq, gt, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomToken, sha256Hex } from "@kj/schema";
import { sessions, users } from "../db/schema.ts";
import type { AppBindings, Env, SessionUser } from "../env.ts";
import { HttpError } from "../http.ts";

export const SESSION_COOKIE = "kj_session";
const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;

export function db(env: Env) {
  return drizzle(env.DB);
}

export async function createSession(c: Context<AppBindings>, userId: string): Promise<void> {
  const token = randomToken(32);
  await db(c.env)
    .insert(sessions)
    .values({ id: await sha256Hex(token), userId, expiresAt: Date.now() + SESSION_TTL_MS, userAgent: c.req.header("user-agent")?.slice(0, 200) ?? null });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(c: Context<AppBindings>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await db(c.env).delete(sessions).where(eq(sessions.id, await sha256Hex(token)));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function destroyUserSessions(env: Env, userId: string): Promise<void> {
  await db(env).delete(sessions).where(eq(sessions.userId, userId));
}

export async function loadSessionUser(c: Context<AppBindings>): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const rows = await db(c.env)
    .select({
      id: users.id,
      orgId: users.orgId,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      mustChangePassword: users.mustChangePassword,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, await sha256Hex(token)), gt(sessions.expiresAt, Date.now()), isNull(users.disabledAt)))
    .limit(1);
  return rows[0] ?? null;
}

/** Requires a logged-in user who has already replaced the admin-issued initial password. */
export const requireUser =
  (opts: { allowPasswordChange?: boolean } = {}): MiddlewareHandler<AppBindings> =>
  async (c, next) => {
    const user = await loadSessionUser(c);
    if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Please log in · 请先登录");
    if (user.mustChangePassword && !opts.allowPasswordChange) throw new HttpError(403, "PASSWORD_CHANGE_REQUIRED", "Please change your initial password · 请先修改初始密码");
    c.set("user", user);
    await next();
  };

export const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.get("user")?.role !== "admin") throw new HttpError(403, "FORBIDDEN", "Admins only · 仅管理员");
  await next();
};

/**
 * CSRF: state-changing API calls must carry a custom header. Browsers cannot send it cross-site
 * without a CORS preflight, which this API never approves.
 */
export const csrfGuard: MiddlewareHandler<AppBindings> = async (c, next) => {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && c.req.header("x-kj-csrf") !== "1") {
    throw new HttpError(403, "CSRF", "Missing x-kj-csrf header");
  }
  await next();
};
