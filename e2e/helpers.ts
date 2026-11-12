import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

export const PDF = path.resolve("fixtures/pdfs/waves-mini.pdf");
const SHOTS_DIR = process.env.SHOTS_DIR;

export async function shot(page: Page, name: string) {
  if (!SHOTS_DIR) return;
  // A full-page capture draws the sticky header wherever the page is scrolled to.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: true });
}

export async function shotOf(el: Locator, name: string) {
  if (SHOTS_DIR) await el.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

/** No visible source chip reaches the player's control bar (it floats over the slide's bottom edge). */
export async function expectChipsClear(page: Page) {
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
export async function toSettings(page: Page, thinShot?: string) {
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

/** Sets "外部解析服务" in the admin page: `auto` (on once configured; the stubbed MinerU always is) or `off`. */
export async function setExternal(page: Page, choice: "auto" | "off") {
  await page.goto("/admin");
  await page.getByTestId("admin-tab-parsing").click();
  await page.getByTestId("external-enabled").setChecked(choice === "auto");
  await expect(page.getByTestId("external-enabled")).toBeChecked({ checked: choice === "auto" });
  await expect(page.getByTestId("parsing-state")).toHaveText(choice === "off" ? /已关闭/ : /已开启|未配置/);
}

/** The kinematics fixture under another title: a different file (sha256) with the same pages. */
export async function kinematicsCopy(title: string): Promise<string> {
  const doc = await PDFDocument.load(fs.readFileSync(path.resolve("fixtures/pdfs/kinematics-outlines.pdf")));
  doc.setTitle(title);
  const out = path.join(os.tmpdir(), `kj-${title.replace(/\W+/g, "-")}.pdf`);
  fs.writeFileSync(out, await doc.save());
  return out;
}
