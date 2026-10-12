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

  // A sequencing page (排序配对): the writer fills an order slide that students rearrange.
  await rows.nth(2).getByLabel("页面类型 Page type").selectOption("sequence");
  await expect(rows.nth(2).getByLabel("页面类型 Page type")).toHaveValue("sequence");

  // Push the plan past +15%: the server refuses with 409 until the teacher acknowledges.
  for (const i of [0, 1]) await rows.nth(i).getByLabel("分钟 Minutes").fill("15");
  await expect(page.getByTestId("budget")).toContainText("over budget");
  await page.getByTestId("confirm-outline").click();
  await expect(page.getByTestId("ack-box")).toBeVisible();
  await page.getByTestId("ack-box").getByRole("button").click();

  // Confirming starts generation by itself (no second "generate all" click).
  await page.waitForURL(/\/slides$/);
  const lessonId = /\/lessons\/([^/]+)\//.exec(page.url())![1]!;
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

  await test.step("hinge question: the check slide becomes a vote first, answer later", async () => {
    await page.getByTestId("thumb").filter({ hasText: "检查理解" }).first().click();
    await page.getByTestId("edit-slide").click();
    await page.getByTestId("toggle-poll").check();
    await page.getByTestId("save-slide").click();
    await expect(page.locator(".preview-pane .kj-slide.kj-poll")).toBeVisible();
    await expect(page.locator(".preview-pane .kj-poll .kj-option:disabled").first()).toBeVisible();
  });

  await test.step("order slide from the sequence page", async () => {
    await page.getByTestId("thumb").filter({ hasText: "排序配对" }).first().click();
    await expect(page.locator(".preview-pane .kj-order .kj-card").first()).toBeVisible();
    await shotOf(page.locator(".preview-pane .slide-preview"), "12-order-slide");
  });

  await test.step("table visual on the data page", async () => {
    await page.getByTestId("thumb").filter({ hasText: "数据图表" }).first().click();
    const table = page.locator(".preview-pane .kj-table");
    await expect(table).toBeVisible();
    await expect(table).toContainText("Quantity");
    await shotOf(page.locator(".preview-pane .slide-preview"), "08-table-slide");
  });

  // Share: one stable link, students get no speaker notes; unsharing kills the link.
  const lessonUrl = page.url();
  await page.getByTestId("share").click();
  const shareUrl = (await page.getByTestId("share-url").textContent())!;
  expect(shareUrl).toMatch(/\/s\/[\w-]+$/);
  await shot(page, "06b-shared");
  const student = await page.context().newPage();
  await student.goto(shareUrl);
  await expect(student.locator(".kj-player")).toBeVisible();
  await expect(student.locator(".kj-notes")).toBeHidden();
  const pub = await (await student.request.get(shareUrl.replace("/s/", "/api/share/"))).json();
  expect(pub.slides).toHaveLength(count);
  expect(pub.slides.every((s: { notes: string }) => s.notes === "")).toBe(true);

  // A new, unconfirmed outline draft does not hide the confirmed deck or its link.
  await page.goto(lessonUrl.replace(/\/slides$/, "/outline"));
  await page.getByRole("button", { name: /修改大纲（新版本）/ }).click();
  await expect(page.getByTestId("draft-note")).toBeVisible();
  await page.getByTestId("draft-note").getByRole("button").click();
  await page.waitForURL(/\/slides$/);
  await expect(page.getByTestId("draft-banner")).toBeVisible();
  await expect(page.getByTestId("gen-progress")).toContainText(`已生成 ${count} / ${count}`);
  await expect(page.getByTestId("present")).toBeEnabled();
  await expect(page.getByTestId("share-url")).toHaveText(shareUrl);

  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("unshare").click();
  await expect(page.getByTestId("share")).toBeVisible();
  await student.reload();
  await expect(student.getByText("链接无效或已撤销")).toBeVisible();
  await student.close();

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
    await expect(player).toHaveAttribute("data-step", "0");
    await page.keyboard.press("Home");
    await expect(page.locator(".kj-player .kj-badge")).toHaveCount(0);
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

    // Jump to the hinge question: the answer key is only in the presenter window.
    const poll = pPlayer.locator(".kj-slide.kj-poll");
    for (let i = 0; i < count * 4 && !(await poll.isVisible()); i++) await presenter.keyboard.press("ArrowRight");
    await expect(poll).toBeVisible();
    await expect(presenter.getByTestId("presenter-answers")).toBeVisible();
    await expect.poll(() => positionOf(player)).toBe(await positionOf(pPlayer));
    await expect(page.getByText("答案 Answer")).toHaveCount(0);

    // Votes typed in the presenter window show as a distribution on the projector at the next click; the answer one click later.
    const votes = presenter.locator(".kj-tally-inputs input");
    await expect(votes).toHaveCount(3);
    for (const [i, n] of [3, 12, 5].entries()) await votes.nth(i).fill(String(n));
    await presenter.keyboard.press("PageDown");
    await expect.poll(() => positionOf(player)).toBe(await positionOf(pPlayer));
    const tallies = page.locator(".kj-slide.kj-poll .kj-tally-n");
    await expect(tallies.nth(1)).toHaveText("12 · 60%");
    await expect(tallies.nth(1)).toBeVisible();
    await expect(page.locator(".kj-slide.kj-poll .kj-explain")).toBeHidden();
    await presenter.keyboard.press("PageDown");
    await expect.poll(() => positionOf(player)).toBe(await positionOf(pPlayer));
    await expect(page.locator(".kj-slide.kj-poll .kj-explain")).toBeVisible();
    await shot(presenter, "09-presenter");
    await shot(page, "13-poll-tally");

    // R3-M2: a stroke drawn in the presenter window appears on the projector.
    const inkedOn = (p: typeof page) => p.locator("canvas.kj-ink").evaluate((c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0));
    expect(await inkedOn(page)).toBe(false);
    await presenter.keyboard.press("d");
    const pBox = (await presenter.locator("canvas.kj-ink").boundingBox())!;
    await presenter.mouse.move(pBox.x + pBox.width * 0.3, pBox.y + pBox.height * 0.5);
    await presenter.mouse.down();
    for (let i = 1; i <= 10; i++) await presenter.mouse.move(pBox.x + pBox.width * (0.3 + i * 0.03), pBox.y + pBox.height * 0.5);
    await presenter.mouse.up();
    await expect.poll(() => inkedOn(page)).toBe(true);
    await shot(page, "18-audience-ink-from-presenter");
    await presenter.getByRole("button", { name: /清除 Clear/ }).click();
    await expect.poll(() => inkedOn(page)).toBe(false);
    await presenter.keyboard.press("Escape");
    await presenter.close();
  });

  await test.step("order slide: tap two cards to swap them, the clicker reveals the right order", async () => {
    const player = page.locator(".kj-player");
    const order = player.locator(".kj-slide.kj-layout-order");
    await page.keyboard.press("Home");
    for (let i = 0; i < count * 4 && !(await order.isVisible()); i++) await page.keyboard.press("ArrowRight");
    await expect(order).toBeVisible();
    const cards = order.locator(".kj-card");
    const before = await cards.evaluateAll((cs) => cs.map((c) => c.getAttribute("data-key")));
    const at = await positionOf(player);
    await cards.nth(0).click();
    await expect(cards.nth(0)).toHaveClass(/kj-picked/);
    await cards.nth(1).click();
    expect(await cards.evaluateAll((cs) => cs.map((c) => c.getAttribute("data-key")))).toEqual([before[1], before[0], ...before.slice(2)]);
    expect(await positionOf(player)).toBe(at);
    await page.keyboard.press("PageDown");
    await expect(order.locator(".kj-order-reveal")).toBeVisible();
    await shot(page, "15-order-reveal");
  });

  await test.step("pen layer: draw on the projected slide, erase with Escape-then-navigate, nothing saved", async () => {
    const player = page.locator(".kj-player");
    await page.keyboard.press("Home");
    await page.keyboard.press("d");
    const ink = page.locator("canvas.kj-ink");
    await expect(ink).toBeVisible();
    const box = (await ink.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + box.width * (0.3 + i * 0.03), box.y + box.height * (0.6 - Math.sin(i / 3) * 0.12));
    await page.mouse.up();
    const inked = () => ink.evaluate((c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0));
    expect(await inked()).toBe(true);
    expect(await positionOf(player)).toBe("0.0");
    await shot(page, "14-pen-annotation");
    await page.getByRole("button", { name: /清除 Clear/ }).click();
    expect(await inked()).toBe(false);
    await page.keyboard.press("Escape");
    await page.keyboard.press("PageDown");
    await expect.poll(() => positionOf(player)).not.toBe("0.0");
    // Esc with the pen off leaves the presentation.
    await page.keyboard.press("Escape");
    await page.waitForURL(/\/lessons\/[^/]+\/slides$/);
  });

  await test.step("offline single-file export runs with the network blocked", async () => {
    await page.goto(`/lessons/${lessonId}/slides`);
    await page.getByText("导出 Export").click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-offline").click()]);
    const file = path.join(os.tmpdir(), `kj-offline-${Date.now()}.html`);
    await download.saveAs(file);
    expect(download.suggestedFilename()).toMatch(/\.html$/);
    const html = fs.readFileSync(file, "utf8");
    expect(html).not.toMatch(/<(script|link|img|iframe)[^>]+(src|href)=["']?https?:/i);
    expect(html).toContain("Noto Sans SC");
    expect(download.suggestedFilename()).not.toMatch(/\.\d.*\.html$/);

    // R3-M1: the student copy carries no speaker notes; the teacher copy keeps them out of the projected slide.
    const deck = await (await page.request.get(`/api/lessons/${lessonId}/deck`)).json();
    const notes: string[] = deck.slides.map((s: { notes: string }) => s.notes).filter((n: string) => n.length > 20);
    expect(notes.length).toBeGreaterThan(0);
    const [studentDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-student").click()]);
    expect(studentDl.suggestedFilename()).toContain("学生版");
    const studentFile = path.join(os.tmpdir(), `kj-student-${Date.now()}.html`);
    await studentDl.saveAs(studentFile);
    const studentHtml = fs.readFileSync(studentFile, "utf8");
    for (const n of notes) expect(studentHtml).not.toContain(JSON.stringify(n).slice(1, 40));
    expect(studentHtml).toContain('"audience":"student"');

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
    const order = off.locator(".kj-slide.kj-layout-order");
    await off.keyboard.press("Home");
    for (let i = 0; i < count * 4 && !(await order.isVisible()); i++) await off.keyboard.press("ArrowRight");
    await expect(order.locator(".kj-card")).not.toHaveCount(0);
    expect(network).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  await test.step("editable PPTX export: one slide per deck slide, with speaker notes", async () => {
    await page.goto(`/lessons/${lessonId}/slides`);
    await page.getByText("导出 Export").click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-pptx").click()]);
    const file = path.join(os.tmpdir(), `kj-${Date.now()}.pptx`);
    await download.saveAs(file);
    expect(download.suggestedFilename()).toMatch(/\.pptx$/);
    const zip = fs.readFileSync(file).toString("latin1");
    expect(zip.startsWith("PK")).toBe(true);
    const names = (re: RegExp) => new Set(zip.match(re) ?? []).size;
    const slides = await page.getByTestId("thumb").count();
    expect(slides).toBeGreaterThan(3);
    expect(names(/ppt\/slides\/slide\d+\.xml/g)).toBe(slides);
    expect(names(/ppt\/notesSlides\/notesSlide\d+\.xml/g)).toBe(slides);
  });

  await test.step("复制这节课到新学期: the copy keeps the confirmed outline and every slide", async () => {
    await page.goto("/");
    await page.getByTestId(`duplicate-${lessonId}`).click();
    await page.waitForURL(/\/lessons\/[^/]+\/outline\?copied=1$/);
    const copyId = /\/lessons\/([^/]+)\//.exec(page.url())![1]!;
    expect(copyId).not.toBe(lessonId);
    await expect(page.getByTestId("copied-hint")).toBeVisible();
    await shot(page, "16-duplicated-outline");
    await page.goto(`/lessons/${copyId}/slides`);
    await expect(page.getByTestId("gen-progress")).toContainText(`已生成 ${count} / ${count}`);
    await expect(page.getByTestId("share-url")).toHaveCount(0);
  });

  await test.step("整单元规划: one chapter range planned as a unit of lessons", async () => {
    const { lesson } = await (await page.request.get(`/api/lessons/${lessonId}`)).json();
    const body = { documentId: lesson.documentId, chapterIds: lesson.scope.chapterIds, ranges: lesson.scope.ranges, count: 2, title: "Waves unit 波动单元" };
    const preview = await page.request.post("/api/lessons/unit?dryRun=1", { data: body, headers: { "x-kj-csrf": "1" } });
    expect(preview.status()).toBe(200);
    expect((await preview.json()).lessons).toHaveLength(2);
    const res = await page.request.post("/api/lessons/unit", { data: body, headers: { "x-kj-csrf": "1" } });
    expect(res.status()).toBe(201);
    const { unit } = await res.json();
    await page.goto(`/?unit=${unit.id}`);
    const group = page.locator(`[data-testid="unit-group"].fresh`);
    await expect(group).toContainText("Waves unit 波动单元");
    await expect(group.getByTestId("lesson-card")).toHaveCount(2);
    await shot(page, "17-unit-group");
  });

  await test.step("delete a lesson (soft): it leaves the list, Undo brings it back", async () => {
    await page.goto("/");
    const cards = page.getByTestId("lesson-card");
    const before = await cards.count();
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId(`delete-${lessonId}`).click();
    await expect(page.getByTestId("deleted-note")).toBeVisible();
    await expect(cards).toHaveCount(before - 1);
    await expect(page.getByTestId(`delete-${lessonId}`)).toHaveCount(0);
    await shot(page, "19-lesson-deleted");
    expect((await page.request.get(`/api/lessons/${lessonId}`)).status()).toBe(404);
    await page.getByTestId("undo-delete").click();
    await expect(cards).toHaveCount(before);
    await expect(page.getByTestId(`delete-${lessonId}`)).toBeVisible();
  });
});

test("Chinese CID-font PDF: text is extracted, scanned pages are flagged and can be pasted", async ({ page }) => {
  await login(page);
  await page.getByTestId("new-lesson").click();
  await page.getByTestId("pdf-input").setInputFiles(path.resolve("fixtures/pdfs/newton-zh-cid.pdf"));
  await page.waitForURL(/\/new\/[^/]+$/);
  const docId = page.url().split("/").pop()!;
  expect((await (await page.request.get(`/api/documents/${docId}/pages/2`)).json()).text).toContain("牛顿第一定律");

  const scanned = page.getByRole("treeitem").filter({ hasText: "4.4 习题" });
  await expect(scanned.getByTestId("chapter-empty")).toHaveText("2 页无文字");
  await expect(page.getByRole("treeitem").filter({ hasText: "4.2 牛顿第一定律" }).getByTestId("chapter-empty")).toHaveCount(0);
  await scanned.locator("input[type=checkbox]").check();
  await expect(page.getByTestId("empty-pages")).toContainText("都没有可读的文字");
  await page.getByTestId("paste-open").click();
  await page
    .getByTestId("paste-text")
    .fill("习题一：质量为 3 kg 的物体受到 12 N 的合力，求加速度。习题二：汽车刹车时乘客向前倾，用惯性解释这一现象。习题三：同一个力作用在质量不同的两个物体上，哪个加速度更大？为什么？");
  await shot(page, "08-paste-scanned");
  await page.getByTestId("paste-save").click();
  await expect(page.getByTestId("empty-pages")).toHaveCount(0);
  await expect(scanned.getByTestId("chapter-empty")).toHaveCount(0);
  await page.getByRole("button", { name: /下一步：课时设置/ }).click();

  await page.waitForURL(/\/settings$/);
  await expect(page.getByTestId("no-text")).toHaveCount(0);
  await page.getByRole("button", { name: /生成大纲 Draft outline/ }).click();
  await page.waitForURL(/\/outline$/);
  await expect(page.getByTestId("outline-row").first()).toBeVisible();

  // Two tabs on the same draft: the second save is refused instead of overwriting the first.
  const other = await page.context().newPage();
  await other.goto(page.url());
  await page.getByTestId("outline-row").first().getByLabel("标题 Title").fill("标签页 A 的标题");
  await page.getByRole("button", { name: "保存修改 Save" }).click();
  await expect(page.getByRole("button", { name: "已保存 Saved" })).toBeVisible();
  await other.getByTestId("outline-row").first().getByLabel("标题 Title").fill("标签页 B 的标题");
  await other.getByRole("button", { name: "保存修改 Save" }).click();
  await expect(other.getByTestId("outline-error")).toContainText("另一个标签页");
  await shot(other, "09-outline-conflict");

  // Unsaved edits: in-app links ask first, closing the tab warns.
  let asked = "";
  other.once("dialog", (d) => {
    asked = d.message();
    void d.dismiss();
  });
  await other.locator('.stepper [data-step="settings"] a').click();
  await expect.poll(() => asked).toContain("还没保存");
  await expect(other).toHaveURL(/\/outline$/);
  // …and so does the browser's Back button.
  let askedBack = "";
  other.once("dialog", (d) => {
    askedBack = d.message();
    void d.dismiss();
  });
  await other.evaluate(() => history.back());
  await expect.poll(() => askedBack).toContain("还没保存");
  await expect(other).toHaveURL(/\/outline$/);
  await expect(other.getByTestId("outline-row").first().getByLabel("标题 Title")).toHaveValue("标签页 B 的标题");

  // The minutes box keeps what is typed and clamps only on blur.
  const minutes = other.getByTestId("outline-row").first().getByLabel("分钟 Minutes");
  await minutes.fill("");
  await minutes.pressSequentially("0");
  await expect(minutes).toHaveValue("0");
  await minutes.blur();
  await expect(minutes).toHaveValue("0.5");

  const closing = new Promise<string>((resolve) => other.once("dialog", (d) => (resolve(d.type()), void d.accept())));
  await other.close({ runBeforeUnload: true });
  expect(await closing).toBe("beforeunload");

  await page.reload();
  await expect(page.getByTestId("outline-row").first().getByLabel("标题 Title")).toHaveValue("标签页 A 的标题");
});
