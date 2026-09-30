# AGENTS.md

> 面向开发人员与 AI Agent 的 `dsh-desktop`（DeepSeek Harness 桌面壳）协作指南。

> ⚠️ **能力口径**：每个特性必须区分五种状态——**已接线 / 未接线 / 未实现 / 计划中 / 已归档**（词表见 §7.3）；不在「已接线」之列的**不得对外呈现为可用能力**，判据见 §7。

> 📖 **本文件是「规则手册 + 索引」**：历史复盘与操作细节已外移。
> - 命令速查（含全部 npm script 名）→ `docs/commands.md`
> - 发布步骤 / 版本 / CI / 双上游通道 → `docs/release-runbook.md`
> - 「已修复，勿回归」事故档案 → `docs/incidents/`，逐条见 §4

---

## 1. 项目概述与仓库结构

`dsh-desktop` 是基于 **Tauri 2.0** 与 **Rust** 的 DeepSeek Harness 跨平台桌面外壳，负责内置 Node.js + Harness 运行时的生命周期管理，并提供 GUI 承载与崩溃自愈。

- **`crates/dsh-contracts`**：无 GUI 的通用契约库（常量、错误码、IPC 封套、JSON-RPC 2.0 唯一契约源）。
- **`crates/dsh-host`**：无 GUI 纯 Rust 核心宿主（子进程派生、孤儿防护、就绪探测、Supervisor、崩溃诊断、脱敏诊断包、日志读取、Safe Mode、Profile/Session）。**INV-6：严格 headless。**
- **`crates/dsh-host-cli`**：命令行前端（`start|status|stop|tail|probe|doctor`），**INV-6 的兑现载体**；仓库内使用，**不作发布产物**。
- **`src-tauri`**：Tauri 桌面应用层（窗口/生命周期/IPC/自动更新/安全模式/LAN 手机桥/日志查看器/托盘/反馈）。
- **`build/`**：运行时启动脚本与安全防护注入。
- **`scripts/`**、**`patches/<target>/`**、**`packages/<target>/`**：组装/门禁/打包工具链，与按通道分目录的补丁、vendored 包。
- **`docs/`**：架构设计、契约定义、不变量与技术规范。

> 📖 **完整目录划分见 `docs/incidents/repo-structure.md`。**

---

## 2. 常用命令速查

> 📖 **完整命令速查表见 `docs/commands.md`**——原 §2 内容原样迁入，**npm script 名字一个都没丢**。
>
> 高频：`npm run dev`、`npm run build`、`cargo test -p dsh-contracts -p dsh-host -p dsh-host-cli`（无头门禁，INV-6）、`npm run verify:claims` / `verify:plan-facts`。

---

## 3. 架构边界与核心不变量

1. **无头核心库隔离（`dsh-contracts`、`dsh-host`）**：严禁依赖 Tauri、UI 框架或窗口系统；核心库测试必须能在无显示器、无预组装资源包的 CI 下独立通过。判据：**它能不能在没有窗口系统的机器上被测试？** 能就放无头 crate，不能才放 `src-tauri`。
2. **契约与常量集中管理（`dsh-contracts`）**：所有硬编码字符串、超时、退避、缓冲区、正则、探测常量**必须**统一定义在 `constants.rs` 并带 `CX-` 编号；**严禁**在业务逻辑里硬编码超时、路径或 URL。JSON-RPC 2.0 消息模型的**唯一定义点**是 `rpc.rs`（`transport.rs` 仅 re-export）；**严禁在任何 crate 内重复定义协议类型**（该冲突已于 2026-09 修复）。⚠️ 该协议**当前无运行时消费者**。
3. **孤儿进程防护与进程管理（INV-3）**：Windows 用 Win32 `JobObject`（`KILL_ON_JOB_CLOSE`）；Linux 用 `PR_SET_PDEATHSIG` + 进程组；macOS 用进程组 + **Node 侧父死看门狗**（`build/parent-death-watchdog.mjs`，**入口与 `mock-harness.mjs` 共同引用**）+ 启动时退出扫描清理。**主程序异常崩溃或退出时子进程不得残留。**
4. **生命周期监督与自愈（Supervisor）**：状态机 `Stopped -> Starting -> Healthy -> Degraded -> Crashed`；心跳探活、自愈重启、重启退避与断路器，防止无限崩溃循环。
5. **插件分级进程隔离与熔断自愈（Tier 0/1/2）**：不可信插件运行于沙箱 Worker / 子进程（JSON-RPC 2.0），连续故障计数与熔断看门狗使插件级崩溃自动隔离并降级进 Safe Mode。**（该实现已归档；当前插件防护只有进程内 `formatFaultDetails`，见 §7.2。）**
6. **日志环形缓冲与编码容错**：stdout/stderr 经 `LogRing` 缓冲并落盘（`harness.log`、`app.log`）；优先 UTF-8、Windows 回退 GBK，并过滤 ANSI 逃逸序列（`sanitize_line`）。

---

## 4. 平台兼容性与避坑指南

- **Rust 工具链**：**唯一产地是 `Cargo.toml` 的 `rust-version`**（当前 `1.90`；Tauri 2.12 起上调，旧值 1.85 源于 `idna_adapter` 的 edition 2024）。README 的「前置条件」与此同步。
- **Tauri 资源校验**：全新 checkout 在 `cargo check`/`cargo test` 前先跑 `node scripts/stub-tauri-resources.mjs`。
- **Node 执行路径**：产物运行内置 `src-tauri/resources/node/` 下的 Node（Windows 带 `.exe`）。
- **页面跳转**：Webview 先加载 `frontend/index.html` 启动屏并监听 `harness://status`；Token 就绪后由 Rust 导航到本地 Harness 页。

> 🗂️ **「已修复，勿回归」事故档案已按主题外移到 `docs/incidents/`**（内容原样保留；新家含完整根因、修法与守卫）：
> - Windows 打包与启动 → `win32-packaging.md`
> - 契约形状与 IPC → `contract-shape.md`
> - 补丁与上游 → `patch-and-upstream.md`
> - 发布与 CI（静默缺陷 / 清理否决结论 / 镜像清单 / 变更基线）→ `release-and-ci.md`
> - 体积与平台变体（optionalDependencies 翻倍 / linuxdeploy 复发）→ `packaging-size-and-platforms.md`
> - 进程与孤儿防护（macOS 父死看门狗）→ `process-and-orphan.md`
> - 桌面壳与托盘（`menu.rs` 两条前提被证伪）→ `desktop-shell-and-tray.md`
> - 本地工具链限制（Clippy ICE / GNU 下测试二进制加载失败）→ `local-toolchain-limits.md`
> - 仓库结构与路线图 → `repo-structure.md`、`roadmap.md`
> - 本文件被精简章节的原文快照（§3 / §4 前言 / §6）→ `agents-md-original-sections.md`

---

## 5. 架构演进与路线图 (P0~P4)

> 📖 **P0~P4 各阶段与归档裁定见 `docs/incidents/roadmap.md`。**（P2/P3 🗄️ 已归档删除。）

---

## 6. 修改敏感模块前必读文档

- `docs/roadmap.md`：**顶层路线图**（定位与边界原则、阶段 H0~H3）；定位与裁决冲突以它为权威。
- `docs/dev-plan-hardening-and-differentiation.md`：近端施工计划（H0）——风险 R1~R9 与批次 H~N。
- `docs/dev-plan-0.2-hardening.md`：产品/分发侧增补（0.2-A~D）；与 H0 的冲突裁决归用户。
- `docs/dev-plan-disconnected-points.md`：上一阶段主计划（批次 A~G 已闭环）——断线点 D1~D11 与裁决记录；「插件禁用语义」证据链在此。
- `docs/dev-plan-cli-distribution.md`：CLI / runtime 可引用产物分期；**动 CLI 发布形态前先读它**（§5 退役评估）。
- `docs/dev-plan-defect-remediation.md`：**缺陷治理专项**（批次 S0~S7，2026-09-30 起）——D1~D12 缺陷清单、可证伪判据、C1~C8 裁决与执行台账；动 S 批次任何条目前先读它。
- `docs/adr/`：架构决策记录库（44 篇，编号有空洞属正常——被否决的编号不复用）；新能力先写代码、再按 `docs/adr/README.md` 登记。
- `docs/dsh-desktop-redesign-architecture-and-plan.md` 与 `docs/system_design.md`：系统重构设计与架构 / 缺陷 / 契约细则。
- `docs/archive/model_gateway_design.md`、`docs/archive/plugin_isolation_architecture.md`：**已归档**，仅在追溯设计意图或评估恢复时读。
- `crates/dsh-contracts/src/constants.rs`（契约常量）、`errors.rs`（错误码 + `AppError`）、`ipc.rs`（`IpcEnvelope<T>` + 形状测试）、`rpc.rs`（JSON-RPC 唯一契约源，⚠️ 无运行时消费者）。
- `crates/dsh-host/src/diagnostics_export.rs`（脱敏诊断包；新规则必须补正反用例）、`transport.rs`（IPC 抽象，RPC 类型 re-export）。
- `src-tauri/src/commands.rs`：**IPC 命令面模块文档**——准入纪律、`CommandResult` 两层结构、外层 `Result` 恒为 `Ok` 的理由。动命令前先读。
- `scripts/verify-shell-pages.mjs`：改 `src-tauri/frontend/` 任何页面后必跑；新增检查项按文件头格式登记。

---

## 7. 宣称纪律（Claim Discipline）

**背景**：外部评审（2026-09）指出 README / 文档宣称的能力与实际代码存在落差。逐项核对后有 4 项宣称在代码中**没有运行时路径**：插件分级隔离、多模型工具网关、一键诊断包、LAN 手机桥（批次 A~G 已全部处置）。这不是「文档写早了」的程度问题——`plugin_worker.rs::call_tool` 当时会**返回伪造的成功结果**（`success: true`），即上层无法通过任何观测手段发现插件工具其实根本没被执行。

> 📌 **该文件已删除**（2026-09-10 批次 F 冻结并归档）。上面这段保留为**历史记录**：它记录的是这套纪律为什么存在，不是当前代码状态。查当前状态请看 §7.2。

### 7.1 三条硬规则

1. **未接线的能力必须显式标注**。任何「已实现但无运行时调用方」的模块，必须在其模块文档头部加 `⚠️ 状态：未接线` 横幅，并在本表登记。禁止用「已实现」「已支持」等词描述未接线能力。
2. **禁止伪造成功**。桩实现若被调用，必须返回**可辨识的错误**，不得返回 `Ok` / `success: true` / 空数组等合理默认值。判据：调用方能否从返回值区分「成功」与「未接线」。**2026-09-10 起这条同时约束 IPC 面**：失败必须是封套里的 `success: false` + 稳定 `error.code`，而不是裸 `false`——恢复页四个按钮「点了没反应」的根因就是静默的 `false`（改为 `E7002` 后页面才能如实报错）。
3. **禁止无声降级**。允许降级（如补丁分级失败策略），但必须把降级事实写进产物：`MANIFEST.json` 的 `patches[]` 逐条记录 `applied / skipped / failed`，缺记录即视为未应用。**同一规则适用于诊断包与日志查看器**：脱敏命中次数写进包内 `README.txt`；日志被截断时 `truncated` 必须如实上报。

### 7.2 宣称能力 ↔ 代码证据对照表

| 对外宣称 | 状态 | 代码证据（唯一产地） | 运行时调用方 |
|---------|------|-------------------|------------|
| 内置 Node + Harness 生命周期管理 | ✅ 已接线 | `crates/dsh-host/src/launch.rs` | `src-tauri/src/lib.rs` setup |
| 孤儿进程防护（INV-3） | ✅ 已接线 | `crates/dsh-host/src/process.rs`（Win32 JobObject / POSIX） | `launch.rs` 派生路径 |
| URL / Token 捕获与就绪探测 | ✅ 已接线 | `readiness.rs`、`token.rs` | `state.rs::on_ready` |
| Supervisor 自愈与退避 | ✅ 已接线 | `crates/dsh-host/src/supervisor.rs` | `state.rs` 生命周期回调 |
| Safe Mode 隔离 Profile | ✅ 已接线（2026-09-10 补完启动链路） | `crates/dsh-host/src/safe_mode.rs`（profile 落盘）+ `args.rs::profile_patch` / `launch.rs::with_safe_mode`（**启动时选中**：`--profile desktop-safe-mode` + `build/dsh-desktop-safe.patch.yml`） | 错误页 `/safe_mode_action` → `commands.rs`、菜单 `harness-safe-mode` → `menu.rs` |
| ↳ Safe Mode 的界面反馈（横幅） | 🕓 **计划中**（刻意后置） | 上游靠 preload 往 Harness 页注入安全模式横幅（`mountSafeModeBanner`，含「卸载插件 / 退出安全模式」两个按钮）；本仓界面**看不出**当前处于安全模式 | 无（**待软件功能稳定后再开发**，非阻塞项） |
| 崩溃归因诊断（**结论**，非压缩包） | ✅ 已接线 | `crates/dsh-host/src/diagnostics.rs` | `dsh-host-cli doctor`、错误页 |
| 插件故障归因（进程内） | ✅ 已接线 | `build/plugin-safety-guard.mjs:formatFaultDetails`（:25，export :154） | `build/harness-node-entry.mjs:15,37,44` |
| **插件分级隔离 Tier 0/1/2** | 🗄️ **已归档（2026-09-10 批次 F：冻结并归档）** | 代码已删除（`plugin_worker.rs`、`plugin-worker-host.mjs`、`PluginWorkerClient`）；设计文档在 `docs/archive/plugin_isolation_architecture.md`。它此前**从未接线**，且不在真实插件挂载路径上 | **无**（且永远不会走这条路：真实挂载在 Harness 进程内的官方 Cordis 体系） |
| ↳ 插件安全（**当前实际生效的那一条**） | ✅ 已接线，**但只在进程内** | `build/plugin-safety-guard.mjs:formatFaultDetails` | `build/harness-node-entry.mjs` 的未捕获异常/拒绝处理器。**同进程的插件崩溃仍可能带走 Harness**——不得表述为「插件崩溃不拖垮主程序」 |
| ↳ **已知缺口：安全模式不隔离插件**（2026-09-22 登记，口径见 [ADR-051](docs/adr/051-archived-capability-known-gap.md)） | 🗄️ **归档能力的已知缺口**（**已裁定接受**：不是欠债、不是计划中——四字段见右侧；登记在归档行下是因为它**只能由恢复 ADR-040 的能力才能修**） | **缺口**：进安全模式**不会**隔离任何第三方插件。安全模式只换 profile 与 patch 层（C10），而插件挂载由 Harness 进程内官方 Cordis 体系按 `profiles/.generations/desired.json` 投影决定，**投影不读 profile**——坏插件在安全模式下照常加载，仍可带走 Harness。**判据**：真实挂载点在官方 loader 上，本仓够不着，硬接即再造假设施（ADR-040）。**恢复前提**：官方 loader 暴露可挂载隔离点（前置条件同 ADR-040 后果段）。**现场级证据**：`[harness-node] generation projection: … bundles=[…]` 列出的挂载清单在安全模式下**不变**（含第三方），`web boot: N entries did not activate` 同理照旧出现 | **无**（**并禁止用特例分支绕开**：在 `projectGenerations()` 里加「安全模式就跳过插件」= 在 `desired.json` 之外另立第二权威，ADR-007 所禁）。完整登记在 `docs/archive/plugin_isolation_architecture.md`「已知缺口」段 |
| **多模型工具网关** | 🗄️ **已归档（2026-09-10 批次 F）** | crate 已从 workspace 删除；设计文档在 `docs/archive/model_gateway_design.md`（文首有归档说明与恢复判据） | **无** |
| **一键脱敏诊断包 `diagnostics.zip`** | ✅ **已接线（2026-09-10 批次 D）** | `crates/dsh-host/src/diagnostics_export.rs`（5 类脱敏规则：launch token / `dsh-auth-*` cookie / 路径用户名段 / API key / 代理口令；每条有正反用例 + 端到端「产物内无原文」断言）；产物落 `app_data_dir/exports/` | 命令 `diagnostics_export` ← 错误页「导出诊断包」按钮、`logs.html` 同功能按钮、菜单「Harness → Export Diagnostics…」（三者都显示产物路径） |
| LAN 手机桥（扫码配对 + cookie 握手） | ✅ 已接线 | `src-tauri/src/mobile_bridge.rs`、`state.rs::sync_mobile_target`（:352）、`menu.rs` 手机子菜单 | 应用菜单 `mobile-pair` / `mobile-stop` |
| 壳层结构化日志 `desktop.log` | ✅ 已接线 | `src-tauri/src/logging.rs::init`（:46） | `src-tauri/src/lib.rs:70` |
| 补丁分级与失败降级 | ✅ 已接线 | `scripts/patch-layers.mjs`（分级表按**包名**索引）、`patches/LAYERS.md`、`prepare-harness.mjs` | 构建期；结果落 `MANIFEST.json:patches[]`（含 `target` 字段标明通道） |
| **双上游运行时通道（next / alpha）** | ✅ 已接线（2026-09-15；**alpha 线 2026-09-30 起休眠**——[ADR-056](docs/adr/056-alpha-channel-dormant.md)：机制与目录保留，不发布、不追漂移，`status` 字段是唯一产地） | `scripts/dsh-targets.mjs`（目标总表）+ `patches/<target>/`、`packages/<target>/`、`harness-deps/<target>/` | `prepare:harness -- --dsh-target=<name>`；`release.yml` preflight 从 tag 的预发布通道名推导目标（未知通道**与休眠通道**直接失败）；`smoke.yml` 有 `dsh_target` 输入；`verify:patches` 逐目标检查、`verify:drift` 逐通道对照 dist-tag（休眠目标显式跳过）。见 §8.6 |
| ↳ 补丁行号重算（移植到另一条上游线时） | ✅ 已接线 | `scripts/recount-patches.mjs`（重生成，依赖 git）+ `scripts/relocate-patch-hunks.mjs`（只改 `@@` 行、原文保真、无外部进程）**二选一** + `check-patch-applicability` 的 ±20 窗口判据 | 升级/移植工序；`patch-package` 按行号定位且偏移超 ±20 行即失败，只按内容搜索的预检会漏报。**同一份补丁只用一条路径**——见 §8.6 |
| **统一 IPC 封套 `IpcEnvelope<T>` + 错误码总表** | ✅ **已接线（2026-09-10 批次 E）** | `crates/dsh-contracts/src/ipc.rs`（`IpcEnvelope<T>`，`error` 载荷为 `AppError`）+ `src/errors.rs` 的 `codes` 模块（`E1xxx`~`E7xxx`，族号↔类别有测试） | `src-tauri/src/commands.rs` 的 **20 个命令全部**返回 `CommandResult<T>`；五个页面（error / plugin-recovery / logs / updates / feedback）均解包 `success` |
| ↳ 命令面 `Result` 语义 | ✅ 已接线 | `commands.rs::CommandResult` 文档注释 + 测试 | 外层 `Result` **恒为 `Ok`**（Tauri 编译要求）；语义全在内层封套。**返回 `Err` 会丢掉错误码**，属违规 |
| **自动更新链路** | ✅ 已接线（2026-09-10 批次 B 闭环） | `src-tauri/src/update.rs` + `tauri-plugin-updater`（`lib.rs:58`、`UpdateManager` 构造于 `lib.rs:145`）；`tauri.conf.json` 开启 `bundle.createUpdaterArtifacts` | 菜单 `updates-check` → `window::show_updates_page` + `UpdateManager::check(true)`；`frontend/updates.html` 调 `updates_status` / `updates_check` / `updates_download` / `updates_install` / `updates_skip` 并监听 `updates://status` |
| ↳ 更新源归属与签名密钥 | ✅ 已闭环（2026-09-10；**端点 2026-09-30 通道化**，见 [ADR-053](docs/adr/053-channelized-updater-manifest.md)） | 端点按通道指向滚动 Release（`releases/download/updater-<channel>/latest.json`），**URL 的唯一产地是 `scripts/updater-manifest.mjs`**，由 `tauri build --config` 在构建期注入（`tauri.conf.json` 只留默认值）；配置里的 `pubkey` 与 `~/.tauri/dsh-desktop.key.pub` **逐字节一致** | 私钥经 CI Secret `TAURI_SIGNING_PRIVATE_KEY` 注入（无口令），本地离线备份在 `~/.tauri/backup/`。发布后由 `verify:update-channel` 断言「端点 version ≥ 该通道最新 tag」 |
| **应用内日志查看器** | ✅ **已接线（2026-09-10 批次 D）** | `frontend/logs.html` + `crates/dsh-host/src/logs_view.rs`（三来源，尾部读取，**截断如实上报 `truncated`**） | 菜单「Harness → View Logs…」→ `window::show_logs_page`；页面调 `logs_read` / `open_logs` / `diagnostics_export` / `harness_open`。「Reveal Log Folder」保留为次入口 |
| **错误页「安全模式」按钮** | ✅ 已接线（2026-09-10 修复调用名；同日补完启动链路） | `src-tauri/frontend/error.html` 调 `safe_mode_action`（`action: "restart"`），失败经 `fail()` 可见上报 | 错误页按钮 → `commands::safe_mode_action` → `HarnessSupervisor::restart_in_safe_mode`（此前调 `restart()`，实际只是**普通重启**——按钮曾是谎话） |
| **恢复页交互** | ✅ **已接线（2026-09-10 批次 C）** | `plugin-recovery.html` 调 `recovery_status` / `recovery_action`（`restart` / `safe-mode` / `show-log` / `quit`）并**检查封套 `success`**；监听 `harness://status` 反映恢复进度 | 错误页「插件恢复…」按钮 → `recovery_open` → `show_recovery_page`。数据来自 `dsh_host::diagnostics`（此前零消费者的那条链） |
| ↳ 插件卸载 / 禁用 | 🕓 **计划中**（依据上游是否提供停用语义） | **无代码，且刻意不实现**：经核验，市场安装的插件没有真正的可逆解除挂载方式——改名会被冷启动投影还原，改 `desired.json` 会触发 `sweepRegistry()` 真删目录（证据链见 `docs/dev-plan-disconnected-points.md` §3 批次 C） | **无**。恢复页只提供非破坏性动作；未知动作返回 `E7002` 而非静默 `false` |
| **`safe-mode.html`** | 🗄️ **已删除（2026-09-10 批次 C）** | 页面 + 资源 + 配置项一并移除；`window::show_safe_mode_page` 同步删除 | **无**。它的每处交互都要求「插件移除」后端（上文已裁定不做），接上只会交出「其余按钮仍读空气」的页面；其独有能力（进安全模式）已由错误页 / 恢复页 / 原生菜单三处覆盖 |
| 手机桥状态可见性 | ✅ 已接线（2026-09-10） | `src-tauri/src/menu.rs` 的 `Phone` 子菜单状态行 + `mobile_bridge::status_label`；`MobileBridge::on_connected_change`（镜像上游 `onConnectedChange`）在配对状态翻转时回调 | 菜单构建时初始化，**手机侧 `POST /pair` 成功**、菜单配对/停止时均经 `refresh_bridge_status` 刷新（`lib.rs` setup 注册监听器） |
| ↳ 页内手机状态指示器（Harness 侧边栏） | ✅ 已接线（2026-09-10） | `harness_ui.rs::INJECT_SCRIPT`（`include_str!` 内嵌 `frontend/harness-ui-inject.js`），挂在 `[data-dsh-sidebar-settings]` 下；状态下发 `push_phone_status` 走 `webview.eval`，**不新增 IPC 命令** | 两个推送点：连接翻转（`on_connected_change`）与页面加载完成（`on_page_load`）。**只做状态指示、不可点击**——配对/停止仍只走原生 `Phone` 菜单，因此它不渲染成按钮 |
| **Harness 页注入机制（preload 等价物）** | ✅ 已接线（2026-09-10；同期更正「无初始化脚本」的误判） | 主窗口 builder 的 `initialization_script`（`lib.rs`）+ `frontend/harness-ui-inject.js`；脚本按 origin 自我早退（本地页与子框架不注入） | 无头行为自测 `npm run verify:harness-inject`（19 项断言 + 可证伪性检查，已进 CI） |
| **CLI 打包与核验能力（`package-cli.mjs`）** | ✅ 已接线（2026-09-13；**发布通道于 2026-09-24 退役，本能力保留**） | `scripts/package-cli.mjs`（命名 / 边车 / manifest / 回读校验 / 产物执行自检 / 已发布核验），约 40 项可证伪判据；由 `ci.yml` 与 release `preflight` 的 `verify:cli-package` 守着 | **本地手动使用**（`npm run package:cli`）。🚫 **不再上传到 Release**：原 `release.yml` 的 `cli` / `cli-publish` job 已删除。依据「本仓之外零消费者 + 产物不含 runtime 不自足」，见 [`docs/dev-plan-cli-distribution.md`](docs/dev-plan-cli-distribution.md) §5。归档的 `scripts/dry-run-cli-publish.mjs` → `docs/archive/`。**crate 与打包脚本不得随之删除**——守卫 `checkCliCrateRetained` 守着这一点 |
| ↳ runtime bundle 独立发布（Phase 2） | 🕓 **计划中**（带触发条件，刻意不做） | **无代码**。门槛与前置改造写在 [`docs/dev-plan-cli-distribution.md`](docs/dev-plan-cli-distribution.md) §4：出现第一个非本仓消费者，或开工 H3-a 运行时更新事务 / H2-a 兼容矩阵时才做；提前单独做就是为「可能有用的未来」建基础设施（同批次 F 归档 `dsh-model-gateway` 的判据） | **无** |
| **系统托盘 + 关窗驻留** | ✅ **已接线（2026-09-18 批次 0.2-B1）** | `src-tauri/src/tray.rs`（图标 / 菜单 / 事件 / 状态行）+ `window.rs::reveal_main_window`（show → unminimize → focus 三步）；图标资产 `icons/tray-32.png` 与 `icons/tray-template.png` 由 `scripts/generate-tray-icons.mjs` 派生；`tauri` 开 `tray-icon` feature（`Cargo.toml`） | `lib.rs` setup 建托盘（失败只记日志、启动继续）；`on_window_event` 的 `CloseRequested` 改为 `prevent_close` + `hide`；菜单事件与应用菜单**共用** `menu::handle_menu_event` 与同一批 id。**无自动门禁**：托盘区在 CI 容器里不存在，验收靠三平台手工（见 §2 与 0.2-B1 记录） |
| ↳ 驻留期的退出语义 | ✅ 已接线 | `lib.rs::shutdown`（先收手机桥、再收 Harness）；`menu.rs` / `commands.rs` 的 Quit 与 `app_quit` 均先 await 它 | 托盘 / 应用菜单 / 错误页三处 Quit。**为什么必须做**：`app.exit()` 不经过 `CloseRequested`，不先停机就只能由 JobObject / PDEATHSIG 强杀子进程 |
| ↳ 托盘后端缺失时的降级 | ✅ 已接线（2026-09-18，**防启动期回归**） | `tray.rs::appindicator_available`（Linux 用 `dlopen` 探 `libayatana-appindicator3.so.1` / `libappindicator3.so.1`）+ `catch_unwind` 兜底 | `create()` 在任何 `dlopen` 失败 / panic 时返回错误而不 panic；`lib.rs` 只记 error 日志，**应用照常启动**，关窗行为自动退回「关窗即退出」。理由：`libappindicator-sys` 用 `Lazy<Library>` + `panic!`，不先探测会把整个应用带崩 |
| **应用内反馈入口** | ✅ **已接线（2026-09-18 批次 0.2-D2）** | `src-tauri/src/feedback.rs`（`Channel` 四值白名单 + `context()`）+ `frontend/feedback.html` + `crates/dsh-contracts/src/constants.rs` 的 **CX-13** 四个渠道 URL + `crates/dsh-host/src/runtime_manifest.rs`（从 `MANIFEST.json` 读通道 / DSH 版本 / 补丁统计） | 命令 `feedback_context`（页面取版本与路径）、`feedback_open`（打开页面，错误页按钮亦走它）、`feedback_channel_open`（白名单内打开浏览器）；菜单 / 托盘的「Send Feedback…」经 `window::show_feedback_page`。**应用自身不上传任何内容**——只读本机信息 + 调 `opener` |
| ↳ 反馈页的「该带什么」自述 | ✅ 已接线 | `feedback.rs::context()`（版本 / 平台 / 通道 / DSH 版本 / 补丁 applied-failed-skipped / 诊断包与日志目录）+ `runtime_manifest::RuntimeManifest::identity_line` | 读不到 `MANIFEST.json` 时**不报错**，改以 `manifest_readable: false` + `manifest_error` 如实上报（§7.1 规则 3）——反馈页恰恰是「安装可能坏了」时最需要打开的页面 |

### 7.3 维护方式

- 新增能力时：先写代码，再在本表补一行——**顺序不可颠倒**。
- 状态词只有五种，含义互不重叠，**不得混用**：
  | 状态 | 含义 |
  |------|------|
  | ✅ 已接线 | 有代码、有运行时调用方，用户可见 |
  | ⚠️ 未接线 | **代码已写但无运行时调用方**——这是「欠债」，必须登记销账批次 |
  | ❌ 未实现 | **代码不存在**——这是「缺口」，不得对外宣称 |
  | 🕓 计划中 | **代码不存在，且刻意不现在做**——这是「决策」，不是欠债。必须写明后置理由（通常是为等前置能力稳定） |
  | 🗄️ 已归档 | **曾实现，现已删除并裁定不做**——这是「结论」。必须写明归档判据；文档保留在 `docs/archive/` 供追溯设计意图 |
  「未接线」与「计划中」的区别是**有没有代码**：前者是写了没接（欠债），后者是还没写（决策）。把计划中说成未接线会误导读者去找不存在的代码；把未接线说成计划中则是在给欠债打掩护。
  「已归档」与「未接线」的区别是**代码还在不在**：归档是欠债已销账（删了，并给出不做的理由），未接线是债还挂着。**归档不是「计划中」**——不要用「以后可能做」来软化一个已经裁定不做的决定。
- 修改未接线模块时：必须同步删除其 `⚠️ 未接线` 横幅、更新本表状态。
- **归档一个模块时**：代码删除、文档移入 `docs/archive/` 并在文首写归档说明（判据 + 恢复前提），本表状态改 🗄️，`README` 对应表述同步收敛。**删除的文件名要写进本表**——否则下一个人只会看到「某个能力不见了」。
- **归档还要登记残留缺口**（ADR-051）：归档判据说明的是「为什么不做」，读者从中**推不出**「不做之后现在会缺什么」。若该能力有用户可感知的残留影响，必须在本表**归档行的 `↳` 子行**（不另起一行冒充新能力）按四字段登记——**缺口**（具体不会发生什么）/**判据**（为什么不修）/**恢复前提**（什么条件重开）/**现场级证据**（用户能看到的日志行或界面现象）。四项缺一不可。**缺口不得用代码补**：在单一权威之外加特例分支绕开缺口，属于 ADR-007 禁止的做法。
- 评审 / 发布前自查：`grep -rn "⚠️ 未接线\|未实现" AGENTS.md README.md docs/` 应只命中**确实未接线/未实现**的条目（归档项不在其中，它们改用 🗄️）。除真实欠债外，以下三类命中是**预期内**的，不要为消除它们而改写文本：
  1. **词表与纪律条文本身**（§7.3 的状态词表、README 的状态标记约定、本条的规则文字）；
  2. **历史盘点记录**——`docs/dev-plan-disconnected-points.md` §1 的 D1~D11 标题记录的是「盘点当时」的状态（该节开头有显式声明）。把它们改成「已修复」会让后来者看不出当初断在哪；
  3. 引用这些术语的规范文档（如 `dsh-upgrade-checklist.md` 的操作说明）。
- **跨语言断言必须可证伪**：新增「X 一定会发生」这类关于页面 / 脚本行为的断言时，按 `scripts/verify-harness-inject.mjs` 的模式配一段**变体回退检查**——把被守护的行为打回旧写法，断言必须变红，否则断言是装饰。同时守卫**不得依赖检出配置**（行尾、路径分隔符）：CRLF 检出下必须与 LF 表现一致。
- **「扫出来再校验」的门禁必须断言数量不为零**（2026-09-22，`E5-空` / ADR-051 附带发现）：凡是先从源码里扫出一组 X、再逐个校验 X 的守卫，必须同时断言**扫出的数量 > 0**。只断言「扫到的都合规」会容忍「一个都没扫到」——那等于门禁替一段**不存在的检查**背书，比漏报更危险（输出还是一行绿色）。触发条件是**写法变更**：入口加了一种新的 import 形态、表格换了一种列结构，扫描器不认了就静默归零。本仓已踩两次——`verify-claims` C3 的表格解析，与 `verify-harness-entry` E5 漏认 `specifier: './x.mjs'` 形态（后者修前在**零个受检模块**下全绿，而它守的正是「三份打包清单漏登记」这条 v0.7.0-alpha.1 真实事故）。**扫出数为 0 时，先怀疑扫描器，再怀疑源码。**
- **计划文档的预算纪律（2026-09-30 起，S2-2）**：新增任何计划类文档，必须同时归档或改写一份旧计划文档——在役 docs 总量不得只增不减；**计划文档无权延期或改写任何 ADR**，要改 ADR 只能走 superseding / 状态修订 ADR（ADR-055 之于 ADR-047、ADR-056 之于 ADR-052 是正确形态）。违反这条即视为文档回归。
- 与 B1 的联动：任何新增 `patch-package` 补丁必须同时登记进 `patches/LAYERS.md` 与 `scripts/patch-layers.mjs`，否则 `prepare-harness.mjs` 会以「未登记」告警并回退默认层。
- **本表只覆盖「契约 / 能力」级宣称**。比它更细一层的问题是「命令写了但没人调用、页面打包了但不可达」——那类断线在 Rust 里不可见（`src-tauri` 是 `rlib`，`pub` 项一律算「可达」，`dead_code` 永不触发），只能靠 `npm run verify:ipc-surface` 静态比对。该脚本的检查项、允许清单与「为什么必须有它」，写在脚本头部注释里，新增例外必须**在 `ALLOW_*` 里写明理由**。
  - 其中 **E7（菜单项 id ↔ `handle_menu_event` 分支）** 是批次 0.2-B1 新增的：托盘与应用菜单**共用同一批 id**，而「加了菜单项忘了接处理器」的后果是一个点了完全没反应的项——没有编译错误、没有日志、没有既有守卫能看见。`--self-test` 用三组夹具（缺分支 / 守卫式早退 / 注释里的 id）钉住该判定本身，已进 CI 与 release preflight。

---

## 8. 版本与发布（Versioning & Release）

> 📖 **8.1~8.5**（版本、变更日志、CI、发布步骤与 tag 清理）见 `docs/release-runbook.md`。

### 8.6 双上游运行时通道（next / alpha）

自 2026-09-15 起，本仓**同时维护两条上游运行时通道**，各自钉一个 DSH 版本、持有一套
补丁与 vendored 覆盖包：

| 目标 | 上游线（`channel`） | 固定的 DSH | 补丁 / vendored | 桌面后缀（`publishChannel`） | 对应的桌面版本形态 |
|------|--------|-----------|----------------|------------------|------------------|
| `next`（默认） | npm `next` dist-tag | `0.2.0-rc.2` | `patches/next/`（10 个）、`packages/next/`（已清空） | `rc` | `0.7.2-rc.1` |
| `alpha` | npm `alpha` dist-tag（2026-09-30 复役，[ADR-057](docs/adr/057-alpha-channel-restored-and-dual-promotion.md) 修订 ADR-056） | `0.1.7-alpha.2` | `patches/alpha/`（11 个）、`packages/alpha/`（已清空） | `alpha` | `0.7.2-alpha.x`（须大于最高 rc tag） |

> ✅ **next 线于 2026-09-30 从 `0.1.5-rc.3` 跨两个 minor 推进到 `0.2.0-rc.2`**（ADR-057 同批
> 恢复 alpha 在役并推进到 `0.1.7-alpha.2`）：预检 clean 2 / conflict 12，经
> `scripts/merge-migrate-patches.mjs` 三路合并 + 逐补丁语义裁定后，退役 6 个（两线合计：
> `ui-layout` / `ui-workspace` / `ui-agent-preset` 双线 + `ui-model-selection` 仅 next）、
> 语义重做 4 个；预设传递插件 `dsh-desktop-preset-transfer` 整链退役（上游把 preset roots
> 文件模型重铸为注册模型）。双线锚点现已各自对齐上游 dist-tag，`verify:drift` 不再告警。
> 逐条裁定见 [`patches/LAYERS.md`](patches/LAYERS.md) 的 2026-09-30 记录。

> **两条线的补丁数可以不同，这是正常的**：本轮退役后 next 10 个 / alpha 11 个——
> `ui-model-selection` 仅 next 退役（上游 0.2.0 自带搜索而 alpha 线尚无）。
> 补丁**净减少**是补丁退役机制想要的方向——不要为了「两条线一样多」而把退役的补丁加回去。

> 📖 通道解耦（`channel` vs `publishChannel`）、补丁行号重算与两条线的发布记录见 `docs/release-runbook.md` §8.6。
