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
