# ADR 索引 — dsh-desktop 架构决策记录

> 本目录把散落在 `AGENTS.md`「已修复，勿回归」小节、`docs/dev-plan-*.md` 决策点、
> 批次执行记录里的**已做决策**汇总为可检索的 ADR（Architecture Decision Record）。
> 一句话定位：**代码说明「现在是什么样」，ADR 说明「为什么不是别的样」。**

## 读法与格式

每份 ADR 一节不落地包含五段：**背景**（什么事件迫使做决定）、**决策**（含唯一产地/文件）、
**备选方案与取舍**（认真考虑过并被否决的选项——没有这一段的记录只是日志，不是决策）、
**后果**（好的一面与代价）、**守卫与证据**（哪条门禁钉住它，或为什么没有门禁）。

状态词（本库只用一个小子集，勿与 `AGENTS.md` §7.3 的能力状态词混用）：

| 状态 | 含义 |
|------|------|
| 已接受 | 决定已做出并在执行（含执行收尾中的） |
| 已被 ADR-NNN 取代 | 原决定被后续决定推翻，保留原文供追溯 |
| 已归档 | 连同它裁决的代码一起删除，见对应归档文档 |

## ADR 清单

### A — 架构与契约（001–007）

| # | 决策 | 状态 |
|---|------|------|
| [001](001-headless-core-invariant.md) | 核心库保持无头，判定标准是「能否在没有窗口系统的机器上测试」（INV-6） | 已接受 |
| [002](002-contracts-and-constants.md) | 契约与常量集中于 `dsh-contracts`：`CX-` 编号、错误码族号↔类别、RPC 类型唯一源 | 已接受 |
| [003](003-ipc-envelope-always-ok.md) | 统一 IPC 封套 `IpcEnvelope<T>`，命令外层 `Result` 恒为 `Ok`，大 `Err` 用 `Box` | 已接受 |
| [004](004-snapshot-phase-flatten.md) | `HarnessSnapshot.phase` 必须 `#[serde(flatten)]` 平铺 | 已接受 |
| [005](005-ipc-command-surface-admission.md) | IPC 命令面准入纪律：只保留有真实调用方的命令 | 已接受 |
| [006](006-shell-upstream-boundary.md) | 壳与上游边界：UI 归上游，注入只做壳→页单向（INV-2） | 已接受 |
| [007](007-claim-discipline.md) | 宣称纪律：状态词表、禁止伪造成功、禁止无声降级 | 已接受 |

### B — 进程与运行时（010–014）

| # | 决策 | 状态 |
|---|------|------|
| [010](010-orphan-process-protection.md) | 孤儿进程防护三平台策略（INV-3：JobObject / PDEATHSIG / 看门狗） | 已接受 |
| [011](011-parent-death-watchdog.md) | macOS 父死看门狗装在被替换后的入口上，定时器不许 `unref` | 已接受 |
| [012](012-entry-explicit-runcli.md) | 壳入口接住 import 返回值，显式调用 `runCli` | 已接受 |
| [013](013-directory-picker-host-seam.md) | 目录选择器走 Host seam，禁止为 remote origin 引入 renderer 全局桥 | 已接受 |
| [014](014-tray-close-to-hide.md) | 托盘关窗=隐藏到托盘，失败回退；`app.exit()` 不经 `CloseRequested` 故 `shutdown` 是必经点 | 已接受 |

### C — 构建与打包（020–028）

| # | 决策 | 状态 |
|---|------|------|
| [020](020-patch-package-apply-mode.md) | `patch-package` 必须「应用模式 + 相对 `--patch-dir`」+ 显式 `--error-on-fail` | 已接受 |
| [021](021-patch-recount-line-numbers.md) | 补丁移植后必须重算行号（±20 窗口判据） | 已接受 |
| [022](022-dual-upstream-channels.md) | 双上游通道 `next`/`alpha`，`dsh-targets.mjs` 唯一事实源 | 已被 ADR-048 取代 |
| [023](023-tauri-hooks-check-only.md) | `beforeBuildCommand` / `beforeDevCommand` 只校验（`--check`）不组装 | 已接受 |
| [024](024-prune-by-content-not-name.md) | 依赖树瘦身判据是「内容」（含运行时模块）不是目录名 | 已接受 |
| [025](025-prune-platform-variants.md) | 剪枝外来平台原生变体，判据有界（linuxdeploy 杀手） | 已接受 |
| [026](026-accept-libreoffice-size.md) | 接受上游 `optionalDependencies` 带入的 LibreOffice 体积 | 已接受 |
| [027](027-workflow-vars-via-env.md) | 工作流变量走 `env:`，不插进 `run:` 字符串 | 已接受 |
| [028](028-version-and-changelog-discipline.md) | 版本号唯一真源 `package.json`；CHANGELOG 与 Release 正文同源 | 已接受 |

### D — 门禁与 CI（030–033）

| # | 决策 | 状态 |
|---|------|------|
| [030](030-zero-daily-automation.md) | 日常提交零自动化；每日定时 + drift 补偿；发布前手动 dispatch | 已接受 |
| [031](031-falsifiable-and-eol-agnostic-guards.md) | 门禁必须可证伪，且不得依赖检出配置（CRLF 无关） | 已接受 |
| [032](032-shell-pages-runtime-smoke.md) | 壳内页面运行时冒烟（DOM 桩真跑真点，含封套解包检查） | 已接受 |
| [033](033-workflow-separation.md) | CI / Smoke / Release 三工作流分工，互不重复 | 已接受 |

### E — 产品与战略（040–048）

| # | 决策 | 状态 |
|---|------|------|
| [040](040-archive-plugin-isolation.md) | 插件分级隔离「冻结并归档」（批次 F） | 已归档 |
| [041](041-archive-model-gateway.md) | 多模型工具网关「冻结并归档」（批次 F） | 已归档 |
| [042](042-recovery-non-destructive-actions.md) | 恢复页只接非破坏性动作；插件卸载/禁用记为计划中 | 已接受 |
| [043](043-delete-safe-mode-page.md) | 删除 `safe-mode.html`（接上只会交出读空气的页面） | 已归档 |
| [044](044-explicitly-out-of-scope.md) | 明确不做清单：遥测、公网隧道、oRPC/tRPC、重写 UI…… | 已接受 |
| [045](045-cli-distributable-artifact.md) | CLI 可引用产物 Phase 1；产物不含 runtime，Phase 2 计划中 | 已接受 |
| [046](046-no-code-signing.md) | 不买 OS 层代码签名证书；保留免费的 minisign 更新链校验 | 已接受 |
| [047](047-zero-budget-roadmap-recast.md) | 零预算路线图重裁：从「发布产品」到「能力证明资产」 | 已接受 |
| [048](048-single-upstream-channel.md) | 收敂为单一上游通道 | 已接受，执行中 |

### F — 打包资源一致性（049–）

| # | 决策 | 状态 |
|---|------|------|
| [049](049-bundle-resources-derived-guard.md) | 打包资源清单由推导校验（E5/E5d），不靠四处手抄保持一致 | 已接受 |
| [050](050-guard-windows-vs-cleanup-budget.md) | 门禁的等待窗口必须与异步清理的预算对账（E6）；断言「预算内干净」而非单次采样 | 已接受 |

## 新增一条 ADR 的规则

1. 编号顺序递增，不回收、不复用（删错的 ADR 改状态为「已归档」而不是删文件）。
2. 文件名用 ASCII kebab-case（与本目录既有文件一致）；标题写在文件内，可中文。
3. **先有决策，再写 ADR**——顺序与 `AGENTS.md` §7.3「先代码，后登记」同构：
   为还没做的决定写 ADR 是预设立场，不是记录。
4. 每条 ADR 至少点名一个「唯一产地」文件或一条守卫；两者都没有的决策不该出现。
5. 与 `AGENTS.md` §7.2 对照表的分工：**§7.2 管能力状态**（已接线/未接线/……），
   **本目录管决策理由**。能力状态变化时记得回看对应 ADR 的「后果」段是否仍然成立。

## 相关文档

- `AGENTS.md` §4「已修复，勿回归」——多数 ADR 的长版本出处（事故经过写在那里）。
- `docs/dev-plan-disconnected-points.md` §4、`docs/dev-plan-0.2-hardening.md` §决策点——
  战略类 ADR 的裁决原文。
- `docs/archive/`——ADR-040/041/043 归档代码对应的设计文档。
- 完成线（ADR-047）：「每个重大决策都有 ADR、每层都有陌生人可跑的验证、复盘存在」——
  本目录的完备度按这条线自查。
