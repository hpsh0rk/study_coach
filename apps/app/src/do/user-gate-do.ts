import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";

export type QuotaKind = "ingest" | "generate";

const LIMITS: Record<QuotaKind, number> = { ingest: 1, generate: 1 };
const LEASE_MS: Record<QuotaKind, number> = { ingest: 60 * 60_000, generate: 30 * 60_000 };

/** Per-user concurrency quota (plan §10). Leases expire so a crashed job cannot block a teacher forever. */
export class UserGateDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, kind TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  }

  async acquire(kind: QuotaKind, leaseId: string): Promise<{ ok: boolean; active: number; limit: number }> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec("DELETE FROM leases WHERE expires_at < ?", now);
    const active = (sql.exec("SELECT COUNT(*) AS n FROM leases WHERE kind = ?", kind).one().n as number) ?? 0;
    if (active >= LIMITS[kind]) return { ok: false, active, limit: LIMITS[kind] };
    sql.exec("INSERT OR REPLACE INTO leases (id, kind, expires_at) VALUES (?, ?, ?)", leaseId, kind, now + LEASE_MS[kind]);
    return { ok: true, active: active + 1, limit: LIMITS[kind] };
  }

  async release(leaseId: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE id = ?", leaseId);
  }
}
