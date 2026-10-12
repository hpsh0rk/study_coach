import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env.ts";

export function db(env: Env) {
  return drizzle(env.DB);
}
