import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const PDF = path.resolve("fixtures/pdfs/waves-mini.pdf");
const INITIAL = "Admin12345";
const CHANGED = "Teacher2026x";
const SHOTS_DIR = process.env.SHOTS_DIR;

async function shot(page: Page, name: string) {
  if (SHOTS_DIR) await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: true });
}

async function login(page: Page) {
  await page.goto("/login");
  for (const password of [INITIAL, CHANGED]) {
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
}

test("upload → chapters → settings → outline (gate) → generate → edit/undo → present", async ({ page }) => {
  await login(page);

  await page.getByTestId("new-lesson").click();
  await page.getByTestId("pdf-input").setInputFiles(PDF);
  await page.waitForURL(/\/new\/[^/]+$/);

  const chapter = page.getByRole("treeitem").filter({ hasText: "Chapter 1" }).first();
  await chapter.locator("input[type=checkbox]").check();
  await expect(page.getByTestId("selection")).toContainText("页");
  await expect(page.getByTestId("scope-estimate")).toBeVisible();
  await shot(page, "02-chapters");
  await page.getByRole("button", { name: /下一步：课时设置/ }).click();

  await page.waitForURL(/\/settings$/);
  await expect(page.getByTestId("pacing")).toBeVisible();
  await shot(page, "03-settings");
  await page.getByRole("button", { name: /生成大纲 Draft outline/ }).click();

  await page.waitForURL(/\/outline$/);
  const rows = page.getByTestId("outline-row");
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  expect(count).toBeGreaterThan(3);
  await expect(page.getByTestId("budget")).toContainText("分钟为合适");
  await shot(page, "04-outline");

  // Push the plan past +15%: the server refuses with 409 until the teacher acknowledges.
  for (const i of [0, 1]) await rows.nth(i).getByLabel("分钟 Minutes").fill("15");
  await expect(page.getByTestId("budget")).toContainText("over budget");
  await page.getByTestId("confirm-outline").click();
  await expect(page.getByTestId("ack-box")).toBeVisible();
  await page.getByTestId("ack-box").getByRole("button").click();

  await page.waitForURL(/\/slides$/);
  await page.getByTestId("generate-all").click();
  await expect(page.getByTestId("gen-progress")).toContainText(`已生成 ${count} / ${count}`, { timeout: 60_000 });
  await shot(page, "05-slides");

  const preview = page.locator(".preview-pane .kj-slide");
  await page.getByTestId("thumb").first().click();
  await page.getByTestId("edit-slide").click();
  await expect(page.getByTestId("slot-editor")).toBeVisible();
  await page.locator('[data-slot-path="title"]').fill("Edited title 改过的标题");
  await shot(page, "06-slot-editor");
  await page.getByTestId("save-slide").click();
  await expect(preview).toContainText("Edited title 改过的标题");
  await page.getByTestId("undo-slide").click();
  await expect(preview).not.toContainText("Edited title");

  const sim = await page.request.get("/sims/wave-string.html");
  expect(sim.status()).toBe(200);
  expect(await sim.text()).toContain("<canvas");

  await page.getByTestId("present").click();
  await page.waitForURL(/\/play\//);
  const player = page.locator(".kj-player");
  await expect(player).toBeVisible();
  await expect(page.locator(".kj-counter")).toContainText(`1 / ${count}`);
  await player.press("End");
  await expect(player).toHaveAttribute("data-index", String(count - 1));
  await player.press("Home");
  await expect(player).toHaveAttribute("data-index", "0");
  await player.press("ArrowRight");
  await expect(page.locator(".kj-counter")).not.toHaveText(`1 / ${count}`);
  await player.press("s");
  await expect(page.locator(".kj-notes")).toBeVisible();
  await shot(page, "07-present");
});
