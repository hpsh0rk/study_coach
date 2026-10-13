import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

const PDF = path.resolve("fixtures/pdfs/waves-mini.pdf");
const INITIAL = "Admin12345";
const CHANGED = "Teacher2026x";
const SHOTS_DIR = process.env.SHOTS_DIR;

async function shot(page: Page, name: string) {
  if (!SHOTS_DIR) return;
  // A full-page capture draws the sticky header wherever the page is scrolled to.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: true });
}

async function shotOf(el: Locator, name: string) {
  if (SHOTS_DIR) await el.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

const positionOf = async (player: Locator) => `${await player.getAttribute("data-index")}.${await player.getAttribute("data-step")}`;

/** No visible source chip reaches the player's control bar (it floats over the slide's bottom edge). */
async function expectChipsClear(page: Page) {
  const under = await page.evaluate(() => {
    const bar = document.querySelector(".kj-controls")!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>(".kj-slide .kj-source")]
      .filter((c) => !c.hidden)
      .filter((c) => {
        const r = c.getBoundingClientRect();
        return r.right > bar.left && r.bottom > bar.top && r.top < bar.bottom;
      })
      .map((c) => c.textContent);
  });
  expect(under).toEqual([]);
}

/** Chapters → settings. The mini fixture PDFs are far below one lesson, so the m3-10 "仍然继续" second click is expected. */
async function toSettings(page: Page, thinShot?: string) {
  await page.getByTestId("chapters-next").click();
  const next = page.getByTestId("chapters-next");
  await expect(page.getByTestId("thin-warning").or(page.getByTestId("pacing"))).toBeVisible();
  if (thinShot) await expect(page.getByTestId("thin-warning")).toBeVisible();
  if (await page.getByTestId("thin-warning").isVisible()) {
    await expect(next).toHaveText(/仍然继续/);
    if (thinShot) await shot(page, thinShot);
    await next.click();
  }
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

test("upload → chapters → settings → outline (gate) → generate → edit/undo/待核实 → presenter → offline file", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await login(page);
  // No model configured (stub server): every page says the output is the built-in templates, not AI.
  await expect(page.getByTestId("stub-banner")).toContainText("不是 AI 写的");

  await page.getByTestId("new-lesson").click();
  await page.getByTestId("pdf-input").setInputFiles(PDF);
  await page.waitForURL(/\/new\/[^/]+$/);

  const chapter = page.getByRole("treeitem").filter({ hasText: "Chapter 1" }).first();
  await chapter.locator("input[type=checkbox]").check();
  await expect(page.getByTestId("selection")).toContainText("页");
  await expect(page.getByTestId("scope-estimate")).toBeVisible();
  await shot(page, "02-chapters");
  await toSettings(page, "23-thin-selection-confirm");

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
  await expect(page.getByTestId("answers-hidden")).toBeChecked();
  await page.getByTestId("share").click();
  const shareUrl = (await page.getByTestId("share-url").textContent())!;
  expect(shareUrl).toMatch(/\/s\/[\w-]+$/);
  await expect(page.getByTestId("share-box")).toContainText("答案课后公布");
  await shot(page, "06b-shared");
  await shotOf(page.getByTestId("share-box").locator(".."), "20-answer-mode-share-panel");
  const student = await page.context().newPage();
  await student.goto(shareUrl);
  await expect(student.locator(".kj-player")).toBeVisible();
  await expect(student.locator(".kj-notes")).toBeHidden();
  await expectChipsClear(student);
  const pubUrl = shareUrl.replace("/s/", "/api/share/");
  const pub = await (await student.request.get(pubUrl)).json();
  expect(pub.slides).toHaveLength(count);
  expect(pub.slides.every((s: { notes: string }) => s.notes === "")).toBe(true);
  // 课前预习 (default): no quiz answer or explanation leaves the server.
  const teacherDeck = await (await page.request.get(`/api/lessons/${lessonId}/deck`)).json();
  const quizzes = (d: { slides: { content: { layout: string; answer?: number; explain?: string } }[] }) => d.slides.map((s) => s.content).filter((c) => c.layout === "quiz");
  expect(quizzes(teacherDeck).length).toBeGreaterThan(0);
  expect(pub.lesson.answers).toBe("hidden");
  expect(quizzes(pub).every((q) => q.answer === -1 && q.explain === "")).toBe(true);
  expect(quizzes(teacherDeck).every((q) => q.answer! >= 0 && q.explain!.length > 0)).toBe(true);
  await expect(student.getByTestId("share-preview-note")).toBeVisible();
  const quizSlide = student.locator(".kj-slide.kj-layout-quiz");
  for (let i = 0; i < count * 4 && !(await quizSlide.isVisible()); i++) await student.keyboard.press("ArrowRight");
  for (let i = 0; i < 3; i++) await student.keyboard.press("ArrowRight");
  if (!(await quizSlide.isVisible())) await student.keyboard.press("ArrowLeft");
  await expect(quizSlide.locator(".kj-after-class")).toBeVisible();
  await expect(quizSlide.locator("[data-correct]")).toHaveCount(0);
  await shot(student, "21-student-link-preview-no-answers");
  // 课后复习: same link, answers back.
  await page.getByTestId("answers-shown").check();
  await expect(page.getByTestId("share-box")).toContainText("含答案");
  const review = await (await student.request.get(pubUrl)).json();
  expect(review.lesson.answers).toBe("shown");
  expect(quizzes(review).map((q) => q.answer)).toEqual(quizzes(teacherDeck).map((q) => q.answer));
  await student.reload();
  await expect(student.getByTestId("share-preview-note")).toHaveCount(0);
  await page.getByTestId("answers-hidden").check();
  await expect(page.getByTestId("share-box")).toContainText("答案课后公布");

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
    // m3-6: reloading the presenter window keeps the lesson clock running.
    const secs = (t: string | null) => {
      const [m, s] = (t ?? "").split("/")[0]!.trim().split(":").map(Number);
      return m! * 60 + s!;
    };
    await expect.poll(async () => secs(await presenter.getByTestId("presenter-timer").textContent())).toBeGreaterThan(1);
    const before = secs(await presenter.getByTestId("presenter-timer").textContent());
    await presenter.reload();
    await expect(presenter.getByTestId("presenter")).toBeVisible();
    expect(secs(await presenter.getByTestId("presenter-timer").textContent())).toBeGreaterThanOrEqual(before);
    await shot(presenter, "24-presenter-timer-after-reload");
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
    expect(studentDl.suggestedFilename()).toContain("学生版·预习");
    const studentFile = path.join(os.tmpdir(), `kj-student-${Date.now()}.html`);
    await studentDl.saveAs(studentFile);
    const studentHtml = fs.readFileSync(studentFile, "utf8");
    for (const n of notes) expect(studentHtml).not.toContain(JSON.stringify(n).slice(1, 40));
    expect(studentHtml).toContain('"audience":"student"');
    // Default 课前预习: the file carries no quiz explanations either.
    expect(studentHtml).toContain('"answers":"hidden"');
    const embedded = JSON.parse(/<script type="application\/json" id="kj-deck">([\s\S]*?)<\/script>/.exec(studentHtml)![1]!) as { slides: { content: { layout: string; answer?: number; explain?: string } }[] };
    const fileQuizzes = embedded.slides.map((s) => s.content).filter((c) => c.layout === "quiz");
    expect(fileQuizzes.length).toBeGreaterThan(0);
    expect(fileQuizzes.every((q) => q.answer === -1 && q.explain === "")).toBe(true);

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
    await expectChipsClear(off);
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
    await expect(page.getByTestId(`delete-${lessonId}`)).toBeVisible();
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

  await test.step("delete an uploaded PDF (soft): gone from the list, lessons keep working, Undo restores it", async () => {
    const { lesson } = await (await page.request.get(`/api/lessons/${lessonId}`)).json();
    await page.goto("/new");
    const del = page.getByTestId(`delete-doc-${lesson.documentId}`);
    await expect(del).toBeVisible();
    page.once("dialog", (d) => void d.accept());
    await del.click();
    await expect(page.getByTestId("doc-deleted-note")).toContainText("照常可用");
    await expect(del).toHaveCount(0);
    await shot(page, "22-document-deleted-undo");
    expect((await page.request.get(`/api/lessons/${lessonId}`)).status()).toBe(200);
    await page.getByTestId("undo-doc-delete").click();
    await expect(del).toBeVisible();
  });

  await test.step("the same PDF again is found by its sha256: not parsed or uploaded again; a deleted copy is restored", async () => {
    const { lesson } = await (await page.request.get(`/api/lessons/${lessonId}`)).json();
    const writes: string[] = [];
    const onRequest = (r: { method(): string; url(): string }) => {
      if (r.method() === "POST" && /^\/api\/documents(\/[^/]+\/pages)?$/.test(new URL(r.url()).pathname)) writes.push(r.url());
    };
    page.on("request", onRequest);
    await page.goto("/new");
    await page.getByTestId("pdf-input").setInputFiles(PDF);
    await page.waitForURL(new RegExp(`/new/${lesson.documentId}$`));
    await expect(page.getByTestId("textbook-reused")).toContainText("没有重新解析");
    await shot(page, "23-textbook-reused");

    await page.goto("/new");
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId(`delete-doc-${lesson.documentId}`).click();
    await expect(page.getByTestId("doc-deleted-note")).toBeVisible();
    const asked: string[] = [];
    page.once("dialog", (d) => {
      asked.push(d.message());
      void d.accept();
    });
    await page.getByTestId("pdf-input").setInputFiles(PDF);
    await page.waitForURL(new RegExp(`/new/${lesson.documentId}$`));
    await expect(page.getByTestId("textbook-reused")).toContainText("已恢复");
    expect(asked[0]).toContain("恢复");
    page.off("request", onRequest);
    expect(writes).toEqual([]);

    await page.goto("/new");
    await expect(page.locator('[data-testid^="delete-doc-"]')).toHaveCount(1);
  });
});

/** Sets "外部解析服务" in the admin page: `auto` (on once configured; the stubbed MinerU always is), `on` or `off`. */
async function setExternal(page: Page, choice: "auto" | "on" | "off") {
  await page.goto("/admin");
  await page.getByTestId("admin-tab-parsing").click();
  await page.getByTestId(`external-choice-${choice}`).check();
  await expect(page.getByTestId(`external-choice-${choice}`)).toBeChecked();
  await expect(page.getByTestId("parsing-state")).toHaveText(choice === "off" ? /已关闭/ : /已开启|未配置/);
}

test("Chinese CID-font PDF: text is extracted, scanned pages are flagged and can be pasted", async ({ page }) => {
  await login(page);
  await setExternal(page, "off");
  await page.goto("/");
  await page.getByTestId("new-lesson").click();
  await page.getByTestId("pdf-input").setInputFiles(path.resolve("fixtures/pdfs/newton-zh-cid.pdf"));
  await page.waitForURL(/\/new\/[^/]+$/);
  const docId = page.url().split("/").pop()!;
  expect((await (await page.request.get(`/api/documents/${docId}/pages/2`)).json()).text).toContain("牛顿第一定律");

  const scanned = page.getByRole("treeitem").filter({ hasText: "4.4 习题" });
  await expect(page.getByTestId("must-fix-summary")).toContainText("扫描 2 页");
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
  await expect(scanned.getByTestId("chapter-pasted")).toHaveText("2 页老师粘贴");
  await expect(page.getByTestId("must-fix-summary")).toHaveCount(0);
  expect((await (await page.request.get(`/api/documents/${docId}/pages/5`)).json()).parser).toBe("paste");
  await toSettings(page);

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

test("formulas drawn as outlines: the chapters step shows the gap, and pasting closes it", async ({ page }) => {
  await login(page);
  await setExternal(page, "off");
  await page.goto("/");
  await page.getByTestId("new-lesson").click();
  await page.getByTestId("pdf-input").setInputFiles(path.resolve("fixtures/pdfs/kinematics-outlines.pdf"));
  await page.waitForURL(/\/new\/[^/]+$/);
  const docId = page.url().split("/").pop()!;

  const summary = page.getByTestId("must-fix-summary");
  await expect(summary).toContainText("公式没读出 1 页");
  await expect(summary).toHaveAttribute("data-count", "1");
  // With 外部解析服务 off nothing is sent; the teacher is told the gap and how to close it.
  await expect(summary.getByTestId("external-off")).toContainText("管理员关闭了外部解析服务");
  await expect(summary.getByTestId("vision-off")).toContainText("看图模型未配置：请联系管理员在后台“AI 模型”里填写看图模型");
  await expect(page.getByTestId("external-run")).toHaveCount(0);
  await expect(page.getByTestId("external-progress")).toHaveCount(0);
  const lossy = page.getByRole("treeitem").filter({ hasText: "Equations of motion" });
  await expect(lossy.getByTestId("chapter-lossy")).toHaveText("1 页公式没读出");
  await expect(page.getByRole("treeitem").filter({ hasText: "Using the equations" }).getByTestId("chapter-lossy")).toHaveCount(0);
  await expect(page.getByTestId("lossy-pages")).toHaveCount(0);

  await lossy.locator("input[type=checkbox]").check();
  await expect(page.getByTestId("lossy-pages")).toContainText("公式或数字可能没读出来");
  await shot(page, "24-formula-lost");
  await page.getByTestId("paste-open-lossy").click();
  await page.getByTestId("paste-text").fill("3.1 Equations of motion: v = v0 + a t; s = v0 t + a t² / 2; v² = v0² + 2 a s. A car accelerating from rest at 2 m/s² reaches 20 m/s after ten seconds.");
  await page.getByTestId("paste-save").click();

  await expect(page.getByTestId("lossy-pages")).toHaveCount(0);
  await expect(summary).toHaveCount(0);
  await expect(lossy.getByTestId("chapter-lossy")).toHaveCount(0);
  await expect(lossy.getByTestId("chapter-pasted")).toHaveText("1 页老师粘贴");
  const fixed = await (await page.request.get(`/api/documents/${docId}/pages/2`)).json();
  expect(fixed).toMatchObject({ parser: "paste" });
  expect(fixed.text).toContain("v = v0 + a t");
});

/** The kinematics fixture under another title: a different file (sha256) with the same pages. */
async function kinematicsCopy(title: string): Promise<string> {
  const doc = await PDFDocument.load(fs.readFileSync(path.resolve("fixtures/pdfs/kinematics-outlines.pdf")));
  doc.setTitle(title);
  const out = path.join(os.tmpdir(), `kj-${title.replace(/\W+/g, "-")}.pdf`);
  fs.writeFileSync(out, await doc.save());
  return out;
}

test("外部解析服务 on (stubbed MinerU): unread formulas are re-read; after a reload the teacher picks the file again", async ({ page }) => {
  await login(page);
  await setExternal(page, "off");
  await page.goto("/");
  const later = await kinematicsCopy("Kinematics reloaded");
  await page.getByTestId("new-lesson").click();
  await page.getByTestId("pdf-input").setInputFiles(later);
  await page.waitForURL(/\/new\/[^/]+$/);
  const laterId = page.url().split("/").pop()!;
  await expect(page.getByTestId("external-off")).toBeVisible();

  await page.goto("/admin");
  await page.getByTestId("admin-tab-parsing").click();
  await expect(page.getByTestId("parsing-state")).toHaveText(/已关闭/);
  // "跟随配置" (the default): the stubbed online API needs nothing, so it is on.
  await page.getByTestId("external-choice-auto").check();
  await expect(page.getByTestId("parsing-state")).toHaveText(/已开启/);
  await shot(page, "25-admin-parsing");

  // A full page load forgets the file: re-reading asks for it again, and only the same file is accepted.
  await page.goto(`/new/${laterId}`);
  const summary = page.getByTestId("must-fix-summary");
  await expect(summary.getByTestId("external-run")).toHaveText("用外部解析服务读这 1 页");
  const pick = async (file: string) => {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("external-run").click()]);
    await chooser.setFiles(file);
  };
  await pick(PDF);
  await expect(page.getByTestId("external-error")).toContainText("不是这本教材");
  await pick(later);
  await expect(page.getByTestId("external-done")).toHaveAttribute("data-read", "1");
  await expect(summary).toHaveCount(0);
  const section = page.getByRole("treeitem").filter({ hasText: "Equations of motion" });
  await expect(section.getByTestId("chapter-external")).toHaveText("1 页外部解析");
  await expect(section.getByTestId("chapter-lossy")).toHaveCount(0);

  // Right after an upload in this tab, must-fix pages are sent without asking.
  await page.goto("/new");
  await page.getByTestId("pdf-input").setInputFiles(await kinematicsCopy("Kinematics fresh"));
  await page.waitForURL(/\/new\/[^/]+$/);
  const freshId = page.url().split("/").pop()!;
  await expect(page.getByTestId("external-done")).toHaveAttribute("data-read", "1");
  await expect(page.getByTestId("must-fix-summary")).toHaveCount(0);
  await shot(page, "26-external-parsed");
  const reread = await (await page.request.get(`/api/documents/${freshId}/pages/2`)).json();
  expect(reread).toMatchObject({ parser: "mineru-agent/1" });
  expect(reread.text).toContain("\\mathtt { v } = \\mathtt { u }");
  expect((await (await page.request.get(`/api/documents/${freshId}/pages/1`)).json()).parser).toBe("pdfjs/1");

  await setExternal(page, "off");
});

/** An OpenAI-compatible endpoint on this machine standing in for the provider's vision model: E2E never calls outside services. */
async function mockVisionProvider(reply: string) {
  const asked: { model: string; image: string; auth: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      asked.push({ model: parsed.model, image: parsed.messages?.[0]?.content?.[0]?.image_url?.url ?? "", auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: parsed.model, choices: [{ message: { content: reply } }], usage: { prompt_tokens: 1200, completion_tokens: 300 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}/v1`, asked, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("看图模型 fallback (local mock provider): with the external parser off, unread pages are read from their images; the teacher can still correct them", async ({ page }) => {
  const READ = "## 3.1 Equations of motion\n\n$$v = u + at$$\n\n$$s = ut + \\frac{1}{2}at^2$$\n\nA car starts at $2\\ \\mathrm{m/s}$ and reaches $20\\ \\mathrm{m/s}$.";
  const provider = await mockVisionProvider("```markdown\n" + READ + "\n```");
  try {
    await login(page);
    await setExternal(page, "off");
    await page.goto("/admin");
    await page.getByRole("button", { name: "AI 模型 Models" }).click();
    const form = page.getByTestId("add-model-form");
    await form.getByLabel("类型 Type").selectOption("custom");
    await form.getByLabel("名称 Name").fill("Local vision mock");
    await form.getByLabel("模型 Model", { exact: true }).fill("mock-chat");
    await form.getByTestId("vision-model").fill("mock-vl");
    await form.getByTestId("model-base-url").fill(provider.baseUrl);
    await form.getByLabel("API Key").fill("sk-local-mock-key");
    await form.getByRole("button", { name: /保存并启用/ }).click();
    await expect(page.locator("tr:not([data-testid^=setup])", { hasText: "Local vision mock" })).toContainText("mock-vl");

    // A model with no known price counts as paid: unusable until paid parsing is allowed or the admin prices it.
    await page.getByTestId("admin-tab-parsing").click();
    await expect(page.getByTestId("parsing-state")).toHaveText(/已关闭/);
    await expect(page.getByTestId("vision-panel")).toContainText("mock-vl");
    await expect(page.getByTestId("vision-usable")).toHaveText(/未开启/);
    await page.goto("/new");
    await page.getByTestId("pdf-input").setInputFiles(await kinematicsCopy("Kinematics vision paid"));
    await page.waitForURL(/\/new\/[^/]+$/);
    await expect(page.getByTestId("external-off")).toBeVisible();
    await expect(page.getByTestId("vision-run")).toHaveCount(0);
    await expect(page.getByTestId("vision-progress")).toHaveCount(0);

    await page.goto("/admin");
    await page.getByTestId("admin-tab-parsing").click();
    await page.getByTestId("vision-price").fill("0");
    await page.getByTestId("vision-price-save").click();
    await expect(page.getByTestId("vision-usable")).toHaveText(/可用/);
    await shot(page, "27-admin-vision");

    // Right after an upload, must-fix pages go to the vision model one by one.
    await page.goto("/new");
    await page.getByTestId("pdf-input").setInputFiles(await kinematicsCopy("Kinematics vision"));
    await page.waitForURL(/\/new\/[^/]+$/);
    const docId = page.url().split("/").pop()!;
    await expect(page.getByTestId("vision-done")).toHaveAttribute("data-read", "1");
    await expect(page.getByTestId("vision-done")).toContainText("核对");
    await expect(page.getByTestId("must-fix-summary")).toHaveCount(0);
    expect(provider.asked).toHaveLength(1);
    expect(provider.asked[0]!.model).toBe("mock-vl");
    expect(provider.asked[0]!.image).toMatch(/^data:image\/jpeg;base64,\/9j\//);
    const section = page.getByRole("treeitem").filter({ hasText: "Equations of motion" });
    await expect(section.getByTestId("chapter-vision")).toHaveText("1 页看图识别");
    await expect(section.getByTestId("chapter-lossy")).toHaveCount(0);
    const read = await (await page.request.get(`/api/documents/${docId}/pages/2`)).json();
    expect(read).toMatchObject({ parser: "vlm:mock-vl/1" });
    expect(read.text).toContain("$$v = u + at$$");
    expect(read.text).not.toContain("```");

    await section.locator("input[type=checkbox]").check();
    await expect(page.getByTestId("vision-pages")).toContainText("看图模型");
    await shot(page, "28-vision-read");
    await page.getByTestId("paste-open-vision").click();
    await page.getByTestId("paste-text").fill("3.1 Equations of motion: v = u + a t; s = u t + a t² / 2. A car accelerating from 2 m/s reaches 20 m/s after nine seconds.");
    await page.getByTestId("paste-save").click();
    await expect(page.getByTestId("vision-pages")).toHaveCount(0);
    await expect(section.getByTestId("chapter-pasted")).toHaveText("1 页老师粘贴");
    expect((await (await page.request.get(`/api/documents/${docId}/pages/2`)).json()).parser).toBe("paste");
  } finally {
    await page.goto("/admin");
    await page.getByRole("button", { name: "AI 模型 Models" }).click();
    await expect(page.getByTestId("add-model-form")).toBeVisible();
    const row = page.locator("tr:not([data-testid^=setup])", { hasText: "Local vision mock" });
    if (await row.count()) {
      await row.getByRole("button", { name: "删除" }).click();
      await expect(row).toHaveCount(0);
    }
    await provider.close();
  }
});

test("单独的看图模型 (local mock): with no vision model on the text side, a separate provider with its own key reads pages; 测试连接 sends one tiny image", async ({ page }) => {
  const READ = "## 3.1 Equations of motion\n\n$$v = u + at$$\n\n$$s = ut + \\frac{1}{2}at^2$$";
  const provider = await mockVisionProvider(READ);
  try {
    await login(page);
    await setExternal(page, "off");
    await page.goto("/admin");
    await page.getByRole("button", { name: "AI 模型 Models" }).click();
    const card = page.getByTestId("vision-provider-card");
    await expect(card.getByTestId("vision-in-use")).toContainText("还没有看图模型");
    await shot(page, "32-admin-vision-missing");

    await card.getByTestId("vision-provider-kind").selectOption("custom");
    await card.getByLabel("名称 Name").fill("Local qwen mock");
    await card.getByTestId("vision-provider-model").fill("mock-qwen-vl");
    await card.getByTestId("vision-provider-base-url").fill(provider.baseUrl);
    await card.getByTestId("vision-provider-key").fill("sk-vision-only-key");
    await card.getByTestId("vision-provider-save").click();
    await expect(card.getByTestId("vision-in-use")).toContainText("Local qwen mock / mock-qwen-vl（单独的看图模型）");
    await expect(card.getByTestId("vision-provider-row")).toContainText("sk-••••");
    await expect(page.locator("body")).not.toContainText("sk-vision-only-key");

    await card.getByTestId("vision-provider-test").click();
    await expect(page.locator(".alert.success")).toContainText("测试连接：Local qwen mock / mock-qwen-vl 可用");
    expect(provider.asked).toHaveLength(1);
    expect(provider.asked[0]).toMatchObject({ model: "mock-qwen-vl", auth: "Bearer sk-vision-only-key" });
    expect(provider.asked[0]!.image).toMatch(/^data:image\/png;base64,/);
    await shot(page, "33-admin-vision-separate");
    // Outlines and slides still come from the built-in templates: no text model is configured.
    expect((await (await page.request.get("/api/auth/me")).json()).ai).toBe("stub");
    expect(JSON.stringify(await (await page.request.get("/api/admin/ai")).json())).not.toContain("sk-vision-only-key");

    await page.getByTestId("admin-tab-parsing").click();
    await expect(page.getByTestId("vision-panel")).toContainText("mock-qwen-vl");
    await page.getByTestId("vision-price").fill("0");
    await page.getByTestId("vision-price-save").click();
    await expect(page.getByTestId("vision-usable")).toHaveText(/可用/);

    await page.goto("/new");
    await page.getByTestId("pdf-input").setInputFiles(await kinematicsCopy("Kinematics separate vision"));
    await page.waitForURL(/\/new\/[^/]+$/);
    const docId = page.url().split("/").pop()!;
    await expect(page.getByTestId("vision-done")).toHaveAttribute("data-read", "1");
    expect(provider.asked).toHaveLength(2);
    expect(provider.asked[1]).toMatchObject({ model: "mock-qwen-vl", auth: "Bearer sk-vision-only-key" });
    expect((await (await page.request.get(`/api/documents/${docId}/pages/2`)).json()).parser).toBe("vlm:mock-qwen-vl/1");
  } finally {
    await page.goto("/admin");
    await page.getByTestId("admin-tab-parsing").click();
    await expect(page.getByTestId("parsing-state")).toBeVisible();
    const reset = page.getByTestId("vision-price-reset");
    if (await reset.count()) {
      await reset.click();
      await expect(reset).toHaveCount(0);
    }
    await page.getByRole("button", { name: "AI 模型 Models" }).click();
    await expect(page.getByTestId("vision-provider-card")).toBeVisible();
    const row = page.getByTestId("vision-provider-row");
    if (await row.count()) {
      await row.getByRole("button", { name: "删除" }).click();
      await expect(row).toHaveCount(0);
    }
    await provider.close();
  }
});

/**
 * A self-hosted MinerU 4 server (`mineru-kit api-server --api-key …`) on this machine: /v1/health, then /v1/tasks
 * with the raw sub-PDF, its status and its JSON result. Every content page comes back with the same Markdown.
 */
/** A Messages-dialect gateway (POST /v1/messages, SSE) that only answers with the right Bearer key and x-source header. */
async function mockMessagesGateway() {
  const asked: { url: string; auth?: string; source?: string; body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      asked.push({ url: req.url ?? "", auth: req.headers.authorization, source: req.headers["x-source"] as string | undefined, body: parsed });
      if (req.url !== "/v1/messages" || req.headers.authorization !== "Bearer sk-gateway-key" || req.headers["x-source"] !== "tensorhawk") {
        res.statusCode = 401;
        res.end('{"error":"unauthorized"}');
        return;
      }
      res.setHeader("content-type", "text/event-stream");
      const send = (e: Record<string, unknown>) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      send({ type: "message_start", message: { model: parsed.model, usage: { input_tokens: 9, output_tokens: 1 } } });
      for (const piece of ['{"ok"', ":true}"]) send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
      send({ type: "message_delta", usage: { output_tokens: 4 } });
      send({ type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}`, asked, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("Messages 协议 (local mock gateway): protocol, max_tokens and a custom header are saved in 后台 and streamed on 测试连接", async ({ page }) => {
  const gateway = await mockMessagesGateway();
  try {
    await login(page);
    await page.goto("/admin");
    await page.getByTestId("admin-tab-ai").click();
    const form = page.getByTestId("add-model-form");
    await form.getByLabel("类型 Type").selectOption("custom");
    await form.getByLabel("名称 Name").fill("Gateway mock");
    await form.getByLabel("模型 Model", { exact: true }).fill("glm-5.3-flash");
    await form.getByTestId("model-protocol").selectOption("messages");
    await form.getByTestId("model-base-url").fill(gateway.baseUrl);
    await form.getByTestId("model-max-tokens").fill("31200");
    await form.getByTestId("model-headers").fill("x-source: tensorhawk");
    await form.getByLabel("API Key").fill("sk-gateway-key");
    await shot(page, "36-admin-messages-form");
    await form.getByRole("button", { name: /保存并启用/ }).click();
    const row = page.locator("tr:not([data-testid^=setup])", { hasText: "Gateway mock" });
    await expect(row.getByTestId("protocol-summary")).toContainText("Messages /v1/messages · max_tokens 31200 · 请求头 x-source:");
    await expect(row).not.toContainText("tensorhawk");

    await row.getByRole("button", { name: /测试连接/ }).click();
    await expect(page.locator(".alert.success")).toContainText("Gateway mock / glm-5.3-flash");
    expect(gateway.asked.at(-1)).toMatchObject({ url: "/v1/messages", auth: "Bearer sk-gateway-key", source: "tensorhawk", body: { model: "glm-5.3-flash", max_tokens: 31200, stream: true } });

    await row.getByTestId("advanced-toggle").click();
    await expect(page.getByTestId("edit-headers")).toHaveValue("x-source:");
    await page.getByTestId("edit-max-tokens").fill("8000");
    await page.getByTestId("advanced-save").click();
    await expect(row.getByTestId("protocol-summary")).toContainText("max_tokens 8000 · 请求头 x-source:");
    await row.getByRole("button", { name: /测试连接/ }).click();
    await expect(page.locator(".alert.success")).toBeVisible();
    expect(gateway.asked.at(-1)).toMatchObject({ source: "tensorhawk", body: { max_tokens: 8000 } });
    await shotOf(row, "37-admin-messages-row");
  } finally {
    await page.goto("/admin");
    await page.getByTestId("admin-tab-ai").click();
    await expect(page.getByTestId("add-model-form")).toBeVisible();
    const row = page.locator("tr:not([data-testid^=setup])", { hasText: "Gateway mock" });
    if (await row.count()) {
      await row.getByRole("button", { name: "删除" }).click();
      await expect(row).toHaveCount(0);
    }
    await gateway.close();
  }
});

async function mockSelfhostMinerU(key: string) {
  const asked: { path: string; query: string; auth: string | undefined; pages?: number }[] = [];
  const tasks = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const send = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };
      const entry: (typeof asked)[number] = { path: url.pathname, query: url.search, auth: req.headers.authorization };
      asked.push(entry);
      if (url.pathname === "/v1/health") return send(200, { version: "4.0.12" });
      if (req.headers.authorization !== `Bearer ${key}`) return send(401, { error: { code: "invalid_api_key", message: "Invalid or missing API key" } });
      if (url.pathname === "/v1/tasks" && req.method === "POST") {
        const pdf = await PDFDocument.load(Buffer.concat(chunks));
        entry.pages = pdf.getPageCount() / 2;
        const id = `task-${tasks.size + 1}`;
        tasks.set(id, entry.pages);
        return send(202, { task_id: id, status: "queued" });
      }
      const m = /^\/v1\/tasks\/([^/]+)(\/result)?$/.exec(url.pathname);
      const count = m ? tasks.get(m[1]!) : undefined;
      if (!m || count === undefined) return send(404, { error: { code: "not_found", message: "Task not found" } });
      if (!m[2]) return send(200, { task_id: m[1], status: "completed", files: [{ status: "completed" }] });
      const markdown = Array.from({ length: count }, (_, i) => `KJPAGE ${i + 1}\n\n## 3.1 Equations of motion (school server)\n\n$$v = u + at$$\n`).join("\n");
      return send(200, { task_id: m[1], status: "completed", files: [{ status: "completed", content: { markdown } }] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}`, asked, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("MinerU 自部署 (local mock server): unconfigured until the URL is saved, then on by itself; the connection test and the pages use the key", async ({ page }) => {
  const KEY = "school-mineru-key";
  const school = await mockSelfhostMinerU(KEY);
  try {
    await login(page);
    await setExternal(page, "auto");
    await page.getByTestId("mineru-mode-selfhost").check();
    await expect(page.getByTestId("parsing-state")).toHaveText(/未配置/);
    await expect(page.getByTestId("parsing-missing")).toContainText("自部署 MinerU 的地址");
    await expect(page.getByTestId("parsing-test")).toBeDisabled();
    await shot(page, "29-admin-selfhost-missing");
    const setup = page.getByTestId("setup-status");
    await expect(setup.getByTestId("setup-ai")).toContainText("演示模式");
    await expect(setup.getByTestId("setup-vision")).toHaveAttribute("data-ok", "false");
    await expect(setup.getByTestId("setup-external")).toContainText("还没有填服务地址");
    await shotOf(setup, "34-admin-setup-status");

    // The teacher is told in plain Chinese whom to ask; nothing is sent and the page can still be pasted.
    await page.goto("/new");
    await page.getByTestId("pdf-input").setInputFiles(await kinematicsCopy("Kinematics selfhost unconfigured"));
    await page.waitForURL(/\/new\/[^/]+$/);
    const summary = page.getByTestId("must-fix-summary");
    await expect(summary.getByTestId("external-off")).toHaveText("外部解析未配置：请联系管理员在后台“外部解析服务”里填写自部署 MinerU 的地址 · External parser not configured");
    await expect(summary.getByTestId("vision-off")).toContainText("看图模型未配置");
    await expect(summary).toContainText("选到这些页时可以粘贴文字补上");
    await expect(page.getByTestId("external-run")).toHaveCount(0);
    await shot(page, "35-teacher-reminders");
    expect(school.asked).toHaveLength(0);
    await page.goto("/admin");
    await page.getByTestId("admin-tab-parsing").click();
    await expect(page.getByTestId("parsing-state")).toHaveText(/未配置/);

    await page.getByTestId("selfhost-url").fill(`${school.baseUrl}/v1`);
    await page.getByTestId("selfhost-key").fill("not-the-key");
    await page.getByTestId("selfhost-save").click();
    await expect(page.getByTestId("parsing-state")).toHaveText(/已开启/);
    await expect(page.getByTestId("selfhost-url")).toHaveAttribute("placeholder", /^已保存：http:\/\/127\.…:\d+$/);
    await expect(setup.getByTestId("setup-external")).toHaveAttribute("data-ok", "true");
    await page.getByTestId("parsing-test").click();
    await expect(page.getByTestId("parsing-error")).toContainText("API Key");
    await page.getByTestId("selfhost-key").fill(KEY);
    await page.getByTestId("selfhost-save").click();
    await expect(page.getByTestId("parsing-notice")).toBeVisible();
    await page.getByTestId("parsing-test").click();
    await expect(page.getByTestId("parsing-notice")).toContainText("已连上自部署 MinerU 4.0.12");
    await shot(page, "30-admin-selfhost-on");
    // The browser only ever sees hints.
    const view = await (await page.request.get("/api/admin/parsing")).text();
    expect(view).not.toContain(KEY);
    expect(view).not.toContain(school.baseUrl);

    await page.goto("/new");
    await page.getByTestId("pdf-input").setInputFiles(await kinematicsCopy("Kinematics school server"));
    await page.waitForURL(/\/new\/[^/]+$/);
    const docId = page.url().split("/").pop()!;
    await expect(page.getByTestId("external-done")).toHaveAttribute("data-read", "1");
    await expect(page.getByTestId("must-fix-summary")).toHaveCount(0);
    await shot(page, "31-selfhost-parsed");
    const read = await (await page.request.get(`/api/documents/${docId}/pages/2`)).json();
    expect(read).toMatchObject({ parser: "mineru-selfhost/1" });
    expect(read.text).toContain("school server");
    const submitted = school.asked.filter((a) => a.path === "/v1/tasks");
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ auth: `Bearer ${KEY}`, pages: 1 });
    expect(submitted[0]!.query).toContain("ocr_mode=auto");
  } finally {
    await page.goto("/admin");
    await page.getByTestId("admin-tab-parsing").click();
    await page.getByTestId("mineru-mode-agent").check();
    await expect(page.getByTestId("mineru-mode-agent")).toBeChecked();
    await page.getByTestId("external-choice-off").check();
    await expect(page.getByTestId("parsing-state")).toHaveText(/已关闭/);
    await school.close();
  }
});
