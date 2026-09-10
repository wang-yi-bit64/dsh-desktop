# AGENTS.md

> 面向开发人员与 AI Agent 的 `dsh-desktop`（DeepSeek Harness 桌面壳）协作指南

---

## 1. 项目概述与仓库结构

`dsh-desktop` 是基于 **Tauri 2.0** 与 **Rust** 构建的 DeepSeek Harness 跨平台桌面外壳程序。它负责打包内置 Node.js + DeepSeek Harness 服务运行时的生命周期管理，并提供 GUI 窗口承载、崩溃自愈、插件分级隔离防护以及多模型工具网关。

### 目录划分
- **`crates/dsh-contracts`**：无 GUI / 无平台绑定的通用契约库。
  - 核心职责：集中定义常量与契约标识（`CX-1` ~ `CX-9`）、标准错误分类码（`E1001` ~ `E4002`）、前后端统一 IPC 封套（`IpcEnvelope<T>`）、JSON-RPC 2.0 规范（唯一契约源，`dsh-host` 等下游 crate 仅 re-export）、生命周期阶段与崩溃诊断类型。
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
   - JSON-RPC 2.0 消息模型（`RpcId` / `RpcRequest` / `RpcResponse` / `RpcError` / `RpcMessage`）的**唯一定义点**是 `crates/dsh-contracts/src/rpc.rs`；`dsh-host/src/transport.rs` 仅 re-export，`dsh-host/src/contracts.rs` 的 glob re-export 与之指向同一组类型。**严禁在任何 crate 内重复定义协议类型**，否则会形成同名异型冲突（该问题已于 2026-09 修复）。Node 侧 `build/plugin-worker-host.mjs` 按同一协议手写实现，错误码语义必须与契约保持一致。
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

### 目录选择器必须走 Host seam，禁止引入 renderer 全局桥（已修复，勿回归）

Harness 页面运行在 Tauri webview 中，**没有 preload / initialization script**，任何 `window.*` 全局都无处定义。曾有一个 `patch-package` 补丁把原生目录选择器改成 `window.dshDesktopDirectoryPicker.pick()`，该全局在整个仓库中从未被定义，导致工作区导入时必然弹出「无法打开文件夹 / DSH Desktop directory picker bridge is unavailable」。

正确路径是上游 stock 实现：客户端调用 `ctx.uiWorkspace.pickDirectory()` → Host `ctx.directoryPicker` seam → `@deepseek-ai/dsh-host-directory-picker-native` 在 Harness 进程内拉起 Win32 `IFileOpenDialog`。因为 Harness 绑定 `127.0.0.1`，`directory-picker-auto` 必定解析到 native 组合，无需任何 renderer IPC（这也与 INV-2 一致：harness 页没有 remote capability，本来也调不动宿主命令）。

`scripts/prepare-harness.mjs` 的 `assertPickerSurfaceIsHostBacked()` 会在应用补丁后校验该文件不再引用 `window.dshDesktop*` 且仍调用 `ctx.uiWorkspace.pickDirectory()`，违反即构建失败。

### 插件「已安装但未生效」的两类根因（已修复，勿回归）

市场对「安装成功却不在 `dsh.profile.bundles` 里」的包会给出结论，历史上此处出过两个独立缺陷，都会让一个**声明了 `dsh.bundle.patch` 的插件**永远挂载不上：

1. **`dsh.client` 单独作为「纯客户端插件」判据**：`vendor/dshmarket/src/verify.ts` 的 client-only 分支原本只测 `dsh.client !== undefined`。同时声明 `dsh.bundle` **和** `dsh.client` 的包（如 `dsh-better-sidebar`）因此被误判为「未声明 dsh.bundle」，提示用户「重启后由市场自动挂载生效」——而重启永远不会让它生效。判据必须成对：`dsh.client !== undefined && dsh.bundle === undefined`（`hasHostHalf` / `hot.ts` 的 shim 挂载早已如此）。
2. **cold-start 投影从未被调用**：`generations/projection.mjs` 的 `projectGenerations()` 是唯一会把 generation 插件写入 `dsh.profile.bundles` 并建立 `node_modules` 链接的函数，但整个仓库没有任何调用方——注释里说的「cold-start projector」并不存在。因此 generation 安装只 publish 了 manifest（`syncBundles: false` 是有意的：Harness 运行时不能替换 junction），却再也没有第二次机会把 bundle 层补上。修复在 [`build/harness-node-entry.mjs`](build/harness-node-entry.mjs)：在 import DSH 入口**之前**、且仅当 `$DSH_HOME/profiles/.generations/desired.json` 存在时执行 `projectGenerations()`，随后执行同样从未被调用的 `sweepRegistry()`。投影只收录**自己声明 `dsh.bundle.patch`** 的 generation：`loadProfile` 遇到列入 `bundles` 却没有 `dsh.bundle` 的包会直接抛错，整棵 profile 起不来，而纯客户端插件正是这种形状（它们由市场 shim 挂载）。已列入的条目除 generation 自有项外一律保留（部分 bundle 从 dsh 安装目录解析，重建列表会误删）。

配套：`scripts/prepare-harness.mjs` 的输入指纹此前不含 `build/`，而 `build/` 是原样拷进 `resources/` 的非依赖文件——改了 `harness-node-entry.mjs` 后指纹不变，快速路径复用旧副本，修改被静默丢弃。现在指纹包含 `build/` 摘要，且快速路径会调用 `copyBuildFiles()` 同步产物。（`vendor/` 无需摘要：这些条目以符号链接进入 `resources/`，打包时解引用，内容始终最新。）

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
- `crates/dsh-contracts/src/rpc.rs`：JSON-RPC 2.0 消息模型唯一契约源（Rust 侧）。
- `crates/dsh-host/src/transport.rs`：IPC 传输抽象与通信信道定义；RPC 类型 re-export 自 `dsh-contracts::rpc`。
