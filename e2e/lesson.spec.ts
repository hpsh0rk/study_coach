import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";
import { expectChipsClear, PDF, shot, shotOf, toSettings } from "./helpers";

const positionOf = async (player: Locator) => `${await player.getAttribute("data-index")}.${await player.getAttribute("data-step")}`;

test("upload → chapters → settings → outline (gate) → generate → edit/undo/待核实 → presenter → offline file", async ({ page, browser }) => {
  test.setTimeout(240_000);
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

  await test.step("editable PPTX export: one slide per deck slide, speaker notes, and real browser ECharts PNG rasterization across classic & chalk", async () => {
    const unzipEntries = (pptxPath: string): Map<string, Buffer> => {
      const buf = fs.readFileSync(pptxPath);
      let eocd = buf.length - 22;
      while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
      if (eocd < 0) throw new Error("missing ZIP EOCD");
      const total = buf.readUInt16LE(eocd + 10);
      let ptr = buf.readUInt32LE(eocd + 16);
      const out = new Map<string, Buffer>();
      for (let i = 0; i < total; i++) {
        if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error("invalid central directory entry");
        const method = buf.readUInt16LE(ptr + 10);
        const compSize = buf.readUInt32LE(ptr + 20);
        const nameLen = buf.readUInt16LE(ptr + 28);
        const extraLen = buf.readUInt16LE(ptr + 30);
        const commentLen = buf.readUInt16LE(ptr + 32);
        const localOff = buf.readUInt32LE(ptr + 42);
        const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(dataStart, dataStart + compSize);
        if (!name.endsWith("/")) out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
        ptr += 46 + nameLen + extraLen + commentLen;
      }
      return out;
    };

    const teacherDeck = await (await page.request.get(`/api/lessons/${lessonId}/deck`)).json();
    const conceptSlide = teacherDeck.slides.find((s: { content: { layout: string } }) => s.content.layout === "statement")!;
    const patchRes = await page.request.patch(`/api/lessons/${lessonId}/slides/${conceptSlide.id}`, {
      headers: { "x-kj-csrf": "1" },
      data: {
        content: {
          ...conceptSlide.content,
          visual: { kind: "function", expr: "1/x", x: [-2, 2], y: [-5, 5], xLabel: "x", yLabel: "y", params: [] },
        },
      },
    });
    expect(patchRes.status()).toBe(200);

    const mediaBuffers: Record<string, Buffer> = {};
    for (const theme of ["classic", "chalk"] as const) {
      expect((await page.request.patch(`/api/lessons/${lessonId}`, { headers: { "x-kj-csrf": "1" }, data: { theme } })).status()).toBe(200);
      await page.goto(`/lessons/${lessonId}/slides`);
      await expect(page.getByTestId("thumb").first()).toBeVisible();
      const slides = await page.getByTestId("thumb").count();
      expect(slides).toBeGreaterThan(3);
      await page.getByText("导出 Export").click();
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-pptx").click()]);
      const file = path.join(os.tmpdir(), `kj-${theme}-${Date.now()}.pptx`);
      await download.saveAs(file);
      expect(download.suggestedFilename()).toMatch(/\.pptx$/);
      const entries = unzipEntries(file);
      const names = [...entries.keys()];
      expect(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(slides);
      expect(names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))).toHaveLength(slides);
      const mediaName = names.find((n) => /^ppt\/media\/.+\.png$/.test(n));
      expect(mediaName, `${theme} browser-rasterized ECharts PNG`).toBeDefined();
      const png = entries.get(mediaName!)!;
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(png.byteLength).toBeGreaterThan(1000);
      expect(png.readUInt32BE(16)).toBeGreaterThan(100);
      expect(png.readUInt32BE(20)).toBeGreaterThan(100);
      mediaBuffers[theme] = png;
    }
    expect(mediaBuffers.classic!.equals(mediaBuffers.chalk!)).toBe(false);
    expect((await page.request.patch(`/api/lessons/${lessonId}`, { headers: { "x-kj-csrf": "1" }, data: { theme: "classic" } })).status()).toBe(200);
    expect((await page.request.post(`/api/lessons/${lessonId}/slides/${conceptSlide.id}/undo`, { headers: { "x-kj-csrf": "1" } })).status()).toBe(200);
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
