# Supervisor 接入桌面壳（L1 → L2 接线）设计与阻塞项

> **状态：设计已定，实现分阶段；本文件记录接入点、消息映射、生命周期与**必须先在 `dsh-host` 补齐的三个 API 缺口。
> 关联：`docs/roadmap.md` §H1-a / 分层图、`AGENTS.md` §3.1（INV-6）与 §7.2、`docs/recover-demo.md`、`docs/dev-plan-defect-remediation.md`（S6 批次）。

---

## 0. 结论先行

| 项 | 结论 |
|---|---|
| 是否需要接入 | **需要，且是对齐既有架构**——`docs/roadmap.md` 的分层图把 `Supervisor` 定为 **L2**、桌面壳定为 **L1**，但当前 L1 **没有走 L2**：`src-tauri` 用的是自己那个同名类型 `HarnessSupervisor`（`state.rs:122`），它是「一次性启动 + 事后错误页」，**没有退避、没有断路器、没有自动重启** |
| 接入形态 | **适配器，不是替换**：`HarnessSupervisor` 保留**全部公开方法**，内部改成 `dsh_host::Supervisor` 的消费者。这样 `commands.rs` / `menu.rs` / `quit_guard.rs` 的 9 处调用点**零改动** |
| 主要收益 | 「崩溃自愈」从**只在 CLI 路径生效**（`recover`）变成**桌面壳也生效**；`AGENTS.md` §7.2 那条「桌面壳尚未接入」的注记可以销账 |
| 主要代价 | **产品行为变化**：Harness 崩溃不再立刻进错误页，而是退避重启至多 5 次。最坏情况 **约 15.5 s** 才显示错误页（`0.5+1+2+4+8`，见 §5.1） |
| 阻塞项 | **`dsh-host` 侧需先补三个 API 缺口**（§4）：`HarnessEnv` 传递、安全模式 profile、`extra_envs` 目前是**死字段** |

---

## 1. 现有形态（实测，2026-10-11）

### 1.1 两侧各有一个 Supervisor，且互不相干

| | L2（`dsh-host`） | L1（`src-tauri`） |
|---|---|---|
| 类型 | `dsh_host::supervisor::Supervisor` | `state::HarnessSupervisor`（`state.rs:122`） |
| 构造 | `Supervisor::new(layout, SupervisorConfig)` | `HarnessSupervisor::new(AppHandle, Layout, LauncherConfig)`（`lib.rs:90`） |
| 退避 / 断路器 | ✅ 有（`next_backoff` / `decide_restart`） | ❌ **无** |
| 自动重启 | ✅ 有（重启协程） | ❌ 无（`restart()` 只是再 `start()` 一次） |
| 崩溃归因 | `SupervisorState::Crashed { diagnostics }` | `LaunchEvent` → `HarnessPhase::Failed` |
| 日志环形缓冲 | `LogRing`（在 `LaunchEvent::Log` 里） | `SupervisorInner.logs`（`logs_tail`） |
| 运行时消费者 | `dsh-host-cli recover`（2026-10-11 新增） | `commands.rs` / `menu.rs` / `quit_guard.rs` |

**关键事实**：`dsh-host::Supervisor` 在 2026-10-11 之前**全仓无调用方**；同日由 `recover` 子命令补上第一个消费者（见 `docs/recover-demo.md`）。桌面壳这一侧仍是空白。

### 1.2 壳侧的公开方法面（= 适配器必须保持的契约）

| 方法 | 消费者 |
|---|---|
| `snapshot()` | `commands.rs:128`、`:296` |
| `logs_tail(n)` | `commands.rs:195`、`:297`、`:545`；`menu.rs:361` |
| `ready_url()` | `commands.rs:160` |
| `restart()` | `commands.rs:141`、`:371`；`menu.rs:275`、`:335` |
| `restart_in_safe_mode()` | `commands.rs:388`、`:442`；`menu.rs:304` |
| `start()` / `start_in_safe_mode()` | `lib.rs:262`、`:264` |
| `stop()` | 退出链路 |
| `launch_endpoint()` / `harness_port()` | `quit_guard.rs`（退出前「有没有会话在跑」） |
| `HarnessSnapshot`（含 `phase` / `message` / `logs`） | 经 `harness://status` 事件下发到 `frontend/*.html`（`state.rs:16`） |

**结论**：这 9 个方法 + `HarnessPhase` 的 8 个变体（`state.rs:39-61`）是**对外契约**，接入时不得改动形状。

---

## 2. 集成点（改哪里、不改哪里）

### 2.1 唯一改动点：`HarnessSupervisor` 的内部

```
src-tauri/src/state.rs
  HarnessSupervisor {
    app: AppHandle,              // 不变：仍是 emit 与导航的落点
    layout: Layout,              // 不变
    config: LauncherConfig,      // 不变（转交给 SupervisorConfig）
    inner: Mutex<SupervisorInner>,   // 不变：仍是 snapshot/logs/phase 的唯一产地
  + inner_supervisor: AsyncMutex<Option<Arc<dsh_host::Supervisor>>>  // 新增：L2 句柄
  + bridge_task: AsyncMutex<Option<JoinHandle<()>>>                  // 新增：状态桥
  }
```

**不改**：`commands.rs`、`menu.rs`、`quit_guard.rs`、`navigation.rs`、`tray.rs`、任何 `frontend/*.html`。

**为什么用适配器而不是替换**：`HarnessPhase` 承载的信息比 `SupervisorState` **更多**——它有 `plugin_fault`（决定错误页是否给「安全模式」入口）、`retryable`（决定是否换端口重试）、`Ready { url }`（导航目标）。`SupervisorState` 里没有这些。替换会把这些语义**丢掉**，而那正是错误页与托盘状态行的输入。适配器让 L1 继续拥有「面向 UI 的相位」，L2 只负责「进程与重启策略」。

### 2.2 分层职责（接入后）

| 层 | 负责 | 不负责 |
|---|---|---|
| L1 `HarnessSupervisor` | UI 相位（`HarnessPhase`）、日志环形缓冲、`harness://status` 广播、导航、错误页、托盘、退出守卫 | 重启策略、退避、断路器 |
| L2 `dsh_host::Supervisor` | 派生子进程、就绪探测、**退避 / 断路器 / 有界重启**、崩溃诊断 | 任何 UI 概念、任何 Tauri 类型（INV-6，由 `verify-dsh-host-headless` 守卫） |

---

## 3. 数据与消息的传递方式

### 3.1 单向：L2 → L1（状态桥）

`dsh_host::Supervisor` 经 `broadcast::Sender<SupervisorState>` 广播；壳侧**派生一个桥接任务**订阅并把状态映射进 `SupervisorInner` + `emit`：

```rust
// 桥接任务（每个 Supervisor 实例一个；在 Supervisor::start() 之后派生）
tauri::async_runtime::spawn(async move {
    let mut rx = supervisor.subscribe();   // ⚠️ Receiver 不能 clone，单一累加器
    while let Ok(state) = rx.recv().await {
        apply_supervisor_state(&inner, &app, state);   // 映射见 §3.2
    }
});
```

### 3.2 映射表（`SupervisorState` → `HarnessPhase` + 副作用）

| `SupervisorState` | `HarnessPhase` | 副作用 |
|---|---|---|
| `Starting { attempt }` | `Preparing`（首次）/ `Starting`（重试，`attempt > 1`） | `message` 注明「第 N 次尝试」；`attempt > 1` 时 `push_desktop("restarting…")` |
| `LaunchProgress(Preparing)` | `Preparing` | — |
| `LaunchProgress(Spawned{pid,port})` | `Starting` | 记录 pid / port |
| `LaunchProgress(TokenFound)` | `Starting` | `message = "Launch token acquired."` |
| `LaunchProgress(ReadyChecking{port})` | `ReadyChecking` | — |
| `LaunchProgress(Log(line))` | **不变** | `inner.logs.push(line)`（日志的唯一入口） |
| `Running { endpoint, pid }` | `Ready { url }` | 触发导航（复用现有 `decide_navigation`）；写 `inner.running` 不适用（L2 持有实例） |
| `Crashed { diagnostics, restart_count, next_backoff, .. }` | **不变**（保持 `Ready`，因为马上要重启） | `push_desktop("crashed #N, retrying in Xms")`；`will_restart == false` 时才置 `Failed` |
| `Failed { diagnostics, total_restarts }` | `Failed { cause_kind, cause, plugin_fault, retryable }` | 由 `diagnostics` 经现有 `FailureCause` 归因填充；导航到错误页 |
| `Stopping` | `Stopping` | — |
| `Stopped` | `Stopped` 或 `Idle` | 用户主动 `stop()` 时 `Idle`；否则 `Stopped` |

### 3.3 双向：L1 → L2（控制）

| L1 动作 | L2 调用 | 说明 |
|---|---|---|
| `start()` | 构造 `SupervisorConfig`（含 `LauncherConfig` + profile + env）→ `Supervisor::new` → `start()` | 见 §4 的 API 缺口 |
| `start_in_safe_mode()` | 同上，额外带 `--profile desktop-safe-mode` 与 safe patch | **需要 §4.2 的 profile 通道** |
| `stop()` | `Supervisor::stop()` | ⚠️ `stop()` 会 `abort()` 监督协程（`supervisor.rs:343-357`），见 §5.3 |
| `restart()` | `stop()` → `start()` | L2 目前**没有** `restart()`；用「停+起」表达，或按 §4.4 补一个 |

### 3.4 日志的双通道（不冲突）

- **L2 → L1 文本行**：`LaunchProgress(Log(line))` → `inner.logs`（供 `logs_tail` / 日志查看器 / 诊断包）。
- **L2 自身结构化状态**：`Starting` / `Crashed` / `Failed` 等，只驱动相位与提示，**不进 `logs`**（否则日志会被状态噪声淹没）。

这条与现有行为一致：现在 `apply_launch_event` 也是只把 `LaunchEvent::Log` 推进 `logs`（`state.rs:338-346`）。

---

## 4. 阻塞项：`dsh-host` 必须先补的三个 API 缺口（**实测确认**）

> 这三条是**接线的硬前提**。不补就接线，会静默丢掉现有能力——而且是编译不报错的那种丢。

### 4.1 `Supervisor` 不传环境 ⇒ C2 契约环境会丢 ⚠️ 阻塞

```rust
// crates/dsh-host/src/supervisor.rs:208-212（现状）
let outcome = launcher
    .launch(None, |evt| { ... })   // ← None：没有 HarnessEnv
```

而壳侧一直传的是构造好的 `HarnessEnv`（`state.rs:234` 用 `launch(None, …)` 也是 `None`，但壳另有 `harness_env_with_overrides` 生成 C2 契约项）。

- **`Launcher::launch` 的签名接受 `Option<&HarnessEnv>`**（`launch.rs:423-427`）。
- **影响**：`DSH_HOME` 等 C2 契约环境变量可能不再到达子进程 → 可写状态落到用户主目录而不是 `app_data_dir`（正是 **INV-1** 要防的）。
- **修法**：`SupervisorConfig` 增加 `env: Option<HarnessEnv>` 字段，`launch(self.config.env.as_ref(), …)`。

### 4.2 无 profile 通道 ⇒ 安全模式会退化成普通启动 ⚠️ 阻塞

壳侧安全模式靠 `Launcher::with_profile("desktop-safe-mode")`（`state.rs:228-231`）切换 `--profile` 与 patch 层。`SupervisorConfig` **没有任何 profile 字段**，`Supervisor` 构造 `Launcher` 时只调 `with_extra(args)` 与 `with_host(host)`。

- **影响**：接进来之后 `restart_in_safe_mode()` 会变成**普通重启**——正是 `AGENTS.md` §7.2 记过的同形事故（错误页「安全模式」按钮曾因调错方法而「是谎话」，2026-09-10 修）。
- **修法**：`SupervisorConfig` 增加 `profile: Option<String>`，构造 `Launcher` 时透传。

### 4.3 `extra_envs` 是死字段 ⚠️（不会当场坏，但是坏味道）

`SupervisorConfig.extra_envs: Vec<(String,String)>`（`supervisor.rs:114`）**声明了、在 `Default` 里初始化了，却从未被任何代码读取**——实测 grep 只有声明与初始化两处命中。`extra_args` 则真的被用（`:203`）。

- **影响**：它给人的印象是「可以注入环境」，实际是静默无效。
- **修法**：与 §4.1 一起做——`env`（基底）+ `extra_envs`（覆盖层），两者都真正生效；或删除该字段并写明「注入环境请走 `env`」。

### 4.4 无 `restart()` / 无 `is_running` 语义说明（次要）

`Supervisor` 只有 `start()` / `stop()` / `is_running()`。壳的 `restart()` 高频使用（菜单 + 错误页 + 托盘），用「停+起」表达可以，但要注意 §5.3 的 abort 语义。

### 4.5 `stable_uptime == 0` 会让退避与断路器同时失效 ✅ 已修（P2，2026-10-11）

`Supervisor::start()` 的重置分支原是 `if uptime >= config.stable_uptime`，而 `uptime` 是 `Instant::elapsed()`，**恒 `>= 0`**。故 `stable_uptime` 取 `0` 时每次崩溃都满足条件，`restart_count` 与 `current_backoff` 双双被打回初值 ⇒ **退避永不增长、断路器永不开路（无限重启）**。

- **已修**：判定抽成纯函数 `supervisor::is_stable_uptime(uptime, stable_uptime)`，显式把 `0` 定义为「**永不视为稳定运行**」（窗口长度为 0 意味着没有任何运行时长算得上稳定）。接线前是必须处理项，现已是闭合项。
- **回归锁**：`supervisor::tests::zero_stable_uptime_never_counts_as_stable`（对 0/1ms/1s/30s/1h 断言恒 `false`）。**可证伪已实证**：把函数体回退成 `uptime >= stable_uptime` 后，只有这条测试变红，精确命中。
- **实测现场**：`tests/supervisor_backoff.rs` 首次写成 `stable_uptime = 0` 时，45 s 内 14 次上报**全为初值**（`attempt` 恒为 2）。

---

## 5. 启动与生命周期管理

### 5.1 启动序列（接入后）

```
lib.rs setup
  └─ HarnessSupervisor::new(app, layout, config)      // 不启动（与现状一致）
       └─ AppState 托管
  └─ 首个启动：lib.rs:262/264 → start_in_safe_mode() / start()
       ├─ stop()（幂等，清上一次）
       ├─ 构造 SupervisorConfig { launcher_config, env, profile, max_restarts, backoff… }
       ├─ Supervisor::new(layout, config)
       ├─ supervisor.start()        // 派生监督协程；立即返回
       └─ 派生桥接任务（§3.1）订阅 broadcast
```

### 5.2 崩溃自愈时序（接入后的产品行为，**变化点**）

```
harness 崩溃
 ├─ Crashed{restart_count=1, next_backoff=500ms}  → 相位保持 Ready，提示「retrying in 500ms」
 ├─ sleep 500ms → Starting{attempt=2}            → 相位 Preparing/Starting
 ├─ …崩溃 → 1s → …→ 2s → …→ 4s → …→ 8s
 └─ 第 6 次崩溃（max_restarts=5 用尽）
      → Crashed{will_restart=false} → Failed{total_restarts=6}
      → 相位 Failed → 导航错误页（保留现有 plugin_fault / retryable 归因）
```

**最坏情况约 3.5 s 才看到错误页**（`0.5+1+2`，`max_restarts = SUPERVISOR_MAX_RESTARTS = 3`；见 §8 的裁决记录）。这是接入的**产品级代价**，不是 bug：
- 对「偶发崩溃」：用户**几乎无感**（0.5 s 后就恢复了）。
- 对「配置错误导致必然崩溃」：用户要多等 3.5 s 才看到归因。

**已采纳的取值与备选**（完整理由见 `crates/dsh-contracts/src/constants.rs` 的 `SUPERVISOR_MAX_RESTARTS`）：

| 取值 | 最坏见到错误页 | 取舍 |
|---|---|---|
| 2 | 1.5 s | 错误页来得快，但只够扛 2 次偶发崩溃 |
| **3（已采纳）** | **3.5 s** | 3 次重试足以渡过端口竞争/瞬时 IO，又把「必然崩溃」的等待压在 4 s 内 |
| 5（原默认） | 15.5 s | 最耐用，但配置类错误要干等 15 s 才见图文归因 |

### 5.3 停止序列与 `abort()` 语义 ⚠️ 边界

`Supervisor::stop()`（`supervisor.rs:343-357`）做三件事：置 `is_stopping` → `take()` 并 `terminate()` 活跃实例 → `handle.abort()`。

| 边界 | 风险 | 处置 |
|---|---|---|
| 在**退避 sleep 中** stop | `abort()` 直接杀掉协程，sleep 被打断 —— 行为正确 | 可接受 |
| 在**启动中**（spawn 到 ready 之间）stop | `abort()` 可能在 `Launcher` 内部中途丢弃 `RunningHarness`。孤儿防护由 Job Object / PDEATHSIG 兜底，但**这一步没有测试覆盖** | **需补**：接入时必须加一条「启动中 stop 不残留孤儿」的集成测试（可复用 `scripts/fault-inject.mjs` 的场景 A） |
| 用户主动 stop 后相位 | 现状是 `Stopped`；壳的 `stop()` 还会区分 `Idle` | 桥接任务须区分「用户停止」与「崩溃终止」——用 `is_stopping` 或 stop 前后置标志判定 |
| `stop()` 之后再 `start()` | `supervision_task` 已被 `take()`，`is_stopping` 会被重置 | 可重入，✅ |

### 5.4 退出守卫（`quit_guard`）不受影响

退出前「有没有会话在跑」靠 `launch_endpoint()` / `harness_port()`。接入后这两个从桥接任务维护的 `Running{endpoint}` 取值即可，**签名不变**。

### 5.5 安全模式链路（接入后必须回归）

`ensure_safe_mode_profile` 落盘 → `restart_in_safe_mode()` → `Supervisor` 带 `--profile desktop-safe-mode` → 子进程用 safe patch 启动。**依赖 §4.2**。
判据：安全模式启动后 `launcher.with_profile` 的等价物真的生效——建议断言 `--print-argv` 输出含 `--profile desktop-safe-mode`（CLI 已有该能力，见 `cli.rs` 的 `StartArgs::profile`）。

---

## 6. S6-1 与 S6-3：能力、触发条件、预期行为

这两条**不是接线的一部分，而是让接线安全的护栏**——它们的价值在接线之后才完全兑现。

### 6.1 S6-1 — `dsh-host` 零 Tauri 依赖闭包守卫

| 项 | 内容 |
|---|---|
| **能力** | 断言 `dsh-host` 的**传递依赖闭包**中不含任何窗口层 crate（`tauri*` / `wry` / `tao` / `muda` / `tray-icon` / `webview2*` / `gtk*`） |
| **为什么接线会压它** | L1 调 L2 时，最省事的「修法」是把壳需要的东西（`AppHandle`、`Emitter`）塞进 `dsh-host`。Tauri 类型一旦渗进 L2，`dsh-host` 就**不能再在没有窗口系统的机器上独立测试**（INV-6 失效），**且编译不报错** |
| **触发条件** | 每次 PR、每日定时、发布前 preflight（`tiers: ['fast','ci','release']`）；零成本——直接读根 `Cargo.lock` 建图，**不调 cargo、不联网** |
| **预期行为** | 通过 → `dsh-host 闭包 90 个包，零窗口层依赖`；违规 → `exit 1` 并逐条点名 |
| **实现** | `scripts/verify-dsh-host-headless.mjs`（已落地，见 §8） |
| **可证伪** | ✅ 已实证：在 `crates/dsh-host/Cargo.toml` 临时加 `tauri.workspace = true` 并重新解析 lock → `exit 1` 且点名 **18 个**窗口层 crate（含只看得见两跳的 `gtk`/`tao`/`wry`/`webview2-com`） |

### 6.2 S6-3 — Supervisor 状态机性质测试

| 项 | 内容 |
|---|---|
| **能力** | 随机采样 + **自动收缩**，断言五条不变式：退避单调且**有上限**、退避**几何公式正确**、`mult>1` 时**有限步收敛**、断路器在**有限次**内开路、重启次数**有界**、**无非法相位转移** |
| **为什么接线要它** | 接线后状态机**真的在跑**（桌面壳每次崩溃都经过它）。举例式测试只能证明「这几个点对」，覆盖不了 `Duration`/`f64`/`usize` 的连续空间 |
| **触发条件** | 随 `cargo test` 进 fast 档；无头、无 I/O、**0.04 s** |
| **预期行为** | 失败时 proptest 打印**最小反例**（含完整参数与推演序列） |
| **实现** | `crates/dsh-host/tests/supervisor_properties.rs`（已落地，见 §8） |
| **可证伪** | ✅ 已实证：注入「去掉上限钳制」→ 4 条测试变红（`退避 8.57s 超过上限 2.327s`）；注入「断路器恒真」→ 3 条变红（`重启次数无界`）。两类均打印最小反例 |
| **副产品** | proptest **首轮就证伪了我写错的两条不变式**：① 「任意 `mult` 都收敛」——错，`mult==1.0` 是常量退避；② 「128 步内必收敛」——错，那是魔数，几何序列需要 `⌈ln(max/init)/ln(mult)⌉` 步 |

---

## 7. 异常与边界情况清单

| # | 场景 | 预期行为 | 依赖 |
|---|---|---|---|
| E1 | 崩溃 → 退避中用户点「重试」 | `restart()` 先 `stop()`（打断退避）再 `start()`；不得出现两个实例 | §5.3 |
| E2 | 退避中用户关闭窗口 / 退出 | `is_stopping` 置位 → 协程退出；`quit_guard` 用 `launch_endpoint()` 判断 | 现有链路 |
| E3 | 启动中（spawn→ready 之间）`stop()` | 不得残留孤儿进程 | **需补测试**（§5.3） |
| E4 | `max_restarts` 用尽 | 进 `Failed` + 错误页；`plugin_fault` / `retryable` 由 `diagnostics` 归因填充 | 现有 `FailureCause` |
| E5 | 安全模式启动 | 必须真的带 `--profile desktop-safe-mode` | **§4.2 阻塞** |
| E6 | `DSH_HOME` 等 C2 契约环境 | 必须到达子进程，可写状态落 `app_data_dir` | **§4.1 阻塞** |
| E7 | 桥接任务与 `emit` 的死锁 | `emit()` → `snapshot()` 会再次加同一把 `Mutex`；现有代码用「块作用域先释放 guard」规避（`state.rs:266-269` 有注释）。桥接任务里**必须沿用同一纪律** | 现有约定 |
| E8 | `broadcast::Receiver` 的行为 | **不能 clone**（每 receiver 独立游标）；桥接任务必须**单一累加器**，且要处理 `Lagged`（容量满时丢消息）——丢的是状态提示而非日志，可接受，但**必须显式处理而非 unwrap** | 实测 |
| E9 | `stable_uptime == 0` | `uptime >= 0` 恒真 ⇒ 每次崩溃都重置退避与计数 ⇒ **退避永不增长、断路器永不开路**（无限重启） | **§4.5** |
| E10 | `backoff_multiplier < 1.0` | 退避**递减** ⇒ 未设防的配置面（已在 `supervisor_properties.rs` 里显式登记为已知缺口） | 待裁决 |
| E11 | `mult == 1.0` | 常量退避（合法退化配置），只承诺有界、不承诺收敛 | 已覆盖 |

---

## 8. 落地情况（P1~P5 全部完成，2026-10-11）

### 已完成

| # | 项 | 产出 | 验证 |
|---|---|---|---|
| **S6-1** | `dsh-host` 零窗口层依赖守卫 | `scripts/verify-dsh-host-headless.mjs`（登记进 `gate-manifest.mjs`，fast/ci/release） | 自检 24/24；真检查 90 包零违规；注入 `tauri` → exit 1 点名 **18** 个 |
| **S6-3** | Supervisor 性质测试 | `crates/dsh-host/tests/supervisor_properties.rs` + `proptest` dev-dep | 9/9（0.04 s）；注入「去掉上限钳制」→ 4 条红、注入「断路器恒真」→ 3 条红，均打印最小反例 |
| **P1** | `SupervisorConfig` 补 `env` / `profile`，`extra_envs` 从**死字段**变为真生效 | `crates/dsh-host/src/supervisor.rs` 的 `resolve_launch_env` | 单测 4 项（四种情形）+ `tests/supervisor_env_profile.rs` 2 项（**子进程真的收到** `DSH_MOCK_FAIL`；`argv` 里真的有 `--profile`） |
| **P2** | 修 `stable_uptime == 0` ⇒ 退避与断路器同时失效 | 抽纯函数 `is_stable_uptime` 并显式排除零值 | 回归锁 `zero_stable_uptime_never_counts_as_stable`；**可证伪**：回退后只有它变红 |
| **P3** | `HarnessSupervisor` 改为 L2 适配器 + 状态桥 | `src-tauri/src/state.rs`（公开方法面零改动） | 编译通过 + `classify_state` 映射单测 5 项；**执行者是 CI**（本机 GNU 工具链无法加载该测试二进制，见 `docs/incidents/local-toolchain-limits.md`） |
| **P4** | 「启动中 stop 不残留孤儿」集成测试 | `crates/dsh-host/tests/supervisor_stop_orphans.rs` | 通过（1.72 s）；**可证伪**：跳过 `abort()` 后真的产生孤儿（pid 存活），测试精确报出 |
| **P5** | ADR 登记 | [ADR-064](adr/064-shell-adopts-l2-supervisor.md)（+ `docs/adr/README.md` 索引） | — |

### 裁决记录（P3 的两个待定项）

| 项 | 取值 | 理由 |
|---|---|---|
| `max_restarts` | **3**（契约常量 `SUPERVISOR_MAX_RESTARTS`） | 区间 [2,5] 的中值。最坏「崩溃 → 见错误页」= `0.5+1+2` = **3.5 s**；3 次重试足以渡过端口竞争/瞬时 IO，又把「必然崩溃」的等待压在 4 s 内 |
| 是否接受「崩溃不再立刻进错误页」 | **接受** | 这正是 L1 采用 L2 的目的；偶发崩溃用户几乎无感（0.5 s 后即恢复） |

### 仍然存在的残余风险（如实记录）

| 风险 | 说明 | 缓解 |
|---|---|---|
| GUI 路径**本机无法执行自动化测试** | `cargo test -p dsh-desktop` 在 GNU 工具链下于 DLL 加载阶段失败；快档的 `cargo test` 也**刻意排除** `dsh-desktop` | 断言由 CI（MSVC）执行；行为另有 `smoke.yml`（手动）覆盖 |
| `classify_state` 的 5 条断言尚未在本机跑过 | 同上——只验证了编译 | CI 首次运行即为验证点 |
| 桥接任务的迟到状态 | 用**代号**而非时序假设防御（每次启动自增） | 幂等：迟到状态在代号不符时直接丢弃 |

