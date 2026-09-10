# DSH Desktop (Tauri)

> [English Document](README.md)

使用 **Rust + Tauri 2.0** 重新构建的 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 桌面套壳。

本仓库是从零开始的 Rust/Tauri 移植版本，目标是替代基于 Electron 的 `dataelement/dsh-desktop` 套壳。它在行为上与原始套壳保持一致，使桌面应用与 Harness Web UI 功能完全对齐，同时用更轻量、更高性能的 Tauri 外壳取代 Electron 运行时。

## 功能特性

> **状态标记约定**：✅ 已接线（在运行时路径上）· ⚠️ 未接线（代码已实现并测试，但无运行时调用方）· 🟡 部分 · ❌ 未实现。
> 每项的代码证据与调用方见 [`AGENTS.md` §7 宣称纪律](AGENTS.md#7-宣称纪律claim-discipline)。本文件与 AGENTS.md 的状态必须一致，改一处须同步另一处。

### 已接线能力

- **内置运行时** ✅ —— 自带 Node.js (v24) 与完整的 `@deepseek-ai/dsh` 依赖树，宿主机无需预先安装 Node.js。
- **独立契约库 (`dsh-contracts`)** ✅ —— 彻底剥离 UI 依赖，提炼统一常量、标准错误码体系 (`E1001`~`E4002`)、前后端 IPC 封套 (`IpcEnvelope<T>`) 以及 JSON-RPC 2.0 规范定义（唯一定义点，`dsh-host` 等下游 crate 仅 re-export，不重复定义）。
- **Harness 核心生命周期** ✅ —— 在保留的 loopback 端口上拉起 Harness，提取进程级启动令牌，并轮询其 HTTP 就绪状态。
- **看门狗与崩溃自愈 (Supervisor)** ✅ —— 核心宿主进程内嵌状态机与心跳监督器，提供自动恢复、进程级断路器与自愈能力。
- **孤儿进程防护（INV-3）** ✅ —— Windows 走 Win32 JobObject (`KILL_ON_JOB_CLOSE`)，Linux 走 `PR_SET_PDEATHSIG` + 进程组，macOS 走进程组 + 退出扫描；主程序崩溃或退出时不残留子进程。
- **插件运行异常守护（进程内）** ✅ —— `plugin-safety-guard.mjs` 拦截未捕获异常与未处理 Promise 拒绝，产出 `[dsh-plugin-fault]` 归因信息，避免单个插件把整个 Harness 拖崩。
- **安全模式与故障恢复** ✅ —— 自动检测启动失败原因并写入独立隔离 profile，随后**真正以该 profile 启动 Harness**（`--profile desktop-safe-mode` 搭配 `dsh-desktop-safe.patch.yml`，后者会摘掉常规补丁层挂载的产品插件），保障基础功能可用。注意：壳层在界面上**没有任何**「当前处于安全模式」的提示。
- **多 Profile 与会话管理** ✅ —— 内置 Session / Profile 状态管理与元数据持久化，支持多环境无缝切换。
- **壳层结构化日志** ✅ —— `tauri-plugin-log` 落盘到 `app_data_dir/desktop.log`（5 MB × 2 轮转，含本地时区），与 Harness 侧 `harness.log` / `app.log` 分离，便于归因「是壳的问题还是 Harness 的问题」。
- **移动桥接 (Mobile Bridge)** ✅ —— 局域网 HTTP 服务，配对页内置二维码与配对令牌，转发 RPC 到 Harness。默认**不监听**，需从应用菜单「Phone Pairing (LAN)…」显式启动；受 Harness 的 `dsh-auth-*` cookie 握手与会话令牌双重约束，进程退出即失效。菜单的 `Phone` 子菜单会实时显示桥状态（off / listening / paired）——注意本应用**尚无系统托盘**。
- **桌面深度定制** ✅ —— 通过 `patch-package` 补丁以及传给 `web --patch` 的 `patch.yml` 层应用桌面品牌资源与 UI 行为。补丁按 `functional` / `ui-behavior` / `brand` 三层分级（见 [`patches/LAYERS.md`](patches/LAYERS.md)），失败时默认降级并在 `MANIFEST.json` 的 `patches[]` 逐条留证；`--strict` 可恢复全量 fail-fast。
- **单实例锁定** ✅ —— 第二次启动时聚焦已有窗口，避免重复拉起多实例。
- **自动更新** ✅ —— `tauri-plugin-updater` 已注册，检查 → 下载 → 择机重启安装的完整链路均已接线，并配有应用内更新页（`frontend/updates.html`，由应用菜单「检查更新」打开）。更新源为**本仓库**（`wang-yi-bit64/dsh-desktop`），验签使用**本项目自有**的 minisign 密钥。发布正式包前请先读[自动更新与签名密钥](#自动更新与签名密钥)。
- **微秒级性能基准测试** ✅ —— `dsh-model-gateway` 内置 benchmark 套件，保障 Schema 清洗与多方言适配转换在 2~20 微秒级内完成（基准可运行，但见下方「未接线」说明）。

### 未接线 / 未实现（实验性，勿对外宣称可用）

- **插件分级隔离 2.0 (Tier 0/1/2)** ⚠️ **未接线** —— Tier 0/1/2 分级沙箱宿主（`plugin-worker-host.mjs`）、JSON-RPC 2.0 双向通信、超时控制、故障计数与熔断断路器（`plugin_worker.rs`）**均已实现并有单元测试**，但整个仓库**没有任何运行时调用方**：Node 侧 `PluginWorkerClient` 被刻意丢弃，Rust 侧 `call_tool` 现在直接返回可辨识的 `ISOLATION_NOT_WIRED` 错误而非伪造成功。因此**当前生效的插件防护仅为上文的进程内守护**（同进程崩溃仍可能带走 Harness）。接线前置与退出条件见 [`docs/plugin_isolation_architecture.md`](docs/plugin_isolation_architecture.md)。
- **多模型工具网关 2.0 (`dsh-model-gateway`)** ⚠️ **未接线** —— 该 crate 的 Schema 校验、`anyOf`/`oneOf` 降级净化、多厂商（OpenAI/DeepSeek/Gemini/Claude）方言适配均已实现并测试通过，但**无任何运行时消费者**，自 2026-09-10 起**不再是 `src-tauri` 的依赖**。保留为可独立测试的资产，接线或冻结的判据见 [`docs/model_gateway_design.md`](docs/model_gateway_design.md) 顶部状态表。
- **壳页面与错误归因** 🟡 **部分** —— 静态启动页 (Splash) 与错误页（故障归因、一键重试、安全模式切换）**已接线**；但**一键脱敏导出诊断包 (`diagnostics.zip`) 未实现**，代码库中不存在对应实现。当前获取诊断证据的两条可用路径是 `dsh-host-cli doctor` 与壳层日志 `desktop.log`。

## 环境要求

- [Rust 工具链](https://rustup.rs/)（stable，建议 `>= 1.85`）
- [Node.js](https://nodejs.org/)（v18+，用于构建工具链）
- [Tauri v2](https://v2.tauri.app/start/prerequisites/) 对应的平台构建依赖（WebView2 / WebKit / WebKitGTK）

## 快速开始

```sh
npm install
npm run dev
```

`npm run dev` 会先把 Harness 运行时组装进 `src-tauri/resources/`（参见 [`scripts/prepare-harness.mjs`](scripts/prepare-harness.mjs)），再启动桌面应用。

构建安装包 / 生产二进制产物：

```sh
npm run build
# 或直接调用
npm run tauri build
```

## 仓库与 Workspace 结构

```text
crates/
  dsh-contracts/        # 纯 Rust 通用契约库（常量、错误码体系、IPC 封套、JSON-RPC、生命周期与诊断定义）
  dsh-host/             # 无 GUI 核心宿主库（子进程管理、Supervisor 监督器、崩溃诊断、日志环形缓冲；插件隔离仅状态机，未接线）
  dsh-host-cli/         # dsh-host 命令行工具（支持 start / status / stop / tail / doctor 等）
  dsh-model-gateway/    # 多模型工具网关（Schema 清洗、复杂 union 降级、OpenAI/Gemini/Claude 适配、Benchmark 套件）—— 未接线，非 src-tauri 依赖
src-tauri/
  frontend/             # 壳页面静态资源（Splash 启动页、Error 错误归因页、安全模式提示）
  resources/            # 组装好的 Harness 运行时 + 品牌资源（已 gitignore，构建自动生成）
  src/                  # Tauri 桌面应用层（窗口管理、应用菜单、IPC 命令、安全模式切换、LAN 手机桥、壳层日志、自动更新）
    logging.rs              # 壳层结构化日志（desktop.log，5MB × 2 轮转）
    mobile_bridge.rs        # 局域网手机桥（配对页 + dsh-auth-* cookie 握手 + RPC 转发）
build/                  # 运行时组装与辅助注入脚本
  harness-node-entry.mjs    # Node 端入口与启动参数适配（含 cold-start 投影与故障归因接线）
  plugin-safety-guard.mjs   # 插件运行异常全局守护网（formatFaultDetails 已接线；PluginWorkerClient 未接线）
  plugin-worker-host.mjs    # 基于 Worker Threads / 子进程的插件隔离宿主（JSON-RPC 2.0）—— 未接线
patches/                # 应用到 Harness 依赖树的 patch-package 补丁 + LAYERS.md 分级清单
vendor/                 # 本地桌面定制包（dshmarket 等）
packages/               # 被打补丁包的 vendored tgz 覆盖
scripts/                # 构建与测试辅助（prepare-harness、stub-tauri-resources 等）
  prepare-harness.mjs       # 组装运行时到 src-tauri/resources/（补丁按级降级，--strict 恢复 fail-fast）
  stub-tauri-resources.mjs  # 全新 checkout / CI 用的仅编译桩资源
  mock-harness.mjs          # 可注入故障的假 Harness，供集成测试使用
  fault-inject.mjs          # 孤儿进程与失败归因验证
  patch-layers.mjs          # 补丁分级唯一产地（--self-test / --list 自检）
  smoke-launch.mjs          # CI 分层烟雾（L1 无头门禁 / L2 GUI xvfb）
  report-bundle-size.mjs    # 采集壳/安装包/资源树体积，写入 CI job summary
docs/                   # 架构设计、契约定义与技术方案
  dsh-desktop-redesign-architecture-and-plan.md  # 架构重构与开发执行完整计划
  system_design.md                  # 系统架构设计与不变量规范
  model_gateway_design.md           # 多模型网关设计与工具转换（含未接线状态与退出条件）
  plugin_isolation_architecture.md  # 插件隔离架构与通信契约（含未接线状态）
  dsh-upgrade-checklist.md          # DSH 官方版本升级清单（补丁重生成 → 门禁 → 三平台烟雾）
  harness-packaging-and-compatibility.md  # 产物瘦身与补丁脆弱性治理的长期方案
```

## 架构演进与路线图 (Roadmap)

### 设计与当前状态对照

下表左列是**设计目标**，右列是**当前是否在运行时路径上**。二者不可混用（详见 [`AGENTS.md` §7](AGENTS.md#7-宣称纪律claim-discipline)）。

| 阶段 | 设计范围 | 当前状态 |
|------|---------|---------|
| P0 | 契约库 `dsh-contracts`、错误码分类体系、跨平台孤儿进程防护（Win32 Job Objects / POSIX 进程组）、无头核心宿主库（`dsh-host`、`dsh-host-cli`） | ✅ 已接线 |
| P1 | Supervisor 状态机与自愈、日志环形缓冲区（LogRing）、崩溃归因分析（DiagnosticsAnalyzer）、安全模式（Safe Mode）隔离 Profile | ✅ 已接线 |
| P2 | 解耦 Worker 线程沙箱（`plugin-worker-host.mjs`）、JSON-RPC 2.0 双向通信、故障计数与断路器熔断自愈（`plugin_worker.rs`） | ⚠️ **未接线**：实现与单测俱在，但无运行时调用方；`call_tool` 返回 `ISOLATION_NOT_WIRED` 而非伪造成功 |
| P3 | 多厂商工具调用 Schema 清洗、复杂嵌套/`anyOf`/`oneOf` 降级、Payload 组装适配（`dsh-model-gateway`）、微秒级性能基准 | ⚠️ **未接线**：已从 `src-tauri` 依赖移除，无运行时消费者 |
| P4 | Tauri Commands 统一采用 `IpcEnvelope<T>` 封套返回；一键脱敏导出诊断包 (`diagnostics.zip`) | 🟡 封套 ⚠️ **未接线**（契约已定义，14 个命令仍返回 `Result<T, String>`）；**诊断包 ❌ 未实现** |

### 后续计划（尚未开工）

- **P2/P3 接线或冻结裁定**：为插件隔离与模型网关给出明确的「接入运行时」或「标记为冻结资产」结论，避免无限期停留在「实现了但没人用」的中间态。
- **诊断包落地**：在 `dsh-host-cli doctor` 现有归因能力之上补齐脱敏打包（日志 + 归因结论 + 环境快照 + `MANIFEST.json`）。

## 测试

无头门禁无需显示器、也无需组装 300MB 运行时（INV-6）：

```sh
cargo test -p dsh-contracts -p dsh-host -p dsh-host-cli -p dsh-model-gateway
```

集成测试会真实派生 Node 进程运行 `scripts/mock-harness.mjs`，因此需要 `PATH` 上有 Node.js（可用 `DSH_TEST_NODE` 指定），找不到时会自行跳过而非失败。各类故障模式（启动失败、不打印 URL、端口占用重试、就绪后崩溃）通过 `mock-harness.mjs` 的 argv 与环境变量注入，而不是在 Rust 侧打桩。`scripts/fault-inject.mjs` 额外针对 `dsh-host-cli` 验证孤儿进程清理与退出码归因。

## 说明

- `node_modules/`、`harness-deps/`、`src-tauri/target/` 与 `src-tauri/resources/` 均已被 gitignore；其中 `resources/` 由构建脚本按需组装生成，避免增大仓库体积。
- 在全新拉取的无资源环境中运行 `cargo check` 或 `cargo test` 前，可先执行 `node scripts/stub-tauri-resources.mjs` 生成桩资源以通过 Tauri 编译期校验。
- **更新端点与签名密钥**：自动更新的更新源为**本仓库**发布页，验签使用**本项目自有**的 minisign 公钥。密钥私钥的存放位置、CI 如何取得、以及一旦丢失会怎样，见[自动更新与签名密钥](#自动更新与签名密钥)。

## 自动更新与签名密钥

更新端点为 `https://github.com/wang-yi-bit64/dsh-desktop/releases/latest/download/latest.json`，且 `tauri.conf.json` → `bundle.createUpdaterArtifacts` 已置 `true`，因此 `npm run build` 会同时产出**已签名的安装包**与该端点所服务的 `latest.json` 清单——发布一个版本无需再额外做发布动作，上传构建产物即可。

更新的可信度完全落在同一对 minisign 密钥上：

| 项目 | 位置 |
|------|------|
| 公钥 | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`（可入库，它只用于验签） |
| 私钥 | `~/.tauri/dsh-desktop.key` —— **严禁入库**，严禁复制进仓库 |
| 离线备份 | `~/.tauri/backup/dsh-desktop.key.<时间戳>`，同目录存放配对的 `.pub` |
| CI 获取方式 | `wang-yi-bit64/dsh-desktop` 仓库的 GitHub Actions Secret `TAURI_SIGNING_PRIVATE_KEY`，**无口令**使用 |

没有签名凭据时构建仍能产出安装包，但这种包无法被已发布的客户端安装——验签会直接拒绝。因此 CI 会在**开始昂贵的构建之前**先校验该 Secret 是否存在，缺失时以显式 `::error::` 提前失败，而不是等到最后才发现问题。

**私钥一旦丢失，对已安装用户而言不可挽回。** 公钥被编译进每一个已发布的二进制；换新密钥对就意味着换新公钥，而已安装的客户端会持续拒绝由新公钥签名的更新。请把 `~/.tauri/dsh-desktop.key` 当作发布关键基础设施，而不是本地开发文件。

## 体积现状与期望管理

安装包体积主要由**内置 Node.js 运行时 + 完整 Harness 依赖树**决定，壳层（Rust/Tauri）自身的贡献很小。这不是「胖壳」问题，而是为了「宿主机零依赖」付出的必然代价——把这个前提说清楚，比给出一个笼统的 MB 数字更有用。

体积数据由 `scripts/report-bundle-size.mjs` 在构建后采集并写入 CI job summary，避免 README 里的数字随时间失真。三个可区分的体积口径：

| 口径 | 含义 | 受什么影响 |
|------|------|-----------|
| 壳二进制 | `src-tauri/target/release/*.exe`（未打包） | Rust 依赖与 LTO 设置；与 Harness 无关 |
| 安装包 | NSIS `*-setup.exe` | 壳二进制 + 压缩后的资源树 |
| 资源树 | `src-tauri/resources/`（未压缩） | Node 运行时 + `harness/node_modules` 依赖树；**体积主项** |

> 实际数值以 `npm run build` 后 `node scripts/report-bundle-size.mjs` 的输出为准（或见 CI 的 build job summary）。本 README 不再维护会失真的手写数字。

若需显著瘦身，方向是减少打包进 `resources/` 的依赖（见 [`docs/harness-packaging-and-compatibility.md`](docs/harness-packaging-and-compatibility.md)），而非改动 Tauri 侧配置——后者对总量的影响在个位数 MB 量级。

## Windows 打包注意事项

此前有三个缺陷会让 Windows 构建产出的安装包启动即失败，现已全部修复。本节记录根因，避免回归。

- **`\\?\` verbatim 路径绝不能传给 Node 子进程。** Tauri 的 `resource_dir()` 来自 `current_exe().canonicalize()`，Windows 上返回扩展长度路径（`\\?\D:\…`）。把它拼进 Node 入口脚本后，CJS loader 会将其还原成裸盘符 `D:`，`lstat` 抛 `EISDIR: illegal operation on a directory, lstat 'D:'`。修复位于 [`crates/dsh-host/src/paths.rs`](crates/dsh-host/src/paths.rs) 的 `Layout::resolve`——所有派生路径的唯一产地，因此没有任何调用点能再泄漏该前缀。
- **`prepare:harness` 幂等快速路径按完整打包清单校验。** 此前只检查 3 个文件，导致缺 `bin/`、`plugin-safety-guard.mjs` 或 `plugin-worker-host.mjs` 的 `resources/` 被判定为完整并跳过组装。`plugin-safety-guard.mjs` 由 `harness-node-entry.mjs` 直接 import，缺失时 Harness 根本无法启动；缺 `bin/` 还会让 `cargo build` 因 `resources/bin/*` glob 不匹配而失败。完整性检查现已对齐 `tauri.conf.json` → `bundle.resources`。
- **`shell == None` 时同样要走 `harness_env`。** `Launcher::execute` 此前把 `capture_shell_environment()` 的原始结果直接交给子进程，`DSH_HOME` 等契约变量因此从未注入，Harness 回退到 `~/.dsh`，把可变状态写到了 `app_data_dir` 之外（违反 INV-1）。GUI 与 CLI 两条路径现已都注入契约环境。

另有工作区目录选择器必须走 Host seam、不得使用 renderer 全局桥：Tauri webview 没有 preload / initialization script，`window.*` 全局无处定义。曾有一个 `patch-package` 补丁把原生目录选择器改成 `window.dshDesktopDirectoryPicker.pick()`，该全局从未被定义，因此导入项目时必然弹出「无法打开文件夹 / DSH Desktop directory picker bridge is unavailable」。现已移除该补丁，恢复上游 stock 路径：客户端 `ctx.uiWorkspace.pickDirectory()` → Host `ctx.directoryPicker` seam → Harness 进程内拉起 Win32 `IFileOpenDialog`。`scripts/prepare-harness.mjs` 的 `assertPickerSurfaceIsHostBacked()` 会在打补丁后校验这一点，违反即构建失败。

要构建真实安装包，`npm run tauri build` 首次运行会下载 NSIS 工具链；在网络无法访问 GitHub releases 的环境下，打包步骤会以 `timeout: global` 失败，但此时 `.exe` 与资源其实已成功产出。

## 安全与依赖说明

- **Dependabot / RUSTSEC-2024-0429 (GHSA-wrw7-89jp-8q8g)** —— `glib 0.18.5` 被标记存在 `glib::VariantStrIter` 的内存不安全性。它是经 Tauri 的 GTK3 后端引入的**仅 Linux、传递性**依赖，且项目未调用受影响 API。修复版本（`glib ≥ 0.20.0`）需等待上游 Tauri 迁移至 gtk-rs 0.20+ 后自动解析更新。
