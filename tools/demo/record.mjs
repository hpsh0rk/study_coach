#!/usr/bin/env node
// Records a paced demo of the whole teacher flow against a running stack with the stub AI:
//   E2E_PORT=8790 bash scripts/e2e-server.sh            (fresh D1, admin / Admin12345)
//   node tools/demo/record.mjs --pdf <textbook.pdf> --out media/full-flow.mp4 [--base http://127.0.0.1:8790]
// Playwright records each window separately; the presenter window is composited over the audience
// view with ffmpeg (audience shown picture-in-picture while the presenter drives).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values: args } = parseArgs({
  options: {
    pdf: { type: "string" },
    out: { type: "string", default: "full-flow.mp4" },
    base: { type: "string", default: "http://127.0.0.1:8790" },
    chapters: { type: "string", default: "^13\\.1 |^13\\.2 " },
  },
});
if (!args.pdf) throw new Error("--pdf is required");

const W = 1280;
const H = 720;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "kj-demo-"));
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: args.base, viewport: { width: W, height: H }, locale: "zh-CN", recordVideo: { dir: workDir, size: { width: W, height: H } }, acceptDownloads: true });

// Videos have no mouse pointer: draw one, and shrink it while the button is down.
await context.addInitScript(() => {
  const add = () => {
    if (document.getElementById("demo-cursor")) return;
    const c = document.createElement("div");
    c.id = "demo-cursor";
    Object.assign(c.style, { position: "fixed", left: "-40px", top: "-40px", width: "24px", height: "24px", borderRadius: "50%", background: "rgba(239,68,68,.3)", border: "3px solid rgba(220,38,38,.95)", zIndex: "2147483647", pointerEvents: "none", transform: "translate(-50%,-50%)", transition: "width .08s, height .08s" });
    document.documentElement.appendChild(c);
    addEventListener("mousemove", (e) => Object.assign(c.style, { left: `${e.clientX}px`, top: `${e.clientY}px` }), true);
    addEventListener("mousedown", () => Object.assign(c.style, { width: "14px", height: "14px" }), true);
    addEventListener("mouseup", () => Object.assign(c.style, { width: "24px", height: "24px" }), true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
  else add();
});

const t0 = Date.now();
const page = await context.newPage();
const pause = (ms) => page.waitForTimeout(ms);
process.on("uncaughtException", async (e) => {
  console.error(e);
  await page.screenshot({ path: path.join(workDir, "failed.png") }).catch(() => {});
  console.error(`screenshot: ${workDir}/failed.png`);
  process.exit(1);
});

async function caption(p, zh, en = "") {
  await p.evaluate(
    ([zh, en]) => {
      let el = document.getElementById("demo-cap");
      if (!el) {
        el = document.createElement("div");
        el.id = "demo-cap";
        Object.assign(el.style, { position: "fixed", left: "50%", bottom: "64px", transform: "translateX(-50%)", zIndex: "2147483646", background: "rgba(15,23,42,.9)", color: "#fff", font: '600 19px/1.4 system-ui, "Noto Sans SC", sans-serif', padding: "8px 20px", borderRadius: "10px", pointerEvents: "none", maxWidth: "86%", textAlign: "center", boxShadow: "0 6px 20px rgba(0,0,0,.3)" });
        document.documentElement.appendChild(el);
      }
      el.innerHTML = `${zh}${en ? `<br><span style="font-weight:400;font-size:15px;opacity:.85">${en}</span>` : ""}`;
    },
    [zh, en],
  );
}

async function pointAt(p, loc) {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  if (!b) throw new Error(`not visible: ${loc}`);
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await p.mouse.move(x, y, { steps: 20 });
  await p.waitForTimeout(300);
  return { x, y };
}

async function click(p, loc, after = 700) {
  const { x, y } = await pointAt(p, loc);
  await p.mouse.click(x, y);
  await p.waitForTimeout(after);
}

async function type(p, loc, text) {
  await click(p, loc, 200);
  await loc.fill("");
  await loc.pressSequentially(text, { delay: 55 });
}

async function key(p, k, times = 1, gap = 900) {
  for (let i = 0; i < times; i++) {
    await p.keyboard.press(k);
    await p.waitForTimeout(gap);
  }
}

async function scrollBy(p, dy, steps = 6) {
  for (let i = 0; i < steps; i++) {
    await p.mouse.wheel(0, dy / steps);
    await p.waitForTimeout(140);
  }
}

// ── 1. Login (first login forces a password change) ─────────────────────────────────────────────
await page.goto("/login");
await caption(page, "AI 课件工坊：从教材 PDF 到可上课的课件", "Textbook PDF → time-budgeted, editable, classroom-ready slides (stub AI)");
await pause(2500);
for (const password of ["Admin12345", "Teacher2026x"]) {
  await type(page, page.getByLabel("用户名 Username"), "admin");
  await type(page, page.getByLabel("密码 Password"), password);
  await click(page, page.getByRole("button", { name: "登录 Log in" }));
  const ok = await page.waitForURL(/\/(change-password)?$/, { timeout: 8_000 }).then(() => true, () => false);
  if (ok) break;
}
if (page.url().endsWith("/change-password")) {
  await caption(page, "首次登录先改初始密码", "Whitelisted accounts change their initial password first");
  await type(page, page.getByLabel("当前密码 Current password"), "Admin12345");
  await type(page, page.getByLabel("新密码 New password"), "Teacher2026x");
  await type(page, page.getByLabel("再输一次 Confirm"), "Teacher2026x");
  await click(page, page.getByRole("button", { name: "保存 Save" }));
}
await page.getByTestId("new-lesson").waitFor();
await caption(page, "我的课：新建一节课", "My lessons → New lesson");
await pause(1500);

// ── 2. Upload ───────────────────────────────────────────────────────────────────────────────────
await click(page, page.getByTestId("new-lesson"));
await caption(page, "第 1 步 · 上传教材 PDF（在浏览器里解析目录、每页文字和印刷页码）", "OpenStax College Physics, ch. 13 Waves — parsed in the browser with pdf.js");
await pause(1800);
await page.getByTestId("pdf-input").setInputFiles(args.pdf);
await page.waitForURL(/\/new\/[^/]+$/, { timeout: 120_000 });

// ── 3. Chapters + content meter ─────────────────────────────────────────────────────────────────
await caption(page, "第 2 步 · 选章节：内容量条按字数估算需要多少分钟", "Choose sections; the meter estimates minutes from the word count");
await page.getByRole("treeitem").first().waitFor();
await pause(1500);
const wanted = new RegExp(args.chapters);
const items = page.getByRole("treeitem");
const titles = await items.allInnerTexts();
console.log("chapters:", titles.map((t) => t.split("\n")[0]).join(" | "));
for (let i = 0; i < titles.length; i++) {
  if (wanted.test(titles[i].replace(/^\s*[▸▾›⌄▶▼]\s*/, "").trim())) {
    await click(page, items.nth(i).locator("input[type=checkbox]").first(), 900);
  }
}
await pointAt(page, page.getByTestId("scope-estimate"));
await pause(2500);
await click(page, page.getByRole("button", { name: /下一步：课时设置/ }));

// ── 4. Settings ─────────────────────────────────────────────────────────────────────────────────
await page.waitForURL(/\/settings$/);
await caption(page, "第 3 步 · 课堂设置：课时、学生水平、课型、英文授课 + 中文术语", "Lesson length, level, type, language, focus");
await pointAt(page, page.getByTestId("pacing"));
await pause(2500);
await click(page, page.getByRole("button", { name: /生成大纲 Draft outline/ }));

// ── 5. Outline (the one mandatory gate) ─────────────────────────────────────────────────────────
await page.waitForURL(/\/outline$/, { timeout: 60_000 });
const rows = page.getByTestId("outline-row");
await rows.first().waitFor();
await caption(page, "第 4 步 · 时间预算大纲：时间条、密度灯、未覆盖内容，老师确认后才生成", "The time-budgeted outline is the one gate: nothing is generated before the teacher confirms");
await pointAt(page, page.getByTestId("budget"));
await pause(2800);
await caption(page, "可以改页型、标题、要点、分钟：把一页改成“排序配对”", "Every row is editable — turn one page into an ordering activity");
const typeSelect = rows.nth(2).getByLabel("页面类型 Page type");
await pointAt(page, typeSelect);
await typeSelect.selectOption("sequence");
await pause(1500);
const types = await rows.getByLabel("页面类型 Page type").evaluateAll((ss) => ss.map((x) => x.value));
const concept = types.findIndex((t, i) => t === "concept" && i !== 2);
if (concept >= 0) {
  await caption(page, "给讲解页换一个图示：函数图像", "Pick a visual for a concept page — a function graph");
  const visual = rows.nth(concept).locator(".row-meta select");
  await pointAt(page, visual);
  await visual.selectOption("function");
  await pause(1500);
}
await scrollBy(page, 900, 10);
await pause(1200);
await scrollBy(page, -900, 6);
await caption(page, "确认大纲（唯一强制卡点）", "Confirm the outline — the only mandatory checkpoint");
await click(page, page.getByTestId("confirm-outline"), 300);
const gate = await Promise.race([
  page.waitForURL(/\/slides$/, { timeout: 20_000 }).then(() => "confirmed"),
  page.getByTestId("ack-box").waitFor({ timeout: 20_000 }).then(() => "ack"),
]).catch(async (e) => {
  await page.screenshot({ path: path.join(workDir, "confirm-failed.png") });
  throw new Error(`confirm did not go through (see ${workDir}/confirm-failed.png): ${e.message}`);
});
if (gate === "ack") {
  await caption(page, "超出课时 ±15% 时需要老师明确“仍然确认”", "Over the ±15% time budget: the server requires an explicit acknowledgement");
  await pause(1800);
  await click(page, page.getByTestId("ack-box").getByRole("button"));
}

// ── 6. Generate ─────────────────────────────────────────────────────────────────────────────────
await page.waitForURL(/\/slides$/);
const lessonId = /\/lessons\/([^/]+)\//.exec(page.url())[1];
await caption(page, "第 5 步 · 逐页生成：每页是固定版式 + 有字数预算的槽位，学生要读的字 ≥ 48px", "Each slide = fixed layout + budgeted slots; rendered and measured for overflow");
await click(page, page.getByTestId("generate-all"));
await page.getByTestId("generate-all").waitFor({ state: "detached", timeout: 120_000 });
await pause(1500);

async function showThumb(label, zh, en, hold = 2600) {
  const thumb = page.getByTestId("thumb").filter({ hasText: label }).first();
  if (!(await thumb.count())) return false;
  await caption(page, zh, en);
  await click(page, thumb, 400);
  await page.locator(".preview-pane").scrollIntoViewIfNeeded();
  await pause(hold);
  return true;
}
const thumbs = await page.getByTestId("thumb").allInnerTexts();
const dataThumbs = thumbs.filter((t) => t.includes("数据图表")).length;
await showThumb("数据图表", "数据页：图表或表格（数据来自教材，出处页可点开核对）", "Data page: chart or table, with clickable textbook page sources");
if (dataThumbs > 1) {
  const second = page.getByTestId("thumb").filter({ hasText: "数据图表" }).nth(1);
  await click(page, second, 400);
  await pause(2400);
}
await showThumb("检查理解", "检查理解：选择题，选项带常见误区；放映时下一步才揭示答案", "Hinge question with misconception-based options");
await showThumb("排序配对", "排序配对：卡片打乱，学生拖动或点两张交换，翻页器揭示正确顺序", "Ordering activity — shuffled cards, clicker reveals the order");
await showThumb("概念讲解", "讲解页：要点 + 函数图像（参数可调），要点逐条揭示", "Concept page with a live function graph");
await showThumb("实验", "实验（预测-观察-解释）：内置仿真实验，滑块可调", "Predict–observe–explain with a built-in simulation");

// ── 7. Edit one slot ────────────────────────────────────────────────────────────────────────────
await caption(page, "编辑：按槽位表单改，实时字数与中文报错", "Slot editor: one form per layout, live word counts");
await click(page, page.getByTestId("edit-slide"));
const explain = page.locator('[data-slot-path="explain"]');
if (await page.locator(".slot-issues").count()) {
  await caption(page, "超出预算的槽位用中文标出，改短之前不能保存", "Over-budget slots are flagged in Chinese and block saving until fixed");
  await pointAt(page, explain);
  await pause(2200);
  await type(page, explain, "Higher frequency gives a shorter wavelength");
  await pause(1200);
  const options = page.locator('[data-slot-path="predict.options"]');
  const lines = (await options.inputValue()).split("\n");
  if (lines.some((l) => l.trim().split(/\s+/).length > 3)) {
    await click(page, options, 300);
    await options.fill(lines.map((l) => (l.trim().split(/\s+/).length > 3 ? l.trim().split(/\s+/).slice(1).join(" ") : l)).join("\n"));
    await options.blur();
    await pause(1200);
  }
}
await caption(page, "再标出实验验证的是哪个预测（POE 结果）", "Mark which prediction the simulation confirms (POE outcome)");
const pick = page.getByTestId("pick-outcome");
await pointAt(page, pick);
const optionValues = await pick.locator("option").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
await pick.selectOption(optionValues[1] ?? optionValues[0]);
await pause(1800);
await click(page, page.getByTestId("save-slide"), 1500);
await pause(1200);

// ── 8. Present: keys, pen, presenter window ─────────────────────────────────────────────────────
await caption(page, "放映：投影窗口不显示讲稿和答案", "Present — the audience window never shows notes or answers");
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await pause(900);
await click(page, page.getByTestId("present"), 1200);
await page.waitForURL(/\/play\//);
await page.locator(".kj-player").waitFor();
await caption(page, "翻页器 / 键盘：PageDown 下一步（逐条揭示）", "Clicker keys: PageDown reveals step by step");
await pause(1500);
await key(page, "PageDown", 5, 1100);
await caption(page, "D 键打开画笔：在一体机上直接圈画（按页保存在内存里，不落库）", "D: pen layer for touch screens — draw, erase, clear; not saved");
await key(page, "d", 1, 600);
const ink = page.locator("canvas.kj-ink");
const box = await ink.boundingBox();
await page.mouse.move(box.x + box.width * 0.18, box.y + box.height * 0.62, { steps: 12 });
await page.mouse.down();
for (let i = 1; i <= 24; i++) await page.mouse.move(box.x + box.width * (0.18 + i * 0.022), box.y + box.height * (0.62 - Math.sin(i / 3.8) * 0.14), { steps: 2 });
await page.mouse.up();
await pause(1800);
await key(page, "Escape", 1, 600);
await key(page, "PageDown", 2, 1000);

await caption(page, "演讲者窗口：计时、下一页、讲稿、答案；两个窗口双向同步", "Presenter window (teacher's laptop): timer, next slide, notes, answer key — synced both ways");
await pause(1200);
const [presenter] = await Promise.all([context.waitForEvent("page"), click(page, page.getByTestId("open-presenter"), 0)]);
const tPresenter = Date.now();
await presenter.getByTestId("presenter").waitFor();
await caption(presenter, "演讲者窗口（右上角小图是投影画面）", "Presenter window — inset shows what the class sees");
await presenter.waitForTimeout(2500);
await key(presenter, "PageDown", 3, 1300);
const sim = presenter.locator(".kj-player .kj-slide.kj-layout-experiment");
for (let i = 0; i < 40 && !(await sim.isVisible()); i++) await presenter.keyboard.press("ArrowRight");
await presenter.waitForTimeout(800);
const votes = presenter.locator(".kj-tally-inputs input");
if (await votes.count()) {
  await caption(presenter, "实验页：先让学生预测，老师输入举手人数", "POE: type in the show of hands for each prediction");
  for (const [i, n] of [7, 15, 4].entries()) if (i < (await votes.count())) await type(presenter, votes.nth(i), String(n));
  await presenter.waitForTimeout(800);
}
await caption(presenter, "翻页揭示：观察 → 实际结果高亮 → 解释", "Reveal: observe → the confirmed prediction is highlighted → explain");
await key(presenter, "PageDown", 3, 1600);
await presenter.waitForTimeout(1200);
await caption(presenter, "B 键黑屏，让学生把注意力拉回老师", "B blanks the projector");
await key(presenter, "b", 1, 1500);
await key(presenter, "b", 1, 1000);
const tPresenterEnd = Date.now();
await presenter.close();
await pause(800);

// ── 9. Share link ───────────────────────────────────────────────────────────────────────────────
await page.goto(`/lessons/${lessonId}/slides`);
await caption(page, "分享给学生：一个链接，冻结当前版本，学生版没有讲稿和误区标签", "Student link: frozen version, no speaker notes, revocable");
await click(page, page.getByTestId("share"), 1200);
if (await page.getByTestId("share-review").isVisible()) {
  await pause(1500);
  await click(page, page.getByTestId("share-ack"), 1200);
}
const shareUrl = (await page.getByTestId("share-url").textContent()).trim();
await pointAt(page, page.getByTestId("share-url"));
await pause(1800);
await page.goto(shareUrl);
await page.locator(".kj-player").waitFor();
await caption(page, "学生打开链接：可以自己翻页复习", "What students see");
await pause(1500);
await key(page, "PageDown", 3, 1000);

// ── 10. Offline export ──────────────────────────────────────────────────────────────────────────
await page.goto(`/lessons/${lessonId}/slides`);
await caption(page, "离线导出：课件、放映器、实验和字体子集打进一个 HTML，断网也能上课", "Offline export: one self-contained HTML file — works without network");
await click(page, page.getByText("导出 Export"), 600);
const [download] = await Promise.all([page.waitForEvent("download"), click(page, page.getByTestId("export-offline"), 0)]);
const file = path.join(workDir, "offline.html");
await download.saveAs(file);
await pause(1200);
await page.goto(`file://${file}`);
await page.locator("body[data-ready='1']").waitFor({ timeout: 30_000 });
await caption(page, "双击打开离线文件：同样的放映器", "The offline file in the browser — same player");
await pause(1500);
const offSim = page.locator(".kj-sim iframe").first();
for (let i = 0; i < 60 && !(await offSim.isVisible()); i++) await page.keyboard.press("ArrowRight");
await pause(2500);
await caption(page, "完成：上传 → 选章节 → 设置 → 确认大纲 → 生成与编辑 → 放映 / 分享 / 离线", "Upload → chapters → settings → confirm outline → generate & edit → present / share / offline");
await pause(3500);

const mainVideo = page.video();
const presenterVideo = presenter.video();
await context.close();
await browser.close();
const mainPath = await mainVideo.path();
const presenterPath = await presenterVideo.path();

// Composite: during the presenter segment show the presenter window full frame, audience inset top-right.
const a = ((tPresenter - t0) / 1000).toFixed(2);
const b = ((tPresenterEnd - t0) / 1000).toFixed(2);
const out = path.resolve(args.out);
fs.mkdirSync(path.dirname(out), { recursive: true });
const filter = [
  `[1:v]setpts=PTS-STARTPTS+${a}/TB[p]`,
  `[0:v]split[m0][m1]`,
  `[m1]scale=400:-2,pad=iw+6:ih+6:3:3:color=white[mini]`,
  `[m0][p]overlay=0:0:eof_action=pass:enable='between(t,${a},${b})'[x]`,
  `[x][mini]overlay=W-w-14:50:enable='between(t,${a},${b})'[v]`,
].join(";");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mainPath, "-i", presenterPath, "-filter_complex", filter, "-map", "[v]", "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p", "-r", "25", "-movflags", "+faststart", out], { stdio: "inherit" });
console.log(JSON.stringify({ out, presenterSegment: [Number(a), Number(b)], raw: [mainPath, presenterPath] }));
