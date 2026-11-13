import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { Outline, SlideContent } from "@kj/schema";

const INITIAL = "Admin12345";
const CHANGED = "Teacher2026x";

async function ensureLoggedIn(page: Page) {
  await page.goto("/login");
  for (const password of [CHANGED, INITIAL]) {
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
    await page.getByLabel("当前密码 Current password").fill(INITIAL);
    await page.getByLabel("新密码 New password").fill(CHANGED);
    await page.getByLabel("再输一次 Confirm").fill(CHANGED);
    await page.getByRole("button", { name: "保存 Save" }).click();
  }
  await expect(page.getByTestId("new-lesson")).toBeVisible();
}

test("route lazy-loading keeps /login free of echarts, pdfjs and katex JS while lazy routes load cleanly", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  const assets: { url: string; type: string; bytes: number }[] = [];

  page.on("response", async (res) => {
    const type = res.request().resourceType();
    if (type === "script" || type === "stylesheet") {
      const body = await res.body().catch(() => Buffer.alloc(0));
      assets.push({ url: new URL(res.url()).pathname, type, bytes: body.byteLength });
    }
  });

  await page.goto("/login", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "登录 Log in" })).toBeVisible();

  const scriptPaths = assets.filter((a) => a.type === "script").map((a) => a.url);
  const preloadHrefs = await page.locator('link[rel="modulepreload"]').evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
  const totalScriptBytes = assets.filter((a) => a.type === "script").reduce((sum, a) => sum + a.bytes, 0);

  for (const heavy of ["echarts", "pdfjs", "katex"]) {
    expect(scriptPaths.some((p) => p.includes(heavy)), `unexpected ${heavy} script on /login: ${scriptPaths.join(", ")}`).toBe(false);
    expect(preloadHrefs.some((h) => h.includes(heavy)), `unexpected ${heavy} modulepreload on /login: ${preloadHrefs.join(", ")}`).toBe(false);
  }
  // Was ~1,756 KB of uncompressed JS on /login before route lazy-loading; now < 350 KB.
  expect(totalScriptBytes).toBeLessThan(350_000);

  // Production build check: zero /dev measurement symbols (`kjMeasure` / `measureReady`) in built assets,
  // and zero heavy modulepreload links in dist/index.html.
  const tmpProd = fs.mkdtempSync(path.join(os.tmpdir(), "kj-prod-bundle-"));
  try {
    const env = { ...process.env };
    delete env.KJ_DEV_PAGES;
    execFileSync("pnpm", ["--filter", "@kj/web", "exec", "vite", "build", "--outDir", tmpProd], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env,
      stdio: "pipe",
    });
    const indexHtml = fs.readFileSync(path.join(tmpProd, "index.html"), "utf8");
    for (const heavy of ["echarts", "pdfjs", "katex"]) {
      expect(indexHtml.includes(heavy)).toBe(false);
    }
    const assetDir = path.join(tmpProd, "assets");
    for (const file of fs.readdirSync(assetDir)) {
      if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
      const src = fs.readFileSync(path.join(assetDir, file), "utf8");
      expect(/kjMeasure|measureReady/.test(src), `unexpected /dev symbol in ${file}`).toBe(false);
    }
  } finally {
    fs.rmSync(tmpProd, { recursive: true, force: true });
  }

  // Verify lazy routes load smoothly after authentication
  await ensureLoggedIn(page);
  await page.goto("/textbooks");
  await expect(page.getByRole("heading", { name: /教材管理/ })).toBeVisible();
  await page.goto("/admin");
  await expect(page.getByTestId("admin-tab-parsing")).toBeVisible();
  await page.goto("/new");
  await expect(page.getByTestId("pdf-input")).toBeAttached();

  await ctx.close();
});

test("conditional offline ECharts bundle (~500 KB lighter without charts, full SVG offline with charts) & offline presenter KaTeX + keys", async ({
  browser,
}) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kj-bundle-offline-"));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", acceptDownloads: true });
  const page = await ctx.newPage();

  try {
    await ensureLoggedIn(page);

    const csrf = { "x-kj-csrf": "1" };
    const postJson = async <T>(url: string, data: unknown, method: "POST" | "PUT" | "PATCH" = "POST"): Promise<T> => {
      const res = await page.request.fetch(url, { method, data, headers: csrf });
      if (!res.ok()) throw new Error(`${method} ${url} failed (${res.status()}): ${await res.text()}`);
      return (await res.json()) as T;
    };

    const doc = await postJson<{ id: string }>("/api/documents", {
      filename: "offline-split-check.pdf",
      title: "Offline Runtime Split Check",
      sizeBytes: 4096,
      pageCount: 2,
      chapters: [{ id: "ch1", parentId: null, level: 1, ord: 0, title: "1 Wave Motion", pageStart: 1, pageEnd: 2, words: 120 }],
    });
    await postJson(`/api/documents/${doc.id}/pages`, {
      pages: [
        {
          no: 1,
          text: "Wave speed equals frequency times wavelength: v = f x lambda. For f = 50 Hz and lambda = 3 m, wave speed v = 150 m/s.",
        },
        {
          no: 2,
          text: "Sound travels at 340 m/s in air, 1480 m/s in water, and 5960 m/s in steel.",
        },
      ],
    });

    const createdLesson = await postJson<{ lesson: { id: string } }>("/api/lessons", {
      documentId: doc.id,
      chapterIds: ["ch1"],
      ranges: [{ start: 1, end: 2 }],
      title: "Offline Bundle Verification",
    });
    const lessonId = createdLesson.lesson.id;
    const drafted = await postJson<{ version: { id: string; rev: number } }>(`/api/lessons/${lessonId}/outline`, {});
    const versionId = drafted.version.id;

    // 3-slide outline: cover + concept (statement) + check (quiz)
    const baseOutline: Outline = {
      objectives: ["Use $v = f\\lambda$ to calculate wave speed"],
      glossary: [{ term: "wavelength", zh: "波长" }],
      notCovered: [],
      slides: [
        {
          id: "sp1",
          pageType: "cover",
          layout: "title",
          visual: "none",
          minutes: 2,
          title: "Wave Speed Overview",
          purpose: "Introduce objectives",
          keyPoints: ["Wave equation"],
          sourcePages: [],
          loop: 0,
        },
        {
          id: "sp2",
          pageType: "concept",
          layout: "statement",
          visual: "formula",
          minutes: 5,
          title: "Wave speed equals frequency times wavelength",
          purpose: "Connect speed, frequency, and wavelength",
          keyPoints: ["v = f lambda"],
          sourcePages: [1],
          loop: 1,
        },
        {
          id: "sp3",
          pageType: "check",
          layout: "quiz",
          visual: "none",
          minutes: 4,
          title: "Check wave speed calculation",
          purpose: "Verify calculation",
          keyPoints: ["Calculate v"],
          sourcePages: [1],
          loop: 1,
        },
      ],
    };

    const saved = await postJson<{ version: { rev: number } }>(`/api/lessons/${lessonId}/outline-versions/${versionId}`, { outline: baseOutline, rev: drafted.version.rev }, "PUT");
    await postJson(`/api/lessons/${lessonId}/outline-versions/${versionId}/confirm`, { ackOverBudget: true, rev: saved.version.rev });

    const generatedSlides: Record<string, string> = {};
    for (const s of baseOutline.slides) {
      const g = await postJson<{ slide: { id: string } }>(`/api/lessons/${lessonId}/outline-versions/${versionId}/slides/${s.id}/generate`, { regenerate: false });
      generatedSlides[s.id] = g.slide.id;
    }

    // Patch chart-free slides with inline math in BOTH notes and quiz answers/explanations
    const formulaSlideContent: SlideContent = {
      layout: "statement",
      title: "Wave speed equals frequency times wavelength",
      bullets: ["Frequency $f$ in Hz", "Wavelength $\\lambda$ in m"],
      visual: { kind: "formula", tex: "v = f\\lambda", caption: "Wave equation" },
      terms: [{ term: "wavelength", zh: "波长" }],
    };
    await postJson(
      `/api/lessons/${lessonId}/slides/${generatedSlides.sp2}`,
      {
        content: formulaSlideContent,
        notes: "Remind class that $v = f\\lambda$ gives $v = 150\\text{ m/s}$ when $f = 50\\text{ Hz}$.",
      },
      "PATCH",
    );

    const quizSlideContent: SlideContent = {
      layout: "quiz",
      question: "A wave has $f = 50\\text{ Hz}$ and $\\lambda = 3\\text{ m}$. What is $v$?",
      options: [
        { text: "$v = 150\\text{ m/s}$", misconception: "" },
        { text: "$v = 53\\text{ m/s}$", misconception: "Added $f + \\lambda$ instead of multiplying" },
        { text: "$v = 16.7\\text{ m/s}$", misconception: "Divided $f / \\lambda$" },
      ],
      answer: 0,
      explain: "Multiply $v = 50 \\times 3 = 150\\text{ m/s}$.",
    };
    await postJson(
      `/api/lessons/${lessonId}/slides/${generatedSlides.sp3}`,
      {
        content: quizSlideContent,
        notes: "Ask students to substitute into $v = f\\lambda$ before revealing $v = 150\\text{ m/s}$.",
      },
      "PATCH",
    );

    // 1) Export chart-free teacher offline HTML
    await page.goto(`/lessons/${lessonId}/slides`);
    await page.getByTestId("gen-progress").waitFor({ state: "visible" });
    await page.locator("details.menu summary").click();
    const [noChartDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-offline").click()]);
    const noChartPath = path.join(tmpDir, "deck-no-charts.html");
    await noChartDl.saveAs(noChartPath);
    const noChartBytes = fs.statSync(noChartPath).size;
    const noChartHtml = fs.readFileSync(noChartPath, "utf8");
    expect(noChartHtml.includes('registerPainter("svg"')).toBe(false);

    // 2) Switch sp2 visual to a function plot with slider (uses ECharts) and re-export offline HTML
    const functionSlideContent: SlideContent = {
      layout: "statement",
      title: "Wave profile varies sinusoidally with distance",
      bullets: ["Amplitude $A$ sets peak height", "Wavelength $L$ sets repeat distance"],
      visual: {
        kind: "function",
        expr: "A*sin(pi*x)",
        x: [0, 4],
        y: [-3, 3],
        xLabel: "distance x / m",
        yLabel: "displacement y / cm",
        params: [{ name: "A", label: "Amplitude $A$", min: 1, max: 3, step: 0.5, value: 2 }],
      },
      terms: [{ term: "wavelength", zh: "波长" }],
    };
    await postJson(
      `/api/lessons/${lessonId}/slides/${generatedSlides.sp2}`,
      {
        content: functionSlideContent,
        notes: "Drag slider $A$ to show amplitude changing without changing wavelength.",
      },
      "PATCH",
    );

    await page.reload({ waitUntil: "networkidle" });
    await page.locator("details.menu summary").click();
    const [withChartDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-offline").click()]);
    const withChartPath = path.join(tmpDir, "deck-with-charts.html");
    await withChartDl.saveAs(withChartPath);
    const withChartBytes = fs.statSync(withChartPath).size;
    const withChartHtml = fs.readFileSync(withChartPath, "utf8");
    expect(withChartHtml.includes('registerPainter("svg"')).toBe(true);

    // Chart-free offline HTML should drop by ~450-550 KB compared to chart-enabled offline HTML!
    expect(withChartBytes - noChartBytes).toBeGreaterThan(450_000);

    // 3) Open chart-free offline HTML with `offline: true` (0 network requests) + test presenter popup KaTeX & keys
    const offlineNoChartCtx = await browser.newContext({ offline: true, viewport: { width: 1280, height: 720 }, locale: "zh-CN" });
    const offlineNoChartPage = await offlineNoChartCtx.newPage();
    const noChartRequests: string[] = [];
    const noChartErrors: string[] = [];
    offlineNoChartPage.on("request", (req) => {
      if (!req.url().startsWith("file:") && !req.url().startsWith("data:") && !req.url().startsWith("about:")) {
        noChartRequests.push(req.url());
      }
    });
    offlineNoChartPage.on("pageerror", (err) => noChartErrors.push(err.message));

    await offlineNoChartPage.goto(`file://${noChartPath}`);
    await offlineNoChartPage.waitForSelector('body[data-ready="1"]');

    // Open offline presenter popup window
    const [popup] = await Promise.all([
      offlineNoChartCtx.waitForEvent("page"),
      offlineNoChartPage.locator('[data-testid="offline-presenter"]').click({ force: true }),
    ]);

    // Jump to last slide (sp3 quiz) from presenter popup using `End` key!
    await popup.keyboard.press("End");
    await expect(offlineNoChartPage.locator(".kj-player")).toHaveAttribute("data-index", "2");
    await expect(offlineNoChartPage.locator(".kj-player")).toHaveAttribute("data-step", "0");

    // Verify KaTeX rendered `$...$` in presenter `#kj-p-notes` and `#kj-p-answers` instead of raw `$v = 150$`
    await expect(popup.locator("#kj-p-notes .katex").first()).toBeVisible();
    await expect(popup.locator("#kj-p-answers .katex").first()).toBeVisible();
    const notesVisibleText = await popup.locator("#kj-p-notes").innerText();
    const answersVisibleText = await popup.locator("#kj-p-answers").innerText();
    expect(notesVisibleText).not.toContain("$v =");
    expect(answersVisibleText).not.toContain("$v =");

    // Verify `b` / `B` toggles blank screen on main player, and `Home` jumps back to slide 0!
    await popup.keyboard.press("b");
    await expect(offlineNoChartPage.locator(".kj-player")).toHaveAttribute("data-blank", "1");
    await popup.keyboard.press("B");
    await expect(offlineNoChartPage.locator(".kj-player")).toHaveAttribute("data-blank", "0");

    await popup.keyboard.press("Home");
    await expect(offlineNoChartPage.locator(".kj-player")).toHaveAttribute("data-index", "0");
    await expect(offlineNoChartPage.locator(".kj-player")).toHaveAttribute("data-step", "0");

    expect(noChartRequests).toEqual([]);
    expect(noChartErrors).toEqual([]);
    await offlineNoChartCtx.close();

    // 4) Open chart-enabled offline HTML with `offline: true` (0 network requests) and verify ECharts SVG + slider!
    const offlineChartCtx = await browser.newContext({ offline: true, viewport: { width: 1280, height: 720 }, locale: "zh-CN" });
    const offlineChartPage = await offlineChartCtx.newPage();
    const chartRequests: string[] = [];
    const chartErrors: string[] = [];
    offlineChartPage.on("request", (req) => {
      if (!req.url().startsWith("file:") && !req.url().startsWith("data:") && !req.url().startsWith("about:")) {
        chartRequests.push(req.url());
      }
    });
    offlineChartPage.on("pageerror", (err) => chartErrors.push(err.message));

    await offlineChartPage.goto(`file://${withChartPath}`);
    await offlineChartPage.waitForSelector('body[data-ready="1"]');
    // Advance from cover (index 0) to function plot slide (index 1)
    await offlineChartPage.keyboard.press("ArrowRight");
    await expect(offlineChartPage.locator(".kj-player")).toHaveAttribute("data-index", "1");
    const svg = offlineChartPage.locator(".kj-plot svg");
    await expect(svg).toBeVisible();
    const box = await svg.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(100);
    expect(box?.height ?? 0).toBeGreaterThan(100);

    // Move interactive slider offline and confirm value updates without errors
    const slider = offlineChartPage.locator('.kj-slider input[type="range"]');
    await slider.fill("3");
    await expect(offlineChartPage.locator(".kj-slider-value")).toHaveText("3.0");

    expect(chartRequests).toEqual([]);
    expect(chartErrors).toEqual([]);
    await offlineChartCtx.close();
  } finally {
    await ctx.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
