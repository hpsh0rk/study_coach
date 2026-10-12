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

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgs.id),
    ownerId: text("owner_id").notNull().references(() => users.id),
    title: text("title").notNull(),
    slideCount: integer("slide_count").notNull().default(0),
    deckVersion: integer("deck_version").notNull().default(0),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    updatedAt: integer("updated_at").notNull().$defaultFn(now),
  },
  (t) => [index("projects_owner_idx").on(t.orgId, t.ownerId)],
);

export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgs.id),
    projectId: text("project_id").references(() => projects.id),
    uploadedBy: text("uploaded_by").notNull().references(() => users.id),
    filename: text("filename").notNull(),
    r2Key: text("r2_key").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    status: text("status", { enum: ["uploaded", "parsing", "ready", "failed"] }).notNull(),
    parserId: text("parser_id"),
    pageCount: integer("page_count"),
    parsedKey: text("parsed_key"),
    workflowInstanceId: text("workflow_instance_id"),
    error: text("error"),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    updatedAt: integer("updated_at").notNull().$defaultFn(now),
  },
  (t) => [index("documents_project_idx").on(t.projectId)],
);

export const chapters = sqliteTable(
  "chapters",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull().references(() => documents.id),
    parentId: text("parent_id"),
    ord: integer("ord").notNull(),
    level: integer("level").notNull(),
    title: text("title").notNull(),
    pageStart: integer("page_start").notNull(),
    pageEnd: integer("page_end").notNull(),
    wordCount: integer("word_count").notNull(),
    estSlides: integer("est_slides").notNull(),
  },
  (t) => [index("chapters_doc_idx").on(t.documentId)],
);

export const shareLinks = sqliteTable(
  "share_links",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    projectId: text("project_id").notNull().references(() => projects.id),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [uniqueIndex("share_token_uq").on(t.tokenHash), index("share_project_idx").on(t.projectId)],
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
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull().$defaultFn(now),
  updatedAt: integer("updated_at").notNull().$defaultFn(now),
});

export const aiRoutes = sqliteTable(
  "ai_routes",
  {
    orgId: text("org_id").notNull().references(() => orgs.id),
    capability: text("capability").notNull(),
    primaryProviderId: text("primary_provider_id").notNull(),
    primaryModel: text("primary_model").notNull(),
    fallbackProviderId: text("fallback_provider_id"),
    fallbackModel: text("fallback_model"),
    temperature: real("temperature"),
    updatedAt: integer("updated_at").notNull().$defaultFn(now),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.capability] })],
);

export const aiCalls = sqliteTable(
  "ai_calls",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    projectId: text("project_id"),
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
  (t) => [index("ai_calls_project_idx").on(t.projectId), index("ai_calls_org_time_idx").on(t.orgId, t.createdAt)],
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
