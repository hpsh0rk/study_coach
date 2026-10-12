import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = () => Date.now();

export const orgs = sqliteTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull().$defaultFn(now),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgs.id),
    username: text("username").notNull(),
    displayName: text("display_name"),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin", "teacher"] }).notNull(),
    mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(true),
    disabledAt: integer("disabled_at"),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    updatedAt: integer("updated_at").notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex("users_username_uq").on(t.username)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    /** sha256(token); the raw token only lives in the httpOnly cookie. */
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    expiresAt: integer("expires_at").notNull(),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const loginAttempts = sqliteTable("login_attempts", {
  key: text("key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  failures: integer("failures").notNull(),
});

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

export const lessons = sqliteTable(
  "lessons",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgs.id),
    ownerId: text("owner_id").notNull().references(() => users.id),
    documentId: text("document_id").notNull().references(() => documents.id),
    title: text("title").notNull(),
    /** LessonScope JSON: chapterIds + normalized page ranges. */
    scope: text("scope").notNull(),
    /** LessonParams JSON. */
    params: text("params").notNull(),
    theme: text("theme").notNull().default("classic"),
    /** Set while an outline draft is running (a lock that expires on its own if the request dies). */
    draftingUntil: integer("drafting_until"),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    updatedAt: integer("updated_at").notNull().$defaultFn(now),
  },
  (t) => [index("lessons_owner_idx").on(t.orgId, t.ownerId)],
);

/** Immutable once confirmed_at is set (enforced by SQLite triggers in the migration). */
export const outlineVersions = sqliteTable(
  "outline_versions",
  {
    id: text("id").primaryKey(),
    lessonId: text("lesson_id").notNull().references(() => lessons.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    outline: text("outline").notNull(),
    /** LessonParams and LessonScope at the time the version was created; confirm and generate read these. */
    params: text("params").notNull(),
    scope: text("scope").notNull(),
    specCount: integer("spec_count").notNull(),
    /** Bumped by every saved edit of a draft; PUT and confirm must name the rev they started from. */
    rev: integer("rev").notNull().default(0),
    ackOverBudget: integer("ack_over_budget", { mode: "boolean" }).notNull().default(false),
    confirmedAt: integer("confirmed_at"),
    createdAt: integer("created_at").notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex("outline_versions_lesson_version_uq").on(t.lessonId, t.version)],
);

export const slides = sqliteTable(
  "slides",
  {
    id: text("id").primaryKey(),
    lessonId: text("lesson_id").notNull().references(() => lessons.id, { onDelete: "cascade" }),
    outlineVersionId: text("outline_version_id").notNull().references(() => outlineVersions.id),
    specId: text("spec_id").notNull(),
    /** sha256 of the spec (without id) and the version's params: identical specs reuse slides across versions. */
    specHash: text("spec_hash").notNull(),
    layout: text("layout").notNull(),
    pageType: text("page_type").notNull(),
    minutes: real("minutes").notNull(),
    content: text("content").notNull(),
    notes: text("notes").notNull(),
    sources: text("sources").notNull(),
    warnings: text("warnings").notNull(),
    /** JSON Unverified[]: numbers/formulas/calculations the source check could not confirm (待核实). */
    unverified: text("unverified").notNull().default("[]"),
    providerId: text("provider_id").notNull(),
    /** Content and notes before the last edit or regeneration (one level of undo). */
    prevContent: text("prev_content"),
    prevNotes: text("prev_notes"),
    updatedAt: integer("updated_at").notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex("slides_version_spec_uq").on(t.outlineVersionId, t.specId), index("slides_lesson_hash_idx").on(t.lessonId, t.specHash)],
);

export const shareLinks = sqliteTable(
  "share_links",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    lessonId: text("lesson_id").notNull().references(() => lessons.id, { onDelete: "cascade" }),
    /** The confirmed version students see; later versions only reach them when the teacher updates the link. */
    versionId: text("version_id").references(() => outlineVersions.id),
    /** Last time the teacher shared (and so reviewed) the deck: flagged slides changed after this are held back. */
    reviewedAt: integer("reviewed_at").notNull().default(0),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    revokedAt: integer("revoked_at"),
  },
  (t) => [uniqueIndex("share_token_uq").on(t.tokenHash), index("share_lesson_idx").on(t.lessonId)],
);

export const aiProviders = sqliteTable("ai_providers", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => orgs.id),
  kind: text("kind", { enum: ["deepseek", "glm", "custom"] }).notNull(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  /** AES-GCM sealed with AI_CONFIG_KEY. */
  apiKeySealed: text("api_key_sealed").notNull(),
  apiKeyHint: text("api_key_hint").notNull(),
  model: text("model").notNull().default(""),
  /** At most one provider per org is enabled: every model call uses it. */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull().$defaultFn(now),
  updatedAt: integer("updated_at").notNull().$defaultFn(now),
});

export const aiCalls = sqliteTable(
  "ai_calls",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    lessonId: text("lesson_id"),
    capability: text("capability").notNull(),
    promptVersion: text("prompt_version").notNull(),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    status: text("status", { enum: ["ok", "error", "rejected"] }).notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    error: text("error"),
    createdAt: integer("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("ai_calls_lesson_idx").on(t.lessonId), index("ai_calls_org_time_idx").on(t.orgId, t.createdAt)],
);

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: text("org_id").notNull(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  target: text("target"),
  detail: text("detail"),
  createdAt: integer("created_at").notNull().$defaultFn(now),
});
