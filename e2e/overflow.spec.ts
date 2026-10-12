import { expect, test } from "@playwright/test";

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
  expect(cells.length).toBe(38);
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
        };
      });
      expect(clash.under, `${size.width}×${size.height} slide ${slide + 1}`).toEqual([]);
      expect(clash.visible).toBeGreaterThan(0);
      if (clash.hidden) expect(clash.more).toBe(`+${clash.hidden}`);
      if (process.env.SHOTS_DIR && slide === 0) await page.screenshot({ path: `${process.env.SHOTS_DIR}/source-chips-${size.width}x${size.height}.png` });
      for (let i = 0; i < 12 && slide < 2 && !(await page.locator(".kj-counter").textContent())!.startsWith(`${slide + 2} /`); i++) await page.keyboard.press("PageDown");
    }
  }
});
