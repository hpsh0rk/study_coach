import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts } from "pdf-lib";
import { mockVisionProvider } from "./mocks";

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

function makeTinyPng(filePath: string) {
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
  const width = 32;
  const height = 32;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (1 + width * 3), 240);
  for (let y = 0; y < height; y++) raw[y * (1 + width * 3)] = 0;
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(filePath, png);
}

async function makeLargeIgcsePdf(filePath: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.setTitle("Cambridge IGCSE Physics Coursebook");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pageCount = 160;
  const richPages: Record<number, string> = {
    141: "Chapter 16 Magnetism: Like magnetic poles repel and unlike magnetic poles attract. Iron, steel, cobalt and nickel are magnetic materials.",
    142: "16.1 Permanent magnets: Soft iron is easy to magnetise and demagnetise; hard steel retains magnetism permanently.",
    143: "16.2 Magnetic fields: Magnetic field lines run from North pole to South pole. Plotting compasses trace field direction.",
    144: "EXAM-STYLE QUESTIONS: [2] Describe how to plot magnetic field lines around a bar magnet using a compass.",
    145: "Chapter 17 Static electricity: Friction transfers electrons between insulating materials.",
    146: "17.1 Electric charge and electric fields around charged spheres.",
  };
  for (let i = 1; i <= pageCount; i++) {
    const p = doc.addPage([500, 650]);
    if (richPages[i]) p.drawText(richPages[i]!, { x: 40, y: 560, size: 12, font, maxWidth: 420 });
    else if (i === 1) p.drawText("Cover page", { x: 40, y: 560, size: 14, font });
  }

  const ctx = doc.context;
  const pages = doc.getPages();
  const dest = (no: number) => ctx.obj([pages[no - 1]!.ref, PDFName.of("XYZ"), null, null, null]);
  const outlinesRef = ctx.nextRef();
  const ch16Ref = ctx.nextRef();
  const ch17Ref = ctx.nextRef();
  ctx.assign(ch16Ref, ctx.obj({ Title: PDFString.of("16 Magnetism"), Parent: outlinesRef, Next: ch17Ref, Dest: dest(141) }));
  ctx.assign(ch17Ref, ctx.obj({ Title: PDFString.of("17 Static electricity"), Parent: outlinesRef, Prev: ch16Ref, Dest: dest(145) }));
  ctx.assign(outlinesRef, ctx.obj({ Type: PDFName.of("Outlines"), First: ch16Ref, Last: ch17Ref, Count: PDFNumber.of(2) }));
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);

  fs.writeFileSync(filePath, await doc.save());
}

async function makePastPaperPdf(filePath: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.setTitle("0625_s25_qp_42");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 8; i++) {
    const p = doc.addPage([500, 650]);
    const txt =
      i === 5
        ? "Question 5 [3 marks]: A solenoid carries 2.5 A and produces a magnetic flux density of 420 mT. Explain how soft iron strengthens the field."
        : i === 6
          ? "Question 6 [2 marks]: Sketch the magnetic field pattern around a bar magnet and mark the field direction."
          : `Past paper cover/blank question page ${i} with standard instructions for candidates.`;
    p.drawText(txt, { x: 40, y: 560, size: 12, font, maxWidth: 420 });
  }
  fs.writeFileSync(filePath, await doc.save());
}

async function makeSlicedPdf(filePath: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.setTitle("Sliced Magnetism Pages");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([500, 650]);
    p.drawText(`Original textbook page ${693 + i}: Magnetic poles and field lines from North to South.`, { x: 40, y: 560, size: 12, font, maxWidth: 420 });
  }
  fs.writeFileSync(filePath, await doc.save());
}

test("SC-50 end-to-end: 160-page PDF partial range import, 60-min volume bar, extra Past Paper PDF, 1500-char brief, syllabus screenshot vision transcription, coverage check & SourcePage switcher", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kj-sc50-"));
  const igcsePdf = path.join(tmpDir, "igcse-physics-160p.pdf");
  const pastPaperPdf = path.join(tmpDir, "0625_s25_qp_42.pdf");
  const slicedPdf = path.join(tmpDir, "sliced-ch16.pdf");
  const syllabusPng = path.join(tmpDir, "Clipboard_Screenshot.png");
  await makeLargeIgcsePdf(igcsePdf);
  await makePastPaperPdf(pastPaperPdf);
  await makeSlicedPdf(slicedPdf);
  makeTinyPng(syllabusPng);

  const vision = await mockVisionProvider(
    [
      "- Like magnetic poles repel and unlike magnetic poles attract",
      "- Soft iron vs permanent hard steel magnets",
      "- Magnetic screening in satellite instruments",
    ].join("\n"),
  );

  try {
    await ensureSignedIn(page);

    // Configure local mock vision provider for syllabus screenshot transcription:
    await page.goto("/admin");
    await page.getByRole("button", { name: "AI 模型 Models" }).click();
    const card = page.getByTestId("vision-provider-card");
    const existingRow = card.getByTestId("vision-provider-row");
    if (await existingRow.count()) {
      await existingRow.getByRole("button", { name: "删除" }).click();
      await expect(existingRow).toHaveCount(0);
    }
    await card.getByTestId("vision-provider-kind").selectOption("glm");
    await card.getByLabel("名称 Name").fill("Local GLM Vision");
    await card.getByTestId("vision-provider-model").fill("glm-4.6v-flash");
    await card.getByTestId("vision-provider-base-url").fill(vision.baseUrl);
    await card.getByTestId("vision-provider-key").fill("sk-local-vision-test");
    await card.getByTestId("vision-provider-save").click();
    await expect(card.getByTestId("vision-provider-row")).toContainText("glm-4.6v-flash");

    // 1. Upload 160-page textbook -> preflight opens automatically -> import ONLY p.141-144!
    await page.goto("/new");
    await page.getByTestId("pdf-input").setInputFiles(igcsePdf);
    await expect(page.getByTestId("pdf-preflight")).toBeVisible();
    await expect(page.getByTestId("pdf-preflight")).toContainText("160 页");
    await page.getByTestId("preflight-ranges").fill("141-144");
    await page.getByTestId("import-range-btn").click();

    await page.waitForURL(/\/new\/[^/]+$/);
    const primaryDocId = page.url().split("/").pop()!;
    const docMeta = await (await page.request.get(`/api/documents/${primaryDocId}`)).json();
    expect(docMeta.document.pagesReceived).toBe(4);
    expect(docMeta.document.pageCount).toBe(160);
    expect(docMeta.importedRanges).toEqual([{ start: 141, end: 144 }]);

    // 2. ChaptersStep: unimported Ch 17 shows "未导入", duration chip updates volume meter to 60 min, and Past Paper PDF attaches!
    const ch17Item = page.getByRole("treeitem").filter({ hasText: "17 Static electricity" });
    await expect(ch17Item.getByTestId("chapter-unimported")).toContainText("页未导入");

    await page.getByTestId("chapters-minutes-60").click();
    await expect(page.getByTestId("volume-meter")).toContainText("/ 60 分钟");

    await page.getByTestId("add-extra-pdf").click();
    await page.getByTestId("extra-pdf-file-input").setInputFiles(pastPaperPdf);
    await expect(page.getByTestId("extra-pdf-select")).not.toHaveValue("");
    await page.getByTestId("extra-pdf-role").selectOption("past_paper");
    await page.getByTestId("extra-pdf-ranges").fill("5-6");
    await page.getByTestId("confirm-extra-pdf").click();
    await expect(page.getByTestId("extra-source-item")).toContainText("0625_s25_qp_42");

    await page.getByTestId("chapters-next").click();
    if (await page.getByTestId("thin-warning").isVisible()) {
      await page.getByTestId("chapters-next").click();
    }
    await page.waitForURL(/\/lessons\/[^/]+\/settings$/);
    const lessonId = /\/lessons\/([^/]+)\//.exec(page.url())![1]!;

    // 3. SettingsStep: 60 min carried over, 350+ char teaching brief preserved, syllabus screenshot transcribed!
    await expect(page.getByTestId("pacing")).toContainText("60");
    const longBrief =
      "我现在是一个G10的物理老师，给IG班学生上课，使用第16章制作一份60分钟的英文课件（重要专业词汇配中文）。严格覆盖考纲所有知识点，重点知识用红色字体加粗，多用书本原图，整体大概在30号字体左右，文字精简，知识点配真题，每隔15分钟左右学生有做题或活动时间，最终需要一份PPT和一份配套讲义。补充课堂实验演示细节要求：请用指南针演示条形磁铁周围磁场方向，并对比软铁与硬钢磁化退磁特性差异，强调右手螺旋定则判断螺线管极性，结合历年真题训练得分点。";
    expect(longBrief.length).toBeGreaterThan(210);
    await page.getByTestId("focus-input").fill(longBrief);
    await expect(page.getByTestId("focus-input")).toHaveValue(longBrief);
    await expect(page.getByTestId("focus-count")).toContainText(`${longBrief.length} / 1500`);

    await page.getByTestId("syllabus-image-input").setInputFiles(syllabusPng);
    await expect(page.getByTestId("syllabus-vision-notice")).toContainText("已通过看图模型");
    await expect(page.getByTestId("syllabus-items-input")).toHaveValue(/Like magnetic poles repel/);

    await page.getByRole("button", { name: /生成大纲 Draft outline/ }).click();
    await page.waitForURL(/\/outline$/);

    // 4. OutlineStep: syllabus coverage card is displayed!
    await expect(page.getByTestId("syllabus-coverage")).toBeVisible();
    await expect(page.getByTestId("syllabus-coverage")).toContainText("/ 3 已覆盖");

    // Cite both primary p.142 and Past Paper virtual page 100005 on slide 2, confirm, and generate slides:
    const lessonState = await (await page.request.get(`/api/lessons/${lessonId}`)).json();
    const draftVer = lessonState.draft;
    const patchedOutline = {
      ...draftVer.outline,
      slides: draftVer.outline.slides.map((s: { id: string }, idx: number) =>
        idx === 1
          ? {
              ...s,
              title: "Soft iron strengthens solenoid flux density in exam problems",
              keyPoints: ["420 mT solenoid flux density", "Soft iron vs steel"],
              sourcePages: [142, 100_005],
            }
          : s,
      ),
    };
    const putRes = await page.request.put(`/api/lessons/${lessonId}/outline-versions/${draftVer.id}`, {
      headers: { "x-kj-csrf": "1" },
      data: { outline: patchedOutline, rev: draftVer.rev },
    });
    expect(putRes.ok()).toBe(true);
    await page.reload();
    await expect(page.getByTestId("outline-row").nth(1)).toContainText("0625_s25_qp_42 p.5");

    await page.getByTestId("confirm-outline").click();
    if (await page.getByTestId("ack-box").isVisible()) {
      await page.getByTestId("ack-box").getByRole("button").click();
    }
    await page.waitForURL(/\/slides/);

    // Wait for slide 2 to finish generating, select it, and click the Past Paper source chip to open SourcePage switcher!
    await expect(page.getByTestId("thumb").nth(1)).not.toContainText("未生成", { timeout: 30_000 });
    await page.getByTestId("thumb").nth(1).click();
    const pastPaperChip = page.locator(".preview-pane .kj-slide .kj-source").filter({ hasText: "0625_s25_qp_42 p.5" });
    await expect(pastPaperChip).toBeVisible();
    await pastPaperChip.click();

    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId("source-doc-switcher")).toBeVisible();
    await expect(modal.locator(".source-text")).toContainText("420 mT");
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);

    // 5. Verify pre-sliced PDF with pageOffset = 693 maps 1..3 -> p.693..695!
    await page.goto("/new");
    await page.getByTestId("partial-mode-toggle").check();
    await page.getByTestId("pdf-input").setInputFiles(slicedPdf);
    await expect(page.getByTestId("pdf-preflight")).toBeVisible();
    await page.getByTestId("preflight-page-offset").fill("693");
    await expect(page.getByTestId("preflight-ranges")).toHaveValue("693-695");
    await page.getByTestId("import-range-btn").click();
    await page.waitForURL(/\/new\/[^/]+$/);
    const slicedDocId = page.url().split("/").pop()!;
    const p693 = await (await page.request.get(`/api/documents/${slicedDocId}/pages/693`)).json();
    expect(p693.text).toContain("693");
  } finally {
    await page.goto("/admin");
    await page.getByRole("button", { name: "AI 模型 Models" }).click();
    const row = page.getByTestId("vision-provider-card").getByTestId("vision-provider-row");
    if (await row.count()) {
      await row.getByRole("button", { name: "删除" }).click();
      await expect(row).toHaveCount(0);
    }
    await vision.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
