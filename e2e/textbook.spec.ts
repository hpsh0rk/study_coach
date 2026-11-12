import * as path from "node:path";
import { expect, test } from "./fixtures";
import { kinematicsCopy, PDF, setExternal, shot, toSettings } from "./helpers";
import { mockVisionProvider } from "./mocks";

test("Chinese CID-font PDF: text is extracted, scanned pages are flagged and can be pasted", async ({ page }) => {
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
  await expect(other.getByTestId("outline-row").first().getByLabel("标题 Title")).not.toHaveValue("");
  await page.getByTestId("outline-row").first().getByLabel("标题 Title").fill("标签页 A 的标题");
  await page.getByRole("button", { name: "保存修改 Save" }).click();
  await expect(page.getByRole("button", { name: "已保存 Saved" })).toBeVisible();
  await other.getByTestId("outline-row").first().getByLabel("标题 Title").fill("标签页 B 的标题");
  await other.getByRole("button", { name: "保存修改 Save" }).click();
  await expect(other.getByTestId("outline-error")).toContainText("另一个标签页");
  await shot(other, "09-outline-conflict");
  await other.getByTestId("outline-reload").click();
  await expect(other.getByTestId("outline-draft-recovery")).toBeVisible();
  await expect(other.getByTestId("outline-row").first().getByLabel("标题 Title")).toHaveValue("标签页 A 的标题");
  await other.getByTestId("outline-restore-draft").click();
  await expect(other.getByTestId("outline-row").first().getByLabel("标题 Title")).toHaveValue("标签页 B 的标题");
  await other.getByRole("button", { name: "保存修改 Save" }).click();
  await expect(other.getByRole("button", { name: "已保存 Saved" })).toBeVisible();
  await other.getByTestId("outline-row").first().getByLabel("标题 Title").fill("标签页 B 尚未保存的标题");

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
  await expect(other.getByTestId("outline-row").first().getByLabel("标题 Title")).toHaveValue("标签页 B 尚未保存的标题");

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
  await expect(page.getByTestId("outline-row").first().getByLabel("标题 Title")).toHaveValue("标签页 B 的标题");
});

test("formulas drawn as outlines: the chapters step shows the gap, and pasting closes it", async ({ page }) => {
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

test("外部解析服务 on (stubbed MinerU): unread formulas are re-read; after a reload the teacher picks the file again", async ({ page }) => {
  await setExternal(page, "off");
  const later = await kinematicsCopy("Kinematics reloaded");
  await page.goto("/");
  await page.getByTestId("new-lesson").click();
  await page.getByTestId("pdf-input").setInputFiles(later);
  await page.waitForURL(/\/new\/[^/]+$/);
  const laterId = page.url().split("/").pop()!;
  await expect(page.getByTestId("external-off")).toBeVisible();

  await page.goto("/admin");
  await page.getByTestId("admin-tab-parsing").click();
  await expect(page.getByTestId("parsing-state")).toHaveText(/已关闭/);
  // On (the default): the stubbed online API needs nothing, so it sends.
  await page.getByTestId("external-enabled").check();
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

test("看图模型 fallback (local mock provider): with the external parser off, unread pages are read from their images; the teacher can still correct them", async ({ page }) => {
  const READ = "## 3.1 Equations of motion\n\n$$v = u + at$$\n\n$$s = ut + \\frac{1}{2}at^2$$\n\nA car starts at $2\\ \\mathrm{m/s}$ and reaches $20\\ \\mathrm{m/s}$.";
  const provider = await mockVisionProvider("```markdown\n" + READ + "\n```");
  try {
    await setExternal(page, "off");
    await page.goto("/admin");
    await page.getByRole("button", { name: "AI 模型 Models" }).click();
    const card = page.getByTestId("vision-provider-card");
    await card.getByTestId("vision-provider-kind").selectOption("custom");
    await card.getByLabel("名称 Name").fill("Local vision mock");
    await card.getByTestId("vision-provider-model").fill("mock-vl");
    await card.getByTestId("vision-provider-base-url").fill(provider.baseUrl);
    await card.getByTestId("vision-provider-key").fill("sk-local-mock-key");
    await card.getByTestId("vision-provider-save").click();
    await expect(card.getByTestId("vision-provider-row")).toContainText("mock-vl");

    // A model not known to be free counts as paid: unusable until paid parsing is allowed.
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
    await page.getByTestId("paid-enabled").check();
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
    await page.getByTestId("admin-tab-parsing").click();
    await expect(page.getByTestId("parsing-state")).toBeVisible();
    await page.getByTestId("paid-enabled").setChecked(false);
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

test("教材管理: rename, reuse without uploading again, archive/restore, delete only when no lesson uses it", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await page.goto("/new");
  await page.getByTestId("pdf-input").setInputFiles(await kinematicsCopy("Kinematics library"));
  await page.waitForURL(/\/new\/[^/]+$/);
  const docId = page.url().split("/").pop()!;

  await page.getByRole("link", { name: "教材 Textbooks" }).click();
  const row = page.locator(`[data-testid=library-row][data-id="${docId}"]`);
  await expect(row.getByTestId("library-title")).toHaveText("Kinematics library");
  await expect(row).toContainText("3 页");
  await expect(row.getByTestId("library-status")).toHaveText(/已读好|页还没读好/);
  await row.getByTestId("library-rename").click();
  await page.getByTestId("library-title-input").fill("运动学 第3章");
  await page.getByTestId("library-rename-save").click();
  await expect(row.getByTestId("library-title")).toHaveText("运动学 第3章");

  // A new lesson from the same book: picked from the list, nothing uploaded.
  await page.goto("/new");
  await expect(page.getByTestId("manage-textbooks")).toBeVisible();
  await page.getByRole("button", { name: /^📘 运动学 第3章/ }).click();
  await expect(page).toHaveURL(new RegExp(`/new/${docId}$`));
  await page.getByRole("treeitem").first().locator("input[type=checkbox]").check();
  await toSettings(page);
  await page.waitForURL(/\/lessons\/[^/]+\/settings$/);

  await page.goto("/textbooks");
  await expect(row.getByTestId("library-lessons")).toHaveText("1 节");
  await expect(row.getByTestId("library-purge")).toBeDisabled();
  await shot(page, "40-textbook-library");
  await row.getByTestId("library-archive").click();
  await expect(page.locator(".alert.success")).toContainText("已归档");
  await expect(row).toHaveCount(0);
  await page.getByTestId("show-archived").check();
  await expect(row).toContainText("已归档");
  await row.getByTestId("library-restore").click();
  await expect(row).not.toContainText("已归档");

  await row.getByTestId("library-open").click();
  await expect(page).toHaveURL(new RegExp(`/new/${docId}$`));
  await expect(page.getByRole("treeitem").first()).toBeVisible();

  await page.goto("/new");
  await page.getByTestId("pdf-input").setInputFiles(await kinematicsCopy("Kinematics unused"));
  await page.waitForURL(/\/new\/[^/]+$/);
  const unusedId = page.url().split("/").pop()!;
  await page.goto("/textbooks");
  const unused = page.locator(`[data-testid=library-row][data-id="${unusedId}"]`);
  await unused.getByTestId("library-purge").click();
  await expect(page.locator(".alert.success")).toContainText("已彻底删除");
  await expect(unused).toHaveCount(0);
  expect((await page.request.get(`/api/documents/${unusedId}`)).status()).toBe(404);
});
