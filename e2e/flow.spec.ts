import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

const PDF = path.resolve("fixtures/pdfs/waves-mini.pdf");
const INITIAL = "Admin12345";
const CHANGED = "Teacher2026x";
const SHOTS_DIR = process.env.SHOTS_DIR;

async function shot(page: Page, name: string) {
  if (SHOTS_DIR) await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: true });
}

async function shotOf(el: Locator, name: string) {
  if (SHOTS_DIR) await el.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

const positionOf = async (player: Locator) => `${await player.getAttribute("data-index")}.${await player.getAttribute("data-step")}`;

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

test("upload → chapters → settings → outline (gate) → generate → edit/undo/待核实 → presenter → offline file", async ({ page, browser }) => {
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
  const lessonId = /\/lessons\/([^/]+)\//.exec(page.url())![1]!;
  await expect(page.getByTestId("present")).toHaveCount(0);
  await page.getByTestId("generate-all").click();
  await expect(page.getByTestId("gen-progress")).toContainText(`已生成 ${count} / ${count}`, { timeout: 60_000 });
  await expect(page.getByTestId("generate-all")).toHaveCount(0);
  await shot(page, "05-slides");

  await test.step("slot edit and undo", async () => {
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
  });

  await test.step("待核实: a number that is not on the cited pages is flagged", async () => {
    const concept = page.getByTestId("thumb").filter({ hasText: "概念讲解" }).first();
    await concept.click();
    await page.getByTestId("edit-slide").click();
    await page.locator('[data-slot-path="bullets"]').fill("Sound travels at 343 m/s in air");
    await page.getByTestId("save-slide").click();
    await expect(page.getByTestId("unverified")).toContainText("343");
    await expect(concept.getByTestId("unverified-badge")).toBeVisible();
    await page.getByTestId("edit-slide").click();
    await expect(page.locator(".slot-field.flagged [data-slot-path='bullets']")).toBeVisible();
    await shot(page, "06b-unverified-editor");
    await page.getByRole("button", { name: "取消 Cancel" }).click();
    await shotOf(page.locator(".preview-pane"), "06c-unverified-preview");
    await page.getByTestId("undo-slide").click();
    await expect(page.getByTestId("unverified")).toHaveCount(0);
  });

  await test.step("slot editor: word counts, Chinese messages, re-adding terms, visual without JSON, A/B/C/D answers", async () => {
    await page.getByTestId("thumb").filter({ hasText: "概念讲解" }).first().click();
    await page.getByTestId("edit-slide").click();
    const editor = page.getByTestId("slot-editor");
    const titleField = editor.locator(".slot-field").filter({ has: page.locator('[data-slot-path="title"]') });
    await page.locator('[data-slot-path="title"]').fill("惯性是物体保持原有运动状态不变的性质，一切物体在没有受到外力作用时总保持静止或匀速直线运动");
    await expect(titleField.locator(".count.over")).toContainText("/ 15 词");
    await expect(titleField.locator(".slot-issues")).toContainText("标题：太长：最多 15 个英文词");
    await page.locator('[data-slot-path="title"]').fill("Waves carry energy 波传递能量");
    await expect(titleField.locator(".count.over")).toHaveCount(0);

    const terms = editor.locator('fieldset[data-slot-path="terms"]');
    while ((await terms.getByRole("button", { name: "删除 Remove" }).count()) > 0) await terms.getByRole("button", { name: "删除 Remove" }).first().click();
    await terms.getByTestId("add-terms").click();
    await page.locator('[data-slot-path="terms.0.term"]').fill("inertia");
    await page.locator('[data-slot-path="terms.0.zh"]').fill("惯性");

    await editor.getByTestId("visual-kind").selectOption("flow");
    await page.locator('[data-slot-path="visual.steps"]').fill("Source vibrates\nWave travels\nEar detects");
    await expect(editor.locator(".slot-preview .kj-flow-step")).toHaveCount(3);
    await editor.evaluate((e) => (e.scrollTop = 0));
    await shotOf(page.locator(".preview-pane"), "06d-slot-editor-visual");
    await page.getByTestId("save-slide").click();
    await expect(editor).toHaveCount(0);
    const preview = page.locator(".preview-pane .slide-preview");
    await expect(preview).toContainText("惯性");
    await expect(preview.locator(".kj-flow-step")).toHaveCount(3);
    await expect(preview.locator(".kj-flow-step.kj-step-hidden")).toHaveCount(0);
    await page.getByTestId("undo-slide").click();

    await page.getByTestId("thumb").filter({ hasText: "检查理解" }).first().click();
    await page.getByTestId("edit-slide").click();
    await expect(editor.getByTestId("answer-A")).toBeVisible();
    await editor.getByTestId("answer-B").check();
    await shotOf(page.locator(".preview-pane"), "06e-slot-editor-quiz");
    await page.getByTestId("save-slide").click();
    await expect(editor).toHaveCount(0);
    await page.getByTestId("undo-slide").click();
  });

  await test.step("table visual on the data page", async () => {
    await page.getByTestId("thumb").filter({ hasText: "数据图表" }).first().click();
    const table = page.locator(".preview-pane .kj-table");
    await expect(table).toBeVisible();
    await expect(table).toContainText("Quantity");
    await shotOf(page.locator(".preview-pane .slide-preview"), "08-table-slide");
  });

  const sim = await page.request.get("/sims/wave-string.html");
  expect(sim.status()).toBe(200);
  expect(await sim.text()).toContain("<canvas");

  await test.step("audience view never shows notes; presenter window stays in sync both ways", async () => {
    await page.getByTestId("present").click();
    await page.waitForURL(/\/play\//);
    const player = page.locator(".kj-player");
    await expect(player).toBeVisible();
    await expect(page.locator(".kj-counter")).toContainText(`1 / ${count}`);
    await page.keyboard.press("End");
    await expect(player).toHaveAttribute("data-index", String(count - 1));
    await page.keyboard.press("Home");
    await expect(player).toHaveAttribute("data-index", "0");
    await page.keyboard.press("s");
    await expect(page.locator(".kj-notes")).toBeHidden();
    await expect(page.getByRole("button", { name: /Notes 讲稿/ })).toHaveCount(0);

    const [presenter] = await Promise.all([page.context().waitForEvent("page"), page.getByTestId("open-presenter").click()]);
    await presenter.setViewportSize({ width: 1400, height: 860 });
    await expect(presenter.getByTestId("presenter")).toBeVisible();
    const pPlayer = presenter.locator(".kj-player");
    await expect(presenter.getByTestId("presenter-notes")).toContainText("Say:");
    await expect(presenter.getByTestId("presenter-next").locator(".kj-slide")).toBeVisible();
    await expect(presenter.getByTestId("presenter-timer")).toHaveText(/\d+:\d\d/);

    // Clicker in the presenter window drives the projector…
    for (let i = 0; i < 3; i++) await presenter.keyboard.press("PageDown");
    const p1 = await positionOf(pPlayer);
    expect(p1).not.toBe("0.0");
    await expect.poll(() => positionOf(player)).toBe(p1);
    // …and a clicker on the projector machine drives the presenter window.
    await page.keyboard.press("PageDown");
    const p2 = await positionOf(player);
    await expect.poll(() => positionOf(pPlayer)).toBe(p2);
    await page.keyboard.press("b");
    await expect(pPlayer).toHaveAttribute("data-blank", "1");
    await page.keyboard.press("b");
    await expect(pPlayer).toHaveAttribute("data-blank", "0");

    // Jump to the quiz: the answer key is only in the presenter window.
    for (let i = 0; i < count * 4 && !(await presenter.getByTestId("presenter-answers").isVisible()); i++) await presenter.keyboard.press("ArrowRight");
    await expect(presenter.getByTestId("presenter-answers")).toBeVisible();
    await expect.poll(() => positionOf(player)).toBe(await positionOf(pPlayer));
    await expect(page.getByText("答案 Answer")).toHaveCount(0);
    await shot(presenter, "09-presenter");
    await shot(page, "07-present");
    await presenter.close();
  });

  await test.step("offline single-file export runs with the network blocked", async () => {
    await page.goto(`/lessons/${lessonId}/slides`);
    await page.getByText("导出 / 分享 Export").click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-offline").click()]);
    const file = path.join(os.tmpdir(), `kj-offline-${Date.now()}.html`);
    await download.saveAs(file);
    expect(download.suggestedFilename()).toMatch(/\.html$/);
    const html = fs.readFileSync(file, "utf8");
    expect(html).not.toMatch(/<(script|link|img|iframe)[^>]+(src|href)=["']?https?:/i);
    expect(html).toContain("Noto Sans SC");

    const ctx = await browser.newContext({ offline: true, viewport: { width: 1280, height: 720 } });
    const network: string[] = [];
    ctx.on("request", (r) => {
      if (!/^(file|data|about|blob):/.test(r.url())) network.push(r.url());
    });
    await ctx.route(/^(https?|wss?):/, (r) => r.abort());
    const off = await ctx.newPage();
    const errors: string[] = [];
    off.on("pageerror", (e) => errors.push(e.message));
    await off.goto(`file://${file}`);
    await expect(off.locator("body"), `offline page errors: ${errors.join(" | ")}`).toHaveAttribute("data-ready", "1");
    await expect(off.locator(".kj-counter")).toContainText(`1 / ${count}`);
    const fonts = await off.evaluate(async () => {
      const zh = await document.fonts.load('400 48px "Noto Sans SC"', "波长频率");
      const latin = await document.fonts.load('700 48px "Arimo"', "Wave");
      return { zh: zh.length, latin: latin.length, errors: [...document.fonts].filter((f) => f.status === "error").length };
    });
    expect(fonts).toEqual({ zh: expect.any(Number), latin: expect.any(Number), errors: 0 });
    expect(fonts.zh).toBeGreaterThan(0);
    expect(fonts.latin).toBeGreaterThan(0);
    await shot(off, "10-offline-file");
    const simFrame = off.locator(".kj-sim iframe").first();
    for (let i = 0; i < count * 4 && !(await simFrame.isVisible()); i++) await off.keyboard.press("ArrowRight");
    await expect(off.frameLocator(".kj-sim iframe").locator("canvas")).toBeVisible();
    await shot(off, "11-offline-sim");
    expect(network).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
