# DSH Desktop 0.8 开发计划(v1.1)

## Runtime 对齐 · 架构收敛 · 发布可靠性 · 开发者体验

> 项目:`wang-yi-bit64/dsh-desktop`
> 计划版本:`0.8.0` · 文档版本:**v1.1**(2026-09-29;v1.0 原始草案存于
> [`docs/dev-plan-0.8.md`](dev-plan-0.8.md),2026-09-28)
> 基础路线:Rust + Tauri 2 + 独立 DSH Runtime
> 核心原则:**不再扩大 Desktop 的业务边界,优先把现有架构做稳、把上游跟上、把发布做可靠。**

> ⚠️ **版本号快照声明**:本文明写的所有 DSH 版本号是 **2026-09-29 核实的事实快照**。
> 本仓锚点的**唯一产地**是 `scripts/dsh-targets.mjs`(运行时动态解析),`verify:plan-facts`
> 不扫描本文件——锚点变更(§6 门禁放行)后,本文 §2 / §4 / §5 / §15 必须人工同步。
> 这条声明的理由见 `scripts/verify-plan-facts.mjs` 文档注释:文档里的版本号零守卫,
> 只能靠"快照声明 + 人工同步纪律"防漂。

**与其他计划文档的关系**:

- `docs/roadmap.md`(H0~H3)是定位权威;本计划是 0.8 周期的执行细化,不推翻定位。
- `docs/dev-plan-release-channels.md` 的批次账本(P0/1a/1b/2~6/R1~R3)**不受本计划影响**;
  本计划 §15 的双通道裁定是对通道**结构**的裁定(`dsh-targets.mjs` 目标表零改动)。
- `docs/dev-plan-cli-distribution.md`:CLI 发布通道维持退役(2026-09-24),本计划不恢复它;
  便携版(Windows zip)是已交付形态,发布门禁包含其核验(§16)。
- `docs/dsh-upgrade-checklist.md`:升级专项(§5)的**手工门禁**载体;本计划不替代它。
- `docs/adr/`:决策记录;本计划 §15 需要一条 superseding ADR(见修订 #9)。

---

# 0. v1.1 相对 v1.0 的修订

| # | 修订 | 依据 |
|---|------|------|
| 1 | **双通道定稿**:只跟踪 `next` + `alpha` 两个 target;上游三个 dist-tag(latest / alpha / next)不建第三目标 | 2026-09-29 维护者裁定 |
| 2 | **升级目标从 0.1.7-rc.2 改为 0.2.0 线;0.1.7 升级专项取消** | 0.2.0-rc.1(2026-09-28)接管 `next` dist-tag;rc.2 三条回归未修(§2) |
| 3 | 删除 v1.0 §5 的升级阶梯「0.1.5-rc.3 → 0.1.6-alpha.2 → 0.1.7-rc.2」 | 0.1.6-alpha.2 属 **alpha 线**,跨通道混爬在机制上不存在(补丁 / lockfile / vendored 均按通道目录隔离) |
| 4 | 门禁条件从「等上游 stable」改为**可观测条件** | 上游历史上从未发布 stable(§2)——"等 stable"不可满足 |
| 5 | profile migration fixtures 固化为上游真实翻车点:#7545 / #6358 / #7872 / #8166 | Discussions 实证报告(§2、§5) |
| 6 | `verify-runtime-upgrade` 定位为**既有门禁的编排器**,不重写 | 仓库已有 ~15 个 verify 脚本(§22);平行门禁必然漂移(本仓"手抄清单脱节"已有三例) |
| 7 | 社区报告全部补 discussion 编号 | 上游 issue 区**关闭**,Discussions 是唯一可复核载体 |
| 8 | Supervisor 2.0 / Recovery 2.0 增加跨语言契约与错误码族约束 | `HarnessSnapshot.phase` 兼容性(§11);`E1xxx~E7xxx` 族号体系(§12) |
| 9 | ✅ **已收尾(2026-09-30)**:ADR-048 已由 **ADR-052** 取代,双通道恢复在役 | 维护者 2026-09-30 裁定;见 `docs/adr/052-dual-upstream-channels-restored.md` |

---

# 1. 本版本定位

0.8 不以"大规模新增功能"为目标,进入 **Architecture Convergence(架构收敛)**阶段。

仓库已具备(均为已接线能力,证据见 `AGENTS.md` §7.2):Shell / Host / Runtime 三层边界、
Supervisor 监督、Safe Mode / Recovery、统一 IPC 封套、脱敏诊断导出、应用内日志查看器、
Mobile Bridge、Updater、无头 CLI(仓内工具,非发布产物)、多平台构建与发布体系、
runtime target / patch / vendored 管理、提交式 lockfile(`npm ci` 零解析组装)。

0.8 真正要解决的三件事:

1. **功能收敛**:Tauri 壳保持 Desktop capability,不向 Agent 能力漂移。
2. **Runtime 漂移**:上游 0.2.0 已就绪,本仓补丁面对 0.1.7 已全面失配(§2 预检)——
   需要一次有门禁的升级,顺带把补丁面削薄。
3. **发布体系**:从"追最新"转为"经过验证才发布"。

---

# 2. 当前基线(2026-09-29 核实)

桌面:`0.7.0-alpha.8`;内置 Node:**v24.9.0**。

通道锚点(唯一产地 `scripts/dsh-targets.mjs`):

| target | channel(上游 dist-tag,不可改) | publishChannel(桌面后缀,本仓命名) | dshVersion(锚点) |
|---|---|---|---|
| `next`(默认) | `next` | `rc` | `0.1.5-rc.3` |
| `alpha` | `alpha` | `alpha` | `0.1.6-alpha.2` |

上游(DeepSeek Harness,`deepseek-ai/deepseek-harness`):

- dist-tags:**latest = 0.1.7-rc.2 / alpha = 0.1.7-alpha.2 / next = 0.2.0-rc.1**(三线互不相同)。
- **0.2.0-rc.1 于 2026-09-28 发布**,接管 `next`;0.1.7 线停在 rc.2(2026-09-24 发布),
  无 rc.3、无 stable。
- **上游从未发布任何 stable**:0.1.2→rc.1、0.1.3→alpha.2、0.1.5→rc.3(维护 backport)、
  0.1.6→alpha.2、0.1.7→rc.2——每条线都以"被下一线取代"收尾。
- **issue 区关闭**;社区报告在 Discussions;上游 nightly 版本戳形如 `0.1.7-rc.1.20260924.1`。

**0.1.7-rc.2 已知回归**(截至 2026-09-29 未修复;0.2.0-rc.1 的 Release 说明无对应修复项):

| Discussion | 内容 |
|---|---|
| [#7903](https://github.com/deepseek-ai/deepseek-harness/discussions/7903) | rc.2 回归:`dsh-app-boot` 重写的 `ResolutionRouter` 破坏 CJS `punycode/` 解析,jsdom 系插件全部加载失败 |
| [#7828](https://github.com/deepseek-ai/deepseek-harness/discussions/7828) | rc.2 回归:Windows 更新后应用不显示窗口,进程挂后台 |
| [#7908](https://github.com/deepseek-ai/deepseek-harness/discussions/7908) / [#7587](https://github.com/deepseek-ai/deepseek-harness/discussions/7587) | 构建报 `MISSING_EXPORT "SettingsProvider"`,build 直接失败 |

**0.2.0-rc.1 发布 24 小时内的报告**:

| Discussion | 内容 | 级别 |
|---|---|---|
| [#8166](https://github.com/deepseek-ai/deepseek-harness/discussions/8166) | 0.2.0 新增 peer gate 静默禁用 profile 基础层 storage 行 → **工作区/会话列表全空**(根因涉及 profile 传递依赖劫持包解析) | 🔴 数据丢失 |
| [#8140](https://github.com/deepseek-ai/deepseek-harness/discussions/8140) | 桌面端更新到 0.2.0-rc.1 后工作区被清(与 #8166 大概率同根因) | 🔴 数据丢失 |
| [#8183](https://github.com/deepseek-ai/deepseek-harness/discussions/8183) | guarded write/edit 静默覆盖暂存期间的外部保存 | 🔴 数据丢失 |
| [#8184](https://github.com/deepseek-ai/deepseek-harness/discussions/8184) | 暂存文件名超文件系统上限,合法长文件名被拒 | 中 |
| [#8158](https://github.com/deepseek-ai/deepseek-harness/discussions/8158) | Windows 沙箱化 PTY(minimal preset)启动失败:ACL runner 退出 127、std 句柄 NULL | 中 |
| [#8186](https://github.com/deepseek-ai/deepseek-harness/discussions/8186) / [#8173](https://github.com/deepseek-ai/deepseek-harness/discussions/8173) | rc.1 构建报错 / Windows 桌面打包失败(vswhere env 丢失大小写不敏感) | 中 |
| #8178 / #8124 / #8175 | 余额本地化格式混乱 / "打开位置"静默空转 / internet zone 疑问 | 低 |

**迁移相关实证报告**(0.1.6 / 0.1.7 早期,§5 fixture 素材):#7545(升级后自定义 agent presets
不再注册)、#6358(exFAT 等无硬链接文件系统迁移失败且就地改写不可回滚)、#7872(`dsh-session-reference`
codec 不兼容 → `session/list` 定义被网关撤回)、#7637(侧栏历史会话与工作区完全丢失)、
#7751(`failOnStartupError` 的 MCP 服务器启动失败不再阻止启动)。

**本仓补丁适用性预检**(2026-09-28,`npm run check:patch-applicability`;脚本不落盘结果,数据记录于此):

| 通道 | 补丁基线 | 对照目标 | 结果 |
|---|---|---|---|
| next(14 个补丁) | 0.1.5-rc.3 | 0.1.7-rc.2 | 2 clean / **12 conflict**;两个 functional 层补丁(`dsh`、`dsh-client-modules`)全挂 |
| alpha(13 个补丁) | 0.1.6-alpha.2 | 0.1.7-alpha.2 | 4 clean / **9 conflict**;两个 functional 同样全挂 |

漂移量级:ui-workspace 单文件最大 ~1356 行、chat ~800 行、settings-models 34 段中 17 段
**内容失配**——是内容重写,不是行号漂移(relocate/recount 救不了)。functional 层失败会
直接阻断组装:**升级 = 全量补丁重做**。

因此 0.8 的目标不是"追最新版本":

> **建立可验证的 DSH Compatibility Gate,再决定哪个版本进入默认发布线。**

---

# 3. 0.8 的核心目标(P0:Runtime Compatibility)

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

最终实现:

```text
Desktop Version → Runtime Manifest → Compatibility Check → Start / Block / Recovery
```

不允许:

- Desktop 0.8 偷偷运行旧 Runtime;
- Desktop rc 后缀与 Runtime channel 失配。

---

# 4. P0-1:Runtime Compatibility Matrix

新增 `docs/runtime-compatibility.md`。矩阵(v1.1 定稿):

| Desktop | DSH | Node | Channel | Patch | Status |
| ------- | --- | ---- | ------- | ----- | ------ |
| 0.8.x | 0.1.5-rc.3 | 24.x | next | current | legacy(现役发布线) |
| 0.8.x | 0.1.6-alpha.2 | 24.x | alpha | current | legacy(现役发布线) |
| 0.8.x | 0.2.0-rc.x | 24.x | next | migrated | candidate(受 §6 门禁约束) |

> v1.0 的「0.1.7-rc.2 | next | migrated | candidate」行**取消**(状态:`superseded`):
> 该线已被 0.2.0 取代,且三条回归未修——为它做全量补丁移植是沉没成本。

状态词表:`candidate / tested / supported / blocked / legacy / superseded / unsupported`。

验收条件:能**自动**回答五个问题——

1. 当前 Desktop 是哪个 Runtime?
2. Runtime 来自哪个 channel?
3. Patch 是哪一套?
4. Node 是哪个版本?
5. 这个 profile 是否兼容?

---

# 5. P0-2:DSH 0.2.0 升级专项

独立分支 `upgrade/dsh-0.2.0`(v1.0 的 `upgrade/dsh-0.1.7` 取消),不动 `main`。

**v1.1 删除版本阶梯。** 升级按通道各自进行,不存在跨通道爬梯:

- **next 线**:0.1.5-rc.3 → 0.2.0-rc.x(唯一活跃升级路径);
- **alpha 线**:0.1.6-alpha.2 保持不动,待上游 `alpha` dist-tag 前移至 0.2.0-alpha.x 后另行评估。

每一步都保存:lockfile / package tree / patch result / runtime manifest / smoke result。

重点验证:启动、停止、重启、工具调用、MCP、Plugin、Provider、Session、Profile、Update、
Safe Mode、Diagnostics。
其中**工具调用 / MCP / Plugin 需要真实账号与真实运行时,不做 CI 自动化**,按
`docs/dsh-upgrade-checklist.md` 作为升级专项的手工门禁(与 §16 同口径)。

**profile migration test**(v1.1 固化 fixture,全部来自上游真实翻车点):

| fixture | 断言 | 来源 |
| --- | --- | --- |
| 旧 profile → 新 runtime 启动 | 自定义 agent presets 仍注册 | #7545 |
| 会话日志迁移 | exFAT 等无硬链接文件系统不就地改写、可回滚 | #6358 |
| session codec 兼容 | `session/list` 定义不被网关撤回 | #7872 |
| **peer gate × 冻结树** | 用本仓 lockfile 组装后,fixture profile 的工作区/会话列表**非空** | #8166 |

> #8166 对本仓是**显式风险项**,理由:0.2.0 的 peer gate 按 profile 的传递依赖做包解析,
> 并可能**静默**禁用 storage 层;而本仓的 `npm ci` 冻结树(顶层/嵌套 hoisting、家族钉死)
> 正是它的输入形态——本仓 2026-09-23 就在 peer/hoisting 上踩过"单例包两份拷贝 → 启动即崩"
> (见 AGENTS.md「依赖解析的堆爆炸」一节)。这条必须做成显式检查,不能等 smoke 红了再查。

任何数据迁移风险都不得进入默认 release。(v1.0 保留)

---

# 6. P0-3:Runtime Upgrade Gate

新增 `scripts/verify-runtime-upgrade.mjs`(`npm run verify:runtime-upgrade`)。

**v1.1 定位:编排器,不重写。** 以下检查**已存在**,直接调用既有出口:

| 检查项 | 既有出口 |
| --- | --- |
| version | `verify:version` |
| lockfile / inputs 一致性 + 依赖闭包 | `verify:harness-lockfile` |
| patch applicability | `check:patch-applicability` |
| native modules / 平台变体 | `verify:variants` |
| 上游漂移 | `verify:drift` |
| 资源树 / 组装清单 / 入口契约 | `verify:harness-tree` / `verify:harness-entry` |
| 发布资产 / 便携版 | `verify:release-assets`(13 项)/ `verify:portable-package` |
| 补丁分级登记 | `verify:patches` / `verify:patch-layers` |

真正新增的只有三件:profile migration fixtures(§5)、peer-gate×冻结树检查(§5)、
以及启动后功能冒烟的编排。

输出 Runtime Upgrade Report(v1.0 形状保留):

```text
DSH:     expected / actual
Patch:   functional PASS · ui PASS · brand PASS
Smoke:   startup PASS · tools PASS · mcp PASS · plugin PASS
Profile: migration PASS
Release: BLOCKED / READY
```

**切线触发条件(v1.1,替代"等上游 stable")**——全部满足,才允许把 `next` 锚点切到 0.2.0:

1. 0.2.0 线最新号发布 **≥ 7~14 天**,且期间无新增数据丢失类报告;
2. #8166 / #8140 / #8183 与 #7903 / #7828 / #7908 关闭,或确认不影响本仓组装路径;
3. `check:patch-applicability` 通过,`harness-locks/next` 按 `dsh-upgrade-checklist.md`
   Step 1 重新生成(inputs.json + package-lock.json 成对提交);
4. migration fixtures 全绿。

锚点切换是**一次原子提交**:`dsh-targets.mjs` 的 `dshVersion` + 重新生成的 lockfile +
重算/重制的补丁,同一批进去,`verify:plan-facts` 会强制同步四处声明点(README ×2 /
AGENTS / LAYERS / upgrade-checklist)。

---

# 7. P1:Patch 系统收敛

现状依据(§2 预检):升级到 0.2.0 需要近乎全量重做补丁。
**v1.1 修订:P1-2 的削减原则在移植时逐补丁执行,而不是移植完再补课**——12/14 的冲突率
正是把"能外部解决就不打补丁"落成机制的唯一窗口。

## P1-1:统计 Patch Surface

新增 `scripts/report-patch-surface.mjs`。**扩展现有 `report:patches`**(补丁健康度报告),
不另起炉灶;在其输出上追加:patch 数 / hunk 数 / 受影响包 / 受影响 LOC / stale 补丁,
按 functional / ui-behavior / brand 分层汇总。

## P1-2:Patch 分级与削减

分级保留 `functional / ui-behavior / brand`;`runtime-hook` / `upstream-feature` 两个新层
**先写判定规则进 `patches/LAYERS.md`,再加层**(登记表按包名索引,加层有治理成本)。

削减原则(v1.0 保留,移植时执行):

- 能通过 Desktop Host 解决 → 不打 DSH patch;
- 能通过官方插件机制解决 → 不打 DSH core patch;
- 能通过 startup hook 解决 → 不使用 patch-package;
- 只有无法外部解决的 → 才保留 patch。

(先例:目录选择器走上游 stock 实现 `ctx.uiWorkspace.pickDirectory()` 而非注入全局桥,
见 AGENTS.md「目录选择器必须走 Host seam」一节。)

---

# 8. P1:Runtime Packaging

(v1.0 三阶段保留,补实施注记)

**Phase A:依赖裁剪**

- `scripts/report-runtime-size.mjs` 与现有 `size:report`(壳/安装包/资源树三口径)合并口径,
  不各写一套。
- 判据红线:**删目录看内容不看名字**(`verify:prune` 守卫);平台变体剪枝只动
  `prune-platform-variants.mjs` 的四类有界判据(`verify:variants` 守卫)。
- LibreOffice 体积(2026-09-18 裁定)维持"接受",减重走上游。

**Phase B:Runtime Assembly Cache**

- cache key 直接复用 `harness-locks/<target>/inputs.json` + patch 指纹,不发明第二套指纹。
- **本地快速路径已存在**:`prepare:harness` 的指纹校验 + MANIFEST 完整性检查。
  0.8 只补 **CI 侧** `actions/cache` 按同一指纹缓存 `resources/` 树,不重写本地缓存。

**Phase C:Bundle 实验**

- `perf/runtime-bundle` 实验轨道不变:esbuild / Node SEA 只做 benchmark / compatibility /
  startup / memory / native module 观测,不进主生产路径。

---

# 9. P1:Thin Shell 继续收敛

(v1.0 全文保留)

Tauri 必须保持 **Desktop capability**,而不是 DSH Agent capability。

Tauri 只负责:Window / Tray / Update / IPC / System integration / Diagnostics / Recovery /
Mobile Bridge。

Tauri 不负责:Agent / Tool execution / Model routing / Session state machine / MCP logic /
Provider schema adaptation。

这是 0.8 最重要的边界规则之一。

---

# 10. P1:冻结 Desktop IPC Surface

(v1.0 原则保留)

- 现有 command 能复用 → 不增加 command;
- 已有 command 只是 payload 不够 → 扩展 contract;
- 只有真正的系统能力 → 新增 IPC。

新增 `docs/ipc-contract.md`,记录:command / request / response / error codes / owner /
security boundary。

**v1.1 注记**:命令面的机器判据是 `verify:ipc-surface`(唯一真源
`src-tauri/src/commands.rs`,当前 20 个命令、`ALLOW_UNUSED_COMMANDS` 为空表)。
文档必须与其**同源**——不要手抄第二份清单;本仓"手抄清单与真实依赖脱节"已有三例
(资源清单四处手抄、看门狗候选清单、演练镜像清单)。

---

# 11. P1:Supervisor 2.0

(v1.0 目标保留)`dsh-host` 是项目核心基础设施:spawn / ready / heartbeat / health /
restart / circuit breaker / orphan cleanup / logs / diagnostics 之上,新增
RuntimeIdentity / RestartReason / FailureBudget / StartupPhase / HealthSnapshot;
全项目**只有一个 Host lifecycle authority**,禁止 Tauri、Supervisor、Harness 各判一次。

**v1.1 契约约束**:状态机**内部**细化可以,但**对外的 `HarnessSnapshot.phase` 词汇必须保持兼容**——
`harness_status` 命令与 `harness://status` 事件共用该载荷,`frontend/error.html` 判
`phase === 'failed'`(平铺契约由 `state.rs` 的 serde 探针测试守着)。改 phase 词汇属
**破坏性跨语言契约变更**:必须过 snapshot 平铺测试 + `verify:shell-pages`,并按 ADR
纪律记录决策。本仓两次"形状变了、消费方静默失效"事故都是这个形态。

---

# 12. P1:恢复机制 2.0

**v1.1 修订**:故障分类**映射进 `crates/dsh-contracts/src/errors.rs` 的 `E1xxx~E7xxx`
族号体系**(族号↔类别有测试守着),**不建第二套平行分类**。新增类别从
`dsh-host/src/diagnostics.rs` **已观测的归因 case** 派生;v1.0 先验列出的
`DUPLICATE_TOOL` / `MISSING_SERVICE` 等暂无观测实例,**不预建**,出现即登记。

Fault → Classification → Recommended Action 的结构保留,例如:
PORT_CONFLICT → 换端口重试;PLUGIN_LOAD_ERROR → Safe Mode;PROFILE_CORRUPTION → 隔离
profile;RUNTIME_EXIT → 重启;UPDATE_FAILURE → 回滚。

边界(v1.0 保留):0.8 只做"诊断 + 非破坏性恢复",不做未经充分验证的插件删除/卸载
——与已归档的 plugin uninstall 裁定一致。

---

# 13. P2:第三方模型 / Tool Calling

(v1.0 全文保留)**不要把 Model Gateway 做回 Desktop**(已归档,无 Runtime Consumer)。

Desktop 只做 observe / diagnose 与 **Provider Error Attribution**:至少能诊断
provider / model / tool / schema path / request id / runtime version,并在 Diagnostics 中
把错误区分为 Desktop / Host / DSH Runtime / Plugin / Provider 五层,而不是全部归类
"Desktop failed"。归因下沉遵守 INV-6:能在无窗口环境测试的逻辑放 `dsh-host`。

---

# 14. P2:Plugin 能力

(v1.0 全文保留)0.8 不重新实现已删除的"假隔离";当前真实有效的是进程内归因
(`plugin-safety-guard.mjs`)。

- **0.8**:Plugin identity / fault attribution / startup failure / recovery / Safe Mode。
- **0.9 以后**:真正 process-level isolation,前提是能接入真实 Harness plugin loader,
  否则不做。

---

# 15. P2:发布通道(v1.1 双通道定稿)

**只保留两个 target(机制零改动),上游三个 dist-tag 只跟两条;不新增 beta / nightly / canary / dev。**

| target | 跟踪的上游 dist-tag | 说明 |
| --- | --- | --- |
| `next` | `next`(现为 0.2.0-rc.1) | 唯一活跃升级线;publishChannel = `rc` |
| `alpha` | `alpha`(现为 0.1.7-alpha.2) | 保持不动,至上游 alpha dist-tag 前移;publishChannel = `alpha` |
| ~~latest~~ | **不建目标** | 0.1.7 线已弃。若上游做维护 backport(参照 0.1.5-rc.3 先例:rc.2 后 12 天、与后继线首号同日),是否跟进由升级专项另行裁定 |

`channel`(上游客观事实,不可改)≠ `publishChannel`(本仓命名,可改)的解耦设计保留;
`targetForVersion` 查 `publishChannel`,漂移哨兵用 `channel`(`upstreamTagFor`)。

**ADR-048(单通道收敛)已被本裁定取代,superseding 条目已补:ADR-052(2026-09-30)。**
理由:双目标机制已建成且边际成本为零;alpha 线上游仍活跃;单通道收敛的收益被
0.2.0 全量补丁移植的工作量挤占。ADR-048 的成本结构分析仍然有效——它正是 ADR-052
明确接受的代价,对冲手段是"补丁数趋势 + retireWhen 减法"
(见 `docs/dev-plan-defect-remediation.md` S5)。

---

# 16. P2:建立"可发布"而不是"最新"策略

(v1.0 判据保留)Release 判断的不是"最新版本?",而是:Compatibility PASS?Smoke PASS?
Migration PASS?Patch PASS?Packaging PASS?→ `READY_TO_RELEASE`。

必须满足:Runtime compatibility / Dependency closure / Patch applicability / Harness
startup / Tool calling / MCP / Plugin / Profile migration / Updater / Diagnostics /
Windows / Linux / macOS 全 PASS。

**v1.1 注记**:

- Tool calling / MCP / Plugin 三项需要真实账号,**CI 不自动化**,走
  `docs/dsh-upgrade-checklist.md` 手工门禁;
- Windows 便携版核验(`verify:portable-package`)与 13 项发布资产清单
  (`verify:release-assets`)必须包含在 Packaging PASS 内;
- CLI 发布通道维持退役,不在判据内。

---

# 17. P2:Upstream Drift 由 Warning 升级为 Gate

(v1.0 分级保留)差 0 patch → PASS;差 1 patch → INFO;差 1 minor → WARNING;
差 ≥2 minor → RELEASE BLOCKED;可填 `DRIFT_OVERRIDE_REASON` 豁免,release workflow 留档。

**v1.1 预期管理**:切锚点前,`next` 通道对照 0.2.0-rc.1 **必然非绿**(跨 minor)——
这是"升级未做"的如实反映,**不得用 OVERRIDE 掩盖欠账**;豁免只用于"已裁定等待"的情形,
且必须写明等待的 §6 门禁条件。

---

# 18. P2:CI 重新分层

(v1.0 三层结构保留)

- **L0:Pull Request**(<10 min):cargo test / check、npm scripts self-test、lint、
  verify contracts / IPC / patches / targets。
- **L1:main / daily**(三平台):prepare harness、build、launch、probe、stop、restart、
  orphan cleanup。
- **L2:release**(全量):package、install、startup、update、migration、tool、MCP、
  plugin、safe mode、diagnostics。只有 L2 全过才允许发布。

**v1.1 成本注记(待裁决)**:三平台 L1 单轮 ≈ 40 分钟以上(组装 + 构建 + 冒烟)。
daily 三平台对个人维护者偏重——裁决项:daily(按 v1.0)或 weekly / 随 release 触发。
裁决只改触发频率,不改分层结构。

---

# 19. P2:性能基线

(v1.0 保留)不再用"应该更快"作为性能描述。新增 `docs/performance-baseline.md`,记录:
cold start / warm start / runtime assembly(cache hit / miss)/ memory idle 与 under load /
IPC latency / restart latency / installer size / runtime size,均记 P50 / P95。
0.8 不追求极限优化,原则:**先测量,再优化**。

---

# 20. P3:Developer Experience

(v1.0 方向保留)README 只保留 What / Why / Architecture / Quick Start / Build / Release /
Diagnostics;新增 `docs/architecture.md`、`runtime-compatibility.md`(§4)、
`development.md`、`release.md`、`diagnostics.md`。

**v1.1 风险注记**:现有 `docs/` 被 `verify:plan-facts`(声明点文件)、`verify:claims`、
AGENTS §6 引用网络锁定。**先补 ADR 与索引,后搬文件**;任何移动必须同步声明点与全部
引用,否则守卫红、且是"静默断线"形态。历史方案归档 `docs/archive/` 按既有纪律执行
(文首加归档说明)。

---

# 21. 建议删除 / 冻结的内容

(v1.0 全文保留)0.8 明确冻结:

- 第二套 Agent Runtime
- Desktop Model Gateway(已归档)
- 未接入真实 loader 的 Plugin Sandbox(已归档)
- 新增 release channel
- 大规模 Frontend 重写
- Desktop 自己实现 Tool Calling

新功能只允许属于:Desktop capability / Host capability / Reliability / Compatibility /
Diagnostics / Cross-platform。

---

# 22. 核心脚本清单(v1.1 标注现状)

**已存在**(0.8 只消费或扩展,**不重写**):`prepare-harness` / `verify-harness-tree` /
`verify-upstream-drift` / `verify-patch-layers` / `verify-ipc-surface` /
`verify-release-workflow` / `verify-release-assets` / `verify-variants` / `verify-prune` /
`verify-target` / `verify-profile-names` / `verify-claims` / `verify-plan-facts` /
`verify-harness-entry` / `verify-harness-inject` / `verify-remove-tree` /
`check-patch-applicability` / `report-patches` / `report-bundle-size` / `smoke-launch` /
`fault-inject` / `package-cli` / `package-portable` / `remove-tree` / `harness-lockfile` /
`changelog` / `version` / `conventional-commits` / `mock-harness`。

**真正新增**(v1.1 收缩后):

- `verify-runtime-upgrade.mjs`——既有门禁的**编排器**(§6);
- profile migration fixtures + peer-gate×冻结树检查(§5);
- `report-patch-surface.mjs`——扩展 `report-patches`(§7);
- `report-performance.mjs`(§19);
- runtime assembly cache 的 CI 侧接线(§8 Phase B)。

命名纪律不变:`verify*` 解决正确性;`report*` 解决可观测性;`smoke*` 解决运行可靠性。

---

# 23. Git 分支策略

(v1.0 清单保留,目标名更新)`main` 之下:`upgrade/dsh-0.2.0`、
`refactor/runtime-compatibility`、`refactor/patch-surface`、`refactor/supervisor-v2`、
`perf/runtime-packaging`、`chore/release-gates`。

不建议与主产品边界冲突的长期分支(`feature/plugin-v3` 等)。

**v1.1 建议**:单人维护者**串行执行**——一条分支做完合一条,不并行养长命分支。

---

# 24. Commit Strategy

(v1.0 保留,示例目标版本更新)`refactor(runtime): add compatibility manifest`、
`feat(runtime): support dsh 0.2.0-rc.x`、`test(runtime): add profile migration fixtures`、
`refactor(patch): remove obsolete dsh-core patches`、`perf(runtime): add assembly cache`、
`refactor(supervisor): unify lifecycle authority`、`fix(recovery): classify …`、
`feat(diagnostics): add runtime identity report`、`ci(release): gate publication on
compatibility checks`。一个 commit 尽量只有一个职责。

---

# 25. 开发阶段安排(v1.1 修订)

## Phase 0:冻结基线

把当前 0.7.x 变成可回滚基线:tag 0.7.x baseline;保存 runtime manifest / lockfile /
三平台 smoke / installer / diagnostics fixture。输出:0.7.x Known Good Baseline。

**v1.1 新增两项**:

- ~~补 ADR-048 的 superseding 条目(§15)~~ ✅ 已完成(2026-09-30,ADR-052);
- 登记 0.2.0 观察清单(#8166 / #8140 / #8183 / #7903 / #7828 / #7908),作为 §6 门禁的
  跟踪底账。

## Phase 1:Runtime Compatibility

在 `upgrade/dsh-0.2.0` 上完成 0.2.0 兼容候选:target table / lockfile / dependency
closure / **补丁移植(逐补丁执行 §7 削减原则)** / vendor 迁移 / migration fixtures /
启动测试。输出:DSH 0.2.0 Compatibility Candidate。

## Phase 2:Patch & Packaging

patch surface 报告 / 过期补丁清理 / CI assembly cache / 依赖裁剪 / runtime size 报告 /
bundle 实验。输出:Repeatable Runtime Assembly。

## Phase 3:Host / Recovery

统一 lifecycle / failure classification(E 族映射,§12)/ health snapshot / restart
reason / diagnostics identity / profile recovery。输出:dsh-host 2.0(内部细化,对外
契约兼容,§11)。

## Phase 4:Release Hardening

PR gate / smoke(频率按 §18 裁决)/ runtime compatibility gate / profile migration gate /
updater gate / package verification。输出:Release Candidate。

## Phase 5:0.8 RC

RC 条件(v1.0 保留,其中"上游 stable"类表述替换为 §6 门禁条件):Runtime compatibility
PASS;No unresolved P0;No unresolved data-loss P1;三平台 PASS;Cold Start / Memory
benchmark recorded;Diagnostics export PASS;Updater PASS;Rollback PASS。

---

# 26. 0.8 的最终 Definition of Done

(v1.0 六组保留;**待裁决**的收缩建议附后)

**Runtime**:DSH version / channel / Node version 显式声明;lockfile 可复现;patch set
可复现;runtime manifest 已生成。

**Host**:one lifecycle authority;startup timeout;heartbeat;restart;circuit breaker;
orphan cleanup。

**Recovery**:boot failure classified;plugin failure classified;profile failure
classified;safe mode works;diagnostics works。

**Desktop**:Thin Shell;IPC contract stable;Tray stable;Update stable;Mobile Bridge stable。

**Packaging**:repeatable assembly;cache;dependency pruning;package verification。

**Release**:compatibility gate;smoke gate;migration gate;updater gate;Windows / Linux /
macOS。

> **待裁决(收缩建议)**:26 项可收缩至 ~12 项核心(Runetime 显式声明 ×3、lockfile /
> patch 可复现、单一 lifecycle authority、三类故障分类、safe mode / diagnostics、
> repeatable assembly、compatibility / smoke / migration 三门禁、三平台),其余降为
> 跟踪项。裁决权在维护者;裁决前按上表全量执行。

---

# 27. 0.8 不做什么

(v1.0 全文保留)

❌ 自研 Agent Runtime / 自研 Conversation UI / 自研 Tool execution engine /
自研 Provider abstraction / 强制 Plugin Sandbox / 新增第三条发布线 / 大规模 UI 重写 /
重写 Tauri IPC / 追求 Node SEA 生产化 / 为了追新版本而跳过兼容性验证。

---

# 28. 0.8 → 0.9 的演进方向

(v1.0 保留)0.8 完成 Runtime compatibility / Host stability / Release reliability /
Diagnostics 之后,0.9 进入:三平台 polish、Runtime packaging 2.0、更好的 provider
diagnostics、Profile migration UX、Plugin ecosystem、Developer tooling——

而不是继续:更多 abstraction / 更多 crate / 更多 gateway / 更多 channel。

---

# 29. 本版本最重要的工程原则

(v1.0 六条全文保留)

1. DSH 是唯一 Agent Runtime
2. dsh-host 是唯一 Runtime lifecycle authority
3. Tauri 只做 Desktop capability
4. 能不用 patch 就不用 patch
5. 能不增加新 IPC 就不增加新 IPC
6. Release 的标准不是"最新",而是"经过验证"

最终架构收敛为:

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
                DSH Runtime(0.2.0 线,经 §6 门禁切锚)
                      │
          ┌───────────┼───────────┐
          │           │           │
        Agent       Plugin       MCP
          │
          ▼
      Provider
```

> **不让 dsh-desktop 变成第二个 DSH,而是把它做成一个可靠、可诊断、可升级、跨平台的
> DSH Runtime Host。**
