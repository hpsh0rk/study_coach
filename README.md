# AI 课件工坊 · study_coach

老师上传教材 PDF，选章节，设课时，确认按时间分配好的大纲，得到一套可以编辑、放映、分享给学生的 HTML 课件。架构和决策见 [`docs/architecture.md`](docs/architecture.md)。

技术栈：pnpm monorepo · Cloudflare Workers + Hono · D1（Drizzle）· 静态资源 · React 19 + Vite。PDF 在浏览器里用 pdf.js 解析，只上传页面文字。全部可以用 `wrangler dev` 在本机运行，符合 Workers 免费版的限制。

## 本地运行（从零开始）

需要 Node 22 或更新版本（Linux 和 macOS arm64 + Node 24 都验证过）。仓库在 `package.json` 里固定了 pnpm 10.33.4，用 Node 自带的 corepack 运行就会自动用这个版本，不需要另外安装 pnpm。不需要 Cloudflare 账号，也不需要任何 API Key。

```bash
git clone https://github.com/hpsh0rk/study_coach.git
cd study_coach
corepack pnpm install          # 安装依赖
corepack pnpm setup:local      # 本地 D1 建表（迁移）+ 创建管理员账号 admin / Admin12345
corepack pnpm dev              # 构建前端并启动，打开 http://127.0.0.1:8787
```

- 运行过 `corepack enable` 之后可以省掉前面的 `corepack`，直接写 `pnpm …`；下文都这样简写。
- 如果配置了 npm 镜像，安装时某些包（例如 `rolldown`）返回 404，说明镜像还没同步到，改用官方源：`corepack pnpm install --registry=https://registry.npmjs.org/`。
- 默认管理员：用户名 `admin`，密码 `Admin12345`。**首次登录后必须改密码**，之后用新密码登录。
- `pnpm setup:local` 可以重复运行：已经有 `admin` 账号时不会改它的密码。
- 管理员密码怎么交给你：`pnpm admin:create` 直接写数据库，并在终端打印一次用户名和密码，不发邮件、不存明文，只有数据库里的哈希。这个密码只用于第一次登录，登录后会立即要求改密码。本地默认是 `Admin12345`，也可以用 `--password '你的密码'` 指定。加 `--remote`（线上 D1）时不用默认密码，而是生成随机的一次性密码打印出来，请当场记下并转交管理员。忘了密码时再运行 `pnpm admin:create --username admin` 就会重置，同样要求首次登录改密码；给老师的账号由管理员在后台创建，初始密码只在创建时显示一次。
- 本地数据（D1、会话）在 `apps/app/.wrangler/`，删掉这个目录再运行 `pnpm setup:local` 就是全新的库。
- 本地密钥可选：把 `apps/app/.dev.vars.example` 复制为 `apps/app/.dev.vars`。不复制也能运行，本地会用仅供开发的默认密钥加密后台填写的 Key。
- 只改前端时可以运行 `pnpm --filter @kj/web dev`（Vite 在 :5173，接口代理到 :8787，需要同时开着 `pnpm dev`）。

### 没有任何 Key 时（演示模式）

刚装好时后台没有配置 AI 模型，整个流程照样能点通：

- 大纲和幻灯片由内置模板生成（确定性的 stub，**不是 AI**）。每个页面顶部都有黄色横幅“演示模式：还没有配置 AI 模型……不是 AI 写的”，后台“AI 模型”页也会提示。
- 扫描页、画成图形的公式等浏览器读不到的页面，选章节时会标出来，老师可以粘贴文字补上。
- 这只在本地开发时打开（`apps/app/wrangler.jsonc` 里的 `AI_ALLOW_STUB=true`）；生产环境应设为 `false`。

### 配置真实的 Key

所有 Key 都在后台（`/admin`，管理员登录）填写，加密保存在服务器的 D1 里（用 `AI_CONFIG_KEY` 加密），不会发到浏览器：

- **AI 模型**：一个启用的提供方（DeepSeek、GLM，或任何 OpenAI 兼容接口：Base URL + Key）加一个模型名，所有生成调用都用它。可选填“看图模型”（如 GLM 的 `glm-4.6v-flash`），用来识别扫描页的图片。
- **外部解析服务**（MinerU）：重新识别扫描页和公式页。

## 主要功能

- 流程：上传 PDF → 选章节 / 页码（按书上印的页码；扫描页会标出来，可以粘贴文字；选的内容够好几节课时可以预览并按单元规划）→ 课时设置 → 大纲（时间预算 ±15%；超出时要明确确认）→ 确认后开始生成；每页可以编辑、撤销、重新生成 → 放映（←/→ 或翻页笔，F 全屏，B 黑屏，D 画笔，End 最后一页，Esc 回到第 5 步），讲稿、计时和答案在单独的演讲者窗口；或分享一个固定在某个大纲版本的只读链接（随时可以取消分享）。
- 离线：导出 → “离线放映文件”是老师用的（讲稿只在它自己的弹出窗口里，不会投到屏幕上）；分享面板里的“下载学生版离线文件”和分享链接一样在服务器上去掉讲稿和误区标签，发给学生用这个。
- 学生版（分享链接和学生离线文件）按分享面板的选项：**课前预习（无答案）**是默认，服务器去掉所有揭示步骤会显示的答案（测验答案和解析、实验结果和解释、问答答案、渐隐步骤；排序 / 配对卡片随机重发），显示“答案课后公布”；**课后复习（含答案）**保留答案，学生可以一步步揭示。切换模式不换链接。
- “我的课”里可以删除课（软删除：分享链接立即失效；撤销能恢复课，但不恢复链接）。上传页也可以同样删除 PDF：从列表消失、不能再用来新建课，已经做好的课照常可用，可以撤销。
- 模型调用每个请求共用 120 秒的截止时间（含重试）。
- `/dev/gallery` 按每种版式的内容上限渲染（中英文）；`/dev/render` 渲染一份课件 JSON。只在 `vite dev` 和用 `KJ_DEV_PAGES=1` 构建时存在（e2e 服务器和 `eval:render` 会设置），生产构建不包含。
- 内置仿真在 `apps/web/public/sims/`，列在 `EMBED_CATALOG`（`packages/widgets`）里。只有目录里有和章节匹配的仿真时才会规划实验页。

## 测试

只有跑 e2e 和溢出测试才需要下面这些（本地运行应用不需要）。每台机器装一次 Chromium 和中文字体：

```bash
# Linux（和 CI 一样）
pnpm exec playwright install --with-deps chromium   # 浏览器及其系统库
sudo apt-get install -y fonts-noto-cjk               # 真实的中文字形宽度，溢出测试要用

# macOS
pnpm exec playwright install chromium                # 不需要 --with-deps，也没有 apt-get
```

macOS 自带苹方等中文字体，不需要安装 `fonts-noto-cjk`。但字形宽度和 CI 用的 Noto 不完全一样，溢出测试在 Mac 上的结果只作参考，以 CI（Linux + Noto）为准。

```bash
pnpm lint          # ESLint + 模型 SDK / 接口只能出现在 packages/ai + dependency-cruiser 模块边界
pnpm typecheck
pnpm test          # 所有包的 vitest；apps/app 在 workerd 里运行（D1、登录、幻灯片复用 / 撤销等）
pnpm test:e2e --project=overflow --project=e2e   # Playwright：每种版式在最大内容时不溢出 + 老师完整流程（:8788）
SHOTS_DIR=out pnpm test:e2e --project=e2e        # 同样的流程，每一步保存截图
```

测试和 CI 不连接任何外部服务：MinerU 用录制的响应回放，模型提供方和自部署服务用本机 mock。CI 安装 `fonts-noto-cjk`，溢出测试量的是真实中文字形。`node scripts/make-fixture-pdf.mjs` 重新生成 e2e 用的 PDF（`waves-mini.pdf`，以及 `newton-zh-cid.pdf`：未嵌入的 CID 字体中文加两页扫描页）。`node scripts/bench-pbkdf2.mjs` 测密码哈希的耗时（见 architecture §9）。

## 评测（`tools/eval`）

离线的消融实验工具，不是产品代码（dependency-cruiser 禁止产品代码导入它）。

```bash
pnpm eval:run --eval-dir <含 manifest.json + pdfs/ 或 pages.json 的目录> --out results/B0 [--scenarios S01,S03 | --all] [--runs 3] [--flags writerSource=none,phases=false]
pnpm eval:render results/B0      # 在 Chromium 里渲染每一页，写入 slides[].overflow
```

提供方：`KJ_EVAL_API_KEY`（加 `KJ_EVAL_PROVIDER` deepseek|glm|custom、`KJ_EVAL_MODEL`、`KJ_EVAL_BASE_URL`），或 `DEEPSEEK_API_KEY` / `GLM_API_KEY`。没有 Key 时所有调用都用确定性的 stub。`--flags` 对应 `@kj/generation` 的 `PipelineOptions`（默认 = 完整流程）以及评测专用开关（`scope`、`outline`、`renderMode`、`autoConfirm`）。

## 部署到 Cloudflare（还没有实际运行过）

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... AI_CONFIG_KEY=... pnpm run deploy
```

`scripts/deploy.sh` 创建或找到 D1 数据库，把真实的数据库 id 写进 `apps/app/.wrangler.deploy.jsonc`，在远端执行迁移，构建前端，设置密钥并运行 `wrangler deploy`。GitHub Actions 的 `.github/workflows/deploy.yml` 执行同样的步骤（手动触发，使用仓库 secrets）。部署后创建第一个管理员：`pnpm admin:create --remote --config .wrangler.deploy.jsonc`（远端会生成随机密码并打印出来）。生产环境请把 `AI_ALLOW_STUB` 设为 `"false"`。

中国大陆说明：字体（Arimo、Noto Sans SC）、KaTeX 和仿真都自己托管，不用第三方 CDN。自定义域名（sh0rk.cn）还没有配置。

## 待办

- 需要真实 Cloudflare 账号的部分：第一次部署、远端 D1、大陆访问测试。
- PDF 里的插图（目前只用页面文字），更多仿真。
