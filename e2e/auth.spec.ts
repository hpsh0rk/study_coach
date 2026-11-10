import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { shot } from "./helpers";

const INITIAL = "Admin12345";
const CHANGED = "Teacher2026x";
export const AUTH_STATE = path.resolve("playwright/.auth/admin.json");

test("authenticate admin", async ({ page }) => {
  await page.goto("/login");
  for (const password of [CHANGED, INITIAL]) {
    await page.getByLabel("用户名 Username").fill("admin");
    await page.getByLabel("密码 Password").fill(password);
    await page.getByRole("button", { name: "登录 Log in" }).click();
    const outcome = await Promise.race([
      page.waitForURL(/\/(change-password)?$/, { timeout: 15_000 }).then(() => "ok"),
      page.locator(".alert.error").waitFor({ timeout: 15_000 }).then(() => "error"),
    ]);
    if (outcome === "ok") break;
  }
  if (page.url().endsWith("/change-password")) {
    await shot(page, "01-change-password");
    await page.getByLabel("当前密码 Current password").fill(INITIAL);
    await page.getByLabel("新密码 New password").fill(CHANGED);
    await page.getByLabel("再输一次 Confirm").fill(CHANGED);
    await page.getByRole("button", { name: "保存 Save" }).click();
  }
  await expect(page.getByTestId("new-lesson")).toBeVisible();
  fs.mkdirSync(path.dirname(AUTH_STATE), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE });
});
