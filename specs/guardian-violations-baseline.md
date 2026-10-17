# Spec · Guardian 违规基线（存量 63 条显式接受）

## 背景 / Problem

`ai-native-guardian` 的 `run-all.js` 硬校验器（agent-smells / security / migration / design）
对**整个仓库**做绝对规则检查，且原本**没有基线机制**。把它套在已有成熟代码库上，
一上手就是 91 条违规，全部与当前改动无关：

| 类别 | 条数 | 性质 |
|---|---|---|
| `[Agent-Smell: Bare-Error]` | 26 | 主要是 `tools/eval`（明确标注"不是产品代码"） |
| `[Agent-Smell: Silent-Failure]` | 20 | player / templates / 前端早退分支 |
| `HARDCODED_SECRET` | 15 | 测试夹具里的假 key（已被框架测试豁免） |
| `DESTRUCTIVE_MIGRATION_NO_ROLLBACK` | 10 | 6 个**已应用**的历史迁移，无法回溯补 down |
| `DYNAMIC_CODE_EXECUTION` | 2 | depcruise 配置 / Playwright `$$eval` 误报 |
| `[Agent-Smell: Swallowed-Exception]` | 2 | — |
| `DESIGN_*`（tokens / selection / mockups） | 3 | 前端设计契约缺失 |

这些是**既有状态**，不是本轮需求引入的。

## Scope 边界

- 只在项目里**锚定基线**：新增 `.guardian/violations-baseline.json`。
- **不改**任何产品代码、测试、迁移、CI。
- 框架侧的配套修复（跳过生成目录、测试夹具豁免、`--update-baseline`）已单独提交到
  `ai-native-guardian` 仓库，不属本 PR。

## Contract 接口契约

- 无新增/修改任何导出、类型、HTTP 接口或数据模型。
- 基线按 `file|rule|msg` **计数**（不含行号）：插入/删除代码行不会让基线漂移。
- 语义：基线内的存量违规不阻断；**任何新增违规仍然阻断**（exit 1）。

## Acceptance Criteria 验收标准

- [x] `run-all.js <repo>` 在无基线时报告 63 条（修复生成目录与测试夹具前为 91 条）。
- [x] 有基线后 `run-all.js <repo>` **exit 0**，输出"无新增违规 (63 处存量已在基线内)"。
- [x] 注入一条新的裸 `throw new Error` → **exit 1**，且只报这 1 条新增。
- [x] 移除注入后恢复 exit 0。

## 非目标 / Out of scope

- 逐条修掉这 63 条存量（会重写 `tools/eval`、给已应用的历史迁移补回滚、补设计 tokens/mockups，
  属于跨多 PR 的独立计划，不在本轮）。
- entropy-guard 的克隆簇基线（advisory，不影响退出码）暂不锚定。
