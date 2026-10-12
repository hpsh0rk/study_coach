# AI 课件工坊 · 架构（v3，合并简化版）

> 状态：2026-10-12 · 由实现方根据以下文档合并而成，实现以本文为准：
> 第一性原理审查 · 夜间决策记录（权威） · HTML 课件调研 · 教学规则（规则编号 L/P/V/I/T/Q 均出自此文）· 老师调研 · 项目决策记录（以上文档在项目资料库 `docs/` 中，不在本仓库）。

---

## 0. 一页结论

- **产品主线只有一条**：上传 PDF → 选章节 → 设置这节课 → **确认时间预算大纲（唯一强制卡点）** → 逐页生成 → 放映。界面是线性的五步向导，每步只有一个主按钮。
- **运行时只用 Workers + Static Assets + D1**，全部可由 `wrangler dev` 本地免费运行。砍掉 Durable Objects、Workflows、Queues、WebSocket、Containers、Vectorize、Browser Run、R2（纵切不用）。
- **PDF 在老师浏览器里用 pdf.js 解析**（Worker 免费版每次调用 CPU 只有 10ms）；服务端只存“目录 + 每页文本”。
- **密码用 WebCrypto PBKDF2-SHA256**（替换纯 JS argon2id）。
- **卡点 = 不可变的已确认大纲版本 + 生成接口 409 检查**。已确认版本由 SQLite 触发器禁止修改；领域层 `writeSlide()` 只接受品牌类型 `ConfirmedOutline`。超出课时 ±15% 时确认需要老师再点一次“仍然确认”，服务端同样强制。
- **课件 = 8 个固定版式 + 带内容预算的类型化槽位**。LLM 只填内容，不写样式、坐标、代码；版式由 CSS Grid 落位，浏览器实测溢出，有下限的字号降档兜底。
- **图表用 ECharts（SVG）**，交互只有五类：分步揭示、选择题、参数图（滑杆）、内嵌实验、来源跳转。全部声明式 JSON，离线可渲染。
- **模块单向依赖，dependency-cruiser 在 CI 中强制**；只有 `packages/ai` 能发起模型请求。
- AI 模型在后台配置（DeepSeek / GLM / OpenAI 兼容），未配置时本地与测试使用确定性 stub。

---

## 1. 运行形态

```
老师浏览器（React SPA，apps/web）
 ├─ pdf.js（Web Worker）解析目录 + 每页文本 → 分批上传（每批 ≤ 50 页）
 ├─ 向导：上传 → 章节 → 课堂设置 → 大纲（时间条 / 密度灯，规则与服务端同一份代码）→ 生成与放映
 ├─ 生成驱动：对每个页面规格并发 3 调用 generate，失败只重试该页，可“继续生成”
 └─ 渲染 + 放映：templates/render + widgets/render + player（溢出在此实测）
        │ HTTPS / JSON（x-kj-csrf 头 + httpOnly 会话 Cookie）
Worker（Hono，apps/app）
 ├─ routes（HTTP 边界、鉴权、参数校验）
 ├─ usecases（documents / lessons / outline / generate / admin）
 ├─ planner、writer（领域，纯函数 + 一次模型调用）→ ai（唯一模型出口）→ DeepSeek / GLM / OpenAI 兼容
 └─ store（D1 仓储）
D1：orgs, users, sessions, login_attempts, ai_providers, ai_routes, ai_calls, audit_log,
    documents, pages, chapters, lessons, outline_versions, slides, share_links
```

关闭标签页会中断生成；重新打开后“继续生成”只补缺失的页（夜间决策）。需要后台生成时再引入 Workflows，`writeSlide()` 原样作为 step 主体。

---

## 2. 模块图与允许的依赖

```
                       schema（只依赖 zod）
        ┌───────────┬──────┴───────┬────────────┬─────────┐
        ▼           ▼              ▼            ▼         ▼
  pdf-structure   widgets ──► templates ──► pedagogy     ai
   (core|browser) (core|render) (catalog|render)  ▲        ▲
                    ▲               ▲             │        │
                    │               └─────┬───────┘        │
                    │                     ▼                │
                    │               planner / writer ──────┘
                    │                     ▲
   player（只依赖 schema 的类型；不认识版式）│
     ▲                                    │
     │                       apps/app（routes → usecases → store）
   apps/web（pdf-structure/browser, templates/render, widgets/render, player, api client）
```

**规则（`.dependency-cruiser.cjs`，`pnpm lint` 执行，违反即失败）**

| 规则 | 说明 |
|---|---|
| `no-packages-to-apps` | `packages/*` 永不依赖 `apps/*` |
| `schema-is-leaf` | `schema` 只能依赖 `zod` |
| `no-circular` | 禁止循环依赖 |
| `server-no-dom` | `apps/app`、`planner`、`writer`、`pedagogy`、`templates/catalog`、`widgets` 核心入口不得导入 `*/render`、`pdf-structure/browser`、`echarts`、`pdfjs-dist`、`katex` |
| `pedagogy-not-up` | `pedagogy` 不得依赖 `ai`、`planner`、`writer`；`templates` 不得依赖 `pedagogy` |
| `player-is-generic` | `player` 不得依赖 `templates`、`widgets` |
| `planner-writer-separate` | `planner` 与 `writer` 互不依赖 |
| `only-ai-calls-models` | 模型 SDK 只能在 `packages/ai`（ESLint + `scripts/check-ai-boundary.mjs`） |

---

## 3. 各模块职责与公共接口

| 模块 | 单一职责 | 公共接口（摘要） | 允许依赖 |
|---|---|---|---|
| `schema` | 所有跨模块数据契约 | `ParsedPdf`、`TocEntry`、`ChapterNode`、`LessonParams`、`PageType`、`LayoutId`、`SlideSpec`、`Outline`、`SlideContent`（按版式区分的联合类型）、`Slide`、`WidgetSpec`、`ThemeId`；`newId()`、`sha256Hex()` | zod |
| `pdf-structure` | 从“目录 + 页文本”得到章节树与范围文本 | 核心：`buildChapterTree(toc, pageCount, pages)`、`rangesForChapters(tree, ids)`、`textForRanges(pages, ranges, maxChars)`、`detectTextLayer(pages)`、`normalizeRanges()`；浏览器入口 `@kj/pdf-structure/browser`：`parsePdf(data, onProgress) → ParsedPdf` | schema；pdfjs-dist（仅浏览器入口） |
| `widgets` | 声明式图表与交互的校验、表达式求值与渲染 | 核心：`validateWidget(spec)`、`compileExpr("A*sin(k*x)")`（自写解析器，不用 eval）、`chartOption(spec, palette)`（ECharts option，纯数据）、`EMBED_CATALOG` / `resolveEmbed(id)`；渲染入口 `@kj/widgets/render`：`renderWidget(spec, host, ctx) → {dispose}` | schema；echarts（仅渲染入口） |
| `templates` | 8 个固定版式：槽位 schema、内容预算、HTML 渲染 | 核心 `@kj/templates`：`LAYOUTS`、`layoutForPageType()`、`slotSchema(layout)`、`BUDGETS`、`maxBudgetContent(layout, lang)`、`stepsOf(content)`；渲染入口 `@kj/templates/render`：`renderSlide(slide, opts) → HTMLElement`、`applyStep(el, step)`、`fitSlide(el)`、`measureOverflow(el) → string[]`、`THEMES` | schema、widgets（核心用于类型，render 用于渲染） |
| `pedagogy` | 把“内容量合适、流程合理”变成可计算规则 | `PAGE_TYPES`（默认分钟、讲/练）、`planBudget(params) → {slideRange, minutes, tolerance}`、`checkOutline(outline, params) → Violation[]`、`outlineTiming(outline, params)`、`checkSlide(layout, content) → Violation[]`、`densityOf(spec)`、`countWords(text)`（中英混排） | schema、templates（核心） |
| `ai` | 唯一模型出口：结构化 JSON 调用、修复一次、计量、stub | `createAiLayer({config, meter, allowStub})`、`ai.callStructured({capability, schema, messages, stub, ctx})`、`testProvider()`、`sealSecret/openSecret`、`PROVIDER_PRESETS` | schema |
| `planner` | 源文本 + 课堂参数 → 时间预算大纲 | `draftOutline(ai, {sourcePages, chapters, params}) → {outline, warnings}`；内部：调用 `ai` → `pedagogy.checkOutline` → 有错误带违规清单重试 1 次 → 仍有则作为警告返回；`stubOutline()` 确定性实现 | schema、ai、pedagogy、templates（核心） |
| `writer` | 单页规格 + 源文本 → 槽位内容 + 备注 | `writeSlide(ai, confirmed: ConfirmedOutline, specId, sourcePages)`；内部：按版式 schema 调 `ai` → `pedagogy.checkSlide` + `widgets.validateWidget` → 违规重试 1 次 → 确定性截断（只截条数，不截句子）；`stubSlide()` | schema、ai、pedagogy、templates（核心）、widgets（核心） |
| `player` | 放映壳：16:9 缩放、翻页、分步、全屏、翻页笔、黑屏 | `mountPlayer(host, {count, render(i) → {el, steps}, start, onChange}) → {next, prev, go, destroy}`；纯函数 `nextPos/prevPos/fitStage` | 无（只用 DOM） |
| `apps/app` | HTTP 边界 + 用例编排 + 持久化 | 路由见 §6；`store/*`（D1）；`auth/*`（PBKDF2 + 会话 + 登录限速） | 全部核心入口 |
| `apps/web` | 老师界面 | 登录 / 改密 / 后台 / 备课列表 / 五步向导 / 放映 / 分享 / `/dev/gallery` | 全部浏览器入口 |

**从基线代码的去向**：`packages/parsers` → `pdf-structure`（`pdf-lite` 移到浏览器入口，`heavy.ts` 与 `containers/heavy` 删除）；`renderer` + `layout` → `templates`；`experiments` → `widgets` 的 `EMBED_CATALOG`；`ai` 保留（删 gateToken，能力提示词移到 planner/writer）；`apps/app/src/do`、`workflows` 删除；`fixtures/decks` 的旧 Deck 删除。

---

## 4. 数据模型

### 4.1 领域对象

```
User ─┬─ Document（一本 PDF 的文本层）── Page[]（no, text）
      │        └─ ChapterNode[]（树：title, level, pageStart, pageEnd, words）
      └─ Lesson（一次备课）
            documentId, title, themeId
            scope: { chapterIds[], ranges[{start,end}] }  ← 服务端快照页码范围
            params: LessonParams
            └─ OutlineVersion[]（只增不改；confirmedAt 可空；overBudgetAck）
                  outline: { objectives[], slides: SlideSpec[] }
            └─ Slide[]（outlineVersionId + specId + specHash 唯一）
                  layout, content（槽位）, notes, sources[]
```

### 4.2 关键类型

```ts
LessonParams = { minutes: 40, level: "basic"|"intermediate"|"advanced", lessonType: "new"|"review"|"lab",
                 language: "en"|"zh"|"en+zh", focus?: string }

PageType = "cover"|"retrieval"|"concept"|"process"|"data"|"worked"|"faded"
         | "practice"|"experiment"|"check"|"summary"|"exit"          // 12 种（M1a）

SlideSpec = { id, pageType, layout, title /*断言式*/, purpose, keyPoints[≤4],
              visual: "none"|"chart"|"function"|"flow"|"formula"|"sim",
              minutes, sourcePages[], loop /*第几个学习环，0=开场/收尾*/ }

Slide = { id, lessonId, outlineVersionId, specId, specHash, layout, content: SlideContent,
          notes: string, sources: number[], status: "ready"|"failed", warnings[] }
```

### 4.3 8 个版式与页型映射（内容预算 = 硬上限，生成时进 JSON Schema，渲染时测溢出）

| 版式 | 页型 | 槽位 | 预算（默认 / 硬上限） | 视觉 / 交互 |
|---|---|---|---|---|
| `title` | cover | title, subtitle, objectives[] | 目标 1–3 / 3 | 无 |
| `statement` | concept, process | title, bullets[], visual, terms[] | 要点 ≤3 / 4；正文 ≤30 词 / 45 词；术语 ≤2 / 3 | 必需：chart / function / flow / formula；要点分步揭示 |
| `chart` | data | title, chart, takeaways[], source | 结论 ≤2 / 3 | ECharts（柱 / 折线 / 散点 / 函数） |
| `steps` | worked, faded | title, problem, steps[{text, why}], fadeFrom? | 步骤 3–5 / 6 | 逐步揭示；渐隐页从 `fadeFrom` 起显示空框，下一步揭示 |
| `experiment` | experiment | title, predict{question, options[]}, sim, observe[], explain | 选项 2–4；观察 ≤3 | 预测 → 操作（参数图或内嵌实验）→ 观察 → 揭示解释（POE） |
| `quiz` | check | question, options[{text, misconception?}], answer, explain | 选项 3–4 | 点击作答即时反馈；“下一步”键揭示答案 |
| `questions` | retrieval, practice, exit | title, items[{q, a}] | 题目 2–5 / 5 | 答案逐题揭示 |
| `summary` | summary | title, nodes[{head, detail}] | 3–4 / 4 | 结构图（箭头相连的块），逐块揭示 |

每页都带 `sources`（教材页码，点击打开该页原文）与 `notes`（演讲备注，屏幕之外的讲解、提问与常见误区）。

**画布与字号**：逻辑画布 1920×1080；标题 72px，正文 56px（降档下限 48px），图表标签 40px，出处 28px；安全边距左右 96px、上下 54px。两套主题（`classic`、`chalk`）只改颜色，共用同一字号阶梯，因此内容预算与主题无关。

### 4.4 D1 表（新增 / 变更部分）

| 表 | 列（摘要） | 约束 |
|---|---|---|
| `documents` | id, org_id, owner_id, title, page_count, has_text_layer, toc_json, created_at | |
| `pages` | document_id, no, text | PK(document_id, no) |
| `chapters` | id, document_id, parent_id, ord, level, title, page_start, page_end, words | |
| `lessons` | id, org_id, owner_id, document_id, title, theme_id, scope_json, params_json, created_at, updated_at | |
| `outline_versions` | id, lesson_id, version, outline_json, warnings_json, created_by, created_at, confirmed_at, over_budget_ack | UNIQUE(lesson_id, version)；触发器：已确认版本禁止 UPDATE / DELETE |
| `slides` | id, lesson_id, outline_version_id, spec_id, spec_hash, layout, content_json, notes, sources_json, warnings_json, status, created_at | UNIQUE(outline_version_id, spec_id) |
| `share_links` | id, token_hash, lesson_id, created_by, created_at, revoked_at | 学生版不含备注与答案提示 |

删除：`projects`、旧 `documents`（R2 键、解析状态）。

---

## 5. 流水线

```
① 解析（浏览器）     pdf.js → ParsedPdf{title, pageCount, toc[], pages[{no,text}]}
                     无文字层（平均每页 < 40 字符）→ “暂不支持扫描版”
② 建树（两端同码）   buildChapterTree(toc) → ChapterNode[]；无书签 → 空树，界面改为“输入起止页”
③ 圈选              勾选章节或输入页码 → 服务端快照 ranges；界面实时显示“约 N 页教材，建议 a–b 页课件”
④ 课堂设置          课时（40）、学生水平（中等）、课型（新授）、语言（英文授课 + 中文术语）、本节重点（可空）；默认继承上一次备课
⑤ 大纲（AI）        planner.draftOutline：源文本（≤ 24k 字符）+ 参数 + 版式目录 → Outline
                     → pedagogy.checkOutline（L-03 ±15%、L-04 每 10 分钟讲授后有检查、POE、例题三联、目标挂钩）
                     → 有错误重试 1 次 → 仍有则作为警告显示在大纲顶部
⑥ 老师编辑大纲       改标题 / 要点 / 页型 / 分钟、增删、上下移动；每次保存 = 新的未确认版本
                     时间条：预计 x / 40 分钟（±15% 绿色）；建议页数 a–b；每页密度灯（偏少 / 合适 / 偏多）
⑦ 确认（唯一卡点）   POST …/confirm：服务端重算 timing；超 ±15% 且未带 acknowledgeOverBudget → 409 OVER_BUDGET
⑧ 逐页生成（AI）     POST …/outline-versions/:vid/slides/:sid/generate
                     服务端：未确认 → 409 OUTLINE_NOT_CONFIRMED；已存在同 specHash 的页 → 直接返回（幂等）
                     writer.writeSlide：版式 schema → ai → checkSlide + validateWidget → 重试 1 次 → 截断
⑨ 渲染与放映（浏览器）renderSlide → fitSlide（56→48px 降档）→ measureOverflow；放映：←/→/PageUp/PageDown/空格/回车
                     翻页笔走完全部分步；F 全屏，B 黑屏，N 备注，Home/End，数字 + 回车跳页
```

**卡点的最小正确设计**

- `outline_versions` 只增不改；触发器 `BEFORE UPDATE/DELETE … WHEN OLD.confirmed_at IS NOT NULL → RAISE(ABORT)`。
- 保存大纲 = 插入新版本；确认 = 给该版本打 `confirmed_at`（只允许从 NULL 变为非 NULL，同一条语句校验）。
- 生成接口路径带 `vid`，服务端唯一检查：属于该课 + 已确认，否则 409。
- `writer.writeSlide()` 只接受 `ConfirmedOutline` 品牌类型，只能由 `store.getConfirmedOutline()` 构造。
- 确认后再改大纲不是竞态：旧版本仍可生成它自己的页面；新版本需重新确认。界面提示“大纲已改动，需要重新确认”。

---

## 6. HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` · `/logout` · `/change-password`；GET `/me` | 白名单登录（PBKDF2），首次登录强制改密 |
| * | `/api/admin/users…` · `/api/admin/ai…` | 管理员：账号、AI 提供方与按能力路由（`outline.draft`、`slide.write`） |
| POST | `/api/documents` | `{title, pageCount, toc, hasTextLayer}` → 文档 + 章节树 |
| POST | `/api/documents/:id/pages` | `{pages:[{no,text}]}`，每批 ≤ 50 页 |
| GET | `/api/documents/:id` · `/api/documents/:id/pages/:no` | 章节树；某页原文（来源跳转） |
| GET/POST | `/api/lessons` | 列表；`{documentId, title}` 新建 |
| GET/PATCH | `/api/lessons/:id` | 课的全部状态（scope、params、最新大纲版本、页面）；更新 scope / params / theme |
| POST | `/api/lessons/:id/outline:draft` | planner 生成 → 新的未确认版本 |
| POST | `/api/lessons/:id/outline-versions` | 保存老师编辑 → 新的未确认版本 |
| POST | `/api/lessons/:id/outline-versions/:vid/confirm` | `{acknowledgeOverBudget?}`；唯一卡点的确认端 |
| POST | `/api/lessons/:id/outline-versions/:vid/slides/:sid/generate` | `{regenerate?}`；唯一卡点的检查端 |
| POST/DELETE | `/api/lessons/:id/share` | 学生分享链接；GET `/api/share/:token` 返回去掉备注的课件 |

---

## 7. 测试策略（每个 PR 必须全绿，全部离线、无密钥）

| 层 | 内容 | 工具 |
|---|---|---|
| 单元 | pdf-structure 建树 / 范围 / 无书签；pedagogy 预算 / 时长 / 密度 / 字数；widgets 表达式安全、校验、ECharts option；templates 预算样本合法；planner / writer 用 stub 和“超预算假模型”（重试 → 截断）；ai 层修复与回退；player 分步导航 | Vitest |
| 卡点 / API | 未确认生成 → 409；超预算未确认 → 409，带 ack → 成功；直接 UPDATE 已确认版本被触发器拒绝；确认后再保存 → 新版本未确认、旧版本仍可生成；同一规格重复生成不重复调模型；鉴权与 CSRF | `@cloudflare/vitest-pool-workers`（本地 D1） |
| 溢出 | 每个版式 × 两套主题 × 中 / 英，填满硬上限后渲染，`measureOverflow` 为空且正文字号 ≥ 48px | Playwright（`/dev/gallery`） |
| E2E | 全流程：建账号 → 上传 `waves-mini.pdf` → 选章节 → 默认设置 → 大纲（时间条、密度灯）→ 未确认时生成被拒 → 确认 → 全部页生成 → 放映（键盘翻页、分步揭示、选择题、全屏）→ 每页无溢出 | Playwright + stub 模型 |
| 依赖边界 | dependency-cruiser + AI 出口检查 | `pnpm lint` |

真模型质量评测（消融实验 A1–A9，见第一性原理审查 §6）在改提示词或换模型时手动触发，不进 CI。

---

## 8. 推迟与恢复条件

| 推迟项 | 恢复条件 |
|---|---|
| Workflows（关页面后继续生成） | 老师反馈中断影响使用 |
| R2 + 教材插图（页图框选） | 纵切第 2 片 |
| 无书签教材的启发式建树 | 真实教材无书签比例 > 30% |
| 大纲批注 → AI 修订 → diff | 纵切第 2 片 |
| 演讲者视图（BroadcastChannel 双窗口）、计时与剩余页数 | 纵切第 2 片 |
| 先查库再新建、复制去年的课 | M1b |
| 离线单文件打包、学生填空讲义、笔迹批注层 | 时间允许 |
| pptx 导出 | 有老师明确需要交给学校系统 |
| AI 生成实验 | `EMBED_CATALOG` 来源可替换，接入点已留 |
