# ADR-033 — CI / Smoke / Release 三工作流分工，互不重复

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-11 ~ 2026-09-12 |
| 唯一产地 | `.github/workflows/ci.yml`、`smoke.yml`、`release.yml` |

## 背景

最初 CI 什么都做（静态 + 单测 + 冒烟），Release 又自己实现一遍校验。同一件事两处
实现必然漂移；而每类检查的成本与时机要求根本不同：静态检查要秒级反馈，真实进程
冒烟要按需，出包要显式意图。

## 决策

| 工作流 | 触发 | 做什么 | 不做什么 |
|--------|------|--------|----------|
| CI | PR / 手动 /（重裁前）每日定时 | 三平台静态门禁 + clippy + 单测 | 不组装资源、不打包、不跑烟雾 |
| Smoke | **仅手动**（scope=l1/assembled/full，dsh_target 输入） | 按需起真实进程：L1 会话烟雾 / 真实资源树 / 打安装包 + L2 GUI + 体积采集 | 不发布任何东西 |
| Release | 推 `v*` tag / 手动指定 tag | preflight（版本↔tag + 通道推导 + 秒级静态门禁）→ 三平台并行出包 + 创建 Release + `latest.json` + CLI 归档 | **不重跑** cargo test / clippy / 冒烟矩阵 |

三条边界纪律：

1. **出包只留一个产地**：tag 归 Release，`ci.yml` 推 tag 也不跑。
2. **Release 的 preflight 必须在组装 300MB 之前失败**（秒级静态 + 版本校验）。
3. **preflight 看不见运行时行为** → 发布前手动 dispatch CI + Smoke 是发布步骤的
   一部分（ADR-030 决策 4）。

## 备选方案与取舍

- **合回一个 workflow 用 job 依赖表达分层**：否决。触发条件不同（PR vs 手动 vs
  tag），合在一起只能取最宽松的触发，等于把冒烟挂回每次 PR。
- **Release 重跑全量测试**：否决。三平台测试 + 冒烟的时间成本让每次发布多等
  十几分钟，而它的结论在手动 dispatch 时已经有过一次。

## 后果

- 「该跑哪一类检查」由触发方式决定，不靠人记。
- 残留风险（tag 的提交从未跑过门禁）被显式接受并写入 §8.5，而不是假装不存在。

## 守卫与证据

- `verify:release-workflow`（含三工作流形状与 tauri 钩子断言）。
- `docs/dev-plan-hardening-and-differentiation.md`（J 批次：门禁强度与 CI 成本）。
