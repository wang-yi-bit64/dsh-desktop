# 仓库结构（目录划分）

> 从 `AGENTS.md` §1 迁入，原样保留。

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
  - 核心职责：子进程派生、跨平台孤儿进程防护、URL/Token 捕获、HTTP 就绪探测、日志滚动轮转、Supervisor 监督器、崩溃归因诊断（`diagnostics.rs`）、**脱敏诊断包导出（`diagnostics_export.rs`，批次 D）**、**日志尾部读取（`logs_view.rs`，批次 D）**、**组装清单读取端（`runtime_manifest.rs`，批次 0.2-D2）**、Safe Mode 隔离 Profile、多 Profile/Session 管理。
  - **严格保持无 GUI / Headless 状态（不变量 INV-6）**。
- **`crates/dsh-host-cli`**：`dsh-host` 的命令行工具前端（支持 `dsh-host start | status | stop | tail | probe | doctor`）。它是 **INV-6 的兑现载体**——「主链路必须能在命令行独立复现」靠的就是这个二进制，排障时先跑它就能区分「宿主逻辑问题」与「窗口/权限问题」。**发布形态：仓库内使用，不作为发布产物（2026-09-24 起）。** 三个消费者（`smoke-launch.mjs` / `fault-inject.mjs` / `cli_blackbox.rs`）全部从 `target/debug/` 取二进制，与上传产物零交集；打包能力（`scripts/package-cli.mjs`：命名 / `.sha256` 边车 / manifest / 回读校验 / 产物执行自检）保留在本地。退役理由与恢复条件见 [`docs/dev-plan-cli-distribution.md`](docs/dev-plan-cli-distribution.md) §5——**注意该打包产物不含 runtime**，本就不是「下载即用」。
- **`src-tauri`**：Tauri 2.0 桌面应用层（负责窗口管理、生命周期、Webview IPC 对接、自动更新、页面导航、安全模式引导、LAN 手机桥、壳层结构化日志、一键脱敏诊断包导出、应用内日志查看器、**系统托盘（批次 0.2-B1）**、**应用内反馈入口（批次 0.2-D2）**）。
  - **IPC 命令面准入纪律**：每个 `#[tauri::command]` 都是对本地页开放的攻击面，**只保留有真实调用方**的命令（当前 21 个，**全部有前端调用方**）。死命令要么接上、要么删掉——不要为「可能有用的未来 UI」预留。判定靠 `npm run verify:ipc-surface`（其 `ALLOW_UNUSED_COMMANDS` 现在是**空表**，这是目标状态），理由与例外清单见 `commands.rs` 模块文档。
  - **命令返回形态**：除 `portable_mode`（便携版判定，返回裸 `bool`）外，命令返回 `CommandResult<T>` = `Result<IpcEnvelope<T>, String>`；**外层 `Result` 恒为 `Ok`**（仅为满足 Tauri 对 async 命令的编译要求），成败与错误码全在内层封套。**不要返回 `Err`**——那会让封套连同错误码一起丢失。细节见 `commands.rs` 模块文档。
  - **`src-tauri/frontend/`**：本地静态页共 6 个——`index.html`（启动屏）、`error.html`（结构化错误页 + 插件故障归因 + 诊断包导出 + 恢复页 / 反馈页入口）、`plugin-recovery.html`（恢复页）、`updates.html`（更新页）、`logs.html`（日志查看器）、`feedback.html`（反馈页）。**均已接线、均可达**（`safe-mode.html` 已于 2026-09-10 删除，理由见批次 C）。
> 🗄️ **已归档并删除（2026-09-10，批次 F）**：`crates/dsh-model-gateway`（多模型工具调用网关）
> 与 `crates/dsh-host` 的插件隔离模块。两者均无运行时消费者，按 §7.3 的裁定「冻结并归档」处理——
> 代码删除，设计文档移入 [`docs/archive/`](docs/archive/)。**不要在未重新裁定的情况下把它们加回来**：
> 见 §7.2 表的归档行与 §3 批次 F。
- **`build/`**：运行时启动脚本与安全防护注入。
  - `harness-node-entry.mjs`：支持隔离参数（`--dsh-isolated-plugins`）与环境引导；同时是 cold-start 投影（`projectGenerations` / `sweepRegistry`）与 `[dsh-plugin-fault]` 归因的接线点。
  - `plugin-safety-guard.mjs`：`formatFaultDetails` **已接线**（被 `harness-node-entry.mjs` 的未捕获异常/拒绝处理器消费）。**这是当前唯一生效的插件防护，且只在进程内**——同进程的插件崩溃仍可能带走 Harness。
  - `plugin-worker-host.mjs` 已于 2026-09-10 随批次 F 删除（连同 `PluginWorkerClient`）：它实现完整但从未接线，且不在真实插件挂载路径上（真实挂载走 Harness 进程内的官方 Cordis 体系）。理由见该文件删除时的提交与 §7.2 归档行。
- **`scripts/`**：
  - `prepare-harness.mjs`：解析、下载并组装 300MB+ 的 Node 运行时与 Harness 依赖包到 `src-tauri/resources/`；**按 `--dsh-target=<name>` 选组装哪条上游通道**（版本、补丁目录、vendored 目录、staging 目录全由 [`dsh-targets.mjs`](scripts/dsh-targets.mjs) 推导）；**依赖安装优先用提交式 lockfile + `npm ci`**（`harness-locks/<target>/`，零解析、可复现；CI 上缺失/失配直接失败），仅本地无 lockfile 时才回退在线解析；幂等快速路径按 `tauri.conf.json` → `bundle.resources` 的完整清单校验产物完整性，并要求 MANIFEST 的 `target` 与本次目标一致（`resources/` 两通道共用，否则会交付另一条线的树）；按 [`patches/LAYERS.md`](patches/LAYERS.md) 的分级决定补丁失败是降级还是中断（`--strict` 恢复全量 fail-fast）。
  - `harness-lockfile.mjs`：提交式 lockfile 的**纯逻辑层**（路径推导 / `inputs.json` 一致性三规则 / 家族钉死推导 / 闭包字段抽取 / 安装位置推导），含 `--self-test`（34 项）；I/O、registry 查询与 npm 调用留在 `prepare-harness.mjs`。
  - `remove-tree.mjs`：**尽力而为**的临时目录删除（三级降级：直接删 → 递归恢复写权限 → OS 命令；**永不抛错**，返回 `{ ok, error, attempts }`），含 `--self-test`（21 项）。守的是「**辅助动作不得否决主结论**」——2026-09-23 alpha.5 的发布死在 `finally` 里一句 `rmSync` 的 EACCES 上，把一次**通过**的 portable 核验判成了发布失败。`package-cli.mjs` / `package-portable.mjs` 的生产路径清理点全部用它。
  - `../harness-locks/<target>/`：与该目标绑定、**必须成对提交**的 `package-lock.json` + `inputs.json`（输入快照——lockfile 本身不记录 overrides）。生成/再生成：`npm run harness:lockfile -- --dsh-target=<t>`（next 解析约 40 分钟、alpha 数分钟；版本锚点/补丁集/vendored 变更后必跑，见升级清单 Step 1 与「依赖解析的堆爆炸」一节）。
  - `dsh-targets.mjs`：**双上游通道的唯一事实源**——目标名 ↔ npm dist-tag ↔ DSH 版本，以及「版本号 → 构建目标」的推导（`--channel-of`）。未知通道返回失败而非回退默认目标。含 `--self-test`。
    > 🔴 **两个「通道名」不是一回事（2026-09-24 解耦）**：目标条目有两个字段，回答两个独立问题——
    > `channel` 是**上游 npm dist-tag 名**（组装时拉哪条线，上游客观事实，不可改），
    > `publishChannel` 是**桌面 tag 的预发布后缀**（本仓命名，可改）。
    > 当前 `next` 目标：`channel: 'next'` 而 `publishChannel: 'rc'`——上游 `next` dist-tag 当下
    > 就指向一个 `rc` 阶段版本，所以桌面发 `v0.7.0-rc.1` 却要组装 `next` 目标的补丁集，这是**正常**的。
    > `targetForVersion` / `--channel-of` 查 `publishChannel`；漂移哨兵查 `channel`（用 `upstreamTagFor`）。
    > **若把两者强行同名**，想改桌面后缀时就会连带去查一个上游不存在的 dist-tag，让哨兵静默退回 `latest` 并永久误报。
  - `recount-patches.mjs`：把补丁 hunk 行号重算到目标版本的真实位置（移植补丁的必需步骤）。拒绝任何未知参数——位置参数曾被静默忽略，会让「重算 alpha」实际跑在默认目标上。
    > ⚠️ **同一份补丁只用下面两条路径中的一条**：两者都能把行号算对，但**产出的补丁不完全相同**（重生成会顺带规范化上下文与计数行）。混用会让同一补丁在两次操作间来回变动，且看不出版本差异是「上游变了」还是「工具换了一条」。
  - `relocate-patch-hunks.mjs`：把补丁的 `@@` 行号重定位到目标版本的真实位置。**与 `recount-patches.mjs` 互补，不是替代**——`recount-patches.mjs` 在纯净树上按内容应用后与纯净文件 `git diff --no-index` **重生成**补丁（依赖 `spawnSync git`，产出规范化补丁）；本脚本**只改写 `@@` 行**、其余原文**逐字节保真**、**无任何外部进程**。行号必然一致，但上下文与计数不保证逐字相同。用途：① 本机 `spawnSync` 不可用（`git` 报 EBUSY）时；② 只需处理纯行号漂移、不希望补丁被重新规范化时。`--pristine` **必传**；退出码 `1` = 存在定位不到 / 纯净树缺该文件 / **纯净树版本不符**。含 `--self-test`（36 项，覆盖「无漂移必须逐字节不变」「末尾空行不得当上下文行」等可证伪夹具）。
    > 🔴 **它比 `recount-patches.mjs` 多一道版本身份判据（`pristineVersionProblem`），这是刻意的**：
    > `--pristine` 的默认路径 `harness-deps/<target>-pristine` 是**目标键、不带版本**，
    > 同一目录在通道内被复用（`next/` 从 rc.2 一路用到 rc.3）⇒ **路径证明不了里面是哪一版**。
    > 2026-09-25 实测该目录装着 `0.1.7-rc.1` 而目标是 `0.1.5-rc.3`：`recount-patches.mjs` 会
    > 照错树的行号把 4 个补丁**静默写回**，而本脚本全部拦下并点名两个版本。
    > 基准取「补丁文件名里的版本段」而非 `dshVersion`，故对 `cordis-plugin-loader`
    > 这类独立版本号的包天然正确。**换锚点后请把版本写进纯净树目录名。**
  - `mock-harness.mjs`：可注入故障的假 Harness（`--fail startup | no-url | port-in-use | after-ready`），集成测试的真实子进程目标。
  - `fault-inject.mjs`：基于 `dsh-host-cli` 的孤儿进程清理与退出码归因验证（6 类故障场景 / 10 项断言）；`npm run fault-inject`，在 Smoke 工作流中为**三平台硬门禁**（2026-09-12 起；此前仅 Windows 硬、其余 `continue-on-error`）。
  - `verify-ipc-surface.mjs`：壳接口面一致性静态检查（命令定义 ↔ 注册 ↔ 前端 `invoke`/`listen` ↔ `local_page` 目标 ↔ `#[allow(dead_code)]` 登记）。这类断线 `dead_code` 看不见，见 §7.3。
  - `verify-shell-pages.mjs`：壳内页面的**运行时**冒烟（DOM 桩里真跑内联脚本 + 逐个点按钮），检查 P1~P6：引用可解析 / 脚本不抛错 / 命令已注册 / **按钮都挂了监听** / 模板 id 前缀可解析 / **命令结果解包了封套**。抓 `verify-ipc-surface` 看不见的两类缺陷：`getElementById` 拿到 `null` 导致整页监听失效；HTML 留了按钮但脚本忘了绑。它曾当场抓到批次 E 引入的「`updates.html` 把封套当载荷用、整页永远不渲染」。
  - `verify-target.mjs`：打包目标守卫（构建主机 vs 目标平台）。目标来源优先级：argv → `TAURI_ENV_TARGET_TRIPLE` → `rustc -vV` host；`--self-test` 跑纯逻辑自检。
  - `generate-app-icons.mjs`：**macOS 手工工具**（依赖 `sips` / `iconutil`），刻意无 npm 入口、不进 CI；定位与产物去向见其文件头注释。
  - `generate-tray-icons.mjs`：**跨平台手工工具**（自带 PNG 编解码，只用 Node 的 `zlib`），从 `build/app-icon.png` 派生两份**托盘**资产——`icons/tray-32.png`（Windows/Linux 方块）与 `icons/tray-template.png`（macOS 单色模板，按亮度从方块里提字形遮罩）。同样无 npm 入口、不进 CI：产物已入库，只在品牌源图变化时重跑。**为什么不能直接复用窗口图标**见该脚本头部。
  - `smoke-launch.mjs`：CI 分层烟雾（L1 无头 / L2 GUI），见 §2。
  - `report-bundle-size.mjs`：采集壳/安装包/资源树体积，写入 CI job summary（§7 期望管理）。
  - `conventional-commits.mjs`：Conventional Commits 解析器（**共享库**，被下面两个脚本复用）。解析 / 归类 / 版本建议都收在这里，避免两个 CLI 各写一份、对同一条提交给出两种说法。含 `--self-test`。
  - `changelog.mjs`：由提交历史生成 `CHANGELOG.md` 与 Release 正文（`--write` / `--notes`）。仓库内变更日志与 Release 正文同源同渲染，因此不会互相矛盾。见 §8.3。
  - `version.mjs`：版本号的 `show` / `check` / `set` / `bump`（`bump auto` 依提交历史判定升哪一位），并同步 `Cargo.toml`；`--commit` 会一并重生成 CHANGELOG 段落。见 §8。
- **`.github/workflows/`**：`ci.yml`（PR / 手动；**刻意不监听 `push`**——日常提交零自动化）、`smoke.yml`（**仅手动**触发冒烟：`l1` / `assembled` / `full` 三档）、`release.yml`（推 `v*` tag / 手动指定 tag）。三者分工见 §8.4——CI 负责**静态验证**，Smoke 负责**按需起的真实进程验证**，Release 负责**出包与发布**，互不重复。
- **`.github/ISSUE_TEMPLATE/`**：Issue 表单（YAML form，非 markdown 模板）。`bug_report.yml` 内嵌**脱敏诊断包两步指引**（菜单「Harness → Export Diagnostics…」导出 → 建完 issue 后拖进评论区，因为 GitHub 只允许对已创建的 issue 挂附件），并给出应用起不来时按平台取日志的路径表，同时**显式声明原始日志未脱敏**；`feature_request.yml` 明确 Harness 侧功能应提给上游；`config.yml` 关闭空白 issue 并挂 Discussions 联系入口。GitHub Discussions 已于 2026-09-12 开启（分类见 `docs/dev-plan-0.2-hardening.md` 批次 0.2-D）。**表单结构必须按 `json.schemastore.org/github-issue-forms.json` 核对**：`checkboxes` 不接受 `validations`，勾选项的必填写在 option 的 `required` 上——写错不会让 YAML 非法，只会让表单在 GitHub 侧渲染异常，「YAML 能解析」不能当通过判据。
- **`CHANGELOG.md`**：**生成物，勿手工编辑**（改动会在下次生成时被覆盖）。数据源是 git 提交历史，见 §8.3。
- **`patches/<target>/`**：`patch-package` 补丁，**按上游运行时通道分目录**（`next` / `alpha`，见 §8.6）+ [`LAYERS.md`](patches/LAYERS.md) 分级清单（`brand` / `ui-behavior` / `functional`）。分级表按**包名**索引——新增一条通道不需要动登记表。
- **`packages/<target>/`**：按目标分目录的 vendored 覆盖包（被上游重新发布过、需要冻结字节的 tgz）。⚠️ **两条线当前均为空**（alpha 于 2026-09-16、next 于 2026-09-24 退役）——vendoring 的前提是「上游静默重发布过同版本号的 tarball，字节不同」，两条线各自实测**均不成立**（next 线是逐对 `diff -rq` 与 registry 内容**逐字节一致**）。`prepare-harness.mjs` 以 `readdirSafe` + `existsSync` 容忍该目录整体缺失。
- **`docs/`**：架构设计、契约定义、不变量与技术规范：
  - `dsh-desktop-redesign-architecture-and-plan.md`：最新系统架构重构设计与执行计划。
  - `system_design.md`：核心系统架构设计、契约定义与不变量清单。
  - `archive/`：**已归档的设计文档**（`model_gateway_design.md`、`plugin_isolation_architecture.md`）。归档 ≠ 计划中：这些方案已被裁定不做，代码已删除，文档仅留作设计意图的追溯。每份文首都有归档说明。
  - `dsh-upgrade-checklist.md`：DSH 官方版本升级清单（补丁重生成 → 断言 → 门禁 → 三平台烟雾 → 体积对比）。
  - `harness-packaging-and-compatibility.md`：产物瘦身与补丁脆弱性治理的长期方案（A/B/C）。

