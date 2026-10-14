# 上游版本对齐：变化类型、现有逻辑与更新后的策略（设计提案）

> **状态**：**提案（未施工）**。除文中显式标注「已落地」的一条（2026-10-10 漂移哨兵按线判定）外，
> 本文**没有**改动任何代码；§4 给出分批施工与每批的判据要求。
>
> **口径关系**：版本号**长什么样 / 何时递增 / 谁有权决定**以 [`version-policy.md`](version-policy.md) 为唯一权威；
> 本文只处置**对齐**这一个维度——「上游的事实怎么变成本仓的载体，以及两侧不一致时怎么发现」。
> 与本文冲突时以 `version-policy.md` 为准。
>
> **证据日期**：2026-10-10（文中所有具体版本串、条数均为**时点快照**，不是常量；常量请看对应产地文件）。

---

## 0. 结论先行

1. **缺的不是「产地」，是「判据面」。** 现状已有三个互斥产地（目标表 / 台账 / 写入面）与单向派生链路，
   结构是收敛的；真正的风险在于**若干条对齐边上没有任何守卫**——那里「上游变了」与「我们对错了」
   都不会产生任何红。§2.4 列了 12 处，其中 6 处会**静默**。
2. **本次真正值得复用的设计范式，是 2026-10-10 对漂移哨兵的拆分**：上游事实有两个来源
   （GitHub Release / npm dist-tag），它们**回答的不是同一个问题**，因此不能共用一个判定出口。
   已拆为「**判定层**按线取 dist-tag」+「**信息层**看 Release，只打印」。
3. 由此得到本策略的骨架：**对齐必须按三个视角分开**——
   **判定**（我这条线走到哪了）／**组装**（我钉的是哪个**精确**版本）／**发布**（这一版对外属哪条通道）。
   三者各自绑定**不同**的上游事实，**不得互相替代**，每条再各配一个守卫。
4. 兼容性面最大的空白是 **peer 区间靠手写、没有派生规则**；其次是**两套 Node 版本族互不校验**；
   再次是**两条通道的 lock 来自不同 registry 且无守卫**（实测 100% 不共源，见 §2.3 G4）。
5. 冲突/缺失的统一口径写死为四档，不允许第五种：
   **判不了 ⇒ 判红** · **取不到 ⇒ SKIP 且明写「未核对」** · **名字不存在 ⇒ 判红（配置缺陷）** ·
   **降级 ⇒ 必须留痕到产物**。

---

## 1. 上游版本变化类型

分五族。**「可观测判据」一列是设计的重点**——看不见的变化等于没发生。

### 族 A — 版本号本身变化

| # | 情形 | 可观测判据 | 现有处置 | 出口 |
|---|---|---|---|---|
| A1 | 同线、同阶段、**阶段内序号**前进（`…alpha.1 → …alpha.2`） | 该目标 `upstreamDistTag` 的现值与 `dshVersion` 比 | `patch-behind` | ⚠️ 仅提示（exit 0） |
| A2 | 同线、同阶段、**补丁线**前进 | 同上 | `patch-behind` | ⚠️ 仅提示 |
| A3 | 同线、`x.y.z` 不变、**阶段前进**（alpha → rc） | 同上 | `stage-behind` | ❌ 阻断 |
| A4 | **跨 minor**（`0.2.x → 0.3.x`） | 同上 | `minor-behind` | ❌ 阻断 |
| A5 | 同线出现「补丁线前进 **且** 阶段回退」⇒ dist-tag 被**重指** | 同上 | `patch-line-behind` | ❌ 阻断 + 归因指向「目标表可能过期」 |
| A6 | 上游出现**正式版**（版本无预发布段） | Release 信息层出现 `prerelease:false` | 叫号器点名 checklist §6 第 1 条；`composeDesktopVersion()` 对无预发布段**直接抛错** | ❌ 硬阻塞（stable 线载体未定，ADR-061 决策 7 开口） |

> A1/A2 只提示、A3 起阻断——这条分界线是**刻意**的：同一阶段内的前进不改变我们的补丁基线语义，
> 而相位/版本位变化会让整套补丁的适用性前提失效。**判定基准见 §3.1 R1**。

### 族 B — 发布面 / 分发面变化（版本号可能不变）

| # | 情形 | 可观测判据 | 现有处置 | 出口 |
|---|---|---|---|---|
| B1 | **tag 已动、npm 未跟上**（上游宣布了但包还没发布） | Release 清单最大版 > 该线 dist-tag 值 | 只在**信息层**打印差值 | ℹ️ 不判定（见 §3.1 R1 的理由） |
| B2 | 某条 dist-tag 指向被改（版本没变、线重指） | 该线现值与其历史比对（**当前无历史留存**） | 无 | 🔴 **缺口 G11** |
| B3 | 某条 dist-tag **消失** | `resolveLineVersion()` 返回 `missing` | 判红，理由点名「目标表指了一条不存在的线」+ 修法指向 `dsh-targets.mjs` | ❌ 阻断（已落地 2026-10-10） |
| B4 | 上游**新增** dist-tag（如 `beta`） | dist-tags 响应出现未知键 | 无（既不红也不提示） | 🔴 **缺口 G12** |

### 族 C — 依赖树 / 包集合变化（**不体现为版本号**，最容易被漏掉）

| # | 情形 | 可观测判据 | 现有处置 | 出口 |
|---|---|---|---|---|
| C1 | `@deepseek-ai/dsh-*` 家族包**增/删** | `inputs.json` 的 `overrides` 与真实闭包比对 | `lockInputsMatch` 规则 1/3（**只判「多出且撞当前补丁名」，不判「漏钉」**） | 🔴 **缺口 G7** |
| C2 | 某个 vendored 覆盖包**版本变化** | `vendor/*/package.json` 与补丁文件名版本段 | 规则 3b/3d（树内拷贝、lock 抄录）逐字比对 | ❌ 判红（需组装树） |
| C3 | 上游 **peer 要求**变化 | `dsh-app-boot::evaluatePluginCompatibility` 的判据 | `verify-harness-tree.mjs` 规则 3（3a 相容 / 3b 树一致 / 3c 不过宽 / 3d lock 一致），**不进 fast/ci** | ❌ 判红（发布链路） |
| C4 | 上游传递依赖带出**安全漏洞** | Dependabot 告警集合 | 登记在 checklist §6 第 4 条；**跟随上游，不自行 pin** | ⚠️ 人工 + 登记 |
| C5 | 上游把包发到**另一个 registry** | lock 的 `resolved` 主机名 | **无守卫** | 🔴 **缺口 G4** |

### 族 D — 内置运行时 / 工具链

| # | 情形 | 可观测判据 | 现有处置 | 出口 |
|---|---|---|---|---|
| D1 | 内置 Node / pnpm 版本变化 | `prepare-harness.mjs` 的 `NODE_VERSION` / `PNPM_VERSION` 常量 | 随 `inputs.json` 进 `lockInputsMatch` 规则 1/4 | ❌ 失配判红（CI） |
| D2 | 宿主工具链 Node 变化 | `.nvmrc` / `package.json` `engines` / `MIN_NODE_MAJOR` | `verify-doc-facts` 只对账 `.nvmrc 大版本 ↔ 文档` | 🔴 **缺口 G1** |
| D3 | primary-runtime 的 node 来源 | `prepare-runtime.mjs` 传 `--node-version` 取自 `.nvmrc`，二进制实际来自 `src-tauri/resources/node` | 无交叉校验；取不到时**回退 `process.execPath` 且只 log** | 🔴 **缺口 G2/G3** |

### 族 E — 数据源**形状**变化（非版本号）

| # | 情形 | 可观测判据 | 现有处置 | 出口 |
|---|---|---|---|---|
| E1 | 台账 `schemaVersion` 变化 | `readLedger` 读到的值 | 不符**抛错** | ❌ 阻断（无迁移路径，属刻意） |
| E2 | MANIFEST v3 字段无产地 | `unresolvedFields[]` | **照常产出**并逐条记录 | ℹ️ 如实缺失（与「自相矛盾」是两个出口，后者抛错） |
| E3 | `release-manifest.json` 的 `n` 时点漂移 | `lines.<target>.n` 与台账现算值 | 恒时档不判（只判结构/目标/白名单）；时点判据只在发布前门 | ⚠️ 已文档化的设计取舍 |

---

## 2. 现有对齐逻辑

### 2.1 三个互斥产地（一个概念只有一个产地）

| 产地 | 文件 | 回答的问题 | **不**回答 |
|---|---|---|---|
| 运行时**目标表** | `scripts/dsh-targets.mjs`（`DSH_TARGETS`） | 目标键 → 目录；上游锚点 `dshVersion`；桌面后缀 `publishChannel`；`upstreamDistTag`（**判定 + 发现**）；`status` | 合成号 / `n` / `w`；「上游精确版本 → `patchTarget`」 |
| 上游**索引与台账** | `harness-locks/dsh-releases.json` + `scripts/release-ledger.mjs` | 上游**精确**版本 → `patchTarget`（`resolveReleaseFor()`）；`n`/`w`；合成号（`composeDesktopVersion()`）；通道（`deriveReleaseChannel()`） | 目录怎么摆；本仓钉的上游锚点是多少 |
| 版本**写入面** | `scripts/version.mjs`、`scripts/sync-upstream-release.mjs` | 把两者组装进 `package.json` / `Cargo.toml` / `Cargo.lock` | 自己拼合成号；自己选通道 |

**命名纪律**：本仓「`channel`」**只**指**桌面通道**（`stable`/`rc`/`alpha`，由**版本后缀**推导）；
上游那条 dist-tag 一律叫 `upstreamDistTag`。

### 2.2 对齐链路

```
上游事实                          本仓载体（全部单向派生 ⇒）
─────────────────────────────────────────────────────────────────────
GitHub Release 清单  ──信息层──▶   只打印 + stable 线叫号        [不判定]
npm dist-tag(线指针) ──判定层──▶   各目标「线上游现值」          → judgeDrift → 红/提示
上游精确版本         ──────────▶   台账键 → patchTarget
                                      │
                    dsh-targets.dshVersion（组装锚点）
                                      ├─▶ 补丁文件名版本段（DSH 家族必须逐字相等）
                                      ├─▶ inputs.json{target, dshVersion, dependencies, overrides}
                                      ├─▶ package-lock.json 根 dependencies
                                      └─▶ MANIFEST.upstreamDsh.version
台账 builds[] + n    ──────────▶   package.json（合成号，唯一 SSOT）
                                      ├─▶ tauri.conf.json（继承）
                                      ├─▶ Cargo.toml（跟随）
                                      └─▶ Cargo.lock（生成物）
上游 peer 要求       ──────────▶   vendor/**/package.json 的 dsh-* peer 区间  ← **手写**
                                      ├─▶ 装配树内拷贝（src-tauri/resources/…）
                                      └─▶ harness-locks/<t>/package-lock.json 的抄录
```

### 2.3 对齐点清单（判据 + 出口形态）

| 对齐点 | 判据产地 | 出口形态 |
|---|---|---|
| 目标锚点 ↔ 补丁文件名版本段 | `patch-layers.mjs::auditPatchLayers()`（仅 `@deepseek-ai/dsh*` 家族要求相等，独立版本包跳过） | ❌ 判红 |
| 目标锚点 ↔ 台账在役键 | `verify-plan-facts` 的 C1（以**台账在役键**为比对基准） | ❌ 判红 |
| 目标锚点 ↔ `inputs.json` | `lockInputsMatch` 规则 1/4 | ❌ CI 判红 / ⚠️ **本地回退在线 install**（G5） |
| `overrides` 集合 ↔ 补丁 + vendored 包 | `lockInputsMatch` 规则 2/3 | ❌ 判红 |
| vendored peer ↔ 在役目标 | `verify-harness-tree` 规则 3a | ❌ 判红（**需组装树**，故不在 fast/ci） |
| vendored peer ↔ 树内拷贝 | 规则 3b（包不在树里则打印 note、跳过） | ❌ 判红 / ℹ️ note |
| vendored peer ↔ 下个 minor 探针 | 规则 3c（挡 `*` 这类一律放行） | ❌ 判红 |
| vendored peer ↔ lock 抄录 | 规则 3d | ❌ 判红 |
| 成员版本 ↔ 真源 | `version.mjs` 对 `Cargo.lock` 成员的核对 | ⚠️ **仅 warning（G10）** |
| `.nvmrc` ↔ 文档 | `verify-doc-facts` | ❌ 判红 |
| 台账自洽 / 合成号逐字 | `release-ledger.mjs`（`--validate`） | ❌ 判红 |
| 线指针 ↔ 目标锚点 | `verify-upstream-drift.mjs`（**2026-10-10 起按线**） | ❌/⚠️/ℹ️ 见族 A |

### 2.4 现有逻辑的结构性缺口

**先说结论**：这些缺口的共同形态是「**判据存在，但判不了时不发声**」，而不是「没有判据」。
按危害排序，P0（会静默放行错误产物）四条，P1（判不了但不阻断）四条，P2（一致性/卫生）四条。

| # | 缺口 | 症状 | 现状出口 | 级别 |
|---|---|---|---|---|
| G4 | 两通道 lock 的 **registry 不共源且无守卫**（实测 next 全部 `registry.npmjs.org`、alpha 全部 `registry.npmmirror.com`，两侧零交叉） | 「刷新 lock」会**整份换源**，噪声远大于版本变化本身；且无法从判据层发现 | 无 | **P0** |
| G5 | `lockInputsMatch` 失配时**本地非 CI 静默回退在线 `npm install`** | 本地组装产物与提交式 lockfile **不同**，而输出只是理由文本 | ⚠️ 降级（打印理由） | **P0** |
| G7 | `overrides` 家族闭包**只判「多出」不判「漏钉」** | 上游新增家族包而漏钉 ⇒ 混血树 ⇒ 运行期单例包多份拷贝 | 无正向守卫 | **P0** |
| G3 | `fetch-primary-runtime.mjs` 找不到 `resources/node` 时**回退 `process.execPath`**，仅 `log()` | 产物与 `inputs.json` 声称的 node 版本不一致 | ⚠️ 静默回退 | **P0** |
| G1 | **两套 Node 版本族互不校验**：内置 `NODE_VERSION`（24.9.0，硬编码）↔ `.nvmrc`/`engines`（24.19.0）↔ `MIN_NODE_MAJOR` | 三处数字可以各自漂移而全绿 | 无 | P1 |
| G2 | primary-runtime 的 `--node-version` 取自 `.nvmrc`，二进制实际来自 `src-tauri/resources/node` | 两个数字不一致无人报红 | 无 | P1 |
| G6 | `PATCH_LAYERS.retireWhen` **从不被机器求值**（只作字符串存储，仅报告脚本计数） | 「上游已补齐能力 ⇒ 该补丁应退役」永远不自动报红 | 人工 | P1 |
| G10 | `Cargo.lock` 成员版本落后真源**只记 warning** | 版本号在 Cargo 侧可短暂不一致 | ⚠️ warning | P1 |
| G5b | `packages/<target>/*.tgz` 分支是**死分支**，且文件名解析失败只 `continue` | 未来加入 vendored tgz 后，解析不了的文件会被**静默忽略** | ⚠️ 静默 | P2 |
| G8 | 两份 `dsh-app-boot` 树副本（`resources/harness/…` 与 `harness-deps/…`）不同步无断言 | 实际运行的那份可能不是被检查的那份 | 无 | P2 |
| G9 | `harness-deps/` 下历史 staging 残留（含与当前锚点都不符的补丁目录）不在任何守卫的校验面内 | 排障时读到过期证据 | 无 | P2 |
| G11/G12 | 线指针变化（B2）与上游新增 dist-tag（B4）无任何观测 | 「线被重指」只能靠 A5 事后撞见 | 无 | P2 |

---

## 3. 更新后的对齐策略

### 3.1 版本映射规则

#### R1 — 三个视角，三条不同的上游事实（**核心规则**）

| 视角 | 问题 | 绑定的事实 | 唯一入口 | 守卫 |
|---|---|---|---|---|
| **判定** | 我这条线走到哪了？ | 该目标 `upstreamDistTag` 的**线指针** | `verify-upstream-drift.mjs::resolveLineVersion()` | `gate -- drift`（sentinel 档） |
| **组装** | 我钉的是哪个**精确**版本？ | `dsh-targets.dshVersion` + 台账键 | `resolveTarget()` / `resolveReleaseFor()` | `targets` / `release-ledger` / `plan-facts` |
| **发布** | 这一版对外属哪条通道？ | **版本后缀**（`publishChannel`） | `desktopChannelForVersion()` / `--channel-of` | `release-workflow` |

**为什么不能合并**：Release 清单里没有任何字段能标记「这条 Release 属于哪条线」，
所以拿「全局最新」当判定，`next` 会被 **alpha 线**的版本判成落后并报红（2026-10-10 实证）。
**组装**必须用**精确**版本（补丁是行级 diff，只对某一个版本成立）；**发布**必须用**后缀**（tag 决定组装哪套运行时）。
三者中任一被另一个替代，都会产生「看起来正常」的错误出口。

#### R2 — 映射是**单向**的：上游 → 本仓，禁止反推

| 禁止的反推 | 为什么 | 已有守卫 |
|---|---|---|
| 桌面号 → 上游版本 | 两个号**形状同构**（`0.7.3-alpha.1` 与 `0.2.1-alpha.1.3` 无法区分末段归属） | `manifest-v3.mjs`：无台账背书时 `seq` 必须落 `null` |
| 桌面号 → 通道 | 通道由**后缀**推导，不读 `upstreamDistTag` | `desktopChannelForVersion()` 自测 |
| 目标键 → 上游版本 | 目标键答「用哪套补丁目录」，版本由台账答 | `verify-plan-facts` C1 |
| 补丁文件名 → 目标锚点 | 反过来才对：文件名**必须**等于 `dshVersion` | `auditPatchLayers()` |

#### R3 — 「上游前进」的判据必须带**线**维度

任何「上游最新是 X」的断言都必须写成「**哪条线**的最新是 X」。裸的全局最新**不得**参与任何判定
（可以进信息层）。这条是 R1 的可执行形式，判据：漂移哨兵自测里那条**跨线反证**
（跨线判 vs 按线判必须得出两个**不同**的结果，否则判据空转）。

#### R4 — 载体映射矩阵（上游事实 → 本仓载体）

| 上游事实 | 本仓载体 | 派生方向 | 断言点 |
|---|---|---|---|
| 精确版本 `x.y.z-<pre>` | 台账键 | 上游 → 台账 | `release-ledger` 自洽 |
| 精确版本 | `dshVersion`（组装锚点） | 台账/目标表 → 补丁与 lock | 目标锚点 ↔ 台账在役键（C1） |
| 精确版本 | 补丁文件名版本段（**DSH 家族**） | 锚点 → 文件名 | `auditPatchLayers()` |
| 精确版本 | `inputs.json.dshVersion` + 根 `dependencies` | 锚点 → lock 输入 | `lockInputsMatch` 规则 1/4 |
| 精确版本 | `MANIFEST.upstreamDsh.version` | **台账键**（不由桌面号反推） | `manifest-v3` 自测 |
| 线指针 | 判定层的比较右端 | dist-tag → 判定 | `drift`（sentinel） |
| 桌面通道 | 版本后缀 | **后缀** → 通道 | `--channel-of` |
| `n` | 合成号末段 | 台账 `builds` max+1 | `release-ledger` 守卫 1（不重复） |

#### R5 — 每个对齐点必须声明它在哪种情况下**判不了**，以及判不了时的出口

不允许「沉默的通过」。§3.3 的出口口径表是这条规则的统一答案。

### 3.2 兼容性处理

| 面 | 现有做法 | 更新后的做法 |
|---|---|---|
| **peer 区间** | 三个 vendored 包的 `dsh-*` 区间**手写**（如 `>=0.2.0-rc.2 <0.3.0-0`），事后靠规则 3 判红 | **由目标表派生**：新增一个纯逻辑模块从全部在役目标的 `dshVersion` 算出「最小安全区间」，规则 3 增加一条「区间必须等于派生值」。理由：手写区间在**锚点推进时必然漂移**，而它是**三面**（源/树/lock）的源头 |
| **区间上界写法** | `>=X <Y-0` | 写成规则：上界必须带 `-0`（`<0.3.0` 会放过 `0.3.0-rc.1`）；**禁 `^`**（遇预发布会把上界改写成 `<X.Y.0-0`）；**禁 `workspace:`**（`vendor/**` 是 `file:` 依赖，npm 报 `EUNSUPPORTEDPROTOCOL`） |
| **lock 双源** | 两通道各自生成，registry 不同（实测零交叉） | `inputs.json` 增加 `registry` 字段，`lockInputsMatch` 增加**规则 5**：lock 里 `resolved` 的主机名必须**单一**且等于声明值。否则「刷新 lock」= 整份换源 |
| **Node 三数** | `NODE_VERSION` 硬编码；`.nvmrc`/`engines` 同值；`MIN_NODE_MAJOR` 在 Rust 侧 | 交叉断言三件事：①`NODE_VERSION` 与 `inputs.json` 一致（已有）；②`.nvmrc` 大版本 ≥ `MIN_NODE_MAJOR`；③`engines.node` 与 `.nvmrc` 一致。**三者互不覆盖**（内置运行时与宿主工具链**可以是不同版本**，但**差异必须显式**且被记录） |
| **Cargo 侧** | 根 `Cargo.lock` 唯一（成对判据：根须在位 + 成员不得有独立 lock）；成员版本落后只 warning | 把「成员版本落后真源」从 warning 升为**发布档判红**（本地保持 warning，避免开发者每次改版本都被打断） |
| **台账 schema** | 不符即抛错，无迁移路径 | 保持不变，但把「**拒绝读**」与「**读到不认识的字段**」分开：前者抛错，后者记入显式 note（新增字段不应让旧读者炸） |

### 3.3 冲突与缺失版本的应对

#### 统一出口口径（四档，不允许第五种）

| 档 | 判据 | 出口 | 反面（禁止） |
|---|---|---|---|
| **判不了** | 判据本身跑不起来（缺树、缺 semver、缺语料） | ❌ 判红 | 静默通过 |
| **取不到** | 外部状态不可达（离线、`gh` 缺失、限流） | ⏭️ SKIP，且**明写「未核对」** | 让 SKIP 与「已核对」在日志里同形 |
| **名字不存在** | 常量指了一个不存在的东西（slug 404、目标指了不存在的线） | ❌ 判红（**配置缺陷**，附修法指向） | 回退默认值 |
| **降级** | 允许继续，但事实必须进产物 | ⚠️ 降级 + **留痕**（`MANIFEST.patches[]` / `unresolvedFields[]` / 理由文本） | 只打日志 |

**四档的判据是「谁是错的」**：外部状态没准备好 = 我们没错 ⇒ SKIP；常量写错 = 我们错了 ⇒ 判红。

#### 各缺口的处置

| # | 处置 | 判据（可证伪） |
|---|---|---|
| G4 | `inputs.json` 增 `registry`；`lockInputsMatch` 增规则 5（`resolved` 主机名单一且等于声明值） | 造一份混源 lock ⇒ 判红；两份真实 lock 各自通过 |
| G5 | 本地回退在线 `install` 时**写一份 `harness-locks/<t>/.local-install-notice`**（含生成时间与失配原因），并把该路径加入 gitignore；CI 行为不变（仍判红） | 本地造失配 ⇒ 文件出现；CI 造失配 ⇒ exit 1 |
| G7 | 生成 `overrides` 后**重算闭包**并与 `overrides` 键集比对（正向）；补齐不了 ⇒ 判红 | 从 `inputs.json` 删一个家族键 ⇒ 判红 |
| G3 | 回退 `process.execPath` 时把「实际用的 node 路径 + 版本」写进 MANIFEST，并**在 CI 判红** | CI 清掉 `resources/node` ⇒ 判红 |
| G1 | 三条交叉断言（见 §3.2） | 任改一处 ⇒ 判红 |
| G2 | 断言 primary-runtime 实际二进制版本 == `inputs.json.node`（不一致时**显式**登记差异，不只 log） | 改 `.nvmrc` 大版本 ⇒ 出现显式差异记录 |
| G6 | 把 `retireWhen` 里**可机器判定**的那部分（如「上游该包版本已 ≥ X」）落成检查；不可判定的保持人工，但 `report:patches` 必须**逐条列出**未求值的 `retireWhen` | 造一条可判定的 `retireWhen` 并把条件满足 ⇒ 报「可退役」 |
| G10 | 见 §3.2（发布档判红） | 本地 warning、发布档红 |
| G5b | `packages/` 的 tgz 解析失败 ⇒ **报错**而不是 `continue`；当前无 tgz 时该分支应打印「无输入」note | 放一个命名不规范的 tgz ⇒ 报错 |
| G8 | 断言两份 `dsh-app-boot` 树副本同源（或删掉一份不可达的） | 改一份 ⇒ 判红 |
| G9 | `harness-deps/` 的 staging 残留纳入 `.gitignore` 并从校验面显式排除（打印「已排除」） | 存在残留时不产生假证据 |
| G11 | 台账或新文件留存「线指针历史」，判定层比对上次快照；变化 ⇒ 提示（不阻断） | 改 stub registry 返回值 ⇒ 出现提示 |
| G12 | dist-tags 出现未知键 ⇒ **提示**（不阻断）：上游开了新线，可能要考虑新目标 | stub 加一个 `beta` 键 ⇒ 出现提示 |

---

## 4. 落地方案（分三批）

| 批 | 内容 | 为什么这个顺序 | 门禁 |
|---|---|---|---|
| **A（P0 静默面）** | G4 / G5 / G7 / G3 | 这四条会**静默产出错误产物**，且都在 lockfile 与 runtime 组装链路上——越晚做，越难区分「新引入的差异」与「早就存在的差异」 | `harness-lockfile` / `release-assets` / `fast --no-cargo` |
| **B（P1 判据面）** | G1 / G2 / G6 / G10 + §3.2 的 peer 派生规则 | 都是「补上一条本来就该有的断言」，不需要新的组装流程 | `doc-facts` / `harness-tree`（需组装树，标待 CI）/ `patches` |
| **C（P2 卫生）** | G5b / G8 / G9 / G11 / G12 | 收益是排障清晰度，不是正确性 | `fast` |

**每批的取证要求（沿用本仓纪律）**：

1. **红→绿成对**：同一条命令、同一棵树，只改被测变量；并附**可伪证性**（消掉夹具缺陷必须转为绿）。
2. **空集不得冒充通过**：新增检查在主流程扫到 0 项时必须打印「空集」，不得静默 exit 0。
3. **取不到上游的守卫**（G11/G12）用**本地 stub registry**做白盒对照（路径固定为
   `/-/package/@deepseek-ai%2Fdsh/dist-tags`，可用 `DSH_REGISTRY` 指向 stub），
   这也是 2026-10-10 修漂移哨兵时用的方法。
4. 改 `docs/` 后同跑 `claims` / `plan-facts` / `doc-facts`。

---

## 5. 明确不做

| 不做 | 理由 |
|---|---|
| 把判定基准换回「全局最新 Release」 | 已实测证伪（跨线误报，且双通道下会长期常驻红灯，违反 ADR-030 的取舍） |
| 在 Release 基准上「按线」分桶 | 两个候选判据都被真实数据证伪（「dist-tag 值 ≤ R 的最大者」在指针越过旧 Release 时判错；「同 (major,minor)+同阶段」会把 alpha 线真实轨迹 `0.1.7-alpha.2 → 0.2.1-alpha.1` 判成不属本线） |
| 让 `+<w>` 承担排序 | 违反 SemVer 规范；本栈今天能排是 `Ord` 含 build 的**实现细节**，升 `semver 2.x` 会静默失效 |
| 回填历史 tag 进台账 | 会把「上游标识符」与「本仓序号」混进同一字段且此后无法区分 |
| 自行 pin 上游传递依赖的漏洞包 | 已裁定跟随上游（checklist §6 第 4 条） |
| 把规则 3（peer）塞进 fast/ci | 它需要树内 `semver` 与组装树；覆盖点是**发布链路**——那正是「锚点推进致漂移」发生的流程 |
| 为 G11/G12 引入「上游线」的启发式判据 | 那就是在替上游发明一层语义；宁可「提示」也不要一个会静默走错的判据 |

---

## 6. 一页速查

```
变化类型：A 版本号(6) · B 发布/分发面(4) · C 依赖树(5) · D 运行时(3) · E 数据源形状(3)
三产地：  目标表(目录/锚点/后缀/线) · 台账(精确版本→patchTarget/n/w/合成号) · 写入面(组装)
三视角：  判定=线指针 | 组装=精确版本 | 发布=版本后缀        ← 互不替代（R1）
映射：    上游 → 本仓 单向；禁止 桌面号/目标键 反推（R2）
判据：    「上游最新」必须带线维度（R3）
兼容：    peer 由目标表派生 · 区间上界带 -0 · lock registry 单一 · Node 三数交叉 · Cargo 发布档判红
出口：    判不了⇒红 | 取不到⇒SKIP+未核对 | 名字不存在⇒红(配置缺陷) | 降级⇒留痕
施工：    A(P0 静默) → B(P1 判据) → C(P2 卫生)，每批红→绿成对 + 空集不冒充 + stub 白盒
```
