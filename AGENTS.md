# AGENTS.md

> 面向开发人员与 AI Agent 的 `dsh-desktop`（DeepSeek Harness 桌面壳）协作指南

---

## 1. 项目概述与仓库结构

`dsh-desktop` 是基于 **Tauri 2.0** 与 **Rust** 构建的 DeepSeek Harness 跨平台桌面外壳程序。它负责打包内置 Node.js + DeepSeek Harness 服务运行时的生命周期管理，并提供 GUI 窗口承载、崩溃自愈、插件分级隔离防护以及多模型工具网关。

### 目录划分
- **`crates/dsh-contracts`**：无 GUI / 无平台绑定的通用契约库。
  - 核心职责：集中定义常量与契约标识（`CX-1` ~ `CX-9`）、标准错误分类码（`E1001` ~ `E4002`）、前后端统一 IPC 封套（`IpcEnvelope<T>`）、JSON-RPC 2.0 规范、生命周期阶段与崩溃诊断类型。
- **`crates/dsh-host`**：无 GUI 依赖的纯 Rust 核心宿主库。
  - 核心职责：子进程派生、跨平台孤儿进程防护、URL/Token 捕获、HTTP 就绪探测、日志滚动轮转、Supervisor 监督器、崩溃归因诊断、Safe Mode 隔离 Profile、多 Profile/Session 管理、插件分级隔离宿主（`plugin_worker.rs`）与断路器看门狗。
  - **严格保持无 GUI / Headless 状态（不变量 INV-6）**。
- **`crates/dsh-host-cli`**：`dsh-host` 的命令行工具前端（支持 `dsh-host start | status | stop | tail | doctor`）。
- **`crates/dsh-model-gateway`**：无 GUI 依赖的多模型工具调用清洗与适配网关库。
  - 核心职责：统一 `CanonicalTool` 抽象、复杂 Schema 降级与净化（`anyOf`/`oneOf` 规范化、深度超限保护）、多模型提供方（OpenAI、DeepSeek、Gemini、Claude）方言转换与严格模式适配、微秒级性能基准测试（`examples/benchmark.rs`）。
- **`src-tauri`**：Tauri 2.0 桌面应用层（负责窗口管理、系统托盘、生命周期、Webview IPC 封套对接、自动更新、页面导航、安全模式引导、一键脱敏导出诊断包）。
  - **`src-tauri/frontend/`**：轻量静态 Loading / Splash 启动页、Error 结构化错误页（支持插件故障归因提示）与安全模式恢复页。
- **`build/`**：运行时启动脚本与安全防护注入。
  - `harness-node-entry.mjs`：支持隔离参数（`--dsh-isolated-plugins`）与环境引导。
  - `plugin-worker-host.mjs`：基于 Node.js `worker_threads` 与子进程的插件分级隔离宿主（JSON-RPC 2.0 通信）。
  - `plugin-safety-guard.mjs`：全局未捕获异常与未处理 Promise 拦截及断路器。
- **`scripts/`**：
  - `prepare-harness.mjs`：解析、下载并组装 300MB+ 的 Node 运行时与 Harness 依赖包到 `src-tauri/resources/`；幂等快速路径按 `tauri.conf.json` → `bundle.resources` 的完整清单校验产物完整性。
  - `stub-tauri-resources.mjs`：生成轻量桩资源树，用于无资源包环境下的快速编译与单测。
  - `mock-harness.mjs`：可注入故障的假 Harness（`--fail startup | no-url | port-in-use | after-ready`），集成测试的真实子进程目标。
  - `fault-inject.mjs`：基于 `dsh-host-cli` 的孤儿进程清理与退出码归因验证。
- **`docs/`**：架构设计、契约定义、不变量与技术规范：
  - `dsh-desktop-redesign-architecture-and-plan.md`：最新系统架构重构设计与执行计划。
  - `system_design.md`：核心系统架构设计、契约定义与不变量清单。
  - `model_gateway_design.md`：多厂商大模型工具调用转换网关设计。
  - `plugin_isolation_architecture.md`：插件分级隔离机制、看门狗与 RPC 协议设计。

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
cargo test -p dsh-contracts -p dsh-host -p dsh-host-cli -p dsh-model-gateway

# 2. 编译 src-tauri 前生成桩资源（全新 checkout 缺少 resources/ 时必跑）
node scripts/stub-tauri-resources.mjs

# 3. 运行模型网关性能基准测试
cargo run --release -p dsh-model-gateway --example benchmark

# 4. 格式化与 Clippy 静态检查
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings

# 5. 全 Workspace 编译检查
cargo check --workspace
```

集成测试（`crates/dsh-host/tests/`）会真实派生 Node 进程运行 `scripts/mock-harness.mjs`，需要 `PATH` 上有 Node.js（可用 `DSH_TEST_NODE` 指定）；找不到时测试自行跳过而非失败。故障模式经 `mock-harness.mjs` 的 argv / 环境变量注入，不在 Rust 侧打桩。

---

## 3. 架构边界与核心不变量

1. **无头核心库隔离（`crates/dsh-contracts`, `crates/dsh-host`, `crates/dsh-model-gateway`）**：
   - 严禁依赖 Tauri、UI 框架或窗口系统。
   - 所有核心库测试必须能在无显示器、无预组装资源包的 CI 环境下独立通过。
2. **契约与常量集中管理（`crates/dsh-contracts`）**：
   - 所有硬编码字符串、超时时间、重试退避间隔、缓冲区大小、正则模式与探测常量，**必须**统一定义在 `crates/dsh-contracts/src/constants.rs` 中，并带有 `CX-` 契约编号注释。
   - 严禁在业务逻辑中硬编码超时、路径常量或 URL。
3. **孤儿进程防护与进程管理（INV-3）**：
   - Windows 采用 Win32 `JobObject`（`KILL_ON_JOB_CLOSE`）。
   - Linux 采用 `PR_SET_PDEATHSIG` + 进程组。
   - macOS 采用进程组 + 退出扫描清理。
   - 子进程必须保证在主程序异常崩溃或退出时不残留。
4. **生命周期监督与自愈机制（Supervisor）**：
   - 内置状态机（Stopped -> Starting -> Healthy -> Degraded -> Crashed）。
   - 支持心跳探活、自愈重启、重启退避与断路器机制，防止无限崩溃循环。
5. **插件分级进程隔离与熔断自愈（Tier 0/1/2）**：
   - 不可信第三方插件运行于沙箱 Worker / 子进程中，基于 JSON-RPC 2.0 双向通信。
   - 内置连续故障计数与熔断看门狗，插件级崩溃自动隔离并降级进入 Safe Mode，保障主程序不闪退。
6. **日志环形缓冲与编码容错**：
   - 标准输出与错误输出通过 `LogRing` 缓冲并落盘（`harness.log` 与 `app.log`）。
   - 编码容错：优先 UTF-8，Windows 下回退 GBK，并过滤 ANSI 逃逸序列（`sanitize_line`）。

---

## 4. 平台兼容性与避坑指南

- **Rust 工具链版本**：因传递依赖项（如 `idna_adapter` / `url`）采用了 2024 edition 特性，要求 Rust stable `>= 1.85`。
- **Tauri 资源校验**：Tauri 的 `build.rs` 在编译期会校验资源 glob 匹配。全新拉取的代码在执行 `cargo check --workspace` 或 `cargo test --workspace` 前，需先运行 `node scripts/stub-tauri-resources.mjs`。
- **Node 执行路径**：打包产物运行内置在 `src-tauri/resources/node/` 下的 Node 二进制（Windows 下带 `.exe` 后缀）。
- **页面跳转流程**：Webview 首先加载 `frontend/index.html` 启动屏，并监听 `harness://status` 事件；`readiness` 模块探测并校验安全 Token 就绪后，Rust 层将 Webview 导航重定向至本地 Harness 服务的 Web 地址。

### Windows 产物启动失败的三类根因（已修复，勿回归）

1. **`\\?\` verbatim 路径泄漏进子进程 argv**：Tauri 的 `resource_dir()` 来自 `current_exe().canonicalize()`，Windows 上带 `\\?\` 前缀。拼进 Node 入口脚本后 CJS loader 还原成裸盘符并抛 `EISDIR: lstat 'D:'`。修复点在 [`crates/dsh-host/src/paths.rs`](crates/dsh-host/src/paths.rs) 的 `Layout::resolve`——所有派生路径的唯一产地，禁止在别处再拼 `resource_dir` 原始值。
2. **`prepare:harness` 幂等检查漏项**：只校验 3 个文件时，缺 `bin/` / `plugin-safety-guard.mjs` / `plugin-worker-host.mjs` 的资源树会被当作完整而跳过组装（前者是 `harness-node-entry.mjs` 的直接依赖，缺失则 Harness 起不来；缺 `bin/` 则 `cargo build` 的 glob 校验直接失败）。修改 `tauri.conf.json` → `bundle.resources` 时必须同步更新 `scripts/prepare-harness.mjs` 的 `REQUIRED_FILES` / `REQUIRED_DIRS`。
3. **契约环境变量未注入**：`Launcher::execute` 在 `shell == None` 时也必须经 `harness_env()`，否则 `DSH_HOME` 等变量缺失，Harness 回退 `~/.dsh`，把可变状态写到 `app_data_dir` 之外（违反 INV-1）。

另：`npm run tauri build` 首次打包需下载 NSIS 工具链；网络不可达 GitHub releases 时打包步骤报 `timeout: global`，但 `.exe` 与资源此时已成功产出。

---

## 5. 架构演进与路线图 (P0~P4)

- **P0（契约基线与无头核心库）**：独立通用契约库（`dsh-contracts`）、集中常量契约、退出码与错误码变体映射（`E1001`~`E4002`）、无 GUI 核心库设计（`dsh-host`, `dsh-host-cli`）、Win32 JobObject / POSIX 孤儿防护。
- **P1（生命周期监督与自愈）**：Supervisor 监督器、状态流转与退避重试、LogRing 环形缓冲、崩溃归因分析（`diagnostics.rs`）与 Safe Mode 隔离 Profile。
- **P2（插件分级隔离与看门狗）**：Tier 0/1/2 分级沙箱（`plugin-worker-host.mjs`）、JSON-RPC 2.0 通信、全局未捕获异常守护（`plugin-safety-guard.mjs`）、连续错误断路器看门狗自愈（`plugin_worker.rs`）。
- **P3（多模型工具网关与基准测试）**：复杂 Schema 深度嵌套/`anyOf`/`oneOf` 降级清洗、多厂商方言适配（OpenAI/Gemini/Claude）、微秒级基准测试套件（`dsh-model-gateway`）。
- **P4（薄壳收敛与诊断系统 2.0）**：统一 IPC 封套 (`IpcEnvelope<T>`)、前端结构化错误归因、一键脱敏导出完整诊断压缩包 (`diagnostics.zip`)。

---

## 6. 修改敏感模块前必读文档
- `docs/dsh-desktop-redesign-architecture-and-plan.md`：系统重构设计与开发全流程计划。
- `docs/system_design.md`：核心系统架构设计、缺陷清单与契约细则。
- `docs/model_gateway_design.md`：大模型工具调用网关架构设计。
- `docs/plugin_isolation_architecture.md`：插件隔离与进程通信机制。
- `crates/dsh-contracts/src/constants.rs`：Harness 运行时通用契约常量总表。
- `crates/dsh-host/src/transport.rs`：IPC 传输抽象与通信信道定义。
