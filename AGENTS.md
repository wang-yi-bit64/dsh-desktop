# AGENTS.md

> 面向开发人员与 AI Agent 的 `dsh-desktop`（DeepSeek Harness 桌面壳）协作指南

---

## 1. 项目概述与仓库结构

`dsh-desktop` 是基于 **Tauri 2.0** 与 **Rust** 构建的 DeepSeek Harness 跨平台桌面外壳程序。它负责打包内置 Node.js + DeepSeek Harness 服务运行时的生命周期管理，并提供 GUI 窗口承载、崩溃自愈、插件隔离防护以及多模型工具网关。

### 目录划分
- **`crates/dsh-host`**：无 GUI 依赖的纯 Rust 核心宿主库。
  - 核心职责：子进程派生、跨平台孤儿进程防护、URL/Token 捕获、HTTP 就绪探测、日志滚动轮转、Supervisor 监督器、崩溃归因诊断、Safe Mode 隔离 Profile、多 Profile/Session 管理、跨平台 Transport 与停止语义。
  - **严格保持无 GUI / Headless 状态（不变量 INV-6）**。
- **`crates/dsh-host-cli`**：`dsh-host` 的命令行工具前端（支持 `dsh-host start | status | stop | tail`）。
- **`crates/dsh-model-gateway`**：无 GUI 依赖的多模型工具调用清洗与适配网关库。
  - 核心职责：统一 `CanonicalTool` 抽象、多模型提供方（OpenAI、DeepSeek、Gemini、Claude）JSON Schema 格式清洗与方言转换、严格模式适配及请求 Payload 组装。
- **`src-tauri`**：Tauri 2.0 桌面应用层（负责窗口管理、系统托盘、生命周期、Webview IPC、自动更新、页面导航、安全模式引导）。
  - **`src-tauri/frontend/`**：轻量静态 Loading / Splash 启动页、Error 结构化错误页（支持插件故障归因提示）与安全模式恢复页。
- **`build/`**：运行时启动脚本与安全防护注入。
  - `harness-node-entry.mjs`：支持隔离参数（`--dsh-isolated-plugins`）与环境引导。
  - `plugin-worker-host.mjs`：基于 Node.js `worker_threads` 的插件进程级隔离宿主。
  - `plugin-safety-guard.mjs`：全局未捕获异常与未处理 Promise 拦截及断路器。
- **`scripts/`**：
  - `prepare-harness.mjs`：解析、下载并组装 300MB+ 的 Node 运行时与 Harness 依赖包到 `src-tauri/resources/`。
  - `stub-tauri-resources.mjs`：生成轻量桩资源树，用于无资源包环境下的快速编译与单测。
- **`docs/`**：架构设计、契约定义、不变量与技术规范：
  - `system_design.md`：核心系统架构设计、契约定义与不变量清单。
  - `model_gateway_design.md`：多厂商大模型工具调用转换网关设计。
  - `plugin_isolation_architecture.md`：插件进程隔离机制、看门狗与 RPC 协议设计。

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
cargo test -p dsh-host -p dsh-host-cli -p dsh-model-gateway

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

1. **无头核心库隔离（`crates/dsh-host`, `crates/dsh-model-gateway`）**：
   - 严禁依赖 Tauri、UI 框架或窗口系统。
   - 所有核心库测试必须能在无显示器、无预组装资源包的 CI 环境下独立通过。
2. **契约与常量集中管理（`contracts.rs`）**：
   - 所有硬编码字符串、超时时间、重试退避间隔、缓冲区大小、正则模式与探测常量，**必须**统一定义在 `crates/dsh-host/src/contracts.rs` 中，并带有 `CX —` 契约编号注释。
   - 严禁在业务逻辑中硬编码超时、路径常量或 URL。
3. **孤儿进程防护与进程管理（INV-3）**：
   - Windows 采用 Win32 `JobObject`（`KILL_ON_JOB_CLOSE`）。
   - Linux 采用 `PR_SET_PDEATHSIG` + 进程组。
   - macOS 采用进程组 + 退出扫描清理。
   - 子进程必须保证在主程序异常崩溃或退出时不残留。
4. **生命周期监督与自愈机制（Supervisor）**：
   - 内置状态机（Stopped -> Starting -> Healthy -> Degraded -> Crashed）。
   - 支持心跳探活、自愈重启、重启退避与断路器机制，防止无限崩溃循环。
5. **插件故障隔离与诊断归因（C7、Safe Mode）**：
   - 针对插件级崩溃进行精准识别与归因，前端提供明确的故障插件提示。
   - 具备安全模式切换能力：生成隔离的 Profile 配置，在不加载第三方故障插件的前提下保障核心功能。
6. **日志环形缓冲与编码容错**：
   - 标准输出与错误输出通过 `LogRing` 缓冲并落盘（`harness.log` 与 `app.log`）。
   - 编码容错：优先 UTF-8，Windows 下回退 GBK，并过滤 ANSI 逃逸序列（`sanitize_line`）。

---

## 4. 平台兼容性与避坑指南

- **Rust 工具链版本**：因传递依赖项（如 `idna_adapter` / `url`）采用了 2024 edition 特性，要求 Rust stable `>= 1.85`。
- **Tauri 资源校验**：Tauri 的 `build.rs` 在编译期会校验资源 glob 匹配。全新拉取的代码在执行 `cargo check --workspace` 或 `cargo test --workspace` 前，需先运行 `node scripts/stub-tauri-resources.mjs`。
- **Node 执行路径**：打包产物运行内置在 `src-tauri/resources/node/` 下的 Node 二进制（Windows 下带 `.exe` 后缀）。
- **页面跳转流程**：Webview 首先加载 `frontend/index.html` 启动屏，并监听 `harness://status` 事件；`readiness` 模块探测并校验安全 Token 就绪后，Rust 层将 Webview 导航重定向至本地 Harness 服务的 Web 地址。

---

## 5. 架构演进与路线图 (P0~P3)

- **P0（契约基线与无头核心库）**：集中常量契约（`contracts.rs`）、退出码与错误变体映射、无 GUI 核心库设计（`dsh-host`, `dsh-host-cli`）、Win32 JobObject / POSIX 孤儿防护。
- **P1（生命周期监督与自愈）**：Supervisor 监督器、状态流转与退避重试、LogRing 环形缓冲、崩溃归因分析（`diagnostics.rs`）与 Safe Mode 隔离 Profile。
- **P2（插件隔离与统一传输）**：Worker 线程插件沙箱（`plugin-worker-host.mjs`）、全局未捕获异常守护（`plugin-safety-guard.mjs`）、双向 IPC 传输与信道抽象（`crates/dsh-host/src/transport.rs`）。
- **P3（多模型工具调用网关）**：多厂商 Schema 清洗与校验、方言适配与 Payload 组装（`crates/dsh-model-gateway`）。

---

## 6. 修改敏感模块前必读文档
- `docs/system_design.md`：核心系统架构设计、缺陷清单与契约细则。
- `docs/model_gateway_design.md`：大模型工具调用网关架构设计。
- `docs/plugin_isolation_architecture.md`：插件隔离与进程通信机制。
- `crates/dsh-host/src/contracts.rs`：Harness 运行时契约常量总表。
- `crates/dsh-host/src/transport.rs`：IPC 传输抽象与通信信道定义。
