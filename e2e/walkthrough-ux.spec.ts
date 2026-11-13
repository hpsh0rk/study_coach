import { expect, test, type Page } from "@playwright/test";
import { PDF } from "./helpers";

async function ensureSignedIn(page: Page) {
  const me = await page.request.get("/api/auth/me");
  const meJson = me.ok() ? ((await me.json()) as { user: unknown | null }) : { user: null };
  if (!meJson.user) {
    await page.goto("/login");
    for (const password of ["Teacher2026x", "Admin12345"]) {
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
      await page.getByLabel("当前密码 Current password").fill("Admin12345");
      await page.getByLabel("新密码 New password").fill("Teacher2026x");
      await page.getByLabel("再输一次 Confirm").fill("Teacher2026x");
      await page.getByRole("button", { name: "保存 Save" }).click();
    }
  } else {
    await page.goto("/");
  }
  await expect(page.getByTestId("new-lesson")).toBeVisible();
}

test("walkthrough UX across 1440x900, 1280x720, and 390x844: chart form, sticky preview, steered regen, stop, theme, dismissible unverified, KaTeX notes, Escape modal, and mobile player", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await ensureSignedIn(page);

  // 1. Upload textbook -> select Chapter 1 -> Settings -> Outline cancel & draft
  await page.getByTestId("new-lesson").click();
  await page.getByTestId("pdf-input").setInputFiles(PDF);
  await page.waitForURL(/\/new\/[^/]+$/);
  await page.getByRole("treeitem").filter({ hasText: "Chapter 1" }).first().locator("input[type=checkbox]").check();
  await page.getByTestId("chapters-next").click();
  if (await page.getByTestId("thin-warning").isVisible()) {
    await page.getByTestId("chapters-next").click();
  }
  await page.waitForURL(/\/settings$/);
  await page.getByRole("button", { name: /生成大纲 Draft outline/ }).click();
  await page.waitForURL(/\/outline$/);
  await expect(page.getByTestId("outline-row").first()).toBeVisible();

  const lessonId = /\/lessons\/([^/]+)\//.exec(page.url())![1]!;
  const csrf = { "x-kj-csrf": "1" };

  // Inject an objective with $v = f\lambda$ and verify KaTeX renders in OutlineStep objectives!
  const lessonInit = await (await page.request.get(`/api/lessons/${lessonId}`)).json();
  const draftVer = lessonInit.draft;
  const updatedOutline = {
    ...draftVer.outline,
    objectives: ["Use $v = f\\lambda$ to calculate wave speed", ...draftVer.outline.objectives.slice(1)],
  };
  await page.request.put(`/api/lessons/${lessonId}/outline-versions/${draftVer.id}`, {
    headers: csrf,
    data: { outline: updatedOutline, rev: draftVer.rev },
  });
  await page.reload();
  await expect(page.locator(".objectives .kj-math .katex").first()).toBeVisible();

  // Confirm outline -> navigate to slides without auto-finishing when stopped
  await page.route(`**/api/lessons/${lessonId}/outline-versions/*/slides/*/generate`, async (route) => {
    await new Promise((r) => setTimeout(r, 350));
    await route.continue().catch(() => undefined);
  });
  await page.getByTestId("confirm-outline").click();
  if (await page.getByTestId("ack-box").isVisible().catch(() => false)) {
    await page.getByTestId("ack-box").getByRole("button").click();
  }
  await page.waitForURL(/\/slides$/);

  // Stop/Cancel button during batch slide generation
  const stopBtn = page.getByTestId("stop-generate");
  await expect(stopBtn).toBeVisible();
  await stopBtn.click();
  await expect(stopBtn).toHaveCount(0);
  await page.unroute(`**/api/lessons/${lessonId}/outline-versions/*/slides/*/generate`);

  // Finish remaining slides
  if (await page.getByTestId("generate-all").isVisible()) {
    await page.getByTestId("generate-all").click();
  }
  const totalSpecs = updatedOutline.slides.length;
  await expect(page.getByTestId("gen-progress")).toContainText(`已生成 ${totalSpecs} / ${totalSpecs}`, { timeout: 60_000 });

  // 2. Quick theme switcher (classic <-> chalk) in GenerateStep without unconfirming outline
  await expect(page.getByTestId("theme-switcher")).toBeVisible();
  await page.getByTestId("theme-chalk").click();
  await expect(page.locator(".preview-pane .kj-slide.kj-theme-chalk")).toBeVisible();
  const afterThemePatch = await (await page.request.get(`/api/lessons/${lessonId}`)).json();
  expect(afterThemePatch.lesson.theme).toBe("chalk");
  expect(afterThemePatch.confirmed).not.toBeNull();
  await page.getByTestId("theme-classic").click();
  await expect(page.locator(".preview-pane .kj-slide.kj-theme-classic")).toBeVisible();

  // 3. Steered single-slide regeneration sends optional instruction in POST body
  let capturedGenerateBody: Record<string, unknown> | null = null;
  await page.route(`**/api/lessons/${lessonId}/outline-versions/*/slides/*/generate`, async (route) => {
    capturedGenerateBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue();
  });
  await page.getByTestId("thumb").first().click();
  await page.getByTestId("toggle-regen-hint").click();
  await page.getByTestId("regenerate-instruction").fill("  换一组数字  ");
  await page.getByTestId("regenerate").click();
  await expect.poll(() => capturedGenerateBody).toEqual({ regenerate: true, instruction: "换一组数字" });
  await page.unroute(`**/api/lessons/${lessonId}/outline-versions/*/slides/*/generate`);

  // 4. Structured chart editor & sticky live preview on 1280x720 laptop viewport + wide display formula fit
  await page.setViewportSize({ width: 1280, height: 720 });
  const conceptThumb = page.getByTestId("thumb").filter({ hasText: "概念讲解" }).first();
  await conceptThumb.click();
  await page.getByTestId("edit-slide").click();
  const editor = page.getByTestId("slot-editor");
  await expect(editor).toBeVisible();

  // Verify sticky live preview stays visible at top when scrolling down the form on 1280x720
  const previewBeforeTop = (await editor.locator(".slot-preview").boundingBox())!.y;
  await editor.evaluate((el) => {
    el.scrollTop = 260;
  });
  const previewAfterTop = (await editor.locator(".slot-preview").boundingBox())!.y;
  expect(Math.abs(previewAfterTop - previewBeforeTop)).toBeLessThan(8);

  // Switch visual to chart -> structured form (NOT bare raw JSON), edit fields, and verify collapsible Raw JSON
  await editor.getByTestId("visual-kind").selectOption("chart");
  await expect(editor.getByTestId("chart-type")).toBeVisible();
  await editor.getByTestId("chart-type").selectOption("bar");
  await editor.locator('[data-slot-path="visual.xLabel"]').fill("介质 Medium");
  await editor.locator('[data-slot-path="visual.yLabel"]').fill("波速 v / (m/s)");
  await editor.getByTestId("chart-categories").fill("空气 | 水 | 钢铁");
  await editor.getByTestId("chart-series").fill("声速: 340 | 1480 | 5960");
  await expect(editor.getByTestId("chart-raw-json-toggle")).toBeVisible();

  // Also enter a bullet with unverified number 343 to test dismissible 待核实, plus $v = f\lambda$ in speaker notes
  await editor.locator('[data-slot-path="bullets"]').fill("Sound travels at 343 m/s in air");
  await editor.getByLabel("讲稿 Speaker notes").fill("讲解波速公式 $v = f\\lambda$，并强调 $\\lambda$ 的单位。");
  await page.getByTestId("save-slide").click();
  await expect(editor).toHaveCount(0);

  // Verify ECharts SVG rendered and speaker notes in GenerateStep render KaTeX (no raw $...$)
  await expect(page.locator(".preview-pane .kj-plot svg")).toBeVisible();
  await expect(page.locator(".preview-pane .notes .kj-math .katex").first()).toBeVisible();

  // 5. Dismissible 待核实 warnings persisted in localStorage with toggle to view/restore
  await expect(page.getByTestId("unverified")).toContainText("343");
  await expect(conceptThumb.getByTestId("unverified-badge")).toBeVisible();
  await page.getByTestId("dismiss-unverified").first().click();
  await expect(page.getByTestId("toggle-dismissed-unverified")).toBeVisible();
  if (await page.getByTestId("dismiss-all-unverified").isVisible().catch(() => false)) {
    await page.getByTestId("dismiss-all-unverified").click();
  } else {
    while ((await page.getByTestId("dismiss-unverified").count()) > 0) {
      await page.getByTestId("dismiss-unverified").first().click();
    }
  }
  await expect(page.getByTestId("unverified")).toHaveCount(0);
  await expect(conceptThumb.getByTestId("unverified-badge")).toHaveCount(0);
  await expect(page.getByTestId("unverified-dismissed-bar")).toBeVisible();

  // Reload confirms localStorage persistence
  await page.reload();
  await conceptThumb.click();
  await expect(page.getByTestId("unverified")).toHaveCount(0);
  await expect(page.getByTestId("unverified-dismissed-bar")).toBeVisible();
  await page.getByTestId("toggle-dismissed-unverified").click();
  await page.getByTestId("restore-unverified").first().click();
  await expect(page.getByTestId("unverified")).toContainText("343");

  // Patch wide display formula on concept slide & math in quiz answer to verify formula horizontal auto-fit & Presenter KaTeX
  const latestData = await (await page.request.get(`/api/lessons/${lessonId}`)).json();
  const conceptSlide = latestData.slides.find((s: { pageType: string }) => s.pageType === "concept")!;
  await page.request.patch(`/api/lessons/${lessonId}/slides/${conceptSlide.id}`, {
    headers: csrf,
    data: {
      content: {
        layout: "statement",
        title: "Waves carry energy",
        bullets: ["Wave equation links speed and wavelength"],
        visual: {
          kind: "formula",
          tex: "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a},\\; \\vec{p} = m\\vec{v}",
          caption: "Quadratic & momentum",
        },
        terms: [],
      },
      notes: "板书推导 $v = f\\lambda$ 与 $T = 1/f$。",
    },
  });
  const quizSlideRow = latestData.slides.find((s: { layout: string }) => s.layout === "quiz")!;
  await page.request.patch(`/api/lessons/${lessonId}/slides/${quizSlideRow.id}`, {
    headers: csrf,
    data: {
      content: {
        ...quizSlideRow.content,
        poll: true,
        explain: "由 $v = f\\lambda$ 可知频率加倍时 $\\lambda$ 减半。",
      },
      notes: "先提问再代入 $v = 340$ m/s 与 $\\lambda = 2$ m。",
    },
  });

  // 6. Classroom Player (1280x720): wide formula auto-fits without clipping, SourcePage Escape closes modal without leaving PlayPage
  await page.goto(`/play/${lessonId}`);
  const player = page.locator(".kj-player");
  await expect(player).toBeVisible();

  const conceptIdx = latestData.slides.findIndex((s: { id: string }) => s.id === conceptSlide.id);
  for (let i = 0; i < 40 && Number(await player.getAttribute("data-index")) < conceptIdx; i++) {
    await page.keyboard.press("PageDown");
  }
  const formulaFit = await page.locator(".kj-formula-tex").evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    fontPx: parseFloat(getComputedStyle(el).fontSize),
  }));
  expect(formulaFit.scrollWidth).toBeLessThanOrEqual(formulaFit.clientWidth + 2);
  expect(formulaFit.fontPx).toBeGreaterThanOrEqual(48 - 0.5);

  // Open textbook source modal -> check dialog semantics -> press Escape -> closes modal, stays on /play/:id!
  await page.locator(".kj-source").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(page.url()).toContain(`/play/${lessonId}`);

  // 7. Presenter View: KaTeX rendered in both Speaker Notes and Answer Key (zero raw $...$)
  await page.goto(`/presenter/${lessonId}`);
  await expect(page.getByTestId("presenter")).toBeVisible();
  const pPlayer = page.locator(".kj-player");
  const quizIdx = latestData.slides.findIndex((s: { id: string }) => s.id === quizSlideRow.id);
  for (let i = 0; i < 40 && Number(await pPlayer.getAttribute("data-index")) < quizIdx; i++) {
    await page.keyboard.press("PageDown");
  }
  await expect(page.getByTestId("presenter-notes").locator(".kj-math .katex").first()).toBeVisible();
  await expect(page.getByTestId("presenter-answers").locator(".kj-math .katex").first()).toBeVisible();

  // 8. Mobile 390x844 student view & responsive narrow-viewport checks
  const shareRes = await page.request.post(`/api/lessons/${lessonId}/share`, {
    headers: csrf,
    data: { ack: true, answers: "shown" },
  });
  const shareJson = await shareRes.json();

  const mobileCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "zh-CN",
    isMobile: true,
    hasTouch: true,
  });
  const mobile = await mobileCtx.newPage();
  await mobile.goto(`${baseURL}${shareJson.path}`);
  await expect(mobile.locator(".kj-player")).toBeVisible();

  // Open ink toolbar on 390x844: .kj-controls wraps cleanly inside viewport (no negative left / right > 390)
  await mobile.getByRole("button", { name: "Pen · 画笔批注 (D)" }).click();
  await expect(mobile.getByRole("button", { name: "红色画笔 · Red pen" })).toBeVisible();
  const barBox = (await mobile.locator(".kj-controls").boundingBox())!;
  expect(barBox.x).toBeGreaterThanOrEqual(0);
  expect(barBox.x + barBox.width).toBeLessThanOrEqual(390);
  await mobile.getByRole("button", { name: "Pen · 画笔批注 (D)" }).click();

  // Single-finger horizontal touch swipe navigates slides on mobile
  const idx0 = await mobile.locator(".kj-player").getAttribute("data-index");
  await mobile.evaluate(() => {
    const el = document.querySelector(".kj-player-frame")!;
    const mk = (x: number, y: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent("touchstart", { touches: [mk(320, 420)], changedTouches: [mk(320, 420)], bubbles: true }));
    el.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [mk(80, 422)], bubbles: true }));
  });
  await expect.poll(() => mobile.locator(".kj-player").getAttribute("data-index")).not.toBe(idx0);

  // Mobile-portrait "横屏全屏 · Rotate" button scales up stage width (> 1.7x portrait width)
  const portraitSlideArea = await mobile.locator(".kj-slide").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  });
  const rotateBtn = mobile.getByTestId("player-rotate");
  await expect(rotateBtn).toBeVisible();
  await rotateBtn.click();
  await expect(mobile.locator(".kj-player")).toHaveClass(/kj-rotated/);
  const rotatedSlideArea = await mobile.locator(".kj-slide").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  });
  expect(rotatedSlideArea).toBeGreaterThan(portraitSlideArea * 2.5);
  await mobileCtx.close();

  // Responsive < 768px check on PresenterPage, TextbooksPage, OutlineStep, and AdminPage at 390x844
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/presenter/${lessonId}`);
  const presenterStageBox = (await page.locator(".presenter-current").boundingBox())!;
  expect(presenterStageBox.width).toBeGreaterThan(320);

  for (const route of ["/textbooks", `/lessons/${lessonId}/outline`, "/admin"]) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(docOverflow, `${route} horizontal document overflow at 390x844`).toBeLessThanOrEqual(2);
  }
});
