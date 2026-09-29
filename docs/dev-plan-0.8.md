# DSH Desktop 0.8 开发计划

## Runtime 对齐 · 架构收敛 · 发布可靠性 · 开发者体验

> 项目：`wang-yi-bit64/dsh-desktop`
> 计划版本：`0.8.0`
> 文档版本：v1.0
> 日期：2026-09-28
> 基础路线：Rust + Tauri 2 + 独立 DSH Runtime
> 核心原则：**不再扩大 Desktop 的业务边界，优先把现有架构做稳、把上游跟上、把发布做可靠。**

---

# 1. 本版本定位

DSH Desktop 0.8 不再以“大规模新增功能”为目标，而是进入：

> **Architecture Convergence（架构收敛）阶段**

当前仓库已经具备：

* Rust + Tauri 2 Desktop Shell
* 独立 DSH Harness Runtime
* `dsh-host`
* Supervisor / watchdog / restart / circuit breaker
* Safe Mode / Recovery
* 结构化 IPC
* Diagnostics / Log Viewer
* Mobile Bridge
* Updater
* Headless CLI
* 多平台构建与发布体系
* Runtime target / patch / vendored package 管理

这些能力已经形成比较清晰的 Shell / Host / Runtime 边界，因此 0.8 不应该重新进行一次“大重构”。

本版本真正需要解决的是：

```text
                 0.7.x
                   │
        ┌──────────┼──────────┐
        │          │          │
     功能增长    Runtime     发布体系
        │        漂移         │
        ▼          ▼          ▼
    功能偏厚     上游落后    维护成本高
                   │
                   ▼
              0.8 收敛
                   │
       ┌───────────┼───────────┐
       │           │           │
    Thin Shell  Stable Host  Reliable Release
       │           │           │
       └───────────┼───────────┘
                   ▼
              0.9 产品化
```

---

# 2. 当前基线

当前仓库版本为：

```text
dsh-desktop = 0.7.0-alpha.8
```

仓库已经把 Runtime Target 独立成 `scripts/dsh-targets.mjs`，目前：

```text
next
  upstream channel = next
  publish channel  = rc
  DSH              = 0.1.5-rc.3

alpha
  upstream channel = alpha
  publish channel  = alpha
  DSH              = 0.1.6-alpha.2
```

并且两个目标分别维护 patch / vendored package。

上游目前已经发布：

```text
0.1.7-alpha.1
0.1.7-alpha.2
0.1.7-rc.1
0.1.7-rc.2
```

当前最新发布版本为 `0.1.7-rc.2`。

但是 0.1.7-rc.2 在近期仍有多个社区报告，包括：

```text
Windows 数据目录重新初始化
读取时迁移问题
构建 SettingsProvider 导出错误
Desktop Host 启动问题
运行时异常
```

因此 0.8 的目标不是“追最新版本”，而是：

> **建立可验证的 DSH Compatibility Gate，然后再决定哪个版本进入默认发布线。**

---

# 3. 0.8 的核心目标

## P0：Runtime Compatibility

目标：

```text
DSH Desktop
      │
      ▼
Compatibility Matrix
      │
      ├── DSH Version
      ├── Node Version
      ├── Patch Set
      ├── Plugin API
      └── Profile Migration
```

最终实现：

```text
Desktop Version
        ↓
Runtime Manifest
        ↓
Compatibility Check
        ↓
Start / Block / Recovery
```

不允许：

```text
Desktop 0.8
    ↓
偷偷运行旧 Runtime
```

也不允许：

```text
Desktop rc
    ↓
Runtime channel 失配
```

---

# 4. P0-1：建立 Runtime Compatibility Matrix

新增：

```text
docs/runtime-compatibility.md
```

建立正式矩阵：

| Desktop | DSH           | Node | Channel | Patch    | Status    |
| ------- | ------------- | ---- | ------- | -------- | --------- |
| 0.8.x   | 0.1.5-rc.3    | 24.x | next    | current  | legacy    |
| 0.8.x   | 0.1.6-alpha.2 | 24.x | alpha   | current  | legacy    |
| 0.8.x   | 0.1.7-rc.2    | 24.x | next    | migrated | candidate |

增加状态：

```text
candidate
tested
supported
blocked
legacy
unsupported
```

### 验收条件

必须能自动回答：

```text
当前 Desktop 是哪个 Runtime？
Runtime 来自哪个 channel？
Patch 是哪一套？
Node 是哪个版本？
这个 profile 是否兼容？
```

---

# 5. P0-2：DSH 0.1.7 升级专项

建立独立分支：

```text
upgrade/dsh-0.1.7
```

不要直接修改：

```text
main
```

先完成：

```text
prepare
 ↓
lock
 ↓
patch migration
 ↓
tree verify
 ↓
build
 ↓
smoke
```

### 升级顺序

```text
0.1.5-rc.3
       ↓
0.1.6-alpha.2
       ↓
0.1.7-rc.2
```

每一步都保存：

```text
lockfile
package tree
patch result
runtime manifest
smoke result
```

### 重点验证

```text
启动
停止
重启
工具调用
MCP
Plugin
Provider
Session
Profile
Update
Safe Mode
Diagnostics
```

### 特别增加

```text
profile migration test
```

验证：

```text
旧 profile
   ↓
新 Runtime
   ↓
启动
   ↓
配置保留
   ↓
Session 保留
```

任何数据迁移风险都不得进入默认 release。

---

# 6. P0-3：建立 Runtime Upgrade Gate

新增：

```text
scripts/verify-runtime-upgrade.mjs
```

执行：

```bash
npm run verify:runtime-upgrade
```

至少检查：

```text
[ ] version
[ ] channel
[ ] node
[ ] lockfile
[ ] dependency closure
[ ] patch applicability
[ ] vendored packages
[ ] native modules
[ ] profile migration
[ ] startup
[ ] tool calling
[ ] MCP
[ ] plugin
[ ] update
```

输出：

```text
Runtime Upgrade Report

DSH:
  expected: 0.1.7-rc.2
  actual:   0.1.7-rc.2

Patch:
  functional:  PASS
  ui:          PASS
  brand:       PASS

Smoke:
  startup:     PASS
  tools:       PASS
  mcp:         PASS
  plugin:      PASS

Profile:
  migration:   PASS

Release:
  BLOCKED / READY
```

---

# 7. P1：Patch 系统收敛

当前仓库明确存在 patch-package 行级补丁机制，而且官方文档已经指出它对上游小改动非常敏感。

0.8 的目标不是马上彻底删除 patch-package，而是：

> **减少 Patch Surface。**

---

## P1-1：统计 Patch Surface

新增：

```text
scripts/report-patch-surface.mjs
```

输出：

```text
Patch Surface Report

functional:
  files: 5
  hunks: 11

ui:
  files: 3
  hunks: 5

brand:
  files: 2
  hunks: 3
```

同时统计：

```text
patch count
hunk count
affected packages
affected LOC
stale patches
```

---

## P1-2：Patch 分级

继续保留：

```text
functional
ui-behavior
brand
```

但新增：

```text
runtime-hook
upstream-feature
```

原则：

```text
能通过 Desktop Host 解决
→ 不打 DSH patch

能通过官方插件机制解决
→ 不打 DSH core patch

能通过 startup hook 解决
→ 不使用 patch-package

只有无法外部解决的
→ 才保留 patch
```

---

# 8. P1：Runtime Packaging 优化

现有方案已经明确指出：

```text
node_modules
数万个文件
300MB+
大量碎文件
```

是构建时间和分发体积的重要来源。

0.8 不建议直接跳到 Node SEA。

先做：

```text
Runtime Packaging 1.0
```

---

## Phase A：依赖裁剪

确认：

```text
development-only
test-only
docs
source maps
unnecessary declarations
unused platform binaries
```

是否可以安全移除。

新增：

```text
scripts/report-runtime-size.mjs
```

输出：

```text
Runtime Size

Raw node_modules      312 MB
Pruned runtime        241 MB
Node binary            68 MB
Assets                 14 MB
Total                  323 MB
```

---

## Phase B：Runtime Assembly Cache

建立：

```text
.harness-cache/
```

以：

```text
DSH version
Node version
platform
architecture
patch fingerprint
lockfile hash
```

作为 cache key。

目标：

```text
第一次 build
→ 完整 Assembly

第二次 build
→ 命中 cache
```

避免每次：

```text
npm install
copy
patch
prune
```

重新执行。

---

## Phase C：Bundle 实验

`esbuild` bundle / Node SEA 可以作为 0.8 的实验性 track，但不能阻塞主线。现有文档已经提出 bundle → runtime loader → Node SEA 的渐进路线。

建立：

```text
perf/runtime-bundle
```

只做：

```text
benchmark
compatibility
startup
memory
native module
```

不直接切主生产路径。

---

# 9. P1：Thin Shell 继续收敛

Tauri 必须保持：

```text
Desktop capability
```

而不是：

```text
DSH Agent capability
```

Tauri 只负责：

```text
Window
Tray
Update
IPC
System integration
Diagnostics
Recovery
Mobile Bridge
```

不负责：

```text
Agent
Tool execution
Model routing
Session state machine
MCP logic
Provider schema adaptation
```

这是 0.8 最重要的边界规则之一。

---

# 10. P1：冻结 Desktop IPC Surface

当前项目已经把全部 Tauri command 统一到了：

```text
IpcEnvelope<T>
```

并有 IPC surface verification。

0.8 不再随意增加 IPC command。

原则：

```text
现有 command 能复用
    ↓
不增加 command

已有 command 只是 payload 不够
    ↓
扩展 contract

只有真正的系统能力
    ↓
新增 IPC
```

建立：

```text
docs/ipc-contract.md
```

记录：

```text
command
request
response
error codes
owner
security boundary
```

---

# 11. P1：Supervisor 2.0

`dsh-host` 应成为整个项目真正的核心基础设施。

保持：

```text
spawn
ready
heartbeat
health
restart
circuit breaker
orphan cleanup
logs
diagnostics
```

新增：

```text
RuntimeIdentity
RestartReason
FailureBudget
StartupPhase
HealthSnapshot
```

统一状态机：

```text
Created
   ↓
Starting
   ↓
WaitingReady
   ↓
Ready
   ↓
Healthy
   ↓
Degraded
   ↓
Restarting
   ↓
Failed
```

禁止：

```text
Tauri 自己判断一次
Supervisor 自己判断一次
Harness 自己判断一次
```

整个项目必须只有一个 Host lifecycle authority。

---

# 12. P1：恢复机制 2.0

当前 Recovery 已经可以识别插件故障并进入 Safe Mode；但 0.8 应进一步统一故障模型。

新增：

```text
BOOT_TIMEOUT
PORT_CONFLICT
RUNTIME_EXIT
PLUGIN_LOAD_ERROR
DUPLICATE_TOOL
MISSING_SERVICE
PROFILE_CORRUPTION
PROVIDER_ERROR
UPDATE_FAILURE
UNKNOWN
```

然后建立：

```text
Fault
  ↓
Classification
  ↓
Recommended Action
```

例如：

```text
PORT_CONFLICT
    → retry with another port

PLUGIN_LOAD_ERROR
    → safe mode

PROFILE_CORRUPTION
    → isolated profile

RUNTIME_EXIT
    → restart

UPDATE_FAILURE
    → rollback
```

注意：

> 0.8 只做“诊断 + 非破坏性恢复”，不做未经充分验证的插件删除/卸载。

当前仓库已经明确放弃了一个没有真实可逆路径的 plugin uninstall 方案。

---

# 13. P2：第三方模型 / Tool Calling

本版本原则：

> **不要重新把 Model Gateway 做回 Desktop。**

此前的 `dsh-model-gateway` 已经被正式归档，因为它没有实际 Runtime Consumer。

因此 0.8 的目标是：

```text
Desktop
   │
   └── observe / diagnose
             │
             ▼
         DSH Runtime
             │
             ▼
       Provider Layer
```

Desktop 不负责：

```text
OpenAI schema
Gemini schema
Claude schema
Tool dialect conversion
Tool execution
```

但是需要增强：

```text
Provider Error Attribution
```

至少能诊断：

```text
provider
model
tool
schema path
request id
runtime version
```

对于出现：

```text
Cannot read properties of undefined
(reading 'prepare')
```

这类错误，应能够在 Diagnostics 中区分：

```text
Desktop error
Host error
DSH Runtime error
Plugin error
Provider error
```

而不是全部归类为：

```text
Desktop failed
```

---

# 14. P2：Plugin 能力

0.8 不重新实现之前已经删除的“假隔离”。

当前真实有效的是：

```text
In-process plugin fault attribution
```

而不是：

```text
Process sandbox
```

仓库已经明确删除没有真正接入 Harness plugin mount path 的 isolation implementation。

因此：

### 0.8

完成：

```text
Plugin identity
Plugin fault attribution
Plugin startup failure
Plugin recovery
Plugin Safe Mode
```

### 0.9 以后再考虑

```text
真正 process-level plugin isolation
```

前提是：

```text
能够接入真实 Harness plugin loader
```

否则不做。

---

# 15. P2：发布通道重构

继续保持两条线：

```text
next
alpha
```

不增加：

```text
beta
nightly
canary
dev
```

当前仓库把 upstream `channel` 和 Desktop `publishChannel` 分开，这个设计继续保留。

目标：

```text
upstream channel
        ≠
desktop publish suffix
```

例如：

```text
upstream next
        ↓
desktop rc

upstream alpha
        ↓
desktop alpha
```

---

# 16. P2：建立“可发布”而不是“最新”策略

Release 不再判断：

```text
最新版本？
```

而判断：

```text
Compatibility PASS？
Smoke PASS？
Migration PASS？
Patch PASS？
Packaging PASS？
```

最终：

```text
READY_TO_RELEASE
```

必须满足：

```text
Runtime compatibility      PASS
Dependency closure         PASS
Patch applicability        PASS
Harness startup            PASS
Tool calling               PASS
MCP                        PASS
Plugin                     PASS
Profile migration          PASS
Updater                    PASS
Diagnostics                PASS
Windows                    PASS
Linux                      PASS
macOS                      PASS
```

---

# 17. P2：Upstream Drift 由 Warning 升级为 Gate

当前已有：

```text
verify:drift
```

0.8 对其分级：

```text
差 0 patch
    → PASS

差 1 patch
    → INFO

差 1 minor
    → WARNING

差 ≥2 minor
    → RELEASE BLOCKED
```

例：

```text
Desktop:
0.1.5

Upstream:
0.1.7

结果:
BLOCKED
```

除非明确填写：

```text
DRIFT_OVERRIDE_REASON
```

并由 release workflow 保存记录。

---

# 18. P2：CI 重新分层

CI 不追求每次 PR 都完整跑三平台重型测试。

分为三层。

## L0：Pull Request

运行：

```text
cargo test
cargo check
npm scripts self-test
lint
typecheck
verify contracts
verify IPC
verify patches
verify targets
```

目标：

```text
< 10 min
```

---

## L1：main / daily

运行：

```text
Windows
Linux
macOS
```

验证：

```text
prepare harness
build
launch
probe
stop
restart
orphan cleanup
```

---

## L2：release

完整运行：

```text
package
install
startup
update
migration
tool
MCP
plugin
safe mode
diagnostics
```

只有 L2 全部通过才允许发布。

---

# 19. P2：性能基线

不要再用：

```text
“应该更快”
```

作为性能描述。

建立：

```text
docs/performance-baseline.md
```

记录：

```text
cold start
warm start
runtime assembly
memory idle
memory under load
IPC latency
restart latency
installer size
runtime size
```

建议初始基线：

```text
Cold Start
P50 / P95

Memory
Idle / Active / Recovery

Runtime Assembly
Cache Hit / Miss

Restart
P50 / P95
```

0.8 不强制追求极限优化。

重点是：

> **先测量，再优化。**

---

# 20. P3：Developer Experience

0.8 需要让新开发者能够在最短路径内理解项目。

README 只保留：

```text
What
Why
Architecture
Quick Start
Build
Release
Diagnostics
```

新增：

```text
docs/
 ├── architecture.md
 ├── runtime-compatibility.md
 ├── development.md
 ├── release.md
 ├── diagnostics.md
 └── adr/
```

历史方案移动：

```text
docs/archive/
```

当前计划、旧设计和已删除功能不要再作为主路径文档。

---

# 21. 建议删除 / 冻结的内容

0.8 明确：

```text
冻结：
- 第二套 Agent Runtime
- Desktop Model Gateway
- 未接入真实 loader 的 Plugin Sandbox
- 新增 release channel
- 大规模 Frontend 重写
- Desktop 自己实现 Tool Calling
```

只允许出现新的功能，当它属于：

```text
Desktop capability
Host capability
Reliability
Compatibility
Diagnostics
Cross-platform
```

---

# 22. 建议新增的核心脚本

最终 scripts 目录至少具备：

```text
prepare-harness.mjs

verify-runtime-upgrade.mjs
verify-upstream-drift.mjs
verify-harness-tree.mjs
verify-patch-layers.mjs
verify-ipc-surface.mjs
verify-release-workflow.mjs
verify-release-assets.mjs

report-patch-surface.mjs
report-runtime-size.mjs
report-performance.mjs

smoke-launch.mjs
fault-inject.mjs
```

其中：

```text
verify*
```

解决正确性。

```text
report*
```

解决可观测性。

```text
smoke*
```

解决运行可靠性。

---

# 23. Git 分支策略

建议从 0.8 开始控制分支数量。

```text
main
 │
 ├── upgrade/dsh-0.1.7
 ├── refactor/runtime-compatibility
 ├── refactor/patch-surface
 ├── refactor/supervisor-v2
 ├── perf/runtime-packaging
 └── chore/release-gates
```

不建议：

```text
feature/plugin-v3
feature/model-gateway-v3
feature/desktop-agent-v2
```

这种与主产品边界冲突的长期分支。

---

# 24. Commit Strategy

推荐使用：

```text
refactor(runtime): add compatibility manifest

feat(runtime): support dsh 0.1.7-rc.2

test(runtime): add profile migration fixtures

refactor(patch): remove obsolete dsh-core patches

perf(runtime): add assembly cache

refactor(supervisor): unify lifecycle authority

fix(recovery): classify duplicate-tool failure

feat(diagnostics): add runtime identity report

ci(release): gate publication on compatibility checks
```

一个 commit 尽量只有一个职责。

---

# 25. 开发阶段安排

## Phase 0：冻结基线

### 目标

把当前 0.7.x 变成可回滚基线。

### 工作

```text
[ ] tag 0.7.x baseline
[ ] 保存 runtime manifest
[ ] 保存 lockfile
[ ] 保存三平台 smoke
[ ] 保存 installer
[ ] 保存 diagnostics fixture
```

### 输出

```text
0.7.x Known Good Baseline
```

---

# Phase 1：Runtime Compatibility

### 目标

完成：

```text
0.1.7-rc.2 compatibility branch
```

### 工作

```text
[ ] target table
[ ] lockfile
[ ] dependency closure
[ ] patch migration
[ ] vendor migration
[ ] profile migration
[ ] startup test
[ ] tools test
[ ] MCP test
[ ] plugin test
```

### 输出

```text
DSH 0.1.7 Compatibility Candidate
```

---

# Phase 2：Patch & Packaging

### 目标

降低升级成本。

### 工作

```text
[ ] patch surface report
[ ] obsolete patches cleanup
[ ] runtime cache
[ ] dependency prune
[ ] runtime size report
[ ] bundle experiment
```

### 输出

```text
Repeatable Runtime Assembly
```

---

# Phase 3：Host / Recovery

### 目标

把 `dsh-host` 固化成核心基础设施。

### 工作

```text
[ ] unified lifecycle
[ ] failure classification
[ ] health snapshot
[ ] restart reason
[ ] diagnostics identity
[ ] profile recovery
```

### 输出

```text
dsh-host 2.0
```

---

# Phase 4：Release Hardening

### 目标

实现真正自动化 Release Gate。

### 工作

```text
[ ] PR gate
[ ] nightly smoke
[ ] cross-platform smoke
[ ] runtime compatibility gate
[ ] profile migration gate
[ ] updater gate
[ ] package verification
```

### 输出

```text
Release Candidate
```

---

# Phase 5：0.8 RC

### RC 条件

必须：

```text
Runtime compatibility PASS

No unresolved P0

No unresolved data-loss P1

Windows PASS
Linux PASS
macOS PASS

Cold Start benchmark recorded

Memory benchmark recorded

Diagnostics export PASS

Updater PASS

Rollback PASS
```

---

# 26. 0.8 的最终 Definition of Done

只有以下全部满足，才认为 0.8 完成：

## Runtime

```text
[✓] DSH version explicitly declared
[✓] Channel explicitly declared
[✓] Node version explicitly declared
[✓] Lockfile reproducible
[✓] Patch set reproducible
[✓] Runtime manifest generated
```

## Host

```text
[✓] one lifecycle authority
[✓] startup timeout
[✓] heartbeat
[✓] restart
[✓] circuit breaker
[✓] orphan cleanup
```

## Recovery

```text
[✓] boot failure classified
[✓] plugin failure classified
[✓] profile failure classified
[✓] safe mode works
[✓] diagnostics works
```

## Desktop

```text
[✓] Thin Shell
[✓] IPC contract stable
[✓] Tray stable
[✓] Update stable
[✓] Mobile Bridge stable
```

## Packaging

```text
[✓] repeatable assembly
[✓] cache
[✓] dependency pruning
[✓] package verification
```

## Release

```text
[✓] compatibility gate
[✓] smoke gate
[✓] migration gate
[✓] updater gate
[✓] Windows
[✓] Linux
[✓] macOS
```

---

# 27. 0.8 不做什么

为了防止项目重新膨胀，本版本明确排除：

```text
❌ 自研 Agent Runtime
❌ 自研 Conversation UI
❌ 自研 Tool execution engine
❌ 自研 Provider abstraction
❌ 强制 Plugin Sandbox
❌ 新增第三条发布线
❌ 大规模 UI 重写
❌ 重写 Tauri IPC
❌ 追求 Node SEA 生产化
❌ 为了追新版本而跳过兼容性验证
```

---

# 28. 0.8 → 0.9 的演进方向

0.8 完成后，项目进入真正的产品化阶段：

```text
0.8
│
├── Runtime compatibility
├── Host stability
├── Release reliability
└── Diagnostics
        │
        ▼
0.9
│
├── Linux / macOS / Windows polish
├── Runtime packaging 2.0
├── Better provider diagnostics
├── Profile migration UX
├── Plugin ecosystem
└── Developer tooling
```

而不是继续：

```text
0.8
 ↓
更多 abstraction
 ↓
更多 crate
 ↓
更多 gateway
 ↓
更多 channel
```

---

# 29. 本版本最重要的工程原则

整个 0.8 只需要记住下面六条：

```text
1. DSH 是唯一 Agent Runtime

2. dsh-host 是唯一 Runtime lifecycle authority

3. Tauri 只做 Desktop capability

4. 能不用 patch 就不用 patch

5. 能不增加新 IPC 就不增加新 IPC

6. Release 的标准不是“最新”，而是“经过验证”
```

最终架构收敛为：

```text
                 DSH Desktop
                      │
           ┌──────────┴──────────┐
           │                     │
       Tauri Shell           dsh-host
           │                     │
     Window / Tray          Supervisor
     Update / IPC           Recovery
     Mobile / UI            Diagnostics
           │                     │
           └──────────┬──────────┘
                      │
                DSH Runtime
                      │
          ┌───────────┼───────────┐
          │           │           │
        Agent       Plugin       MCP
          │
          ▼
      Provider
```

这就是 0.8 的核心目标：

> **不让 dsh-desktop 变成第二个 DSH，而是把它做成一个可靠、可诊断、可升级、跨平台的 DSH Runtime Host。**
