import katex from "katex";
import katexCssRaw from "katex/dist/katex.min.css?raw";
import type { HandoutDoc, HandoutRun, HandoutTable } from "./model.ts";

const KATEX_EMBEDDED_CSS = katexCssRaw.replace(/@font-face\s*\{[^}]*\}/g, "");

const PRINT_STYLES = `
@page { size: A4; margin: 16mm; }
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  color: #0f172a;
  background: #e2e8f0;
  font-family: "PingFang SC", "Noto Sans SC", "Microsoft YaHei", Arimo, -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 10.5pt;
  line-height: 1.58;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.ho-toolbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 20px;
  background: #0f172a;
  color: #f8fafc;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.2);
}
.ho-toolbar-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.ho-badge {
  display: inline-block;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  background: #dbeafe;
  color: #1e40af;
}
.ho-badge.teacher {
  background: #fee2e2;
  color: #C81E1E;
}
.ho-print-btn {
  padding: 7px 16px;
  border: 0;
  border-radius: 8px;
  background: #2563eb;
  color: #ffffff;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.ho-print-btn:hover { background: #1d4ed8; }
.ho-sheet {
  width: 210mm;
  min-height: 297mm;
  margin: 16px auto 32px;
  padding: 16mm;
  background: #ffffff;
  box-shadow: 0 6px 24px rgba(15, 23, 42, 0.12);
}
.ho-header {
  border-bottom: 2px solid #0f172a;
  padding-bottom: 10px;
  margin-bottom: 14px;
}
.ho-title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.ho-title {
  margin: 0;
  font-size: 18pt;
  line-height: 1.25;
  color: #0f172a;
}
.ho-meta-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  margin-top: 8px;
  font-size: 9.5pt;
  color: #334155;
}
.ho-student-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed #cbd5e1;
  font-size: 10pt;
}
.ho-section { margin-top: 16px; }
.ho-section-title {
  margin: 0 0 8px;
  padding: 4px 10px;
  background: #f1f5f9;
  border-left: 4px solid #1d4ed8;
  font-size: 12pt;
  font-weight: 700;
  color: #0f172a;
}
.ho-section-title.teacher-key {
  background: #fef2f2;
  border-left-color: #C81E1E;
  color: #991b1b;
}
.ho-checklist {
  list-style: none;
  margin: 6px 0 10px;
  padding: 0;
}
.ho-checklist li {
  margin: 4px 0;
  padding-left: 2px;
}
.ho-loop-title {
  margin: 12px 0 6px;
  font-size: 10.5pt;
  font-weight: 700;
  color: #1e3a8a;
}
.ho-block {
  margin: 8px 0 12px;
  padding: 8px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  break-inside: avoid;
}
.ho-block-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}
.ho-block-title {
  margin: 0;
  font-size: 10.5pt;
  font-weight: 700;
}
.ho-src {
  font-size: 8.5pt;
  color: #64748b;
  white-space: nowrap;
}
.ho-bullets {
  margin: 4px 0;
  padding-left: 18px;
}
.ho-bullets li { margin: 4px 0; }
.ho-em-red {
  color: #C81E1E;
  font-weight: 700;
}
.ho-blank {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.03em;
  color: #334155;
}
.ho-formula {
  margin: 8px 0;
  padding: 8px 12px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  text-align: center;
}
.ho-formula-caption {
  margin-top: 4px;
  font-size: 9pt;
  color: #475569;
}
.ho-flow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 6px 0;
  font-size: 9.5pt;
}
.ho-flow-step {
  padding: 3px 8px;
  border: 1px solid #cbd5e1;
  border-radius: 4px;
  background: #f8fafc;
}
.ho-table {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 9.5pt;
  break-inside: avoid;
}
.ho-table th, .ho-table td {
  border: 1px solid #cbd5e1;
  padding: 5px 8px;
  text-align: left;
  vertical-align: top;
}
.ho-table th {
  background: #f1f5f9;
  font-weight: 700;
}
.ho-table-caption {
  font-size: 9pt;
  color: #475569;
  margin: 4px 0 2px;
  font-weight: 600;
}
.ho-misconceptions {
  margin: 8px 0;
  padding: 7px 10px;
  background: #fffbeb;
  border-left: 3px solid #d97706;
  font-size: 9.5pt;
}
.ho-example {
  margin: 10px 0;
  padding: 9px 11px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  break-inside: avoid;
}
.ho-problem {
  margin: 4px 0 8px;
  padding: 6px 8px;
  background: #f8fafc;
  border-radius: 4px;
}
.ho-steps {
  margin: 4px 0;
  padding-left: 20px;
}
.ho-steps li { margin: 4px 0; }
.ho-why {
  margin-left: 8px;
  font-size: 9pt;
  color: #475569;
}
.ho-workspace {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px dashed #94a3b8;
  border-radius: 6px;
  background: #ffffff;
}
.ho-workspace-label {
  font-size: 8.5pt;
  color: #64748b;
  margin-bottom: 4px;
}
.ho-rule-line {
  height: 22px;
  border-bottom: 1px solid #cbd5e1;
}
.ho-question {
  margin: 10px 0;
  padding-bottom: 6px;
  break-inside: avoid;
}
.ho-q-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.ho-q-tag {
  font-size: 8.5pt;
  color: #64748b;
}
.ho-mark {
  margin-left: auto;
  font-size: 9pt;
  font-weight: 700;
  color: #334155;
}
.ho-options {
  list-style: none;
  margin: 5px 0 4px;
  padding-left: 14px;
}
.ho-options li { margin: 3px 0; }
.ho-teacher-inline-ans {
  margin-top: 4px;
  font-size: 9.5pt;
}
.ho-page-break {
  break-before: page;
  page-break-before: always;
}
.ho-key-item {
  margin: 8px 0;
  padding: 7px 10px;
  border-bottom: 1px solid #e2e8f0;
  break-inside: avoid;
}
.ho-key-item h4 {
  margin: 0 0 4px;
  font-size: 10pt;
}
.ho-key-row {
  margin: 2px 0;
  font-size: 9.5pt;
}
@media print {
  html, body { background: #ffffff; }
  .ho-toolbar { display: none !important; }
  .ho-sheet {
    width: auto;
    min-height: 0;
    margin: 0;
    padding: 0;
    box-shadow: none;
  }
}
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

function renderTex(tex: string, displayMode: boolean): string {
  const clean = tex.replace(/\$/g, "").trim();
  try {
    return katex.renderToString(clean, {
      displayMode,
      throwOnError: false,
      output: "html",
      strict: "ignore",
      trust: false,
    });
  } catch {
    return `<code>${escapeHtml(clean)}</code>`;
  }
}

export function renderRunsHtml(runs: HandoutRun[]): string {
  return runs
    .map((run) => {
      if (run.kind === "blank") {
        return '<span class="ho-blank">____________</span>';
      }
      if (run.kind === "math") {
        const rendered = renderTex(run.tex, !!run.display);
        return run.highlight ? `<span class="ho-math ho-em-red">${rendered}</span>` : `<span class="ho-math">${rendered}</span>`;
      }
      const escaped = escapeHtml(run.text).replace(/\n/g, "<br>");
      if (run.highlight) return `<strong class="ho-em-red">${escaped}</strong>`;
      if (run.bold) return `<strong>${escaped}</strong>`;
      return escaped;
    })
    .join("");
}

function renderTableHtml(table: HandoutTable): string {
  const caption = table.caption ? `<div class="ho-table-caption">${renderRunsHtml(table.caption)}</div>` : "";
  const ths = table.headers.map((h) => `<th>${renderRunsHtml(h)}</th>`).join("");
  const trs = table.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderRunsHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `${caption}<table class="ho-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

function renderRuledLines(count: number): string {
  return Array.from({ length: count }, () => '<div class="ho-rule-line"></div>').join("");
}

/**
 * Compiles `HandoutDoc` into a standalone, self-contained A4 print-styled HTML document with
 * inline KaTeX math (`katex.renderToString`), embedded print CSS, and a `window.print()` toolbar.
 */
export function compileHandoutHtml(doc: HandoutDoc, opts: { fontCss?: string } = {}): string {
  const isTeacher = doc.copy === "teacher";
  const parts: string[] = [];

  // 1. Header & Syllabus / Learning Objectives Checklist
  parts.push('<header class="ho-header">');
  parts.push('<div class="ho-title-row">');
  parts.push(`<h1 class="ho-title">${renderRunsHtml(doc.header.titleRuns)}</h1>`);
  parts.push(`<span class="ho-badge${isTeacher ? " teacher" : ""}">${escapeHtml(doc.header.copyBadge)}</span>`);
  parts.push("</div>");
  parts.push('<div class="ho-meta-grid">');
  parts.push(`<span><b>学段/难度 Grade:</b> ${escapeHtml(doc.header.grade)}</span>`);
  parts.push(`<span><b>课程类型 Subject:</b> ${escapeHtml(doc.header.subject)}</span>`);
  parts.push(`<span><b>建议时长 Duration:</b> ${escapeHtml(doc.header.duration)}</span>`);
  if (doc.header.sourcesLabel) {
    parts.push(`<span><b>教材页码 Pages:</b> ${escapeHtml(doc.header.sourcesLabel)}</span>`);
  }
  parts.push("</div>");
  if (!isTeacher) {
    parts.push(
      '<div class="ho-student-fields"><span>姓名 Name：<span class="ho-blank">____________</span></span><span>班级 Class：<span class="ho-blank">__________</span></span><span>日期 Date：<span class="ho-blank">__________</span></span></div>',
    );
  }
  parts.push("</header>");

  if (doc.header.objectives.length > 0 || doc.header.glossary.length > 0) {
    parts.push('<section class="ho-section" data-section="objectives">');
    parts.push('<h2 class="ho-section-title">学习目标与核心词汇 · Learning Objectives &amp; Glossary</h2>');
    if (doc.header.objectives.length > 0) {
      parts.push('<ul class="ho-checklist">');
      for (const obj of doc.header.objectives) {
        parts.push(`<li>☐ ${renderRunsHtml(obj)}</li>`);
      }
      parts.push("</ul>");
    }
    if (doc.header.glossary.length > 0) {
      parts.push('<table class="ho-table"><thead><tr><th>核心术语 Term</th><th>中文释义 / 备注 Meaning</th></tr></thead><tbody>');
      for (const g of doc.header.glossary) {
        parts.push(`<tr><td><strong>${escapeHtml(g.term)}</strong></td><td>${escapeHtml(g.zh || "—")}</td></tr>`);
      }
      parts.push("</tbody></table>");
    }
    parts.push("</section>");
  }

  // 2. Guided Notes
  parts.push('<section class="ho-section" data-section="guided-notes">');
  parts.push('<h2 class="ho-section-title">导学笔记 · Guided Notes</h2>');
  if (doc.guidedNotes.length === 0) {
    parts.push('<p class="ho-src">（本节无概念讲授页 · No lecture concept slides in this deck）</p>');
  }
  for (const group of doc.guidedNotes) {
    parts.push(`<div class="ho-loop"><div class="ho-loop-title">${escapeHtml(group.heading)}</div>`);
    for (const block of group.blocks) {
      parts.push('<div class="ho-block">');
      parts.push('<div class="ho-block-head">');
      parts.push(`<h3 class="ho-block-title">${renderRunsHtml(block.title)}</h3>`);
      if (block.sourcesLabel) parts.push(`<span class="ho-src">${escapeHtml(block.sourcesLabel)}</span>`);
      parts.push("</div>");
      if (block.bullets.length > 0) {
        parts.push('<ul class="ho-bullets">');
        for (const bullet of block.bullets) {
          parts.push(`<li>${renderRunsHtml(bullet)}</li>`);
        }
        parts.push("</ul>");
      }
      for (const f of block.formulas) {
        parts.push('<div class="ho-formula">');
        parts.push(renderTex(f.tex, true));
        if (f.caption) parts.push(`<div class="ho-formula-caption">${renderRunsHtml(f.caption)}</div>`);
        parts.push("</div>");
      }
      for (const flow of block.flows) {
        const chain = flow.map((step) => `<span class="ho-flow-step">${renderRunsHtml(step)}</span>`).join("<span>→</span>");
        parts.push(`<div class="ho-flow">${chain}</div>`);
      }
      for (const tbl of block.tables) {
        parts.push(renderTableHtml(tbl));
      }
      parts.push("</div>");
    }
    if (isTeacher && group.misconceptions.length > 0) {
      parts.push('<div class="ho-misconceptions">');
      for (const m of group.misconceptions) {
        parts.push(`<div>• ${renderRunsHtml(m)}</div>`);
      }
      parts.push("</div>");
    }
    parts.push("</div>");
  }
  parts.push("</section>");

  // 3. Worked & Faded Examples
  parts.push('<section class="ho-section" data-section="worked-examples">');
  parts.push('<h2 class="ho-section-title">例题示范与演练 · Worked Examples</h2>');
  if (doc.examples.length === 0) {
    parts.push('<p class="ho-src">（本节无独立分步例题 · See practice questions below）</p>');
  }
  for (const ex of doc.examples) {
    parts.push('<div class="ho-example">');
    parts.push('<div class="ho-block-head">');
    const tag = ex.kind === "faded" ? "【半留白演练 Faded Practice】" : "【例题示范 Worked Example】";
    parts.push(`<h3 class="ho-block-title">${escapeHtml(tag)} ${renderRunsHtml(ex.title)}</h3>`);
    if (ex.sourcesLabel) parts.push(`<span class="ho-src">${escapeHtml(ex.sourcesLabel)}</span>`);
    parts.push("</div>");
    parts.push(`<div class="ho-problem"><strong>题目 Problem：</strong>${renderRunsHtml(ex.problem)}</div>`);
    parts.push('<ol class="ho-steps">');
    for (const st of ex.steps) {
      if (st.hiddenInStudent && !isTeacher) {
        parts.push('<li><em>请独立完成此步推导与计算 Complete this step:</em> <span class="ho-blank">____________</span></li>');
      } else {
        const whyHtml = st.why ? `<span class="ho-why">（${renderRunsHtml(st.why)}）</span>` : "";
        parts.push(`<li>${renderRunsHtml(st.runs)}${whyHtml}</li>`);
      }
    }
    parts.push("</ol>");
    if (!isTeacher || ex.kind === "faded") {
      parts.push('<div class="ho-workspace">');
      parts.push('<div class="ho-workspace-label">演算与作答区 Workspace (show formula, substitution &amp; SI units):</div>');
      parts.push(renderRuledLines(ex.workspaceLines));
      parts.push("</div>");
    }
    parts.push("</div>");
  }
  parts.push("</section>");

  // 4. Check & Exam-Style Practice
  parts.push('<section class="ho-section" data-section="practice-questions">');
  parts.push('<h2 class="ho-section-title">随堂测验与配套真题 · Practice Questions</h2>');
  if (doc.practices.length === 0) {
    parts.push('<p class="ho-src">（本节无随堂练习题 · No practice items）</p>');
  }
  for (const q of doc.practices) {
    parts.push('<div class="ho-question">');
    parts.push('<div class="ho-q-head">');
    parts.push(`<strong>${q.number}.</strong>`);
    parts.push(`<span>${renderRunsHtml(q.prompt)}</span>`);
    if (q.marks && !runsContainMark(q.prompt, q.marks)) {
      parts.push(`<span class="ho-mark">${escapeHtml(q.marks)}</span>`);
    }
    parts.push("</div>");
    parts.push(`<div class="ho-q-tag">${escapeHtml(q.sourceTag)}</div>`);

    if (q.kind === "mcq" && q.options) {
      parts.push('<ul class="ho-options">');
      for (const opt of q.options) {
        const checkMark = isTeacher && opt.isCorrect ? " ✓" : "";
        parts.push(`<li><strong>${escapeHtml(opt.letter)}.</strong> ${renderRunsHtml(opt.runs)}${checkMark}</li>`);
      }
      parts.push("</ul>");
      if (!isTeacher) {
        parts.push('<div>作答 Answer：<span class="ho-blank">______</span></div>');
      }
    } else if (q.kind === "match" && q.matchPairs) {
      parts.push('<table class="ho-table"><thead><tr><th>项目 Item</th><th>匹配项 Match (已打乱 Shuffled)</th></tr></thead><tbody>');
      for (const row of q.matchPairs) {
        parts.push(
          `<tr><td><strong>${row.number}.</strong> ${renderRunsHtml(row.left)}</td><td><strong>${escapeHtml(row.rightLetter)}.</strong> ${renderRunsHtml(row.rightShuffled)}</td></tr>`,
        );
      }
      parts.push("</tbody></table>");
      if (!isTeacher) {
        const blanks = q.matchPairs.map((r) => `${r.number} — <span class="ho-blank">____</span>`).join("&emsp;");
        parts.push(`<div>配对作答 Match：${blanks}</div>`);
      }
    } else if (q.kind === "order" && q.orderCards) {
      parts.push('<ul class="ho-options">');
      for (const card of q.orderCards) {
        parts.push(`<li><strong>${escapeHtml(card.letter)}.</strong> ${renderRunsHtml(card.runs)}</li>`);
      }
      parts.push("</ul>");
      if (!isTeacher) {
        const orderBlank = q.orderCards.map(() => '<span class="ho-blank">____</span>').join(" → ");
        parts.push(`<div>正确顺序 Order：${orderBlank}</div>`);
      }
    } else if (!isTeacher) {
      parts.push(renderRuledLines(q.ruledLines));
    }

    if (isTeacher && q.teacherAnswer) {
      parts.push(`<div class="ho-teacher-inline-ans"><strong>参考答案 Answer：</strong>${renderRunsHtml(q.teacherAnswer)}</div>`);
    }
    parts.push("</div>");
  }
  parts.push("</section>");

  // 5. Teacher Answer Key & Notes (`copy === "teacher"` only, dedicated page break)
  if (isTeacher && doc.answerKey) {
    parts.push('<section class="ho-section ho-page-break" data-section="teacher-answer-key">');
    parts.push('<h2 class="ho-section-title teacher-key">教师参考答案与讲评要点 · Teacher Answer Key &amp; Notes</h2>');
    for (const item of doc.answerKey) {
      parts.push('<div class="ho-key-item">');
      parts.push(`<h4>${escapeHtml(item.heading)}</h4>`);
      if (item.answer) {
        parts.push(`<div class="ho-key-row"><strong>答案 Key：</strong>${renderRunsHtml(item.answer)}</div>`);
      }
      if (item.rationale) {
        parts.push(`<div class="ho-key-row"><strong>解析 Rationale：</strong>${renderRunsHtml(item.rationale)}</div>`);
      }
      for (const m of item.misconceptions) {
        parts.push(`<div class="ho-key-row"><strong>易错点 Misconception：</strong>${renderRunsHtml(m)}</div>`);
      }
      if (item.notes) {
        parts.push(`<div class="ho-key-row"><strong>讲评提示 Teaching Notes：</strong>${renderRunsHtml(item.notes)}</div>`);
      }
      parts.push("</div>");
    }
    parts.push("</section>");
  }

  const pageTitle = `${doc.header.title} · 配套讲义（${isTeacher ? "教师答案版" : "学生版"}）`;

  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(pageTitle)}</title>`,
    opts.fontCss ? `<style>${opts.fontCss}</style>` : "",
    `<style>${KATEX_EMBEDDED_CSS}</style>`,
    `<style>${PRINT_STYLES}</style>`,
    "</head>",
    "<body>",
    '<div class="ho-toolbar" data-testid="handout-toolbar">',
    `<div class="ho-toolbar-meta"><strong>${escapeHtml(doc.header.title)}</strong><span class="ho-badge${isTeacher ? " teacher" : ""}">${escapeHtml(doc.header.copyBadge)}</span></div>`,
    '<button type="button" class="ho-print-btn" onclick="window.print()">打印 / 另存为 PDF · Print / Save PDF</button>',
    "</div>",
    `<main class="ho-sheet">${parts.join("\n")}</main>`,
    "</body>",
    "</html>",
  ]
    .filter(Boolean)
    .join("\n");
}

function runsContainMark(runs: HandoutRun[], marks: string): boolean {
  return runs.some((r) => r.kind === "text" && r.text.includes(marks));
}
