import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/db/accounts.ts", "./src/db/schema.ts", "./src/textbook/tables.ts"],
  out: "./migrations",
});
