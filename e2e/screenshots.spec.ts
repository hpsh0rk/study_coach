import { expect, test } from "@playwright/test";
import { s0DemoDeck } from "../fixtures/decks/s0-demo.ts";

// Writes the S0 demo deck as images: SHOTS_DIR=... pnpm screenshots
const OUT = process.env.SHOTS_DIR ?? "test-results/s0-deck";

test("S0 demo deck screenshots", async ({ page }) => {
  for (let i = 1; i <= s0DemoDeck.slides.length; i++) {
    await page.goto(`/demo/play?slide=${i}&step=99`);
    await expect(page.locator(".kj-slide").first()).toBeVisible();
    await page.waitForLoadState("load");
    await page.waitForTimeout(i === 8 ? 5000 : 500);
    await page.screenshot({ path: `${OUT}/slide-${String(i).padStart(2, "0")}.png` });
  }
  await page.goto("/demo");
  await page.waitForLoadState("load");
  await page.screenshot({ path: `${OUT}/overview.png`, fullPage: true });

  // Builds: slide 9 step-by-step and slide 10 after tapping hotspot A.
  await page.goto("/demo/play?slide=9&step=0");
  await page.waitForLoadState("load");
  await page.screenshot({ path: `${OUT}/slide-09-step0.png` });
  await page.goto("/demo/play?slide=10&step=0");
  await page.waitForLoadState("load");
  await page.locator(".kj-reveal-hotspot").first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/slide-10-hotspot.png` });
});
