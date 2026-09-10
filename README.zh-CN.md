# DSH Desktop (Tauri)

> [English Document](README.md)

使用 **Rust + Tauri 2.0** 重新构建的 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 桌面套壳。

本仓库是从零开始的 Rust/Tauri 移植版本，目标是替代基于 Electron 的 `dataelement/dsh-desktop` 套壳。它在行为上与原始套壳保持一致，使桌面应用与 Harness Web UI 功能完全对齐，同时用更轻量、更高性能的 Tauri 外壳取代 Electron 运行时。

## 功能特性

- **内置运行时** —— 自带 Node.js (v24) 与完整的 `@deepseek-ai/dsh` 依赖树，宿主机无需预先安装 Node.js。
- **独立契约库 (`dsh-contracts`)** —— 彻底剥离 UI 依赖，提炼统一常量、标准错误码体系 (`E1001`~`E4002`)、前后端 IPC 封套 (`IpcEnvelope<T>`) 以及 JSON-RPC 2.0 规范定义（唯一定义点，`dsh-host` 等下游 crate 仅 re-export，不重复定义）。
- **Harness 核心生命周期** —— 在保留的 loopback 端口上拉起 Harness，提取进程级启动令牌，并轮询其 HTTP 就绪状态。
- **看门狗与崩溃自愈 (Supervisor)** —— 核心宿主进程内嵌状态机与心跳监督器，提供自动恢复、进程级断路器与自愈能力。
- **插件分级隔离 2.0 (Tier 0/1/2) 与看门狗** —— 基于 Node.js `worker_threads` / 独立沙箱子进程运行不可信插件，通过标准 JSON-RPC 2.0 双向通信，具备超时控制、故障计数与熔断自愈机制。
- **多模型工具网关 2.0 (Model Gateway)** —— 原生 Rust 库 `dsh-model-gateway`，支持多厂商（OpenAI、DeepSeek、Gemini、Claude）工具调用 JSON Schema 校验、深度嵌套展开、`anyOf`/`oneOf` 降级净化与方言适配。
- **微秒级性能基准测试** —— 内置 benchmark 测试套件，保障 Schema 清洗与多方言适配转换在 2~20 微秒级内高效完成。
- **壳页面与诊断系统 2.0** —— 静态启动页 (Splash)、错误页（支持故障归因、一键重试、安全模式切换）、一键脱敏导出诊断包 (`diagnostics.zip`)。
- **安全模式与故障恢复** —— 自动检测启动失败原因，定位并隔离崩溃插件，生成独立沙箱 profile 保障基础功能可用。
- **多 Profile 与会话管理** —— 内置 Session / Profile 状态管理与元数据持久化，支持多环境无缝切换。
- **桌面深度定制** —— 通过 `patch-package` 补丁以及传给 `web --patch` 的 `patch.yml` 层应用桌面品牌资源与 UI 行为。
- **移动桥接 (Mobile Bridge)** —— 提供带配对令牌、二维码的局域网 HTTP 服务，并转发 RPC 到 Harness。
- **自动更新** —— 基于 `tauri-plugin-updater` 的通用更新源（GitHub releases）。
- **单实例锁定** —— 第二次启动时聚焦已有窗口，避免重复拉起多实例。

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
  dsh-host/             # 无 GUI 核心宿主库（子进程管理、Supervisor 监督器、崩溃诊断、插件隔离 2.0、日志环形缓冲）
  dsh-host-cli/         # dsh-host 命令行工具（支持 start / status / stop / tail / doctor 等）
  dsh-model-gateway/    # 多模型工具网关（Schema 清洗、复杂 union 降级、OpenAI/Gemini/Claude 适配、Benchmark 套件）
src-tauri/
  frontend/             # 壳页面静态资源（Splash 启动页、Error 错误归因页、安全模式提示）
  resources/            # 组装好的 Harness 运行时 + 品牌资源（已 gitignore，构建自动生成）
  src/                  # Tauri 桌面应用层（窗口管理、托盘、IPC 封套接线、安全模式切换、诊断导出、自动更新）
build/                  # 运行时组装与辅助注入脚本
  harness-node-entry.mjs    # Node 端入口与启动参数适配
  plugin-safety-guard.mjs   # 插件运行异常全局守护网
  plugin-worker-host.mjs    # 基于 Worker Threads / 子进程的插件隔离宿主（JSON-RPC 2.0）
patches/                # 应用到 Harness 依赖树的 patch-package 补丁
vendor/                 # 本地桌面定制包（dshmarket 等）
packages/               # 被打补丁包的 vendored tgz 覆盖
scripts/                # 构建与测试辅助（prepare-harness、stub-tauri-resources 等）
  prepare-harness.mjs       # 组装运行时到 src-tauri/resources/
  stub-tauri-resources.mjs  # 全新 checkout / CI 用的仅编译桩资源
  mock-harness.mjs          # 可注入故障的假 Harness，供集成测试使用
  fault-inject.mjs          # 孤儿进程与失败归因验证
docs/                   # 架构设计、契约定义与技术方案
  dsh-desktop-redesign-architecture-and-plan.md  # 架构重构与开发执行完整计划
  system_design.md                  # 系统架构设计与不变量规范
  model_gateway_design.md           # 多模型网关设计与工具转换
  plugin_isolation_architecture.md  # 插件隔离架构与通信契约
```

## 架构演进与路线图 (Roadmap)

项目整体架构围绕以下核心阶段演进：

- **阶段 0 (P0) —— 契约基线与无头核心库**：提炼独立契约库（`dsh-contracts`）、错误码分类体系、跨平台孤儿进程防护（Win32 Job Objects / POSIX 进程组）以及纯 Rust 核心宿主库（`dsh-host`、`dsh-host-cli`）。
- **阶段 1 (P1) —— 进程生命周期与诊断系统**：内置 Supervisor 状态机与自愈机制、日志环形缓冲区（LogRing）、崩溃归因分析（DiagnosticsAnalyzer）以及安全模式（Safe Mode）隔离 Profile 生成。
- **阶段 2 (P2) —— 插件分级隔离 2.0 (Tier 0/1/2) 与看门狗**：构建解耦的 Worker 线程沙箱（`plugin-worker-host.mjs`）、JSON-RPC 2.0 双向通信、故障计数与断路器熔断自愈（`plugin_worker.rs`）。
- **阶段 3 (P3) —— 多模型网关 2.0 与基准测试**：支持 OpenAI、DeepSeek、Gemini、Claude 多厂商工具调用 JSON Schema 清洗、复杂嵌套/`anyOf`/`oneOf` 降级、Payload 组装适配（`dsh-model-gateway`）以及微秒级性能基准测试。
- **阶段 4 (P4) —— 薄壳收敛与诊断系统 2.0**：Tauri Commands 统一采用 `IpcEnvelope<T>` 封套返回，支持一键脱敏导出诊断包 (`diagnostics.zip`)。

## 测试

无头门禁无需显示器、也无需组装 300MB 运行时（INV-6）：

```sh
cargo test -p dsh-contracts -p dsh-host -p dsh-host-cli -p dsh-model-gateway
```

集成测试会真实派生 Node 进程运行 `scripts/mock-harness.mjs`，因此需要 `PATH` 上有 Node.js（可用 `DSH_TEST_NODE` 指定），找不到时会自行跳过而非失败。各类故障模式（启动失败、不打印 URL、端口占用重试、就绪后崩溃）通过 `mock-harness.mjs` 的 argv 与环境变量注入，而不是在 Rust 侧打桩。`scripts/fault-inject.mjs` 额外针对 `dsh-host-cli` 验证孤儿进程清理与退出码归因。

## 说明

- `node_modules/`、`harness-deps/`、`src-tauri/target/` 与 `src-tauri/resources/` 均已被 gitignore；其中 `resources/` 由构建脚本按需组装生成，避免增大仓库体积。
- 在全新拉取的无资源环境中运行 `cargo check` 或 `cargo test` 前，可先执行 `node scripts/stub-tauri-resources.mjs` 生成桩资源以通过 Tauri 编译期校验。
- 更新源指向本仓库 GitHub 发布页的 `latest.json`。发布构建需要签名密钥（见 `tauri.conf.json` → `plugins.updater.pubkey`）。

## Windows 打包注意事项

此前有三个缺陷会让 Windows 构建产出的安装包启动即失败，现已全部修复。本节记录根因，避免回归。

- **`\\?\` verbatim 路径绝不能传给 Node 子进程。** Tauri 的 `resource_dir()` 来自 `current_exe().canonicalize()`，Windows 上返回扩展长度路径（`\\?\D:\…`）。把它拼进 Node 入口脚本后，CJS loader 会将其还原成裸盘符 `D:`，`lstat` 抛 `EISDIR: illegal operation on a directory, lstat 'D:'`。修复位于 [`crates/dsh-host/src/paths.rs`](crates/dsh-host/src/paths.rs) 的 `Layout::resolve`——所有派生路径的唯一产地，因此没有任何调用点能再泄漏该前缀。
- **`prepare:harness` 幂等快速路径按完整打包清单校验。** 此前只检查 3 个文件，导致缺 `bin/`、`plugin-safety-guard.mjs` 或 `plugin-worker-host.mjs` 的 `resources/` 被判定为完整并跳过组装。`plugin-safety-guard.mjs` 由 `harness-node-entry.mjs` 直接 import，缺失时 Harness 根本无法启动；缺 `bin/` 还会让 `cargo build` 因 `resources/bin/*` glob 不匹配而失败。完整性检查现已对齐 `tauri.conf.json` → `bundle.resources`。
- **`shell == None` 时同样要走 `harness_env`。** `Launcher::execute` 此前把 `capture_shell_environment()` 的原始结果直接交给子进程，`DSH_HOME` 等契约变量因此从未注入，Harness 回退到 `~/.dsh`，把可变状态写到了 `app_data_dir` 之外（违反 INV-1）。GUI 与 CLI 两条路径现已都注入契约环境。

另有工作区目录选择器必须走 Host seam、不得使用 renderer 全局桥：Tauri webview 没有 preload / initialization script，`window.*` 全局无处定义。曾有一个 `patch-package` 补丁把原生目录选择器改成 `window.dshDesktopDirectoryPicker.pick()`，该全局从未被定义，因此导入项目时必然弹出「无法打开文件夹 / DSH Desktop directory picker bridge is unavailable」。现已移除该补丁，恢复上游 stock 路径：客户端 `ctx.uiWorkspace.pickDirectory()` → Host `ctx.directoryPicker` seam → Harness 进程内拉起 Win32 `IFileOpenDialog`。`scripts/prepare-harness.mjs` 的 `assertPickerSurfaceIsHostBacked()` 会在打补丁后校验这一点，违反即构建失败。

要构建真实安装包，`npm run tauri build` 首次运行会下载 NSIS 工具链；在网络无法访问 GitHub releases 的环境下，打包步骤会以 `timeout: global` 失败，但此时 `.exe` 与资源其实已成功产出。

## 安全与依赖说明

- **Dependabot / RUSTSEC-2024-0429 (GHSA-wrw7-89jp-8q8g)** —— `glib 0.18.5` 被标记存在 `glib::VariantStrIter` 的内存不安全性。它是经 Tauri 的 GTK3 后端引入的**仅 Linux、传递性**依赖，且项目未调用受影响 API。修复版本（`glib ≥ 0.20.0`）需等待上游 Tauri 迁移至 gtk-rs 0.20+ 后自动解析更新。
