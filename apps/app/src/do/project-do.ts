import { DurableObject } from "cloudflare:workers";
import { DEFAULT_THEME, getTheme, newId, outlineContentHash, Slide, type Deck, type OutlineItem } from "@kj/schema";
import type { Env } from "../env.ts";

export type GateCode = "NO_OUTLINE" | "OUTLINE_NOT_CONFIRMED" | "THEME_NOT_LOCKED" | "UNKNOWN_ITEMS" | "GENERATION_IN_PROGRESS" | "RUN_NOT_FOUND" | "OUTLINE_CHANGED";
export type GateResult<T> = ({ ok: true } & T) | { ok: false; code: GateCode; message: string };

export interface ScopeChapter {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  childTitles: string[];
}

export interface OutlineState {
  id: string;
  version: number;
  items: OutlineItem[];
  contentHash: string;
  source: string;
  createdAt: number;
  confirmation: { id: string; confirmedBy: string; at: number } | null;
}

export interface RunState {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  itemIds: string[];
  outlineVersionId: string;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface ProjectState {
  projectId: string;
  scope: { documentId: string; chapterIds: string[]; at: number } | null;
  outline: OutlineState | null;
  themeLock: { themeId: string; themeVersion: number; lockedBy: string; at: number } | null;
  runs: RunState[];
  deck: { version: number; slideCount: number } | null;
}

export type ProjectEvent =
  | { type: "state" }
  | { type: "ingest"; documentId: string; status: string; message?: string }
  | { type: "run"; runId: string; status: string; itemId?: string; message?: string }
  | { type: "deck"; version: number; slideCount: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scope (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, chapter_ids TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outline_versions (id TEXT PRIMARY KEY, version INTEGER NOT NULL UNIQUE, items TEXT NOT NULL, content_hash TEXT NOT NULL, source TEXT NOT NULL, document_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outline_confirmations (id TEXT PRIMARY KEY, version_id TEXT NOT NULL, content_hash TEXT NOT NULL, confirmed_by TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS theme_lock (id INTEGER PRIMARY KEY CHECK (id = 1), theme_id TEXT NOT NULL, theme_version INTEGER NOT NULL, locked_by TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS generation_runs (id TEXT PRIMARY KEY, outline_version_id TEXT NOT NULL, confirmation_id TEXT NOT NULL, item_ids TEXT NOT NULL, status TEXT NOT NULL, workflow_instance_id TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER, error TEXT);
CREATE TABLE IF NOT EXISTS deck (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deck_versions (version INTEGER PRIMARY KEY, json TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

type Row = Record<string, SqlStorageValue>;

/**
 * One instance per lesson project (plan D2). Single-threaded, so the outline gate check and the
 * creation of a generation run happen atomically (plan D10, Case 2).
 */
export class ProjectDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  private rows(query: string, ...args: SqlStorageValue[]): Row[] {
    return this.sql.exec(query, ...args).toArray() as Row[];
  }

  private first(query: string, ...args: SqlStorageValue[]): Row | undefined {
    return this.rows(query, ...args)[0];
  }

  async init(projectId: string, orgId: string, title: string): Promise<void> {
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('projectId', ?), ('orgId', ?), ('title', ?)", projectId, orgId, title);
  }

  private meta(key: string): string {
    return String(this.first("SELECT value FROM meta WHERE key = ?", key)?.value ?? "");
  }

  private latestOutline(): OutlineState | null {
    const row = this.first("SELECT * FROM outline_versions ORDER BY version DESC LIMIT 1");
    if (!row) return null;
    const conf = this.first(
      "SELECT * FROM outline_confirmations WHERE version_id = ? AND content_hash = ? ORDER BY at DESC LIMIT 1",
      row.id as string,
      row.content_hash as string,
    );
    return {
      id: row.id as string,
      version: row.version as number,
      items: JSON.parse(row.items as string) as OutlineItem[],
      contentHash: row.content_hash as string,
      source: row.source as string,
      createdAt: row.created_at as number,
      confirmation: conf ? { id: conf.id as string, confirmedBy: conf.confirmed_by as string, at: conf.at as number } : null,
    };
  }

  private themeLock(): ProjectState["themeLock"] {
    const row = this.first("SELECT * FROM theme_lock WHERE id = 1");
    return row ? { themeId: row.theme_id as string, themeVersion: row.theme_version as number, lockedBy: row.locked_by as string, at: row.at as number } : null;
  }

  private runRow(row: Row): RunState {
    return {
      id: row.id as string,
      status: row.status as RunState["status"],
      itemIds: JSON.parse(row.item_ids as string),
      outlineVersionId: row.outline_version_id as string,
      createdAt: row.created_at as number,
      finishedAt: (row.finished_at as number | null) ?? null,
      error: (row.error as string | null) ?? null,
    };
  }

  async getState(): Promise<ProjectState> {
    const scopeRow = this.first("SELECT * FROM scope ORDER BY id DESC LIMIT 1");
    const deckRow = this.first("SELECT json, version FROM deck WHERE id = 1");
    return {
      projectId: this.meta("projectId"),
      scope: scopeRow ? { documentId: scopeRow.document_id as string, chapterIds: JSON.parse(scopeRow.chapter_ids as string), at: scopeRow.created_at as number } : null,
      outline: this.latestOutline(),
      themeLock: this.themeLock(),
      runs: this.rows("SELECT * FROM generation_runs ORDER BY created_at DESC LIMIT 5").map((r) => this.runRow(r)),
      deck: deckRow ? { version: deckRow.version as number, slideCount: (JSON.parse(deckRow.json as string) as Deck).slides.length } : null,
    };
  }

  /**
   * M1a-1 "fixed outline": one outline item per selected chapter, points = its sub-section titles.
   * Every scope change produces a new outline version, which invalidates any earlier confirmation.
   */
  async setScope(documentId: string, chapters: ScopeChapter[]): Promise<OutlineState> {
    const sorted = [...chapters].sort((a, b) => a.pageStart - b.pageStart);
    const items: OutlineItem[] = sorted.map((ch) => ({
      id: newId("oi"),
      kind: "content",
      title: ch.title.replace(/\s+/g, " ").trim(),
      points: ch.childTitles.map((t) => t.replace(/^\d+(\.\d+)*\s+/, "").trim()).slice(0, 5),
      chapterIds: [ch.id],
      pageRange: [ch.pageStart, ch.pageEnd],
    }));
    const hash = await outlineContentHash(items);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO scope (document_id, chapter_ids, created_at) VALUES (?, ?, ?)", documentId, JSON.stringify(sorted.map((c) => c.id)), now);
      const next = ((this.first("SELECT MAX(version) AS v FROM outline_versions")?.v as number | null) ?? 0) + 1;
      this.sql.exec(
        "INSERT INTO outline_versions (id, version, items, content_hash, source, document_id, created_at) VALUES (?, ?, ?, ?, 'fixed', ?, ?)",
        newId("ol"),
        next,
        JSON.stringify(items),
        hash,
        documentId,
        now,
      );
    });
    this.broadcast({ type: "state" });
    return this.latestOutline()!;
  }

  async confirmOutline(versionId: string, userId: string): Promise<GateResult<{ confirmationId: string }>> {
    const result = this.ctx.storage.transactionSync((): GateResult<{ confirmationId: string }> => {
      const latest = this.latestOutline();
      if (!latest) return { ok: false, code: "NO_OUTLINE", message: "No outline yet" };
      if (latest.id !== versionId) return { ok: false, code: "OUTLINE_CHANGED", message: "The outline changed; review the latest version" };
      if (latest.confirmation) return { ok: true, confirmationId: latest.confirmation.id };
      const id = newId("olc");
      this.sql.exec("INSERT INTO outline_confirmations (id, version_id, content_hash, confirmed_by, at) VALUES (?, ?, ?, ?, ?)", id, latest.id, latest.contentHash, userId, Date.now());
      return { ok: true, confirmationId: id };
    });
    this.broadcast({ type: "state" });
    return result;
  }

  async lockTheme(themeId: string, userId: string): Promise<GateResult<{ themeId: string }>> {
    const theme = getTheme(themeId);
    if (!theme) return { ok: false, code: "THEME_NOT_LOCKED", message: `Unknown theme ${themeId}` };
    this.sql.exec(
      "INSERT INTO theme_lock (id, theme_id, theme_version, locked_by, at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET theme_id = excluded.theme_id, theme_version = excluded.theme_version, locked_by = excluded.locked_by, at = excluded.at",
      theme.id,
      theme.version,
      userId,
      Date.now(),
    );
    this.broadcast({ type: "state" });
    return { ok: true, themeId: theme.id };
  }

  /** The only way to start generation (gate layer 1). */
  async startGeneration(input: { userId: string; orgId: string; itemIds?: string[]; leaseId?: string }): Promise<GateResult<{ runId: string; itemIds: string[] }>> {
    const projectId = this.meta("projectId");
    const check = this.ctx.storage.transactionSync((): GateResult<{ runId: string; itemIds: string[]; outlineVersionId: string; gateToken: string }> => {
      const outline = this.latestOutline();
      if (!outline) return { ok: false, code: "NO_OUTLINE", message: "Create an outline first · 请先生成大纲" };
      if (!outline.confirmation) return { ok: false, code: "OUTLINE_NOT_CONFIRMED", message: "Confirm the outline before generating · 请先确认大纲" };
      if (!this.themeLock()) return { ok: false, code: "THEME_NOT_LOCKED", message: "Lock a theme before generating · 请先锁定模板" };
      const known = new Set(outline.items.map((i) => i.id));
      const itemIds = input.itemIds?.length ? input.itemIds : outline.items.slice(0, 1).map((i) => i.id);
      if (itemIds.some((id) => !known.has(id))) return { ok: false, code: "UNKNOWN_ITEMS", message: "Items are not in the confirmed outline" };
      if (this.first("SELECT id FROM generation_runs WHERE status IN ('queued', 'running') LIMIT 1")) {
        return { ok: false, code: "GENERATION_IN_PROGRESS", message: "A generation run is already in progress · 正在生成中" };
      }
      const runId = newId("run");
      this.sql.exec(
        "INSERT INTO generation_runs (id, outline_version_id, confirmation_id, item_ids, status, created_by, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
        runId,
        outline.id,
        outline.confirmation.id,
        JSON.stringify(itemIds),
        input.userId,
        Date.now(),
      );
      return { ok: true, runId, itemIds, outlineVersionId: outline.id, gateToken: outline.confirmation.id };
    });
    if (!check.ok) return check;
    try {
      const instance = await this.env.GENERATE_WF.create({
        id: check.runId,
        params: { projectId, orgId: input.orgId, userId: input.userId, runId: check.runId, outlineVersionId: check.outlineVersionId, gateToken: check.gateToken, itemIds: check.itemIds, ...(input.leaseId ? { leaseId: input.leaseId } : {}) },
      });
      this.sql.exec("UPDATE generation_runs SET workflow_instance_id = ? WHERE id = ?", instance.id, check.runId);
    } catch (err) {
      this.sql.exec("UPDATE generation_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", String(err), Date.now(), check.runId);
      throw err;
    }
    this.broadcast({ type: "run", runId: check.runId, status: "queued" });
    return { ok: true, runId: check.runId, itemIds: check.itemIds };
  }

  /** Gate layer 2: every GenerateWF step re-checks the gate (outline may change while queued). */
  async assertGate(
    runId: string,
    outlineVersionId: string,
    itemId: string,
  ): Promise<GateResult<{ item: OutlineItem; documentId: string | null; themeId: string }>> {
    const run = this.first("SELECT * FROM generation_runs WHERE id = ?", runId);
    if (!run) return { ok: false, code: "RUN_NOT_FOUND", message: "Unknown generation run" };
    const outline = this.latestOutline();
    if (!outline) return { ok: false, code: "NO_OUTLINE", message: "No outline" };
    if (outline.id !== outlineVersionId || run.outline_version_id !== outline.id) return { ok: false, code: "OUTLINE_CHANGED", message: "Outline changed after the run started" };
    if (!outline.confirmation || outline.confirmation.id !== run.confirmation_id) return { ok: false, code: "OUTLINE_NOT_CONFIRMED", message: "Outline is no longer confirmed" };
    const lock = this.themeLock();
    if (!lock) return { ok: false, code: "THEME_NOT_LOCKED", message: "Theme not locked" };
    const item = outline.items.find((i) => i.id === itemId);
    if (!item || !(JSON.parse(run.item_ids as string) as string[]).includes(itemId)) return { ok: false, code: "UNKNOWN_ITEMS", message: "Item not in this run" };
    const doc = this.first("SELECT document_id FROM outline_versions WHERE id = ?", outline.id);
    return { ok: true, item, documentId: (doc?.document_id as string | null) ?? null, themeId: lock.themeId };
  }

  /** Gate layer 3: the AI capability layer verifies tokens here before calling a model. */
  async verifyGateToken(gateToken: string): Promise<boolean> {
    const outline = this.latestOutline();
    return !!outline?.confirmation && outline.confirmation.id === gateToken;
  }

  async markRun(runId: string, status: RunState["status"], error?: string): Promise<void> {
    const finished = status === "done" || status === "failed" ? Date.now() : null;
    this.sql.exec("UPDATE generation_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?", status, error ?? null, finished, runId);
    this.broadcast({ type: "run", runId, status, ...(error ? { message: error } : {}) });
  }

  async commitSlide(runId: string, outlineVersionId: string, slideInput: unknown): Promise<{ version: number; slideCount: number }> {
    const slide = Slide.parse(slideInput);
    const outline = this.latestOutline();
    const order = new Map((outline?.items ?? []).map((it, i) => [it.id, i]));
    const result = this.ctx.storage.transactionSync(() => {
      const row = this.first("SELECT json, version FROM deck WHERE id = 1");
      const lock = this.themeLock();
      const deck: Deck = row
        ? (JSON.parse(row.json as string) as Deck)
        : {
            id: newId("deck"),
            schemaVersion: 2,
            projectId: this.meta("projectId"),
            version: 0,
            title: this.meta("title"),
            theme: { themeId: lock?.themeId ?? DEFAULT_THEME.id, themeVersion: lock?.themeVersion ?? DEFAULT_THEME.version },
            outlineVersionId,
            slides: [],
          };
      deck.outlineVersionId = outlineVersionId;
      deck.slides = deck.slides.filter((s) => s.outlineItemId !== slide.outlineItemId);
      deck.slides.push(slide);
      deck.slides.sort((a, b) => (order.get(a.outlineItemId) ?? 1e9) - (order.get(b.outlineItemId) ?? 1e9));
      deck.version += 1;
      const json = JSON.stringify(deck);
      this.sql.exec("INSERT INTO deck (id, json, version) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, version = excluded.version", json, deck.version);
      this.sql.exec("INSERT INTO deck_versions (version, json, reason, created_at) VALUES (?, ?, ?, ?)", deck.version, json, `run:${runId}`, Date.now());
      return { version: deck.version, slideCount: deck.slides.length };
    });
    await this.env.DB.prepare("UPDATE projects SET slide_count = ?, deck_version = ?, updated_at = ? WHERE id = ?")
      .bind(result.slideCount, result.version, Date.now(), this.meta("projectId"))
      .run();
    this.broadcast({ type: "deck", ...result });
    return result;
  }

  async getDeck(): Promise<Deck | null> {
    const row = this.first("SELECT json FROM deck WHERE id = 1");
    return row ? (JSON.parse(row.json as string) as Deck) : null;
  }

  async notify(event: ProjectEvent): Promise<void> {
    this.broadcast(event);
  }

  private broadcast(event: ProjectEvent): void {
    const msg = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // Socket already closing; hibernation API cleans it up.
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "state" } satisfies ProjectEvent));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") ws.send("pong");
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(code === 1005 ? 1000 : code, "closing");
  }
}
