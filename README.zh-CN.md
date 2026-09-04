# DSH Desktop (Tauri)

使用 **Rust + Tauri 2.0** 重新构建的 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 桌面套壳。

本仓库是从零开始的 Rust/Tauri 移植版本，目标是替代基于 Electron 的 `dataelement/dsh-desktop` 套壳。它在行为上与原始套壳保持一致，使桌面应用与 Harness Web UI 功能完全对齐，同时用更轻量的 Tauri 外壳取代 Electron 运行时。

## 功能特性

- **内置运行时** —— 自带 Node.js (v24) 与完整的 `@deepseek-ai/dsh` 依赖树，宿主机无需安装 Node.js。

- **Harness 生命周期** —— 在保留的 loopback 端口上拉起 Harness，提取进程级启动令牌，并轮询其 HTTP 就绪状态。

- **壳页面** —— 启动页、错误页（支持重试 / 打开日志 / 退出）、插件恢复页与安全模式页。

- **桌面定制** —— 通过 `patch-package` 补丁以及传给 `web --patch` 的 `patch.yml` 层应用桌面品牌资源与 UI 行为。

- **移动桥接** —— 提供带配对令牌、二维码的局域网 HTTP 服务，并转发 RPC 到 Harness。

- **安全模式** —— 使用仅含核心 Harness 包的隔离配置，用于在插件故障时恢复。

- **插件恢复** —— 扫描启动日志定位出问题的插件，并提供定向移除。

- **自动更新** —— 基于 `tauri-plugin-updater` 的通用更新源（GitHub releases）。

- **单实例** —— 第二次启动时聚焦已有窗口，而非另起一个副本。

## 环境要求

- [Rust 工具链](https://rustup.rs/)（stable）

- [Node.js](https://nodejs.org/)（v18+，用于构建工具链）

- [Tauri v2](https://v2.tauri.app/start/prerequisites/) 对应的平台构建依赖（WebView2 / WebKit / WebKitGTK）

## 快速开始

```sh
npm install
npm run dev
```

`npm run dev` 会先把 Harness 运行时组装进 `src-tauri/resources/`（参见 [`scripts/prepare-harness.mjs`](scripts/prepare-harness.mjs)），再启动应用。

构建安装包：

```sh
npm run build
```

## 目录结构

```text
src-tauri/
  resources/      # 组装好的 Harness 运行时 + 品牌资源（已 gitignore，由构建生成）
  src/            # Rust 源码
    lib.rs        # 应用装配：插件、状态、窗口导航、生命周期
    harness_runtime.rs  # Harness 子进程生命周期、令牌提取、就绪检测
    mobile_bridge.rs    # 局域网配对 + RPC 桥接
    recovery.rs         # 插件故障检测 / 移除
    safe_mode.rs        # 隔离配置
    update.rs           # 自动更新管理
    window.rs           # 窗口导航辅助
    paths.rs            # 数据目录布局
    resources.rs        # 打包资源解析
frontend/         # 壳页面（启动、错误、插件恢复、安全模式）
patches/          # 应用到 Harness 依赖树的 patch-package 补丁
vendor/           # 本地桌面定制包（dshmarket 等）
packages/         # 被打补丁包的 vendored tgz 覆盖
scripts/          # 构建辅助（prepare-harness、install-brand-assets 等）
```

## 说明

- `node_modules/`、`harness-deps/`、`src-tauri/target/` 与 `src-tauri/resources/` 均已被 gitignore；
  其中 `resources/` 由构建重新生成，入库会显著增大仓库体积。

- 更新源指向本仓库 GitHub 发布页的 `latest.json`。发布构建需要签名密钥
  （见 `tauri.conf.json` → `plugins.updater.pubkey`）。

## 安全说明

- **Dependabot / RUSTSEC-2024-0429 (GHSA-wrw7-89jp-8q8g)** —— `glib 0.18.5` 被标记存在
  `glib::VariantStrIter`（`Iterator` / `DoubleEndedIterator` 实现）的 unsoundness（可能导致未定义行为）。
  它是经 Tauri 的 GTK3 后端（`gtk 0.18.2` 固定 `glib ^0.18`）引入的 **仅 Linux、传递性** 依赖，
  且我们的代码从不调用受影响 API。补丁版本（`glib ≥ 0.20.0`）在当前依赖树中 **不可达**，
  需等待上游 Tauri 将 Linux 后端迁移到 gtk-rs 0.20+（tauri 2.11.5 已是最新 2.x）。
  因此该 Dependabot 告警以"不可利用 / 不可达"为理由标注为已处理。当某个 Tauri 版本引入
  `glib >= 0.20.0` 后，需重新执行 `cargo update`，并用 `cargo tree -i glib` 确认已解析到修补版本，再行复查。

