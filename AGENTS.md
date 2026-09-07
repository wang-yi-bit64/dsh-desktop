# AGENTS.md

> 面向开发人员与 AI Agent 的 `dsh-desktop`（DeepSeek Harness 桌面壳）协作指南

---

## 1. 项目概述与仓库结构

`dsh-desktop` 是基于 **Tauri 2.0** 与 **Rust** 构建的 DeepSeek Harness 跨平台桌面外壳程序。它负责打包内置 Node.js + DeepSeek Harness 服务运行时的生命周期管理，并提供 GUI 窗口承载。

### 目录划分
- **`crates/dsh-host`**：无 GUI 依赖的纯 Rust 核心宿主库。承担子进程派生、跨平台孤儿进程防护、URL/Token 捕获、HTTP 就绪探测、日志滚动轮转与停止语义。**严格保持无 GUI / Headless 状态（不变量 INV-6）**。
- **`crates/dsh-host-cli`**：`dsh-host` 的命令行工具前端（支持 `dsh-host start | status | stop | tail`）。
- **`src-tauri`**：Tauri 2.0 桌面应用层（负责窗口管理、系统托盘、生命周期、Webview IPC、自动更新、页面导航）。
  - **`src-tauri/frontend/`**：轻量静态 Loading / Splash 启动页、错误页与安全模式页，在 Webview 导航跳转到 Harness 服务前显示。
- **`scripts/`**：
  - `prepare-harness.mjs`：解析、下载并组装 300MB+ 的 Node 运行时与 Harness 依赖包到 `src-tauri/resources/`。
  - `stub-tauri-resources.mjs`：生成轻量桩资源树，用于无资源包环境下的快速编译与单测。
- **`docs/`**：架构设计、契约定义、不变量与设计文档（如 `system_design.md`、`class-diagram.mermaid` 等）。

---

## 2. 常用命令速查

### 开发与构建
```bash
# 组装资源并启动 Tauri 开发调试环境
npm run dev

# 构建安装包 / 二进制产物
npm run build
# 或直接调用
npm run tauri build
```

### 快速测试与校验门禁
```bash
# 1. 快速无头测试门禁（无需 GUI，无需组装资源包 - INV-6）
cargo test -p dsh-host -p dsh-host-cli

# 2. 编译 src-tauri 前生成桩资源（全新 checkout 缺少 resources/ 时必跑）
node scripts/stub-tauri-resources.mjs

# 3. 格式化与 Clippy 静态检查
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings

# 4. 全 Workspace 测试
cargo test --workspace
```

---

## 3. 架构边界与核心不变量

1. **无头核心库隔离（`crates/dsh-host`）**：
   - 严禁依赖 Tauri、UI 框架或窗口系统。
   - `dsh-host` 内所有测试必须能在无显示器、无预组装资源包的 CI 环境下独立通过。
2. **契约与常量集中管理（`contracts.rs`）**：
   - 所有硬编码字符串、超时时间、重试退避间隔、缓冲区大小、正则模式与探测常量，**必须**统一定义在 `crates/dsh-host/src/contracts.rs` 中，并带有 `CX —` 契约编号注释。
   - 严禁在 `launch.rs`、`readiness.rs`、`process.rs` 等业务逻辑中硬编码超时或 URL。
3. **孤儿进程防护与进程管理（INV-3）**：
   - Windows 采用 Win32 `JobObject`（`KILL_ON_JOB_CLOSE`）。
   - Linux 采用 `PR_SET_PDEATHSIG` + 进程组。
   - macOS 采用进程组 + 退出扫描清理。
   - 子进程必须保证在主程序异常崩溃或退出时不残留。
4. **日志环形缓冲与归因（C7）**：
   - 标准输出与错误输出通过 `LogRing` 缓冲并落盘（`harness.log` 与 `app.log`）。
   - 具备编码容错能力：优先 UTF-8，Windows 下回退 GBK，并过滤 ANSI 逃逸序列（`sanitize_line`）。

---

## 4. 平台兼容性与避坑指南

- **Rust 工具链版本**：因传递依赖项（如 `idna_adapter` / `url`）采用了 2024 edition 特性，要求 Rust stable `>= 1.85`。
- **Tauri 资源校验**：Tauri 的 `build.rs` 在编译期会校验资源 glob 匹配。全新拉取的代码在执行 `cargo check --workspace` 或 `cargo test --workspace` 前，需先运行 `node scripts/stub-tauri-resources.mjs`。
- **Node 执行路径**：打包产物运行内置在 `src-tauri/resources/node/` 下的 Node 二进制（Windows 下带 `.exe` 后缀）。
- **页面跳转流程**：Webview 首先加载 `frontend/index.html` 启动屏，并监听 `harness://status` 事件；`readiness` 模块探测并校验安全 Token 就绪后，Rust 层将 Webview 导航重定向至本地 Harness 服务的 Web 地址。

---

## 5. 修改敏感模块前必读文档
- `docs/system_design.md`：架构设计、缺陷清单与契约细则。
- `crates/dsh-host/src/contracts.rs`：Harness 运行时契约常量总表。
