# DSH Desktop 改造后架构设计与开发计划

> 项目：`wang-yi-bit64/dsh-desktop`
>
> 文档版本：v1.0
>
> 日期：2026-09-08
>
> 目标：在保留 Rust + Tauri 2 技术路线、官方 DSH Web UI 和独立 Harness Runtime 的前提下，将项目从“功能较多的桌面壳”收敛为“薄 Shell + Supervisor + 独立 DSH Runtime + 可选插件隔离 + 独立 Model Gateway”的长期可维护架构。

---

## 1. Executive Summary

### 1.1 改造结论

当前 `wang-yi-bit64/dsh-desktop` 的技术方向总体正确：Tauri 2 + Rust、独立 Node Harness 子进程、Supervisor、Safe Mode、故障诊断以及 Model Gateway 都是值得保留的方向。

但当前架构逐渐把 Desktop Shell、Runtime Orchestration、Plugin Isolation、Model Gateway、Mobile Bridge 等能力集中到同一项目边界中，存在“桌面壳向第二套 DSH Runtime 演化”的风险。

本次改造的核心目标不是继续增加功能，而是**重新划定职责边界**：

- Tauri Shell：只负责桌面能力。
- Rust Supervisor：只负责 DSH 进程生命周期、健康检查、崩溃恢复、日志与诊断。
- DSH Runtime：继续由官方 Node/DSH 负责 Agent、Session、Cordis、Tool、MCP 等核心业务。
- Plugin Host：仅对不可信第三方插件做分级隔离，不强制把所有插件 RPC 化。
- Model Gateway：作为 Runtime 侧独立组件，负责 Provider 适配、Canonical Tool Schema、Tool Calling 规范化，不把模型业务逻辑放进 Tauri。
- Desktop ↔ DSH：采用最少集成面，优先使用 DSH 官方 Web UI 和明确的 loopback HTTP/WebSocket 边界。

### 1.2 核心目标架构

```text
                         DSH Desktop
                              │
                ┌─────────────┴─────────────┐
                │                           │
         Tauri 2 Shell                 WebView2
                │                           │
      native UI / tray / update        Official DSH Web UI
                │                           │
                └─────────────┬─────────────┘
                              │ IPC
                              ▼
                    Rust DSH Supervisor
                              │
                  spawn / ready / health
                  restart / recovery / logs
                              │
                   isolated child process
                              │
                              ▼
                     Node.js DSH Runtime
                              │
               ┌──────────────┼──────────────┐
               │              │              │
             Agent         Plugins          MCP
               │
               ▼
          Model Gateway
               │
       ┌───────┼────────┐
       │       │        │
     OpenAI  Gemini  Anthropic
       │       │        │
       └───────┼────────┘
               ▼
            Provider API
```

### 1.3 改造原则

1. **Shell 薄化**：Tauri 不实现 Agent 业务。
2. **Runtime 独立**：DSH 是唯一 Agent Runtime，不产生第二份 Agent 状态机。
3. **进程边界优先**：崩溃隔离和安全边界优先于线程隔离。
4. **插件分级隔离**：官方插件可同进程；社区插件默认独立进程；高风险插件进一步限制文件、网络和环境变量。
5. **模型层独立**：Model Gateway 与 Tauri 解耦，可在 CLI/Server/Desktop 复用。
6. **兼容优先**：以 DSH upstream compatibility 为一等公民，不因为 Desktop 需求修改 Agent 内核。
7. **性能可量化**：以启动、空闲内存、IPC、Tool Calling、插件崩溃恢复为指标，而不是只看安装包大小。
8. **可观测性先行**：所有启动、崩溃、恢复、Provider 转换均可诊断。

---

# 2. Current Baseline

## 2.1 当前项目已有能力

截至 2026-09-08，仓库 README 显示其已经采用 Rust + Tauri 2，并包含以下核心能力：

- Bundled Node.js v24 与完整 `@deepseek-ai/dsh` 依赖树。
- Harness subprocess lifecycle。
- Supervisor / heartbeat / restart / circuit breaker。
- 插件 worker-thread 隔离与 safety guard。
- `dsh-model-gateway` Rust crate，用于多 Provider Tool Schema 处理。
- Unified IPC transport abstraction。
- Safe Mode / Recovery。
- Multi-profile / session management。
- Mobile Bridge。
- Tauri updater。
- Single-instance。

仓库当前为 Cargo workspace，并包含 `src-tauri`、`crates/dsh-host`、`crates/dsh-host-cli`、`crates/dsh-model-gateway` 等成员；Release profile 当前启用了 LTO、单 codegen unit、size optimization 和 strip。见当前仓库 README 与 `Cargo.toml`。

## 2.2 当前架构的主要问题

### P1：Desktop 与 Runtime 责任边界偏厚

当前项目同时包含：

- Desktop Shell
- Harness Host
- Plugin Worker Host
- Model Gateway
- Mobile Bridge
- Recovery
- Update
- Profile
- Desktop customization patches

这些功能全部合理，但全部落在同一个产品代码边界之后，会使 Desktop 对 DSH 内部协议、Plugin API、Tool Schema、Provider 行为产生越来越强的耦合。

### P1：Worker Thread 被当作主要插件隔离边界

`worker_threads` 可以隔离 JavaScript 执行上下文，但不是强安全边界，也不是最可靠的 crash isolation 边界。

目标架构应把：

- thread isolation：性能优化手段
- process isolation：故障边界/安全边界

明确区分。

### P1：Model Gateway 容易越界到 Desktop 层

Model Gateway 的设计理念是正确的，尤其适合治理：

- JSON Schema dialect 差异
- Provider request/response 差异
- Tool declaration 限制
- Tool call streaming
- strict / non-strict 模式

但是它不应成为 Tauri 的 Agent 业务层。否则 Desktop 会承担越来越多 Provider compatibility debt。

### P2：构建和依赖链偏复杂

当前 workspace 既有 Rust crates、Tauri、Node Harness、bundled resources、patches、vendor packages 和 build scripts。该结构可以支撑工程化，但需要继续减少“运行时重复职责”，否则构建复杂度和升级复杂度会超过收益。

### P2：可观测性需要统一成单一事件模型

启动、ready、heartbeat、crash、restart、plugin failure、model conversion failure 应该使用统一的诊断事件模型，而不是分别在 Shell、Supervisor、Node、Plugin Host 各自记录非结构化日志。

---

# 3. Target Architecture

## 3.1 五层模型

```text
L1  Desktop Shell
    Tauri / WebView / Tray / Update / Native Dialog

L2  Supervisor
    process lifecycle / health / crash / recovery / logs

L3  DSH Runtime
    Agent / Session / Cordis / Tools / MCP / Web

L4  Extension Runtime
    trusted plugins / isolated plugins / plugin policy

L5  Model Gateway
    canonical tool schema / provider adapter / stream normalization
```

### 每层必须满足单向依赖

```text
Desktop Shell
      ↓
Supervisor
      ↓
DSH Runtime
      ↓
Extension / Model Gateway
```

禁止：

```text
DSH Runtime → Tauri UI implementation
Plugin → arbitrary Tauri IPC
Model Gateway → Tauri window
Tauri Shell → Cordis internal registry
```

---

# 4. Layer 1 — Tauri Shell

## 4.1 职责

Tauri 只负责桌面操作系统能力：

- Window / tray / menu
- Single instance
- Native dialogs
- Update
- Application lifecycle
- Desktop settings
- Crash/recovery UI
- Diagnostics UI
- Safe Mode entry UI
- 与 Supervisor 的最小 IPC

## 4.2 不允许承担的职责

以下逻辑不得进入 Tauri business layer：

- Agent loop
- Session state machine
- Tool registry
- MCP registry
- Provider-specific Tool conversion
- Cordis plugin composition
- DSH conversation persistence

## 4.3 WebView 集成原则

主窗口直接加载官方 DSH Web UI：

```text
Tauri WebView
      ↓
http://127.0.0.1:<random-port>
      ↓
DSH Web UI
```

不建议：

```text
Tauri React UI
   ↓ iframe
DSH Web UI
```

也不建议复制 DSH 前端并维护第二套聊天界面。

理由：降低 renderer 层复制、减少 postMessage/bridge、最大化 upstream feature parity。

---

# 5. Layer 2 — Rust Supervisor

## 5.1 Supervisor 是整个 Desktop 的核心基础设施

建议把 `dsh-host` 定义成稳定的无 GUI Runtime Orchestrator。

```text
DshHost
 ├── Launcher
 ├── ReadinessProbe
 ├── HealthMonitor
 ├── RestartController
 ├── ProcessTreeGuard
 ├── LogCollector
 ├── CrashAnalyzer
 └── RecoveryCoordinator
```

## 5.2 生命周期状态机

```text
Stopped
  │
  ▼
Starting
  │
  ├── process spawn fail ──→ Failed
  │
  ▼
WaitingForReady
  │
  ├── timeout ─────────────→ Failed
  │
  ▼
Ready
  │
  ▼
Running
  │
  ├── unhealthy ───────────→ Recovering
  ├── process exit ─────────→ Crashed
  └── user stop ────────────→ Stopping

Recovering
  │
  ├── success ──────────────→ Running
  ├── retry exhausted ──────→ SafeModeSuggested
  └── fatal ─────────────────→ Failed
```

## 5.3 Ready 条件必须是多条件

不能只根据“端口被打开”判断 ready。

建议：

```text
ready =
  process_alive
  && port_listening
  && http_health_ok
  && expected_dsh_signature
  && boot_token_valid
```

这样可以减少：

- 半启动进程
- 旧 Harness 服务误复用
- 端口占用导致的假 ready
- renderer 提前打开产生的 race condition

## 5.4 Process Tree Protection

Windows：Job Object。

POSIX：process group / session。

关闭 DSH 时必须做到：

```text
Tauri exit
   ↓
Supervisor stop
   ↓
Graceful shutdown
   ↓ timeout
Kill process tree
   ↓
Verify no orphan child
```

---

# 6. Layer 3 — DSH Runtime

## 6.1 原则

DSH Runtime 是唯一 Agent Runtime。

Desktop 不重新实现：

- Agent
- Tool registry
- Session
- MCP
- Cordis composition
- Prompt orchestration

Desktop 只负责启动并承载官方 Harness。

## 6.2 Runtime 目录布局

推荐：

```text
app-data/
├── runtime/
│   └── dsh/<version>/
├── profiles/
│   ├── default/
│   ├── safe-mode/
│   └── backup/
├── logs/
├── cache/
└── diagnostics/
```

如果需要与 CLI 共享 DSH 数据，应通过兼容的 `DSH_HOME` 机制实现，而不是把 Desktop 的私有数据库复制一份。

## 6.3 Profile 是隔离核心

每个 profile 至少记录：

```text
profile.json
runtime version
node version
enabled plugins
plugin hashes
provider configs metadata
patch set
safe-mode flag
created-at
last-known-good
```

目标：

```text
normal profile
      │
      ├── third-party plugins
      ├── patches
      └── provider config

safe-mode profile
      │
      └── minimum official core
```

---

# 7. Layer 4 — Plugin Runtime

## 7.1 插件分级

### Tier 0：Official/Trusted

```text
DSH Process
└── in-process plugin
```

用途：官方插件、经过签名/审核、对性能敏感的基础能力。

### Tier 1：Community

```text
DSH
└── Plugin Host Process
      └── JSON-RPC / stdio
```

用途：默认社区插件。

### Tier 2：High Risk

```text
DSH
└── Restricted Plugin Process
      ├── limited filesystem
      ├── filtered env
      ├── optional network restriction
      ├── CPU/time limits
      └── kill/restart
```

## 7.2 不建议所有插件统一 RPC 化

否则会造成：

- 高频 event 额外序列化
- tool call latency 上升
- plugin API 复杂化
- UI 服务跨进程传递困难
- 上游兼容性下降

采用分级模型后，可以把 RPC 成本控制在真正需要隔离的插件上。

## 7.3 Plugin Host API

只提供最小 API：

```text
plugin.init
plugin.health
plugin.registerTool
plugin.invokeTool
plugin.dispose
```

禁止插件获得：

```text
raw Tauri IPC
arbitrary window handle
full filesystem access
unrestricted environment
arbitrary desktop process control
```

---

# 8. Layer 5 — Model Gateway

## 8.1 Gateway 必须脱离 Tauri

推荐独立为：

```text
packages/dsh-model-gateway/
```

或继续保留 Rust crate，但定义为 Runtime-facing library/service，而不是 Desktop business module。

## 8.2 Canonical Tool Model

定义统一内部模型：

```text
CanonicalTool
├── name
├── description
├── input_schema
└── metadata
```

Provider adapter 负责：

```text
CanonicalTool
      ↓
ProviderSchema
```

以及：

```text
ProviderToolCall
      ↓
CanonicalToolCall
```

## 8.3 Provider Adapter

第一阶段支持：

```text
OpenAI-compatible
DeepSeek
Google Gemini
Anthropic Claude
```

后续增加 Provider 时不得修改 Agent 核心代码。

## 8.4 Schema Sanitization Pipeline

```text
Raw Tool Schema
      ↓
Parse
      ↓
Validate
      ↓
Normalize
      ↓
Provider Capability Check
      ↓
Sanitize
      ↓
Emit Provider Request
```

建议能力矩阵：

| 能力 | OpenAI | DeepSeek | Gemini | Claude |
|---|---|---|---|---|
| object | ✓ | ✓ | ✓ | ✓ |
| nested object | ✓ | ✓ | 需检查 | ✓ |
| array items | ✓ | ✓ | 需严格规范化 | ✓ |
| additionalProperties | provider-specific | provider-specific | 谨慎处理 | provider-specific |
| anyOf/oneOf | 支持度不一致 | 支持度不一致 | 高风险 | 支持度不一致 |
| nullable | provider-specific | provider-specific | 需转换 | provider-specific |
| strict mode | provider-specific | provider-specific | provider-specific | provider-specific |

## 8.5 Tool Calling 必须可测试

所有 Provider adapter 都必须具备：

1. schema unit tests
2. request snapshot tests
3. tool-call roundtrip tests
4. streaming tests
5. malformed-schema negative tests
6. provider regression fixtures

这部分直接针对第三方模型 Tool Calling 的长期稳定性。

---

# 9. IPC Design

## 9.1 Desktop IPC 应保持最小

```text
Tauri
  │
  ├── supervisor.start
  ├── supervisor.stop
  ├── supervisor.restart
  ├── supervisor.status
  ├── supervisor.diagnostics
  ├── profile.list
  ├── profile.activate
  ├── recovery.enterSafeMode
  └── update.check/install
```

禁止通过 Tauri IPC 代理 DSH 的全部 API。

## 9.2 DSH Web 通信

继续使用：

```text
HTTP
WebSocket
127.0.0.1 only
```

Desktop 不插手 Agent message protocol，除非必须满足 native feature。

## 9.3 IPC Envelope

统一 Envelope：

```json
{
  "version": 1,
  "request_id": "uuid",
  "type": "supervisor.status",
  "timestamp": 0,
  "payload": {},
  "error": null
}
```

要求：

- version 可升级
- request_id 可追踪
- structured error
- 无裸 string error

---

# 10. Unified Error Model

错误必须分层：

```text
DSHDesktopError
├── Launch
├── Readiness
├── Runtime
├── Plugin
├── Model
├── Network
├── Profile
├── Recovery
└── Update
```

例如：

```text
PluginError::DuplicateToolRegistration {
    plugin: "dsh-recall",
    tool: "recall"
}
```

而不是最终只出现：

```text
tool already registered
```

诊断页面需要同时显示：

```text
root cause
plugin owner
profile
runtime version
first failing stage
recommended action
log correlation id
```

---

# 11. Startup / Recovery Design

## 11.1 正常启动

```text
App Start
  ↓
Single Instance
  ↓
Load Desktop Config
  ↓
Select Profile
  ↓
Supervisor Start
  ↓
Spawn DSH
  ↓
Wait Ready
  ↓
Validate Web Signature
  ↓
Open WebView
```

## 11.2 崩溃恢复

```text
Running
  ↓
Heartbeat fail / process exit
  ↓
Capture diagnostics
  ↓
Classify
  ├── transient → restart
  ├── provider → retain runtime, mark model failure
  ├── plugin → isolate plugin
  └── boot-fatal → Safe Mode
```

## 11.3 Circuit breaker

推荐：

```text
max_restart = 3
window = 60s
cooldown = 30s
```

超过阈值后：

```text
Normal Profile
      ↓
Safe Mode Suggestion
      ↓
Disable last suspect plugin
      ↓
Restart
```

不要默认直接删除用户插件或 profile。

---

# 12. Logging & Observability

## 12.1 三层日志

```text
Desktop log
Supervisor log
DSH runtime log
```

统一以 correlation id 关联：

```text
boot_id
session_id
profile_id
process_id
plugin_id
request_id
```

## 12.2 必须记录的指标

- process startup time
- ready time
- renderer first-load time
- restart count
- plugin crash count
- model request latency
- tool schema conversion failures
- tool execution latency
- memory RSS
- CPU idle/runtime
- orphan process count

## 12.3 Diagnostics Bundle

一键导出：

```text
diagnostics.zip
├── desktop.json
├── supervisor.json
├── runtime.json
├── profile-manifest.json
├── recent-harness.log
├── plugin-status.json
├── model-gateway.json
└── environment.json
```

不得包含 API key、access token、完整 prompt 或用户私密文件内容。

---

# 13. Performance Architecture

## 13.1 不追求“壳的理论最小”，而追求端到端稳定开销

性能优化优先级：

```text
P0 DSH Runtime 不重复启动
P0 不重复加载 Web UI
P0 不重复维护 Session
P0 降低插件崩溃导致的整体重启
P1 减少跨进程序列化
P1 减少无意义 heartbeat / polling
P1 限制日志 IO
P2 优化 Rust shell startup
P2 优化 WebView startup
```

## 13.2 建议基准线

Windows x64 推荐目标：

| 指标 | Target |
|---|---:|
| Tauri shell cold start | < 500 ms |
| Supervisor process spawn overhead | < 150 ms |
| DSH ready time | 以真实 baseline 为准，目标降低 15% |
| Shell idle RSS | < 120 MB，不含 DSH Web/Node |
| Supervisor idle RSS | < 25 MB |
| Native IPC p95 | < 2 ms |
| Local supervisor restart decision | < 100 ms |
| Plugin isolated crash recovery | < 2 s（不含 DSH full reboot） |
| Orphan process | 0 |

这些是工程目标，不是当前实现已经达到的事实。第一阶段必须先建立 baseline。

## 13.3 性能诊断工具链

Windows：

- Process Explorer
- Windows Performance Recorder / Analyzer
- ETW
- WebView2 DevTools

Runtime：

- Node `--cpu-prof`
- Node heap snapshots
- Performance marks
- DSH structured logs

Rust：

- `cargo flamegraph`
- `tracing`
- criterion benchmarks

---

# 14. Repository Refactor Plan

推荐最终结构：

```text
 dsh-desktop/
 ├── crates/
 │   ├── dsh-supervisor/
 │   ├── dsh-supervisor-cli/
 │   ├── dsh-contracts/
 │   └── dsh-model-gateway/
 │
 ├── src-tauri/
 │   ├── src/
 │   │   ├── app.rs
 │   │   ├── commands.rs
 │   │   ├── tray.rs
 │   │   ├── update.rs
 │   │   └── recovery_ui.rs
 │   └── frontend/
 │
 ├── packages/
 │   ├── plugin-host/
 │   ├── plugin-sdk/
 │   └── provider-fixtures/
 │
 ├── runtime/
 │   ├── launcher/
 │   └── manifests/
 │
 ├── patches/
 ├── scripts/
 ├── tests/
 │   ├── smoke/
 │   ├── integration/
 │   ├── compatibility/
 │   └── performance/
 │
 └── docs/
     ├── architecture.md
     ├── development-plan.md
     ├── adr/
     ├── contracts/
     ├── plugin-isolation.md
     └── model-gateway.md
```

### 14.1 Rust crate 边界

`dsh-contracts`

只放：

- status enum
- error model
- IPC envelope
- profile metadata
- diagnostics schema

`dsh-supervisor`

只放：

- process management
- readiness
- health
- restart
- log collection
- recovery

`dsh-model-gateway`

只放：

- canonical schema
- provider capability
- sanitizer
- request/response mapping

`src-tauri`

只放：

- GUI
- Tauri commands
- native OS integration

---

# 15. Development Plan

## Phase 0 — Baseline & Characterization

### 目标

先证明当前项目“实际是什么”，避免在未知行为上直接重构。

### 工作项

- 固化当前 DSH 版本、Node 版本、插件集合。
- 记录正常启动日志。
- 记录崩溃日志。
- 建立 startup / ready / memory / CPU baseline。
- 建立当前 Tool Calling fixtures。
- 建立第三方 plugin 启动失败 fixture。
- 建立 profile migration fixture。
- 建立 Windows orphan-process fixture。

### 完成标准

```text
baseline-report.md
startup.json
memory.json
tool-schema-fixtures/
plugin-failure-fixtures/
```

---

## Phase 1 — Contract First

### 目标

先固定跨层协议，再移动实现。

### 工作项

- 新建 `dsh-contracts`。
- 定义 Supervisor state machine。
- 定义 IPC envelope。
- 定义 Error taxonomy。
- 定义 diagnostics schema。
- 定义 Profile manifest。
- 定义 runtime manifest。

### 验收

所有 Tauri command 和 Supervisor event 都必须通过 contracts 编译/验证。

---

## Phase 2 — Supervisor Solidification

### 目标

让 `dsh-supervisor` 成为真正独立的 headless runtime orchestrator。

### 工作项

- 重构 spawn/readiness/stop。
- 多条件 readiness。
- 随机 loopback port。
- Process tree guard。
- stdout/stderr ring buffer。
- structured lifecycle event。
- restart controller。
- circuit breaker。
- CLI parity。

### 验收

```text
start
status
stop
restart
health
logs
```

五类操作全部不依赖 Tauri。

---

## Phase 3 — Desktop Shell Thin-down

### 目标

删除 Tauri 中所有非桌面业务逻辑。

### 工作项

- 将启动逻辑移到 Supervisor。
- 将 recovery classification 移到 Supervisor。
- 将 profile state 管理最小化。
- 删除 Tauri 对 Cordis/plugin registry 的直接依赖。
- WebView 直接加载 DSH。
- IPC 缩减到少量 native commands。

### 验收

`src-tauri` 中不存在：

```text
Agent state
Tool schema
Plugin registration
Provider-specific code
Session persistence implementation
```

---

## Phase 4 — Plugin Isolation 2.0

### 目标

从 worker-thread-only 演进为分级隔离。

### 工作项

- 定义 plugin trust level。
- 实现 Tier 0 trusted in-process。
- 实现 Tier 1 process host。
- 实现 JSON-RPC protocol。
- 实现 crash restart。
- 实现 plugin health。
- 实现插件级诊断。
- 实现 Safe Mode plugin quarantine。

### 验收

测试：

```text
plugin throws
plugin exits
plugin infinite loop
plugin malformed RPC
plugin duplicate tool
plugin missing service
```

均不得导致 Desktop Shell 崩溃。

---

## Phase 5 — Model Gateway 2.0

### 目标

解决第三方模型 Tool Calling / Schema 兼容问题，并与 Tauri 解耦。

### 工作项

- Canonical Tool Model。
- JSON Schema normalizer。
- Provider capability registry。
- Gemini sanitizer。
- OpenAI-compatible adapter。
- DeepSeek adapter。
- Anthropic adapter。
- request snapshot tests。
- roundtrip tests。
- malformed schema tests。

### 验收

以下情况必须可诊断：

```text
invalid schema
unsupported keyword
nested array issue
nullable mismatch
required mismatch
unknown tool call
malformed tool arguments
streaming tool call split
```

错误必须标明：

```text
provider
model
tool name
schema path
normalization rule
final emitted schema
```

---

## Phase 6 — Recovery & Diagnostics 2.0

### 目标

把过去需要用户手工搜索日志的问题变成自动诊断。

### 工作项

实现 root-cause 分类：

```text
BOOT_TIMEOUT
PORT_CONFLICT
RUNTIME_EXIT
PLUGIN_LOAD_ERROR
DUPLICATE_TOOL
MISSING_SERVICE
PROVIDER_SCHEMA_ERROR
PROFILE_CORRUPTION
UPDATE_FAILURE
UNKNOWN
```

并提供动作：

```text
Retry
Restart
Disable plugin
Enter Safe Mode
Restore last-known-good
Open diagnostics
```

---

## Phase 7 — Performance & Release Hardening

### 工作项

- 建立 CI smoke test。
- 建立 cold-start benchmark。
- 建立 memory benchmark。
- 建立 24h soak test。
- 建立 plugin fault-injection test。
- 建立 Provider regression suite。
- 检查 WebView navigation security。
- 检查 updater signature。
- 检查 orphan processes。
- 检查 profile migration。

### Release Gate

没有通过以下条件不得发布：

```text
cargo test
npm test
smoke test
startup benchmark
plugin fault test
provider fixture test
24h soak test
```

---

# 16. 推荐开发顺序

```text
P0  Characterization Test
      ↓
P1  Contracts
      ↓
P2  Supervisor
      ↓
P3  Thin Shell
      ↓
P4  Plugin Isolation
      ↓
P5  Model Gateway
      ↓
P6  Recovery/Diagnostics
      ↓
P7  Performance/Release
```

**禁止先做 UI 大改，再修 Runtime。**

---

# 17. Git Branch / Commit Strategy

推荐：

```text
main
 │
 ├── refactor/contracts
 ├── refactor/supervisor
 ├── refactor/thin-shell
 ├── refactor/plugin-host
 ├── feature/model-gateway-v2
 ├── feature/recovery-v2
 └── perf/benchmark
```

每个阶段独立合并，保证随时可回滚。

推荐 commit 结构：

```text
refactor(supervisor): extract readiness state machine
refactor(shell): remove direct cordis dependency
feat(plugin-host): add tier-1 process isolation
feat(model-gateway): add canonical tool schema
fix(recovery): classify duplicate tool registration
perf(startup): reduce redundant runtime probes
```

---

# 18. ADR 列表

建议在 `docs/adr/` 建立：

```text
ADR-001 thin desktop shell
ADR-002 Rust supervisor boundary
ADR-003 official DSH as single runtime
ADR-004 plugin trust tiers
ADR-005 process isolation over thread isolation
ADR-006 canonical tool schema
ADR-007 model gateway outside Tauri
ADR-008 profile isolation
ADR-009 random loopback port
ADR-010 unified diagnostics model
ADR-011 compatibility matrix
ADR-012 no duplicated DSH frontend
```

每个 ADR 都必须回答：

```text
Context
Decision
Alternatives
Trade-offs
Migration impact
```

---

# 19. Compatibility Strategy

## 19.1 Runtime Compatibility Matrix

建立：

| Desktop | DSH | Node | Plugin API | Status |
|---|---|---|---|---|
| 0.2 | 0.1.x | 24.x | v1 | supported |
| 0.2 | 0.2.x | 24.x | v2 | test |
| 0.3 | 0.2.x | 24.x | v2 | supported |

## 19.2 启动前检查

```text
Desktop
  ↓
Read runtime manifest
  ↓
Check compatibility
  ↓
Check profile
  ↓
Check plugin API
  ↓
Start DSH
```

不要等 DSH 启动后才发现 plugin API 不兼容。

---

# 20. Security Requirements

必须保持：

- Renderer 不启用 Node integration。
- IPC 最小权限。
- Loopback 优先。
- WebView 禁止任意导航。
- Native command 校验调用来源。
- Plugin process 不默认继承全部环境变量。
- Plugin filesystem scope 最小化。
- Diagnostics 默认脱敏。
- API key 不进入普通日志。
- 更新包必须验证签名/摘要。

---

# 21. 关键风险与规避方案

| 风险 | 等级 | 对策 |
|---|---|---|
| DSH upstream API 变化 | 高 | compatibility layer + pinned runtime |
| Plugin API 变化 | 高 | trust tier + plugin manifest |
| Third-party Tool Schema 不兼容 | 高 | canonical schema + provider fixtures |
| RPC 性能下降 | 中 | 只隔离社区/高风险插件 |
| Tauri 与 DSH 双向耦合 | 高 | thin-shell rule |
| Safe Mode 误删除数据 | 高 | non-destructive recovery |
| Node 子进程 orphan | 高 | Job Object/process group |
| 大量日志导致 IO | 中 | ring buffer + level control |
| 构建链膨胀 | 中 | workspace cache / resource generation |
| Profile corruption | 高 | manifest + last-known-good + backup |

---

# 22. “完成改造”的最终验收标准

项目达到 v2 架构时，应满足：

### Architecture

- [ ] Tauri 不包含 Agent/Tool/Provider 业务。
- [ ] DSH Runtime 是唯一 Agent Runtime。
- [ ] Supervisor 无 GUI 依赖。
- [ ] Model Gateway 可脱离 Tauri 测试。
- [ ] Community plugin 可独立进程运行。

### Reliability

- [ ] DSH crash 不导致 Tauri crash。
- [ ] Plugin crash 不导致 DSH 整体退出。
- [ ] 三次 restart 失败后进入 recovery。
- [ ] Safe Mode 可启动最小 profile。
- [ ] 无 orphan child process。

### Tool Calling

- [ ] Gemini Schema 有独立测试集。
- [ ] OpenAI-compatible 有独立测试集。
- [ ] DeepSeek 有独立测试集。
- [ ] Anthropic 有独立测试集。
- [ ] 每个 provider 都有 malformed-schema negative tests。

### Performance

- [ ] 有 cold-start baseline。
- [ ] 有 memory baseline。
- [ ] 有 24h soak test。
- [ ] plugin crash recovery 时间可测。
- [ ] supervisor IPC p95 可测。

### Upgrade

- [ ] DSH runtime 可以独立升级。
- [ ] Desktop 可以独立升级。
- [ ] Profile 不被覆盖。
- [ ] Plugin manifest 可迁移。
- [ ] Upstream upgrade 有 compatibility report。

---

# 23. 优先级建议

如果资源有限，只做下面四件事，收益最大：

```text
1. Supervisor 固化
2. Thin Shell
3. Plugin process isolation
4. Canonical Tool Schema / Model Gateway
```

不要首先投入：

```text
- 大规模 UI 重写
- 复杂 Mobile 功能
- 重型插件市场
- 壳层自建 Agent Runtime
- 将所有插件统一 RPC 化
```

---

# 24. 与当前项目的迁移策略

本次重构不建议“大爆炸重写”。

采用 Strangler Fig / Incremental Refactor：

```text
Current dsh-host
      ↓
Extract contracts
      ↓
Extract supervisor
      ↓
Move recovery
      ↓
Thin Tauri
      ↓
Introduce plugin tiers
      ↓
Refactor model gateway
      ↓
Delete obsolete paths
```

任何时候都保持：

```text
Old path available
        │
        ▼
New path verified
        │
        ▼
Feature flag
        │
        ▼
Old path removed
```

不要一次性替换整个 Harness lifecycle。

---

# 25. 最终架构原则

> **Desktop 管“应用怎么活”。**
>
> **Supervisor 管“DSH 进程怎么活”。**
>
> **DSH 管“Agent 怎么工作”。**
>
> **Plugin Host 管“第三方代码怎么隔离”。**
>
> **Model Gateway 管“不同模型怎么理解 Tool”。**
>
> **Profile 管“用户状态怎么安全迁移”。**

这是整个改造最重要的边界。

只要未来新增功能能够回答“它属于哪一层”，并且不跨层直接耦合，项目就不会再次演化成“Desktop + 第二套 DSH Runtime”。

---

# Appendix A — 推荐下一步任务拆分

## Sprint 1

```text
[ ] Characterization tests
[ ] startup benchmark
[ ] memory benchmark
[ ] process tree test
[ ] current plugin failure fixtures
[ ] current provider schema fixtures
```

## Sprint 2

```text
[ ] dsh-contracts
[ ] error taxonomy
[ ] lifecycle state machine
[ ] IPC envelope
[ ] diagnostics schema
```

## Sprint 3

```text
[ ] supervisor extraction
[ ] readiness redesign
[ ] health monitor
[ ] restart controller
[ ] ring buffer
```

## Sprint 4

```text
[ ] thin Tauri shell
[ ] minimal IPC
[ ] WebView direct DSH loading
[ ] Safe Mode UI decoupling
```

## Sprint 5

```text
[ ] plugin manifest
[ ] trust tier
[ ] process host
[ ] JSON-RPC
[ ] plugin crash recovery
```

## Sprint 6

```text
[ ] canonical tool schema
[ ] Gemini adapter
[ ] OpenAI adapter
[ ] DeepSeek adapter
[ ] Claude adapter
[ ] regression suite
```

## Sprint 7+

```text
[ ] recovery automation
[ ] performance tuning
[ ] 24h soak
[ ] release hardening
[ ] documentation/ADR completion
```

---

# Appendix B — 技术选型总表

| 能力 | 推荐实现 | 原因 |
|---|---|---|
| Desktop Shell | Tauri 2 + Rust | 轻量、原生能力强 |
| Web UI | Official DSH Web | 避免双前端 |
| Runtime | Bundled Node + DSH | 可控、可复现 |
| Supervisor | Rust | 适合 process lifecycle |
| IPC | Tauri command + structured events | 简洁 |
| DSH ↔ Web | HTTP/WebSocket loopback | 与 upstream 保持一致 |
| Plugin isolation | process first | 真正故障边界 |
| Plugin RPC | JSON-RPC/stdio | 简洁、可测试 |
| Model Gateway | 独立 Rust/TS component | 可复用、可测试 |
| Schema | Canonical internal model | 降低 provider coupling |
| Profile | versioned manifest | 易迁移、可恢复 |
| Recovery | non-destructive Safe Mode | 防止数据损坏 |
| Logging | structured JSON/events | 易诊断 |
| Benchmark | criterion + OS profiling + WebView DevTools | 覆盖 native/runtime/web |

---

# References

- `wang-yi-bit64/dsh-desktop` repository: https://github.com/wang-yi-bit64/dsh-desktop
- Current repository README / workspace layout / roadmap / security notes.
- Current `Cargo.toml` workspace and release profile.
- Current `scripts/prepare-harness.mjs` runtime assembly script.
- Tauri documentation: https://v2.tauri.app/
- Microsoft WebView2 process model: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model
