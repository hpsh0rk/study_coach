import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import type { Outline, SlideContent } from "@kj/schema";

const INITIAL = "Admin12345";
const CHANGED = "Teacher2026x";

async function ensureSignedIn(page: Page) {
  const me = await page.request.get("/api/auth/me");
  const meJson = me.ok() ? ((await me.json()) as { user: unknown | null }) : { user: null };
  if (!meJson.user) {
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
  } else {
    await page.goto("/");
  }
  await expect(page.getByTestId("new-lesson")).toBeVisible();
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

function docxPlainText(documentXml: string): string {
  return [...documentXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((m) =>
      m[1]!
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&"),
    )
    .join("");
}

test("companion handout export in GenerateStep downloads standalone A4 print HTML and editable OOXML .docx in both Student Blanked and Teacher Red-Bold Answer Key modes", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kj-handout-e2e-"));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", acceptDownloads: true });
  const page = await ctx.newPage();

  try {
    await ensureSignedIn(page);

    const csrf = { "x-kj-csrf": "1" };
    const reqJson = async <T>(url: string, data: unknown, method: "POST" | "PUT" | "PATCH" = "POST"): Promise<T> => {
      const res = await page.request.fetch(url, { method, data, headers: csrf });
      if (!res.ok()) throw new Error(`${method} ${url} failed (${res.status()}): ${await res.text()}`);
      return (await res.json()) as T;
    };

    const doc = await reqJson<{ id: string }>("/api/documents", {
      filename: "igcse-magnetism-ch16.pdf",
      title: "IGCSE Physics Ch16 Magnetism",
      sizeBytes: 8192,
      pageCount: 4,
      chapters: [{ id: "ch16", parentId: null, level: 1, ord: 0, title: "16 Magnetism", pageStart: 1, pageEnd: 4, words: 320 }],
    });
    await reqJson(`/api/documents/${doc.id}/pages`, {
      pages: [
        {
          no: 1,
          text: "Permanent magnets use steel, which is a hard magnetic material. Soft iron loses its magnetism quickly and is used for electromagnet cores.",
        },
        {
          no: 2,
          text: "Current I in a solenoid produces a uniform magnetic field B. Magnetic flux Phi = B x A. For B = 0.25 T and A = 0.08 m^2, Phi = 0.02 Wb.",
        },
        {
          no: 3,
          text: "Table 16.3: 20 turns attract 12 g, 40 turns attract 24 g, 60 turns attract 35 g.",
        },
        {
          no: 4,
          text: "Exam-style questions: State two ways to strengthen a solenoid magnetic field [2]. Reversing current swaps the poles [1].",
        },
      ],
    });

    const created = await reqJson<{ lesson: { id: string } }>("/api/lessons", {
      documentId: doc.id,
      chapterIds: ["ch16"],
      ranges: [{ start: 1, end: 4 }],
    });
    const lessonId = created.lesson.id;
    await reqJson(`/api/lessons/${lessonId}`, { title: "16.1 Magnetism & Electromagnets" }, "PATCH");

    const drafted = await reqJson<{ version: { id: string; rev: number } }>(`/api/lessons/${lessonId}/outline`, {});
    const versionId = drafted.version.id;

    const outline: Outline = {
      objectives: [
        "Compare **steel** and **soft iron** magnetic properties",
        "Calculate magnetic flux using $\\Phi = B A$",
      ],
      glossary: [
        { term: "solenoid", zh: "螺线管" },
        { term: "soft iron", zh: "软铁" },
      ],
      notCovered: [],
      slides: [
        { id: "sp1", pageType: "cover", layout: "title", visual: "none", minutes: 1, title: "Magnetism Overview", purpose: "Intro", keyPoints: [], sourcePages: [], loop: 0 },
        { id: "sp2", pageType: "concept", layout: "statement", visual: "table", minutes: 4, title: "Hard vs Soft Magnetic Materials", purpose: "Compare", keyPoints: ["Steel vs soft iron"], sourcePages: [1], loop: 1 },
        { id: "sp3", pageType: "data", layout: "chart", visual: "chart", minutes: 3, title: "Turns vs Mass Attracted", purpose: "Data trend", keyPoints: ["Turns data"], sourcePages: [3], loop: 1 },
        { id: "sp4", pageType: "worked", layout: "steps", visual: "formula", minutes: 4, title: "Worked Flux Example", purpose: "Model calculation", keyPoints: ["Phi = B A"], sourcePages: [2], loop: 2 },
        { id: "sp5", pageType: "faded", layout: "steps", visual: "formula", minutes: 4, title: "Faded Flux Practice", purpose: "Student calculation", keyPoints: ["Double area"], sourcePages: [2], loop: 2 },
        { id: "sp6", pageType: "check", layout: "quiz", visual: "none", minutes: 2, title: "Check Electromagnet Core", purpose: "Hinge question", keyPoints: ["Core material"], sourcePages: [1], loop: 1 },
        { id: "sp7", pageType: "practice", layout: "questions", visual: "none", minutes: 6, title: "Exam-Style Practice", purpose: "Past paper", keyPoints: ["Strengthen field"], sourcePages: [4], loop: 2 },
      ],
    };

    const saved = await reqJson<{ version: { rev: number } }>(`/api/lessons/${lessonId}/outline-versions/${versionId}`, { outline, rev: drafted.version.rev }, "PUT");
    await reqJson(`/api/lessons/${lessonId}/outline-versions/${versionId}/confirm`, { ackOverBudget: true, rev: saved.version.rev });

    const slideIds: Record<string, string> = {};
    for (const s of outline.slides) {
      const gen = await reqJson<{ slide: { id: string } }>(`/api/lessons/${lessonId}/outline-versions/${versionId}/slides/${s.id}/generate`, { regenerate: false });
      slideIds[s.id] = gen.slide.id;
    }

    const patches: [string, SlideContent, string][] = [
      [
        "sp2",
        {
          layout: "statement",
          title: "Hard vs Soft Magnetic Materials",
          bullets: [
            "Steel is a ==hard magnetic== material.",
            "Current $I$ magnetizes a solenoid core.",
          ],
          visual: {
            kind: "table",
            caption: "Table 16.1 Materials",
            columns: ["Material", "Use"],
            rows: [
              ["Steel", "==Bar magnet=="],
              ["Soft iron", "==Crane core=="],
            ],
          },
          terms: [{ term: "solenoid", zh: "螺线管" }],
        },
        "TEACHER-ONLY-NOTE: Demonstrate steel nail retaining paperclips.",
      ],
      [
        "sp3",
        {
          layout: "chart",
          title: "Turns vs Mass Attracted",
          chart: {
            kind: "chart",
            type: "bar",
            xLabel: "Turns N",
            yLabel: "Mass / g",
            categories: ["20", "40", "60"],
            series: [{ name: "Mass / g", data: [12, 24, 35] }],
          },
          takeaways: ["Forty turns attract ==24 g== mass."],
          source: "Table 16.3",
        },
        "Discuss magnetic saturation.",
      ],
      [
        "sp4",
        {
          layout: "steps",
          title: "Worked Flux Example",
          problem: "Calculate $\\Phi$ when $B = 0.25\\text{ T}$ and $A = 0.04\\text{ m}^2$.",
          steps: [
            { text: "Write $\\Phi = B A$", why: "Flux formula" },
            { text: "Result $\\Phi = 0.01\\text{ Wb}$", why: "SI unit" },
          ],
        },
        "Keep units clear.",
      ],
      [
        "sp5",
        {
          layout: "steps",
          title: "Faded Flux Practice",
          problem: "Calculate $\\Phi$ when $B = 0.25\\text{ T}$ and $A = 0.08\\text{ m}^2$.",
          steps: [
            { text: "Write $\\Phi = B A$", why: "Formula" },
            { text: "SECRET-FADED-ANS: $\\Phi = 0.02\\text{ Wb}$", why: "SECRET-WHY" },
          ],
          fadeFrom: 1,
        },
        "Check student units.",
      ],
      [
        "sp6",
        {
          layout: "quiz",
          question: "Which material makes the best electromagnet core? [1]",
          options: [
            { text: "Steel", misconception: "SECRET-MISCONCEPTION: Steel stays magnetized" },
            { text: "Soft iron", misconception: "" },
            { text: "Copper", misconception: "Copper is non-magnetic" },
          ],
          answer: 1,
          explain: "SECRET-QUIZ-EXPLAIN: Soft iron demagnetizes immediately when $I = 0$ A.",
          poll: true,
        },
        "Poll before revealing.",
      ],
      [
        "sp7",
        {
          layout: "questions",
          title: "Exam-Style Practice",
          items: [
            { q: "State two ways to strengthen a solenoid. [2]", a: "SECRET-EXAM-ANS: Increase $I$ and turns." },
            { q: "What happens when current reverses? [1]", a: "Magnetic poles swap." },
          ],
        },
        "1 mark per distinct factor.",
      ],
    ];

    for (const [specId, content, notes] of patches) {
      await reqJson(`/api/lessons/${lessonId}/slides/${slideIds[specId]}`, { content, notes }, "PATCH");
    }

    await page.goto(`/lessons/${lessonId}/slides`);
    await expect(page.getByTestId("gen-progress")).toContainText("已生成 7 / 7");

    // Open Export menu
    await page.locator("details.menu summary").click();
    await expect(page.getByTestId("handout-copy-toggle")).toBeVisible();
    await expect(page.getByTestId("handout-copy-student")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("export-handout-html")).toContainText("配套讲义 · 打印版 HTML/PDF");
    await expect(page.getByTestId("export-handout-docx")).toContainText("配套讲义 · Word (.docx)");

    // 1. Download Student HTML & Student DOCX
    const [stuHtmlDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-handout-html").click()]);
    expect(stuHtmlDl.suggestedFilename()).toContain("学生版");
    expect(stuHtmlDl.suggestedFilename()).toMatch(/\.html$/);
    const stuHtmlPath = path.join(tmpDir, "student-handout.html");
    await stuHtmlDl.saveAs(stuHtmlPath);

    const [stuDocxDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-handout-docx").click()]);
    expect(stuDocxDl.suggestedFilename()).toContain("学生版");
    expect(stuDocxDl.suggestedFilename()).toMatch(/\.docx$/);
    const stuDocxPath = path.join(tmpDir, "student-handout.docx");
    await stuDocxDl.saveAs(stuDocxPath);

    // 2. Switch toggle to Teacher Answer Key (`教师答案版`) and download Teacher HTML & Teacher DOCX
    await page.getByTestId("handout-copy-teacher").click();
    await expect(page.getByTestId("handout-copy-teacher")).toHaveAttribute("aria-pressed", "true");

    const [teaHtmlDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-handout-html").click()]);
    expect(teaHtmlDl.suggestedFilename()).toContain("教师答案版");
    const teaHtmlPath = path.join(tmpDir, "teacher-handout.html");
    await teaHtmlDl.saveAs(teaHtmlPath);

    const [teaDocxDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-handout-docx").click()]);
    expect(teaDocxDl.suggestedFilename()).toContain("教师答案版");
    const teaDocxPath = path.join(tmpDir, "teacher-handout.docx");
    await teaDocxDl.saveAs(teaDocxPath);

    // 3. Open Student & Teacher HTML in completely offline browser context and verify KaTeX, print button, blanks vs red-bold
    const offlineCtx = await browser.newContext({ offline: true, viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
    const extRequests: string[] = [];
    const pageErrors: string[] = [];
    offlineCtx.on("request", (r) => {
      if (!/^(file|data|about):/.test(r.url())) extRequests.push(r.url());
    });

    const stuPage = await offlineCtx.newPage();
    stuPage.on("pageerror", (e) => pageErrors.push(e.message));
    await stuPage.goto(`file://${stuHtmlPath}`);
    await expect(stuPage.locator(".ho-print-btn")).toContainText("打印 / 另存为 PDF · Print / Save PDF");
    await expect(stuPage.locator(".katex").first()).toBeVisible();
    const stuVisibleText = await stuPage.locator(".ho-sheet").innerText();
    expect(stuVisibleText).toContain("☐");
    expect(stuVisibleText).toContain("____________");
    expect(stuVisibleText).toContain("[1]");
    expect(stuVisibleText).toContain("[2]");
    expect(stuVisibleText).not.toContain("教师参考答案与讲评要点");
    for (const secret of ["hard magnetic", "TEACHER-ONLY-NOTE", "SECRET-FADED-ANS", "SECRET-MISCONCEPTION", "SECRET-QUIZ-EXPLAIN", "SECRET-EXAM-ANS"]) {
      expect(stuVisibleText).not.toContain(secret);
    }
    // Verify print button triggers window.print()
    await stuPage.evaluate(() => {
      (window as unknown as { __printed?: boolean }).__printed = false;
      window.print = () => {
        (window as unknown as { __printed?: boolean }).__printed = true;
      };
    });
    await stuPage.locator(".ho-print-btn").click();
    expect(await stuPage.evaluate(() => (window as unknown as { __printed?: boolean }).__printed)).toBe(true);

    const teaPage = await offlineCtx.newPage();
    teaPage.on("pageerror", (e) => pageErrors.push(e.message));
    await teaPage.goto(`file://${teaHtmlPath}`);
    await expect(teaPage.locator(".ho-em-red").first()).toBeVisible();
    const redColor = await teaPage.locator(".ho-em-red").first().evaluate((el) => getComputedStyle(el).color);
    expect(redColor).toBe("rgb(200, 30, 30)"); // #C81E1E
    const teaVisibleText = await teaPage.locator(".ho-sheet").innerText();
    expect(teaVisibleText).toContain("教师参考答案与讲评要点");
    for (const expected of ["hard magnetic", "TEACHER-ONLY-NOTE", "SECRET-FADED-ANS", "SECRET-MISCONCEPTION", "SECRET-QUIZ-EXPLAIN", "SECRET-EXAM-ANS"]) {
      expect(teaVisibleText).toContain(expected);
    }

    expect(extRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    await offlineCtx.close();

    // 4. Verify Student & Teacher .docx archives via unzip + DOM XML check in browser + content assertions
    const stuZip = unzipEntries(stuDocxPath);
    const teaZip = unzipEntries(teaDocxPath);
    for (const [label, zip] of [
      ["student", stuZip],
      ["teacher", teaZip],
    ] as const) {
      for (const entry of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml"]) {
        expect(zip.has(entry), `${label} .docx has ${entry}`).toBe(true);
        const xmlStr = zip.get(entry)!.toString("utf8");
        const parserError = await page.evaluate((xml) => {
          const parsed = new DOMParser().parseFromString(xml, "application/xml");
          return parsed.querySelector("parsererror")?.textContent ?? null;
        }, xmlStr);
        expect(parserError, `${label} ${entry} DOMParser XML error`).toBeNull();
      }
    }

    const stuDocXml = stuZip.get("word/document.xml")!.toString("utf8");
    const stuDocText = docxPlainText(stuDocXml);
    expect(stuDocXml).toContain('<w:pgSz w:w="11906" w:h="16838"');
    expect(stuDocText).toContain("____________");
    expect(stuDocText).toContain("Φ");
    expect(stuDocText).not.toContain("$");
    expect(stuDocText).not.toContain("==");
    expect(stuDocText).not.toContain("**");
    expect(stuDocText).not.toContain("教师参考答案与讲评要点");
    for (const secret of ["TEACHER-ONLY-NOTE", "SECRET-FADED-ANS", "SECRET-MISCONCEPTION", "SECRET-QUIZ-EXPLAIN", "SECRET-EXAM-ANS"]) {
      expect(stuDocText).not.toContain(secret);
    }

    const teaDocXml = teaZip.get("word/document.xml")!.toString("utf8");
    const teaDocText = docxPlainText(teaDocXml);
    expect(teaDocXml).toContain('<w:color w:val="C81E1E"/>');
    expect(teaDocXml).toContain('<w:br w:type="page"/>');
    expect(teaDocText).toContain("教师参考答案与讲评要点");
    expect(teaDocText).not.toContain("$");
    expect(teaDocText).not.toContain("==");
    expect(teaDocText).not.toContain("**");
    for (const expected of ["hard magnetic", "TEACHER-ONLY-NOTE", "SECRET-FADED-ANS", "SECRET-MISCONCEPTION", "SECRET-QUIZ-EXPLAIN", "SECRET-EXAM-ANS"]) {
      expect(teaDocText).toContain(expected);
    }
  } finally {
    await ctx.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
