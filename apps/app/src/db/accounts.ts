import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const now = () => Date.now();

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
