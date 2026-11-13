import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateSync, inflateRawSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

async function ensureSignedIn(page: Page) {
  const me = await page.request.get("/api/auth/me");
  const meJson = me.ok() ? ((await me.json()) as { user: unknown | null }) : { user: null };
  if (!meJson.user) {
    await page.goto("/login");
    for (const password of ["Teacher2026x", "Admin12345"]) {
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
      await page.getByLabel("当前密码 Current password").fill("Admin12345");
      await page.getByLabel("新密码 New password").fill("Teacher2026x");
      await page.getByLabel("再输一次 Confirm").fill("Teacher2026x");
      await page.getByRole("button", { name: "保存 Save" }).click();
    }
  } else {
    await page.goto("/");
  }
  await expect(page.getByTestId("new-lesson")).toBeVisible();
}

function makeSolidPng(width: number, height: number, rByte: number, gByte: number, bByte: number): Buffer {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const off = y * (1 + width * 3);
    raw[off] = 0;
    for (let x = 0; x < width; x++) {
      raw[off + 1 + x * 3] = rByte;
      raw[off + 1 + x * 3 + 1] = gByte;
      raw[off + 1 + x * 3 + 2] = bByte;
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function unzipEntries(zipPath: string): Map<string, Buffer> {
  const buf = fs.readFileSync(zipPath);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("missing ZIP EOCD");
  const total = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error("invalid central directory entry");
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    if (!name.endsWith("/")) out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function makeFigureTextbookPdf(filePath: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.setTitle("IGCSE Ch16 Solenoid Figures");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const tinyHeaderIcon = await doc.embedPng(makeSolidPng(16, 16, 40, 80, 180));
  const solenoidBase = await doc.embedPng(makeSolidPng(210, 100, 215, 232, 250));

  const p1 = doc.addPage([520, 700]);
  p1.drawImage(tinyHeaderIcon, { x: 40, y: 668, width: 16, height: 16 });
  p1.drawText("16.2 Magnetic field around a solenoid", { x: 64, y: 670, size: 12, font: bold });
  p1.drawText(
    "A current-carrying solenoid produces a uniform parallel magnetic field inside the coil and resembles a bar magnet outside.",
    { x: 42, y: 615, size: 11, font, maxWidth: 430 },
  );

  // Composite physics diagram: raster base + red vector arrow + "N" / "S" / "Force" text labels + Figure 16.8 caption
  p1.drawImage(solenoidBase, { x: 145, y: 360, width: 210, height: 100 });
  p1.drawLine({ start: { x: 100, y: 410 }, end: { x: 395, y: 410 }, thickness: 2.5, color: rgb(0.82, 0.1, 0.1) });
  p1.drawLine({ start: { x: 380, y: 418 }, end: { x: 395, y: 410 }, thickness: 2.5, color: rgb(0.82, 0.1, 0.1) });
  p1.drawLine({ start: { x: 380, y: 402 }, end: { x: 395, y: 410 }, thickness: 2.5, color: rgb(0.82, 0.1, 0.1) });
  p1.drawText("N", { x: 84, y: 405, size: 13, font: bold });
  p1.drawText("S", { x: 404, y: 405, size: 13, font: bold });
  p1.drawText("Force", { x: 230, y: 472, size: 11, font });
  p1.drawText("Figure 16.8: Magnetic field pattern around a solenoid", { x: 105, y: 315, size: 10, font });

  p1.drawText("Inserting a soft-iron core increases the magnetic field strength significantly.", { x: 42, y: 245, size: 11, font, maxWidth: 430 });

  const p2 = doc.addPage([520, 700]);
  p2.drawText("Exam-style question [2]: State two ways to increase the magnetic field strength of a solenoid.", {
    x: 42,
    y: 610,
    size: 11,
    font,
    maxWidth: 430,
  });

  fs.writeFileSync(filePath, await doc.save());
}

test("SC-53 end-to-end: 2x composite PDF figure extraction -> AI outline/slide figure selection -> SlotEditor manual upload & page crop -> Live Web, Share (?share=), Offline HTML (0 network), .pptx, and Companion Handout (.html & .docx)", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kj-sc53-"));
  const textbookPdf = path.join(tmpDir, "igcse-ch16-figures.pdf");
  const manualPng = path.join(tmpDir, "manual-compass.png");
  await makeFigureTextbookPdf(textbookPdf);
  fs.writeFileSync(manualPng, makeSolidPng(240, 150, 195, 240, 215));

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", acceptDownloads: true });
  const page = await ctx.newPage();

  try {
    await ensureSignedIn(page);

    // 1. Upload PDF with composite diagram -> verify 2x figure automatically extracted & tiny header icon ignored!
    await page.goto("/new");
    await page.getByTestId("pdf-input").setInputFiles(textbookPdf);
    await page.waitForURL(/\/new\/[^/]+$/);
    const docId = page.url().split("/").pop()!;

    const docMediaRes = await page.request.get(`/api/documents/${docId}`);
    expect(docMediaRes.ok()).toBe(true);
    const mediaList = await (await page.request.get(`/api/media?documentId=${docId}`)).json();
    expect(mediaList.assets).toHaveLength(1);
    const autoFig = mediaList.assets[0];
    expect(autoFig.pageNo).toBe(1);
    expect(autoFig.label).toBe("Figure 16.8");
    expect(autoFig.caption).toContain("Magnetic field pattern around a solenoid");
    expect(autoFig.width).toBeGreaterThan(300);
    expect(autoFig.width).toBeLessThanOrEqual(1200);

    // 2. Select pages 1-2 -> Settings with focus asking for textbook figures ("直接用书本上的图片") -> Draft & confirm outline -> Generate slides!
    await page.getByTestId("ranges").fill("1-2");
    await page.getByTestId("chapters-next").click();
    if (await page.getByTestId("thin-warning").isVisible()) {
      await page.getByTestId("chapters-next").click();
    }
    await page.waitForURL(/\/lessons\/[^/]+\/settings$/);
    const lessonId = /\/lessons\/([^/]+)\//.exec(page.url())![1]!;

    await page.getByTestId("focus-input").fill("重点知识用红色字体加粗，直接用书本上的图片，文字精简");
    await page.getByRole("button", { name: /生成大纲 Draft outline/ }).click();
    await page.waitForURL(/\/outline$/);

    // Stub planner automatically selected visual "figure" ("原书插图 Figure") on concept slide!
    await expect(page.locator("select").filter({ hasText: "原书插图 Figure" }).first()).toHaveValue("figure");

    await page.getByTestId("confirm-outline").click();
    if (await page.getByTestId("ack-box").isVisible()) {
      await page.getByTestId("ack-box").getByRole("button").click();
    }
    await page.waitForURL(/\/slides/);

    // Wait for all slides to finish generating
    await expect(page.getByTestId("present")).toBeVisible({ timeout: 45_000 });

    // Select the concept slide that has the extracted Figure 16.8
    const lessonData = await (await page.request.get(`/api/lessons/${lessonId}`)).json();
    const figSlideIdx = lessonData.slides.findIndex(
      (s: { content: { layout: string; visual?: { kind: string; assetId?: string } } }) =>
        s.content.layout === "statement" && s.content.visual?.kind === "figure" && s.content.visual.assetId === autoFig.id,
    );
    expect(figSlideIdx).toBeGreaterThanOrEqual(0);

    await page.getByTestId("thumb").nth(figSlideIdx).click();
    const previewImg = page.locator(".preview-pane .kj-figure-img");
    await expect(previewImg).toBeVisible();
    await expect(previewImg).toHaveAttribute("src", `/api/media/${autoFig.id}`);
    const naturalW = await previewImg.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0));
    expect(naturalW).toBeGreaterThan(0);

    // 3. Verify SlotEditor manual fallbacks: (a) drag-crop from rendered textbook page, (b) upload image, then pick Figure 16.8 back!
    await page.getByTestId("edit-slide").click();
    await expect(page.getByTestId("figure-slot-editor")).toBeVisible();
    await expect(page.getByTestId(`pick-figure-${autoFig.id}`)).toHaveAttribute("aria-pressed", "true");

    // (a) Drag-crop a region from page 1 in PageCropper:
    await page.getByTestId("figure-crop-toggle").click();
    await expect(page.getByTestId("page-cropper")).toBeVisible();
    const stage = page.getByTestId("cropper-stage");
    await expect(stage.locator("img")).toBeVisible();
    const box = await stage.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * 0.8, box!.y + box!.height * 0.65);
    await page.mouse.up();
    await page.getByTestId("cropper-label").fill("Fig 16.8 (manual crop)");
    await page.getByTestId("cropper-save").click();
    await expect(page.getByTestId("page-cropper")).toHaveCount(0);

    // (b) Direct image upload into visual slot:
    await page.getByTestId("figure-upload-input").setInputFiles(manualPng);
    await expect(page.getByTestId("figure-picker-grid").locator("button")).toHaveCount(3);

    // Pick original extracted Figure 16.8 and save slide:
    await page.getByTestId(`pick-figure-${autoFig.id}`).click();
    await page.getByTestId("save-slide").click();
    await expect(page.getByTestId("slot-editor")).toHaveCount(0);

    // 4a. Format 1 — Live Web Player (`/play/:id`) & Student Share (`/s/:token` with `?share=<token>`):
    await page.getByTestId("present").click();
    await page.waitForURL(`/play/${lessonId}`);
    await expect(page.getByTestId("player")).toBeVisible();
    for (let step = 0; step < 30; step++) {
      if (await page.locator(".kj-player .kj-figure-img").isVisible()) break;
      await page.keyboard.press("ArrowRight");
    }
    const livePlayerImg = page.locator(".kj-player .kj-figure-img");
    await expect(livePlayerImg).toBeVisible();
    await expect.poll(() => livePlayerImg.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 100)).toBe(true);
    await page.goBack();
    await page.waitForURL(/\/slides$/);

    // Share link in anonymous browser context:
    await page.getByTestId("share").click();
    if (await page.getByTestId("share-ack").isVisible()) {
      await page.getByTestId("share-ack").click();
    }
    const shareHref = await page.getByTestId("share-url").getAttribute("href");
    expect(shareHref).toBeTruthy();

    const anonCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "zh-CN" });
    const sharePage = await anonCtx.newPage();
    await sharePage.goto(shareHref!);
    await expect(sharePage.getByTestId("player")).toBeVisible();
    for (let step = 0; step < 30; step++) {
      if (await sharePage.locator(".kj-player .kj-figure-img").isVisible()) break;
      await sharePage.keyboard.press("ArrowRight");
    }
    const sharedImg = sharePage.locator(".kj-player .kj-figure-img");
    await expect(sharedImg).toBeVisible();
    await expect(sharedImg).toHaveAttribute("src", /\?share=/);
    await expect.poll(() => sharedImg.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 100)).toBe(true);
    await anonCtx.close();

    // 4b/c/d. Export Offline HTML, Editable .pptx, Companion Handout HTML, and Companion Handout .docx:
    await page.locator("details.menu summary").click();

    const [offlineDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-offline").click()]);
    const offlinePath = path.join(tmpDir, "offline-deck.html");
    await offlineDl.saveAs(offlinePath);

    const [pptxDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-pptx").click()]);
    const pptxPath = path.join(tmpDir, "lesson.pptx");
    await pptxDl.saveAs(pptxPath);

    const [handoutHtmlDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-handout-html").click()]);
    const handoutHtmlPath = path.join(tmpDir, "handout.html");
    await handoutHtmlDl.saveAs(handoutHtmlPath);

    const [handoutDocxDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-handout-docx").click()]);
    const handoutDocxPath = path.join(tmpDir, "handout.docx");
    await handoutDocxDl.saveAs(handoutDocxPath);

    // Format 2 — Offline Standalone HTML (`offline: true`, `file://`, 0 network requests):
    const offlineCtx = await browser.newContext({ offline: true, viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
    const netRequests: string[] = [];
    offlineCtx.on("request", (req) => {
      if (!/^(file|data|about):/.test(req.url())) netRequests.push(req.url());
    });
    const offPage = await offlineCtx.newPage();
    await offPage.goto(`file://${offlinePath}`);
    await offPage.waitForFunction(() => document.body.dataset.ready === "1");
    for (let step = 0; step < 30; step++) {
      if (await offPage.locator(".kj-figure-img").isVisible()) break;
      await offPage.keyboard.press("ArrowRight");
    }
    const offImg = offPage.locator(".kj-figure-img");
    await expect(offImg).toBeVisible();
    await expect(offImg).toHaveAttribute("src", /^data:image\//);
    expect(await offImg.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(100);

    // Format 4a — Offline Companion Handout HTML (`file://`, 0 network requests):
    const hoPage = await offlineCtx.newPage();
    await hoPage.goto(`file://${handoutHtmlPath}`);
    const hoImg = hoPage.locator(".ho-figure-img").first();
    await expect(hoImg).toBeVisible();
    await expect(hoImg).toHaveAttribute("src", /^data:image\//);
    expect(await hoImg.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(100);
    expect(netRequests).toEqual([]);
    await offlineCtx.close();

    // Format 3 — Editable .pptx contains embedded media image & slide relationship:
    const pptxZip = unzipEntries(pptxPath);
    const pptxMedia = [...pptxZip.keys()].filter((k) => k.startsWith("ppt/media/"));
    expect(pptxMedia.length).toBeGreaterThanOrEqual(1);
    const allSlideXml = [...pptxZip.entries()]
      .filter(([k]) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .map(([, v]) => v.toString("utf8"))
      .join("\n");
    expect(allSlideXml).toContain("<p:pic>");
    expect(allSlideXml).toContain("Figure 16.8");

    // Format 4b — Editable Companion Handout .docx contains `word/media/image1.png`, rels, and `<w:drawing><wp:inline>` with EMU extent:
    const docxZip = unzipEntries(handoutDocxPath);
    expect(docxZip.has("word/media/image1.png")).toBe(true);
    const docxRels = docxZip.get("word/_rels/document.xml.rels")!.toString("utf8");
    const docxXml = docxZip.get("word/document.xml")!.toString("utf8");
    expect(docxRels).toContain('Target="media/image1.png"');
    expect(docxXml).toContain("<w:drawing>");
    expect(docxXml).toContain("<wp:inline");
  } finally {
    await ctx.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
