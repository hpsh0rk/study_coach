# Spec · 构建残留目录（`.next/`）纳入忽略规则

## 背景 / Problem

`apps/web/` 是 Vite + React 19 工程，但工作区里曾出现一个未跟踪的 `apps/web/.next/`
（`cache/`、`server/`、`types/routes.d.ts`，Next.js 15 的产物形状，代码中无任何引用）。
它带来两个问题：

1. `git status` 一直有噪声（`?? apps/web/.next/`）。
2. ESLint 不读 `.gitignore`，会去 lint 里面的 `types/routes.d.ts`，命中
   `@typescript-eslint/no-empty-object-type`，导致**本地 `pnpm lint` 失败**，
   而全新 clone（无该目录）的 CI 却是绿的 —— 一个只在"脏工作区"复现的假红。

## Scope 边界

- **只改忽略规则**：`.gitignore` 增加 `.next/`；`eslint.config.js` 的 `ignores` 增加 `**/.next/**`；
  `.dependency-cruiser.cjs` 的 `options.exclude.path` 增加 `\\.next`（否则 depcruise 会把
  `.next` 里的 `.ts` 当模块扫，实测模块数 202 → 207）。
- **不改**任何产品代码、构建配置、`package.json` 脚本、CI 流程。
- **不删除**用户磁盘上的既有 `apps/web/.next/`（本次已另行移到 `/tmp` 备份，不随提交）。

## Contract 接口契约

- 无新增/修改任何导出、类型、HTTP 接口或数据模型。
- `pnpm lint` / `pnpm typecheck` / `pnpm test` 的**命令与语义不变**；
  唯一变化是 ESLint 的文件发现集合排除 `**/.next/**`。

## Acceptance Criteria 验收标准

- [ ] 存在 `apps/web/.next/types/routes.d.ts`（含空 interface）时，`pnpm lint` 仍 **exit 0**。
- [ ] `git status` 不再把 `apps/web/.next/` 列为未跟踪。
- [ ] `pnpm lint`、`pnpm typecheck` 在干净工作区仍然全绿（不引入新违规）。
- [ ] 依赖边界（dependency-cruiser）与 AI 边界检查结果不变。

## 非目标 / Out of scope

- macOS 上 `slide-chart-table-en` 的 8px 溢出：按 README 约定以 CI（Linux + Noto）为准，
  本 spec 不处理。
