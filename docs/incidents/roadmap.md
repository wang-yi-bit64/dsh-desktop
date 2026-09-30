# 架构演进与路线图 (P0~P4)

> 从 `AGENTS.md` 原 §5 原样迁入。

## 5. 架构演进与路线图 (P0~P4)

> 下表描述**设计目标**，不等于当前可用能力。阶段名后标注的状态以 §7 的代码证据为准。
> **状态词表见 §7.3**：⚠️ 未接线（有代码无调用方）、🕓 计划中（无代码且刻意不做）、
> 🗄️ 已归档（曾实现，现已删除并裁定不做）。

- **P0（契约基线与无头核心库）✅ 已接线**：独立通用契约库（`dsh-contracts`）、集中常量契约、**标准错误码总表**（`E1xxx`~`E7xxx`，见 §7.2）、无 GUI 核心库设计（`dsh-host`, `dsh-host-cli`）、Win32 JobObject / POSIX 孤儿防护。
- **P1（生命周期监督与自愈）✅ 已接线**：Supervisor 监督器、状态流转与退避重试、LogRing 环形缓冲、崩溃归因分析（`diagnostics.rs`）与 Safe Mode 隔离 Profile。
- **P2（插件分级隔离与看门狗）🗄️ 已归档（2026-09-10，批次 F）**：Tier 0/1/2 分级沙箱、JSON-RPC 2.0 通信、连续错误断路器曾实现且有单测，但**从未有任何运行时调用方**，且不在真实插件挂载路径上（真实挂载走 Harness 进程内的官方 Cordis 体系）。按 `docs/dev-plan-disconnected-points.md` §4 决策点 3 裁定「冻结并归档」：`plugin_worker.rs`、`plugin-worker-host.mjs`、`PluginWorkerClient` 全部删除，设计文档移入 `docs/archive/`。**当前生效的插件防护只有 `plugin-safety-guard.mjs` 的进程内 `formatFaultDetails` 归因**——同进程的插件崩溃仍可能带走 Harness。
- **P3（多模型工具网关与基准测试）🗄️ 已归档（2026-09-10，批次 F）**：Schema 降级清洗、多厂商方言适配、微秒级基准均已实现并测试通过，但无运行时消费者。按同一裁定从 workspace 移除（目录 + members + `[workspace.dependencies]`），设计文档移入 `docs/archive/model_gateway_design.md`。恢复前置条件仍见该文档的「退出条件」段。
- **P4（薄壳收敛与诊断系统 2.0）✅ 已接线（2026-09-10 批次 D/E 闭环）**：前端结构化错误归因、**统一 IPC 封套（`IpcEnvelope<T>`，当时 17 个命令全部收敛；现 **20** 个，见 §7.2）**、**一键脱敏导出诊断包（`diagnostics_export`，5 类脱敏规则 + 正反用例）**、**应用内日志查看器（`logs.html`）**、**插件恢复页（可操作、有状态反馈）** 均已接线。证据获取路径现为五条：错误页 / 恢复页 / 日志页 / **反馈页** / 原生菜单「Export Diagnostics…」。

