# AGENTS.md

> 面向开发人员与 AI Agent 的 `dsh-desktop`（DeepSeek Harness 桌面壳）协作指南

---

## 1. 项目概述与仓库结构

`dsh-desktop` 是基于 **Tauri 2.0** 与 **Rust** 构建的 DeepSeek Harness 跨平台桌面外壳程序。它负责打包内置 Node.js + DeepSeek Harness 服务运行时的生命周期管理，并提供 GUI 窗口承载与崩溃自愈。

> ⚠️ **能力口径**：文档中每个特性都必须区分「已接线」与「未接线/实验性」。本文件与 README 中列为**未接线**的项（插件分级隔离、诊断包导出）在代码中确有实现或部分实现，但**不在运行时路径上**，不得对外呈现为可用能力。判据与证据位置见 §7 宣称纪律。

### 目录划分
- **`crates/dsh-contracts`**：无 GUI / 无平台绑定的通用契约库。
  - 核心职责：集中定义常量与契约标识（`CX-1` ~ `CX-9`）、标准错误分类码（`E1001` ~ `E4002`）、前后端统一 IPC 封套（`IpcEnvelope<T>`）、JSON-RPC 2.0 规范（唯一契约源，`dsh-host` 等下游 crate 仅 re-export）、生命周期阶段与崩溃诊断类型。
- **`crates/dsh-host`**：无 GUI 依赖的纯 Rust 核心宿主库。
  - 核心职责：子进程派生、跨平台孤儿进程防护、URL/Token 捕获、HTTP 就绪探测、日志滚动轮转、Supervisor 监督器、崩溃归因诊断、Safe Mode 隔离 Profile、多 Profile/Session 管理、插件分级隔离的**状态机与断路器逻辑**（`plugin_worker.rs`，⚠️ **未接线**，见 §7）。
  - **严格保持无 GUI / Headless 状态（不变量 INV-6）**。
- **`crates/dsh-host-cli`**：`dsh-host` 的命令行工具前端（支持 `dsh-host start | status | stop | tail | doctor`）。
- **`crates/dsh-model-gateway`**：无 GUI 依赖的多模型工具调用清洗与适配网关库。⚠️ **未接线**：无任何运行时消费者，**不是** `src-tauri` 的依赖（2026-09-10 移除声明）；保留为独立可测资产。
  - 核心职责：统一 `CanonicalTool` 抽象、复杂 Schema 降级与净化（`anyOf`/`oneOf` 规范化、深度超限保护）、多模型提供方（OpenAI、DeepSeek、Gemini、Claude）方言转换与严格模式适配、微秒级性能基准测试（`examples/benchmark.rs`）。
  - 定位、接线前置与**退出条件**见 [`docs/model_gateway_design.md`](docs/model_gateway_design.md) 顶部状态表。
- **`src-tauri`**：Tauri 2.0 桌面应用层（负责窗口管理、生命周期、Webview IPC 对接、自动更新、页面导航、安全模式引导、LAN 手机桥、壳层结构化日志）。⚠️ 一键脱敏导出诊断包（`diagnostics.zip`）**未实现**，见 §7。
  - **IPC 命令面准入纪律**：每个 `#[tauri::command]` 都是对本地页开放的攻击面，**只保留有真实调用方**的命令（当前 13 个）。死命令要么接上、要么删掉——不要为「可能有用的未来 UI」预留。判定靠 `npm run verify:ipc-surface`，理由与例外清单见 `commands.rs` 模块文档。
  - **`src-tauri/frontend/`**：轻量静态 Loading / Splash 启动页、Error 结构化错误页（支持插件故障归因提示）与安全模式恢复页。
- **`build/`**：运行时启动脚本与安全防护注入。
  - `harness-node-entry.mjs`：支持隔离参数（`--dsh-isolated-plugins`）与环境引导；同时是 cold-start 投影（`projectGenerations` / `sweepRegistry`）与 `[dsh-plugin-fault]` 归因的接线点。
  - `plugin-worker-host.mjs`：基于 Node.js `worker_threads` 与子进程的插件分级隔离宿主（JSON-RPC 2.0 通信）。⚠️ **未接线**：只能由 `PluginWorkerClient` 拉起，而后者当前无调用方（见 §7）。
  - `plugin-safety-guard.mjs`：`formatFaultDetails` **已接线**（被 `harness-node-entry.mjs` 的未捕获异常/拒绝处理器消费）；`PluginWorkerClient` **未接线**。
- **`scripts/`**：
  - `prepare-harness.mjs`：解析、下载并组装 300MB+ 的 Node 运行时与 Harness 依赖包到 `src-tauri/resources/`；幂等快速路径按 `tauri.conf.json` → `bundle.resources` 的完整清单校验产物完整性；按 [`patches/LAYERS.md`](patches/LAYERS.md) 的分级决定补丁失败是降级还是中断（`--strict` 恢复全量 fail-fast）。
  - `stub-tauri-resources.mjs`：生成轻量桩资源树，用于无资源包环境下的快速编译与单测。
  - `mock-harness.mjs`：可注入故障的假 Harness（`--fail startup | no-url | port-in-use | after-ready`），集成测试的真实子进程目标。
  - `fault-inject.mjs`：基于 `dsh-host-cli` 的孤儿进程清理与退出码归因验证（6 类故障场景 / 10 项断言）；`npm run fault-inject`，CI 中 Windows 为硬门禁。
  - `verify-ipc-surface.mjs`：壳接口面一致性静态检查（命令定义 ↔ 注册 ↔ 前端 `invoke`/`listen` ↔ `local_page` 目标 ↔ `#[allow(dead_code)]` 登记）。这类断线 `dead_code` 看不见，见 §7.3。
  - `verify-target.mjs`：打包目标守卫（构建主机 vs 目标平台）。目标来源优先级：argv → `TAURI_ENV_TARGET_TRIPLE` → `rustc -vV` host；`--self-test` 跑纯逻辑自检。
  - `generate-app-icons.mjs`：**macOS 手工工具**（依赖 `sips` / `iconutil`），刻意无 npm 入口、不进 CI；定位与产物去向见其文件头注释。
  - `smoke-launch.mjs`：CI 分层烟雾（L1 无头 / L2 GUI），见 §2。
  - `report-bundle-size.mjs`：采集壳/安装包/资源树体积，写入 CI job summary（§7 期望管理）。
- **`patches/`**：`patch-package` 补丁 + [`LAYERS.md`](patches/LAYERS.md) 分级清单（`brand` / `ui-behavior` / `functional`）。
- **`docs/`**：架构设计、契约定义、不变量与技术规范：
  - `dsh-desktop-redesign-architecture-and-plan.md`：最新系统架构重构设计与执行计划。
  - `system_design.md`：核心系统架构设计、契约定义与不变量清单。
  - `model_gateway_design.md`：多厂商大模型工具调用转换网关设计（含未接线状态与退出条件）。
  - `plugin_isolation_architecture.md`：插件分级隔离机制、看门狗与 RPC 协议设计（含未接线状态）。
  - `dsh-upgrade-checklist.md`：DSH 官方版本升级清单（补丁重生成 → 断言 → 门禁 → 三平台烟雾 → 体积对比）。
  - `harness-packaging-and-compatibility.md`：产物瘦身与补丁脆弱性治理的长期方案（A/B/C）。

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

# 6. 补丁分级自检（patches/ 与 patch-layers.mjs 登记表一致性）
npm run verify:patches

# 7. 壳接口面一致性（命令定义 ↔ 注册 ↔ 前端 invoke/listen ↔ 页面可达性）
#    这是唯一能捕获「写了但没人调用」类断线的门禁——见 §7.3
npm run verify:ipc-surface

# 8. 打包目标守卫（构建主机 vs 目标平台；自动推断，亦可 `-- self-test` 自检）
npm run verify:target
npm run verify:target -- --self-test

# 9. 故障注入（孤儿进程清理 + 退出码归因，10 项断言）
#    前置：cargo build -p dsh-host-cli
npm run fault-inject

# 10. 分层烟雾（L1 无头硬门禁；L2 需已构建产物，缺失则 SKIP）
npm run smoke:headless
npm run smoke

# 11. 产物体积三口径（壳二进制 / 安装包 / 资源树）
npm run size:report
```

集成测试（`crates/dsh-host/tests/`）会真实派生 Node 进程运行 `scripts/mock-harness.mjs`，需要 `PATH` 上有 Node.js（可用 `DSH_TEST_NODE` 指定）；找不到时测试自行跳过而非失败。故障模式经 `mock-harness.mjs` 的 argv / 环境变量注入，不在 Rust 侧打桩。

#### ⚠️ 已知环境限制：GNU 工具链下 Clippy 在 `dsh-model-gateway` 上 ICE

同一台 `x86_64-pc-windows-gnu` 宿主机上，`cargo clippy --workspace` 会在编译
`dsh-model-gateway` 时**编译器内部错误**（`the compiler unexpectedly panicked`，
rustc 1.97.1 / clippy 0.1.97），停在 `codegen_and_build_linker`。

- **性质**：clippy 自身缺陷（环境相关），与本仓库源码无关：同一命令在 `cargo check --workspace` 下完全通过。
- **怎么办**：
  1. 本地用 `cargo check --workspace --all-targets` 替代（能报出全部真实 warning，包括 CI `-D warnings` 会拦下的 `unused_imports`）；
  2. clippy 的权威执行者是 CI（MSVC 工具链，三个平台都跑）。

#### ⚠️ 已知环境限制：GNU 工具链下 `dsh-desktop` 的测试二进制无法加载

在 **`x86_64-pc-windows-gnu`**（mingw）宿主机上，`cargo test -p dsh-desktop` 会失败：

```text
dsh_desktop_lib-<hash>.exe: error while loading shared libraries:
api-ms-win-core-winrt-error-l1-1-0.dll: cannot open shared object file
（或 STATUS_ENTRYPOINT_NOT_FOUND / 0xc0000139）
```

- **根因**：该导入来自 Tauri 无条件链接的 `webview2-com-sys`（WinRT）。本机 `System32` 与 `System32\downlevel` 下都没有该 API set DLL，GNU 运行时加载器不会去 MSVC 的解析路径找它。
- **性质**：失败发生在**动态加载阶段**，早于测试 harness 的 `main()`——因此与任何测试代码无关，也不会因源码改动而出现或消失。
- **后果**：`cargo test --workspace` 在本机必然失败；`src-tauri` 下的单元测试（含 `mobile_bridge.rs`）**只能编译、不能本地执行**。
- **怎么办**：
  1. 本地依赖上面第 1 条的**无头门禁**（不含 `src-tauri`，这正是 INV-6 的价值）；
  2. `src-tauri` 的行为由第 7 条的 L1/L2 烟雾覆盖（它派生真实进程，不依赖 Rust 单测）；
  3. `src-tauri` 单测的实际执行者是 CI——GitHub runner 用 **MSVC** 工具链，该导入可正常解析，故 CI 的 `cargo test --workspace` 有意义。
  4. 若本机需要跑这些单测，唯一可靠路径是切到 MSVC 工具链（`rustup default stable-x86_64-pc-windows-msvc`），这不是代码问题。


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

Harness 页面运行在 Tauri webview 中。**此处曾有一处机制误判，已更正**：早期版本写「没有 preload / initialization script，任何 `window.*` 全局都无处定义」——**这句话是错的**。Tauri 的 `WebviewWindowBuilder::initialization_script` 会在每次顶层导航前执行脚本，正是 preload 的等价物；本仓已用它向 Harness 页注入手机状态指示器（见 §7.2 与 `src-tauri/src/harness_ui.rs`）。所以「定义不了全局」这个理由不成立。

**结论不变，但理由要换成成立的**：曾有一个 `patch-package` 补丁把原生目录选择器改成 `window.dshDesktopDirectoryPicker.pick()`，该全局在整个仓库中从未被定义（从没有任何注入脚本定义过它），导致工作区导入时必然弹出「无法打开文件夹 / DSH Desktop directory picker bridge is unavailable」。

即便今天有能力定义这样一个全局，**也不该走这条路**：页面若要回连宿主，就得为 Harness 这个**远程 origin** 开一个 IPC 入口，而本仓的命令面是收紧的（见 INV-2 与 §7）。注入机制只用于**壳层 → 页面**的单向下发。

正确路径是上游 stock 实现：客户端调用 `ctx.uiWorkspace.pickDirectory()` → Host `ctx.directoryPicker` seam → `@deepseek-ai/dsh-host-directory-picker-native` 在 Harness 进程内拉起 Win32 `IFileOpenDialog`。因为 Harness 绑定 `127.0.0.1`，`directory-picker-auto` 必定解析到 native 组合，无需任何 renderer IPC（这也与 INV-2 一致：harness 页没有 remote capability，本来也调不动宿主命令）。

`scripts/prepare-harness.mjs` 的 `assertPickerSurfaceIsHostBacked()` 会在应用补丁后校验该文件不再引用 `window.dshDesktop*` 且仍调用 `ctx.uiWorkspace.pickDirectory()`，违反即构建失败。

### 快照契约：`HarnessSnapshot.phase` 必须 `#[serde(flatten)]`（已修复，勿回归）

`harness_status` 命令与 `harness://status` 事件共用同一个载荷 `HarnessSnapshot`，契约为 `phase` 的 tag 与 `message` / `logs` **平铺**（与上游 `RuntimeStatus` 一致）：

```json
{ "phase": "failed", "cause_kind": "plugin_fault", "plugin_fault": true, "message": "…", "logs": ["…"] }
```

此前 `state.rs` 只**写了这句话**、漏了属性，实际发出 `{"phase":{"phase":"failed",…}}`。编译器不会报错——`Serialize` 照常成功，只是形状变了；而唯一的消费方 `frontend/error.html` 判的是 `snapshot.phase === 'failed'`，于是**恒为 false**：「疑似插件故障 → 建议进入安全模式」分支与安全模式按钮**从未生效过**。2026-09-10 用 serde 探针打印真实 JSON 才定位到。

这是跨语言契约问题的典型形态：**两侧各自都没错，错在中间的形状**。守护它的是 `state.rs` 的 `snapshot_json_keeps_the_phase_tag_flat`（CI 运行；本机 GNU 工具链跑不了 `src-tauri` 单测，原因见 §2）。

### 插件「已安装但未生效」的两类根因（已修复，勿回归）

市场对「安装成功却不在 `dsh.profile.bundles` 里」的包会给出结论，历史上此处出过两个独立缺陷，都会让一个**声明了 `dsh.bundle.patch` 的插件**永远挂载不上：

1. **`dsh.client` 单独作为「纯客户端插件」判据**：`vendor/dshmarket/src/verify.ts` 的 client-only 分支原本只测 `dsh.client !== undefined`。同时声明 `dsh.bundle` **和** `dsh.client` 的包（如 `dsh-better-sidebar`）因此被误判为「未声明 dsh.bundle」，提示用户「重启后由市场自动挂载生效」——而重启永远不会让它生效。判据必须成对：`dsh.client !== undefined && dsh.bundle === undefined`（`hasHostHalf` / `hot.ts` 的 shim 挂载早已如此）。
2. **cold-start 投影从未被调用**：`generations/projection.mjs` 的 `projectGenerations()` 是唯一会把 generation 插件写入 `dsh.profile.bundles` 并建立 `node_modules` 链接的函数，但整个仓库没有任何调用方——注释里说的「cold-start projector」并不存在。因此 generation 安装只 publish 了 manifest（`syncBundles: false` 是有意的：Harness 运行时不能替换 junction），却再也没有第二次机会把 bundle 层补上。修复在 [`build/harness-node-entry.mjs`](build/harness-node-entry.mjs)：在 import DSH 入口**之前**、且仅当 `$DSH_HOME/profiles/.generations/desired.json` 存在时执行 `projectGenerations()`，随后执行同样从未被调用的 `sweepRegistry()`。投影只收录**自己声明 `dsh.bundle.patch`** 的 generation：`loadProfile` 遇到列入 `bundles` 却没有 `dsh.bundle` 的包会直接抛错，整棵 profile 起不来，而纯客户端插件正是这种形状（它们由市场 shim 挂载）。已列入的条目除 generation 自有项外一律保留（部分 bundle 从 dsh 安装目录解析，重建列表会误删）。

配套：`scripts/prepare-harness.mjs` 的输入指纹此前不含 `build/`，而 `build/` 是原样拷进 `resources/` 的非依赖文件——改了 `harness-node-entry.mjs` 后指纹不变，快速路径复用旧副本，修改被静默丢弃。现在指纹包含 `build/` 摘要，且快速路径会调用 `copyBuildFiles()` 同步产物。（`vendor/` 无需摘要：这些条目以符号链接进入 `resources/`，打包时解引用，内容始终最新。）

---

## 5. 架构演进与路线图 (P0~P4)

> 下表描述**设计目标**，不等于当前可用能力。阶段名后标注的状态以 §7 的代码证据为准；
> 凡标 ⚠️ 者，代码存在但未接线，不得按「已完成」对外表述。

- **P0（契约基线与无头核心库）✅ 已接线**：独立通用契约库（`dsh-contracts`）、集中常量契约、退出码与错误码变体映射（`E1001`~`E4002`）、无 GUI 核心库设计（`dsh-host`, `dsh-host-cli`）、Win32 JobObject / POSIX 孤儿防护。
- **P1（生命周期监督与自愈）✅ 已接线**：Supervisor 监督器、状态流转与退避重试、LogRing 环形缓冲、崩溃归因分析（`diagnostics.rs`，输出归因结论而非压缩包）与 Safe Mode 隔离 Profile。
- **P2（插件分级隔离与看门狗）⚠️ 未接线**：Tier 0/1/2 分级沙箱（`plugin-worker-host.mjs`）、JSON-RPC 2.0 通信、连续错误断路器（`plugin_worker.rs`）均已实现且有单测，但**没有任何运行时调用方**——`PluginWorkerClient` 无消费者，`call_tool` 现返回显式错误而非伪造成功。当前生效的插件防护只有 `plugin-safety-guard.mjs` 的进程内 `formatFaultDetails` 归因。接线前置见 `docs/plugin_isolation_architecture.md`。
- **P3（多模型工具网关与基准测试）⚠️ 未接线**：复杂 Schema 深度嵌套/`anyOf`/`oneOf` 降级清洗、多厂商方言适配（OpenAI/Gemini/Claude）、微秒级基准测试套件（`dsh-model-gateway`）均已实现并测试通过，但无运行时消费者，已从 `src-tauri` 依赖中移除。退出条件见 `docs/model_gateway_design.md`。
- **P4（薄壳收敛与诊断系统 2.0）🟡 部分**：前端结构化错误归因已接线；**统一 IPC 封套（`IpcEnvelope<T>`）尚未接线**（契约已定义，16 个命令仍返回 `Result<T, String>`）；**一键脱敏导出诊断压缩包（`diagnostics.zip`）未实现**，当前只有 `dsh-host-cli doctor` 与壳层日志（`desktop.log`）两条可用的证据获取路径。

---

## 6. 修改敏感模块前必读文档
- `docs/dev-plan-disconnected-points.md`：**当前主计划**——断线点清单（D1~D11）与批次 A~G 的施工计划、进度快照与需裁决的决策点。**开工前先看它的「进度快照」表与 §4 决策点。**
- `docs/dsh-desktop-redesign-architecture-and-plan.md`：系统重构设计与开发全流程计划。
- `docs/system_design.md`：核心系统架构设计、缺陷清单与契约细则。
- `docs/model_gateway_design.md`：大模型工具调用网关架构设计。
- `docs/plugin_isolation_architecture.md`：插件隔离与进程通信机制。
- `crates/dsh-contracts/src/constants.rs`：Harness 运行时通用契约常量总表。
- `crates/dsh-contracts/src/rpc.rs`：JSON-RPC 2.0 消息模型唯一契约源（Rust 侧）。
- `crates/dsh-host/src/transport.rs`：IPC 传输抽象与通信信道定义；RPC 类型 re-export 自 `dsh-contracts::rpc`。

---

## 7. 宣称纪律（Claim Discipline）

**背景**：外部评审（2026-09）指出 README / 文档宣称的能力与实际代码存在落差。逐项核对后有 4 项宣称在代码中**没有运行时路径**：插件分级隔离、多模型工具网关、一键诊断包、LAN 手机桥（本轮已接线）。这不是「文档写早了」的程度问题——`plugin_worker.rs::call_tool` 当时会**返回伪造的成功结果**（`success: true`），即上层无法通过任何观测手段发现插件工具其实根本没被执行。

### 7.1 三条硬规则

1. **未接线的能力必须显式标注**。任何「已实现但无运行时调用方」的模块，必须在其模块文档头部加 `⚠️ 状态：未接线` 横幅，并在本表登记。禁止用「已实现」「已支持」等词描述未接线能力。
2. **禁止伪造成功**。桩实现若被调用，必须返回**可辨识的错误**（错误串含 `ISOLATION_NOT_WIRED` 之类的稳定标识），不得返回 `Ok` / `success: true` / 空数组等合理默认值。判据：调用方能否从返回值区分「成功」与「未接线」。
3. **禁止无声降级**。允许降级（如补丁分级失败策略），但必须把降级事实写进产物：`MANIFEST.json` 的 `patches[]` 逐条记录 `applied / skipped / failed`，缺记录即视为未应用。

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
| **插件分级隔离 Tier 0/1/2** | ⚠️ **未接线** | `crates/dsh-host/src/plugin_worker.rs`（`call_tool` :191 返回 `ISOLATION_NOT_WIRED`）、`build/plugin-worker-host.mjs`、`build/plugin-safety-guard.mjs:PluginWorkerClient`（:52） | **无**（`PluginWorkerClient` 无消费者） |
| **多模型工具网关** | ⚠️ **未接线** | `crates/dsh-model-gateway/**` | **无**（2026-09-10 从 `src-tauri/Cargo.toml` 移除） |
| **一键脱敏诊断包 `diagnostics.zip`** | ❌ **未实现** | 无对应代码 | **无** |
| LAN 手机桥（扫码配对 + cookie 握手） | ✅ 已接线 | `src-tauri/src/mobile_bridge.rs`、`state.rs::sync_mobile_target`（:352）、`menu.rs` 手机子菜单 | 应用菜单 `mobile-pair` / `mobile-stop` |
| 壳层结构化日志 `desktop.log` | ✅ 已接线 | `src-tauri/src/logging.rs::init`（:46） | `src-tauri/src/lib.rs:70` |
| 补丁分级与失败降级 | ✅ 已接线 | `scripts/patch-layers.mjs`、`patches/LAYERS.md`、`prepare-harness.mjs` | 构建期；结果落 `MANIFEST.json:patches[]` |
| **统一 IPC 封套 `IpcEnvelope<T>`** | ⚠️ **未接线** | 契约定义在 `crates/dsh-contracts/src/ipc.rs:7` | **无**：`src-tauri/src/commands.rs` 的 14 个命令全部返回 `Result<T, String>` |
| **自动更新链路** | ✅ 已接线（2026-09-10 批次 B 闭环） | `src-tauri/src/update.rs` + `tauri-plugin-updater`（`lib.rs:58`、`UpdateManager` 构造于 `lib.rs:145`）；`tauri.conf.json` 开启 `bundle.createUpdaterArtifacts` | 菜单 `updates-check` → `window::show_updates_page` + `UpdateManager::check(true)`；`frontend/updates.html` 调 `updates_status` / `updates_check` / `updates_download` / `updates_install` / `updates_skip` 并监听 `updates://status` |
| ↳ 更新源归属与签名密钥 | ✅ 已闭环（2026-09-10） | `plugins.updater.endpoints` 指向 `github.com/wang-yi-bit64/dsh-desktop/releases/latest/download/latest.json`；配置里的 `pubkey` 与 `~/.tauri/dsh-desktop.key.pub` **逐字节一致** | 私钥经 CI Secret `TAURI_SIGNING_PRIVATE_KEY` 注入（无口令），本地离线备份在 `~/.tauri/backup/` |
| **应用内日志查看器** | ❌ **未实现** | 无 `frontend/logs.html`；`harness-view-log` 仅调用 `opener` 打开系统文件管理器 | **无** |
| **错误页「安全模式」按钮** | ✅ 已接线（2026-09-10 修复调用名；同日补完启动链路） | `src-tauri/frontend/error.html` 调 `safe_mode_action`（`action: "restart"`），失败经 `fail()` 可见上报 | 错误页按钮 → `commands::safe_mode_action` → `HarnessSupervisor::restart_in_safe_mode`（此前调 `restart()`，实际只是**普通重启**——按钮曾是谎话） |
| **恢复页交互** | ❌ **未接线** | `recovery_action` / `safe_mode_action`（restart/quit）已定义且注册 | **无**：`plugin-recovery.html` 与 `safe-mode.html` 零 `invoke`、零事件监听（`plugin-recovery.html` 甚至无 `local_page` 指向，不可达） |
| 手机桥状态可见性 | ✅ 已接线（2026-09-10） | `src-tauri/src/menu.rs` 的 `Phone` 子菜单状态行 + `mobile_bridge::status_label`；`MobileBridge::on_connected_change`（镜像上游 `onConnectedChange`）在配对状态翻转时回调 | 菜单构建时初始化，**手机侧 `POST /pair` 成功**、菜单配对/停止时均经 `refresh_bridge_status` 刷新（`lib.rs` setup 注册监听器） |
| ↳ 页内手机状态指示器（Harness 侧边栏） | ✅ 已接线（2026-09-10） | `harness_ui.rs::INJECT_SCRIPT`（`include_str!` 内嵌 `frontend/harness-ui-inject.js`），挂在 `[data-dsh-sidebar-settings]` 下；状态下发 `push_phone_status` 走 `webview.eval`，**不新增 IPC 命令** | 两个推送点：连接翻转（`on_connected_change`）与页面加载完成（`on_page_load`）。**只做状态指示、不可点击**——配对/停止仍只走原生 `Phone` 菜单，因此它不渲染成按钮 |
| **Harness 页注入机制（preload 等价物）** | ✅ 已接线（2026-09-10；同期更正「无初始化脚本」的误判） | 主窗口 builder 的 `initialization_script`（`lib.rs`）+ `frontend/harness-ui-inject.js`；脚本按 origin 自我早退（本地页与子框架不注入） | 无头行为自测 `npm run verify:harness-inject`（19 项断言 + 可证伪性检查，已进 CI） |

### 7.3 维护方式

- 新增能力时：先写代码，再在本表补一行——**顺序不可颠倒**。
- 状态词只有四种，含义互不重叠，**不得混用**：
  | 状态 | 含义 |
  |------|------|
  | ✅ 已接线 | 有代码、有运行时调用方，用户可见 |
  | ⚠️ 未接线 | **代码已写但无运行时调用方**（如 `plugin_worker.rs`）——这是「欠债」，必须登记销账批次 |
  | ❌ 未实现 | **代码不存在**——这是「缺口」，不得对外宣称 |
  | 🕓 计划中 | **代码不存在，且刻意不现在做**——这是「决策」，不是欠债。必须写明后置理由（通常是为等前置能力稳定） |
  「未接线」与「计划中」的区别是**有没有代码**：前者是写了没接（欠债），后者是还没写（决策）。把计划中说成未接线会误导读者去找不存在的代码；把未接线说成计划中则是在给欠债打掩护。
- 修改未接线模块（如把 `plugin_worker.rs` 接入运行时）时：必须同步删除其 `⚠️ 未接线` 横幅、更新本表状态、更新 `docs/plugin_isolation_architecture.md` 的状态段。
- 评审 / 发布前自查：`grep -rn "⚠️ 未接线\|未实现" AGENTS.md README.md docs/` 应只命中**确实未接线**的条目。
- 与 B1 的联动：任何新增 `patch-package` 补丁必须同时登记进 `patches/LAYERS.md` 与 `scripts/patch-layers.mjs`，否则 `prepare-harness.mjs` 会以「未登记」告警并回退默认层。
- **本表只覆盖「契约 / 能力」级宣称**。比它更细一层的问题是「命令写了但没人调用、页面打包了但不可达」——那类断线在 Rust 里不可见（`src-tauri` 是 `rlib`，`pub` 项一律算「可达」，`dead_code` 永不触发），只能靠 `npm run verify:ipc-surface` 静态比对。该脚本的检查项、允许清单与「为什么必须有它」，写在脚本头部注释里，新增例外必须**在 `ALLOW_*` 里写明理由**。
