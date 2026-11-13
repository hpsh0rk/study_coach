import { texToText } from "@kj/pptx";
import type { HandoutDoc, HandoutRun, HandoutTable } from "./model.ts";
import { buildZip } from "./zip.ts";

/** A4 Portrait in twips (1 mm = 56.6929 twips): 210mm x 297mm = 11906 x 16838; 16mm margin = 907 twips. */
const A4_WIDTH_DXA = 11906;
const A4_HEIGHT_DXA = 16838;
const A4_MARGIN_DXA = 907;
const PRINTABLE_WIDTH_DXA = A4_WIDTH_DXA - A4_MARGIN_DXA * 2; // 10092

const RED_ACCENT_HEX = "C81E1E";

function cleanXmlChars(s: string): string {
  // Strip XML 1.0 illegal control chars and lone surrogates while keeping \t, \n, \r, BMP, and astral planes
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || cp >= 0x10000) {
      out += ch;
    }
  }
  return out;
}

function escapeXml(s: string): string {
  return cleanXmlChars(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wText(text: string): string {
  const safe = cleanXmlChars(text);
  const preserve = /^\s|\s$|\s{2,}/.test(safe) ? ' xml:space="preserve"' : "";
  return `<w:t${preserve}>${escapeXml(safe)}</w:t>`;
}

interface RunStyle {
  bold?: boolean;
  color?: string;
  sizeHalfPt?: number;
  italic?: boolean;
}

function wRun(text: string, style: RunStyle = {}): string {
  const lines = cleanXmlChars(text).split("\n");
  const rPrParts: string[] = [];
  if (style.bold) rPrParts.push("<w:b/><w:bCs/>");
  if (style.italic) rPrParts.push("<w:i/><w:iCs/>");
  if (style.color) rPrParts.push(`<w:color w:val="${style.color}"/>`);
  if (style.sizeHalfPt) rPrParts.push(`<w:sz w:val="${style.sizeHalfPt}"/><w:szCs w:val="${style.sizeHalfPt}"/>`);
  const rPr = rPrParts.length ? `<w:rPr>${rPrParts.join("")}</w:rPr>` : "";
  const body = lines.map((line, idx) => (idx === 0 ? wText(line) : `<w:br/>${wText(line)}`)).join("");
  return `<w:r>${rPr}${body}</w:r>`;
}

function runsToXml(runs: HandoutRun[], base: RunStyle = {}): string {
  if (runs.length === 0) return wRun("", base);
  return runs
    .map((run) => {
      if (run.kind === "blank") {
        return wRun("____________", { ...base, bold: false });
      }
      const text = run.kind === "math" ? texToText(run.tex).text.replace(/\$/g, "") : run.text.replace(/\$/g, "");
      const highlight = !!run.highlight;
      const bold = highlight || !!run.bold || !!base.bold;
      const color = highlight ? RED_ACCENT_HEX : base.color;
      return wRun(text, { ...base, bold, ...(color ? { color } : {}) });
    })
    .join("");
}

interface ParaOpts {
  pStyle?: string;
  spaceBefore?: number;
  spaceAfter?: number;
  indentLeft?: number;
  shadingFill?: string;
  borderLeftColor?: string;
  borderBottomColor?: string;
  keepNext?: boolean;
}

function wPara(innerRunsXml: string, opts: ParaOpts = {}): string {
  const pPr: string[] = [];
  if (opts.pStyle) pPr.push(`<w:pStyle w:val="${opts.pStyle}"/>`);
  if (opts.keepNext) pPr.push("<w:keepNext/>");
  if (opts.borderLeftColor || opts.borderBottomColor) {
    const borders: string[] = [];
    if (opts.borderLeftColor) borders.push(`<w:left w:val="single" w:sz="18" w:space="8" w:color="${opts.borderLeftColor}"/>`);
    if (opts.borderBottomColor) borders.push(`<w:bottom w:val="single" w:sz="6" w:space="4" w:color="${opts.borderBottomColor}"/>`);
    pPr.push(`<w:pBdr>${borders.join("")}</w:pBdr>`);
  }
  if (opts.shadingFill) pPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${opts.shadingFill}"/>`);
  if (opts.spaceBefore !== undefined || opts.spaceAfter !== undefined) {
    pPr.push(`<w:spacing w:before="${opts.spaceBefore ?? 0}" w:after="${opts.spaceAfter ?? 80}"/>`);
  }
  if (opts.indentLeft) pPr.push(`<w:ind w:left="${opts.indentLeft}"/>`);
  return `<w:p>${pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : ""}${innerRunsXml}</w:p>`;
}

function wPageBreak(): string {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function wBorderedTable(headers: string[], rows: string[][], colWidths?: number[]): string {
  const colCount = Math.max(1, headers.length);
  const widths = colWidths ?? Array.from({ length: colCount }, () => Math.floor(PRINTABLE_WIDTH_DXA / colCount));
  const gridCols = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("");

  const headerCells = headers
    .map(
      (cellXml, idx) =>
        `<w:tc><w:tcPr><w:tcW w:w="${widths[idx] ?? widths[0]!}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/></w:tcPr>${wPara(cellXml, { spaceBefore: 40, spaceAfter: 40 })}</w:tc>`,
    )
    .join("");
  const headerRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headerCells}</w:tr>`;

  const bodyRows = rows
    .map((row) => {
      const cells = Array.from({ length: colCount }, (_, idx) => {
        const cellXml = row[idx] ?? wRun("");
        return `<w:tc><w:tcPr><w:tcW w:w="${widths[idx] ?? widths[0]!}" w:type="dxa"/></w:tcPr>${wPara(cellXml, { spaceBefore: 40, spaceAfter: 40 })}</w:tc>`;
      }).join("");
      return `<w:tr>${cells}</w:tr>`;
    })
    .join("");

  return [
    "<w:tbl>",
    "<w:tblPr>",
    '<w:tblStyle w:val="TableGrid"/>',
    `<w:tblW w:w="${PRINTABLE_WIDTH_DXA}" w:type="dxa"/>`,
    "<w:tblBorders>",
    '<w:top w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>',
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>',
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>',
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>',
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>',
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>',
    "</w:tblBorders>",
    '<w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar>',
    "</w:tblPr>",
    `<w:tblGrid>${gridCols}</w:tblGrid>`,
    headerRow,
    bodyRows,
    "</w:tbl>",
  ].join("");
}

function wWorkspaceBox(lines: number): string {
  const innerParas = [
    wPara(wRun("演算与作答区 Workspace (show formula, substitution & SI units):", { sizeHalfPt: 18, color: "64748B", italic: true }), {
      spaceBefore: 20,
      spaceAfter: 40,
    }),
    ...Array.from({ length: lines }, () =>
      wPara(wRun(""), { borderBottomColor: "CBD5E1", spaceBefore: 120, spaceAfter: 80 }),
    ),
  ].join("");

  return [
    "<w:tbl>",
    "<w:tblPr>",
    `<w:tblW w:w="${PRINTABLE_WIDTH_DXA}" w:type="dxa"/>`,
    "<w:tblBorders>",
    '<w:top w:val="dashed" w:sz="6" w:space="0" w:color="94A3B8"/>',
    '<w:left w:val="dashed" w:sz="6" w:space="0" w:color="94A3B8"/>',
    '<w:bottom w:val="dashed" w:sz="6" w:space="0" w:color="94A3B8"/>',
    '<w:right w:val="dashed" w:sz="6" w:space="0" w:color="94A3B8"/>',
    "</w:tblBorders>",
    '<w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="140" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="140" w:type="dxa"/></w:tblCellMar>',
    "</w:tblPr>",
    `<w:tblGrid><w:gridCol w:w="${PRINTABLE_WIDTH_DXA}"/></w:tblGrid>`,
    `<w:tr><w:tc><w:tcPr><w:tcW w:w="${PRINTABLE_WIDTH_DXA}" w:type="dxa"/></w:tcPr>${innerParas}</w:tc></w:tr>`,
    "</w:tbl>",
  ].join("");
}

function renderHandoutTableXml(tbl: HandoutTable): string {
  const out: string[] = [];
  if (tbl.caption) {
    out.push(wPara(runsToXml(tbl.caption, { bold: true, sizeHalfPt: 19, color: "475569" }), { spaceBefore: 80, spaceAfter: 40, keepNext: true }));
  }
  const headers = tbl.headers.map((h) => runsToXml(h, { bold: true, sizeHalfPt: 20 }));
  const rows = tbl.rows.map((r) => r.map((c) => runsToXml(c, { sizeHalfPt: 20 })));
  out.push(wBorderedTable(headers, rows));
  return out.join("");
}

function sectionHeadingXml(title: string, isTeacherKey = false): string {
  return wPara(wRun(title, { bold: true, sizeHalfPt: 26, color: isTeacherKey ? RED_ACCENT_HEX : "0F172A" }), {
    pStyle: "Heading1",
    borderLeftColor: isTeacherKey ? RED_ACCENT_HEX : "1D4ED8",
    shadingFill: isTeacherKey ? "FEF2F2" : "F1F5F9",
    spaceBefore: 220,
    spaceAfter: 120,
    keepNext: true,
  });
}

function buildStylesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    "<w:docDefaults>",
    "<w:rPrDefault><w:rPr>",
    '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="PingFang SC" w:cs="Arial"/>',
    '<w:sz w:val="21"/><w:szCs w:val="21"/>',
    '<w:color w:val="0F172A"/>',
    '<w:lang w:val="en-US" w:eastAsia="zh-CN"/>',
    "</w:rPr></w:rPrDefault>",
    '<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>',
    "</w:docDefaults>",
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>',
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:bCs/><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style>',
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/></w:tblBorders></w:tblPr></w:style>',
    "</w:styles>",
  ].join("");
}

function buildContentTypesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    "</Types>",
  ].join("");
}

function buildRootRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    "</Relationships>",
  ].join("");
}

function buildDocRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    "</Relationships>",
  ].join("");
}

function buildCorePropsXml(title: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `<dc:title>${escapeXml(title.replace(/\$/g, ""))}</dc:title>`,
    "<dc:creator>AI 课件工坊</dc:creator>",
    "</cp:coreProperties>",
  ].join("");
}

function buildAppPropsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">',
    "<Application>AI 课件工坊 Handout Compiler</Application>",
    "</Properties>",
  ].join("");
}

/**
 * Compiles `HandoutDoc` into a valid, zero-dependency editable OOXML `.docx` (`Uint8Array`).
 */
export function compileHandoutDocx(doc: HandoutDoc): Uint8Array {
  const isTeacher = doc.copy === "teacher";
  const body: string[] = [];

  // 1. Header & Syllabus / Learning Objectives Checklist
  body.push(
    wPara(
      runsToXml(doc.header.titleRuns, { bold: true, sizeHalfPt: 34 }) +
        wRun(`   [${doc.header.copyBadge}]`, { bold: true, sizeHalfPt: 20, color: isTeacher ? RED_ACCENT_HEX : "1E40AF" }),
      { pStyle: "Title", spaceBefore: 0, spaceAfter: 80 },
    ),
  );

  const metaParts = [
    `学段/难度 Grade: ${doc.header.grade}`,
    `课程类型 Subject: ${doc.header.subject}`,
    `建议时长 Duration: ${doc.header.duration}`,
    doc.header.sourcesLabel ? `教材页码 Pages: ${doc.header.sourcesLabel}` : "",
  ]
    .filter(Boolean)
    .join("   |   ");
  body.push(wPara(wRun(metaParts, { sizeHalfPt: 19, color: "475569" }), { borderBottomColor: "0F172A", spaceBefore: 0, spaceAfter: 120 }));

  if (!isTeacher) {
    body.push(
      wPara(
        wRun("姓名 Name：____________     班级 Class：__________     日期 Date：__________", { sizeHalfPt: 20 }),
        { spaceBefore: 40, spaceAfter: 140 },
      ),
    );
  }

  if (doc.header.objectives.length > 0 || doc.header.glossary.length > 0) {
    body.push(sectionHeadingXml("学习目标与核心词汇 · Learning Objectives & Glossary"));
    for (const obj of doc.header.objectives) {
      body.push(wPara(wRun("☐ ", { bold: true }) + runsToXml(obj), { indentLeft: 180, spaceBefore: 30, spaceAfter: 50 }));
    }
    if (doc.header.glossary.length > 0) {
      body.push(
        wBorderedTable(
          [wRun("核心术语 Term", { bold: true, sizeHalfPt: 20 }), wRun("中文释义 / 备注 Meaning", { bold: true, sizeHalfPt: 20 })],
          doc.header.glossary.map((g) => [
            wRun(g.term.replace(/\$/g, ""), { bold: true, sizeHalfPt: 20 }),
            wRun((g.zh || "—").replace(/\$/g, ""), { sizeHalfPt: 20 }),
          ]),
          [4200, PRINTABLE_WIDTH_DXA - 4200],
        ),
      );
    }
  }

  // 2. Guided Notes
  body.push(sectionHeadingXml("导学笔记 · Guided Notes"));
  if (doc.guidedNotes.length === 0) {
    body.push(wPara(wRun("（本节无概念讲授页 · No lecture concept slides in this deck）", { color: "64748B", italic: true })));
  }
  for (const group of doc.guidedNotes) {
    body.push(wPara(wRun(group.heading, { bold: true, sizeHalfPt: 23, color: "1E3A8A" }), { pStyle: "Heading2", spaceBefore: 160, spaceAfter: 60, keepNext: true }));
    for (const block of group.blocks) {
      const srcSuffix = block.sourcesLabel ? wRun(`  (${block.sourcesLabel})`, { sizeHalfPt: 18, color: "64748B" }) : "";
      body.push(wPara(runsToXml(block.title, { bold: true, sizeHalfPt: 21 }) + srcSuffix, { spaceBefore: 100, spaceAfter: 40, keepNext: true }));
      for (const bullet of block.bullets) {
        body.push(wPara(wRun("• ", { bold: true }) + runsToXml(bullet), { indentLeft: 240, spaceBefore: 20, spaceAfter: 50 }));
      }
      for (const f of block.formulas) {
        const mathText = texToText(f.tex).text.replace(/\$/g, "");
        const capXml = f.caption ? wRun("   — ", { color: "64748B" }) + runsToXml(f.caption, { sizeHalfPt: 19, color: "475569" }) : "";
        body.push(
          wPara(wRun(mathText, { bold: true, sizeHalfPt: 23 }) + capXml, {
            shadingFill: "F8FAFC",
            indentLeft: 240,
            spaceBefore: 60,
            spaceAfter: 60,
          }),
        );
      }
      for (const flow of block.flows) {
        const flowRuns = flow
          .map((step, idx) => (idx > 0 ? wRun(" → ", { bold: true, color: "475569" }) : "") + runsToXml(step))
          .join("");
        body.push(wPara(flowRuns, { indentLeft: 240, spaceBefore: 40, spaceAfter: 60 }));
      }
      for (const tbl of block.tables) {
        body.push(renderHandoutTableXml(tbl));
      }
    }
    if (isTeacher && group.misconceptions.length > 0) {
      for (const m of group.misconceptions) {
        body.push(
          wPara(wRun("• ", { bold: true, color: "B45309" }) + runsToXml(m, { sizeHalfPt: 20 }), {
            shadingFill: "FFFBEB",
            borderLeftColor: "D97706",
            indentLeft: 180,
            spaceBefore: 40,
            spaceAfter: 60,
          }),
        );
      }
    }
  }

  // 3. Worked & Faded Examples
  body.push(sectionHeadingXml("例题示范与演练 · Worked Examples"));
  if (doc.examples.length === 0) {
    body.push(wPara(wRun("（本节无独立分步例题 · See practice questions below）", { color: "64748B", italic: true })));
  }
  for (const ex of doc.examples) {
    const tag = ex.kind === "faded" ? "【半留白演练 Faded Practice】 " : "【例题示范 Worked Example】 ";
    const srcSuffix = ex.sourcesLabel ? wRun(`  (${ex.sourcesLabel})`, { sizeHalfPt: 18, color: "64748B" }) : "";
    body.push(wPara(wRun(tag, { bold: true, color: "1E3A8A" }) + runsToXml(ex.title, { bold: true }) + srcSuffix, { spaceBefore: 140, spaceAfter: 40, keepNext: true }));
    body.push(wPara(wRun("题目 Problem：", { bold: true }) + runsToXml(ex.problem), { shadingFill: "F8FAFC", spaceBefore: 40, spaceAfter: 60 }));

    for (const st of ex.steps) {
      if (st.hiddenInStudent && !isTeacher) {
        body.push(
          wPara(wRun(`步骤 ${st.index}（请独立推导作答）：____________`, { italic: true, color: "334155" }), {
            indentLeft: 240,
            spaceBefore: 30,
            spaceAfter: 50,
          }),
        );
      } else {
        const whyXml = st.why ? wRun("  （", { color: "64748B", sizeHalfPt: 19 }) + runsToXml(st.why, { color: "64748B", sizeHalfPt: 19 }) + wRun("）", { color: "64748B", sizeHalfPt: 19 }) : "";
        body.push(
          wPara(wRun(`${st.index}. `, { bold: true }) + runsToXml(st.runs) + whyXml, {
            indentLeft: 240,
            spaceBefore: 30,
            spaceAfter: 50,
          }),
        );
      }
    }

    if (!isTeacher || ex.kind === "faded") {
      body.push(wWorkspaceBox(ex.workspaceLines));
    }
  }

  // 4. Check & Exam-Style Practice
  body.push(sectionHeadingXml("随堂测验与配套真题 · Practice Questions"));
  if (doc.practices.length === 0) {
    body.push(wPara(wRun("（本节无随堂练习题 · No practice items）", { color: "64748B", italic: true })));
  }
  for (const q of doc.practices) {
    const hasMarkInline = q.marks ? q.prompt.some((r) => r.kind === "text" && r.text.includes(q.marks!)) : false;
    const markSuffix = q.marks && !hasMarkInline ? wRun(` ${q.marks}`, { bold: true, color: "334155" }) : "";
    const tagSuffix = wRun(`   [${q.sourceTag}]`, { sizeHalfPt: 18, color: "64748B" });
    body.push(wPara(wRun(`${q.number}. `, { bold: true }) + runsToXml(q.prompt) + markSuffix + tagSuffix, { spaceBefore: 120, spaceAfter: 50, keepNext: true }));

    if (q.kind === "mcq" && q.options) {
      for (const opt of q.options) {
        const tick = isTeacher && opt.isCorrect ? wRun(" ✓", { bold: true, color: RED_ACCENT_HEX }) : "";
        body.push(wPara(wRun(`${opt.letter}. `, { bold: true }) + runsToXml(opt.runs) + tick, { indentLeft: 300, spaceBefore: 20, spaceAfter: 30 }));
      }
      if (!isTeacher) {
        body.push(wPara(wRun("作答 Answer：______"), { indentLeft: 300, spaceBefore: 30, spaceAfter: 80 }));
      }
    } else if (q.kind === "match" && q.matchPairs) {
      body.push(
        wBorderedTable(
          [wRun("项目 Item", { bold: true, sizeHalfPt: 20 }), wRun("匹配项 Match (已打乱 Shuffled)", { bold: true, sizeHalfPt: 20 })],
          q.matchPairs.map((row) => [
            wRun(`${row.number}. `, { bold: true, sizeHalfPt: 20 }) + runsToXml(row.left, { sizeHalfPt: 20 }),
            wRun(`${row.rightLetter}. `, { bold: true, sizeHalfPt: 20 }) + runsToXml(row.rightShuffled, { sizeHalfPt: 20 }),
          ]),
          [5046, 5046],
        ),
      );
      if (!isTeacher) {
        const blankLine = q.matchPairs.map((r) => `${r.number} — ____`).join("     ");
        body.push(wPara(wRun(`配对作答 Match：${blankLine}`), { spaceBefore: 60, spaceAfter: 100 }));
      }
    } else if (q.kind === "order" && q.orderCards) {
      for (const card of q.orderCards) {
        body.push(wPara(wRun(`${card.letter}. `, { bold: true }) + runsToXml(card.runs), { indentLeft: 300, spaceBefore: 20, spaceAfter: 30 }));
      }
      if (!isTeacher) {
        const orderBlank = q.orderCards.map(() => "____").join(" → ");
        body.push(wPara(wRun(`正确顺序 Order：${orderBlank}`), { indentLeft: 300, spaceBefore: 40, spaceAfter: 80 }));
      }
    } else if (!isTeacher) {
      for (let lineIdx = 0; lineIdx < q.ruledLines; lineIdx++) {
        body.push(wPara(wRun(""), { borderBottomColor: "CBD5E1", indentLeft: 240, spaceBefore: 130, spaceAfter: 70 }));
      }
    }

    if (isTeacher && q.teacherAnswer) {
      body.push(wPara(wRun("参考答案 Answer：", { bold: true }) + runsToXml(q.teacherAnswer), { indentLeft: 240, spaceBefore: 40, spaceAfter: 80 }));
    }
  }

  // 5. Teacher Answer Key & Notes (`copy === "teacher"` only, dedicated page break)
  if (isTeacher && doc.answerKey) {
    body.push(wPageBreak());
    body.push(sectionHeadingXml("教师参考答案与讲评要点 · Teacher Answer Key & Notes", true));
    for (const item of doc.answerKey) {
      body.push(wPara(wRun(item.heading.replace(/\$/g, ""), { bold: true, sizeHalfPt: 21 }), { spaceBefore: 120, spaceAfter: 30, keepNext: true }));
      if (item.answer) {
        body.push(wPara(wRun("答案 Key：", { bold: true }) + runsToXml(item.answer), { indentLeft: 200, spaceBefore: 20, spaceAfter: 30 }));
      }
      if (item.rationale) {
        body.push(wPara(wRun("解析 Rationale：", { bold: true }) + runsToXml(item.rationale), { indentLeft: 200, spaceBefore: 20, spaceAfter: 30 }));
      }
      for (const m of item.misconceptions) {
        body.push(wPara(wRun("易错点 Misconception：", { bold: true, color: "B45309" }) + runsToXml(m), { indentLeft: 200, spaceBefore: 20, spaceAfter: 30 }));
      }
      if (item.notes) {
        body.push(wPara(wRun("讲评提示 Teaching Notes：", { bold: true, color: "475569" }) + runsToXml(item.notes), { indentLeft: 200, spaceBefore: 20, spaceAfter: 50 }));
      }
    }
  }

  const sectPr = [
    "<w:sectPr>",
    `<w:pgSz w:w="${A4_WIDTH_DXA}" w:h="${A4_HEIGHT_DXA}"/>`,
    `<w:pgMar w:top="${A4_MARGIN_DXA}" w:right="${A4_MARGIN_DXA}" w:bottom="${A4_MARGIN_DXA}" w:left="${A4_MARGIN_DXA}" w:header="454" w:footer="454" w:gutter="0"/>`,
    "</w:sectPr>",
  ].join("");

  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<w:body>${body.join("")}${sectPr}</w:body>`,
    "</w:document>",
  ].join("");

  return buildZip([
    { name: "[Content_Types].xml", data: buildContentTypesXml() },
    { name: "_rels/.rels", data: buildRootRelsXml() },
    { name: "word/_rels/document.xml.rels", data: buildDocRelsXml() },
    { name: "word/styles.xml", data: buildStylesXml() },
    { name: "word/document.xml", data: documentXml },
    { name: "docProps/core.xml", data: buildCorePropsXml(doc.header.title) },
    { name: "docProps/app.xml", data: buildAppPropsXml() },
  ]);
}
