import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
    createdAt: integer("created_at").notNull().$defaultFn(now),
    /** Soft delete, like lessons.archived_at: hidden from lists and new lessons; lessons made from it keep working. */
    archivedAt: integer("archived_at"),
  },
  (t) => [index("documents_owner_idx").on(t.orgId, t.ownerId)],
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
