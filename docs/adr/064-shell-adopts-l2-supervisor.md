# ADR-064 — 桌面壳（L1）正式采用 `dsh_host::Supervisor`（L2）

**状态**：已接受（2026-10-11）

---

## 背景

`docs/roadmap.md` 的分层图早已把职责切成三层：

```
L1  Desktop Shell  —  Tauri / 窗口 / 菜单 / 托盘 / 更新 / 原生对话框
L2  Supervisor     —  dsh-host：spawn / ready / health / restart / orphan / logs / diagnostics / safe mode
L3  DSH Runtime    —  官方 Node + DSH
```

但 **L1 从来没有走 L2**。`src-tauri` 用的是自己那个**同名类型** `HarnessSupervisor`
（`src-tauri/src/state.rs`），它是「一次性启动 + 事后错误页」：崩溃检测靠 shell 自己
spawn 的 exit watcher，然后直接进错误页——**没有退避、没有断路器、没有自动重启**。
而真正的重启策略（`next_backoff` / `decide_restart` / 重启协程）全在
`crates/dsh-host/src/supervisor.rs` 里。

2026-10-11 逐项实测确认：`dsh_host::Supervisor` **全仓无任何运行时消费者**——
`dsh-host-cli` 的五个子命令不导入它，`src-tauri` 用的又是另一个类型。
而 `AGENTS.md` §7.2 当时把「Supervisor 自愈与退避」记为「✅ 已接线，运行时调用方 =
`state.rs` 生命周期回调」，属于 §7.1 禁止的**宣称与代码脱节**。

同日补上 `dsh-host-cli recover` 后，L2 有了第一个消费者，宣称暂时成立；但桌面产品
这条主线仍然没有自愈能力。本次决策把 L1 也接上。

## 决策

**桌面壳采用 L2，形态是适配器而非替换。**

1. `HarnessSupervisor` 保留**全部公开方法**（`start` / `start_in_safe_mode` / `stop` /
   `restart` / `restart_in_safe_mode` / `snapshot` / `ready_url` / `harness_port` /
   `launch_endpoint` / `logs_tail`），因此 `commands.rs` / `menu.rs` / `quit_guard.rs`
   的 9 处调用点**零改动**。
2. L1 只保留**面向 UI 的那一层**：`HarnessPhase`、日志环形缓冲、`harness://status`
   广播、导航、错误页、托盘、退出守卫。子进程的派生、就绪探测、退避、断路器、
   有界重启全部交给 L2。
3. 状态经**广播桥**单向流动：L2 的 `broadcast::Sender<SupervisorState>` → 壳层派生的
   桥接任务 → 映射进 `SupervisorInner` + `emit`。映射决策抽成纯函数
   `classify_state`（`src-tauri/src/state.rs`），因为它不依赖 Tauri 才能被单测。
4. 重启上限取契约常量 `SUPERVISOR_MAX_RESTARTS = 3`
   （唯一产地 `crates/dsh-contracts/src/constants.rs`）。最坏「崩溃 → 见到错误页」
   耗时 = `0.5 + 1 + 2` = **3.5 s**。
5. 桥用**代号（generation）** 而非时序假设来防迟到状态：每次启动自增，
   桥只在代号未变时应用状态。

## 备选方案与取舍

| 方案 | 为什么被否决 |
|---|---|
| **直接替换**：删掉 `HarnessSupervisor`，让所有调用点直连 `dsh_host::Supervisor` | `HarnessPhase` 承载的信息比 `SupervisorState` **更多**——`plugin_fault`（决定错误页是否给安全模式入口）、`retryable`（决定是否换端口重试）、`Ready { url }`（导航目标）。替换会把这些语义丢掉，而它们正是错误页与托盘状态行的输入 |
| **保持现状，只在 CLI 接线** | 桌面产品主线仍缺「崩溃自愈」，与 roadmap 把 L2 定位为资产的方向相反；且会让 §7.2 那条宣称继续半真半假 |
| **让 L2 直接持有 Tauri 类型**（`AppHandle` / `Emitter`），省掉桥 | 一票否决：这会让 `dsh-host` 再也不能在没有窗口系统的机器上被测试，**INV-6 当场失效**，而且编译不会报错。ADR-001 的判定标准就是「能否在没有窗口系统的机器上测试」 |
| **让桥靠「退出够快」保证正确性**（不设代号） | 上一轮的桥在读到通道 `Closed` 之前可能已投递迟到状态，把新一轮相位改掉。这是把正确性押在调度时序上，属本仓明令避免的那类假设 |
| **`max_restarts` 取默认 5** | 最坏 15.5 s 才见到错误页。对「配置错误导致必然崩溃」的场景，用户要干等 15 秒才拿到归因 |

## 后果

**好的一面**

- 「崩溃自愈 + 指数退避 + 断路器」从**只在 CLI 路径生效**变成**桌面壳也生效**；
  `AGENTS.md` §7.2 那条「桌面壳尚未接入」的注记可以销账。
- 崩溃归因统一到 L2 的 `DiagnosticReport`，错误页的 `plugin_fault` / `retryable` 与
  日志推导共用一条链路。
- L2 因此获得真实、长期的运行时消费者，它不再是「写好了但没人跑」的代码。

**代价（必须明说）**

- **产品可见行为变化**：Harness 崩溃不再立刻进错误页，而是先退避重启至多 3 次。
  偶发崩溃用户几乎无感（0.5 s 后即恢复）；但「必然崩溃」要等最坏 **3.5 s** 才见图文归因。
- L1 多了一个桥接任务与一个代号字段；`SupervisorInner.running` 字段随之删除
  （实例归 L2 持有），`handle_post_ready_exit` 整条路径被 L2 取代。
- **GUI 路径没有本机自动化覆盖**：`cargo test -p dsh-desktop` 在 GNU 工具链下因
  WinRT DLL 加载失败无法执行（`docs/incidents/local-toolchain-limits.md`），
  因此 `classify_state` 的断言**只能编译、由 CI（MSVC）执行**。

## 守卫与证据

| 守卫 / 证据 | 钉住什么 |
|---|---|
| `scripts/verify-dsh-host-headless.mjs`（S6-1，fast/ci/release 三档） | L2 的依赖闭包不得含窗口层 crate。**接线之后这条最承压**——最省事的「修法」就是把 `AppHandle` 塞进 `dsh-host`；该守卫把那次渗漏变成会报红的事实（实测注入 `tauri` 后点名 18 个 crate） |
| `crates/dsh-host/tests/supervisor_properties.rs`（S6-3，proptest） | 退避单调且有上限 / 几何公式正确 / 有限步收敛 / 断路器恰好 N 次开路 / 重启次数有界 / 无非法相位转移 |
| `crates/dsh-host/tests/supervisor_stop_orphans.rs`（P4） | **启动中（spawn→ready 之间）`stop()` 不残留孤儿**。这是接线文档里唯一标着「无测试覆盖」的边界：那段窗口里 `active_instance` 仍是 `None`，终止只能靠 Job Object 兜底。实测通过；跳过 `abort()` 探针会让它变红 |
| `crates/dsh-host/tests/supervisor_env_profile.rs`（P1） | `env` / `extra_envs` / `profile` 三条通道真的到达子进程（`extra_envs` 此前是**死字段**；`profile` 缺失会让安全模式退化成普通启动） |
| `crates/dsh-host/tests/supervisor_backoff.rs` + `supervisor.rs` 的 `mod tests` | 退避在真实派生进程上递增、断路器进 `Failed`；`stable_uptime == 0` 的零值语义回归锁 |
| `src-tauri/src/state.rs` 的 `classify_state` 单测 | 映射里最容易错的两条：崩溃**重试期间不得进错误页**、`Stopped`/`Stopping` 桥**不得处理** |
| `docs/recover-demo.md` | 一页式、无 GUI 的三段流程复现步骤（CLI 侧同一套 L2 行为） |
| `AGENTS.md` §7.2「Supervisor 自愈与退避」行 | 能力状态与证据链的对照表；状态变化时须回看本 ADR 的「后果」段 |

## 相关

- `docs/dev-plan-supervisor-shell-wiring.md` — 接入点、映射表、生命周期与异常清单（E1~E11）
- ADR-001（INV-6 无头核心）、ADR-004（`phase` 平铺契约）、ADR-007（宣称纪律）
- ADR-010（孤儿进程防护三平台策略）——P4 那条测试正是它的 L2 兑现
- `docs/incidents/local-toolchain-limits.md` — 为什么 GUI 侧断言只能由 CI 执行
