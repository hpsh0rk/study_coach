import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const PDF = new URL("../fixtures/pdfs/waves-mini.pdf", import.meta.url);

async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: /登录 Log in/ }).click();
}

async function changePassword(page: Page, current: string, next: string) {
  await expect(page).toHaveURL(/\/change-password/);
  await page.locator('input[name="current"]').fill(current);
  await page.locator('input[name="new"]').fill(next);
  await page.locator('input[name="confirm"]').fill(next);
  await page.getByRole("button", { name: /保存 Save/ }).click();
  await expect(page).not.toHaveURL(/\/change-password/);
}

async function logout(page: Page) {
  await page.getByRole("button", { name: /退出 Log out/ }).click();
  await expect(page).toHaveURL(/\/login/);
}

test("whitelist login → upload → outline gate → generate → play → share → revoke", async ({ page, browser }) => {
  // Admin bootstrapped by scripts/create-admin.mjs must change the password first.
  await login(page, "admin", "Admin12345");
  await changePassword(page, "Admin12345", "Admin123456");

  await page.goto("/admin");
  await page.locator('input[name="new-username"]').fill("wang");
  await page.locator('input[name="new-display"]').fill("王老师");
  await page.locator('input[name="new-password"]').fill("Teach12345");
  await page.getByRole("button", { name: /创建 Create/ }).click();
  await expect(page.getByTestId("issued-password")).toContainText("Teach12345");
  await logout(page);

  // Teacher: first login also forces a password change.
  await login(page, "wang", "Teach12345");
  await changePassword(page, "Teach12345", "Teach123456");
  await page.goto("/");
  await page.locator('input[name="title"]').fill("Waves · 波 (Lesson 1)");
  await page.getByRole("button", { name: /创建 Create/ }).click();
  await expect(page).toHaveURL(/\/projects\/prj_/);

  await page.getByTestId("pdf-input").setInputFiles({ name: "waves-mini.pdf", mimeType: "application/pdf", buffer: readFileSync(PDF) });
  await expect(page.getByTestId("doc-status")).toHaveClass(/ready/, { timeout: 60_000 });

  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: /生成大纲 Build outline/ }).click();
  await expect(page.getByTestId("outline-status")).toContainText("Not confirmed");

  // The gate: generation before confirmation is refused by the server.
  await page.getByTestId("generate-one").click();
  await expect(page.getByText("请先确认大纲").first()).toBeVisible();

  await page.getByRole("button", { name: /锁定模板 Lock theme/ }).click();
  await page.getByRole("button", { name: /确认大纲 Confirm$/ }).click();
  await expect(page.getByTestId("outline-status")).toContainText("Confirmed");

  await page.getByTestId("generate-one").click();
  await expect(page.getByTestId("run-status")).toContainText("done", { timeout: 60_000 });
  await expect(page.locator(".slide-thumb").first()).toBeVisible();

  // Presenter view renders the generated slide.
  await page.getByTestId("play-link").click();
  await expect(page.locator(".kj-slide").first()).toBeVisible();
  await page.goBack();

  await page.getByTestId("create-share").click();
  const shareUrl = await page.getByTestId("share-url").inputValue();
  expect(shareUrl).toMatch(/\/s\//);

  const student = await browser.newPage();
  await student.goto(shareUrl);
  await expect(student.locator(".kj-slide").first()).toBeVisible();
  const token = new URL(shareUrl).pathname.split("/").pop()!;
  const shared = await (await student.request.get(`/api/share/${token}`)).json();
  for (const s of shared.deck.slides as { notes?: { en: string[]; zhTerms: unknown[] } }[]) {
    expect(s.notes?.en ?? []).toEqual([]);
    expect(s.notes?.zhTerms ?? []).toEqual([]);
  }

  await page.getByRole("button", { name: /撤销 Revoke/ }).click();
  await expect(page.getByText(/已撤销 revoked/)).toBeVisible();
  await student.reload();
  await expect(student.getByTestId("share-error")).toBeVisible();
  await student.close();
});

test("teachers cannot open the admin console", async ({ page }) => {
  await login(page, "wang", "Teach123456");
  await expect(page).not.toHaveURL(/\/login/);
  const res = await page.request.get("/api/admin/users");
  expect(res.status()).toBe(403);
});
