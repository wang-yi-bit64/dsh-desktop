# AGENTS.md

> 面向开发人员与 AI Agent 的 `dsh-desktop`（DeepSeek Harness 桌面壳）协作指南

---

## 1. 项目概述与仓库结构

`dsh-desktop` 是基于 **Tauri 2.0** 与 **Rust** 构建的 DeepSeek Harness 跨平台桌面外壳程序。它负责打包内置 Node.js + DeepSeek Harness 服务运行时的生命周期管理，并提供 GUI 窗口承载与崩溃自愈。

> ⚠️ **能力口径**：文档中每个特性都必须区分五种状态——**已接线 / 未接线 / 未实现 / 计划中 / 已归档**（词表见 §7.3）。凡不在「已接线」之列的，**不得对外呈现为可用能力**；状态词的判据与代码证据位置见 §7 宣称纪律。
>
> 截至 2026-09-10 批次 A~G 收尾，§7.2 表里**已无「未接线」条目**：能接的都接了（IPC 封套、诊断导出、日志查看器、恢复页），接不上的都裁定归档并删除了（插件隔离、模型网关）。剩下两个 🕓 计划中（Safe Mode 界面横幅、插件卸载/禁用）都是**明确决策**而非欠债，各自的依据写在该行里。

### 目录划分
- **`crates/dsh-contracts`**：无 GUI / 无平台绑定的通用契约库。
  - 核心职责：集中定义常量与契约标识（`CX-1` ~ `CX-9`）、**标准错误码总表（`E1xxx`~`E7xxx`，见 `src/errors.rs` 的 `codes` 模块）**、前后端统一 IPC 封套（`IpcEnvelope<T>`，`error` 载荷为 `AppError`）、JSON-RPC 2.0 规范（唯一契约源，`dsh-host` 等下游 crate 仅 re-export）、生命周期阶段与崩溃诊断类型。
  - **错误码按族号对应类别**：`E1xxx` 环境 / `E2xxx` 网络 / `E3xxx` 进程 / `E4xxx` 鉴权 / `E5xxx` 插件 / `E6xxx` 模型网关 / `E7xxx` 内部。族号与类别的对应关系有测试守着（`errors.rs::every_code_family_maps_to_its_category`），改一处必须改另一处。
- **`crates/dsh-host`**：无 GUI 依赖的纯 Rust 核心宿主库。
  - 核心职责：子进程派生、跨平台孤儿进程防护、URL/Token 捕获、HTTP 就绪探测、日志滚动轮转、Supervisor 监督器、崩溃归因诊断（`diagnostics.rs`）、**脱敏诊断包导出（`diagnostics_export.rs`，批次 D）**、**日志尾部读取（`logs_view.rs`，批次 D）**、Safe Mode 隔离 Profile、多 Profile/Session 管理。
  - **严格保持无 GUI / Headless 状态（不变量 INV-6）**。
- **`crates/dsh-host-cli`**：`dsh-host` 的命令行工具前端（支持 `dsh-host start | status | stop | tail | doctor`）。
- **`src-tauri`**：Tauri 2.0 桌面应用层（负责窗口管理、生命周期、Webview IPC 对接、自动更新、页面导航、安全模式引导、LAN 手机桥、壳层结构化日志、一键脱敏诊断包导出、应用内日志查看器）。
  - **IPC 命令面准入纪律**：每个 `#[tauri::command]` 都是对本地页开放的攻击面，**只保留有真实调用方**的命令（当前 17 个，**全部有前端调用方**）。死命令要么接上、要么删掉——不要为「可能有用的未来 UI」预留。判定靠 `npm run verify:ipc-surface`（其 `ALLOW_UNUSED_COMMANDS` 现在是**空表**，这是目标状态），理由与例外清单见 `commands.rs` 模块文档。
  - **命令返回形态**：所有命令返回 `CommandResult<T>` = `Result<IpcEnvelope<T>, String>`；**外层 `Result` 恒为 `Ok`**（仅为满足 Tauri 对 async 命令的编译要求），成败与错误码全在内层封套。**不要返回 `Err`**——那会让封套连同错误码一起丢失。细节见 `commands.rs` 模块文档。
  - **`src-tauri/frontend/`**：本地静态页共 5 个——`index.html`（启动屏）、`error.html`（结构化错误页 + 插件故障归因 + 诊断包导出 + 恢复页入口）、`plugin-recovery.html`（恢复页）、`updates.html`（更新页）、`logs.html`（日志查看器）。**均已接线、均可达**（`safe-mode.html` 已于 2026-09-10 删除，理由见批次 C）。
> 🗄️ **已归档并删除（2026-09-10，批次 F）**：`crates/dsh-model-gateway`（多模型工具调用网关）
> 与 `crates/dsh-host` 的插件隔离模块。两者均无运行时消费者，按 §7.3 的裁定「冻结并归档」处理——
> 代码删除，设计文档移入 [`docs/archive/`](docs/archive/)。**不要在未重新裁定的情况下把它们加回来**：
> 见 §7.2 表的归档行与 §3 批次 F。
- **`build/`**：运行时启动脚本与安全防护注入。
  - `harness-node-entry.mjs`：支持隔离参数（`--dsh-isolated-plugins`）与环境引导；同时是 cold-start 投影（`projectGenerations` / `sweepRegistry`）与 `[dsh-plugin-fault]` 归因的接线点。
  - `plugin-safety-guard.mjs`：`formatFaultDetails` **已接线**（被 `harness-node-entry.mjs` 的未捕获异常/拒绝处理器消费）。**这是当前唯一生效的插件防护，且只在进程内**——同进程的插件崩溃仍可能带走 Harness。
  - `plugin-worker-host.mjs` 已于 2026-09-10 随批次 F 删除（连同 `PluginWorkerClient`）：它实现完整但从未接线，且不在真实插件挂载路径上（真实挂载走 Harness 进程内的官方 Cordis 体系）。理由见该文件删除时的提交与 §7.2 归档行。
- **`scripts/`**：
  - `prepare-harness.mjs`：解析、下载并组装 300MB+ 的 Node 运行时与 Harness 依赖包到 `src-tauri/resources/`；幂等快速路径按 `tauri.conf.json` → `bundle.resources` 的完整清单校验产物完整性；按 [`patches/LAYERS.md`](patches/LAYERS.md) 的分级决定补丁失败是降级还是中断（`--strict` 恢复全量 fail-fast）。
  - `stub-tauri-resources.mjs`：生成轻量桩资源树，用于无资源包环境下的快速编译与单测。
  - `mock-harness.mjs`：可注入故障的假 Harness（`--fail startup | no-url | port-in-use | after-ready`），集成测试的真实子进程目标。
  - `fault-inject.mjs`：基于 `dsh-host-cli` 的孤儿进程清理与退出码归因验证（6 类故障场景 / 10 项断言）；`npm run fault-inject`，在 Smoke 工作流中为**三平台硬门禁**（2026-09-12 起；此前仅 Windows 硬、其余 `continue-on-error`）。
  - `verify-ipc-surface.mjs`：壳接口面一致性静态检查（命令定义 ↔ 注册 ↔ 前端 `invoke`/`listen` ↔ `local_page` 目标 ↔ `#[allow(dead_code)]` 登记）。这类断线 `dead_code` 看不见，见 §7.3。
  - `verify-shell-pages.mjs`：壳内页面的**运行时**冒烟（DOM 桩里真跑内联脚本 + 逐个点按钮），检查 P1~P6：引用可解析 / 脚本不抛错 / 命令已注册 / **按钮都挂了监听** / 模板 id 前缀可解析 / **命令结果解包了封套**。抓 `verify-ipc-surface` 看不见的两类缺陷：`getElementById` 拿到 `null` 导致整页监听失效；HTML 留了按钮但脚本忘了绑。它曾当场抓到批次 E 引入的「`updates.html` 把封套当载荷用、整页永远不渲染」。
  - `verify-target.mjs`：打包目标守卫（构建主机 vs 目标平台）。目标来源优先级：argv → `TAURI_ENV_TARGET_TRIPLE` → `rustc -vV` host；`--self-test` 跑纯逻辑自检。
  - `generate-app-icons.mjs`：**macOS 手工工具**（依赖 `sips` / `iconutil`），刻意无 npm 入口、不进 CI；定位与产物去向见其文件头注释。
  - `smoke-launch.mjs`：CI 分层烟雾（L1 无头 / L2 GUI），见 §2。
  - `report-bundle-size.mjs`：采集壳/安装包/资源树体积，写入 CI job summary（§7 期望管理）。
  - `conventional-commits.mjs`：Conventional Commits 解析器（**共享库**，被下面两个脚本复用）。解析 / 归类 / 版本建议都收在这里，避免两个 CLI 各写一份、对同一条提交给出两种说法。含 `--self-test`。
  - `changelog.mjs`：由提交历史生成 `CHANGELOG.md` 与 Release 正文（`--write` / `--notes`）。仓库内变更日志与 Release 正文同源同渲染，因此不会互相矛盾。见 §8.3。
  - `version.mjs`：版本号的 `show` / `check` / `set` / `bump`（`bump auto` 依提交历史判定升哪一位），并同步 `Cargo.toml`；`--commit` 会一并重生成 CHANGELOG 段落。见 §8。
- **`.github/workflows/`**：`ci.yml`（PR / 手动；**刻意不监听 `push`**——日常提交零自动化）、`smoke.yml`（**仅手动**触发冒烟：`l1` / `assembled` / `full` 三档）、`release.yml`（推 `v*` tag / 手动指定 tag）。三者分工见 §8.4——CI 负责**静态验证**，Smoke 负责**按需起的真实进程验证**，Release 负责**出包与发布**，互不重复。
- **`.github/ISSUE_TEMPLATE/`**：Issue 表单（YAML form，非 markdown 模板）。`bug_report.yml` 内嵌**脱敏诊断包两步指引**（菜单「Harness → Export Diagnostics…」导出 → 建完 issue 后拖进评论区，因为 GitHub 只允许对已创建的 issue 挂附件），并给出应用起不来时按平台取日志的路径表，同时**显式声明原始日志未脱敏**；`feature_request.yml` 明确 Harness 侧功能应提给上游；`config.yml` 关闭空白 issue 并挂 Discussions 联系入口。GitHub Discussions 已于 2026-09-12 开启（分类见 `docs/dev-plan-0.2-hardening.md` 批次 0.2-D）。**表单结构必须按 `json.schemastore.org/github-issue-forms.json` 核对**：`checkboxes` 不接受 `validations`，勾选项的必填写在 option 的 `required` 上——写错不会让 YAML 非法，只会让表单在 GitHub 侧渲染异常，「YAML 能解析」不能当通过判据。
- **`CHANGELOG.md`**：**生成物，勿手工编辑**（改动会在下次生成时被覆盖）。数据源是 git 提交历史，见 §8.3。
- **`patches/`**：`patch-package` 补丁 + [`LAYERS.md`](patches/LAYERS.md) 分级清单（`brand` / `ui-behavior` / `functional`）。
- **`docs/`**：架构设计、契约定义、不变量与技术规范：
  - `dsh-desktop-redesign-architecture-and-plan.md`：最新系统架构重构设计与执行计划。
  - `system_design.md`：核心系统架构设计、契约定义与不变量清单。
  - `archive/`：**已归档的设计文档**（`model_gateway_design.md`、`plugin_isolation_architecture.md`）。归档 ≠ 计划中：这些方案已被裁定不做，代码已删除，文档仅留作设计意图的追溯。每份文首都有归档说明。
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
cargo test -p dsh-contracts -p dsh-host -p dsh-host-cli

# 2. 编译 src-tauri 前生成桩资源（全新 checkout 缺少 resources/ 时必跑）
node scripts/stub-tauri-resources.mjs

# 3. 格式化与 Clippy 静态检查
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings

# 4. 全 Workspace 编译检查
cargo check --workspace

# 5. 补丁分级自检（patches/ 与 patch-layers.mjs 登记表一致性）
npm run verify:patches

# 6. 壳接口面一致性（命令定义 ↔ 注册 ↔ 前端 invoke/listen ↔ 页面可达性）
#    这是唯一能捕获「写了但没人调用」类断线的门禁——见 §7.3
npm run verify:ipc-surface

# 7. 壳内页面运行时冒烟（DOM 桩执行内联脚本 + 点一遍所有按钮）
npm run verify:shell-pages

# 8. Harness 页注入脚本行为自测（19 项断言 + 可证伪性检查）
npm run verify:harness-inject

# 9. 打包目标守卫（构建主机 vs 目标平台；自动推断，亦可 `-- self-test` 自检）
npm run verify:target
npm run verify:target -- --self-test

# 10. 故障注入（孤儿进程清理 + 退出码归因，10 项断言）
#    前置：cargo build -p dsh-host-cli
npm run fault-inject

# 11. 分层烟雾（L1 无头硬门禁；L2 需已构建产物，缺失则 SKIP）
npm run smoke:headless
npm run smoke

# 12. 产物体积三口径（壳二进制 / 安装包 / 资源树）
npm run size:report

# 13. 版本号一致性（package.json 唯一真源 ↔ tauri.conf.json ↔ Cargo.toml；
#     tag 构建时额外校验 tag 与版本号匹配）——发布前的关键防线
npm run verify:version
# 本地查看各处版本、最近 tag、以及「上个 tag 以来的提交建议升哪一位」
npm run version:show

# 14. 变更日志/版本推进生成器自测（纯逻辑，无 git 依赖）
npm run verify:commits
npm run verify:changelog

# 15. 依赖树瘦身自测（删目录判据是「内容」不是「名字」，含可证伪性检查）
npm run verify:prune

# 16. 原生平台变体剪枝自测（删 musl / 非目标架构 prebuilds；
#     Linux AppImage 打包的必要前置——见「linuxdeploy 撞上外来变体」一节）
npm run verify:variants

# 17. 发布工作流守卫（tauri-action 参数拼装 + shell 变量终止；含自测）
#     守两类「只有真跑 release 才炸」的缺陷——见「发布工作流的两个静默缺陷」一节
npm run verify:release-workflow
npm run verify:release-workflow:self-test

# 18. 官方 profile 保留名守卫（`desktop` 大小写变体）+ 契约锚点；含自测
npm run verify:profile-names
npm run verify:profile-names:self-test

# 19. 宣称纪律守卫（README ↔ AGENTS：禁止表述 / 状态词表 / §7.2 欠债登记）；含自测
npm run verify:claims
npm run verify:claims:self-test

# 20. 上游版本漂移哨兵（真检查会因上游领先而红，跑在 nightly；CI 只跑自测）
npm run verify:drift
npm run verify:drift:self-test

# 21. 补丁健康度报告（层 / 退役条件 ↔ MANIFEST 实际结果；报告，非门禁）
npm run report:patches

# 22. 上游升级预检：补丁在新版本上的适用性（~4MB，不必组装 300MB）
npm run check:patch-applicability -- --target=0.1.2-rc.1

# 15. 推进版本号（dry-run 先看，再真改）
npm run version:bump -- auto --dry-run     # 依提交历史判定升 major/minor/patch
npm run version:set  -- 0.2.0              # 直接指定
npm run version:bump -- minor --commit --tag   # 改文件 + 提交 + 打本地 tag（不推送）

# 16. 变更日志（产物入库 / 供 Release 正文使用）
npm run changelog:write -- --version 0.2.0     # 写入 CHANGELOG.md
npm run changelog:notes                        # 打印上个 tag..HEAD 的 Release 正文
```

集成测试（`crates/dsh-host/tests/`）会真实派生 Node 进程运行 `scripts/mock-harness.mjs`，需要 `PATH` 上有 Node.js（可用 `DSH_TEST_NODE` 指定）；找不到时测试自行跳过而非失败。故障模式经 `mock-harness.mjs` 的 argv / 环境变量注入，不在 Rust 侧打桩。

#### ⚠️ 已知环境限制：GNU 工具链下 Clippy 在旧 `dsh-model-gateway` 上 ICE（该 crate 已归档，条目仅留档）

同一台 `x86_64-pc-windows-gnu` 宿主机上，`cargo clippy --workspace` 曾在编译
`dsh-model-gateway` 时**编译器内部错误**（`the compiler unexpectedly panicked`，
rustc 1.97.1 / clippy 0.1.97），停在 `codegen_and_build_linker`。

- **性质**：clippy 自身缺陷（环境相关），与本仓库源码无关：同一命令在 `cargo check --workspace` 下完全通过。
- **现状（2026-09-11 已实测复核）**：该 crate 于 2026-09-10 随批次 F 从 workspace 移除后，
  **本机 `cargo clippy --workspace --all-targets -- -D warnings` 已可正常执行**（本地实跑 exit 0，
  增量构建约 6 秒）。也就是说：**现在本地就能复现 CI 的 clippy 失败，不必等 CI 报错再回头改。**
  这一点在 2026-09-11 修 `clippy::result_large_err` 时起了决定作用——先本地复现、再修、再本地验证通过，
  一轮闭环，没有消耗三平台 CI 跑一轮十几分钟的反馈时间。
  ⚠️ **仍不要把 clippy 当成「本地有没有都无所谓」**：触发该 ICE 的是一类「某个 crate 恰好触到
  clippy 代码生成路径」的环境问题，将来任何新 crate 都可能复现。因此：
  1. 本地首选 `cargo clippy --workspace --all-targets -- -D warnings`（与 CI 逐字一致）；
     若某天又 ICE，退回 `cargo check --workspace --all-targets`（能报出全部真实 warning，包括
     CI `-D warnings` 会拦下的 `unused_imports`）；
  2. clippy 的最终权威执行者仍是 CI（MSVC 工具链，三个平台都跑）——本地通过不等于三平台都通过。

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

1. **无头核心库隔离（`crates/dsh-contracts`, `crates/dsh-host`）**：
   - 严禁依赖 Tauri、UI 框架或窗口系统。
   - 所有核心库测试必须能在无显示器、无预组装资源包的 CI 环境下独立通过。
   - 判定一条「这个逻辑该放哪」的简单问题：**它能不能在没有窗口系统的机器上被测试？** 能，就放无头 crate；不能，才放 `src-tauri`。`dsh-host` 里的诊断导出、日志尾部读取（批次 D）都是照这条标准从壳层下沉下来的。
2. **契约与常量集中管理（`crates/dsh-contracts`）**：
   - 所有硬编码字符串、超时时间、重试退避间隔、缓冲区大小、正则模式与探测常量，**必须**统一定义在 `crates/dsh-contracts/src/constants.rs` 中，并带有 `CX-` 契约编号注释。
   - 严禁在业务逻辑中硬编码超时、路径常量或 URL。
   - JSON-RPC 2.0 消息模型（`RpcId` / `RpcRequest` / `RpcResponse` / `RpcError` / `RpcMessage`）的**唯一定义点**是 `crates/dsh-contracts/src/rpc.rs`；`dsh-host/src/transport.rs` 仅 re-export，`dsh-host/src/contracts.rs` 的 glob re-export 与之指向同一组类型。**严禁在任何 crate 内重复定义协议类型**，否则会形成同名异型冲突（该问题已于 2026-09 修复）。⚠️ **当前该协议没有运行时消费者**：原先按同一协议手写实现的 Node 侧 `build/plugin-worker-host.mjs` 已随批次 F 删除，`TransportProtocol` 服务的进程间通道从未接线。保留的是纯类型契约，不要把它当作「本仓有可用 RPC 基础设施」的证据。
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
2. **`prepare:harness` 幂等检查漏项**：只校验 3 个文件时，缺 `bin/` / `plugin-safety-guard.mjs` 的资源树会被当作完整而跳过组装（前者是 `harness-node-entry.mjs` 的直接依赖，缺失则 Harness 起不来；缺 `bin/` 则 `cargo build` 的 glob 校验直接失败）。修改 `tauri.conf.json` → `bundle.resources` 时必须同步更新 `scripts/prepare-harness.mjs` 的 `REQUIRED_FILES` / `REQUIRED_DIRS`。
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

### 统一 IPC 封套（`IpcEnvelope`）改造会**静默**打断页面（已修复，勿回归）

2026-09-10 批次 E 把 17 个命令从 `Result<T, String>` 改成 `IpcEnvelope<T>`。改动本身是正确的（前端因此能按错误类别分派），但它**当场打断了 `frontend/updates.html`**，而且没有任何编译错误、没有异常、没有日志：

```js
// 改前：拿到快照
invoke('updates_status').then(apply)
// apply 的第一行
if (!snapshot || !snapshot.phase) return
```

加上封套之后 `apply` 拿到的是**封套**而非快照，`snapshot.phase` 恒为 `undefined`，于是**每次调用都静默早退，整页永不渲染**。同一批里 `run()` 还漏判了 `success`，把「没有可用更新」这类业务失败当成了成功。

这是跨语言契约问题的第二种形态（第一种见上一节）：**形状变了，消费方不报错，只是安静地不工作**。三条纪律由此确立：

1. **命令不返回 `Err`**。外层 `Result` 恒为 `Ok`（只为满足 Tauri 对 `async` 命令的编译要求）；返回 `Err` 会让封套连同 `error.code` / `error.category` 一起丢掉，消费方退回读字符串。
2. **页面必须解包 `success`**，并把 `envelope.data` 当载荷用（`updates://status` 这类**事件**给的才是裸快照——同一页面两种载荷形态，别弄混）。
3. **改命令返回形态属于破坏性变更，必须过 `npm run verify:shell-pages`**。该守卫在 DOM 桩里真点每个页面的按钮并跑内联脚本，P6 专查「调用了命令却没解包封套」。上面两处缺陷就是它抓到的。

#### 后续回归：不要把 `IpcEnvelope` 放进 `Err` 位置（2026-09-11 修复）

批次 E 之后 CI 三平台 `cargo clippy` 全红，下游 smoke / bundle 被连带跳过。根因很单一：

```text
error: the `Err`-variant returned from this function is very large
  --> src-tauri/src/commands.rs:66
   |  fn ensure_local_origin(webview: &WebviewWindow) -> Result<(), IpcEnvelope<()>>
   |                                                    ^^^^^^^^^ the `Err`-variant is at least 128 bytes
note: `-D clippy::result-large-err` implied by `-D warnings`
```

`AppError` 里装着两个 `String`、一个可选 `String` 与一个 `serde_json::Value`，于是
`size_of::<IpcEnvelope<()>>()` = **128 字节**。它一旦出现在 `Err` 位置，clippy 就会把
「按值返回的 `Result` 每穿一层调用搬 128 字节」判为问题——在 `-D warnings` 下这是错误。

**修法（勿改回）**：`ensure_local_origin` 的 `Err` 改为 `Box<IpcEnvelope<()>>`
（`guard!` 宏相应 `failed(*error)`）。

**为什么不改共享契约**：`CommandResult<T> = Result<IpcEnvelope<T>, String>` 把封套放在
**`Ok`** 位置（`Err` 是 24 字节的 `String`），clippy 不管它；因此「给 `AppError` 拆箱」之类
的改法会让**所有**错误构造都多一次分配，却只修得掉上面这一处——成本与收益不成比例。

**为什么不 `#[allow(clippy::result_large_err)]`**：本仓库口径是能修根因就不压制，而
`Box` 正是 clippy 自己给的两条建议之一。若将来确有需要压制的场合，请连同理由一起写进本节，
不要就地挂一个裸 `allow`。

**这条 lint 本地能拦**（见 §2 关于 clippy 的实测复核）：改完跑
`cargo clippy --workspace --all-targets -- -D warnings`，不要等 CI 三平台跑一轮才发现。

### 上游改 CLI 自执行方式：壳入口静默退出（2026-09-12 升级实测，已修复勿回归）

`build/harness-node-entry.mjs` 是**包装器**：它必须先 import 上游 `@deepseek-ai/dsh/lib/bin.js`
之前装好 windowsHide 补丁、plugin safety guard 与 cold-start 投影，所以走 **`import`** 而非
派生 `node bin.js`。

alpha.4 的 `bin.js` 是**顶层自执行**，import 即运行。**0.1.5-rc.1 把它重构成**：

```js
async function runCli() { … }
if (import.meta.main) await runCli();   // ← 只有「作为直接入口」才执行
export { runCli };
```

import 该模块时 `import.meta.main` 恒为 **false**，于是 **CLI 从不运行**，进程随即以
退出码 **0** 静默结束。表现极具误导性——资源组装报 `14/14 applied`、入口 import 无任何异常、
harness.log 只到 `[harness-node] DSH entry loaded` 就断，而 `smoke-launch` 报的是
「Harness 就绪超时（退出码 8）」。**所有静态检查全绿**，因为它们看不见「进程起来了但 CLI 没跑」。

**修法（勿改回）**：入口接住 import 的返回值，并在导出了 `runCli` 时显式调用——

```js
const entry = await import(pathToFileURL(dshEntryPath).href)
if (typeof entry?.runCli === 'function') await entry.runCli()   // 新版显式调用
// 旧版（≤0.1.2-alpha.4）没有该导出，顶层自执行，不重复调用
```

**守卫**：`npm run verify:harness-entry`（E1~E3，含以修复前写法为夹具的可证伪性检查），
已进 CI 与 release preflight。**这类「上游改了自执行方式」属于升级时的隐形炸弹**：
升级 DSH 版本后若 L1 报「就绪超时但日志无报错」，先查这里。

### 补丁应用：`patch-package` 必须用「应用模式 + 相对 `--patch-dir`」（已修复，勿回归）

`scripts/prepare-harness.mjs` 的 `applySinglePatch()` 逐个应用 `patches/` 下的补丁。两条约束都是硬性的，各自都能**静默**做错事：

1. **不得用 `patch-package <包名>` 形式。** 带包名会把 CLI 切到**生成**模式：它安装一份干净的包并与 `node_modules` 做 diff，以便*写出*补丁文件。刚装好的 staging 树什么都没打过，于是它报 `There don't appear to be any changes` 并退出非零 → 18 个补丁全被判失败 → `functional` 层抛错 → 三平台 `bundle` 作业一起挂。报错信息指向「某个包没有改动」，与真实原因（调用形式用错）毫无关系。`cea57b3` 就是这样把原来正确的 `npx patch-package`（应用全部）换掉的；由于当时 `test` 作业本身是红的，`bundle` 从未执行，这个缺陷被掩盖了两天。
2. **`--patch-dir` 必须传相对路径，且目录要位于 `staging/` 之内。** patch-package 只拒绝以 `/` 开头的值（`--patch-dir must be a relative path`），**Windows 绝对路径（`C:\…`）能绕过这个守卫**：它被当成相对路径拼到 cwd 之下，变成 `harness-deps/C:/…` 这样不存在的目录，patch-package 打印 `No patch files found` 却**以 0 退出**。也就是说绝对路径不会失败，它只是什么都不做，而调用方会把补丁记成 `applied`。`applySinglePatch()` 因此在 staging 内建 scratch 目录、命令行传目录名，并额外拦截 `No patch files found` 这一种已知静默形态。

配套：**`--error-on-fail` 必须显式传**。patch-package 在非 CI 环境失败也返回 0（它有意如此，以防 `package.json` 与 `node_modules` 失步），不传的话本机跑出来的「已应用」是假绿，而这份报告正是「哪些补丁真的打上了」的证据。

判定这类改动是否成功，看的是**补丁是否真的落到盘上**（文件字节数 / 内容形态变化），不是退出码。

### 变更说明的默认基线必须相对 `--to` 求（已修复，勿回归）

`release.yml` 用 `changelog.mjs --notes --to "$TAG"` 生成 Release 正文。`--from` 省略时的默认基线**不能**写成「全仓库最近的 tag」：发布时 `$TAG` 这个 tag 必然已经存在（它就是刚 push 上来的那个），从 `HEAD` 去找会把它自己找回来，`--from` 与 `--to` 指向同一处，区间退化为 `v0.1.0..v0.1.0`，正文变成「区间内没有提交」——**首个版本的 Release 说明整篇空白，且不报错**。

正确做法是相对 `--to` 求上一个 tag：`latestTag({ rev: \`${to}^\` })`（推导已抽成 `conventional-commits.mjs` 的 `baselineRefFor()`）。另外 `--notes` 遇到空区间现在**直接失败**：空白正文会被 GitHub Release 原样展示，没人会注意到「这个版本没什么可说的」其实是一次自动化故障。

`changelog.mjs --self-test` 里有一条建临时 git 仓库实跑区间解析的断言钉着这点（渲染层纯逻辑断言抓不到它——错在「与 git 的交互」上）。实测：同一首次发布场景，旧实现读到 0 条提交、新实现读到全部历史（98 行 / 13063 字符 / 8 章节，对比修复前的 5 行 / 115 字符 / 0 章节）。

### 依赖树瘦身：删目录的判据是「内容」不是「名字」（已修复，勿回归）

`prepare:harness` 会把组装好的 `node_modules` 里「名字像开发产物」的目录（`test` / `docs` / `doc` / `example` …）**整目录删除**，用来缩小安装包。这条规则按名字判定是错的：`doc` 在某些包里恰好是**运行时路径**。

2026-09-11 定位的真实事故：`yaml/dist/doc/` 被整个删掉，而那里装的是 `directives.js` / `Document.js` 等运行时模块，于是 Harness 一启动就崩：

```
Harness 出现未处理的 Promise 拒绝：Error: Cannot find module '../doc/directives.js'
```

这个缺陷**没有任何静态检查能发现**——打包、签名、安装、`tauri build` 全部成功，只有真正启动才报错，也就是「装得上、起不来」。它能存活这么久，是因为 CI 直到 2026-09-10 才加「真实资源树 L1 烟雾」，而那条烟雾当时又被更早的红灯连续挡住。

规则已抽到 [`scripts/prune-harness-deps.mjs`](scripts/prune-harness-deps.mjs)，判据改为**目录内是否含运行时模块**（`.js`/`.cjs`/`.mjs`/`.node`/`.wasm`/`.json`）：命中名字只是必要条件，含运行时模块时**只递归进去删文件，绝不整目录删除**。`npm run verify:prune` 的自测带**可伪证性检查**——把旧判据作用于同一棵树必须复现出「`dist/doc` 被删」，否则自测本身失效。

实测（真实 `yaml` 包，203 → 153 个文件）：`dist/doc/directives.js`、`Document.js` 存活，同目录 5 个 `.d.ts` 仍被删除；整个 staging 内有 **42 个**这类「名字像开发产物但含运行时模块」的目录，旧判据会全部误删。取舍明确：**误删只会得到一个起不来的包，少删只是少省一点体积**，所以判据一律偏向「宁可不删」。

### linuxdeploy 撞上外来平台原生变体：AppImage 打包的静默杀手（已修复，勿回归）

Linux 的 `build` job 曾**连续多轮**以 `failed to run linuxdeploy` 收场，而 tauri-bundler 在默认日志级别下**吞掉 linuxdeploy 的 stderr**，CI 上只留下一句无信息量的错误（deb 正常，因为 deb 不解析 ELF 依赖；Windows/macOS 不经过 linuxdeploy，全绿——所以红灯只出现在一个平台）。用 `-v` 拿到真实报错才定位：

```
Deploying dependencies for ELF file …/@koromix/koffi-linux-x64/musl_x64/koffi.node
ERROR: Could not find dependency: libc.musl-x86_64.so.1
ERROR: Failed to deploy dependencies for existing files
```

根因：linuxdeploy 会遍历 AppDir 内**每一个** ELF 并解析其动态依赖。`@koromix/koffi-linux-x64` 在同一个包里并列 glibc 与 musl 两份构建，`node-pty` 的 `prebuilds/` 也带齐所有平台架构——其中 musl 变体依赖 `libc.musl-x86_64.so.1`，在 glibc 的 ubuntu runner 上**必然**解析失败，于是整个 AppImage 打包被拖垮。附带噪声（非致命）：静态链接的 `landlock-run` 让 patchelf 打 ERROR、跨架构的 arm64 `pty.node` 走 ldd 只给警告——同源，都是「树里混进了与目标无关的二进制」。

修法：`prepare:harness` 在瘦身之后、打包之前调用 [`scripts/prune-platform-variants.mjs`](scripts/prune-platform-variants.mjs) 剪掉外来变体。判据**有界**，只对「目录名本身充当平台选择器」的两种布局动手——`prebuilds/`（prebuildify 约定，其 loader 按 `platform-arch` 查找）与 koffi 的 `musl_*` 布局；包**名**里带平台后缀的（`@img/sharp-linux-x64`）不碰（npm 已按 `os`/`cpu` 过滤）。另有一道保险：prebuilds 目录之外只对**有同平台邻居**的目录按名删，永远不会删掉「最后一个能用的」。剪掉它们不影响运行时——我们发布的 node 是 glibc 链接的，koffi 按运行时 libc 选构建。

`npm run verify:variants` 把判据钉住，并带**可伪证性检查**：把**现有**瘦身门禁 `pruneNodeModules()` 作用于同一棵树，必须复现出「`musl_x64/koffi.node` 原样幸存」——证明这个缺陷**逃得过当时全部门禁**（静态检查、L1 烟雾、Windows/macOS 打包全部看不出），断言才不是装饰。

### 发布工作流的两个静默缺陷（已修复，勿回归）

`v0.1.0` 首次发布时，三个平台的 release job **全红**，但失败点各不相同，且本地门禁全绿——只有真跑发布才暴露。两处根因都已修正并加了守卫 `npm run verify:release-workflow`：

1. **tauri-action 会自己插入 `build` 与 `--`**。其 `Runner.execTauriCommand` 拼出的 argv 是
   `[...tauriScript] + ['build'] + (npm 且有参数 ? ['--'] : []) + [...args]`。
   本仓原来写成 `tauriScript: npm run tauri --` + `args: build --bundles …`，实际展开成
   `npm run tauri -- build -- build --bundles …`，tauri CLI 报 `unexpected argument 'build' found`。
   正确形状是 `tauriScript: npm run tauri`（不带 `build`、不带尾随 `--`）+ `args: --bundles …`（只放选项）。
   守卫会**模拟**该拼装逻辑，断言 `build` 恰好出现一次、且 `tauriScript` 自身不含 `build`/`--`。

2. **macOS 的 bash 3.2 不认全角标点作变量终止符**。生成发布说明的脚本里写了
   `**首次发布**（$TAG）`：macOS runner 的 bash 3.2 在没有 UTF-8 locale 时会把紧跟其后的
   全角 `）` 并进变量名，解析成变量 `TAG）`，报 `TAG）: unbound variable`（Linux/Windows 的
   bash 正确终止，所以只有 macOS 这一台红）。修法是变量一律写 `${VAR}` 花括号形式。守卫用正则
   扫 release.yml 里「未加花括号的 `$NAME` 紧邻非 ASCII 字符」的可执行行（注释与 `${{ … }}` 表达式除外）。

两条判据都带**可伪证性检查**：把上述旧写法当夹具，断言必须变红。

---

## 5. 架构演进与路线图 (P0~P4)

> 下表描述**设计目标**，不等于当前可用能力。阶段名后标注的状态以 §7 的代码证据为准。
> **状态词表见 §7.3**：⚠️ 未接线（有代码无调用方）、🕓 计划中（无代码且刻意不做）、
> 🗄️ 已归档（曾实现，现已删除并裁定不做）。

- **P0（契约基线与无头核心库）✅ 已接线**：独立通用契约库（`dsh-contracts`）、集中常量契约、**标准错误码总表**（`E1xxx`~`E7xxx`，见 §7.2）、无 GUI 核心库设计（`dsh-host`, `dsh-host-cli`）、Win32 JobObject / POSIX 孤儿防护。
- **P1（生命周期监督与自愈）✅ 已接线**：Supervisor 监督器、状态流转与退避重试、LogRing 环形缓冲、崩溃归因分析（`diagnostics.rs`）与 Safe Mode 隔离 Profile。
- **P2（插件分级隔离与看门狗）🗄️ 已归档（2026-09-10，批次 F）**：Tier 0/1/2 分级沙箱、JSON-RPC 2.0 通信、连续错误断路器曾实现且有单测，但**从未有任何运行时调用方**，且不在真实插件挂载路径上（真实挂载走 Harness 进程内的官方 Cordis 体系）。按 `docs/dev-plan-disconnected-points.md` §4 决策点 3 裁定「冻结并归档」：`plugin_worker.rs`、`plugin-worker-host.mjs`、`PluginWorkerClient` 全部删除，设计文档移入 `docs/archive/`。**当前生效的插件防护只有 `plugin-safety-guard.mjs` 的进程内 `formatFaultDetails` 归因**——同进程的插件崩溃仍可能带走 Harness。
- **P3（多模型工具网关与基准测试）🗄️ 已归档（2026-09-10，批次 F）**：Schema 降级清洗、多厂商方言适配、微秒级基准均已实现并测试通过，但无运行时消费者。按同一裁定从 workspace 移除（目录 + members + `[workspace.dependencies]`），设计文档移入 `docs/archive/model_gateway_design.md`。恢复前置条件仍见该文档的「退出条件」段。
- **P4（薄壳收敛与诊断系统 2.0）✅ 已接线（2026-09-10 批次 D/E 闭环）**：前端结构化错误归因、**统一 IPC 封套（`IpcEnvelope<T>`，17 个命令全部收敛）**、**一键脱敏导出诊断包（`diagnostics_export`，5 类脱敏规则 + 正反用例）**、**应用内日志查看器（`logs.html`）**、**插件恢复页（可操作、有状态反馈）** 均已接线。证据获取路径现为四条：错误页 / 恢复页 / 日志页 / 原生菜单「Export Diagnostics…」。

## 6. 修改敏感模块前必读文档
- `docs/roadmap.md`：**顶层路线图**——定位声明、边界原则与阶段序列（H0~H3）；定位与裁决冲突以它为权威。
- `docs/dev-plan-hardening-and-differentiation.md`：**近端施工计划（路线图 H0 阶段）**——风险清单 R1~R9 与批次 H~N（风险哨兵 / 上游推进 / 门禁可信度 / 宣称纪律 / 构建卫生 / 运维韧性 / 差异化）。
- `docs/dev-plan-0.2-hardening.md`：**产品与分发侧增补计划（批次 0.2-A~D）**——与 H0 互补：签名/公证、发布通道、桌面体验底线、上游 PR 候选、反馈闭环；它相对 H0 的独有覆盖与三处优先级冲突写在该文首「关系」一节，**是否并入 H0 及冲突如何裁决归用户**。
- `docs/dev-plan-disconnected-points.md`：上一阶段主计划（批次 A~G 已闭环）——断线点清单（D1~D11）与裁决记录，留作追溯；「插件禁用语义」的证据链在这里（批次 C），0.2-B4 项要重走它。
- `docs/dsh-desktop-redesign-architecture-and-plan.md`：系统重构设计与开发全流程计划。
- `docs/system_design.md`：核心系统架构设计、缺陷清单与契约细则。
- `docs/archive/model_gateway_design.md`、`docs/archive/plugin_isolation_architecture.md`：**已归档**（裁定不做，代码已删）的两份设计文档；只在需要追溯设计意图或评估「要不要恢复」时读。
- `crates/dsh-contracts/src/constants.rs`：Harness 运行时通用契约常量总表。
- `crates/dsh-contracts/src/errors.rs`：**错误码总表**（`E1xxx`~`E7xxx`）与 `AppError`；IPC 封套的错误形状在这里。
- `crates/dsh-contracts/src/ipc.rs`：`IpcEnvelope<T>` 封套定义 + 跨语言字段形状测试。
- `crates/dsh-host/src/diagnostics_export.rs`：**脱敏诊断包**（新增脱敏规则时必须补正反用例）。
- `src-tauri/src/commands.rs`：**IPC 命令面模块文档**——准入纪律、`CommandResult` 的两层结构、为什么外层 `Result` 恒为 `Ok`。动任何命令前先读它。
- `scripts/verify-shell-pages.mjs`：改动 `src-tauri/frontend/` 下任何页面后必跑。它的头部注释写清了「它查什么、不查什么」，新增检查项要照同一格式登记。
- `crates/dsh-contracts/src/rpc.rs`：JSON-RPC 2.0 消息模型唯一契约源（Rust 侧）。⚠️ 当前**无运行时消费者**，见该文件模块文档。
- `crates/dsh-host/src/transport.rs`：IPC 传输抽象与通信信道定义；RPC 类型 re-export 自 `dsh-contracts::rpc`。

---

## 7. 宣称纪律（Claim Discipline）

**背景**：外部评审（2026-09）指出 README / 文档宣称的能力与实际代码存在落差。逐项核对后有 4 项宣称在代码中**没有运行时路径**：插件分级隔离、多模型工具网关、一键诊断包、LAN 手机桥（批次 A~G 已全部处置）。这不是「文档写早了」的程度问题——`plugin_worker.rs::call_tool` 当时会**返回伪造的成功结果**（`success: true`），即上层无法通过任何观测手段发现插件工具其实根本没被执行。

> 📌 **该文件已删除**（2026-09-10 批次 F 冻结并归档）。上面这段保留为**历史记录**：它记录的是这套纪律为什么存在，不是当前代码状态。查当前状态请看 §7.2。

### 7.1 三条硬规则

1. **未接线的能力必须显式标注**。任何「已实现但无运行时调用方」的模块，必须在其模块文档头部加 `⚠️ 状态：未接线` 横幅，并在本表登记。禁止用「已实现」「已支持」等词描述未接线能力。
2. **禁止伪造成功**。桩实现若被调用，必须返回**可辨识的错误**，不得返回 `Ok` / `success: true` / 空数组等合理默认值。判据：调用方能否从返回值区分「成功」与「未接线」。**2026-09-10 起这条同时约束 IPC 面**：失败必须是封套里的 `success: false` + 稳定 `error.code`，而不是裸 `false`——恢复页四个按钮「点了没反应」的根因就是静默的 `false`（改为 `E7002` 后页面才能如实报错）。
3. **禁止无声降级**。允许降级（如补丁分级失败策略），但必须把降级事实写进产物：`MANIFEST.json` 的 `patches[]` 逐条记录 `applied / skipped / failed`，缺记录即视为未应用。**同一规则适用于诊断包与日志查看器**：脱敏命中次数写进包内 `README.txt`；日志被截断时 `truncated` 必须如实上报。

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
| **插件分级隔离 Tier 0/1/2** | 🗄️ **已归档（2026-09-10 批次 F：冻结并归档）** | 代码已删除（`plugin_worker.rs`、`plugin-worker-host.mjs`、`PluginWorkerClient`）；设计文档在 `docs/archive/plugin_isolation_architecture.md`。它此前**从未接线**，且不在真实插件挂载路径上 | **无**（且永远不会走这条路：真实挂载在 Harness 进程内的官方 Cordis 体系） |
| ↳ 插件安全（**当前实际生效的那一条**） | ✅ 已接线，**但只在进程内** | `build/plugin-safety-guard.mjs:formatFaultDetails` | `build/harness-node-entry.mjs` 的未捕获异常/拒绝处理器。**同进程的插件崩溃仍可能带走 Harness**——不得表述为「插件崩溃不拖垮主程序」 |
| **多模型工具网关** | 🗄️ **已归档（2026-09-10 批次 F）** | crate 已从 workspace 删除；设计文档在 `docs/archive/model_gateway_design.md`（文首有归档说明与恢复判据） | **无** |
| **一键脱敏诊断包 `diagnostics.zip`** | ✅ **已接线（2026-09-10 批次 D）** | `crates/dsh-host/src/diagnostics_export.rs`（5 类脱敏规则：launch token / `dsh-auth-*` cookie / 路径用户名段 / API key / 代理口令；每条有正反用例 + 端到端「产物内无原文」断言）；产物落 `app_data_dir/exports/` | 命令 `diagnostics_export` ← 错误页「导出诊断包」按钮、`logs.html` 同功能按钮、菜单「Harness → Export Diagnostics…」（三者都显示产物路径） |
| LAN 手机桥（扫码配对 + cookie 握手） | ✅ 已接线 | `src-tauri/src/mobile_bridge.rs`、`state.rs::sync_mobile_target`（:352）、`menu.rs` 手机子菜单 | 应用菜单 `mobile-pair` / `mobile-stop` |
| 壳层结构化日志 `desktop.log` | ✅ 已接线 | `src-tauri/src/logging.rs::init`（:46） | `src-tauri/src/lib.rs:70` |
| 补丁分级与失败降级 | ✅ 已接线 | `scripts/patch-layers.mjs`、`patches/LAYERS.md`、`prepare-harness.mjs` | 构建期；结果落 `MANIFEST.json:patches[]` |
| **统一 IPC 封套 `IpcEnvelope<T>` + 错误码总表** | ✅ **已接线（2026-09-10 批次 E）** | `crates/dsh-contracts/src/ipc.rs`（`IpcEnvelope<T>`，`error` 载荷为 `AppError`）+ `src/errors.rs` 的 `codes` 模块（`E1xxx`~`E7xxx`，族号↔类别有测试） | `src-tauri/src/commands.rs` 的 **17 个命令全部**返回 `CommandResult<T>`；四个页面（error / plugin-recovery / logs / updates）均解包 `success` |
| ↳ 命令面 `Result` 语义 | ✅ 已接线 | `commands.rs::CommandResult` 文档注释 + 测试 | 外层 `Result` **恒为 `Ok`**（Tauri 编译要求）；语义全在内层封套。**返回 `Err` 会丢掉错误码**，属违规 |
| **自动更新链路** | ✅ 已接线（2026-09-10 批次 B 闭环） | `src-tauri/src/update.rs` + `tauri-plugin-updater`（`lib.rs:58`、`UpdateManager` 构造于 `lib.rs:145`）；`tauri.conf.json` 开启 `bundle.createUpdaterArtifacts` | 菜单 `updates-check` → `window::show_updates_page` + `UpdateManager::check(true)`；`frontend/updates.html` 调 `updates_status` / `updates_check` / `updates_download` / `updates_install` / `updates_skip` 并监听 `updates://status` |
| ↳ 更新源归属与签名密钥 | ✅ 已闭环（2026-09-10） | `plugins.updater.endpoints` 指向 `github.com/wang-yi-bit64/dsh-desktop/releases/latest/download/latest.json`；配置里的 `pubkey` 与 `~/.tauri/dsh-desktop.key.pub` **逐字节一致** | 私钥经 CI Secret `TAURI_SIGNING_PRIVATE_KEY` 注入（无口令），本地离线备份在 `~/.tauri/backup/` |
| **应用内日志查看器** | ✅ **已接线（2026-09-10 批次 D）** | `frontend/logs.html` + `crates/dsh-host/src/logs_view.rs`（三来源，尾部读取，**截断如实上报 `truncated`**） | 菜单「Harness → View Logs…」→ `window::show_logs_page`；页面调 `logs_read` / `open_logs` / `diagnostics_export` / `harness_open`。「Reveal Log Folder」保留为次入口 |
| **错误页「安全模式」按钮** | ✅ 已接线（2026-09-10 修复调用名；同日补完启动链路） | `src-tauri/frontend/error.html` 调 `safe_mode_action`（`action: "restart"`），失败经 `fail()` 可见上报 | 错误页按钮 → `commands::safe_mode_action` → `HarnessSupervisor::restart_in_safe_mode`（此前调 `restart()`，实际只是**普通重启**——按钮曾是谎话） |
| **恢复页交互** | ✅ **已接线（2026-09-10 批次 C）** | `plugin-recovery.html` 调 `recovery_status` / `recovery_action`（`restart` / `safe-mode` / `show-log` / `quit`）并**检查封套 `success`**；监听 `harness://status` 反映恢复进度 | 错误页「插件恢复…」按钮 → `recovery_open` → `show_recovery_page`。数据来自 `dsh_host::diagnostics`（此前零消费者的那条链） |
| ↳ 插件卸载 / 禁用 | 🕓 **计划中**（依据上游是否提供停用语义） | **无代码，且刻意不实现**：经核验，市场安装的插件没有真正的可逆解除挂载方式——改名会被冷启动投影还原，改 `desired.json` 会触发 `sweepRegistry()` 真删目录（证据链见 `docs/dev-plan-disconnected-points.md` §3 批次 C） | **无**。恢复页只提供非破坏性动作；未知动作返回 `E7002` 而非静默 `false` |
| **`safe-mode.html`** | 🗄️ **已删除（2026-09-10 批次 C）** | 页面 + 资源 + 配置项一并移除；`window::show_safe_mode_page` 同步删除 | **无**。它的每处交互都要求「插件移除」后端（上文已裁定不做），接上只会交出「其余按钮仍读空气」的页面；其独有能力（进安全模式）已由错误页 / 恢复页 / 原生菜单三处覆盖 |
| 手机桥状态可见性 | ✅ 已接线（2026-09-10） | `src-tauri/src/menu.rs` 的 `Phone` 子菜单状态行 + `mobile_bridge::status_label`；`MobileBridge::on_connected_change`（镜像上游 `onConnectedChange`）在配对状态翻转时回调 | 菜单构建时初始化，**手机侧 `POST /pair` 成功**、菜单配对/停止时均经 `refresh_bridge_status` 刷新（`lib.rs` setup 注册监听器） |
| ↳ 页内手机状态指示器（Harness 侧边栏） | ✅ 已接线（2026-09-10） | `harness_ui.rs::INJECT_SCRIPT`（`include_str!` 内嵌 `frontend/harness-ui-inject.js`），挂在 `[data-dsh-sidebar-settings]` 下；状态下发 `push_phone_status` 走 `webview.eval`，**不新增 IPC 命令** | 两个推送点：连接翻转（`on_connected_change`）与页面加载完成（`on_page_load`）。**只做状态指示、不可点击**——配对/停止仍只走原生 `Phone` 菜单，因此它不渲染成按钮 |
| **Harness 页注入机制（preload 等价物）** | ✅ 已接线（2026-09-10；同期更正「无初始化脚本」的误判） | 主窗口 builder 的 `initialization_script`（`lib.rs`）+ `frontend/harness-ui-inject.js`；脚本按 origin 自我早退（本地页与子框架不注入） | 无头行为自测 `npm run verify:harness-inject`（19 项断言 + 可证伪性检查，已进 CI） |

### 7.3 维护方式

- 新增能力时：先写代码，再在本表补一行——**顺序不可颠倒**。
- 状态词只有五种，含义互不重叠，**不得混用**：
  | 状态 | 含义 |
  |------|------|
  | ✅ 已接线 | 有代码、有运行时调用方，用户可见 |
  | ⚠️ 未接线 | **代码已写但无运行时调用方**——这是「欠债」，必须登记销账批次 |
  | ❌ 未实现 | **代码不存在**——这是「缺口」，不得对外宣称 |
  | 🕓 计划中 | **代码不存在，且刻意不现在做**——这是「决策」，不是欠债。必须写明后置理由（通常是为等前置能力稳定） |
  | 🗄️ 已归档 | **曾实现，现已删除并裁定不做**——这是「结论」。必须写明归档判据；文档保留在 `docs/archive/` 供追溯设计意图 |
  「未接线」与「计划中」的区别是**有没有代码**：前者是写了没接（欠债），后者是还没写（决策）。把计划中说成未接线会误导读者去找不存在的代码；把未接线说成计划中则是在给欠债打掩护。
  「已归档」与「未接线」的区别是**代码还在不在**：归档是欠债已销账（删了，并给出不做的理由），未接线是债还挂着。**归档不是「计划中」**——不要用「以后可能做」来软化一个已经裁定不做的决定。
- 修改未接线模块时：必须同步删除其 `⚠️ 未接线` 横幅、更新本表状态。
- **归档一个模块时**：代码删除、文档移入 `docs/archive/` 并在文首写归档说明（判据 + 恢复前提），本表状态改 🗄️，`README` 对应表述同步收敛。**删除的文件名要写进本表**——否则下一个人只会看到「某个能力不见了」。
- 评审 / 发布前自查：`grep -rn "⚠️ 未接线\|未实现" AGENTS.md README.md docs/` 应只命中**确实未接线/未实现**的条目（归档项不在其中，它们改用 🗄️）。除真实欠债外，以下三类命中是**预期内**的，不要为消除它们而改写文本：
  1. **词表与纪律条文本身**（§7.3 的状态词表、README 的状态标记约定、本条的规则文字）；
  2. **历史盘点记录**——`docs/dev-plan-disconnected-points.md` §1 的 D1~D11 标题记录的是「盘点当时」的状态（该节开头有显式声明）。把它们改成「已修复」会让后来者看不出当初断在哪；
  3. 引用这些术语的规范文档（如 `dsh-upgrade-checklist.md` 的操作说明）。
- **跨语言断言必须可证伪**：新增「X 一定会发生」这类关于页面 / 脚本行为的断言时，按 `scripts/verify-harness-inject.mjs` 的模式配一段**变体回退检查**——把被守护的行为打回旧写法，断言必须变红，否则断言是装饰。同时守卫**不得依赖检出配置**（行尾、路径分隔符）：CRLF 检出下必须与 LF 表现一致。
- 与 B1 的联动：任何新增 `patch-package` 补丁必须同时登记进 `patches/LAYERS.md` 与 `scripts/patch-layers.mjs`，否则 `prepare-harness.mjs` 会以「未登记」告警并回退默认层。
- **本表只覆盖「契约 / 能力」级宣称**。比它更细一层的问题是「命令写了但没人调用、页面打包了但不可达」——那类断线在 Rust 里不可见（`src-tauri` 是 `rlib`，`pub` 项一律算「可达」，`dead_code` 永不触发），只能靠 `npm run verify:ipc-surface` 静态比对。该脚本的检查项、允许清单与「为什么必须有它」，写在脚本头部注释里，新增例外必须**在 `ALLOW_*` 里写明理由**。

---

## 8. 版本与发布（Versioning & Release）

### 8.1 版本号的唯一真源

| 位置 | 角色 | 谁写 |
|------|------|------|
| `package.json` → `version` | **唯一真源** | `scripts/version.mjs` |
| `src-tauri/tauri.conf.json` → `version` | 写 `"../package.json"`，**原生继承**不存值 | 手工设一次，之后不动 |
| `Cargo.toml` → `[workspace.package] version` | 跟随真源（Cargo 读不了 package.json） | `scripts/version.mjs` |
| `Cargo.lock` | 生成物，跟随 Cargo.toml | cargo 自身 |
| `CHANGELOG.md` | 生成物，由提交历史推导 | `scripts/changelog.mjs` |

`tauri.conf.json` 之所以能不存值：Tauri 官方 schema 明确允许 `version` 写成
「`package.json` 的路径」（*"a semver version number **or a path to a `package.json` file**
containing the `version` field"*）。用满这个能力就把三处重复消掉一处——**不要**把它改回硬编码字面量。

### 8.2 版本号怎么推进（规则可执行，不靠人记）

| 提交内容 | 推进 | 例子 |
|---------|------|------|
| 任一破坏性变更（`!` 或正文 `BREAKING CHANGE:` 页脚） | `major` | 0.3.1 → 1.0.0 |
| 任一 `feat` | `minor` | 0.1.0 → 0.2.0 |
| 任一 `fix` / `perf` | `patch` | 0.2.0 → 0.2.1 |
| 只有 `docs` / `chore` / `ci` 等 | **不发版** | —（产物无行为变化） |

- 由 `npm run version:bump -- auto` 执行上面的判定，也可 `version:set <x.y.z>` 直接指定。
- **`0.y.z` 阶段（当前）**：破坏性变更升 `minor` 而非 `major`——API 本就未稳定，用 `major`
  会让版本号跑在实际成熟度前面。
- 预发布版本用 `-` 后缀（`0.2.0-beta.1`）。对应的 GitHub Release 会被标为 prerelease，
  且**不进入** updater 的正常更新通道。
- **先 `--dry-run` 再真改**：`npm run version:bump -- auto --dry-run`。
- 没有历史 tag 时 `auto` **会报错并要求显式指定**——首次发布不该由一个推导规则猜版本号。

### 8.3 变更日志与 Release 正文

`CHANGELOG.md` 与 Release 正文**来自同一份数据（git 提交历史）与同一套渲染逻辑**，因此不会出现
「Release 页说的」与「CHANGELOG.md 说的」不一致。

- 解析器 `scripts/conventional-commits.mjs`：类型分组、破坏性置顶、版本建议。
- 渲染器 `scripts/changelog.mjs`：`--write` 落 `CHANGELOG.md`，`--notes` 出 Release 正文。
- **两条硬规则**（都有自测钉着）：
  1. **不静默丢弃任何提交**。认不出的 `type`（例如历史上真实存在的 `debug(ci):`）归入「其他」
     并保留原文。静默丢弃会让变更日志**因遗漏而撒谎**——比分类不准严重得多。
  2. **破坏性变更同时出现在置顶章节与它的类型章节**——读者既要知道「有不兼容改动」，
     也要知道它属于哪一类工作。

> ⚠️ **为什么不用 GitHub 内置的 `--generate-notes`**：它按**已合并 PR** 归纳，而本仓库全程直推
> `main`（`gh pr list --state all` 为空）。2026-09-11 实测其产出只有一行
> `**Full Changelog**: …`、零条目。直推流程下这条路走不通，不要为了"少维护"换回去。

### 8.4 CI 工作流与触发条件

| 工作流 | 文件 | 触发 | 做什么 |
|--------|------|------|--------|
| CI | `.github/workflows/ci.yml` | 任意 `pull_request` / 手动 / **每日定时一次** | 三平台 `test`（静态门禁 + clippy + 单测）。**不组装资源、不打包、不跑烟雾** |
| Smoke | `.github/workflows/smoke.yml` | **仅手动**（`workflow_dispatch`，三个输入：`scope` / `os` / `fault_injection`） | 按 `scope` 分级：`l1`（mock 资源树 L1 会话烟雾 + 可选故障注入）/ `assembled`（组装真实资源树 + 真实树 L1）/ `full`（+ 打安装包 + L2 GUI 烟雾 + 体积采集）。**不发布任何东西** |
| Drift | `.github/workflows/drift.yml` | **每日定时一次** / 手动 | 上游 DSH 版本漂移哨兵：`verify:drift` 真检查落后 npm dist-tag 即红。**不构建任何东西**——只回答「该规划升级了吗」 |
| Release | `.github/workflows/release.yml` | **推 `v*` tag** / 手动（指定 tag） | `preflight`（版本↔tag 一致性 + 秒级静态门禁）→ 三平台并行出包并**创建/更新 GitHub Release**、上传安装包与 `.sig`、生成 updater 的 `latest.json` |

- **每日定时是「日常零自动化」的补偿，不是把它加回来**（2026-09-12 起）：`ci.yml` 增设
  `schedule`（每天一次）、新增 `drift.yml`。二者合起来让「main 的 HEAD 有没有烂」与「上游
  是否已甩开我们」最迟 24 小时内被证实——成本是**一天一次**而非每次提交一次。它们**不替代**
  发布前那两次手动 dispatch：定时 CI 不跑冒烟（起窗口那一步），drift 只比版本号。

- **日常提交不触发任何 CI**（2026-09-11 起）：`ci.yml` 摘掉了 `push: main`，**推 tag 也不会跑它**
  （tag 归 `release.yml`；同一件事两处实现必然漂移，出包只留一个产地）。日常提交要的是快反馈，
  静态门禁 + 单测就够了；组装 300MB 资源、打包、起窗口这些成本高的动作不该挂在每次提交上。
  `pr` 触发保留（拉 PR 时跑静态 + 单测），`workflow_dispatch` 保留（在分支上主动验证）。
- **冒烟测试改为手动触发**（2026-09-11 起）：冒烟（L1/L2）**从 `ci.yml` 迁到独立的 `smoke.yml`**，
  且**只**由 `workflow_dispatch` 触发。保留能力、去掉自动化，正是为了「需要时能跑、平时不占额度」。
  三种 `scope` 对应三档成本，见上表；`gh workflow run smoke.yml -f scope=l1` 是命令行等价物。
  与 `ci.yml` 的关系是**搬家不是另起一套**：用的是同一批脚本（`smoke-launch.mjs` / `fault-inject.mjs`）
  与同一套断言，只是触发方式从自动变成了手动。
- **为什么发布用 tag 触发而不是 main 提交**：发布是一次性、不可撤销的动作（Release 一旦公开
  就有人下载）。tag 是显式的单一意图声明；让 main 上每次提交都发版会把「发布」退化成无需决策的背景动作。
- **`workflow_dispatch` 兜底**：发布失败时可指定同一个 tag 重跑，不必删 tag 重建（删已发布的 tag
  是破坏性操作）。
- **与 CI 的边界（2026-09-11 重述）**：Release **不重跑** `cargo test` / clippy / 三平台烟雾矩阵，
  它只跑 `preflight` 的秒级静态门禁 + 版本校验，目的是在组装 300MB 资源**之前**失败。
  ⚠️ **但「tag 提交已经绿过」这个前提不再自动成立**——`ci.yml` 不再随 `push main` 触发，冒烟也
  不再自动跑，Release 成了 tag 上唯一会出包、也唯一会拦一道门的地方，而 preflight 看不见运行时行为。
  **发布前请手动 dispatch 一次 CI 工作流（静态 + 单测）与一次 Smoke 工作流（冒烟），都确认全绿，
  再打 tag。** 残留风险（给从未跑过门禁的提交打 tag，Release 不会发现）是**有意接受的边界，不是遗漏**。
- **各平台产物类型必须显式传 `--bundles`**：`tauri.conf.json` 的 `bundle.targets` 只写了 `nsis`
  （Windows 专属）。macOS/Linux 上必须显式声明 `app,dmg` / `deb,appimage`，不要依赖 Tauri 对
  不支持类型的平台回退行为（既无文档承诺，也无法在本机验证）。
- **`latest.json` 是更新链路的命门**：updater 端点指向
  `releases/latest/download/latest.json`。tauri-action 的 `uploadUpdaterJson`（默认开）负责生成上传；
  **它不在 Release 里，自动更新就是断的**。

### 8.5 发布操作步骤（人看的）

```bash
# 1. 确认待发布提交在 main 上
git checkout main && git pull

# 2. 手动 dispatch CI 与 Smoke 两个工作流并确认全绿（★ 2026-09-11 起为必需步骤）
#    日常提交已不触发 CI，冒烟也不再自动跑，Release 的 preflight 只跑静态门禁、
#    看不见运行时行为，因此「静态 + 单测」与「冒烟」这两轮只能在发布前手动补齐。
#    gh CLI 示例（在 Actions 页点 Run workflow 等价）：
gh workflow run ci.yml --ref main                  # 三平台静态门禁 + clippy + 单测
gh workflow run smoke.yml --ref main -f scope=full # 组装真实资源 + 打包 + L2 冒烟
gh run watch   # 等到两个都全绿再继续

# 3. 看将要升到哪个版本（不写任何文件）
npm run version:bump -- auto --dry-run

# 4. 落版本号 + 重新生成 CHANGELOG 段落 + 提交 + 打本地 tag（一个原子发布提交）
npm run version:bump -- auto --commit --tag

# 5. 推送（tag 推送即触发 Release 工作流）
git push origin main --follow-tags
```

> 第 4 步的 `--tag` 只创建**本地** tag，推送与否由人决定——这是刻意的：打 tag 就是发布意图，
> 不该由脚本替人按下。
>
> `--commit` 会**一并重新生成 CHANGELOG.md 的对应段落**并纳入同一个提交。版本号与变更日志
> 同属「这一次发布」，分成两个提交就会出现「tag 指向有版本号、没变更日志的那个提交」——
> CHANGELOG.md 从此永久滞后一版。
>
> ⚠️ 第 2 步不是可选的仪式：`ci.yml` 不再随 `push main` 触发、冒烟也改为手动之后，这两次
> dispatch 是你的提交在打 tag 前**唯一**几次会跑 `cargo test` / clippy / 真实进程冒烟的机会。
> 跳过它们，Release 不会替你拦。只想要快速一档时，`smoke.yml` 用默认的 `scope=l1` 即可
> （几十秒、不起窗口）；要复现发布形态就用 `scope=full`。
