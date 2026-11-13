import { expect, test, type Page } from "@playwright/test";
import { stepsOf } from "../packages/templates/src/index.ts";
import { CLASSROOM_FIXTURES } from "../packages/templates/src/classroom-fixtures.ts";

const RUNTIME_PROFILES = [
  { id: "16:9", viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
  { id: "4:3", viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 },
  { id: "small-16:9", viewport: { width: 1024, height: 576 }, deviceScaleFactor: 1 },
  { id: "high-dpi", viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 },
] as const;

async function fixturePlayerMeasurement(page: Page) {
  return page.evaluate(() => window.kjPlayerMeasure!());
}

async function goToFixtureSlide(page: Page, fixtureIndex: number) {
  await page.keyboard.press("Home");
  const fixture = CLASSROOM_FIXTURES[0]!;
  const moves = fixture.slides
    .slice(0, fixtureIndex)
    .reduce((total, slide) => total + (slide.content.layout === "quiz" && slide.content.poll ? 1 : stepsOf(slide.content)) + 1, 0);
  for (let move = 0; move < moves; move++) await page.keyboard.press("PageDown");
  await expect(page.locator(".kj-player")).toHaveAttribute("data-index", String(fixtureIndex));
  await expect(page.locator(".kj-player")).toHaveAttribute("data-step", "0");
}

// Every layout filled to its hard budget (en + zh) must fit at 1920×1080 with body text ≥ 48px (T-02),
// and the last reveal step must show everything.
test("all layouts fit at max budget with body text >= 48px", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/dev/gallery");
  await page.waitForFunction(() => document.body.dataset.galleryReady === "1", null, { timeout: 30_000 });
  const cells = await page.$$eval("figure[data-testid^='slide-']", (figs) =>
    figs.map((f) => ({ id: f.getAttribute("data-testid"), overflow: f.getAttribute("data-overflow") ?? "?", minFont: Number(f.getAttribute("data-min-font")), hidden: f.querySelectorAll(".kj-step-hidden").length })),
  );
  expect(errors).toEqual([]);
  expect(cells.length).toBe(52);
  for (const c of cells) {
    expect.soft(c.overflow, `${c.id} overflowing slots`).toBe("");
    expect.soft(c.minFont, `${c.id} smallest body font`).toBeGreaterThanOrEqual(48 - 0.01);
    expect.soft(c.hidden, `${c.id} elements still hidden at the last reveal step`).toBe(0);
  }
  if (process.env.SHOTS_DIR) {
    for (const id of ["order-sample", "order-match-zh", "quiz-poll-en", "experiment-sample"]) {
      const fig = page.getByTestId(`slide-${id}`);
      if (await fig.count()) await fig.locator(".kj-slide").screenshot({ path: `${process.env.SHOTS_DIR}/18-gallery-${id}.png` });
    }
  }
});

test("classroom gallery replays fit in both themes at every reveal step", async ({ page }) => {
  for (const size of [{ width: 1920, height: 1080 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size);
    for (const theme of ["classic", "chalk"]) {
      for (let reveal = 0; reveal <= 3; reveal++) {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`/dev/gallery?fixture=classroom&theme=${theme}&reveal=${reveal}`);
        await page.waitForFunction(() => document.body.dataset.galleryReady === "1", null, { timeout: 30_000 });
        const cells = await page.$$eval("figure[data-testid^='slide-classroom-']", (figs) =>
          figs.map((figure) => ({
            id: figure.getAttribute("data-testid"),
            overflow: figure.getAttribute("data-overflow") ?? "?",
            minFont: Number(figure.getAttribute("data-min-font")),
            hidden: figure.querySelectorAll(".kj-step-hidden").length,
            steps: Number((figure as HTMLElement).dataset.steps),
            shown: Number((figure as HTMLElement).dataset.reveal),
          })),
        );
        expect(errors, `${theme} ${size.width}×${size.height} reveal ${reveal}`).toEqual([]);
        expect(cells).toHaveLength(14);
        for (const cell of cells) {
          expect.soft(cell.overflow, `${cell.id} ${theme} reveal ${reveal}`).toBe("");
          expect.soft(cell.minFont, `${cell.id} ${theme} reveal ${reveal}`).toBeGreaterThanOrEqual(48 - 0.01);
          if (cell.shown === cell.steps) expect.soft(cell.hidden, `${cell.id} final reveal`).toBe(0);
        }
        page.removeAllListeners("pageerror");
      }
    }
  }
});

test("classroom fixture players fit every real reveal state across the viewport matrix", async ({ browser, baseURL }) => {
  let cells = 0;
  for (const profile of RUNTIME_PROFILES) {
    const context = await browser.newContext({ viewport: profile.viewport, deviceScaleFactor: profile.deviceScaleFactor });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const theme of ["classic", "chalk"]) {
      for (const fixture of CLASSROOM_FIXTURES) {
        await page.goto(`${baseURL}/dev/player?fixture=${fixture.id}&theme=${theme}`);
        await page.waitForFunction(() => document.body.dataset.playerReady === "1");
        await page.keyboard.press("Home");
        for (let slideIndex = 0; slideIndex < fixture.slides.length; slideIndex++) {
          const content = fixture.slides[slideIndex]!.content;
          const reveals = stepsOf(content);
          for (let reveal = 0; reveal <= reveals; reveal++) {
            await expect(page.locator(".kj-player")).toHaveAttribute("data-index", String(slideIndex));
            await expect(page.locator(".kj-player")).toHaveAttribute("data-step", String(reveal));
            if (reveal === 0 && content.layout === "quiz" && content.poll) {
              await page.locator(".kj-tally-inputs input").first().fill("5");
            }
            const measured = await fixturePlayerMeasurement(page);
            const at = `${fixture.id}/${theme}/${profile.id}/slide-${slideIndex}/reveal-${reveal}`;
            expect.soft(measured.overflow, `${at} overflowing slots`).toEqual([]);
            expect.soft(measured.clipped, `${at} clipped descendants`).toEqual([]);
            expect.soft(measured.sourcesUnderControls, `${at} sources under controls`).toEqual([]);
            expect.soft(measured.minFont, `${at} smallest body font`).toBeGreaterThanOrEqual(48 - 0.01);
            expect.soft(measured.deviceScaleFactor, `${at} device scale`).toBe(profile.deviceScaleFactor);
            if (reveal === reveals) expect.soft(measured.hidden, `${at} hidden at final reveal`).toBe(0);
            cells++;
            if (reveal < reveals || slideIndex < fixture.slides.length - 1) await page.keyboard.press("PageDown");
          }
        }
      }
    }
    expect(errors, `${profile.id} page errors`).toEqual([]);
    await context.close();
  }
  expect(cells).toBe(280);
});

test("classroom poll and simulation survive resize and fullscreen", async ({ page }) => {
  const fixture = CLASSROOM_FIXTURES[0]!;
  await page.setViewportSize({ width: 1024, height: 576 });
  await page.goto("/dev/player?fixture=waves-en&theme=classic");
  await page.waitForFunction(() => document.body.dataset.playerReady === "1");

  const experimentIndex = fixture.slides.findIndex((slide) => slide.specId === "en-experiment");
  await goToFixtureSlide(page, experimentIndex);
  const sim = page.locator(".kj-sim iframe");
  await expect(sim).toBeHidden();
  await page.keyboard.press("PageDown");
  await expect(sim).toBeVisible();
  await expect(sim.contentFrame().locator("canvas")).toBeVisible();
  await page.keyboard.press("PageDown");
  await expect(page.locator('.kj-chip[data-outcome="true"]')).toBeVisible();

  const pollIndex = fixture.slides.findIndex((slide) => slide.specId === "en-check");
  await goToFixtureSlide(page, pollIndex);
  // With 0 votes entered, PageDown skips the empty '–' tally bar step and reveals the answer directly.
  await page.keyboard.press("PageDown");
  await expect(page.locator(".kj-player")).toHaveAttribute("data-step", "2");
  await expect(page.locator(".kj-answer")).toBeVisible();
  await page.keyboard.press("PageUp");
  await expect(page.locator(".kj-player")).toHaveAttribute("data-step", "0");

  const votes = page.locator(".kj-tally-inputs input");
  await expect(votes).toHaveCount(3);
  await votes.nth(0).fill("3");
  await votes.nth(1).fill("12");
  await votes.nth(2).fill("5");
  await page.keyboard.press("PageDown");
  await expect(page.locator(".kj-tally-n").nth(1)).toHaveText("12 · 60%");
  await expect(page.locator(".kj-answer")).toBeHidden();
  await page.keyboard.press("PageDown");
  await expect(page.locator(".kj-answer")).toBeVisible();

  const transforms: string[] = [];
  for (const viewport of [{ width: 1024, height: 576 }, { width: 1024, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.locator(".kj-stage").getAttribute("style")).toContain("transform");
    transforms.push((await page.locator(".kj-stage").evaluate((stage) => (stage as HTMLElement).style.transform)));
    const measured = await fixturePlayerMeasurement(page);
    expect(measured.overflow, `${viewport.width}×${viewport.height} overflow`).toEqual([]);
    expect(measured.clipped, `${viewport.width}×${viewport.height} clipping`).toEqual([]);
    expect(measured.sourcesUnderControls, `${viewport.width}×${viewport.height} source collision`).toEqual([]);
  }
  expect(new Set(transforms).size).toBeGreaterThan(1);

  await page.keyboard.press("f");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains("kj-player") ?? false)).toBe(true);
  expect((await fixturePlayerMeasurement(page)).overflow).toEqual([]);
  await page.keyboard.press("f");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
});

// Source chips sit in the slide footer; the player's control bar floats over the bottom edge. However many
// pages a slide cites, and at any window size, no visible chip may be under the bar (student link, projector
// and offline file all use this player).
test("source chips never sit under the player's control bar", async ({ page }) => {
  for (const size of [
    { width: 1024, height: 576 },
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
    { width: 1280, height: 1000 },
  ]) {
    await page.setViewportSize(size);
    await page.goto("/dev/player");
    await page.waitForFunction(() => document.body.dataset.playerReady === "1");
    for (let slide = 0; slide < 3; slide++) {
      await expect(page.locator(".kj-slide .kj-source:not([hidden])").first()).toBeVisible();
      const clash = await page.evaluate(() => {
        const bar = document.querySelector(".kj-controls")!.getBoundingClientRect();
        const chips = [...document.querySelectorAll<HTMLElement>(".kj-slide .kj-source")].filter((c) => !c.hidden);
        return {
          visible: chips.length,
          hidden: document.querySelectorAll(".kj-slide .kj-source[hidden]").length,
          more: document.querySelector(".kj-source-more")?.textContent ?? "",
          under: chips
            .map((c) => ({ text: c.textContent, r: c.getBoundingClientRect() }))
            .filter(({ r }) => r.right > bar.left && r.bottom > bar.top && r.top < bar.bottom)
            .map(({ text }) => text),
          clipped: [...document.querySelectorAll<HTMLElement>(".kj-slide [data-clip]")].filter((c) => c.scrollHeight > c.clientHeight + 1).map((c) => c.textContent),
        };
      });
      expect(clash.under, `${size.width}×${size.height} slide ${slide + 1}`).toEqual([]);
      expect(clash.clipped, `${size.width}×${size.height} slide ${slide + 1} clipped option text`).toEqual([]);
      expect(clash.visible).toBeGreaterThan(0);
      if (clash.hidden) expect(clash.more).toBe(`+${clash.hidden}`);
      if (process.env.SHOTS_DIR && slide === 0) await page.screenshot({ path: `${process.env.SHOTS_DIR}/source-chips-${size.width}x${size.height}.png` });
      for (let i = 0; i < 12 && slide < 2 && !(await page.locator(".kj-counter").textContent())!.startsWith(`${slide + 2} /`); i++) await page.keyboard.press("PageDown");
    }
  }
});
