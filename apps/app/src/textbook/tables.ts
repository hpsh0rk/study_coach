import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { PageFlag } from "@kj/pdf-structure";
import type { PageKind } from "@kj/schema";
import { now, orgs, users } from "../db/accounts.ts";

/** Textbook tables: read and written only through apps/app/src/textbook (see .dependency-cruiser.cjs). */
export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgs.id),
    ownerId: text("owner_id").notNull().references(() => users.id),
    filename: text("filename").notNull(),
    title: text("title").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    pageCount: integer("page_count").notNull(),
    /** Pages received so far; the document is usable once it equals page_count. */
    pagesReceived: integer("pages_received").notNull().default(0),
    hasBookmarks: integer("has_bookmarks", { mode: "boolean" }).notNull(),
    /** sha256 of the PDF file (computed in the browser before parsing): the same book is parsed and stored once per teacher. Null for uploads before migration 0006. */
    fileSha256: text("file_sha256"),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    /** Soft delete, like lessons.archived_at: hidden from lists and new lessons; lessons made from it keep working. */
    archivedAt: integer("archived_at"),
  },
  (t) => [
    index("documents_owner_idx").on(t.orgId, t.ownerId),
    uniqueIndex("documents_owner_sha_uq").on(t.ownerId, t.fileSha256).where(sql`archived_at IS NULL AND file_sha256 IS NOT NULL`),
  ],
);

export const pages = sqliteTable(
  "pages",
  {
    documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    no: integer("no").notNull(),
    text: text("text").notNull(),
    /** Printed page label when it differs from the page index. */
    label: text("label"),
    words: integer("words").notNull().default(0),
    /** Facts about the stored text (pdf-structure `pageFacts`), so reads that only need sizes never load the text. */
    chars: integer("chars").notNull().default(0),
    /** Where the text came from: `pdfjs/1` or `paste` (see pdf-structure PDFJS_PARSER / PASTE_PARSER). */
    parser: text("parser").notNull().default("pdfjs/1"),
    /** Kinds of suspicious text on the page (`instruction`, `link`, `email`, `file`); `[]` for pages stored before migration 0007. */
    flags: text("flags", { mode: "json" }).$type<PageFlag[]>().notNull().default([]),
    /** What the browser's probe saw on the PDF page (pdf-structure `classifyPage`); null for pages stored before migration 0008. Stays when the text is later pasted: `parser` says whether it was fixed. */
    kind: text("kind").$type<PageKind>(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.no] })],
);

export const chapters = sqliteTable(
  "chapters",
  {
    documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    parentId: text("parent_id"),
    ord: integer("ord").notNull(),
    level: integer("level").notNull(),
    title: text("title").notNull(),
    pageStart: integer("page_start").notNull(),
    pageEnd: integer("page_end").notNull(),
    words: integer("words").notNull(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.id] })],
);

/** The admin switch "外部解析服务" per organisation. No row means off: pages leave the browser only after an admin turns it on. */
export const parserSettings = sqliteTable("parser_settings", {
  orgId: text("org_id").primaryKey().references(() => orgs.id),
  externalEnabled: integer("external_enabled", { mode: "boolean" }).notNull().default(false),
  /** `agent`: MinerU's token-free API (≤ 20 pages, 10 MB per file). `token`: the precise API with a MinerU token. */
  mineruMode: text("mineru_mode", { enum: ["agent", "token"] }).notNull().default("agent"),
  /** Sealed with AI_CONFIG_KEY like ai_providers.api_key_sealed; falls back to the MINERU_API_TOKEN secret. */
  mineruTokenSealed: text("mineru_token_sealed"),
  mineruTokenHint: text("mineru_token_hint"),
  /** "允许付费兜底": parsers that cost money (cost per page > 0) run only when on, and only within the monthly budget. */
  paidEnabled: integer("paid_enabled", { mode: "boolean" }).notNull().default(false),
  /** Per organisation and calendar month (China), in micro-yuan (1 元 = 1,000,000). */
  monthlyBudgetMicroYuan: integer("monthly_budget_micro_yuan").notNull().default(0),
  /** Price of the vision model per page in micro-yuan, when the admin entered one; else the known list price (or the dearest one for unknown models). */
  visionPriceMicroYuan: integer("vision_price_micro_yuan"),
  updatedAt: integer("updated_at").notNull().$defaultFn(now),
  updatedBy: text("updated_by").references(() => users.id),
});

/**
 * One row per sub-PDF sent to an external parser, or per page image sent to the vision model: the job's state,
 * and the usage the guardrails count (pages per book, per teacher per day, MinerU pages site-wide per day; cost).
 * Pages reused from a copy of the same file are not sent and not counted.
 */
export const parseUsage = sqliteTable(
  "parse_usage",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgs.id),
    userId: text("user_id").notNull().references(() => users.id),
    documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    parser: text("parser").notNull(),
    /** `auto`: must-fix pages, sent without asking. `refine`: pages the teacher asked to re-read ("精修本章"). */
    reason: text("reason", { enum: ["auto", "refine"] }).notNull(),
    pages: text("pages", { mode: "json" }).$type<number[]>().notNull(),
    pageCount: integer("page_count").notNull(),
    /** Micro-yuan: a vision page can cost less than one fen (qwen-vl-ocr ≈ 900). */
    costMicroYuan: integer("cost_micro_yuan").notNull().default(0),
    state: text("state", { enum: ["submitted", "uploaded", "parsed", "done", "failed"] }).notNull().default("submitted"),
    taskId: text("task_id").notNull(),
    /** The parser's signed upload URL: the Worker streams the sub-PDF to it; never sent to the browser. */
    uploadUrl: text("upload_url").notNull(),
    resultUrl: text("result_url"),
    error: text("error"),
    /** Calendar day in China (UTC+8), for the daily limits. */
    day: text("day").notNull(),
    createdAt: integer("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("parse_usage_day_idx").on(t.day, t.userId), index("parse_usage_document_idx").on(t.documentId)],
);
