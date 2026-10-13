# AI 课件工坊 · 架构（v10，教材模块：教材读写收进一个模块，见 docs/design/textbook-module.md）

> 状态：2026-10-13 · 与 `main` 上的代码一致（后台与教材库：Messages 协议、测试连接、概览、教材管理合并后）。来源文档：第一性原理审查 · 夜间决策记录（权威）· HTML 课件调研 · 教学规则（规则编号 L/P/V/I/T/Q 出自此文）· 老师调研 · 项目决策记录 · 对抗审查 1 / 2 / 3 · 消融结果（均在项目资料库 `docs/`，不在本仓库）。代码与本文冲突时以代码为准，并修正本文。

---

## 0. 一页结论

- **产品主线只有一条**：上传 PDF → 选章节 → 设置这节课 → **确认时间预算大纲（唯一强制卡点）** → 逐页生成、可编辑 → 放映 / 分享。界面是线性的五步向导，每步只有一个主按钮。
- **运行时只用 Workers + Static Assets + D1**，`wrangler dev` 本地免费运行，适配 Workers 免费版（每次调用 10ms CPU、50 次 D1 查询）。没有 Durable Objects、Workflows、Queues、R2、Containers。
- **PDF 在老师浏览器里用 pdf.js 解析**；服务端只存“章节树 + 每页文本 + 印刷页码”。
- **密码用 WebCrypto PBKDF2-SHA256，300k 次迭代**（本机约 35ms；取舍见 §9）。
- **卡点 = SQLite 触发器 + 409**：已确认的大纲版本不可改不可删；页面只能挂在已确认版本上；生成接口对未确认版本返回 409。超出课时 ±15% 时确认需要老师显式“仍然确认”，服务端同样强制（409 → 带 ack 重试）。
- **每个大纲版本快照自己的课时参数与页码范围**；之后改设置不会悄悄改变已有版本的含义，界面提示“需重新生成大纲”。
- **生成幂等、可复用**：页面按 `slideKey` 跨版本复用。`slideKey` 由 `generation` 导出，只包含 writer 真正读取的输入（规格的页型、版式、标题、目的、要点、视觉、分钟、页码，加学生水平和授课语言）；改“本节重点”或课时长度不会作废已生成或手改的页。“修改大纲”复制源版本的参数与范围快照。单页可“重新生成”、按槽位表单编辑、撤销一步。
- **待核实（数字与页码核对）**：屏幕上和讲稿里的数字、公式、算式必须能在引用页找到或算得对；大纲引用的页超出所选范围或和内容对不上时不再静默丢弃，而是标记。生成时找不到出处的数字触发一次重试，剩下的存进 `slides.unverified`，编辑器和列表里黄色标出，编辑或撤销后重新核对。
- **规则在规划阶段强制**：连续讲授超过 10 分钟时自动插入一页“检查理解”；图示校验失败（例如表达式算不出来）时保存为“图示待补”占位，渲染器任何情况下都不抛错。
- **上课**：观众窗口永远不显示讲稿和答案；演讲者窗口（`BroadcastChannel` 同步）显示计时、下一页、讲稿、答案；翻页器按键（含方向键）在两个窗口都有效，笔画也双向同步。学生看到的页面（观众窗口、分享页、离线文件）不显示页型标签；版式自带的标签（学习目标、预测 / 观察 / 解释、教材）按授课语言显示。**离线单文件**：课件、放映器、用到的内置实验和按字符子集化的 Noto Sans SC / Arimo / KaTeX 字体打进一个 HTML，断网可放。分两种：上课用的文件讲稿只在单独弹出的演讲者窗口里（S 键不在投影上显示讲稿）；学生版由服务端 `deckExport` 剥离讲稿和误区标签（与分享链接同一处代码）。
- **复用**：“复制到新学期”复制一节课的已确认大纲和全部页面（含手改内容；有更新的草稿也一起复制），新课从 `rev` 0 开始、不带分享链接；修订时按 `slideKey` 只重新生成改过的页。“整单元规划”先预览（每节课的页码和估时，可多一节 / 少一节）再建课：默认节数保证每节估时 ≤ 课时的 115%，课名用节号范围（“4.1–4.3”），不带“第 N/M 课”（课名也是封面标题）；每节课单独确认大纲，在“我的课”里成组显示。课可以删除（软删除 `archived_at`，分享链接立即失效，可撤销但链接不恢复）。
- **课堂互动（都能用翻页器操作、离线可用、按预算测溢出）**：排序 / 配对页（拖动或点两张卡交换，下一步卡片归位）；检查页可设为“先投票”（老师把举手人数输进控制条或演讲者窗口，下一步在投影上显示分布，再下一步揭示答案）；实验页（POE）标注实际结果，揭示时高亮并可录入预测人数。放映器带画笔层（D 键：画、擦、清除，按页保存在内存里，不落库）。
- **生成从不保存超出自身硬预算的页**：`writeSlide` 校验 → 重试 → 截断列表并逐词裁短超长文字 → 仍不合格时换成确定性兜底页 → 还不合格就拒绝保存（502 `SLIDE_INVALID`）。所以老师原样保存 AI 生成的页时永远不会遇到 422。网址不计入字数。
- **课件 = 9 个固定版式 + 带内容预算的类型化槽位**。LLM 只填内容；CSS Grid 落位；浏览器实测溢出；学生要读的字不小于 48px。每个版式按硬预算填满（中 / 英，含表格、流程图、图示待补变体）都能放下，最后一步揭示后没有隐藏的元素，由 Playwright 在 CI 中验证（CI 安装 Noto CJK 字体）。
- **生成流水线在一个包 `@kj/generation`**（大纲 + 单页），消融开关是一个带默认值的普通对象 `PipelineOptions`；评测驱动在产品代码之外的 `tools/eval`。
- **模块单向依赖，dependency-cruiser 在 CI 中强制**；只有 `packages/ai` 能发起模型请求。
- AI 模型在后台配置：**一个启用的提供方 + 一个模型名**服务所有调用（DeepSeek / GLM / OpenAI 兼容），未启用时本地与测试使用确定性 stub。每个提供方选一种接口协议：OpenAI Chat Completions（`{base}/chat/completions`）或 Messages（`{base}/v1/messages`，Anthropic Messages 兼容，`Authorization: Bearer`）；两种都用 SSE 流式（`packages/ai/src/sse.ts`），服务器不理会 `stream` 而直接回 JSON 也接受。可选 `max_tokens` 和自定义请求头（如 `x-source`），请求头的值和 Key 一样加密存在 D1，后台只显示名称和打码后的值。
- **第 5 步只有一个主按钮**：确认大纲后自动开始生成，生成完是“放映”；演讲者视图从放映页打开。
- **第 5 步与分享只看已确认版本**：新的未确认草稿不会挡住放映和分享；分享链接冻结一个版本，学生版不含讲稿和误区标签，账号停用即失效。
- **学生版默认不含答案（课前预习）**：分享链接和学生版离线文件由服务端 `withoutAnswers` 剥掉所有揭示步骤会显示的答案；老师可切到“课后复习（含答案）”，同一个链接。
- **模型调用有请求级总截止时间（120 秒，含重试）**；没有配置模型、由内置模板（stub）应答时，每个页面顶部都有“演示模式 · 不是 AI 写的”横幅。

---

## 1. 运行形态

```
老师浏览器（React SPA，apps/web）
 ├─ 教材摄取（src/textbook：ingest.ts 编排、pdf.ts 是唯一加载 pdf.js 的地方、api.ts 教材接口）：
 │   先算文件 sha256 → POST /documents/lookup：已有的直接用（不解析不上传），没传完的只补缺页，
 │   删除过的可恢复；否则 pdf.js 解析目录、每页文本、印刷页码（getPageLabels）→ 建树 → 分批上传（每批 40 页）
 │   CMap 与标准字体随 SPA 发布在 /pdfjs/（中文 CID 字体的 PDF 没有它们就抽不出字）
 ├─ 向导：上传 → 章节（树 / 按书上页码输入，首尾页预览，字数估时与拆课提示）
 │        → 课堂设置 → 大纲（时间条、密度灯、未覆盖、术语表；规则与服务端同一份代码）
 │        → 生成（先例题后其余，并发 2；单页重新生成 / 槽位编辑 / 撤销 / 待核实）→ 放映 / 分享
 ├─ 放映：观众窗口 /play/:id（无讲稿）+ 演讲者窗口 /presenter/:id（BroadcastChannel 同步翻页、黑屏、投票人数、笔画）
 │        画笔层（canvas，按页存在内存，不落库）
 ├─ 离线导出：public/offline/runtime.{js,css}（Vite IIFE 构建）+ deck（?audience=teacher|student）+ 内置实验 + 字体子集 → 一个 .html
 └─ 渲染：templates/render + widgets/render + player（溢出在此实测）
        │ HTTPS / JSON（x-kj-csrf 头 + httpOnly 会话 Cookie）
Worker（Hono，apps/app）
 ├─ routes（HTTP 边界、鉴权、zod 校验、用例编排）
 ├─ generation（draftOutline / writeSlide）→ ai（唯一模型出口）→ DeepSeek / GLM / OpenAI 兼容 / Messages 兼容网关
 ├─ textbook（教材模块：documents / pages / chapters 的唯一读写入口；index.ts 读接口、write.ts 写接口只给 routes/documents.ts、tables.ts 表定义）
 └─ store（课的 D1 仓储与读模型：快照、复用、聚合查询、lessonView、分享视图；读教材只经 textbook/index.ts）；db/index.ts（drizzle 句柄）
D1：orgs, users, sessions, login_attempts, ai_providers, ai_calls, audit_log,
    documents, pages, chapters, lessons, outline_versions, slides, share_links
静态资源：SPA、字体（Arimo、Noto Sans SC）、KaTeX、内置实验 /sims/*.html
```

本地运行（README“本地运行”）：`corepack pnpm install` → `pnpm setup:local`（本地 D1 迁移 + `scripts/create-admin.mjs --keep`：本地默认管理员 admin / Admin12345、首次登录必须改密码，已有账号不动；`--remote` 总是随机密码）→ `pnpm start:local`（正式使用，生产设置）或 `pnpm dev`（开发），都在 :8787。两者都由 `scripts/local.mjs` 启动：构建前端、执行未执行的本地迁移、第一次运行时生成随机 `AI_CONFIG_KEY` 存到 `apps/app/.wrangler/kj-local.env`（和数据放在一起，权限 600）并把旧版用公开开发密钥加密的 Key 重新加密，然后 `wrangler dev --env-file` 读入密钥（因此不会读到零散的 `.dev.vars`）。`wrangler.jsonc` 的 vars 是生产值（`ENVIRONMENT=production`、`AI_ALLOW_STUB=false`）；`pnpm dev` 用 `--var` 改成 development 并打开 stub，`start:local` 只有加 `--stub` 才打开。`secret()` 只在 vitest（`ENVIRONMENT=test`）里有后备值，别的情况缺密钥就报错，开发默认密钥不可能被意外用上。E2E（`scripts/e2e-server.sh`）每次用随机密钥。没有任何 Key 且打开 stub 时用确定性 stub 跑通全流程，每页黄色“演示模式”横幅标明不是 AI。

关闭标签页会中断逐页生成；重新打开后“继续生成”只补缺失的页。需要后台生成时再引入 Workflows，`writeSlide()` 原样作为 step 主体。

起草大纲有服务端锁：`lessons.drafting_until`（150 秒）用一条条件 UPDATE 抢占，同一节课同时只有一次起草（双击、刷新、另一个标签页 → 409 `DRAFT_IN_PROGRESS`，不会重复计费或生成两个版本）。请求断开后 `waitUntil` 让已开始的起草跑完；界面按 `drafting` 每 3 秒轮询并显示已用秒数。请求死掉时锁到期自动释放。

---

## 2. 模块图与允许的依赖

```
                         schema（只依赖 zod）
        ┌────────────┬──────────┴──────┬─────────────┬──────────┐
        ▼            ▼                 ▼             ▼          ▼
  textbook    widgets ──────► templates      pedagogy      ai
 (core|browser)  (core|render)    (core|render)      ▲          ▲
        ▲            ▲                 ▲             │          │
        │            │                 ├──► player   │          │
        │            │                 │             │          │
        │            └──────────► generation ◄───────┴──────────┘
        │                              ▲
        │                 apps/app（routes → store / textbook）tools/eval（消融驱动、渲染测量）
   apps/web（textbook/browser, templates/render, widgets/render, player, pedagogy, pptx）
   pptx（schema + templates 核心 + widgets 核心 → 可编辑 .pptx；不依赖应用、渲染入口、player、模型）
```

**规则（`.dependency-cruiser.cjs`，`pnpm lint` 执行，违反即失败）**

| 规则 | 说明 |
|---|---|
| `no-circular` | 禁止循环依赖 |
| `schema-is-a-leaf` | `schema` 只放类型与 zod schema，不依赖其他包 |
| `packages-never-import-apps` | `packages/*` 永不依赖 `apps/*` |
| `server-code-is-dom-free` | `apps/app`、`ai`、`generation`、`pedagogy`、`schema`，以及 `templates`/`widgets`/`textbook` 的核心入口，不得导入渲染入口、player、pdf.js、ECharts、KaTeX、React |
| `model-calls-stay-on-the-server` | `apps/web`、`player` 不得导入 `ai`、`generation` |
| `only-textbook-ingest-loads-pdfjs` | `apps/web` 里只有 `src/textbook/` 能导入 pdf.js 或 `textbook/browser` |
| `only-textbook-ingest-cuts-pdfs` | `apps/web` 里只有 `src/textbook/` 能导入 pdf-lib（切子 PDF），按需加载 |
| `only-the-server-and-evals-orchestrate` | 其他 `packages/*` 不得导入 `generation`（只有 Worker 路由与 `tools/eval` 调用它） |
| `product-code-never-imports-tools` | `apps/*`、`packages/*` 不得导入 `tools/*` |
| `ai-layer-is-generic` | `ai` 只依赖 `schema`，不认识课、版式、教学规则 |
| `pedagogy-rules-do-not-import-templates` | `pedagogy` 不得依赖 `templates`：共用的版式预算与页型 → 版式映射来自 `schema`（审查 #3 D-10）。规则同时匹配裸包名 `@kj/templates`，没有声明依赖、导入解析不了时也会报错 |
| `pedagogy-has-no-io` | `pedagogy` 不得依赖 `ai`、`generation`、`player`、`textbook` |
| `textbook-core-is-a-low-layer` | `textbook`（教材核心）只依赖 `schema`，不认识课、教学规则、版式、模型（同时匹配裸包名） |
| `textbook-tables-are-private` | `documents` / `pages` / `chapters`（`apps/app/src/textbook/tables.ts`）只能在 `apps/app/src/textbook/` 里导入；`db/schema.ts` 只为 `lessons` 的外键导入且不再导出（`apps/app/test/boundaries.test.ts` 检查） |
| `textbook-writes-only-from-the-documents-route` | `textbook/write.ts`（上传、粘贴、删除）只给 `routes/documents.ts` 用；其他代码只经 `textbook/index.ts` 读 |
| `textbook-does-not-know-lessons` | `apps/app/src/textbook/` 不得导入 `store.ts`、`routes/*`、`ai.ts`，也不得导入 `generation`、`pedagogy`、`templates`、`widgets`、`player`、`pptx` |
| `only-parser-adapters-call-ai` | 教材模块里只有 `textbook/parsers/` 能导入 `ai`：解封管理员填的自部署地址和 Key，以及看图模型兜底 `parsers/vision.ts`（模型层由 `routes/documents.ts` 按请求传进来，教材模块不导入 `apps/app/src/ai.ts`） |
| `parsers-plug-in-through-the-textbook-module` | `textbook/parsers/` 只给教材模块自己、`routes/documents.ts`（解析任务）和 `routes/admin.ts`（开关）用 |
| `admin-sees-parser-settings-only` | `routes/admin.ts` 只能导入 `textbook/parsers/settings.ts`，不碰任务和适配器 |
| `pptx-export-reads-the-deck-only` | `pptx` 只依赖 `schema`、`templates` / `widgets` 的核心入口（和 pptxgenjs），不得导入渲染入口、player、`ai`、`generation`、`pedagogy`、`textbook` |
| AI 出口检查 | 只有 `packages/ai` 能导入模型 SDK 或写模型端点（`scripts/check-ai-boundary.mjs`，扫描 apps、packages、tools、scripts；这是这条边界唯一的检查） |

---

## 3. 各模块职责与公共接口

| 模块 | 单一职责 | 公共接口（摘要） |
|---|---|---|
| `schema` | 跨模块数据契约 | `ParsedPdf`、`PageText{no, text, label?, kind?}`、`PageKind`（text · blank · scanned · garbled · formula-lost · formula-text · table）、`PageProbe`（每页探针的计数）、`ChapterNode`、`LessonParams`、`PageType`、`LayoutId`、`SlideSpec{…, sourceIssue?}`、`Outline{objectives, slides, glossary, notCovered}`、`SlideContent`（按版式区分的联合）、`Slide{…, unverified?, canUndo?}`、`Unverified{kind: number\|formula\|calc\|source, text, detail}`、`WidgetSpec`（含 `table`、`placeholder`）、`ThemeId`；`newId()`、`sha256Hex()`、`countWords()`；版式预算 `BUDGETS`、`CANVAS`、`FONT` 与页型 → 版式映射 `layoutForPageType`（`templates` 与 `pedagogy` 共用，放在这里使 `pedagogy` 不依赖 `templates`，D-10） |
| `textbook`（原 `pdf-structure`，教材模块 PR 9 改名） | 目录 + 页文本 → 章节树、范围、源文本 | `buildChapterTree`、`rangesForChapters`、`normalizeRanges`、`pagesInRanges`、`countPages`、`sourceForRanges(pages, ranges, maxChars) → {text, included, omitted}`、`sourceCut(pageSizes, maxChars)`（只按长度预测哪些页读不进）、`isEmptyPage(words)`（< 5 词 = 扫描页）、`distributeText`（粘贴文字分到多页）、`labelOf`、`formatPages`、`pageForLabel`（按印刷页码解析输入）、`subtreeIds`、`leafSections(tree, chapterIds)`（选中的最深一级章节：大纲的 sections、单元拆分的归属）、`chapterRunsOf(tree, scope, words) → ChapterRun[]`（按叶子章节切成连续页段，父章节的引言页归父章节；结构上就是 `pedagogy.UnitPiece`）、`missingRanges(present, pageCount)`（续传时还缺哪些页）、`pageFacts(text) → {words, chars, flags}`（服务端存页时重算；`flags` 是 `suspiciousSpans` 的种类）、`PDFJS_PARSER` / `PASTE_PARSER`（页文字的来源）、`classifyPage(probe) → PageKind`（阈值见 `docs/research/pdf-parsing.md` §7：扫描 = 字少且图大；乱码 = 坏字符 > 5%；公式没读出 = 成排的画成图形的字形，或正文行里的空洞；公式文字 = 数学符号分 ≥ 40；表格 = 线条或格子多）、`MUST_FIX_KINDS`（scanned · garbled · formula-lost：文字层读不全，要换解析器或老师粘贴）/ `REFINE_KINDS`（formula-text · table：读得出但不完美，只在老师要求时精修）、`needsText({words, kind, parser})`（没有文字，或必修页仍是 pdf.js 或看图模型的文字：看图模型可能读错数字，老师粘贴的为准）、`routePages(pages, parsers, {kinds, limit}) → {parserId: 页号[]}`（纯函数：按页种类把页分给启用的解析器，剩下的归 `manual` = 老师粘贴）、外部解析器 id `MINERU_AGENT_PARSER`（`mineru-agent/1`）/ `MINERU_PARSER`（`mineru/1`）/ `MINERU_SELFHOST_PARSER`（`mineru-selfhost/1`，学校自部署的 MinerU）与 `isExternalParser`、看图模型 `visionParserId(model)`（`vlm:<模型>/1`）/ `isVisionParser`、`cleanVisionText`（去掉模型偶尔包的 Markdown 代码块）、`separatorText(i)` / `splitSeparated(markdown, n)`（子 PDF 每页前插一页“KJPAGE i”，结果是一整份 Markdown，按分隔页拆回各页；印在页边的标记会被当成页眉丢掉，所以用整页）、`cleanParsedMarkdown`（去图片和注释，HTML 表格转成 `a | b` 行，保留标题与 LaTeX）；浏览器入口 `parsePdf(data, title, {onProgress, assets})`（配置 CMap / 标准字体；丢弃极小字号文字；页面有像指令的文字时再去掉白色文字；同一循环里取操作符列表，`probePage` 数图片面积、画成路径的字形、线条与格子，每页定 `kind`，不多读一遍 PDF）；`pageRenderer(file).render(no)`（把一页画成 JPEG data URL，长边 1600 px、质量 0.8，给看图模型） |
| `widgets` | 声明式图示与交互：校验、表达式、渲染 | 核心：`validateWidget`、`compileExpr`（自写解析器，不用 eval）、`chartOption`、`functionOption`、`EMBED_CATALOG` / `resolveEmbed` / `findEmbed(text, minHits)`（整词匹配）；渲染入口 `renderWidget(spec, host, ctx) → {dispose}`（从不抛错：画不出来时显示“图示无法显示”占位） |
| `templates` | 9 个固定版式：槽位 schema、内容预算、HTML 渲染、给老师看的槽位报错 | 核心：`LAYOUTS`、`layoutForPageType`（从 `schema` 再导出）、`PAGE_TYPE_VISUALS`、`SLOT_SCHEMAS` / `slotSchema`、`TABLE_SLOT` / `TABLE_NARROW_SLOT` / `FLOW_SLOT` / `PLACEHOLDER_SLOT`、`BUDGETS`、`FONT`（从 `schema` 再导出）、`stepsOf`；`testing` 入口（只给 `/dev/gallery` 和测试用）：`maxBudgetContent(layout, lang)`、`sampleContent`、`galleryCells()`；`issues` 入口：`slotIssues(content)`（含过长列表遮住的逐条错误）、`widgetIssues`、`describeIssue`（中文：“要点 第 2 条：太长：最多 8 个英文词（约 14 个汉字）”）；渲染入口：`renderSlide(slide, {theme, interactive, badge, pageLabels, onSourceClick, tally, language}) → {el, steps, tally?, dispose}`（`tally.set(counts)` 更新投票分布）、`shuffledOrder`（排序卡片的确定性打乱，起始顺序不泄露答案）、`applyStep`、`fitSlide`、`measureOverflow`、`minBodyFontPx`、`THEMES`、`sourceRuns`（出处页码合并成连续区间，如 p.5–8）、`fitSources(el, avoid)`（碰到 `avoid` 矩形的出处页码从末尾收起成 “+N”，悬停显示收起的页码） |
| `pedagogy` | “内容量合适、流程合理”的可计算规则 | `PAGE_TYPES`（默认分钟、讲 / 练）、`TIME_TOLERANCE = 0.15`、`planBudget(params) → {minutes, minMinutes, maxMinutes}`、`outlineTiming → {totalMinutes, status, needsAck, …}`、`checkOutline`、`checkSlide`、`densityOf`、`scopeAdvice(words, minutes, unreadPages) → {estimatedMinutes, lessons, tooMuch}`（6 分钟 / 千词；有读不进的页时永远不算“合适”）、`planUnit(pieces, minutes, count?)`（不给 count 时每组 ≤ `maxMinutes`）/ `unitGroupMinutes` / `unitGroupLabel`、`OUTLINE_SOURCE_CHARS = 60_000`、`MAX_LECTURE_RUN = 10`；数字核对 `verifyNumbers(content, sourceText, {pageType, notes}) → Unverified[]`（数字可按 10³ / 10⁶ / 百分比换算匹配；≤ 10 的整数忽略；公式的符号必须出现在源文某个含“=”的句子里；算式重算） |
| `ai` | 唯一模型出口：结构化 JSON、修复一次、计量、stub | `createAiLayer({config: {active: {provider, model, visionModel?} \| null, vision?: {provider, model} \| null}, meter, allowStub})`、`ai.callStructured({capability, promptVersion, schema, messages, stub, ctx})`、`ai.callVision`（`visionTarget(config)`：单独的看图提供方优先，否则用启用的模型的看图模型；从不 stub）、`jsonSchemaOf(schema)`（WeakMap 缓存）、`testProvider`、`testVision`（发一张 32×32 的白色 PNG，不发页面）、`sealSecret/openSecret`、`PROVIDER_PRESETS` |
| `generation` | 源文本 + 参数 → 时间预算大纲；大纲 + 规格 → 单页内容；一页的复用键 | `draftOutline(ai, DraftInput) → {outline, warnings}`、`normalizeOutline`（含 `checkSourcePages`、`enforceCheckCadence`）、`rebalanceMinutes`、`writeSlide(ai, outline, specId, WriteInput) → {content, notes, sources, warnings, unverified}`、`slideKey(spec, {level, language})`、`sourceUnverified(spec)`、`workedSpecFor`、`stubOutline` / `stubSlide`、`problemsOf` / `truncateLists` / `clipToBudgets` / `sanitizeWidgets` / `applyGlossary`、`SlideInvalidError`、`PipelineOptions` / `DEFAULT_OPTIONS` / `optionsOf`、`OUTLINE_PROMPT_VERSION`、`SLIDE_PROMPT_VERSION`；`neutralizeSource`（源文本里的 `<` `>` 换成全角，学生教材里的文字关不掉 `<source>`）、`suspiciousContent`（网址、邮箱、可下载文件、像指令的文字） |
| `player` | 放映壳：16:9 缩放、翻页、分步、全屏、黑屏、讲稿；双窗口同步 | `new Player(host, {slides, theme, showNotes, badge, onSourceClick, pageLabels, language, start, onChange, onBlank, onTally, onInk, onEscape})`（按键监听在 document 上，翻页器在任何焦点下都有效；投票人数框是文本输入，焦点在里面时 PageUp/PageDown/方向键照常翻页、不改数值，回车或停顿 1 秒后失焦）、`setBlank`、`setTally(index, counts)`、`setInk("pen"|"eraser"|null)`、`setStrokes(index, strokes)`、`renderThumb`；每次缩放、翻页、开关画笔后用 `fitSources` 让出处页码避开底部控制条（学生链接、投影、离线文件共用）；`InkLayer`（逻辑 1920×1080 坐标的笔画，按页保存）；`presenterSync(lessonId, {onPosition, onBlank, onHello, onTally, onInk}) → {position, blank, tally, ink, close}`（`ink` 发送一页的全部笔画，收到时校验颜色和坐标）、`answerKey(content)`；纯函数 `keyAction` / `nextPosition` / `prevPosition` |
| `apps/app` | HTTP 边界 + 用例编排 + 持久化 | 路由见 §6（复用在 `routes/reuse.ts`；路由之间不互相导入）；`store.ts`（快照、复用、聚合列表、导出、`lessonView`、`lessonsUsing`、`citedPages`、分享视图与 `shareToken`）；`textbook/`（教材模块：`index.ts` 读接口 `ownedTextbook`、`textbookList`、`lookupTextbook(sha256) → none | ready | incomplete{missing} | archived`、`chapterTree`、`pageMeta`（含 `parsers`、`flags`、`kinds`）、`labelsFor(…, {ranges, pages})`（只取需要的页的印刷页码：放映 / 分享 / 学生版只取引用页，课的视图取选区 ∪ 大纲和幻灯片的引用页）、`page`、`pageTexts`、`selectionPages`、`slideSourcePages(cited, ranges)`（生成一页只读它在选区内的引用页；没有引用页时读整个选区供待核实核对；大纲的页码检查 `recheckSources` 需要整个选区的词频，仍读选区）、`scopeStats(…, {sourceBudget})`、`chapterRuns`、`resolveScope`；`write.ts` 写接口 `createTextbook`（同一文件已在 → 409 `DOCUMENT_EXISTS`；每位老师 `MAX_TEXTBOOKS` 30 本 / `MAX_TEXTBOOK_PAGES` 15000 页）、`putPages`（存浏览器给的 `kind`）、`pastePages`（只填 `needsText` 的页；都已有可读文字 → 409 `PAGES_HAVE_TEXT`）、`setTextbookArchived`（恢复时同一文件已有在用的一份 → 409）；`parsers/`：外部解析（`settings.ts` 管理员开关“外部解析服务”（`externalChoice` auto / off；`externalState` → on / off / unconfigured{missing: url}；`missingConfig`；`testExternalConnection` 给“测试连接”）、`PARSE_DAY_PAGES`、`parsedPagesToday`、免费看图模型名单 `FREE_VISION_MODELS` 与纯函数 `parseAllowance`；`mineru.ts` 适配器 `agentParser` / `selfhostParser` / `stubParser`（同一个 `ExternalParser` 接口：submit → upload → poll → result；以后换自部署的机器只改配置），在线接口只跟随 MinerU 自己的上传与结果地址（`isMineruHost`：`mineru.net`、`*.openxlab.org.cn` 的结果地址，以及 MinerU 在阿里云 OSS 的上传桶 `mineru.oss-<region>.aliyuncs.com`；2026-10-13 实测免 Token 接口的签名上传地址就在这个桶上），自部署只请求管理员填的地址；`checkConnection`（不发页面：在线接口查一个不存在的任务，自部署查 `/v1/health` 或 `/health` 再用 Key 查一个不存在的任务）；`maskUrl`（地址只回显协议、主机前几个字和端口）；`jobs.ts` 任务：`createParseJob`（先复用同组织同文件已读好的页，再按额度建任务）、`uploadJobFile`（把浏览器的子 PDF 流式转给签名上传地址）、`pollJob`、`jobResult`（把结果流式转回浏览器：MinerU 不给 CORS）、`saveJobPages`（只写任务里的页，且只覆盖仍是 pdf.js 文字的页）；`vision.ts` 看图模型兜底：`visionParserInfo`（启用的模型配了看图模型，且免费或已允许付费）、`readPageImage`（一页图片 → `ai.callVision` → 存为 `vlm:<模型>/1`；同组织同文件已读过的页直接复制；额度与预算同 `parseAllowance`）；`settings.ts` 另有 `VISION_PRICES`（列表价，微元 / 页）、`visionPriceOf`（管理员填写 > 列表价 > 未知模型按最贵的计））；`tables.ts`）；`ai.ts`（`makeAi`、`visionModelOf`）；`db/accounts.ts`（`orgs`、`users`）；`db/index.ts`（`db(env)`）；`auth/*`（PBKDF2 + 会话 + 登录限速） |
| `apps/web` | 老师界面 | `src/textbook/`（教材摄取：`ingestPdf(file, {hash, lookup, parse, create, putPages, restore, confirmRestore}, onProgress) → {id, outcome: new | ready | resumed | restored}`、`sha256Hex`、`fileProblem`、`documentApi`、`SourcePage`（出处弹窗，生成页和放映页共用，老师粘贴的页会标明）；`apps/web/test/ingest.test.ts`）/ 登录 / 改密 / 后台 / 我的课（单元成组、“复制到新学期”、删除与撤销）/ 五步向导（章节步显示内容量条和每章的“N 页无文字 / 老师粘贴 / 含像指令的文字”标记，内容偏多时可预览并“整单元规划”）/ 槽位编辑器（按版式生成表单：实时字数、中文报错、图示无需 JSON、A/B/C/D 选答案、先投票开关、实验结果、排序 / 配对卡片、实时预览）/ 放映 / 演讲者窗口 / 离线导出（`src/offline/*`：上课用 + 学生版）/ 分享；后台的“最近操作”（审计日志最新 20 条）；`/dev/gallery`、`/dev/render`、`/dev/player` 只在 `vite dev` 和 `KJ_DEV_PAGES=1` 构建里（E2E、评测用），生产包不含 |
| `pptx` | 兼容导出：课件 → 可编辑 .pptx（HTML 课件仍是主格式） | `planSlide(slide, {theme, pageLabels}) → {items, notes, degraded}`（9 个版式 → 原生文本框 / 形状 / 表格 / 图表，逻辑 1920×1080 坐标，56px = 28pt；`fitFont` 按 56→48px 降档）、`exportPptx(deck, {chartImage?}) → {data, filename, degraded, overflow}`、`PPTX_FONT`（PingFang SC，macOS 自带，不嵌入字体）、`texToText`；`scripts/render-check.ts`（LibreOffice headless：自增高探针比对每个文本框的实际高度、PDF 每个词都在页内、导出 PNG） |
| `tools/eval` | 消融评测（不属于产品） | `pnpm eval:run`（manifest 场景 → 流水线 → 每场景 × 次数一个 deck JSON）、`pnpm eval:render`（Chromium 渲染，写回 `slides[].overflow`）；`pnpm eval:run --noise` / `pnpm eval:faults`（注入故障，量每道防线的拦截率与干净数据上的误报率）；`AblationFlags = PipelineOptions + {scope, outline, renderMode, autoConfirm}` |

---

## 4. 数据模型

### 4.1 领域对象

```
User ─┬─ Document（一本 PDF 的文本层）── Page[]（no, text, label?, words）
      │        └─ ChapterNode[]（树：title, level, pageStart, pageEnd, words）
      └─ Lesson（一次备课）
            documentId, title, theme
            scope: { chapterIds[], ranges[{start,end}], unit? }   ← 当前选择；unit = 所属单元（不改表结构）
            params: LessonParams                            ← 当前设置
            └─ OutlineVersion[]（只增不改；confirmedAt 可空；ackOverBudget）
                  outline: { objectives[], slides: SlideSpec[], glossary[], notCovered[] }
                  params, scope                              ← 起草时的快照，生成只看它
            └─ Slide[]（outlineVersionId + specId 唯一；spec_hash 列存 slideKey，用于跨版本复用）
                  layout, pageType, minutes, content（槽位）, notes, sources[], warnings[], unverified[]
                  prevContent / prevNotes                    ← 一步撤销
```

### 4.2 关键类型

```ts
LessonParams = { minutes: 40, level: "basic"|"intermediate"|"advanced", lessonType: "new"|"review"|"lab",
                 language: "en"|"zh"|"en+zh", focus: string }

PageType = "cover"|"retrieval"|"concept"|"process"|"data"|"worked"|"faded"
         | "practice"|"sequence"|"experiment"|"check"|"summary"|"exit"   // 13 种；sequence = 排序配对（3 分钟）

UnitRef = { id, title, index /*第几节，从 1 开始*/, count }

SlideSpec = { id, pageType, layout, title /*断言式*/, purpose, keyPoints[≤6],
              visual: "none"|"chart"|"function"|"flow"|"formula"|"sim"|"table",
              minutes, sourcePages[], loop /*第几个学习环，0=开场/收尾*/,
              sourceIssue?: { kind: "out-of-range"|"mismatch", cited[], suggested[] } /*只由规范化写入*/ }

Unverified = { kind: "number"|"formula"|"calc"|"source", text ≤120, detail ≤200 }   // 待核实，每页 ≤ 10 条

Outline = { objectives[1–3], slides[1–40], glossary[{term, zh}] ≤30, notCovered[string ≤200] ≤20 }

PipelineOptions = { budgetsInPrompt, outlineCheckRetry, slideCheckRetry, truncateFallback, phases: boolean,
                    visualPlanning: "outline"|"writer", writerSource: "pages"|"none"|"all" }   // 默认全开
```

### 4.3 9 个版式与页型映射（预算 = 硬上限：进 JSON Schema、超出截断、渲染测溢出）

预算单位是“词”（1.7 个汉字 = 1 词）。数字是 默认 / 硬上限。

| 版式 | 页型 | 槽位与预算 | 视觉 / 交互 |
|---|---|---|---|
| `title` | cover | 标题 8/10；副标题 8/10；目标 3 条 × 7/8 | 无 |
| `statement` | concept, process | 标题 12/15；要点 3 条 × 7/8（合计 20/24）；术语 2 个；流程图 4/5 步 × 3/4；窄表格 2 列 × 4 行 | 图示：chart / function / flow / formula / table；大纲选“无”时为“图示待补”占位；要点与流程图同步分步揭示 |
| `chart` | data | 标题；结论 2/3 条 × 6/7；出处 6/8；表格 2–3 列 × 4 行，每格 1–2 词 | ECharts（柱 / 折线 / 散点）、函数图像或表格，数据标签只标焦点系列 |
| `steps` | worked, faded | 题目 18/24；步骤 3/4 步 × 5/6（理由 2/3） | 逐步揭示；渐隐页从 `fadeFrom` 起显示空框 |
| `experiment` | experiment | 问题 6/8；选项 3 个 × 2/3；观察 2 条 × 3/4；解释 6/8；`outcome`（实际结果是第几个选项，可空） | 左：预测 + 观察；右：实验 + 解释（POE）；揭示时高亮实际结果，预测选项可录入人数。只有目录里有匹配实验时才规划此页 |
| `quiz` | check | 题干 14/20；选项 4 个 × 5/7；误区 8/10；解释 14/18；`poll` | 点击作答即时反馈；“下一步”揭示答案。`poll`（先投票）：选项不可点，第 1 步显示老师录入的人数分布，第 2 步揭示答案 |
| `questions` | retrieval, practice, exit | 题目 3/4 道 × 8/10；答案 4/6 | 答案逐题揭示 |
| `order` | sequence | 标题 12/15；`mode` order / match；卡片 4/5 张 × 4/6；配对卡 4/5 | 卡片打乱（每张都离开原位），拖动或点两张交换；下一步按 CSS `order` 归位并标绿，翻页器即可揭示 |
| `summary` | summary | 节点 3/4 个 × 3/4；说明 6/8 | 结构图，逐块揭示 |

每页都带 `sources`（教材页码，按印刷页码显示，连续页合并成区间，点击打开原文；放映时会碰到控制条的页码收起成 “+N”）与 `notes`（讲稿：屏幕之外的讲解、提问与常见误区）。屏幕上只留学生要看的；讲多了的内容进讲稿。

**画布与字号**：逻辑画布 1920×1080；标题 72px（降档下限 60px），正文 56px（降档下限 48px，学生要读的文字一律 ≥ 48px），标签 ≥ 40px，出处 28px；左右边距 96px。两套主题（`classic`、`chalk`）只改颜色，预算与主题无关。

### 4.4 D1 表（业务部分）

| 表 | 列（摘要） | 约束 |
|---|---|---|
| `documents` | id, org_id, owner_id, filename, title, size_bytes, page_count, pages_received, has_bookmarks, file_sha256, archived_at, purged_at | `purged_at`（迁移 0014）：彻底删除（只在没有任何课——包括已删除的课——引用它时）：页和章节删掉、`file_sha256` 清空，行保留，让 `parse_usage` 的当天额度照算；读取一律 404。`file_sha256`（迁移 0006）：浏览器算的文件哈希，部分唯一索引 `documents_owner_sha_uq` 保证同一老师未删除的教材里每个文件只有一份；旧数据为空、不去重； 扫描页由服务端按 `pages.words` 判断，不存标志；`archived_at`：软删除（迁移 0005），列表和新建课看不到，已用它做的课仍可读页、改范围、粘贴扫描页文字 |
| `pages` | document_id, no, text, label, words, chars, parser, flags, kind | PK(document_id, no)；`chars` / `parser` / `flags` 来自迁移 0007：`chars` 替代 `LENGTH(text)`（回填），`parser` 是 `pdfjs/1`、`paste`（老师粘贴）、外部解析器 `mineru-agent/1` / `mineru/1`（迁移 0009 起）或看图模型 `vlm:<模型>/1`（迁移 0010 起；界面提示老师核对数字）；都带版本号，作为（文件 sha256，页号，解析器）缓存键的一部分，`flags` 是可疑文字的种类（JSON，0007 之前存的页为 `[]`）。都由服务端 `pageFacts` 算，不信任浏览器。`kind`（迁移 0008，可空）是浏览器探针给的页种类：服务端没有 PDF，只能存下来；它只决定提示和路由（哪些页值得换解析器、哪些页允许粘贴替换），不进提示词。粘贴后 `kind` 不变（是关于 PDF 的事实），`parser` 变为 `paste` 即视为已补 |
| `chapters` | document_id, id, parent_id, ord, level, title, page_start, page_end, words | |
| `lessons` | id, org_id, owner_id, document_id, title, scope, params, theme, drafting_until, archived_at | `drafting_until`：起草锁（§1）；`archived_at`：软删除（迁移 0004），`ownedLesson` 和列表都看不到 |
| `outline_versions` | id, lesson_id, version, outline, params, scope, spec_count, rev, ack_over_budget, confirmed_at | UNIQUE(lesson_id, version)；触发器 `outline_versions_confirmed_no_update` / `_no_delete`；`rev` 乐观锁 |
| `slides` | id, lesson_id, outline_version_id, spec_id, spec_hash（= slideKey）, layout, page_type, minutes, content, notes, sources, warnings, unverified, provider_id, prev_content, prev_notes | UNIQUE(outline_version_id, spec_id)；INDEX(lesson_id, spec_hash)；触发器 `slides_require_confirmed_insert` |
| `share_links` | id, token_hash, lesson_id, version_id, reviewed_at, answers, created_by, revoked_at | 每课最多一条有效链接；token = HMAC(密钥, 链接 id)，库里只存其 sha256；`answers` = `hidden`（课前预习，默认，迁移 0005 之前的链接也按它处理）/ `shown`（课后复习） |
| `ai_providers` | id, org_id, purpose, kind, name, base_url, api_key_sealed, api_key_hint, model, vision_model, enabled | 每个组织每种 `purpose` 最多一个 enabled（启用一个会停用同一种的其他）。`purpose`（迁移 0012）：`text` 写大纲和幻灯片（`model`，可带同一提供方的 `vision_model`）；`vision` 是单独的看图提供方，用它自己的 Key，只读页面图片（`model` 就是看图模型），例如文字用 DeepSeek、看图用智谱 GLM-4.6V-Flash 或百炼 qwen-vl-ocr。读图时单独的看图提供方优先（`visionModelOf`）；`/me` 的 `ai` 模式只看 `text` |
| `parser_settings` | org_id, external_choice, mineru_mode, selfhost_url_sealed, selfhost_url_hint, selfhost_key_sealed, selfhost_key_hint, paid_enabled, updated_at, updated_by | 迁移 0009 / 0010 / 0011 / 0015 / 0016。管理员开关“外部解析服务”`external_choice`（迁移 0011 替换 `external_enabled`；迁移 0016 把和 `auto` 行为一样的 `on` 并入 `auto`）：`auto`（默认，没有这一行也是它）= 选中的接口配置好就开启，`off` = 任何页都不离开浏览器。`mineru_mode`：`agent`（MinerU 免 Token 轻量接口，每份 ≤ 20 页 / 10 MB，即 10 页内容 + 10 页分隔页；不需要配置，所以默认就开启）或 `selfhost`（MinerU 4+ 自部署，`/v1` 接口：地址必填、API Key 可选，都加密存，地址也当机密只回显掩码；没有地址 = 未配置）。精准接口（`token`，从没在真机上验证过）和自部署的 MinerU 3.x `/tasks` 方言按设计评审 O1 删掉了：迁移 0015 把选了 `token` 的组织改回 `agent` 并删掉 Token 列。环境变量 `PARSER_MINERU_MODE` 是新组织的默认接口，`stub` 只给测试和 E2E（回放录制的 MinerU 返回，生产环境拒绝），只替换在线接口：自部署始终请求管理员填的地址（E2E 用本机 mock 服务）。“允许付费兜底”`paid_enabled`（迁移 0010，默认关）：关着时只用免费看图模型（`FREE_VISION_MODELS`，目前 `glm-4.6v-flash`），其他看图模型一律当作可能收费、不用；开了就用管理员选的看图模型，花费由模型服务商的账户管。每月预算和每页价格按设计评审 O2 删掉了（迁移 0016） |
| `parse_usage` | id, org_id, user_id, document_id, parser, reason, pages, page_count, state, task_id, upload_url, result_url, error, day | 迁移 0009（花费列迁移 0016 删掉）。每份发出去的子 PDF、或每张发给看图模型的页面图片一行：任务状态（submitted → uploaded → parsed → done / failed）和额度计数。`reason`：`auto`（必修页，不问老师）或 `refine`（老师点“精修本章”）。额度只有一条：每位老师每天 `PARSE_DAY_PAGES` 300 页（外部解析和看图模型合计，自部署也算；429 `PARSE_QUOTA`，`detail.remaining`）。可能收费的看图模型要先开“允许付费兜底”（否则 402 `PARSE_BUDGET`）；MinerU 两种接口都不收费。`day` 按北京时间。`upload_url` 是签名地址，不发给浏览器。从同一文件的副本复用的页不发出、不计数 |

---

## 5. 流水线

```
⓪ 查重（浏览器）    文件 sha256（crypto.subtle）→ lookup：ready 直接进章节步；incomplete 只传 missing 页；
                    archived 问老师“恢复 / 重新上传”；none 才往下走（同一老师同一文件只解析、只存一次）
① 解析（浏览器）    pdf.js → {title, pageCount, toc[], pages[{no, text, label?, kind}]}；同一循环里的探针定每页 kind
                    不再整本拒收扫描版：每页照常上传，服务端按页判断（< 5 词 = 没有文字）
② 建树（两端同码）  buildChapterTree → ChapterNode[]；无书签 → 空树，界面改为输入页码
③ 圈选             勾选章节或按书上印的页码输入（pageForLabel）；显示首尾页第一行供核对；
                    scopeAdvice：按字数估计所需分钟，超过课时 1.2 倍提示“约需 N 节课，建议拆分”
                    有扫描页的章节标“N 页无文字”；所选页里的扫描页单独提示，可按页段粘贴文字
                    （POST /documents/:id/pages/paste，只填没有文字的页和必修页）；全是扫描页时不能起草
                    整本书有必修页（公式没读出 / 扫描 / 乱码）时顶部显示“这本书有 N 页可能没读全”及各类页数；
                    章节标“N 页公式没读出”等；所选页里有文字但读不全的页单独提示，可粘贴完整文字替换
                    “外部解析服务”开启时（默认：管理员选的接口配置好就开启；免 Token 轻量接口不需要配置）：刚在本标签页上传的书，必修页（每本最多 300 页）自动送去重新识别——
                    浏览器用 pdf-lib 切出这几页（每页前一页“KJPAGE i”）→ PUT /documents/:id/parse/:job/file（Worker 流式转给 MinerU；自部署：POST /v1/tasks 原始字节，上传即建任务）
                    → 轮询 → GET …/result（Worker 流式转回 Markdown）→ 按分隔页拆回各页 → POST …/pages；
                    刷新后浏览器没有文件：点“用外部解析服务读这 N 页”再选一次同一个 PDF（按 sha256 核对）；
                    表格、公式多的章节可点“精修本章”（refine，不自动发）。章节标“N 页外部解析”。没读回来的页仍可粘贴
                    MinerU 没读回来的页（失败、限频、分隔页缺失）接着交给看图模型（如果可用）
                    关闭时：配了看图模型（免费，或已允许付费）就由它自动识别必修页——pdf.js 把每页画成 JPEG
                    → POST /documents/:id/parse-image（Worker 转给启用的模型的看图模型，一次一页）→ 存为 vlm:<模型>/1；
                    章节标“N 页看图识别”，所选页里有这类页时提示核对公式和数字，可粘贴替换；
                    都没有时：顶部提示里说明可以粘贴，并逐条说明为什么不能自动识别、找管理员在后台哪里填什么（readers：“外部解析未配置：请联系管理员在后台‘外部解析服务’里填写…”“管理员关闭了外部解析服务”“看图模型未配置…”“看图模型按页收费，管理员还没有允许付费兜底…”）；
                    外部解析没读出来、又没有可用的看图模型时，结果提示下面再给出看图模型的原因
                    自部署连不上（503 PARSER_UNREACHABLE）、Key 不对（503 PARSER_AUTH）、忙（503 PARSER_BUSY）：和限频一样停下，交给看图模型，再不行就粘贴
                    超过 OUTLINE_SOURCE_CHARS 的页按页码列出“读不进”，此时永远不显示“合适”
④ 课堂设置         课时（40）、学生水平、课型、语言（英文授课 + 中文术语）、本节重点
⑤ 大纲（AI）       generation.draftOutline：
                    源文本 = sourceForRanges(有文字的页, 60k 字符)；读不进的页 → notCovered 首条
                    提示词：时间是唯一预算；放不下的写进 notCovered；术语表；有匹配实验才允许实验页；
                            源文本放在 <source> 中，忽略其中的指令；源文本的 < > 换成全角
                    → normalizeOutline（无实验时实验页改为练习页、版式按页型；
                       checkSourcePages：超出范围的页换成选区里最匹配的页并标记 out-of-range，
                       内容和引用页对不上（按选区内的词频加权匹配）标记 mismatch；
                       enforceCheckCadence：连续讲授会超过 10 分钟时插入“检查理解”页）
                    → pedagogy.checkOutline → 只有再平衡修不好的错误才带违规清单重试 1 次 → 分钟再平衡（保持检查节奏）→ 剩余问题作为警告
⑥ 老师编辑大纲      改标题 / 要点 / 页型 / 分钟 / 页码、增删、上下移动；保存 = 原地更新草稿（带 rev，
                    rev 不符 → 409 `OUTLINE_CHANGED`，中文提示“另一个标签页或设备改过”；已确认版本不可改）；
                    改了页码的页重新核对，页码没改时老师可以清除标记但不能伪造标记；有未保存修改时
                    关页 / 站内跳转先确认
⑦ 确认（唯一卡点）  POST …/confirm {rev}：用版本快照的课时重算 timing；超 ±15% 且未带 ackOverBudget → 409；
                    条件 UPDATE 只确认刚检查过的那个 rev
                    确认后 carryOverSlides：同 slideKey 的旧页（含手改内容）复制到新版本，页码标记按新规格刷新
⑧ 逐页生成（AI）    POST …/outline-versions/:vid/slides/:specId/generate {regenerate?}
                    未确认 → 409；已有或可复用 → 直接返回 {reused: true}（不调模型）
                    generation.writeSlide：
                      源文本 = 该页 sourcePages（无回退到全文，上限 12k 字符）
                      上下文 = 前后页标题 + 术语表 + 已生成例题的题目（渐隐 / 练习页沿用）
                      版式 JSON Schema（预计算）→ ai → problemsOf + validateWidget + verifyNumbers（数字 / 算式）
                      → 带问题清单重试 1 次 → 截断列表 + clipToBudgets（逐词裁短超长槽位，先去掉路径式链接）
                      → sanitizeWidgets（仍画不出来的图示 → 图示待补）→ 槽位 schema 仍不通过 → 换确定性兜底页
                      → 还不通过 → 不保存，502 `SLIDE_INVALID`（stub 每种页型在五本评测教材上都有测试保证可直接 PATCH）
                      术语按术语表统一；实验页固定使用目录中的实验
                      unverified = 规格的页码标记 + verifyNumbers 结果，存进 slides.unverified
                      suspiciousContent：网址 / 邮箱 / 文件 / 像指令的文字进 warnings
                    重新生成时旧内容存入 prev_*，可撤销
⑨ 编辑             PATCH /slides/:id {content?, notes?}：按版式槽位 schema（含硬预算）和图示校验，否则 422
                    （detail 为逐条 {path, message}，message 是中文；过长列表同时报条数和逐条字数）；
                    编辑器在保存前用同一份 schema 实时提示；保存与撤销后重新核对数字
                    POST /slides/:id/undo：当前与上一版互换，没有上一版 → 409
⑩ 渲染与放映（浏览器）renderSlide → fitSlide（56→48px 降档）→ measureOverflow；
                    放映键：→/↓/PageDown/空格/回车/n 下一步，←/↑/PageUp/Backspace/p 上一步，
                    Home，End（最后一页第 0 步），F/F5 全屏，B/. 黑屏，S 讲稿（观众窗口与离线文件不响应），D 画笔，
                    Esc 收起画笔；画笔没开时 Esc 退出放映回到第 5 步
                    演讲者窗口：计时（暂停 / 重置、超前落后）、下一页缩略图、讲稿、答案（含实验结果、正确顺序 / 配对）；
                    与观众窗口双向同步翻页、黑屏、投票人数和笔画
                    画笔：canvas 盖在页面上，笔画按页存在内存（换页再回来还在，刷新即清空）；画笔开着时点击不翻页
⑪ 离线导出（浏览器）GET deck?audience=teacher|student → 内联 runtime.js / runtime.css、内置实验 HTML（srcdoc）、
                    与课件字符相交的 Noto Sans SC / Arimo unicode-range 字体块和（有公式时）KaTeX 字体 → 一个 .html
                    上课用：讲稿和答案只在“演讲者窗口 Notes”按钮弹出的窗口里；学生版：服务端剥离，文件名带“（学生版）”
                    文件名去掉 . / 等字符（“4.1 Force”不再被当成扩展名）
⑫ PPTX 导出（浏览器，次要格式）GET deck → pptx.exportPptx：每页一张 16:9 幻灯片，槽位 = 原生文本框（PingFang SC）；
                    图表 → 原生图表（类别数据、共享 x 的散点、函数在滑块初始值下的曲线；其余用 ECharts 截图），表格 → 原生表格；
                    逐步揭示变成一次全显示；答案、解释、误区、正确顺序 / 配对、实验结果 → 讲稿；
                    互动（实验、先投票、排序 / 配对、POE、滑块）→ 静态版 + 讲稿里写明课堂上怎么做
```

**卡点的最小正确设计**

- `outline_versions` 只增不改；触发器在 `confirmed_at IS NOT NULL` 时拒绝 UPDATE / DELETE。确认 = 把 `confirmed_at` 从 NULL 设为时间。
- `slides` 插入触发器要求所属版本已确认，因此任何路径都无法给草稿生成页面。
- 生成与导出接口用 `confirmedOutline(version)` 读取大纲，未确认 → 409 `OUTLINE_NOT_CONFIRMED`。卡点就是“触发器 + 409”，没有额外的类型层。
- 确认后再改大纲不是竞态：旧版本仍可生成它自己的页面；新版本需重新确认，确认时复用未变的页。

**分享**

- `POST /share`：已有有效链接时返回同一个 URL；`versionId` 把链接移到另一个已确认版本；默认选“页面齐全的最新已确认版本”。
- 每次分享都是一次检查：学生可见文字里有网址、邮箱、可下载文件或像指令的文字 → 409 `SHARE_REVIEW_REQUIRED`（列出页码），老师带 `ack` 重试。分享之后才生成或改过、并且被标记的页，学生端暂不显示（`reviewed_at`），老师再分享一次即放出。
- 学生 JSON 去掉讲稿、检查提示和测验误区标签；链接所属账号停用后 404；取消分享或删除这节课立即失效，再分享得到新 URL。
- 答案模式（老师在分享面板里选，链接和学生版离线文件共用）：**课前预习（无答案）** 是默认，`@kj/templates` 的 `withoutAnswers` 在服务端去掉选择题的 `answer`（变 -1）和解析、实验的 `outcome` 和解释、问答题的答案、渐隐例题被隐去的步骤；排序 / 配对卡片按随机循环置换重新发牌（列表顺序本身就是答案，带种子的打乱可以被反推）。渲染器 `hideAnswers` 在这些位置显示“答案课后公布”，不标正确项。**课后复习（含答案）** 保留答案，学生可逐步揭示。`PATCH /share {answers}` 切换模式，不移动版本、不算一次检查；老师端 deck 永远含答案。

**复用**

- `POST /lessons/:id/duplicate`：新课复制最新已确认版本（大纲、参数与范围快照、确认时间）和它的全部页面（新 id，`spec_hash` 不变，`prev_*` 清空，所以没有可撤销的上一步），有更新的草稿时也复制；所有复制的版本 `rev` = 0；分享链接、起草锁和单元归属都不复制。之后“修改大纲”→ 确认时由 `carryOverSlides` 按 `slideKey` 复用，只有改过的页需要模型。
- `POST /lessons/unit`：把所选范围按叶子章节（父章节在第一个子章节之前的引言页归父章节）切成片，`pedagogy.planUnit(pieces, 课时, count?)` 按字数均分成 N 节（单片超过目标 1.25 倍或超过 115% 课时时在页边界切开，标题加“(1)”“(2)”；不给 count 时从估算节数起逐个加一，直到每节 ≤ 115% 课时），`?dryRun=1` 只返回预览 `{lessons[{title, ranges, estimatedMinutes, over}], maxMinutes}` 不写库；建课时每节课一个新 lesson，课名 = 单元名 · 节号范围，`scope.unit` 记下单元；向导里那节还没有大纲的课作为第 1 节复用。只够一节课 → 400 `UNIT_TOO_SMALL`；要复用的课已有大纲或正在起草 → 409 `LESSON_IN_USE`。

**提示词版本**：`outline.draft@6`（排序配对页规则）、`slide.write@7`（先投票、排序 / 配对、实验结果）。

**免费版约束**：我的课列表是一条带相关子查询的 SQL；页面上传每批 40 页（每页一条 upsert，留出鉴权等查询余量）；复用插入每批 5 行（D1 每条语句 ≤ 100 个绑定参数）；JSON Schema 预计算并缓存。

---

## 6. HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST / GET | `/api/auth/login` · `/logout` · `/change-password` · `/me` | 白名单登录（PBKDF2），首次登录强制改密 |
| * | `/api/admin/users…` · `/api/admin/ai…` · GET / PUT `/api/admin/parsing` · GET `/api/admin/status` · GET `/api/admin/audit` | 管理员：`status` 是后台“概览”页（第一个、默认的标签）：`counts`（在用账号、教材、课、今天外部解析页数）加“配置状态”：AI 模型（live / stub / off，提供方名和模型名）、看图模型（on / paid_off / none，是否单独的看图提供方）、外部解析服务（on / off / unconfigured{missing}、接口、是否 stub），只有名称和模型名，没有 Key 和地址；账号、AI 模型（提供方 + 模型名 + 可选的看图模型，启用一个即停用其他；可另加一个 `purpose: vision` 的单独看图提供方，用它自己的 Key；每个提供方可选接口协议 `openai | messages`、`maxTokens`、自定义请求头（加密，GET 只回名称和两个字的提示）；测试连接：`POST /api/admin/ai/providers/:id/test`，文字模型发一句 JSON 提示，`{vision: true}` 或看图提供方发一张小图，返回 `{ok, message, kind?, latencyMs}`：成功（延迟 + 回复开头）/ Key 不对 / 模型名不对 / 连不上 / 空回复 / 其他 HTTP 错误，全是中文；GET 只回显 Key 的掩码）；外部解析服务开关（开 = 配置好就用 / 关）、接口（免 Token / 自部署）、自部署地址和 Key（加密存储，只回显掩码；未配置时显示“未配置”和该填什么）与今天的用量；POST `/api/admin/parsing/test` 测试连接（不发页面）；看图模型是否免费、“允许付费兜底”（审计 `admin.parser_settings`，target `external_auto/off`、`mode_agent/selfhost`、`paid_on/off`、`selfhost` 或 `settings`）；最近 20 条审计记录 |
| GET / POST | `/api/documents` | 列表；`{filename, title, sizeBytes, pageCount, chapters, sha256?}` 新建 → `{id, pageBatch: 40}`；同一文件已在 → 409 `DOCUMENT_EXISTS`（`detail.id`），超过每人 30 本 / 15000 页 → 409 `TEXTBOOK_QUOTA` |
| POST | `/api/documents/lookup` | `{sha256}` → `{status: none \| ready \| incomplete \| archived, document?, missing?, pageBatch}`（只查自己的） |
| POST | `/api/documents/:id/pages` | `{pages:[{no, text, label?}]}` |
| POST · PUT · GET · GET · POST | `/api/documents/:id/parse` · `…/parse/:job/file` · `…/parse/:job` · `…/parse/:job/result` · `…/parse/:job/pages` | 外部解析（开关关闭 → 403 `PARSER_OFF`；选中的接口缺地址 → 403 `PARSER_NOT_CONFIGURED`，中文提示请管理员在后台填写）：`{pages ≤ 每份上限, reason: auto\|refine, ocr}` → `{reused, job, parser}`（不该重读的页 409 `PAGES_NOT_ELIGIBLE`；额度 429 / 402）；上传子 PDF（超过上限 413）；轮询 `running\|ready\|done\|failed`；取结果；存回各页文字（任务外的页 400）。MinerU 限频 → 503 `PARSER_BUSY`；自部署连不上 → 503 `PARSER_UNREACHABLE`，Key 不对 → 503 `PARSER_AUTH` |
| POST | `/api/documents/:id/parse-image` | 看图模型兜底：`{no, image: data:image/jpeg;base64,…, reason}` → `{page, reused}`。没有看图模型 → 403 `VISION_OFF`；不该重读的页 409；额度 429、付费关闭 / 预算 402；模型限频 → 503 `PARSER_BUSY`，其他失败 502 `VISION_FAILED`（失败也记一行用量）。只检查图片前缀（扫描整段 base64 太费 CPU），上限 4 MB |
| POST | `/api/documents/:id/pages/paste` | `{start, end, text}` → 文字分到范围内没有文字的页和必修页（含看图模型读的页）（`needsText`；可读的文字页、精修类页和已粘贴的页不动，都不需要时 409 `PAGES_HAVE_TEXT`；一次最多 40 页） |
| GET | `/api/documents/:id` · `/api/documents/:id/pages/:no` | 章节树、`pageLabels`、`pageWords`、`pageChars`、`pageParsers`（只列不是 `pdfjs/1` 的页）、`pageFlags`（只列有可疑文字的页）、`pageKinds`（只列不是 text / blank 的页）、`externalParser`（开关打开时：解析器 id、每份页数与字节上限、结果格式；关闭时 null）、`visionParser`（可用时：解析器 id、看图模型名；没有、或模型可能收费而付费未开启时 null）、`readers: {external, vision}`（不可用时给老师看的中文原因，说明找管理员在后台哪里填什么：`externalNote` / `visionNote`；可用时 null；不含任何密钥或地址）；某页原文、印刷页码与 `parser`（已删除的教材也可读，供已有的课使用） |
| DELETE / POST | `/api/documents/:id`（= POST `/:id/archive`）· `/api/documents/:id/restore` | 归档（软删除）→ `{ok, lessons}`（仍在用它的课数）；恢复（同一文件已有在用的一份 → 409 `DOCUMENT_EXISTS`）。都写审计日志 |
| GET / PATCH / DELETE | `/api/documents/library` · `/api/documents/:id` · `/api/documents/:id/permanent` | 教材管理：老师自己的全部教材（含已归档，不含彻底删除的）：页数、已收到页数、还没读好的页数（几乎没字且不是空白页，或必修页仍是 pdf.js 文字）、用它做的课数（`lessons` 在用 / `lessonsAll` 含已删除）；改名（审计 `document.renamed`）；彻底删除：有课引用 → 409 `IN_USE`，否则清掉页和章节（审计 `document.purged`）。“查看页面 / 备课”打开 `/new/:id`（原有的选章节页，可重读没读好的页）；上传页的“或使用之前上传的教材”直接选已有教材，不再上传 |
| GET | `/api/auth/me` | `{user, ai}`：`ai` = `live` / `stub` / `off`，界面据此显示演示模式横幅 |
| GET / POST | `/api/lessons` | 列表（单条聚合 SQL）；`{documentId, chapterIds, ranges}` 新建 |
| DELETE / POST | `/api/lessons/:id` · `/api/lessons/:id/restore` | 软删除（撤销分享链接、清起草锁、记审计）；恢复（链接不恢复） |
| GET / PATCH | `/api/lessons/:id` | `{lesson{…, scopeWords, emptyPages, unreadPages}, draft, confirmed, slides（已确认版本的）, pageLabels, share, drafting}`（版本含快照）；更新 scope / params / theme / title |
| POST | `/api/lessons/:id/outline` | 起草 → 新的未确认版本；全是扫描页 → 422 `NO_SOURCE_TEXT`；正在起草 → 409 `DRAFT_IN_PROGRESS` |
| PUT | `/api/lessons/:id/outline-versions/:vid` | `{outline, rev}` 保存老师编辑；已确认 → 409 `OUTLINE_VERSION_IMMUTABLE`；rev 过期 → 409 `OUTLINE_CHANGED` |
| POST | `/api/lessons/:id/outline-versions/:vid/confirm` | `{ackOverBudget?, rev?}`；超预算未确认 → 409 `OVER_BUDGET_ACK_REQUIRED`；返回复用后的页面 |
| POST | `/api/lessons/:id/outline-versions/:vid/revise` | 以已确认版本为底稿新建草稿（复制它的参数与范围快照） |
| POST | `/api/lessons/:id/outline-versions/:vid/slides/:specId/generate` | `{regenerate?}` → `{slide, reused}`；兜底页也过不了槽位 schema → 502 `SLIDE_INVALID` |
| PATCH | `/api/lessons/:id/slides/:slideId` | `{content?, notes?}`；槽位或图示校验失败 → 422 `INVALID_CONTENT`（`detail: [{path, message}]`，message 为中文）；返回重新核对后的 `unverified` |
| POST | `/api/lessons/:id/slides/:slideId/undo` | 一步撤销；无可撤销 → 409 `NOTHING_TO_UNDO` |
| GET | `/api/lessons/:id/deck` | 导出 deck JSON（版本快照的参数与范围，含讲稿与待核实；离线导出也用它）；`?audience=student` 与分享链接同样剥离讲稿和误区标签，并且默认剥离答案（`&answers=shown` 保留）；`lesson.answers` 标明模式 |
| POST | `/api/lessons/:id/duplicate` | `{title?}` → 201 新课的 lesson 视图（默认标题加“（新学期）”；见 §5“复用”） |
| POST | `/api/lessons/unit` | `{documentId, chapterIds, ranges, title?, params?, count?, lessonId?}` → 201 `{unit, lessons[{id, title, ranges, estimatedMinutes}]}`；`?dryRun=1` → 200 预览，不建课 |
| POST / PATCH / DELETE | `/api/lessons/:id/share` | POST `{versionId?, ack?, answers?}` → `{path, versionId, version, held, answers}`（见 §5“分享”）；PATCH `{answers}` 只切换答案模式；DELETE 取消分享。GET `/api/share/:token` 返回冻结版本的学生版课件（按链接的答案模式） |

---

## 7. 测试策略（每个 PR 必须全绿，全部离线、无密钥）

| 层 | 内容 | 工具 |
|---|---|---|
| 单元 | schema 默认值与上限；textbook 建树 / 范围 / 印刷页码；pedagogy 预算 / 时长 / 密度 / 估时；widgets 表达式安全、校验、整词匹配；templates 预算样本合法；generation：stub 预算、开关、实验门槛、notCovered、术语表、无全文回退、12k 上限、渐隐修复、重试 → 截断、源文本转义与可疑内容、编造数字重试、图示兜底、页码标记、检查节奏、slideKey；pedagogy 数字核对；templates 中文槽位报错；ai 层修复、回退、Schema 缓存、请求级总截止时间；templates 出处页码区间；player 出处标签（区间、印刷页码）；templates `withoutAnswers` 去掉每种版式的答案、排序 / 配对重新发牌；渲染器“答案课后公布”占位；player 导航、演讲者同步（含投票人数）、表达式坏掉不抛错、最后一步无隐藏元素、排序卡片打乱 / 交换 / 揭示、配对、投票输入与 PageDown、实验结果、画笔不翻页与橡皮命中、笔画转发与校验、投票框方向键翻页不改数值、End 到第 0 步、Esc 退出、标签按授课语言；pedagogy 单元拆分（每组 ≤ 115%、节号范围课名）；generation 预算守卫（五本评测教材 × 每种页型的 stub 输出都能直接 PATCH，网址不计字数，`clipToBudgets`）；textbook CID 字体中文抽取与隐藏文字、`missingRanges`、`pageFacts`、`classifyPage` 各阈值与顺序、`routePages`、`needsText`、`splitSeparated` / `cleanParsedMarkdown` / `cleanVisionText`；ai 层看图调用（发给看图模型、GLM 去掉 data URL 前缀并关闭 thinking、从不 stub、单独的看图提供方优先且没有文字模型时也能用、`testVision` 发一张小图且不用 JSON 模式）；web 看图兜底（一次一页、单页失败跳过、402/403/429/503 即停、画不出的页算没读）；web 外部解析（OCR 分组、每份页数、建不了任务的那一份记为没读出并保留原因、超过字节上限对半拆、分隔页缺失的页不存、额度用完即停、zip 结果、pdf-lib 切页）、解析循环里的探针（pdf-lib 合成的扫描 / 空白 / 成排公式 / 行内公式空洞 / 公式文字 / 表格页，以及三本样例 PDF 的页种类）；web 教材摄取（新文件、已有、续传只传缺页、恢复 / 不恢复、批次失败即停）；tools/eval 开关解析 | Vitest |
| 卡点 / API | 未确认生成 → 409；超预算未确认 → 409，带 ack → 成功；触发器拒绝改已确认版本与给草稿插页；跨版本复用与幂等生成；改“本节重点”标点后修订或重新起草，所有页（含手改页）都保留；PATCH 校验（含坏图示、过长列表的逐条错误）与撤销；待核实；页码标记；快照；鉴权与 CSRF；扫描页 / 粘贴 / 不能凭空起草；60k 读不进的页；起草锁；rev 冲突；分享（同一 URL、冻结版本、移动、取消、去误区、停用账号、检查与暂扣）；单一 AI 模型配置；PBKDF2 换代；复制到新学期（他人不可复制、手改保留、`rev` 0、不带分享、修订只调 1 次模型、只有草稿时复制草稿）；单元规划（章节不拆、复用向导里的空课、PATCH 保留单元、400 / 409、dryRun 不建课、课名无“第 N/M 课”）；学生版 deck 无讲稿；删除课（他人不可删、链接立即失效、列表隐藏、恢复后链接仍失效）；审计日志只给管理员；学生答案模式（链接和学生版 deck 默认无答案、PATCH 切换不动版本、他人 404）；删除教材（列表隐藏、不能新建课和上传页、已有的课照常、恢复）；教材文件哈希（lookup none → incomplete 缺页 → ready、他人查不到、重复新建 409 带原 id、他人可传同一文件、无哈希不去重、删除后查到 archived、有新副本时恢复 409、配额 409 与删除后腾出名额）；页事实（上传存 `chars` 与可疑文字 `flags`，粘贴后 `parser = paste`）；页种类（存 `kind`、非法种类 400、`pageKinds`；粘贴只替换必修页的 pdf.js 文字，文字页与精修类页 409，粘贴后再粘贴 409、`kind` 保留）；外部解析（默认跟随配置：免 Token 接口即开启，关闭后 403 `PARSER_OFF`、老师不能开、开启后 stub 全流程按页存回 `mineru-agent/1`、读好的页不能再粘贴或再发、任务不能重放、他人 404、只写任务里的页、精修页只在 refine 时发、同组织同文件复用不发不计数、每本书 / 每人每天 / 全站每天额度 429、付费封顶 402、关闭后进行中的任务也停、审计；看图模型（没有看图模型 403 且不发请求、未知或付费模型在“允许付费兜底”关闭时 402、开启后即可用；免费名单里的模型不用开、限频 503 与空结果 502 记为失败、只读必修页、非图片 400、同文件复用、老师粘贴后不再发；单独的看图提供方：文字用 DeepSeek、看图用 GLM 各用各的 Key，GET 不含 Key，测试连接发小图，再加文字模型不停用看图提供方）；配置状态与提醒（`/api/admin/status` 各状态、老师不能读、教材 GET 的 `readers` 对每种缺失给出中文原因；配好所有 Key、Token、自部署地址和 Key 后，管理员和老师的每个 GET 响应里都找不到它们，只有掩码）；适配器回放录制的 MinerU 返回：请求形状、上传不带 Content-Type、非 MinerU 地址拒绝、限频 503、token 接口）；MinerU 自部署（fetch mock 的学校服务器：4.x `/v1` 原始字节上传、3.x `/tasks` multipart、Bearer Key、401 → `PARSER_AUTH`、连不上 → `PARSER_UNREACHABLE`、忙 → `PARSER_BUSY`；没填地址 403 `PARSER_NOT_CONFIGURED` 且不发请求；填好后自动开启、GET 只有掩码不含地址和 Key、测试连接、全流程存 `mineru-selfhost/1`、不计全站额度、审计、错的 Key 测试连接报错）；窄读（学生版 deck 和分享 JSON 的 `pageLabels` 只含引用页，课的视图只含选区；生成只读选区内的引用页，没有引用页时读整个选区）；`/me` 的 `ai` 模式 | `@cloudflare/vitest-pool-workers`（本地 D1） |
| 溢出 | 9 个版式 × {示例, 英文满预算, 中文满预算} + 表格 / 流程图 / 图示待补 / 配对 / 先投票变体（38 格）：`measureOverflow` 为空、正文 ≥ 48px、最后一步没有隐藏元素；出处页码多的页（`/dev/player`：12 个出处的先投票题、印刷页码区间、图表）在 1024×576、1280×720、1920×1080、1280×1000 下没有可见页码碰到控制条，“+N” 与收起数一致 | Playwright `overflow`（`/dev/gallery`、`/dev/player`，CI 装 `fonts-noto-cjk`） |
| E2E | 登录 → 改密 → 演示模式横幅 → 上传 `waves-mini.pdf` → 选章节（内容量条）→ 设置 → 大纲（时间条）→ 把一页改成排序配对 → 超预算确认被拒 → “仍然确认” → 自动开始生成 → 编辑标题 → 撤销 → 待核实 → 编辑器（字数、中文报错、重新添加术语、流程图、A/B/C/D）→ 检查页设为先投票 → 排序页 → 表格页 → 放映（End 到最后一页第 0 步、无页型标签）与演讲者窗口双向同步（答案只在演讲者窗口；演讲者窗口录入人数，投影上显示分布再揭示答案；在演讲者窗口画的笔画出现在投影上，清除也同步；刷新演讲者窗口计时不归零）→ 排序页点两张卡交换、翻页器揭示 → 画笔画线、清除、Esc 后照常翻页，再按 Esc 回到第 5 步 → 学生分享页和学生版离线文件的出处页码不碰控制条 → 学生版离线文件不含任何讲稿、默认不含选择题解析 → 离线文件在断网的上下文里打开（无网络请求、字体加载、实验画布、排序页）→ 复制到新学期 → 单元规划（先 dryRun）成组显示 → 删除一节课、撤销 → 内容过少时“仍然继续” → 删除教材、已有的课照常、撤销 → 同一 PDF 再传一次：进同一份教材、显示“没有重新解析”、不发新建和上传页请求；删除后再传：确认后恢复原来那份 → 分享（默认课前预习：学生无讲稿、无答案、显示“答案课后公布”；切到课后复习同一链接含答案）→ 新草稿不挡放映 → 取消分享；中文 CID 字体 PDF（`newton-zh-cid.pdf`）抽出中文 → 顶部“扫描 2 页” → 扫描章节标记 → 粘贴文字 → 章节标“N 页老师粘贴”、该页 `parser = paste` → 起草 → 两个标签页保存冲突 → 未保存离开提示（站内链接、浏览器后退键、关标签页）→ 分钟输入失焦才 clamp；公式画成图形的 PDF（`kinematics-outlines.pdf`）→ 顶部“公式没读出 1 页”、该节标“1 页公式没读出” → 选中后提示 → 粘贴替换 → 提示和标记消失、标“1 页老师粘贴”、该页 `parser = paste`（外部解析服务关闭：提示里说明可粘贴、“管理员关闭了外部解析服务”“看图模型未配置…”、没有自动发送）；外部解析服务开启（stub MinerU）：后台打开开关 → 刷新后点“用外部解析服务读这 1 页”，选错文件被拒、选对后读好 1 页、标“1 页外部解析” → 新上传的书必修页自动发送，该页 `parser = mineru-agent/1`、文字含公式 LaTeX → 后台关闭；看图模型兜底（本机 mock 的 OpenAI 兼容接口）：后台添加带看图模型的模型 → 不在免费名单、付费未开启，不可用，新书不自动发 → 勾选“允许付费兜底” → 新上传的书必修页自动识别（请求里是 JPEG data URL）、标“1 页看图识别”、该页 `parser = vlm:mock-vl/1` → 选中后提示核对 → 粘贴替换为 `paste` → 删除模型；单独的看图模型（本机 mock）：没有文字模型时“AI 模型”页显示“还没有看图模型” → 在“单独的看图模型”里填 Custom + 看图模型 + Key → “现在读图用：…（单独的看图模型）”、只显示 Key 掩码 → 测试连接发一张 PNG、带这个 Key → 勾选“允许付费兜底” → 新上传的书必修页由它识别（带这个 Key）、该页 `parser = vlm:<模型>/1`，大纲仍是演示模式；MinerU 自部署（本机 mock 的 MinerU 4 服务）：选“自部署”→ 显示“未配置”，顶部“配置状态”里外部解析服务写“还没有填服务地址”→ 老师上传的书顶部提示“外部解析未配置：请联系管理员在后台…填写自部署 MinerU 的地址”和“看图模型未配置…”，可以粘贴，没有发出任何请求 → 填地址和错的 Key → 已开启、测试连接报 Key 错 → 换对的 Key → 测试连接“已连上自部署 MinerU 4.0.12”，接口返回里没有地址和 Key → 新上传的书必修页送到学校服务器（Bearer Key、`ocr_mode=auto`）、该页 `parser = mineru-selfhost/1` | Playwright `e2e` + stub 模型；`SHOTS_DIR` 时每步截图 |
| 依赖边界 | dependency-cruiser + AI 出口检查 | `pnpm lint` |

真模型质量评测（消融计划，见资料库 `docs/design/ablation-plan.md`）用 `tools/eval` 手动运行，不进 CI。

---

## 8. 推迟与恢复条件

| 推迟项 | 恢复条件 |
|---|---|
| 更多内置实验 | 下一迭代 |
| 教材插图（R2 + 页图框选） | 下一迭代 |
| Workflows（关页面后继续生成） | 老师反馈中断影响使用 |
| 无书签教材的启发式建树 | 真实教材无书签比例 > 30% |
| 大纲批注 → AI 修订 → diff | 纵切第 2 片 |
| 先查库再新建（按教材找已有的课） | M1b |
| `orgs` 表与 `org_id` 常量化、`PipelineOptions` 里输掉的消融分支（审查 #3 D-4 / D-6） | 有迁移窗口时；消融结论定稿、`tools/eval` 不再需要这些开关 |
| AI 生成实验 | `EMBED_CATALOG` 的 `src` 可替换，接入点已留 |

---

## 9. 密码哈希的取舍（PBKDF2 迭代次数）

现在部署在本机，没有 Workers 免费版的 10ms CPU 限制，所以从 15k 提高到 **300k**（`node scripts/bench-pbkdf2.mjs` 在 Xeon 上 100k ≈ 12–19ms，300k ≈ 35–55ms；登录有限速，这点延迟可以接受）。Cloudflare 线上的 WebCrypto 每次 PBKDF2 最多 10 万次迭代，为了以后还能部署到 Cloudflare，超过 10 万次时分成每次不超过 10 万次的几段串起来算，上一段的输出当下一段的密码（`derive`，`scripts/create-admin.mjs` 用 Node 的 `pbkdf2Sync` 做同样的事，`auth.test.ts` 用脚本算出的哈希核对两边一致）。哈希串自带迭代次数，登录成功时把其他次数的哈希换成当前次数，老用户下次登录自动升级到 300k。未知用户名用同样次数的假哈希校验，响应时间一致。登录按用户名和 IP 限速（15 分钟 8 次），密码至少 8 位且含字母和数字。
