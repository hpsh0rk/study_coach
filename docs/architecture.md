# AI 课件工坊 · 架构（v4，核心纵切已实现）

> 状态：2026-10-12 · 与 `main` 上的代码一致（核心纵切 PR 合并后）。来源文档：第一性原理审查 · 夜间决策记录（权威）· HTML 课件调研 · 教学规则（规则编号 L/P/V/I/T/Q 出自此文）· 老师调研 · 项目决策记录 · 对抗审查 1（均在项目资料库 `docs/`，不在本仓库）。代码与本文冲突时以代码为准，并修正本文。

---

## 0. 一页结论

- **产品主线只有一条**：上传 PDF → 选章节 → 设置这节课 → **确认时间预算大纲（唯一强制卡点）** → 逐页生成、可编辑 → 放映 / 分享。界面是线性的五步向导，每步只有一个主按钮。
- **运行时只用 Workers + Static Assets + D1**，`wrangler dev` 本地免费运行，适配 Workers 免费版（每次调用 10ms CPU、50 次 D1 查询）。没有 Durable Objects、Workflows、Queues、R2、Containers。
- **PDF 在老师浏览器里用 pdf.js 解析**；服务端只存“章节树 + 每页文本 + 印刷页码”。
- **密码用 WebCrypto PBKDF2-SHA256**。
- **卡点 = SQLite 触发器 + 409**：已确认的大纲版本不可改不可删；页面只能挂在已确认版本上；生成接口对未确认版本返回 409。超出课时 ±15% 时确认需要老师显式“仍然确认”，服务端同样强制（409 → 带 ack 重试）。
- **每个大纲版本快照自己的课时参数与页码范围**；之后改设置不会悄悄改变已有版本的含义，界面提示“需重新生成大纲”。
- **生成幂等、可复用**：页面按 `spec_hash = sha256(规格去掉 id + 课时参数)` 跨版本复用；改了大纲只重做变了的页。单页可“重新生成”、按槽位表单编辑、撤销一步。
- **课件 = 8 个固定版式 + 带内容预算的类型化槽位**。LLM 只填内容；CSS Grid 落位；浏览器实测溢出；学生要读的字不小于 48px。每个版式按硬预算填满（中 / 英）都能放下，由 Playwright 在 CI 中验证（CI 安装 Noto CJK 字体）。
- **生成流水线在一个包 `@kj/generation`**（大纲 + 单页），消融开关是一个带默认值的普通对象 `PipelineOptions`；评测驱动在产品代码之外的 `tools/eval`。
- **模块单向依赖，dependency-cruiser 在 CI 中强制**；只有 `packages/ai` 能发起模型请求。
- AI 模型在后台配置（DeepSeek / GLM / OpenAI 兼容），未配置时本地与测试使用确定性 stub。

---

## 1. 运行形态

```
老师浏览器（React SPA，apps/web）
 ├─ pdf.js 解析目录、每页文本、印刷页码（getPageLabels）→ 分批上传（每批 40 页）
 ├─ 向导：上传 → 章节（树 / 按书上页码输入，首尾页预览，字数估时与拆课提示）
 │        → 课堂设置 → 大纲（时间条、密度灯、未覆盖、术语表；规则与服务端同一份代码）
 │        → 生成（先例题后其余，并发 2；单页重新生成 / 槽位编辑 / 撤销）→ 放映 / 分享
 └─ 渲染 + 放映：templates/render + widgets/render + player（溢出在此实测）
        │ HTTPS / JSON（x-kj-csrf 头 + httpOnly 会话 Cookie）
Worker（Hono，apps/app）
 ├─ routes（HTTP 边界、鉴权、zod 校验、用例编排）
 ├─ generation（draftOutline / writeSlide）→ ai（唯一模型出口）→ DeepSeek / GLM / OpenAI 兼容
 └─ store（D1 仓储：快照、复用、聚合查询）
D1：orgs, users, sessions, login_attempts, ai_providers, ai_routes, ai_calls, audit_log,
    documents, pages, chapters, lessons, outline_versions, slides, share_links
静态资源：SPA、字体（Arimo、Noto Sans SC）、KaTeX、内置实验 /sims/*.html
```

关闭标签页会中断生成；重新打开后“继续生成”只补缺失的页。需要后台生成时再引入 Workflows，`writeSlide()` 原样作为 step 主体。

---

## 2. 模块图与允许的依赖

```
                         schema（只依赖 zod）
        ┌────────────┬──────────┴──────┬─────────────┬──────────┐
        ▼            ▼                 ▼             ▼          ▼
  pdf-structure    widgets ──────► templates ───► pedagogy      ai
 (core|browser)  (core|render)    (core|render)      ▲          ▲
        ▲            ▲                 ▲             │          │
        │            │                 ├──► player   │          │
        │            │                 │             │          │
        │            └──────────► generation ◄───────┴──────────┘
        │                              ▲
        │                 apps/app（routes → store）     tools/eval（消融驱动、渲染测量）
   apps/web（pdf-structure/browser, templates/render, widgets/render, player, pedagogy）
```

**规则（`.dependency-cruiser.cjs`，`pnpm lint` 执行，违反即失败）**

| 规则 | 说明 |
|---|---|
| `no-circular` | 禁止循环依赖 |
| `schema-is-a-leaf` | `schema` 只放类型与 zod schema，不依赖其他包 |
| `packages-never-import-apps` | `packages/*` 永不依赖 `apps/*` |
| `server-code-is-dom-free` | `apps/app`、`ai`、`generation`、`pedagogy`、`schema`，以及 `templates`/`widgets`/`pdf-structure` 的核心入口，不得导入渲染入口、player、pdf.js、ECharts、KaTeX、React |
| `model-calls-stay-on-the-server` | `apps/web`、`player` 不得导入 `ai`、`generation` |
| `only-the-server-and-evals-orchestrate` | 其他 `packages/*` 不得导入 `generation`（只有 Worker 路由与 `tools/eval` 调用它） |
| `product-code-never-imports-tools` | `apps/*`、`packages/*` 不得导入 `tools/*` |
| `ai-layer-is-generic` | `ai` 只依赖 `schema`，不认识课、版式、教学规则 |
| `pedagogy-has-no-io` | `pedagogy` 不得依赖 `ai`、`generation`、`player`、`pdf-structure` |
| AI 出口检查 | 模型 SDK 只能在 `packages/ai`（ESLint + `scripts/check-ai-boundary.mjs`，扫描 apps、packages、tools） |

---

## 3. 各模块职责与公共接口

| 模块 | 单一职责 | 公共接口（摘要） |
|---|---|---|
| `schema` | 跨模块数据契约 | `ParsedPdf`、`PageText{no, text, label?}`、`ChapterNode`、`LessonParams`、`PageType`、`LayoutId`、`SlideSpec`、`Outline{objectives, slides, glossary, notCovered}`、`SlideContent`（按版式区分的联合）、`Slide{…, canUndo?}`、`WidgetSpec`、`ThemeId`；`newId()`、`sha256Hex()` |
| `pdf-structure` | 目录 + 页文本 → 章节树、范围、源文本 | `buildChapterTree`、`rangesForChapters`、`normalizeRanges`、`pagesInRanges`、`countPages`、`sourceForRanges(pages, ranges, maxChars) → {text, included, omitted}`、`labelOf`、`formatPages`、`pageForLabel`（按印刷页码解析输入）、`detectTextLayer`、`subtreeIds`；浏览器入口 `parsePdf(data, title, onProgress)` |
| `widgets` | 声明式图示与交互：校验、表达式、渲染 | 核心：`validateWidget`、`compileExpr`（自写解析器，不用 eval）、`chartOption`、`functionOption`、`EMBED_CATALOG` / `resolveEmbed` / `findEmbed(text, minHits)`（整词匹配）；渲染入口 `renderWidget(spec, host, ctx) → {dispose}` |
| `templates` | 8 个固定版式：槽位 schema、内容预算、HTML 渲染 | 核心：`LAYOUTS`、`layoutForPageType`、`PAGE_TYPE_VISUALS`、`SLOT_SCHEMAS` / `slotSchema`、`BUDGETS`、`FONT`、`maxBudgetContent(layout, lang)`、`stepsOf`；渲染入口：`renderSlide(slide, {theme, interactive, badge, pageLabels, onSourceClick})`、`applyStep`、`fitSlide`、`measureOverflow`、`minBodyFontPx`、`THEMES` |
| `pedagogy` | “内容量合适、流程合理”的可计算规则 | `PAGE_TYPES`（默认分钟、讲 / 练）、`TIME_TOLERANCE = 0.15`、`planBudget(params) → {minutes, minMinutes, maxMinutes}`、`outlineTiming → {totalMinutes, status, needsAck, …}`、`checkOutline`、`checkSlide`、`densityOf`、`scopeAdvice(words, minutes) → {estimatedMinutes, lessons, tooMuch}`（6 分钟 / 千词） |
| `ai` | 唯一模型出口：结构化 JSON、修复一次、计量、stub | `createAiLayer({config, meter, allowStub})`、`ai.callStructured({capability, promptVersion, schema, messages, stub, ctx})`、`jsonSchemaOf(schema)`（WeakMap 缓存）、`testProvider`、`sealSecret/openSecret`、`PROVIDER_PRESETS` |
| `generation` | 源文本 + 参数 → 时间预算大纲；大纲 + 规格 → 单页内容 | `draftOutline(ai, DraftInput) → {outline, warnings}`、`writeSlide(ai, outline, specId, WriteInput) → {content, notes, sources, warnings}`、`workedSpecFor`、`stubOutline` / `stubSlide`、`problemsOf` / `truncateLists` / `applyGlossary`、`PipelineOptions` / `DEFAULT_OPTIONS` / `optionsOf`、`OUTLINE_PROMPT_VERSION`、`SLIDE_PROMPT_VERSION` |
| `player` | 放映壳：16:9 缩放、翻页、分步、全屏、黑屏、讲稿 | `new Player(host, {slides, theme, showNotes, badge, onSourceClick, pageLabels, start, onChange})`、`renderThumb`；纯函数 `keyAction` / `nextPosition` / `prevPosition` |
| `apps/app` | HTTP 边界 + 用例编排 + 持久化 | 路由见 §6；`store.ts`（快照、复用、聚合列表、导出）；`auth/*`（PBKDF2 + 会话 + 登录限速） |
| `apps/web` | 老师界面 | 登录 / 改密 / 后台 / 我的课 / 五步向导 / 槽位编辑器 / 放映 / 分享 / `/dev/gallery`、`/dev/render` |
| `tools/eval` | 消融评测（不属于产品） | `pnpm eval:run`（manifest 场景 → 流水线 → 每场景 × 次数一个 deck JSON）、`pnpm eval:render`（Chromium 渲染，写回 `slides[].overflow`）；`AblationFlags = PipelineOptions + {scope, outline, renderMode, autoConfirm}` |

---

## 4. 数据模型

### 4.1 领域对象

```
User ─┬─ Document（一本 PDF 的文本层）── Page[]（no, text, label?, words）
      │        └─ ChapterNode[]（树：title, level, pageStart, pageEnd, words）
      └─ Lesson（一次备课）
            documentId, title, theme
            scope: { chapterIds[], ranges[{start,end}] }   ← 当前选择
            params: LessonParams                            ← 当前设置
            └─ OutlineVersion[]（只增不改；confirmedAt 可空；ackOverBudget）
                  outline: { objectives[], slides: SlideSpec[], glossary[], notCovered[] }
                  params, scope                              ← 起草时的快照，生成只看它
            └─ Slide[]（outlineVersionId + specId 唯一；specHash 用于跨版本复用）
                  layout, pageType, minutes, content（槽位）, notes, sources[], warnings[]
                  prevContent / prevNotes                    ← 一步撤销
```

### 4.2 关键类型

```ts
LessonParams = { minutes: 40, level: "basic"|"intermediate"|"advanced", lessonType: "new"|"review"|"lab",
                 language: "en"|"zh"|"en+zh", focus: string }

PageType = "cover"|"retrieval"|"concept"|"process"|"data"|"worked"|"faded"
         | "practice"|"experiment"|"check"|"summary"|"exit"          // 12 种

SlideSpec = { id, pageType, layout, title /*断言式*/, purpose, keyPoints[≤6],
              visual: "none"|"chart"|"function"|"flow"|"formula"|"sim",
              minutes, sourcePages[], loop /*第几个学习环，0=开场/收尾*/ }

Outline = { objectives[1–3], slides[1–40], glossary[{term, zh}] ≤30, notCovered[string ≤200] ≤20 }

PipelineOptions = { budgetsInPrompt, outlineCheckRetry, slideCheckRetry, truncateFallback, phases: boolean,
                    visualPlanning: "outline"|"writer", writerSource: "pages"|"none"|"all" }   // 默认全开
```

### 4.3 8 个版式与页型映射（预算 = 硬上限：进 JSON Schema、超出截断、渲染测溢出）

预算单位是“词”（1.7 个汉字 = 1 词）。数字是 默认 / 硬上限。

| 版式 | 页型 | 槽位与预算 | 视觉 / 交互 |
|---|---|---|---|
| `title` | cover | 标题 8/10；副标题 8/10；目标 3 条 × 7/8 | 无 |
| `statement` | concept, process | 标题 12/15；要点 3 条 × 7/8（合计 20/24）；术语 2 个 | 必需：chart / function / flow / formula；要点分步揭示 |
| `chart` | data | 标题；结论 2/3 条 × 6/7；出处 6/8 | ECharts（柱 / 折线 / 散点），数据标签只标焦点系列 |
| `steps` | worked, faded | 题目 18/24；步骤 3/4 步 × 5/6（理由 2/3） | 逐步揭示；渐隐页从 `fadeFrom` 起显示空框 |
| `experiment` | experiment | 问题 6/8；选项 3 个 × 2/3；观察 2 条 × 3/4；解释 6/8 | 左：预测 + 观察；右：实验 + 解释（POE）。只有目录里有匹配实验时才规划此页 |
| `quiz` | check | 题干 14/20；选项 4 个 × 5/7；误区 8/10；解释 14/18 | 点击作答即时反馈；“下一步”揭示答案 |
| `questions` | retrieval, practice, exit | 题目 3/4 道 × 8/10；答案 4/6 | 答案逐题揭示 |
| `summary` | summary | 节点 3/4 个 × 3/4；说明 6/8 | 结构图，逐块揭示 |

每页都带 `sources`（教材页码，按印刷页码显示，点击打开原文）与 `notes`（讲稿：屏幕之外的讲解、提问与常见误区）。屏幕上只留学生要看的；讲多了的内容进讲稿。

**画布与字号**：逻辑画布 1920×1080；标题 72px（降档下限 60px），正文 56px（降档下限 48px，学生要读的文字一律 ≥ 48px），标签 ≥ 40px，出处 28px；左右边距 96px。两套主题（`classic`、`chalk`）只改颜色，预算与主题无关。

### 4.4 D1 表（业务部分）

| 表 | 列（摘要） | 约束 |
|---|---|---|
| `documents` | id, org_id, owner_id, filename, title, size_bytes, page_count, pages_received, has_text_layer, has_bookmarks | |
| `pages` | document_id, no, text, label, words | PK(document_id, no) |
| `chapters` | document_id, id, parent_id, ord, level, title, page_start, page_end, words | |
| `lessons` | id, org_id, owner_id, document_id, title, scope, params, theme | |
| `outline_versions` | id, lesson_id, version, outline, params, scope, spec_count, total_minutes, ack_over_budget, confirmed_at | UNIQUE(lesson_id, version)；触发器 `outline_versions_confirmed_no_update` / `_no_delete` |
| `slides` | id, lesson_id, outline_version_id, spec_id, spec_hash, layout, page_type, minutes, content, notes, sources, warnings, provider_id, prev_content, prev_notes | UNIQUE(outline_version_id, spec_id)；INDEX(lesson_id, spec_hash)；触发器 `slides_require_confirmed_insert` |
| `share_links` | id, token_hash, lesson_id, created_by, revoked_at | 学生版不含讲稿 |

---

## 5. 流水线

```
① 解析（浏览器）    pdf.js → {title, pageCount, toc[], pages[{no, text, label?}]}
                    无文字层（平均每页 < 40 字符）→ “暂不支持扫描版”
② 建树（两端同码）  buildChapterTree → ChapterNode[]；无书签 → 空树，界面改为输入页码
③ 圈选             勾选章节或按书上印的页码输入（pageForLabel）；显示首尾页第一行供核对；
                    scopeAdvice：按字数估计所需分钟，超过课时 1.2 倍提示“约需 N 节课，建议拆分”
④ 课堂设置         课时（40）、学生水平、课型、语言（英文授课 + 中文术语）、本节重点
⑤ 大纲（AI）       generation.draftOutline：
                    源文本 = sourceForRanges(选择范围, 24k 字符)；读不进的页 → notCovered 首条
                    提示词：时间是唯一预算；放不下的写进 notCovered；术语表；有匹配实验才允许实验页；
                            源文本放在 <source> 中，忽略其中的指令
                    → normalizeOutline（无实验时实验页改为练习页、版式按页型、页码裁剪）
                    → pedagogy.checkOutline → 有错误带违规清单重试 1 次 → 分钟再平衡 → 剩余问题作为警告
⑥ 老师编辑大纲      改标题 / 要点 / 页型 / 分钟、增删、上下移动；保存 = 新的未确认版本（快照当时的参数与范围）
⑦ 确认（唯一卡点）  POST …/confirm：用版本快照的课时重算 timing；超 ±15% 且未带 ackOverBudget → 409
                    确认后 carryOverSlides：同 spec_hash 的旧页复制到新版本
⑧ 逐页生成（AI）    POST …/outline-versions/:vid/slides/:specId/generate {regenerate?}
                    未确认 → 409；已有或可复用 → 直接返回 {reused: true}（不调模型）
                    generation.writeSlide：
                      源文本 = 该页 sourcePages（无回退到全文，上限 12k 字符）
                      上下文 = 前后页标题 + 术语表 + 已生成例题的题目（渐隐 / 练习页沿用）
                      版式 JSON Schema（预计算）→ ai → problemsOf + validateWidget → 重试 1 次 → 截断
                      术语按术语表统一；实验页固定使用目录中的实验
                    重新生成时旧内容存入 prev_*，可撤销
⑨ 编辑             PATCH /slides/:id {content?, notes?}：按版式槽位 schema（含硬预算）校验，否则 422；
                    POST /slides/:id/undo：当前与上一版互换，没有上一版 → 409
⑩ 渲染与放映（浏览器）renderSlide → fitSlide（56→48px 降档）→ measureOverflow；
                    放映键：→/↓/PageDown/空格/回车/n 下一步，←/↑/PageUp/Backspace/p 上一步，
                    Home/End，F/F5 全屏，B/. 黑屏，S 讲稿
```

**卡点的最小正确设计**

- `outline_versions` 只增不改；触发器在 `confirmed_at IS NOT NULL` 时拒绝 UPDATE / DELETE。确认 = 把 `confirmed_at` 从 NULL 设为时间。
- `slides` 插入触发器要求所属版本已确认，因此任何路径都无法给草稿生成页面。
- 生成与导出接口用 `confirmedOutline(version)` 读取大纲，未确认 → 409 `OUTLINE_NOT_CONFIRMED`。卡点就是“触发器 + 409”，没有额外的类型层。
- 确认后再改大纲不是竞态：旧版本仍可生成它自己的页面；新版本需重新确认，确认时复用未变的页。

**免费版约束**：我的课列表是一条带相关子查询的 SQL；页面上传每批 40 页（每页一条 upsert，留出鉴权等查询余量）；复用插入每批 5 行（D1 每条语句 ≤ 100 个绑定参数）；JSON Schema 预计算并缓存。

---

## 6. HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST / GET | `/api/auth/login` · `/logout` · `/change-password` · `/me` | 白名单登录（PBKDF2），首次登录强制改密 |
| * | `/api/admin/users…` · `/api/admin/ai…` | 管理员：账号、AI 提供方、按能力路由（`outline.draft`、`slide.write`） |
| GET / POST | `/api/documents` | 列表；`{filename, title, sizeBytes, pageCount, hasTextLayer, chapters}` 新建 → `{id, pageBatch: 40}` |
| POST | `/api/documents/:id/pages` | `{pages:[{no, text, label?}]}` |
| GET | `/api/documents/:id` · `/api/documents/:id/pages/:no` | 章节树、`pageLabels`、`pageWords`；某页原文与印刷页码 |
| GET / POST | `/api/lessons` | 列表（单条聚合 SQL）；`{documentId, chapterIds, ranges}` 新建 |
| GET / PATCH | `/api/lessons/:id` | 课的全部状态（最新大纲版本含快照、页面、`pageLabels`、`scopeWords`）；更新 scope / params / theme / title |
| POST | `/api/lessons/:id/outline` | 起草 → 新的未确认版本 |
| PUT | `/api/lessons/:id/outline-versions/:vid` | 保存老师编辑（已确认版本 → 409 `OUTLINE_VERSION_IMMUTABLE`） |
| POST | `/api/lessons/:id/outline-versions/:vid/confirm` | `{ackOverBudget?}`；超预算未确认 → 409 `OVER_BUDGET_ACK_REQUIRED`；返回复用后的页面 |
| POST | `/api/lessons/:id/outline-versions/:vid/revise` | 以已确认版本为底稿新建草稿 |
| POST | `/api/lessons/:id/outline-versions/:vid/slides/:specId/generate` | `{regenerate?}` → `{slide, reused}` |
| PATCH | `/api/lessons/:id/slides/:slideId` | `{content?, notes?}`；槽位校验失败 → 422 `INVALID_CONTENT` |
| POST | `/api/lessons/:id/slides/:slideId/undo` | 一步撤销；无可撤销 → 409 `NOTHING_TO_UNDO` |
| GET | `/api/lessons/:id/deck` | 导出 deck JSON（版本快照的参数与范围） |
| POST / DELETE | `/api/lessons/:id/share` | 学生分享链接；GET `/api/share/:token` 返回去掉讲稿的课件 |

---

## 7. 测试策略（每个 PR 必须全绿，全部离线、无密钥）

| 层 | 内容 | 工具 |
|---|---|---|
| 单元 | schema 默认值与上限；pdf-structure 建树 / 范围 / 印刷页码；pedagogy 预算 / 时长 / 密度 / 估时；widgets 表达式安全、校验、整词匹配；templates 预算样本合法；generation：stub 预算、开关、实验门槛、notCovered、术语表、无全文回退、12k 上限、渐隐修复、重试 → 截断；ai 层修复、回退、Schema 缓存；player 导航；tools/eval 开关解析 | Vitest |
| 卡点 / API | 未确认生成 → 409；超预算未确认 → 409，带 ack → 成功；触发器拒绝改已确认版本与给草稿插页；跨版本复用与幂等生成；PATCH 校验与撤销；快照；鉴权与 CSRF | `@cloudflare/vitest-pool-workers`（本地 D1） |
| 溢出 | 8 个版式 × {示例, 英文满预算, 中文满预算}：`measureOverflow` 为空且正文 ≥ 48px | Playwright `overflow`（`/dev/gallery`，CI 装 `fonts-noto-cjk`） |
| E2E | 登录 → 改密 → 上传 `waves-mini.pdf` → 选章节（估时）→ 设置 → 大纲（时间条）→ 超预算确认被拒 → “仍然确认” → 全部生成 → 编辑标题 → 撤销 → 内置实验可访问 → 放映（Home/End/→/讲稿） | Playwright `e2e` + stub 模型；`SHOTS_DIR` 时每步截图 |
| 依赖边界 | dependency-cruiser + AI 出口检查 | `pnpm lint` |

真模型质量评测（消融计划，见资料库 `docs/design/ablation-plan.md`）用 `tools/eval` 手动运行，不进 CI。

---

## 8. 推迟与恢复条件

| 推迟项 | 恢复条件 |
|---|---|
| 数字来源核对（生成页中的数字必须能在源页找到） | 下一迭代 |
| 表格视觉、更多内置实验 | 下一迭代 |
| 演讲者视图（双窗口讲稿、计时） | 下一迭代 |
| 离线单文件打包（内嵌 Noto Sans SC） | 下一迭代 |
| 教材插图（R2 + 页图框选） | 下一迭代 |
| Workflows（关页面后继续生成） | 老师反馈中断影响使用 |
| 无书签教材的启发式建树 | 真实教材无书签比例 > 30% |
| 大纲批注 → AI 修订 → diff | 纵切第 2 片 |
| 先查库再新建、复制去年的课 | M1b |
| pptx 导出 | 有老师明确需要交给学校系统 |
| AI 生成实验 | `EMBED_CATALOG` 的 `src` 可替换，接入点已留 |
