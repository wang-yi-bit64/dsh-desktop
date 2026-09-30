# AGENTS.md 被精简章节的原文快照

> 保真存档：`AGENTS.md` 为回到 32 KiB 指令预算而精简了措辞，这里保留三个被精简章节（§3、§4 前言、§6）的**逐字原文**，确保「搬位置、不删内容」。
> 规则以 `AGENTS.md` 的现行版本为准；本节用于追溯被精简掉的例子、告警与出处细节。

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
   - macOS 采用进程组 + **Node 侧父死看门狗**（`build/parent-death-watchdog.mjs`，轮询 `process.kill(ppid, 0)`；**入口与 `mock-harness.mjs` 共同引用**——故障注入的 mock 模式会把入口整体替换成 mock，只装在入口上测不到）+ 启动时退出扫描清理。
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

## 4. 平台兼容性与避坑指南

- **Rust 工具链版本**：因传递依赖项（如 `idna_adapter` / `url`）采用了 2024 edition 特性，要求 Rust stable `>= 1.85`。
- **Tauri 资源校验**：Tauri 的 `build.rs` 在编译期会校验资源 glob 匹配。全新拉取的代码在执行 `cargo check --workspace` 或 `cargo test --workspace` 前，需先运行 `node scripts/stub-tauri-resources.mjs`。
- **Node 执行路径**：打包产物运行内置在 `src-tauri/resources/node/` 下的 Node 二进制（Windows 下带 `.exe` 后缀）。
- **页面跳转流程**：Webview 首先加载 `frontend/index.html` 启动屏，并监听 `harness://status` 事件；`readiness` 模块探测并校验安全 Token 就绪后，Rust 层将 Webview 导航重定向至本地 Harness 服务的 Web 地址。

## 6. 修改敏感模块前必读文档
- `docs/roadmap.md`：**顶层路线图**——定位声明、边界原则与阶段序列（H0~H3）；定位与裁决冲突以它为权威。
- `docs/dev-plan-hardening-and-differentiation.md`：**近端施工计划（路线图 H0 阶段）**——风险清单 R1~R9 与批次 H~N（风险哨兵 / 上游推进 / 门禁可信度 / 宣称纪律 / 构建卫生 / 运维韧性 / 差异化）。
- `docs/dev-plan-0.2-hardening.md`：**产品与分发侧增补计划（批次 0.2-A~D）**——与 H0 互补：签名/公证、发布通道、桌面体验底线、上游 PR 候选、反馈闭环；它相对 H0 的独有覆盖与三处优先级冲突写在该文首「关系」一节，**是否并入 H0 及冲突如何裁决归用户**。
- `docs/dev-plan-disconnected-points.md`：上一阶段主计划（批次 A~G 已闭环）——断线点清单（D1~D11）与裁决记录，留作追溯；「插件禁用语义」的证据链在这里（批次 C），0.2-B4 项要重走它。
- `docs/dev-plan-cli-distribution.md`：**CLI / runtime 可引用产物的分期计划**（roadmap H1-c/H1-d）——Phase 1（CLI 归档 + sha256 + 回读校验，2026-09-13 已执行）、**§5 发布通道退役评估（2026-09-24）** 与 Phase 2（runtime 独立发布，未开工，带触发条件与前置改造清单）。**动 CLI 发布形态前先读它**，尤其是 §5 与「产物不含 runtime」这条边界。
- `docs/adr/`：**架构决策记录库**——`AGENTS.md` §4「已修复，勿回归」与各 dev-plan 决策点的 ADR 化汇总（36 篇，分组编号 001–050）。代码说明「现在是什么样」，ADR 说明「为什么不是别的样」；新增能力先写代码、后按 `docs/adr/README.md` 的规则登记决策。
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
