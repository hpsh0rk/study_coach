import { expect, test as base } from "@playwright/test";

export { expect };

/**
 * Every scenario starts where the old login helper left it: authenticated on
 * the lesson list. Authentication itself is performed once by auth.spec.ts.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.goto("/");
    await expect(page.getByTestId("new-lesson")).toBeVisible();
    await use(page);
  },
});
