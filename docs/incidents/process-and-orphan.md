# 进程与孤儿防护事故档案

> 从 `AGENTS.md` §4 迁入，原样保留。

### macOS 孤儿防护：父死看门狗必须装在被替换后的入口上（2026-09-12 修复，勿回归）

风险 R-7：**macOS 没有 `PR_SET_PDEATHSIG` 等价物**（`crates/dsh-host/src/process.rs`），
宿主被杀后 Harness 会成为孤儿，只等下次冷启动的陈旧 pidfile 清扫。三平台冒烟转为硬门禁后，
故障注入的 A（SIGTERM 宿主）/ B（强杀宿主）当场变红，暴露了这个长期缺口。

补法在 `build/parent-death-watchdog.mjs`。两个坑各花掉一轮 CI，**都写进该模块文件头**：

1. **定时器不能 `unref()`**：unref 的定时器在事件循环闲置时不触发，而 Harness 大部分时间
   正是闲置的。第一版 unref 之后看门狗在 macOS 上**从未运行**——日志里连一行痕迹都没有，
   极易误判成「探测逻辑写错」。
2. **必须装在实际执行的那个进程上**：故障注入的 mock 模式会把 `node_entry`/`dsh_entry`
   **双双替换成 `mock-harness.mjs`**（`crates/dsh-host-cli/src/commands/mod.rs::apply_mock_if_requested`），
   `harness-node-entry.mjs` 根本不在该路径上。只装在入口上，对故障注入**零作用**。
   因此该模块由**入口与 mock 共同引用**。

**守卫**：`verify:harness-entry` 的 E4a/E4b/E4c 三条分别钉住「入口装了看门狗」「模块可用且
未 unref」「mock 也装了」，各有可证伪夹具。`DSH_PARENT_DEATH_WATCHDOG=1` 可在非 darwin
平台强制启用——本机没有 macOS，这个开关让该行为能被**本地实测**（隔离验证：宿主被杀后
mock 进程数 2 → 0），而不是每轮靠三平台 CI 试错。

**预算（2026-09-21 补，勿改错方向）**：看门狗的清理是异步的，最坏耗时
=`POLL_INTERVAL_MS + FORCE_EXIT_MS`。这个数字曾与门禁的等待窗口对不上账：当时是
`250 + 1500 = 1750ms`，而 `fault-inject` 的 B 场景与 `smoke-launch.mjs` 的 L2.2 都只等
**1500ms**——真实 Harness 收到 SIGTERM 后不立刻退出，由兜底计时器决定退出时刻，采样点
于是落在清理完成之前。现在常数是 `250 + 750 = 1000ms`，且 `verify:harness-entry` 的 **E6**
会把两个常数与各门禁窗口逐个对账。理由、备选方案与实测数字见
[`docs/adr/050`](docs/adr/050-guard-windows-vs-cleanup-budget.md)。

