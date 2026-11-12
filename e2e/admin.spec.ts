import { expect, test } from "./fixtures";
import { kinematicsCopy, setExternal, shot, shotOf } from "./helpers";
import { mockMessagesGateway, mockSelfhostMinerU, mockVisionProvider } from "./mocks";

test("后台概览: the overview tab comes first with counts and the setup status; other tabs only carry the demo-mode banner", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByTestId("admin-tab-overview")).toHaveClass(/active/);
  for (const id of ["users", "textbooks", "lessons", "parsed"]) await expect(page.getByTestId(`count-${id}`).locator(".stat-value")).toHaveText(/^\d+$/);
  expect(Number(await page.getByTestId("count-users").locator(".stat-value").innerText())).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("setup-status").getByTestId("setup-ai")).toContainText("演示模式");
  await shot(page, "39-admin-overview");
  await page.getByTestId("admin-tab-users").click();
  await expect(page.getByTestId("setup-status")).toHaveCount(0);
  await expect(page.getByTestId("critical-banner")).toContainText("演示模式");
  await page.getByTestId("admin-tab-parsing").click();
  await expect(page.getByTestId("setup-status")).toHaveCount(0);
  await page.getByTestId("critical-banner").getByRole("button", { name: "去填写" }).click();
  await expect(page.getByTestId("add-model-form")).toBeVisible();
  await expect(page.getByTestId("critical-banner")).toHaveCount(0);
});

test("看图模型 provider (local mock): with no text model, a vision provider with its own key reads pages; 测试连接 sends one tiny image", async ({ page }) => {
  const READ = "## 3.1 Equations of motion\n\n$$v = u + at$$\n\n$$s = ut + \\frac{1}{2}at^2$$";
  const provider = await mockVisionProvider(READ);
  try {
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
    await expect(card.getByTestId("vision-provider-key")).toHaveAttribute("autocomplete", "new-password");
    await card.getByTestId("vision-provider-key").fill("sk-vision-only-key");
    await card.getByTestId("vision-provider-save").click();
    await expect(card.getByTestId("vision-in-use")).toContainText("Local qwen mock / mock-qwen-vl · In use");
    await expect(card.getByTestId("vision-provider-row")).toContainText("sk-••••");
    await expect(page.locator("body")).not.toContainText("sk-vision-only-key");

    await card.getByTestId("vision-provider-test").click();
    await expect(page.locator(".alert.success")).toContainText("测试连接：Local qwen mock / mock-qwen-vl · 连接成功");
    expect(provider.asked).toHaveLength(1);
    expect(provider.asked[0]).toMatchObject({ model: "mock-qwen-vl", auth: "Bearer sk-vision-only-key" });
    expect(provider.asked[0]!.image).toMatch(/^data:image\/png;base64,/);
    await shot(page, "33-admin-vision-separate");
    // Outlines and slides still come from the built-in templates: no text model is configured.
    expect((await (await page.request.get("/api/auth/me")).json()).ai).toBe("stub");
    expect(JSON.stringify(await (await page.request.get("/api/admin/ai")).json())).not.toContain("sk-vision-only-key");

    await page.getByTestId("admin-tab-parsing").click();
    await expect(page.getByTestId("vision-panel")).toContainText("mock-qwen-vl");
    await page.getByTestId("paid-enabled").check();
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
    const paid = page.getByTestId("paid-enabled");
    if (await paid.isChecked()) {
      await paid.uncheck();
      await expect(paid).not.toBeChecked();
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

test("Messages 协议 (local mock gateway): protocol, max_tokens and a custom header are saved in 后台 and streamed on 测试连接", async ({ page }) => {
  const gateway = await mockMessagesGateway();
  try {
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
    await expect(form.getByLabel("API Key")).toHaveAttribute("autocomplete", "new-password");
    await form.getByLabel("API Key").fill("sk-gateway-key");
    await shot(page, "36-admin-messages-form");
    await form.getByRole("button", { name: /保存并启用/ }).click();
    const row = page.locator("tr:not([data-testid^=setup])", { hasText: "Gateway mock" });
    await expect(row.getByTestId("protocol-summary")).toContainText("Messages /v1/messages · max_tokens 31200 · 请求头 x-source:");
    await expect(row).not.toContainText("tensorhawk");

    await row.getByRole("button", { name: /测试连接/ }).click();
    await expect(page.locator(".alert.success")).toContainText(/Gateway mock \/ glm-5\.3-flash · 连接成功 · \d+ ms · 模型 glm-5\.3-flash 回复：“\{"ok":true\}”/);
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

    await row.getByTestId("advanced-toggle").click();
    await page.getByTestId("edit-headers").fill("x-source: wrong-source");
    await page.getByTestId("advanced-save").click();
    await expect(row.getByTestId("protocol-summary")).toContainText("x-source: wr••••");
    await row.getByRole("button", { name: /测试连接/ }).click();
    await expect(page.locator(".alert.error")).toContainText("Gateway mock / glm-5.3-flash · Key 不对或没有权限（HTTP 401）：请检查 API Key和自定义请求头。");
    await shot(page, "38-admin-test-auth-error");
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

test("MinerU 自部署 (local mock server): unconfigured until the URL is saved, then on by itself; the connection test and the pages use the key", async ({ page }) => {
  const KEY = "school-mineru-key";
  const school = await mockSelfhostMinerU(KEY);
  try {
    await setExternal(page, "auto");
    await page.getByTestId("mineru-mode-selfhost").check();
    await expect(page.getByTestId("parsing-state")).toHaveText(/未配置/);
    await expect(page.getByTestId("parsing-missing")).toContainText("自部署 MinerU 的地址");
    await expect(page.getByTestId("parsing-test")).toBeDisabled();
    await shot(page, "29-admin-selfhost-missing");
    await expect(page.getByTestId("setup-status")).toHaveCount(0);
    await page.getByTestId("admin-tab-overview").click();
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
    await expect(page.getByTestId("selfhost-key")).toHaveAttribute("autocomplete", "new-password");
    await page.getByTestId("selfhost-key").fill("not-the-key");
    await page.getByTestId("selfhost-save").click();
    await expect(page.getByTestId("parsing-state")).toHaveText(/已开启/);
    await expect(page.getByTestId("selfhost-url")).toHaveAttribute("placeholder", /^已保存：http:\/\/127\.…:\d+$/);
    await page.getByTestId("admin-tab-overview").click();
    await expect(setup.getByTestId("setup-external")).toHaveAttribute("data-ok", "true");
    await page.getByTestId("admin-tab-parsing").click();
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
    await page.getByTestId("external-enabled").uncheck();
    await expect(page.getByTestId("parsing-state")).toHaveText(/已关闭/);
    await school.close();
  }
});
