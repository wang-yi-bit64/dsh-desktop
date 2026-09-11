# DSH Desktop (Tauri)

> [English Document](README.md)

使用 **Rust + Tauri 2.0** 重新构建的 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 桌面套壳。

本仓库是从零开始的 Rust/Tauri 移植版本，目标是替代基于 Electron 的 `dataelement/dsh-desktop` 套壳。它在行为上与原始套壳保持一致，使桌面应用与 Harness Web UI 功能完全对齐，同时用更轻量、更高性能的 Tauri 外壳取代 Electron 运行时。

## 功能特性

> **状态标记约定**：✅ 已接线（在运行时路径上）· ⚠️ 未接线（代码已实现并测试，但无运行时调用方）· 🟡 部分 · ❌ 未实现 · 🗄️ 已归档（曾实现，现已删除并正式裁定不做）· 🕓 计划中（无代码，且刻意不现在做）。
> 每项的代码证据与调用方见 [`AGENTS.md` §7 宣称纪律](AGENTS.md#7-宣称纪律claim-discipline)。本文件与 AGENTS.md 的状态必须一致，改一处须同步另一处。
>
> 截至 2026-09-10 批次 A~G 收尾，表中**已无「未接线」条目**：能接的都接了，其余都正式归档并删除；剩下两条「计划中」是写明理由的决策，不是欠债。

### 已接线能力

- **内置运行时** ✅ —— 自带 Node.js (v24) 与完整的 `@deepseek-ai/dsh` 依赖树，宿主机无需预先安装 Node.js。
- **独立契约库 (`dsh-contracts`)** ✅ —— 彻底剥离 UI 依赖，提炼统一常量、**标准错误码总表 (`E1xxx`~`E7xxx`)**、前后端 IPC 封套 (`IpcEnvelope<T>`，其 `error` 载荷为类型化的 `AppError`) 以及 JSON-RPC 2.0 规范定义（唯一定义点，`dsh-host` 等下游 crate 仅 re-export，不重复定义）。
- **全命令面统一 IPC 封套** ✅ —— **17 个命令全部**返回 `IpcEnvelope<T>`（成败标记 + 类型化数据 + 机器可读的 `error.code` / `error.category`），且每个壳页面都会解包该封套。失败**不**用 reject 表达，因此页面可以按错误的**类别**分派（「端口占用」→ 换端口重试 vs「插件故障」→ 进入安全模式），而不是对英文文案做字符串匹配。
- **Harness 核心生命周期** ✅ —— 在保留的 loopback 端口上拉起 Harness，提取进程级启动令牌，并轮询其 HTTP 就绪状态。
- **看门狗与崩溃自愈 (Supervisor)** ✅ —— 核心宿主进程内嵌状态机与心跳监督器，提供自动恢复、进程级断路器与自愈能力。
- **孤儿进程防护（INV-3）** ✅ —— Windows 走 Win32 JobObject (`KILL_ON_JOB_CLOSE`)，Linux 走 `PR_SET_PDEATHSIG` + 进程组，macOS 走进程组 + 退出扫描；主程序崩溃或退出时不残留子进程。
- **插件运行异常守护（进程内）** ✅ —— `plugin-safety-guard.mjs` 拦截未捕获异常与未处理 Promise 拒绝，产出 `[dsh-plugin-fault]` 归因信息，避免单个插件把整个 Harness 拖崩。
- **安全模式与故障恢复** ✅ —— 自动检测启动失败原因并写入独立隔离 profile，随后**真正以该 profile 启动 Harness**（`--profile desktop-safe-mode` 搭配 `dsh-desktop-safe.patch.yml`，后者会摘掉常规补丁层挂载的产品插件），保障基础功能可用。注意：安全模式生效期间，壳层界面上**尚无任何提示**——该指示器属**刻意后置的功能**，见[后续计划](#后续计划尚未开工)。
- **多 Profile 与会话管理** ✅ —— 内置 Session / Profile 状态管理与元数据持久化，支持多环境无缝切换。
- **壳层结构化日志** ✅ —— `tauri-plugin-log` 落盘到 `app_data_dir/desktop.log`（5 MB × 2 轮转，含本地时区），与 Harness 侧 `harness.log` / `app.log` 分离，便于归因「是壳的问题还是 Harness 的问题」。
- **移动桥接 (Mobile Bridge)** ✅ —— 局域网 HTTP 服务，配对页内置二维码与配对令牌，转发 RPC 到 Harness。默认**不监听**，需从应用菜单「Phone Pairing (LAN)…」显式启动；受 Harness 的 `dsh-auth-*` cookie 握手与会话令牌双重约束，进程退出即失效。菜单的 `Phone` 子菜单会实时显示桥状态（off / listening / paired），Harness 侧边栏另有一枚对应的**页内状态指示器**——注意本应用**尚无系统托盘**。
  - 该指示器由壳层注入到 Harness 页面（见下方[Harness 页面注入](#harness-页面注入)）。它**只表示状态、刻意不可点击**：配对与停止在原生 `Phone` 菜单里，壳层不会为了复制一个菜单项而向 Harness 这个远程 origin 开 IPC 入口。文案随连接状态切换（「手机未连接」/「手机已连接」），侧边栏收起且未配对时保持隐藏。
- **桌面深度定制** ✅ —— 通过 `patch-package` 补丁以及传给 `web --patch` 的 `patch.yml` 层应用桌面品牌资源与 UI 行为。补丁按 `functional` / `ui-behavior` / `brand` 三层分级（见 [`patches/LAYERS.md`](patches/LAYERS.md)），失败时默认降级并在 `MANIFEST.json` 的 `patches[]` 逐条留证；`--strict` 可恢复全量 fail-fast。
- **单实例锁定** ✅ —— 第二次启动时聚焦已有窗口，避免重复拉起多实例。
- **自动更新** ✅ —— `tauri-plugin-updater` 已注册，检查 → 下载 → 择机重启安装的完整链路均已接线，并配有应用内更新页（`frontend/updates.html`，由应用菜单「检查更新」打开）。更新源为**本仓库**（`wang-yi-bit64/dsh-desktop`），验签使用**本项目自有**的 minisign 密钥。发布正式包前请先读[自动更新与签名密钥](#自动更新与签名密钥)。
- **插件恢复流程** ✅ —— 真正的恢复页（`frontend/plugin-recovery.html`），在疑似插件故障时从错误页进入。它调用 `recovery_status`（归因结论 + 嫌疑插件清单，数据直接来自 `dsh_host::diagnostics`）与 `recovery_action`（`safe-mode` / `restart` / `show-log` / `quit`），失败在页面上可见，并监听 `harness://status` 让重启过程真的可见。它**只提供非破坏性动作**——「卸载插件」为何刻意缺席见下方「已归档 / 计划中」。
- **一键脱敏诊断包导出** ✅ —— 一键产出 `app_data_dir/exports/diagnostics-<时间戳>.zip`，内含三个日志文件、归因结论、环境快照与 `MANIFEST.json`。每个文本条目都过五条脱敏规则（launch token / `dsh-auth-*` cookie / 路径用户名段 / API key 形态 / 代理口令），且**每条规则的命中次数都写进包里**——因此「到底脱敏了没有」是可核对的事实，而不是一句承诺。错误页、日志页与应用菜单三处入口。
- **应用内日志查看器** ✅ —— `frontend/logs.html` 读取 `harness.log` / `desktop.log` / `app.log` 的尾部（经 `logs_read`），显示文件大小，**在只显示尾部时明确标记**，并提供诊断导出与打开日志目录的入口。

### 已归档 / 计划中（勿对外宣称可用）

- **插件分级隔离 2.0 (Tier 0/1/2)** 🗄️ **已归档（2026-09-10）** —— Tier 0/1/2 分级沙箱宿主（`plugin-worker-host.mjs`）、其 JSON-RPC 2.0 双向通信与熔断断路器（`plugin_worker.rs`）**曾经实现且有单测**，但**从来没有任何调用方**：Node 侧 `PluginWorkerClient` 无消费者，Rust 侧返回的是可辨识的 `ISOLATION_NOT_WIRED` 错误而非伪造成功。更关键的是它**根本不在插件挂载路径上**（真实挂载发生在 Harness 进程内的官方 Cordis 体系）。现已整体删除而非保留：一个既不被编译、不被测试、又够不着它所声称守护的加载器的模块，只会静默腐烂。因此**当前生效的插件防护仅为上文的进程内守护**——同进程崩溃仍可能带走 Harness，本仓库不得作相反表述。设计文档归档于 [`docs/archive/plugin_isolation_architecture.md`](docs/archive/plugin_isolation_architecture.md)。
- **多模型工具网关 2.0 (`dsh-model-gateway`)** 🗄️ **已归档（2026-09-10）** —— Schema 校验、`anyOf`/`oneOf` 降级净化、多厂商（OpenAI/DeepSeek/Gemini/Claude）方言适配曾实现并测试通过，但无任何运行时消费者。该 crate 已**从 workspace 整体移除**（目录 + members + `[workspace.dependencies]`），设计文档归档于 [`docs/archive/model_gateway_design.md`](docs/archive/model_gateway_design.md)，其中仍保留恢复它的判据。
- **插件卸载 / 禁用** 🕓 **计划中，刻意不实现** —— 恢复页原本以「卸载插件」为主按钮。它**不是疏漏**：卸载是破坏性且不可逆的操作，而显而易见的「可逆」替代方案（把目录改名为 `<name>.disabled`）经核验**根本不具备可逆性**——市场安装的插件由 `profiles/.generations/desired.json` 单一权威描述，冷启动投影会按它重放链接，手工改名会被静默撤销；而改为从该文件摘除条目，则会让 `sweepRegistry()` 直接删掉 generation 目录。既然只剩「假装关掉」与「真的删除」两条路，壳层两条都不提供。完整证据链见 [`docs/dev-plan-disconnected-points.md`](docs/dev-plan-disconnected-points.md) 批次 C。

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
  dsh-contracts/        # 纯 Rust 通用契约库（常量、错误码总表 E1xxx~E7xxx、IPC 封套、JSON-RPC、生命周期定义）
  dsh-host/             # 无 GUI 核心宿主库（子进程管理、Supervisor 监督器、崩溃诊断、日志环形缓冲、脱敏诊断包导出、日志尾部读取）
  dsh-host-cli/         # dsh-host 命令行工具（支持 start / status / stop / tail / doctor 等）
src-tauri/
  frontend/             # 壳页面静态资源（Splash 启动页、Error 错误归因页、插件恢复页、更新页、日志查看器）
  resources/            # 组装好的 Harness 运行时 + 品牌资源（已 gitignore，构建自动生成）
  src/                  # Tauri 桌面应用层（窗口管理、应用菜单、IPC 命令、安全模式切换、LAN 手机桥、壳层日志、自动更新）
    commands.rs             # 完整 IPC 命令面：17 个命令，全部返回 IpcEnvelope<T>
    logging.rs              # 壳层结构化日志（desktop.log，5MB × 2 轮转）
    mobile_bridge.rs        # 局域网手机桥（配对页 + dsh-auth-* cookie 握手 + RPC 转发）
build/                  # 运行时组装与辅助注入脚本
  harness-node-entry.mjs    # Node 端入口与启动参数适配（含 cold-start 投影与故障归因接线）
  plugin-safety-guard.mjs   # 插件运行异常全局守护网 —— formatFaultDetails 是当前唯一生效的插件防护（进程内）
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
  dev-plan-disconnected-points.md   # 【当前主计划】断线点清单（D1~D11）与批次 A~G 施工记录
  dsh-desktop-redesign-architecture-and-plan.md  # 架构重构与开发执行完整计划
  system_design.md                  # 系统架构设计与不变量规范
  archive/                          # 已归档设计（刻意不做，代码已删，仅留作追溯）
    model_gateway_design.md           # 多模型网关（2026-09-10 归档；仍保留恢复判据）
    plugin_isolation_architecture.md  # 插件隔离沙箱（2026-09-10 归档）
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
| P2 | 解耦 Worker 线程沙箱（`plugin-worker-host.mjs`）、JSON-RPC 2.0 双向通信、故障计数与断路器熔断自愈（`plugin_worker.rs`） | 🗄️ **已归档（2026-09-10）**：从未有调用方，且根本不在插件挂载路径上；整体删除而非留着腐烂。只剩进程内故障归因 |
| P3 | 多厂商工具调用 Schema 清洗、复杂嵌套/`anyOf`/`oneOf` 降级、Payload 组装适配（`dsh-model-gateway`）、微秒级性能基准 | 🗄️ **已归档（2026-09-10）**：已从 workspace 整体移除；归档文档保留恢复判据 |
| P4 | Tauri Commands 统一采用 `IpcEnvelope<T>` 封套返回；一键脱敏导出诊断包 (`diagnostics.zip`)；应用内日志查看器 | ✅ **已接线**：17 个命令全部返回 `IpcEnvelope<T>`；脱敏导出（5 条规则，落 `app_data_dir/exports/`）；`frontend/logs.html` |

### 后续计划（尚未开工）

- **插件卸载 / 禁用** 🕓 **刻意后置** —— 见上方功能表。这一项在等**上游的停用（disable）语义**，不是等壳层开发：眼下只有「冷启动被静默还原」与「不可逆删除」两种行为可选。
- **安全模式界面指示器** 🕓 **刻意后置** —— 安全模式生效时，壳层目前**不给用户任何可见提示**。上游的做法是往 Harness 页注入一条横幅（带「卸载插件」/「退出安全模式」两个动作）。这项能力**不是遗漏**：它刻意推迟到壳层其余部分稳定之后再做，好让注入机制在已定型的地基上一次性建好，而不是事后回补。安全模式本身当前工作正常（见「已接线能力」），待补的只是它的「可见性」。
- **诊断包落地**：在 `dsh-host-cli doctor` 现有归因能力之上补齐脱敏打包（日志 + 归因结论 + 环境快照 + `MANIFEST.json`）。

## 测试

无头门禁无需显示器、也无需组装 300MB 运行时（INV-6）：

```sh
cargo test -p dsh-contracts -p dsh-host -p dsh-host-cli
```

集成测试会真实派生 Node 进程运行 `scripts/mock-harness.mjs`，因此需要 `PATH` 上有 Node.js（可用 `DSH_TEST_NODE` 指定），找不到时会自行跳过而非失败。各类故障模式（启动失败、不打印 URL、端口占用重试、就绪后崩溃）通过 `mock-harness.mjs` 的 argv 与环境变量注入，而不是在 Rust 侧打桩。`scripts/fault-inject.mjs` 额外针对 `dsh-host-cli` 验证孤儿进程清理与退出码归因。

### 校验门禁一览

本文件里有若干宣称**编译器查不出来**——它们要么跨语言，要么描述的是「产出的文件长什么样」而不是某个函数的行为。每一条都有对应的门禁：

| 命令 | 它到底在守什么 |
|------|--------------|
| `npm run verify:ipc-surface` | 命令定义 ↔ `generate_handler!` 注册 ↔ 页面 `invoke`/`listen` ↔ `local_page` 目标 ↔ `#[allow(dead_code)]` 登记。`src-tauri` 是 rlib，没人调用的 `pub` 命令**不会**触发 `dead_code`——这是唯一能抓到「写了但没接线」的东西。 |
| `npm run verify:shell-pages` | 把每个壳页面的内联脚本放进 DOM 桩里真跑一遍，并**逐个点一遍按钮**。抓 `getElementById` 返回 `null`（脚本会就此中断，**该页所有监听全部失效**），以及 HTML 留了按钮却没挂监听。 |
| `npm run verify:harness-inject` | Harness 页注入脚本的 DOM 行为，含**可证伪性检查**：把脚本回退成上游行为，断言必须变红。 |
| `npm run verify:patches` | `patches/` 与 `scripts/patch-layers.mjs` 的分级清单一致，且每个补丁文件名都能推导出包名。 |
| `npm run verify:prune` / `npm run verify:variants` | 决定出厂 `node_modules` 形状的两条剪枝规则：哪些开发产物目录可安全删除（看**内容**不看名字——`yaml/dist/doc` 是运行时路径），以及哪些外来平台原生变体必须在 linuxdeploy 扫描 AppDir 前清掉。两条都带针对旧判据的可伪证性检查。 |
| `npm run verify:version` | 版本号在 `package.json`（唯一真源）/ `tauri.conf.json`（继承真源）/ `Cargo.toml`（脚本同步）三处一致；tag 构建时额外校验 **tag 与版本号匹配**。不一致会让安装包自称另一个版本，updater 据此决定推不推更新——错一次影响所有已安装用户。 |
| `npm run verify:commits` / `npm run verify:changelog` | 变更日志生成器与其解析器的自测。一个写坏了却**静默产出空变更日志**的脚本，比没有脚本更危险——Release 页会显示「没有任何改动」。 |
| `npm run verify:target` | 构建主机与打包目标是同一平台/架构——在 300MB 运行时被组装进产物**之前**就拦住。 |
| `npm run fault-inject` | 针对真实 `dsh-host-cli` 验证孤儿进程清理与退出码归因（10 项断言）。 |
| `npm run smoke:headless` / `npm run smoke` | 分层烟雾：L1 无头（派生 → 就绪 → 真的在服务页面 → 干净退出、无孤儿）与 L2 GUI 启动。 |

`verify:shell-pages` **不**替代肉眼看页面：它不渲染、不布局、不跑 CSS。它只回答一个很窄的问题——页面脚本加载完之后，该挂的监听是不是都挂上了。

## 说明

- `node_modules/`、`harness-deps/`、`src-tauri/target/` 与 `src-tauri/resources/` 均已被 gitignore；其中 `resources/` 由构建脚本按需组装生成，避免增大仓库体积。
- 在全新拉取的无资源环境中运行 `cargo check` 或 `cargo test` 前，可先执行 `node scripts/stub-tauri-resources.mjs` 生成桩资源以通过 Tauri 编译期校验。
- **更新端点与签名密钥**：自动更新的更新源为**本仓库**发布页，验签使用**本项目自有**的 minisign 公钥。密钥私钥的存放位置、CI 如何取得、以及一旦丢失会怎样，见[自动更新与签名密钥](#自动更新与签名密钥)。

## 自动更新与签名密钥

更新端点为 `https://github.com/wang-yi-bit64/dsh-desktop/releases/latest/download/latest.json`，且 `tauri.conf.json` → `bundle.createUpdaterArtifacts` 已置 `true`，因此 `npm run build` 会同时产出**已签名的安装包**与该端点所服务的 `latest.json` 清单。

> `latest.json` 必须出现在 Release 资产里——**它不在，自动更新就是断的**。发布工作流（见下）由 `tauri-action` 的 `uploadUpdaterJson` 负责生成上传；手工 `npm run build` 后自行上传产物时，别忘了这个文件。

更新的可信度完全落在同一对 minisign 密钥上：

| 项目 | 位置 |
|------|------|
| 公钥 | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`（可入库，它只用于验签） |
| 私钥 | `~/.tauri/dsh-desktop.key` —— **严禁入库**，严禁复制进仓库 |
| 离线备份 | `~/.tauri/backup/dsh-desktop.key.<时间戳>`，同目录存放配对的 `.pub` |
| CI 获取方式 | `wang-yi-bit64/dsh-desktop` 仓库的 GitHub Actions Secret `TAURI_SIGNING_PRIVATE_KEY`，**无口令**使用 |

没有签名凭据时构建仍能产出安装包，但这种包无法被已发布的客户端安装——验签会直接拒绝。因此 CI 会在**开始昂贵的构建之前**先校验该 Secret 是否存在，缺失时以显式 `::error::` 提前失败，而不是等到最后才发现问题。

**私钥一旦丢失，对已安装用户而言不可挽回。** 公钥被编译进每一个已发布的二进制；换新密钥对就意味着换新公钥，而已安装的客户端会持续拒绝由新公钥签名的更新。请把 `~/.tauri/dsh-desktop.key` 当作发布关键基础设施，而不是本地开发文件。

## 版本与发布

**版本号的唯一真源是 `package.json` 的 `version`。** `src-tauri/tauri.conf.json` 写 `"../package.json"` 原生继承（Tauri schema 明确支持该写法），因此它不存第二份值；`Cargo.toml` 的 workspace version 由脚本同步（Cargo 读不了 `package.json`）。

推进规则与 [Conventional Commits](https://www.conventionalcommits.org/) 对齐，且**可执行**而非靠人记：

| 提交内容 | 推进 | 例子 |
|---------|------|------|
| 破坏性变更（`!` 或 `BREAKING CHANGE:` 页脚） | `major` | 0.3.1 → 1.0.0 |
| 任一 `feat` | `minor` | 0.1.0 → 0.2.0 |
| 任一 `fix` / `perf` | `patch` | 0.2.0 → 0.2.1 |
| 只有 `docs` / `chore` / `ci` 等 | **不发版** | 产物没有任何行为变化 |

```bash
npm run version:show                        # 看各处版本、最近 tag、建议升级位
npm run version:bump -- auto --dry-run      # 只预览，不写文件
npm run version:bump -- auto --commit --tag # 落版本号 + 更新 CHANGELOG + 提交 + 打本地 tag
git push origin main --follow-tags          # 推 tag 即触发发布
```

`--commit` 会**顺带重新生成 `CHANGELOG.md` 的对应段落**并纳入同一个提交——版本号与变更日志同属一次发布，分成两个提交就会出现「tag 指向有版本号、没变更日志的那个提交」，CHANGELOG 从此永久滞后一版。`--tag` 只创建**本地** tag，是否推送由人决定。

**变更日志由 git 提交历史自动生成**（`npm run changelog:write` / `changelog:notes`），仓库内 `CHANGELOG.md` 与 GitHub Release 正文来自同一份数据、同一套渲染逻辑，因此不会互相矛盾。两条硬规则：认不出的提交类型（如历史遗留的 `debug(ci):`）归入「其他」而**不静默丢弃**（丢弃会让变更日志因遗漏而撒谎）；破坏性变更**同时**出现在置顶章节与它的类型章节。

> 为什么不用 GitHub 内置的 `--generate-notes`：它按**已合并 PR** 归纳，而本仓库全程直推 `main`（`gh pr list --state all` 为空）。实测其产出只有一行 `**Full Changelog**: …`、零条目。

### 发布工作流

| 工作流 | 触发 | 做什么 |
|--------|------|--------|
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | push `main` / 任意 PR / 手动 | 三平台 `test`（静态门禁 + clippy + 单测）→ `smoke-headless`（L1 + 故障注入）→ main 上追加 `build`（组装真实资源 + 打包 + L2 + 体积采集） |
| [`.github/workflows/release.yml`](.github/workflows/release.yml) | **推 `v*` tag** / 手动指定 tag | `preflight`（版本↔tag 一致性 + 秒级静态门禁）→ 三平台并行出包，**创建/更新 GitHub Release** 并上传安装包、`.sig` 签名与 `latest.json` |

- **发布用 tag 触发而非 main 提交**：发布是一次性、不可撤销的动作。tag 是显式的单一意图声明；让每次提交都发版会把「发布」退化成无需决策的背景动作。手动触发用于失败后**指定同一 tag 重跑**（删已发布的 tag 是破坏性操作）。
- **各平台产物类型显式声明**：Windows `nsis`、macOS `app,dmg`、Linux `deb,appimage`。不依赖 `tauri.conf.json` 的 `bundle.targets`——那里只有 Windows 专属的 `nsis`。
- **与 CI 的边界**：发布流程**不重跑**整套 Rust 测试矩阵（那是 CI 对同一 commit 的职责），`preflight` 只跑秒级门禁以便在组装 300MB 资源前失败。因此**只对 main 上绿着的提交打 tag**——这是有意接受的边界。

## Harness 页面注入

壳层通过 Tauri 的 `initialization_script` 在**每一次 Harness 页面加载**时注入一小段脚本——它等价于 Electron 的 `preload`。脚本在文档解析之前执行、在每次顶层导航时生效，并按 origin 自我早退，因此壳层自己的本地页（`index.html`、`error.html`、`updates.html` 等）与子框架都不受影响。

有两点必须说清，因为本文档早期版本把它们搞错了：

1. **Harness 页上是可以定义 `window.*` 全局的。** 本文档曾写道「Tauri webview 没有 preload / initialization script」——那是一个错误的机制判断。它当年用来支撑的「目录选择器规则」依然成立，但依据已改为真正成立的理由，见上文目录选择器一段。
2. **这条通道是单向的：壳层 → 页面。** 状态经 `webview.eval()` 推送，因此**不**向 Harness 这个远程 origin 暴露任何 IPC 命令。任何需要反向通信的能力都被刻意不做。

当前消费方是手机状态指示器（`src-tauri/frontend/harness-ui-inject.js`，由 `src-tauri/src/harness_ui.rs` 推送）。它的 DOM 侧行为由一套基于最小 DOM 桩的无头自测覆盖：

```sh
npm run verify:harness-inject
```

该套件还带一项**可证伪性检查**：它把脚本回退成上游的行为（会把指示器以未渲染状态漏进侧边栏），并要求断言**必须变红**；若不变红则门禁失败。一个不可能失败的测试是装饰，不是防线。

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
- **`prepare:harness` 幂等快速路径按完整打包清单校验。** 此前只检查 3 个文件，导致缺 `bin/` 或 `plugin-safety-guard.mjs` 的 `resources/` 被判定为完整并跳过组装。`plugin-safety-guard.mjs` 由 `harness-node-entry.mjs` 直接 import，缺失时 Harness 根本无法启动；缺 `bin/` 还会让 `cargo build` 因 `resources/bin/*` glob 不匹配而失败。完整性检查现已对齐 `tauri.conf.json` → `bundle.resources`。
- **`shell == None` 时同样要走 `harness_env`。** `Launcher::execute` 此前把 `capture_shell_environment()` 的原始结果直接交给子进程，`DSH_HOME` 等契约变量因此从未注入，Harness 回退到 `~/.dsh`，把可变状态写到了 `app_data_dir` 之外（违反 INV-1）。GUI 与 CLI 两条路径现已都注入契约环境。

另有工作区目录选择器必须走 Host seam、不得使用 renderer 全局桥。这条规则原先的理由是「Tauri webview 没有 preload / initialization script，`window.*` 全局无处定义」——**这个机制描述是错的**（Tauri 的 `initialization_script` 正是 preload 的等价物，本仓现已用它向 Harness 页注入手机状态指示器）。规则依旧成立，但要用成立的理由：曾有一个 `patch-package` 补丁把原生目录选择器改成 `window.dshDesktopDirectoryPicker.pick()`，而该全局**从未被任何东西定义**，因此导入项目时必然弹出「无法打开文件夹 / DSH Desktop directory picker bridge is unavailable」；并且即便今天有能力定义这样的全局，让选择器经由页面回连宿主也要为 Harness 这个**远程 origin** 开一个 IPC 入口，而注入机制刻意只用于**壳层 → 页面**的单向下发。现已移除该补丁，恢复上游 stock 路径：客户端 `ctx.uiWorkspace.pickDirectory()` → Host `ctx.directoryPicker` seam → Harness 进程内拉起 Win32 `IFileOpenDialog`。`scripts/prepare-harness.mjs` 的 `assertPickerSurfaceIsHostBacked()` 会在打补丁后校验这一点，违反即构建失败。

要构建真实安装包，`npm run tauri build` 首次运行会下载 NSIS 工具链；在网络无法访问 GitHub releases 的环境下，打包步骤会以 `timeout: global` 失败，但此时 `.exe` 与资源其实已成功产出。

## 安全与依赖说明

- **Dependabot / RUSTSEC-2024-0429 (GHSA-wrw7-89jp-8q8g)** —— `glib 0.18.5` 被标记存在 `glib::VariantStrIter` 的内存不安全性。它是经 Tauri 的 GTK3 后端引入的**仅 Linux、传递性**依赖，且项目未调用受影响 API。修复版本（`glib ≥ 0.20.0`）需等待上游 Tauri 迁移至 gtk-rs 0.20+ 后自动解析更新。
- **诊断包是「写入前脱敏」，不是「写完之后再处理」。** 导出路径服务于「把你的日志发给我」这个场景，而用户手写这条消息时**不会先去删凭据**——`harness.log` 里就有明文的首航 token 与 `dsh-auth-*` cookie。因此每个文本条目在写进压缩包**之前**都要过五条脱敏规则（launch token / `dsh-auth-*` cookie / 路径用户名段 / API key 形态 / 代理口令），且每条规则的命中次数都会写进包内 `README.txt` 与命令返回值——「到底脱敏了没有」是可核对的事实，不是一句承诺。规则同时有正例（原文不得残留）与反例（版本号、端口、`E` 码、包名**不得**被误伤；一份把版本号涂掉的诊断包没有诊断价值）。包**不会**上传到任何地方，产物留在磁盘上，直到用户自己决定发出。
