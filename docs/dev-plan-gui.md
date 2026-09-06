# DSH Desktop GUI 打通与发布实施计划（P0–P5）

> 依据：`README.md` Features 声明 + 全仓库代码现状核对（2026-09-06）。
> 本文是《DSH Desktop Tauri 版实施计划 v2》（`.trae/documents/`，不在仓库）中 **阶段 2–7 的重排**：
> 原编号按「从零写新代码」假设计阶段；实际阶段 1（T01–T05）收尾时，大部分 GUI 功能代码已随
> `2d91067` 一次性移植落地，但 **`dsh-desktop` crate 从未编译成功、壳层从未运行验证**，且存在
> 两处 Electron 遗产页面与一处从未激活的桥接。故按「先能编译 → 先能跑 → 修断点 → 真引擎对齐 →
> 发布」重排为 P0–P5。
>
> 关联文档：[archive-phase0-1-2026-09-04.md](archive-phase0-1-2026-09-04.md)、
> [system_design.md](system_design.md)、[verification-phase1.md](verification-phase1.md)、
> [api-audit-src-tauri.md](api-audit-src-tauri.md)。
>
> **更新记录**：2026-09-06 建档。核对人为上一轮会话；能力矩阵与缺口清单均带 `file:line` 证据。

## 一、能力核对矩阵（README 声明 vs 代码现状 vs 状态）

| # | README 声称的功能 | 代码落点 | 状态（证据） |
|---|---|---|---|
| F1 | 打包内置 Node v24 + `@deepseek-ai/dsh` 依赖树 | `scripts/prepare-harness.mjs` | ⚠️ 幂等组装机制已 T05 验证；本机从未成功组装出 `resources/`（gitignored）；只在 CI runner 上跑过 |
| F2 | Harness 生命周期（spawn/端口/token/就绪） | `crates/dsh-host` + `src-tauri/src/state.rs`（`HarnessSupervisor` 状态机） | ✅ host 侧 170 测试全绿；**GUI 接线侧从未编译/运行** |
| F3 | 壳页 splash / error（重试/看日志/退出） | `frontend/index.html`、`frontend/error.html` | ⚠️ 已 Tauri 化（`__TAURI__.event.listen`、`invoke('harness_restart')` 等，见 `frontend/error.html`）；从未运行验证 |
| F4 | plugin-recovery 页（定位插件故障、定向移除） | `frontend/plugin-recovery.html`（与 `build/` 下 Electron 原件逐字节相同） | ❌ **Electron 遗产**：页面 JS 走 `location.href = 'dsh-recovery://…'`，全页 0 处 `__TAURI__`；该 scheme 在 Tauri 里不存在，且会被导航白名单拦截 |
| F5 | safe-mode 页（隔离 profile 恢复） | `frontend/safe-mode.html`（与 `build/` 原件相同） | ❌ **Electron 遗产**：调用 `window.dshSafeMode.action('apply'\|'restart'\|…)`，Tauri 无此 preload 注入 → 按钮点了无反应 |
| F6 | 桌面定制（patch-package + `patch.yml` 层） | `patches/`、`vendor/`、`build/dsh-desktop.patch.yml` → prepare-harness 应用 | ⚠️ 机制在；真实 dsh 树未端到端验证 |
| F7 | Mobile bridge（LAN 配对 / QR / RPC 转发） | `src-tauri/src/mobile_bridge.rs`（339 行 axum 完整实现） | ❌ **从未激活**：全库唯一调用点是 `lib.rs:59` `new()`、`lib.rs:141-147` 关窗时 `stop()`、`commands.rs:250` `snapshot()`；`start()`（:117）与 `set_harness_target()`（:85）**零调用方** |
| F8 | Safe mode 入口 | `src-tauri/src/safe_mode.rs` + 菜单项 + `commands.rs::safe_mode_action` | ⚠️ 菜单「Restart in Safe Mode」已接线可用；但目标页 `safe-mode.html` 本身是坏的（见 F5），命令只支持 `restart`/`quit` 两个 action |
| F9 | Plugin recovery 入口 | `src-tauri/src/recovery.rs`（`detect_from_logs`/`remove_plugin_from_profile` 完整） | ❌ **自动入口缺失**：`state.rs:318` `on_failed` 只调 `show_error_page`；`window.rs:46` `show_recovery_page` / `:56` `show_safe_mode_page` 定义存在但**零调用方** |
| F10 | 自动更新 | `src-tauri/src/update.rs` + updater 插件 + `tauri.conf.json` pubkey/endpoints | ⚠️ 代码完整，启动 10s + 6h 轮询已接线（`lib.rs:117-125`）；无签名私钥、无真实 release → 无法端到端 |
| F11 | 单实例 | `lib.rs:38-43` `tauri_plugin_single_instance` | ⚠️ 已接线；需装机后实测 |
| F12 | 安全：harness 页无 remote capability + 命令 origin 守卫 | `capabilities/main.json`（仅 `core:default`）、`commands.rs::ensure_local_origin` | ⚠️ 代码就位；从未动态验证（验证清单见 P1） |

**结论**：代码完成度约 85%，但分水岭是 **GUI crate 从未编译**；在它通过之前，F3–F12 的一切「声称」都未成立。

## 二、待解决缺口清单（G1–G6）

| # | 缺口 | 证据 | 归属 |
|---|---|---|---|
| G1 | `dsh-desktop`（GUI）crate 从未编译成功 | `archive-phase0-1` §四.1「编译挂起」；本机缺 `windres.exe` + `resources/` 未组装 | P0 |
| G2 | 壳层运行行为从未验证 | `verification-phase1.md` §3「GUI 层手工清单」全未勾选 | P1 |
| G3 | `plugin-recovery.html` / `safe-mode.html` 是 Electron 原件，IPC 通路不存在 | 两页与 `build/` 同名文件逐字节相同；`grep __TAURI__` = 0；`window.dshSafeMode.action` / `dsh-recovery://`（F4/F5） | P2 |
| G4 | 恢复/安全模式入口断线：Rust 有命令与检测逻辑，但无人导航过去，且命令 action 词表与页面按钮不对齐 | `window.rs:46/56` 零调用方；`commands.rs` `safe_mode_action`/`recovery_action` 只处理 `restart`/`quit`，页面要 `apply`/`uninstall`/`agent`/`recovery-open`/`show-log` | P2 |
| G5 | Mobile bridge 从未激活（构造即死代码） | `mobile_bridge.rs` `start()`/`set_harness_target()` 无调用方（F7） | P2 |
| G6 | 页面资产三处重复维护：`frontend/`（壳页，`tauri.conf.json` `frontendDist`）、`build/`（prepare-harness 源）、`resources/`（`prepare-harness.mjs:318-331` 另拷一份用于 bundle） | `frontend/` 与 `build/` 的 recovery/safe-mode 页 diff 为空 = 两份手工维护同一文件 | P3 |

## 三、实施计划

> 依赖链：`P0 → P1 → P2 → {P3 → P4} → P5`。P2 内部三项互不依赖可并行；P3 与 P4 均依赖 P1/P2 后产出的「真壳能跑」基线。

### P0 — GUI 编译门禁（解阻塞，最高优先）

**目标**：`cargo check/test/clippy --workspace` 全绿，让 GUI crate 首次进入可编译状态。

**要做**：
1. 补齐本机 GUI 构建前置：安装 MinGW-w64 binutils 提供 `windres.exe`（或按归档文档评估切 MSVC target）；`npm install` + `npm run prepare:harness` 首次组装 `resources/`（需网络）。
2. `cargo check -p dsh-desktop`，修掉全部真实编译错误。`docs/api-audit-src-tauri.md` 的静态 API 核对是纸面对照，编译会暴露它漏掉的问题。
3. 核对远端 CI：`ab4ea70` 起的 main 分支 Actions 是否全绿（CI 的 `cargo test --workspace` 含 src-tauri，若绿则说明 GUI 在干净 runner 可编译，可降低本机工具链优先级）。
4. `cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace` 全绿。

**验收（可执行）**：
```bash
cargo check --workspace          # 0 error / 0 warning
cargo clippy --workspace --all-targets -- -D warnings   # 通过
cargo test --workspace           # 全绿（GUI 编译首次纳入测试面）
```
并将 `archive-phase0-1` §四.1 的「GUI 编译挂起」风险状态改为「已解除」。

**涉及**：根 `Cargo.toml`、`src-tauri/*`、`.cargo/`（本机链接器配置）、CI workflow。

### P1 — 壳层首跑验证（让 F3/F12 等「壳」能力首次真实成立）

**目标**：按 `verification-phase1.md` §3 手工清单，用 `DSH_MOCK=1` 跑通主链路与故障路径。

**要做**（逐项执行并勾选 §3 清单）：
1. mock 就绪：splash → 800ms → 导航 mock 页；`harness://status` 事件驱动进度文案（`frontend/index.html` 已监听）。
2. mock `--fail startup`：错误页显示归因（kind/plugin_fault/retryable），「重试」可恢复。
3. mock `--fail after-ready`：exit watcher 把窗口拉回错误页。
4. 安全负例：harness 页 devtools 执行 `window.__TAURI__.core.invoke('harness_status')` 必须被拒（无 remote capability + 守卫双保险）。
5. Cookie 431 缓解：重启 3 次后 127.0.0.1 域 `dsh-auth-*` cookie ≤ 1。
6. 快速开关 5 次：pidfile 清扫正常、无残留。

**验收**：§3 清单全勾；跑出的真实 bug 就地修复并补 host 或 GUI 单测回归。

**涉及**：`state.rs`、`cookies.rs`、`navigation.rs`、`window.rs`、`frontend/{index,error}.html`、`scripts/mock-harness.mjs`。

### P2 — 补齐移植断点（G3/G4/G5；README 里「坏了/死了」的三处功能）

**2a. recovery/safe-mode 页 Tauri 化（G3+G4）**
- 把 `frontend/plugin-recovery.html`、`frontend/safe-mode.html` 的 JS 从 `window.dshSafeMode.action(...)` / `location.href='dsh-recovery://…'` 改写为 `invoke('safe_mode_action'|'recovery_action', { action, … })`。
- 同步扩展 `commands.rs` 两个命令的 action 词表以对齐页面按钮：`apply`（复用 `recovery.rs::remove_plugin_from_profile` 等）、`uninstall`、`agent`、`recovery-open`、`show-log`（复用 `open_logs` 语义）、`restart`、`quit`；页面按钮原语义逐步映射。
- 打通自动入口：`state.rs::on_failed` 在 `plugin_fault=true` 时先经 `recovery.rs` 检测插件清单，再 `window::show_recovery_page(&plugins)`（该函数已写好、零调用）。
- `navigation.rs` 决策表补充：本地壳页跳转一律放行，删除/迁移 `dsh-recovery://` 相关处理。
- 页面按钮可在真窗口点击并驱动真实状态迁移为验收线。

**2b. Mobile bridge 激活（G5）**
- 决策入口形态后接线：菜单项「Enable Mobile Bridge…」或壳内开关页 → `mobile.start()`；状态机 `Ready` 时把当前 harness endpoint 喂给 `set_harness_target()`。
- 端到端验证：浏览器/真机访问 LAN 地址 → 配对 token → QR → RPC 转发到 harness 的请求返回正确响应；`mobile_status` 返回 running。

**2c. 命令面与页面按钮对齐的测试落地**
- 为扩展后的 `safe_mode_action`/`recovery_action` action 词表补单元测试；IPC 语义以 `commands.rs` 守卫与 action 分发表为唯一事实源。

**验收**：G3/G4/G5 各有一条可操作端到端路径；扩展命令带测试；两个页面不再引用任何 `window.dsh*` / `dsh-*://` Electron 残留。

**涉及**：`frontend/{plugin-recovery,safe-mode,error}.html`、`commands.rs`、`state.rs`、`recovery.rs`、`safe_mode.rs`、`window.rs`、`navigation.rs`、`menu.rs`、`mobile_bridge.rs`、`lib.rs`。

### P3 — 真实引擎 + 定制端到端（对齐「feature-identical」承诺）

**目标**：mock 验证的是壳，这一步用真实 dsh 运行时验证整机与 Electron 基线一致。

**要做**：
1. `npm run dev` 组真 harness 运行，对照 `docs/baseline-electron.md` 与 Electron 原版逐项验收：导航、白名单、错误归因、Ready 后 UI 呈现。
2. 验证定制层生效：`dsh-desktop.patch.yml`、品牌资源、`windows-menu.html`、logo 注入（prepare-harness 第 4/5 步），与截图基线比对。
3. 资产单源化（G6）：收口 `frontend/` 与 `build/` 的重复页面为单一维护点，`prepare-harness` 改为从唯一源拷贝；补一个 CI 断言防止再次漂移。
4. ADR-4 目录选择原生能力：按设计决策落地 remote capability 直通或保持命令桥。

**验收**：README Features（F1–F12）在真实运行下逐条打勾；差异写成对齐报告；G6 消除。

### P4 — 发布链路（单实例、更新器、安装包）

**要做**：
1. 生成 updater 签名密钥对；私钥入 CI secret，pubkey 保持 `tauri.conf.json` 现状。
2. 打真实 GitHub release，验证「检查 → 下载 → 安装」闭环与 skip-version 逻辑（`update.rs` 已实现 skip，`updates_skip` 命令已接）。
3. `npm run build`（nsis）：安装/卸载、`installMode`、升级路径、单实例二次启动聚焦既有窗口。

**验收**：从 release A 安装 → 发布 B → 应用内自动更新到 B；装机后 F11 实测通过。

### P5 — 跨平台与收尾

**要做**：
1. POSIX-only 路径补验：PDEATHSIG / 进程组语义、`tauri://localhost` origin、菜单差异——本机仅 Windows，代码里 unix 分支从未被执行，靠 CI 三平台矩阵（`ci.yml` 已备）补齐。
2. 复访 README「Security notes」承诺的 RUSTSEC-2024-0429（glib）revisit 条件；`cargo tree -i glib` 复核。
3. README 状态校准：能力矩阵与验证记录对齐，删去「声称即事实」的表述。
4. 归档纪律：本计划与进度更新分离（归档即冻结，进度另起文档）。

**验收**：三平台 CI 全绿；README 各项与验证矩阵一致；依赖告警复访结论落盘。

## 四、与原计划阶段 2–7 的映射

| 原阶段 | 主题 | 现状 | 新归属 |
|---|---|---|---|
| 阶段 1 收尾 | GUI 编译/全量验证 | 挂起 | **P0**（先解此阻塞） |
| 阶段 4 | 移动桥接完善 | 代码在、未激活 | **P2b** |
| 阶段 5 | 安全模式 / 恢复页 | 页面是 Electron 遗产、入口断线 | **P2a** |
| 阶段 3 | 目录选择原生能力（ADR-4） | 命令桥在、决策待落地 | **P3** |
| 阶段 6 | updater | 代码完整、无签名/release | **P4** |
| 阶段 7 | 打包 / 单实例托盘 | 单实例接线、托盘未做 | **P4/P5**（托盘按需评估是否进范围） |
| 阶段 2 | 单实例托盘 | 单实例已接线 | **P4/P5** |

## 五、风险与外部依赖

1. **P0 工具链**（最高风险）：本机 windows-gnu 链路依赖 `.cargo/` 私有链接器配置（rust-lld wrapper），且缺 `windres.exe`。若 CI 已证明 GUI 在干净 runner 可编译，则优先依赖 CI，本机工具链降为可选。
2. **P3 网络/真实引擎**：真实 dsh 运行时组装需网络 + `patches/` 对应版本仍可安装（`@deepseek-ai/dsh` 上游已漂移，见 `system_design.md` §8）。
3. **P4 发布凭据**：签名私钥属机密，需有权者提供；无 release 则更新闭环无法自证。
4. **P2 页面改造范围**：两个页面是 Electron 原版整体拷贝，按钮/文案/状态逻辑不少；Tauri 化时要保留原交互语义，只换 IPC 通路，避免顺手改 UI。
5. 环境坑（沙箱写 `target` 被拦、`NODE_OPTIONS` shim 影响重删除、NTFS 删除慢）均已有解法记录于 `archive-phase0-1` §五，直接沿用。

## 附：本计划与现有文档的边界

- 本文 = **做什么、按什么顺序、怎么验收**（计划）。
- `system_design.md` = host/CLI 增量设计（T01–T05，已完成），不覆盖 GUI 断点。
- `verification-phase1.md` = 阶段 1 验证记录；P1 执行后回填其 §3。
- `archive-phase0-1` = 阶段 0/1 归档；P0 完成后回填其风险状态。
- 阶段 2–7 推进期间的进度**不回填本计划**，避免活文档与进度日志混淆（同上一轮归档纪律建议）。
