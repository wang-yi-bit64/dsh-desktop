# ADR-030 — 日常提交零自动化；每日定时 + drift 补偿；发布前手动 dispatch

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-11 |
| 唯一产地 | `.github/workflows/ci.yml`、`smoke.yml`、`drift.yml` |

## 背景

原 CI 监听 `push: main`，每次提交跑三平台静态门禁 + 单测，冒烟也在 CI 里。
对一个单人维护、日常提交频繁的仓库，成本与收益失衡：日常提交要的是**快反馈**，
而组装 300MB 资源、打包、起窗口这些成本高的动作不该挂在每次提交上。

## 决策

1. **`ci.yml` 摘掉 `push: main`**（推 tag 也不跑它——tag 归 `release.yml`，
   同一件事两处实现必然漂移，出包只留一个产地）；保留 `pull_request` 与
   `workflow_dispatch`。
2. **冒烟从 ci.yml 迁到独立的 `smoke.yml`，且只由 `workflow_dispatch` 触发**
   （搬家不是另起一套：同一批脚本、同一套断言）。三种 scope 对应三档成本
   （`l1` / `assembled` / `full`）。
3. **每日定时是「日常零自动化」的补偿，不是把它加回来**（2026-09-12 起）：
   `ci.yml` 增设每天一次 `schedule`、新增 `drift.yml` 每日对照上游 dist-tag。
   合起来让「main 的 HEAD 有没有烂」与「上游是否已甩开我们」最迟 24 小时内被证实。
4. **发布前必须手动 dispatch CI 与 Smoke 并确认全绿再打 tag**。这是有意接受的
   边界，不是遗漏：Release 的 preflight 只跑秒级静态门禁 + 版本校验，
   看不见运行时行为；「tag 提交已经绿过」这个前提不再自动成立。

## 备选方案与取舍

- **恢复 push 触发全量 CI**：否决（被本决定取代）。反馈延迟换不来 nightly
  给不了的信息；且冒烟起窗口在 runner 上 flaky 成本高。
- **按路径过滤触发**（Rust 改了才跑 Rust）：否决。跨层契约问题的受害者恰恰是
  「改动与失败不在同一层」（ADR-003/004 都是 Rust 改动、页面受害）。

## 后果

- 日常提交零等待；静态门禁与单测改由本地 + PR 触发承担。
- 残留风险已命名：**给从未跑过门禁的提交打 tag，Release 不会发现**——
  所以 §8.5 的两步手动 dispatch 是发布步骤的一部分，不是可选仪式。
- ⚠️ 零预算重裁（ADR-047）后，每日定时 CI 与 drift 也改回**仅手动**；
  本条保留「push 不触发」与「发布前手动补齐」的结论。

## 守卫与证据

- `verify:release-workflow`（含 workflow 形状断言）。
- `docs/dev-plan-hardening-and-differentiation.md` §4「不在 push 上恢复全量 CI」。
