# DSH Desktop (Tauri)

使用 **Rust + Tauri 2.0** 重新构建的 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 桌面套壳。

本仓库是从零开始的 Rust/Tauri 移植版本，目标是替代基于 Electron 的 `dataelement/dsh-desktop` 套壳。它在行为上与原始套壳保持一致，使桌面应用与 Harness Web UI 功能完全对齐，同时用更轻量、更高性能的 Tauri 外壳取代 Electron 运行时。

## 功能特性

- **内置运行时** —— 自带 Node.js (v24) 与完整的 `@deepseek-ai/dsh` 依赖树，宿主机无需预先安装 Node.js。
- **Harness 核心生命周期** —— 在保留的 loopback 端口上拉起 Harness，提取进程级启动令牌，并轮询其 HTTP 就绪状态。
- **看门狗与崩溃自愈 (Supervisor)** —— 核心宿主进程内嵌状态机与心跳监督器，提供自动恢复、进程级断路器与自愈能力。
- **插件进程级隔离与安全守护** —— 基于 Node.js `worker_threads` 与 `plugin-safety-guard` 将高危插件与主运行时解耦隔离，拦截未捕获异常，防止单点故障引发整体崩溃。
- **多模型工具网关 (Model Gateway)** —— 提供 `dsh-model-gateway` 原生 Rust 库，支持多厂商（OpenAI、DeepSeek、Gemini、Claude）工具调用 JSON Schema 的校验、清洗与方言适配，彻底解决格式不兼容与严格模式约束报错。
- **壳页面与交互体验** —— 静态启动页 (Splash)、错误页（支持失败归因、一键重试、安全模式切换、查看日志）、插件恢复页。
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
  dsh-host/             # 无 GUI 核心宿主库（子进程管理、Supervisor 监督器、崩溃诊断、日志环形缓冲、IPC）
  dsh-host-cli/         # dsh-host 命令行工具（支持 start / status / stop / tail 等）
  dsh-model-gateway/    # 多模型工具网关（Schema 清洗、OpenAI/Gemini/Claude 适配、请求编排）
src-tauri/
  frontend/             # 壳页面静态资源（Splash 启动页、Error 错误归因页、安全模式提示）
  resources/            # 组装好的 Harness 运行时 + 品牌资源（已 gitignore，构建自动生成）
  src/                  # Tauri 桌面应用层（窗口管理、托盘、安全模式切换、IPC 接线、自动更新）
build/                  # 运行时组装与辅助注入脚本
  harness-node-entry.mjs    # Node 端入口与启动参数适配
  plugin-safety-guard.mjs   # 插件运行异常全局守护网
  plugin-worker-host.mjs    # 基于 Worker Threads 的插件隔离宿主
patches/                # 应用到 Harness 依赖树的 patch-package 补丁
vendor/                 # 本地桌面定制包（dshmarket 等）
packages/               # 被打补丁包的 vendored tgz 覆盖
scripts/                # 构建与测试辅助（prepare-harness、stub-tauri-resources 等）
docs/                   # 架构设计、契约定义与技术方案
  system_design.md                  # 系统架构设计与不变量规范
  model_gateway_design.md           # 多模型网关设计与工具转换
  plugin_isolation_architecture.md  # 插件隔离架构与通信契约
```

## 说明

- `node_modules/`、`harness-deps/`、`src-tauri/target/` 与 `src-tauri/resources/` 均已被 gitignore；其中 `resources/` 由构建脚本按需组装生成，避免增大仓库体积。
- 在全新拉取的无资源环境中运行 `cargo check` 或 `cargo test` 前，可先执行 `node scripts/stub-tauri-resources.mjs` 生成桩资源以通过 Tauri 编译期校验。
- 更新源指向本仓库 GitHub 发布页的 `latest.json`。发布构建需要签名密钥（见 `tauri.conf.json` → `plugins.updater.pubkey`）。

## 安全与依赖说明

- **Dependabot / RUSTSEC-2024-0429 (GHSA-wrw7-89jp-8q8g)** —— `glib 0.18.5` 被标记存在 `glib::VariantStrIter` 的内存不安全性。它是经 Tauri 的 GTK3 后端引入的**仅 Linux、传递性**依赖，且项目未调用受影响 API。修复版本（`glib ≥ 0.20.0`）需等待上游 Tauri 迁移至 gtk-rs 0.20+ 后自动解析更新。
