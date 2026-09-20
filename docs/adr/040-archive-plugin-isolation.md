# ADR-040 — 插件分级隔离「冻结并归档」

| | |
|---|---|
| 状态 | 已归档（代码已删除，2026-09-10 批次 F） |
| 日期 | 2026-09-10 |
| 唯一产地 | `docs/archive/plugin_isolation_architecture.md`（设计意图留档） |

## 背景

Tier 0/1/2 分级沙箱、JSON-RPC 2.0 双向通信、连续故障断路器**曾实现且有单测**，
但从未有任何运行时调用方，且**不在真实插件挂载路径上**（真实挂载走 Harness 进程内
的官方 Cordis 体系）。最严重的是：`plugin_worker.rs::call_tool` 会**返回伪造的
成功结果**（`success: true`）——上层无法通过任何观测手段发现插件工具其实根本没被
执行。这不是「文档写早了」，是桩实现说谎（ADR-007 立纪的直接动因）。

## 决策

按 `docs/dev-plan-disconnected-points.md` §4 决策点 3 裁定**冻结并归档**，且当轮
执行完毕：删 `crates/dsh-host/src/plugin_worker.rs`、`build/plugin-worker-host.mjs`，
注销 `PluginWorkerClient`；设计文档移入 `docs/archive/` 并在文首写归档说明
（判据 + 恢复前提）；README / `AGENTS.md` §7 的相应表述收敛为「已归档」。
**不要在未重新裁定的情况下把它加回来。**

## 备选方案与取舍

- **接线到某个路径再说**：否决。没有真实挂载点可接；硬接就是再造一个
  「返回伪造成功」的假设施。
- **保留代码但标未接线**：否决。已判定不在真实路径上的隔离是纯维护成本，
  且 `pub` 项在 rlib 里永远「可达」（ADR-005），挂着没人知道它没接。
- **按官方 loader 对齐做进程隔离**（roadmap 决策点 3 的 B）：暂不。前置是官方
  mount path 暴露可挂载的隔离点；A 案（先做诊断 + 归因 + 恢复）是立刻可做且
  用户可见的部分。

## 后果

- 当前**唯一生效的插件防护**是 `build/plugin-safety-guard.mjs` 的进程内
  `formatFaultDetails` 归因（被 `harness-node-entry.mjs` 的未捕获异常/拒绝处理器
  消费）。**同进程的插件崩溃仍可能带走 Harness**——不得表述为「插件崩溃不拖垮
  主程序」。
- 恢复前置条件（写在上游归档文档「退出条件」段）：与官方 loader 的 mount path
  对齐，且不得再自造脱离官方 loader 的「假隔离」。

## 守卫与证据

- `verify:claims` C1（被 §7 明令禁止的表述不得出现在 README）。
- 归档文档文首的恢复判据（`docs/archive/plugin_isolation_architecture.md`）。
