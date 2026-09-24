# 发布通道重构计划：正式版 / 测试版 / 开发版三通道对齐上游版本控制

> 状态：**部分已落地**。批次 1a / R1 已完成，其余待开工；本文是计划，不是既成事实。
> 范围：版本号语义、tag → 上游运行时的派生、发布门禁、更新源、宣称与文档。
> 不在范围：补丁分级机制本身、CI 触发策略重构、签名/公证流程改造。
>
> **阅读顺序**：先读 §2（主路径及其批次依赖），它决定其余部分的可用性判据；§1 是事实底账，可作查询用。

---

## 1. 为什么要动：核对到的事实

每条都带**取证命令**——重跑一次即可判定它今天是否还成立。

⚠️ 事实会过期。本文已在两处栽在同一个形态上：**依据记忆或早先的读盘结果写「现状」，而不重读仓库**。一次是 `harness-locks/` 的存在性（后被提交 `3f3c46c` 推翻），一次是把一件已完成的事（CLI 发布通道退役，HEAD = `64cdd7b`）写成待施工项。因此：**任何一条事实在被当作依据之前，先跑它的取证命令。**

| # | 事实 | 证据 | 对发布流程的后果 |
|---|------|------|----------------|
| F1 | 上游三个 dist-tag：`latest`=0.1.5-rc.3、**`next`=0.1.7-rc.1**、`alpha`=0.1.7-alpha.2 | `npm view @deepseek-ai/dsh dist-tags`（**2026-09-24 复测**） | 🔴 **`latest` 与 `next` 已分叉**（原表述「两者指向同一 rc」已过期）。上游没有真正的 stable 线这一条仍成立；但 D2/D4 的日常形态随之改变——**「正式版钉旧 rc、测试版跟新 next」成为常态**，D4 的分支条件（版本分叉）已被激活。详见 [`docs/risk-review-release-channels.md`](risk-review-release-channels.md) §2 |
| F2 | 本仓只有 `next` / `alpha` 两条通道 | `scripts/dsh-targets.mjs:59-73` | 无「正式版」这一等公民 |
| F3 | 无后缀版本号（正式版）**回落到默认目标 `next`** | `scripts/dsh-targets.mjs:143-147` | 发「正式版」= 悄悄捆一个上游 rc，Release 正文与产物都不声明这件事 |
| F4 | ~~`harness-locks/` 不存在，打任何 tag 都会三平台全红~~ **已过期**：两条通道的锁文件现已提交。真正的残留缺口是**键与新鲜度**：锁文件当时按 `target` 命名，且两份都锚在落后版本。现已按精确版本键重建（见批次 1a） | `git ls-tree HEAD harness-locks` + 读 `inputs.json` 的 `dependencies['@deepseek-ai/dsh']`；CI 硬失败逻辑在 `scripts/prepare-harness.mjs:399-411` | 发布不再被「没有锁」卡住；但**每推进一次锚点就必须重生成一次锁**（`next` 线在线解析约 40 分钟 / 8 GB 堆）。此项已闭环 |
| F5 | 两条通道锚点均落后上游，且哨兵只提示不阻断 | 实跑 `npm run verify:drift`（两条都 ⚠️） | 「对齐上游版本控制」必须包含一次真实升级 + 补丁移植，否则只是改文档 |
| F6 | 更新源单端点 `releases/latest/download/latest.json` | `src-tauri/tauri.conf.json:21-24` | `releases/latest` 天然排除 prerelease ⇒ **预发布通道的用户永远收不到自动更新**，只能手工重装 |
| F7 | `increment()` 一律丢弃预发布后缀；`bump auto` 只认 major/minor/patch | `scripts/version.mjs:100-109` | 表达不出「0.7.0-alpha.5 → alpha.6」与「0.8.0-rc.2 定稿为 0.8.0」。历史 12 个 tag 里 6 个预发布全靠手工 `version.mjs set` |
| F8 | 「通道」一词在文档里有两种含义（上游运行时通道 / 桌面发布通道），且 stable-preview 约定至今未开工 | `docs/dev-plan-0.2-hardening.md` §A3（标 ❌ 未开工）、`README.md:235-244` | 不先把两个概念拆名，三通道文档会互相指错东西 |
| F9 | **桌面版本与上游版本是多对一关系**：`v0.6.0-alpha.2`、`v0.7.0-alpha.1`、`v0.7.0-alpha.2`、`v0.7.0-alpha.4` 四个连续桌面版本捆的都是 DSH `0.1.6-alpha.2`，**发生在 3.8 天内**（09-18 15:12Z → 09-22 10:40Z，`published_at`） | `gh api repos/.../releases` 逐条读正文「内置运行时」横幅 + `published_at`；上游 `0.1.6-alpha.2` 发布于 09-17 13:52Z、下一个 `0.1.7-alpha.1` 在 09-22 06:23Z（`npm view @deepseek-ai/dsh time`） | 「壳层独立修 bug 但要复用同一个运行时」是**已经发生过的常态**，不是理论可能。任何「桌面版本 == 上游版本」的模型都发不出这三次修复；且这四次发布全部落在**同一个上游空窗（4.7 天）**里 |
| F10 | 上游**没有任何 GitHub Release**（`releases/latest` 返回 404），只有 `dsh-v*` 形式的 git tag（`dsh-v0.1.7-alpha.2` …）；npm 的 dist-tag 是唯一权威的「哪条线」信号 | `gh api repos/deepseek-ai/deepseek-harness/releases/latest` → 404；`.../tags` → `dsh-v` 前缀清单 | 「上游 release 未发布则不得发布」这类不变量只能落在 **npm 精确版本存在性**上，且 tag 名要加 `dsh-` 前缀映射，不能假设与我们的 tag 同名 |
| F11 | 上游空窗期**不是几天，最长实测 12 天**：`0.1.5-rc.2`（09-10 14:57Z）→ `0.1.5-rc.3`（09-22 05:55Z）之间上游 rc 线零发版；alpha 线同期是 09-15 → 09-17 → 09-22 | `npm view @deepseek-ai/dsh time`（2026-09-23 实测） | 这是对 F9 的关键补充：**模型 B 下壳层 hotfix 的最坏延迟 = 上游下一次发版的间隔，历史观测最大值 12 天**（不是「几天」）。D0 的代价对比以此为准 |
| F12 | **`dsh-host-cli` 已退出发布资产（commit `64cdd7b` = 当前 HEAD）**。退役的只是「对外发包」这一层：`crates/dsh-host-cli`、`scripts/package-cli.mjs`（含 `verify:cli-package`，仍在 preflight 跑）、本地打包能力**全部保留**；`scripts/dry-run-cli-publish.mjs` 已归档 | `release.yml` 的退役注释块；AGENTS.md §1 该条目；`docs/dev-plan-cli-distribution.md` §5；ADR-045 「后续」段 + ADR-047；`scripts/verify-release-workflow.mjs` 的 `checkCliArtifactShape`（断言那两个 job **不得存在**，是防复活守卫） | 一次完整发布的期望资产数是 **13** = 9 平台安装包 + 1 `latest.json` + **3 个 Windows 便携版**。⚠️ 便携版**不在**退役范围内（见 F14）。本计划后续批次**不得再为 CLI 设计任何门禁、清单或产物声明**，也不得把 `checkCliArtifactShape` 当成「待清理的旧守卫」。⚠️ 但**这个数字目前兑现不了**，见 F13 |
| F13 | 🔴 **便携版的上传路径在退役 CLI 时被连带删除（当前 HEAD 的真实缺陷）**：便携版的「下载 workflow artifact → `--verify-download` 核验 → `gh release upload` 上 Release」三步一直住在 `cli-publish` 里，该 job 被删时**一并删掉了它们**，而没有搬家。现在 `portable` job 只 `upload-artifact`，全流程**没有任何一处**再执行 `gh release upload`，而 AGENTS.md §8.5 与 `release.yml` 的退役注释块仍写着「期望值 13 = 9 安装包 + `latest.json` + **3 便携版**」 | `git show 64cdd7b -- .github/workflows/release.yml` 里被删的 `publish CLI + portable artifacts` job（含 `pattern: portable-windows` 下载与便携版 manifest 核验）；`release.yml` 现存步骤清单；`grep -n "portable" scripts/verify-release-workflow.mjs` → 只有注释，**没有任何判据** | 下一次发布会安静地少 3 个资产：**所有门禁全绿**（`checkCliArtifactShape` 只断言 CLI job 不得存在，不管便携版），只有人去 Release 页按清单数才发现。这是「被前置失败/搬家掩盖的潜伏缺陷」家族的又一例——**删一个 job 前要先数它承载了几类职责**。修复见批次 4 |
| F14 | 便携版与 `dsh-host-cli` 是**两类产物**：前者是桌面应用的一种交付形态（免安装 zip，用户直接用），后者是仓内诊断/故障注入工具。F12 的裁定范围**只含后者** | AGENTS.md §1 两条目 + `docs/dev-plan-cli-distribution.md` | 任何「顺手把便携版一起摘掉」的改动都属越界。本计划把便携版的发布恢复为**发布形态的一部分**，并给它配上前向缺失即判红的守卫（批次 4） |

---

## 2. 主路径：壳层连发多版（上游锚点不动）

**这是本计划最高频、也是必须最先被打通的那条路径。** 读本文其余部分之前先读这一节——它决定后面所有批次的可用性判据。

「同步上游版本号」与「壳层出问题要连着发几版」在这个模型里是**两个正交的轴**，各由一个命令独占，互不改对方的字段：

| 轴 | 命令 | 改动 | 不改 |
|---|---|---|---|
| 运行时锚点 | `npm run version:anchor -- set <dshVersion>` | `dshVersion`、lockfile 键、MANIFEST 的 `dshVersion`/`lockfileHash` | `package.json`/`Cargo.toml`/tag（批次 3 有断言钉死） |
| 壳层版本 | `npm run version:bump -- prerelease <channel>` | `desktopVersion` 的预发布计数（`rc.1 → rc.2`）、CHANGELOG 段 | `dshVersion`、`lockfileHash`、`patchSetHash` |

一次典型的「同一上游版本内连修三版」是可执行序列：

```bash
# 0. 一次性把锚点对到上游真实存在的版本（CH-4/CH-5 联网核验在这一步做）
npm run version:anchor -- set 0.1.5-rc.3      # 只写锚点与 lockfile 键，不产生发布

# 1..N. 每次壳层修复走同一循环，锚点从头到尾不再出现
npm run version:bump -- prerelease rc --dry-run   # 0.8.0-rc.1 → rc.2 → rc.3
npm run version:bump -- prerelease rc --commit --tag
git push origin main --follow-tags                # tag 推上去即触发 release.yml
```

配套机制：

- **装配复现**：`dshVersion` 不变 ⇒ `harness-locks/0.1.5-rc.3/` 那一份锁**一次都不重新生成**，`npm ci` 零解析、三平台同一棵树；`prepare-harness --check` 在每个 build job 里断言「还是那棵树」。**连发多版反而是最省事的形态**——没有 40 分钟的在线解析。
- **「运行时没动」要有机器可核的证据，不靠人记**：`(dshVersion, lockfileHash, patchSetHash)` 三个字段在 `rc.1 → rc.2 → rc.3` 之间必须**逐字节相同**。这是 CH-3 身份元组在这条路径上的直接推论。
- **对外要说清楚**：三处声明（Release 正文三行、`MANIFEST.json` 身份行、反馈页 `feedback_context`）都显示「内置运行时 `0.1.5-rc.3`（本次未变）」。读者从 `rc.1 → rc.2` 应当读出「壳层改了东西、DSH 没换」，而不是反过来猜。
- **更新链路**：`rc.1 < rc.2 < rc.3` 是严格递增的 semver，滚动 release `channel-rc/latest.json` 每次都被覆盖成新指针，已装 `rc.1` 的机器能连续收到两次更新。stable 端点 `releases/latest` 不受影响，prerelease 天然进不去（既有断言）。
- **CHANGELOG 区间**：`--from` 是上一个 tag，因此每版正文只写**这一次壳层修了什么**，不会把 `rc.1` 的内容重复进 `rc.2`。

### 2.1 这条路径的可用性依赖哪些批次（**避免被埋没的关键映射**）

上表两行命令在计划开工前**都不存在**。下表把这条路径拆成最小可用集，并逐项标出缺了它会退化成什么——**实施时按这张表判进度，而不是按批次的自然序号**：

| 路径所需能力 | 落在哪一批 | 缺了它的后果（退化成什么） |
|---|---|---|
| `anchor set`：锚点可显式操作且不动桌面版本号 | 批次 3 | 锚点仍隐式写在 `dsh-targets.mjs` 的表里，改锚点＝手改表；「连发」这一步无从表达 |
| `bump prerelease <channel>`：预发布计数可推进 | 批次 3 | 只能手工 `version.mjs set`（历史 12 个 tag 里 6 个预发布都是这么来的，F7） |
| 「锚点不动」有断言钉死（`anchor set` 不得写 `package.json`/`Cargo.toml`） | 批次 3 | 两轴会互相污染，「壳层小修」可能顺手改掉运行时锚点 |
| `patchSetHash` / `lockfileHash` / `dshVersion` 三字段逐字节对照 | 批次 R2（落盘）+ 批次 3（判红逻辑） | 「运行时未变」只剩口头说明，无人可核 |
| 同一通道内相邻两版的三字段一致性门禁 | 批次 3 | 补丁集被改却伪装成壳层 hotfix 也能发出去 |
| 滚动端点 `channel-<x>/latest.json` | 批次 5 | `rc.1` 装了收不到 `rc.2`，回到今天「预发布用户手工重装」的形态（F6） |
| `MANIFEST` 记全身份元组并落进三处声明 | 批次 R2 | 用户与取证者看不出「DSH 没换」 |

**最小可用集 = 批次 3 + R2 + 批次 5。** 这三项之外都是改善（门禁更严、声明更全），缺任一项则该路径**不成立**：

- 缺批次 3 ⇒ 连发的动作本身无法执行；
- 缺 R2 ⇒ 连发可执行但「运行时未变」不可核；
- 缺批次 5 ⇒ 连发出来的版本对预发布用户不可达。

⚠️ **实施顺序上的推论**：批次 5 是本路径的**组成部分**而非可选项。若因风险想分批交付，可以先把批次 5 做成「只对 alpha 生效」，但不能把它整体后置——§9「明确不做」里的边界（不做 per-channel 分支等）不变，变的是**这条路径的完成时点**。

### 2.2 四种边界情况的处置

1. **同一个 bug 横跨 rc 与 alpha 两条通道** → 修两次、bump 两次、发两个 tag（`0.8.0-rc.4` 与 `0.9.0-alpha.2`）。不为「一次修两通道」发明复合 tag：通道是从后缀单派生的（CH-2），一个 tag 只能属于一条通道。
2. **要下发给已装 stable 的用户** → 只能出 `0.8.1`（stable patch bump），锚点仍是 `0.1.5-rc.3`。这就是 D2 允许「正式版捆上游 rc」的场景之一，声明横幅必须出现。
3. **连发途中上游发了新版** → **不自动跟进**。锚点只在人敲 `anchor set` 时才变，Sync PR 自动化（批次 R3）只负责把候选送到门口。否则「壳层 hotfix」会顺带捆进一整套未经评估的上游变更。
4. **连发中 `lockfileHash` 或 `patchSetHash` 变了** → 说明这**不是**壳层 hotfix，是一次运行时/补丁集变更，必须走升级清单并重跑两条通道的 `scope=full` 冒烟，不得伪装成一次小修。

> 📌 **判据**：这条路径不是推演——`v0.7.0-alpha.4 → alpha.5 → alpha.6 → alpha.7` 四次发布同捆一个上游版本（F9），用的就是「锚点不动 + 只 bump 预发布计数」。本计划相对现状的增量只有两点——**锚点从「隐式写在 `dsh-targets.mjs` 的表里」变成 `anchor set` 可显式操作的字段**，以及**「运行时未变」从口头说明变成三处声明 + 一个反向门禁**。

---

## 3. 目标模型

**版本号 = 列车 + 阶段。** `X.Y.Z` 这段 base 唯一标识「哪一列车」，预发布后缀标识「这列车走到哪一步」，后缀同时决定捆哪条上游运行时——不需要在 tag 之外再声明一次通道（沿用 F2/F3 已有的派生机制，只是扩到三值）。

| 通道名 | 中文 | 版本号形态 | tag 示例 | 跟随上游 dist-tag | GitHub Release | 更新源端点 | 定位与准入 |
|--------|------|-----------|---------|------------------|----------------|-----------|-----------|
| `stable` | 正式版 | `X.Y.Z` | `v0.8.0` | `latest` | 非 prerelease | `releases/latest/download/latest.json`（现状） | 只能从同 base 的 `rc` 晋升；锚点必须**恰等于**发布当时的 npm `latest` |
| `rc` | 测试版 | `X.Y.Z-rc.N` | `v0.8.0-rc.1` | `next` | prerelease | `releases/download/channel-rc/latest.json` | feature freeze 后的候选版本，捆上游 rc 阶段 |
| `alpha` | 开发版 | `X.Y.(Z+1)-alpha.N` | `v0.9.0-alpha.1` | `alpha` | prerelease | `releases/download/channel-alpha/latest.json` | 新特性唯一入口；落后上游只记录不阻断 |

### 3.1 列车与晋升规则（要能被判据校验，不只是散文）

1. **新特性只进 `alpha`**，且 alpha 跑在**下一个 base**（stable 在 0.8.0 时，alpha 是 0.9.0-alpha.N）。
2. **`alpha → rc` = 冻结 + 晋升**：同一 base，内容来自 alpha 某个已验证版本；补丁集按 `patches/<channel>/` 移植并重算行号。
3. **`rc → stable` = 定稿**：只允许 fix，不允许新特性；运行时锚点从 `next` 切到 `latest` 并要求恰等（见裁定 D2）。
4. **hotfix 从 stable 落，向前回灌** `rc` / `alpha`；不允许某个修复只存在于中间通道。
5. 三条通道**都从 `main` 打 tag**，不引入 per-channel 分支模型。

### 3.2 两个「通道」概念改名定案（消 F8 的歧义）

- **发布通道（release channel）** = 桌面版本号后缀 = `stable` / `rc` / `alpha`，是对外语义。
- **运行时线（upstream line）** = 上游 npm dist-tag = `latest` / `next` / `alpha`，是内部装配语义。
- 二者在 `dsh-targets.mjs` 里拆成 `channel`（对外后缀）与 `distTag`（对上游）两个字段，**不再被迫同值**。这是本计划的结构性改动，改名只是它的副产品。
- **内容边界**：`patches/` 按通道为**作者区**，但「这一版实际打了哪一套补丁」不能由目录名承担——相邻上游预发布版本的补丁集常只差 1~2 条，按版本全量铺目录会产生多棵近乎相同的树。故冻结方式取**内容哈希**：`patchSetHash` 在组装那一刻算定、写进 `MANIFEST`。细节见批次 R1/R2。

### 3.3 不变量

| 编号 | 不变量 | 落点（谁能校验它） |
|------|--------|------------------|
| CH-1 | `tag == package.json == Cargo.toml == tauri(继承)` | 已有：`version.mjs check --tag` |
| CH-2 | **channel 只从版本号派生，不得独立存储**（既不在 tag 之外声明一次，也不写进配置文件） | 已有 `--channel-of`；新增 `verify-release-workflow` 断言不存在第二处通道声明 |
| CH-3 | 每次发布的 `(desktopVersion, dshVersion, channel, upstreamTag, lockfileHash, patchSetHash)` 必须**全部**落进 `MANIFEST.json` | 批次 R2 |
| CH-4 | 运行时锚点必须是**上游真实发布过的精确版本**（npm 上存在该版本；不是浮动的 dist-tag 解析结果） | 批次 R1 + preflight 联网核 |
| CH-5 | 上游未发布对应版本 ⇒ 该次发布不得存在（即禁止「我们自己凭空造一个版本号」） | preflight：`npm view @deepseek-ai/dsh@<锚点>` 必须命中 |

**明确不采纳**的三条：`DESKTOP_VERSION === DSH_VERSION`、`GIT_TAG === v${DSH_VERSION}`、`RUNTIME_VERSION === DESKTOP_VERSION` —— 反证见 §4-D0 的 F9。

**CH-4 / CH-5 的网络健壮性口径**：`npm view` 一类联网核验必须区分三种结果，而不是笼统「查询失败就放行」：

| 结果 | 判定 | 处置 |
|---|---|---|
| registry 明确返回「该版本不存在」（404 / `ETARGET`） | 硬事实 | 🔴 阻断发布（CH-5 本意） |
| 网络类失败（超时 / 5xx / DNS） | 环境噪声 | 重试 3 次（指数退避）；**仍失败则阻断**，错误信息里写明「未能核验，请人工确认 registry 状态后重跑」 |
| 核验通过 | — | 把「核验时刻 + 返回的 `dist.tarball` sha」写进 preflight 日志与 MANIFEST |

- ❌ **不给「降级通过」**：放行等于**发出一个可能捆着不存在运行时的包**，而 AGENTS.md §7.1 规则 3 不允许无声降级——降级至少要写进产物并出现在 Release 正文，那与阻断的收益差距太小。
- 误阻塞的代价（重跑 `workflow_dispatch` 同一个 tag，几分钟）明显小于错发布的代价（用户装到一个运行时对不上号的包，且 updater 会把它当更新推下去），因此这条门禁一律偏保守。

### 3.4 为什么保留「桌面版本列车」（对「并轨上游」的正面回答）

质疑的核心是：**D2 / D4 / D1 这三个决策全都只是因为「桌面有独立版本列车」才存在的**，把列车砍掉，三个问题一起消失。这个判断是对的。

但列车砍不掉，因为 F9：**四个连续桌面版本捆同一个上游版本**。桌面版本号承载的是「壳层 + 装配 + 补丁集」的变更，这三样都会独立于上游前进（本仓最近三次桌面发布的内容是 WebView2Loader 判据、portable 打包 shell、npm 堆上限 —— 一行上游代码都没动）。

于是只剩两条路：

1. **保留列车**（本计划）：代价是 D2/D4 两条特例必须存在并被写清楚。
2. **并轨到上游版本**：代价分两档，必须如实区分——
   - 严格档（`Desktop Version == 上游 Version`）：**壳层 hotfix 无版本号可发**。同版本号重发时 Tauri updater 按 semver 比较不会认为它是更新，`build` 元数据（`+dsh-desktop.3`）在比较里被忽略，NSIS 也不覆盖同版本；要发出去就得偷偷改一个数字，那正是「通道参与版本创建」。
   - 退一档（「等上游发新版时一起发」）：代价从「发不出」降级为**「延迟发」，且延迟完全由上游决定**——F11 实测上游 rc 线空窗 **12 天**（`0.1.5-rc.2` 09-10 → `rc.3` 09-22），而 F9 那四次发布全挤在一个 4.7 天的空窗里。对「装得上、起不来」这类崩溃级缺陷（`0xC0000135` 是真实事故），等 12 天不可接受。

故取第 1 条。第 2 条的代价不是理论推演：它就是 F9 那三次发布在模型 B 下的命运。

> 📌 若将来上游进入稳定节奏、且不再需要独立于上游出包，可以重开第 2 条；**前置条件**是先解决「同版本重发」的更新语义，否则不可迁移。

---

## 4. 已裁定项与被否方案（供比对）

### D0 版本模型：A 桌面版本列车（裁定）vs B 上游版本即桌面版本

B 方案：`Desktop Version == 上游 DSH Version`，tag 直连上游，channel 纯派生，`dsh-targets.mjs` 退休。逐条比对：

| 维度 | A（本计划） | B（并轨上游） |
|------|------------|--------------|
| 用户看到几个版本号 | 两个（桌面 0.8.0 / 内置 DSH 0.1.5-rc.3），需正文与 MANIFEST 声明 | 一个，Issue 里不会记错 |
| 壳层 hotfix（不动上游） | ✅ 有版本号可发（F9 已发生 4 次） | ❌ **无合法版本号**：同版本重发不会被视为更新（semver 比较 + `+build` 被忽略） |
| ↳ 若退一步「等上游发新版时一起发」 | 不涉及 | ⚠️ 不是发不出，而是**要等**。等多久由上游决定——F11 实测空窗 **12 天**，期间三次壳层修复（WebView2Loader 判据 / portable shell / npm 堆上限）都得压着。对启动即 `0xC0000135` 静默崩溃这类缺陷，12 天不可接受 ⇒ 结论不变，但**代价按「延迟」而非「无法发布」如实记** |
| 上游快速迭代期（近 3 周 6 个版本） | 我们挑能构建的版本发，其余跳过 | 同样只能跳，但跳过期间连壳层修复也发不出去 |
| 正式版能否先于上游 stable | 能（D2 因此存在，须如实声明） | 不能，「没有 DSH stable 就没有 Desktop stable」——这是 B 最干净的地方 |
| 补丁/锁文件目录键 | 精确版本键（批次 R1） | 精确版本键（天然） |
| 与既有 12 个 tag 的连续性 | 连续（0.7.0-alpha.5 之后 0.8.0-rc / 0.9.0-alpha） | ❌ **版本号倒退**（0.7.x → 0.1.x），老用户 updater 永远收不到，必须手工重装一次 |
| 上游 tag 形态 | 无关 | 需 `dsh-` 前缀映射，且上游**没有 GitHub Release** 只有 tag（F10），「对齐上游 Release」这个说法在对象上并不成立 |

- ✅ **裁定：取 A**，同时吸收 B 的三点：锁文件按精确版本键、MANIFEST 记全身份元组、上游发现做成「同步 PR 而非自动发布」（批次 R1/R2/R3）。
- ❌ **否 B 的理由**：唯一但致命——它让「壳层修了 bug」这件事没有发布通道。B 换来的简洁是真的，但它买走的正是本仓**最高频**的那类发布（即 §2 那条路径）。

### D1 测试版后缀：`rc`（裁定）vs 保留 `next`

- ✅ **裁定：`rc`**，理由：与上游实际阶段（rc）语义一致，对外可读；`0.8.0-rc.1 → 0.8.0` 的晋升关系一眼成立。
- ❌ 保留 `next`：改动最小（无历史别名、无目录更名），但「next」在用户读来是「下一个版本」而非「候选版」，与三通道定位冲突。
- ⚠️ 采案的代价（必须一起做，见批次 2）：
  - 现存 `v0.5.0-next.1` 与已安装包 `MANIFEST.json:target="next"` 要能被解析 ⇒ `resolveTarget` 接受 `next` 为**已弃用别名** → `rc`，但**新 tag 禁用旧名**（preflight 判红）。别名作用域**只读**（读历史 tag / 已装包 MANIFEST），不得出现在任何新写入路径里——删掉别名等于让已装 0.5.0-next.1 的机器读不出自己的运行时线。
  - 现有两条自测**故意**把 `rc` 判为非法通道（`scripts/dsh-targets.mjs:219` 断言 `targetForVersion('0.5.0-rc.1') === null`；`scripts/verify-upstream-drift.mjs:254` 只认 `latest/next/alpha`）。这两处属**前提变更**，不可当成笔误顺手改掉。

### D2 上游 `latest` 是 rc 时能否发正式版：允许 + 如实声明（裁定）

- ✅ **裁定：允许**，preflight 硬要求锚点 == 当时 `latest`；Release 正文横幅与 `MANIFEST.json` 必须写明「内置运行时 `0.1.5-rc.3`（上游 `latest`，处 rc 阶段）」。
- ❌ 严格阻塞（上游必须先是正式 semver 才准发 stable）：口径最干净，但**当前直接后果是发不出正式版**，且阻塞条件完全在上游手里。
- ❌ 允许且不标注：与 AGENTS.md §7.1 的宣称纪律冲突（不得让读者以为捆的是正式版运行时）。

### D3 分通道自动更新：本次一起做（裁定）

- ✅ **裁定：三通道都自动更新**，否则「三通道」对用户只等于「三个下载页」，测试版/开发版仍要手工重装（F6）。**这也是 §2 主路径成立的前提之一。**
- ❌ 只做通道模型、更新源后置：风险最低，可先验证模型本身；被否是因为 F6 是可感知的功能缺口，拆开后容易长期搁置。
- ❌ 永久只让正式版自动更新：简单，但等于放弃预发布通道的用户反馈闭环。
- 方案要点（批次 5）：**滚动 release 承载清单**，不自行合并 JSON。
  - 新建两个长期存在的 prerelease：`channel-rc`、`channel-alpha`；每次发布把该平台构建产出的 `latest.json` 以 `--clobber` 覆盖上传到对应滚动 release。
  - 清单里的 `url` 字段指向**真实版本 tag 的资产**（`releases/download/v0.8.0-rc.1/...`），所以滚动 release 只托管 JSON，不需要跨平台合并逻辑，也不需要改 `tauri-action`。
  - 应用侧按**自身版本号后缀**选端点（`app.package_info().version`），**不新增构建期配置、不加命令行开关**——后缀已经是通道的唯一产地，再加一处声明就会有两处可能不一致的真相。

### D4 stable 的补丁集：与 rc 版本相同则复用（裁定）

- ✅ 裁案：`stable` 在 `dshVersion` 与 `rc` **逐字相同**时复用 `patches/rc/`；一旦两线版本分叉，必须存在 `patches/stable/`，否则 preflight 判红。
- ❌ 三条通道各一份目录：模型最一致、无例外分支，但今天 `latest`==`next` 意味着**手抄 14 个逐字节相同的补丁**，且每次同步升级都要改两份。
- 复用的例外必须显式（别名复用只由「版本相同」派生，不允许手工指定），否则就是 F3 那类「静默捆错运行时」的新变体。


---

## 5. 实施批次

每批独立可验、独立可提交。**打 tag 前仍需人工过 CI + Smoke 两轮**（AGENTS.md §8.5 第 2 步），但这不再是本计划的额外前置——仓库当前**没有已知的发布阻塞项**（F4 已失效，见 §1）。

**验收写法约定**（全文统一，适用于 §5 与 §6）：

- 每条验收都必须是**可伪证的**：给出「打回旧写法 ⇒ 必须变红」的构造。只写「全绿」不算验收。
- 负向构造与正向样例**成对出现**，且**期望值硬编码为独立事实**，禁止用被测函数现算（否则判据改错时期望值跟着错，双向失效）。
- 不写「人工确认」「自行验证」这类无判据的条目；确需人看的，必须写明**看什么字段、期望什么值**。

---

### 批次 1a — 锁文件新鲜度与换键迁移 ❌ **待办（曾被误标为「已完成」）**

⚠️ 本节状态于 2026-09-24 由「✅ 已完成」改回「**待办**」。误标的原因是把「计划里描述过」当成了「仓库里已完成」——与 §1 开头承认的「不重读仓库就写现状」是同一形态。**实测反证**：

```text
$ ls harness-locks/        → alpha  next          （仍是通道键，未换成版本键）
$ ls patches/              → LAYERS.md alpha next （patches/next → patches/rc 未发生）
```

要做的是两件事：

- **换键迁移**：`harness-locks/next/` → `harness-locks/0.1.5-rc.2/`、`harness-locks/alpha/` → `harness-locks/0.1.6-alpha.2/`（与批次 R1 同一批改动做，避免动两次目录）。通道名从此只是「读哪个版本键」的入口。
- **补新锁**：为三条通道的锚点各备一份锁（`stable` 与 `rc` 同版本时同源，不重复生成）。若 1b 已批准，则直接生成推进后的版本，旧版本锁保留用于重建历史包。
- 目录更名同步：`patches/next → patches/rc`、`packages/next → packages/rc`（含 `verify:patches` 的目标枚举、`patches/LAYERS.md` 表述）。
- 🔴 **更名最容易漏的雷：`patches/<target>/` 的静默降级（2026-09-24 取证）**。`patches/LAYERS.md`
  的分级策略让 `brand` / `ui-behavior` 层的补丁失败**降级而非中断**。于是「`patchesDirFor` 指到新路径、
  但补丁文件还在旧路径」这种更名半成品会**打出一个能装能跑、只是品牌/UI 补丁全丢的包**，而
  `verify:harness-tree` 只看树健全性、未必看得见某个补丁没应用。这属本仓「被前置失败掩盖的潜伏缺陷」族。
  **对策**：本批次必须新增一条**硬断言**——`patchesDirFor(target)` 指向的目录**必须存在且非空**，
  且「整个补丁目录缺失」**不适用** `LAYERS.md` 的降级策略（那是配置错误，不是补丁冲突）。
  存量物清点（五类，逐项确认）：

  | # | 存量物 | 残留形态 | 失效表现 | 危险度 |
  |---|---|---|---|---|
  | S1 | `src-tauri/resources/MANIFEST.json` | `"target": "next"` | 快速路径断言失配 → 重新组装 300MB（变慢不变错） | 🟠 |
  | S2 | staging 目录 | 目录名含 `next` | 新目录不存在 → 重下载；**旧目录永久残留** | 🟠 |
  | S3 | `packages/next/*.tgz` | 路径含 `next` | 找不到 tgz → **硬失败**（好） | 🔴 |
  | S4 | `patches/next/*.patch` | 路径含 `next` | **静默降级**（见上） | 🔴 **最高** |
  | S5 | `harness-locks/next/` | 目录名 + `inputs.json` 内容 | 按目标推导路径，找不到 | 🔴 |

- ⚠️ **`inputs.json` 缺自证字段（2026-09-24 实测）**：其结构实测为
  `{ "dependencies": { "@deepseek-ai/dsh": "...", "node": "...", "pnpm": "..." }, "overrides": {...} }`，
  **没有任何「这份 inputs 属于哪个目标/版本」的自证**。若它被误复制到另一目标目录，比对会
  **静默按新位置的键值走**。本批次顺带加一个 `target` 字段，与 MANIFEST 的做法对齐。
- **验收（可伪证）**：
  1. `npm run prepare:harness` 在三条通道下都命中 `npm ci` 模式、**不打印「回退在线解析」警告**。
  2. `inputs.json` 的依赖摘要在**另一台机器 / 清空 staging** 后能复算出同一 `lockfileHash`（可复现性自证）。**伪证**：改一条 `inputs.json` 的依赖项 → 重算值必须变化。
  3. `npm run verify:patches` 全绿；`patches/` / `packages/` / `harness-locks/` 下**不留旧通道名残留**（`grep` 命中必须逐条能用「读历史/别名」解释）。
  4. **不复现本次误标**：本节状态词与实跑结果一致（见 §1 的 P0 事实校验脚本）。
  5. **负向·补丁目录缺失必须判红**（S4 的直防）：令 `patchesDirFor(target)` 指向一个不存在的目录
     → 必须**硬失败**，**不得**因 `LAYERS.md` 降级而放过。这是本批次最重要的一条新判据。

---

### 批次 1b — 锚点对齐上游现值

- `rc`: 0.1.5-rc.2 → rc.3；`alpha`: 0.1.6-alpha.2 → 0.1.7-alpha.2；`stable` 锚到 `latest`。
- 工序走 `docs/dsh-upgrade-checklist.md` 全流程：补丁移植 → `recount-patches` 重算行号 → `check:patch-applicability`（±20 窗口）→ 重生成 lockfile → `report:patches` → 三平台烟雾 → 体积三口径对比。
- ⚠️ 这一批是唯一会真实改变产物内容的一批。若只想要「流程重构」，可先只做 2~6 + R 系列，把 1b 另立一次升级提交。
- 🟢 **锁文件生成成本分摊（2026-09-24 取证：机制**已经存在**，缺口是流程纪律）**：
  在线解析约 **40 分钟 / 8GB 堆**（`npm install --package-lock-only`）。本仓已有全部所需机制——
  `harness:lockfile` 入口、`prepare-harness.mjs` 的 `ci` 模式（复制 lockfile → `npm ci`，**零解析**）、
  CI 上 lockfile 缺失/失配**硬失败**、非 CI 才允许在线解析。所以**不需要新设计**，
  只需把工序写成纪律：**在本地或独立分支生成一次，`package-lock.json` + `inputs.json` 成对提交**，
  此后 release CI 的三处组装（`build` matrix ×3 + `portable`）全部零解析。**一次性成本换三倍收益。**
- 🔴 **顺序硬约束**：本批次（生成 lockfile）**必须在批次 1a 之后**。否则为旧通道键目录生成的
  锁在 1a 改成版本键后**立刻成为孤儿**，还得重跑 40 分钟。同理，生成前须确认
  `dsh-targets.mjs` 的锚点已 `-- set` 到目标版本（实测现状：`next: 0.1.5-rc.2` 硬编码，
  **比上游 `latest` 的 `0.1.5-rc.3` 还旧**；`alpha: 0.1.6-alpha.2` vs 上游 `0.1.7-alpha.2`）——
  否则白跑 40 分钟。
- **验收（可伪证）**：
  1. `npm run verify:drift` 三条通道输出均为 `ok`。**伪证**：把某一通道的锚点在 `dsh-targets.mjs` 里退回旧值 → 该行必须变 ⚠️。
  2. `report:patches` 无 `failed` 条目。**伪证**：故意删掉一条补丁的 `retireWhen` 使其无法应用 → 必须出现 `failed`。

---

### 批次 2 — 通道契约层

- `scripts/dsh-targets.mjs`：字段拆 `channel` / `distTag` / `aliasOf`；键改 `stable` / `rc` / `alpha`；`targetForVersion` 无后缀 → `stable`（**删掉「正式版回落默认目标」这条规则**）；`patchesDirFor` / `packagesDirFor` / `stagingDirFor` 走别名复用（D4）；`resolveTarget` 接受弃用别名 `next`。
- 下游同步：`verify-upstream-drift.mjs` 三通道各自对照自己的 `distTag`；`runtime_manifest.rs` 的身份行能显示 `stable`。
- 🔴 **本批次不需要「清理三平台 CI Cache」（2026-09-24 实测推翻该待办）**。原待办假设了
  `resources/` / `harness-deps/` 被缓存，实测 `release.yml` 全文的缓存面**只有两处**：
  `actions/setup-node@v5` 的 `cache: npm`（键 = `package-lock.json`）与 `Swatinem/rust-cache@v2`
  （键含 `Cargo.lock` + rustc 版本）。**两者都与目标名无关**，更名不动它们，
  **无可清理项**。真正需要做的三条见批次 1a（`patches/<target>/` 存在性硬断言、
  `inputs.json` 加 `target` 自证字段、本机残留的**显式路径清单**清理——不 glob）。
  另注：`actions/upload-artifact@v6` 的 `portable-windows` 是 **artifact 不是 cache**，
  它随保留期自然过期；避免核验时下到旧包的办法是**artifact 名带版本**（已在
  `package-portable.mjs` 的 `portableBaseName(version)` 里）。
- **验收（可伪证，正向 + 负向成对）**：
  1. 正向派生：`0.8.0` → `stable`；`0.8.0-rc.1` → `rc`；`0.9.0-alpha.1` → `alpha`。期望值**硬编码**在夹具里，不由 `channelOf()` 现算。
  2. 负向·映射表恒真检查：**把 `stable` 目标从表里删掉 → 必须判红**。（这一条专治「映射表恒真」：只验正向时，一个把所有输入都映射到同一通道的实现也能全绿。）
  3. 负向·别名方向：`--channel-of v0.5.0-next.1` → `rc`（只读别名生效）；**新 tag 用 `next` 必须判红**。两条同时成立才算通过——只验前一条会漏掉「别名被写进新路径」。
  4. 负向·回落规则已删除：`0.0.0`（无对应通道）→ 判红。**伪证**：把「无后缀 → 默认目标」那行加回去 → 必须判红。
  5. 未改动即通过：改写 `dsh-targets.mjs:219` 与 `verify-upstream-drift.mjs:254` 两处**旧断言**（它们刻意把 `rc` 判为非法）；**伪证**：保留旧断言 → 必须红。

---

### 批次 3 — 版本号推进语义（**§2 主路径的最小可用集之一**）

- `scripts/version.mjs` 新增：`bump prerelease <channel>`（`0.9.0-alpha.3 → alpha.4`）、`bump promote <channel>`（`0.8.0-rc.2 → 0.8.0`，校验 base 与来源通道一致）、`auto` 保留且只服务 stable；**拒绝**任何会静默丢后缀的推导。
- **新增 `anchor set <dshVersion>`**：只做「把运行时锚点对齐到某个上游精确版本，并同步 lockfile 键 / MANIFEST 字段」，**不动桌面版本号**。它与 bump 是两件事——一次上游同步常常不产生新的桌面发布（要产生时才 bump），这正是 F9 的多对一关系。`anchor` 管对齐上游，`bump` 管出壳层的版本。
- `scripts/changelog.mjs` / `conventional-commits.mjs`：段落标题带通道；预发布区间的变更日志不得与正式版互相覆盖。
- **壳层连发的反向门禁**（§2 那条例外的守卫）：`bump prerelease` 在推进 `desktopVersion` 时，**不得**触碰 `dshVersion` 锚点；而 `lockfileHash` / `patchSetHash` / `dshVersion` 三字段在**同一通道内相邻两次发布**之间必须逐字节相同，不同即 `verify:version` 判红并提示「这不是壳层 hotfix，请走升级清单」。
- **验收（可伪证）**：
  1. `bump prerelease rc` 出现 `0.8.0-rc.1 → rc.2`；**伪证**：断言结果里预发布后缀**未被丢弃**（旧 `increment()` 会丢，F7）——用旧实现跑同一条夹具必须变红。
  2. `bump promote rc` 出现 `0.8.0-rc.2 → 0.8.0`；**负向**：`bump promote rc` 用于 `0.9.0-alpha.2` → 判红（来源通道不符）。
  3. **`anchor set` 不得改动 `package.json`/`Cargo.toml` 版本**：有断言钉住，且**配可伪证夹具——让它写版本号必须判红**。
  4. **两轴互不污染**：`bump prerelease` 前后 `dshVersion` 逐字节相同；**伪证**：手工把 `anchor set` 的执行混进 bump 路径 → 必须红。
  5. **三字段一致性门禁**：改一条补丁内容后 bump → 必须红（三字段不一致）。**反向**：不改补丁只 bump → 必须绿。两条成对，缺一即无效。
  6. `--dry-run` 输出与真实写入一致：**伪证**——把 dry-run 的写入分支短路一部分 → 两者必须产生差异并被捕获。

---

### 批次 4 — 发布门禁分通道（**含 F13 的便携版发布修复，可先于三通道改造单独执行**）

- `release.yml` preflight：三通道派生 + **分通道强度**——`stable` 硬检锚点 == npm `latest` 并输出 D2 要求的声明横幅；`rc` 落后提示；`alpha` 仅记录。
- Release 正文三行：所属通道 / 内置运行时及其上游阶段 / 该通道的晋升预期（现在只有「内置运行时」一行）。
- `ci.yml`、`smoke.yml` 的 `dsh_target` choice 换三值；`drift.yml` 三通道；`verify-release-workflow` 加三通道形状 + 「旧别名不得用于新 tag」的静态守卫。
- 🔴 **修复便携版的发布路径（F13，本批次唯一的缺陷修复项）**：`cli-publish` 退役时把便携版的「下载 artifact → `--verify-download` 核验 → `gh release upload`」三步一起带走了，于是 AGENTS.md §8.5 那个「期望 13（含 3 便携版）」的口径**目前兑现不了**——文档口径是对的（便携版本就该发），是工作流缺了这一步。补法二选一，**都要连同核验一起补回来**（只补上传等于把「辅助动作否决主结论」换成「产物未经核验就上架」）：
  - 方案 a：`portable` job 内追加「下载自己的 artifact 副本并 `--verify-download`，再 `gh release upload --clobber` 三个文件」，`needs: [preflight, build]`（Release 对象由 `build` 的 tauri-action 创建，必须先于上传）；
  - 方案 b：新建一个 `publish-assets` 小 job 承接（`needs: [build, portable]`），顺带成为 R1 三平台 `patchSetHash` 汇总步骤的新落点——**一个 job 解决两处「原本借住在 cli-publish」**。
  - ✅ **取 b**：R1 无论如何都需要一个 `needs` 三平台的汇总点（见批次 R1），选 a 就要再建第二个 job 干同一件事——两处汇总两处真相。选 b 后便携版上传与哈希核对同址、同一份 `needs` 图。
  - 🔴 **硬阻塞（2026-09-24 实跑发现，方案 b 落地前必须先解）**：`scripts/verify-release-workflow.mjs`
    的 `checkCliArtifactShape` 第 2 条断言是 `if (/gh release upload/.test(code))` **判红**——
    而方案 b 唯一可行的实现就是新增 `gh release upload`。**不先改守卫，本项一提交就恒红。**
    修法：把该断言从「一概禁止」改为**三向判据**（本仓已确立的「注释剥离 + 互补夹具」纪律照旧）：
    ```text
    2a. `gh release upload` 若出现，其参数必须只指向 dist/portable/*
    2b. 不得出现 dist/cli/* 的上传路径（CLI 退役断言保持）
    2c. 不得出现 `cli` / `cli-publish` job（原有断言不变）
    ```
    配**两条互补夹具**：「`gh release upload "$TAG" dist/portable/*`」放行 +
    「`gh release upload "$TAG" dist/cli/*`」判红。判据清单见
    [`docs/optimization-release-channels.md`](optimization-release-channels.md) §3.1。
- ⚠️ **`dsh-host-cli` 的退役不列入本批次施工范围**：它已落地（F12），`release.yml` 里那两个 job 早就不存在，防复活守卫 `checkCliArtifactShape` 已就位。本批次只需要**不把它加回来**。**便携版不在退役范围内**（F14）——它是本批次要修好的对象，不是要摘掉的对象。
- 🔴 **F13 真正的守卫缺席（2026-09-24 实跑发现）**：全仓**没有任何判据断言 Release 的资产数**——
  「期望值 13」只写在 `AGENTS.md` §8.5 里，是纯文档承诺。F13 之所以能潜伏，根因不是「忘了写上传步骤」，
  而是「口径改了、**兑现路径与判据双双缺席**」。故本批次验收须**新增一条资产清单判据**：
  逐项枚举 13 个资产的期望名字（9 安装包 + 1 `latest.json` + 3 便携版），任一缺失判红。
  这条与验收 1（前向守卫）**互补而非重复**：1 守「工作流里有这条路径」，新判据守「跑完真能凑齐 13 个」。
- **验收（可伪证）**：
  1. **前向守卫（F13 的直防）**：`release.yml` 必须存在一条把 `dist/portable/*` 上传到 Release 的路径。**可伪证夹具——删掉该步骤必须判红**。这次缺陷之所以能潜伏，就是因为全仓只有注释提到便携版、**零判据**。
  2. 断言 `cli` / `cli-publish` 两个 job 仍不存在（沿用 `checkCliArtifactShape`），且**不因新增便携版步骤而误判**——两条判据必须能同时为真。
  3. 三通道派生演练（不真发布），结论表逐条对得上。**负向**：见 §6 的五条串道构造。
  4. `npm run verify:release-workflow` 含新夹具全绿，且**新增夹具各配一条「打回旧写法」检查**。
  5. preflight 的 `npm view` 三态分辨：**用 `0.1.9-rc.9`（上游不存在）跑 → 报错文案必须是「版本不存在」而非「查询失败」**（§3.3 三态表）。

---

### 批次 5 — 分通道更新源（**§2 主路径的最小可用集之一**，唯一涉及运行时行为）

- `src-tauri/src/update.rs`：端点按 `package_info().version` 后缀选择；`stable` 走 `releases/latest`，其余走 `releases/download/channel-<x>/latest.json`。
- `release.yml`：确保 `channel-rc` / `channel-alpha` 两个滚动 release 存在（不存在则创建为 prerelease），并把本次 `latest.json` clobber 上去。
- 人工前置：确认 Actions 的 `contents: write`（现已具备）、首次允许 CI 建滚动 release。
- **验收（可伪证）**：
  1. Rust 单测钉「后缀 → 端点」映射。正向：`0.8.0` → stable 端点。**负向夹具**：`0.8.0-rc.2` promote 成 `0.8.0` 后必须落 stable 端点；`0.9.0-alpha.1` 必须落 alpha 端点。**反向构造**：把映射函数改成恒返回 alpha 端点 → 夹具必须红。
  2. 静态守卫断言 `tauri.conf.json` 的默认端点仍是 stable 那条，且 alpha/rc 端点**只能出现在映射函数的分支里**。**伪证**：在 `tauri.conf.json` 里另写一次 alpha 端点 → 必须判红（CH-2「不得有第二处通道声明」）。
  3. `frontend/updates.html` 与反馈页显示所属通道。**伪证**：删掉该显示 → `verify:shell-pages` 必须红。
  4. **滚动端点缓存实测（未经验证的假设必须被实测掉）**：发一个可丢弃的 alpha 演练 tag → 取 `releases/download/channel-alpha/latest.json`，`version` 必须等于刚发布的那版 → 间隔 30 分钟与 6 小时各取一次 → 干净虚拟机走一次真实「收到更新 → 下载 → 装上」闭环。**任一条不成立即判批次 5 未完成。** 理由：stable 那条 `releases/latest` 是官方语义端点、被大量项目长期验证；滚动 release 这条路**本仓从未走过一次真实覆盖**，不能靠推定上线。回退设计见 §8。

     🔴 **2026-09-24 实测修正了本条的三处判据（必须按修正后执行）**：

     | 原判据 | 实测结果 | 修正 |
     |---|---|---|
     | 「`curl` **无缓存**取回」 | `-H 'Cache-Control: no-cache'` **绕不过** Fastly——响应仍 `X-Cache: MISS, HIT`、`Age` 单调递增（0→10→18→23→40→48→63s） | 改为 **cache-busting**：每次附加独立 nonce（`?nonce=$(date +%s%N)`），或改用**不可变 URL**（带 tag 的路径）。**别再写「无缓存取回」**——做不到 |
     | 「**不得回退**成旧内容」 | **这是错误判据**：若 clobber 写错了，三次取回**全是旧的且稳定**——「不回退」**反而通过**。稳定 ≠ 正确 | 改为**正向断言**：每次的 `version` **必须等于**刚发布的版本（硬编码常量） |
     | 「`version` 对就算过」 | 漏检 **`--clobber` 后 `url` 仍指向旧 tag** 这一类（清单新、资产旧，updater 验签失败） | 追加断言：`url` 里包含的 tag **必须等于**刚发布的 tag；并校验 `signature` 与 `url` 指向的 `.sig` 资产一致 |

     另需**夹具隔离**：三次取回**不得共用同一 URL**（Fastly 是全局共享状态，测试相互污染），
     且期望版本号**硬编码**在判据里、**禁止**用 `dsh-targets.mjs` 现算
     （本仓已踩过「自测与被测犯同一个错 → 对称失效」的坑）。
     完整判据设计与夹具要求见 [`docs/optimization-release-channels.md`](optimization-release-channels.md) §1.4 / §1.5。

---

### 批次 6 — 宣称纪律与文档

- AGENTS.md：§8.6 三通道表重写、§8.2 推进规则重写、§2 命令速查补新命令、§4 新增三节（`next → rc` 更名与历史别名 / 滚动 release 是更新链路命门 / **删一个 job 前先数它承载几类职责**）。
- README 双语「运行时通道」一节改为「发布通道」表；`docs/dsh-upgrade-checklist.md` 改三通道工序；`verify:claims` 同步。
- **F13 的教训要落到「勿回归」而不是只落进本文**：AGENTS.md §4 新增「删一个 job 前先数它承载几类职责」，并把「Release 必须含 3 个便携版资产」写进 §8.5 的资产核对（现有那条 13 的期望值保留——它是**正确的口径**，本批次是补齐兑现路径，不是改口径）。
- ⚠️ **`dsh-host-cli` 的文档收敛不在本批次范围内**：它已完成（AGENTS.md §1/§8.4/§8.5、README 双语、`dev-plan-cli-distribution.md` §5、ADR-045/047 均已改写，防复活守卫 `checkCliArtifactShape` 已就位）。本文只是记录这项已完成事实并据此裁剪计划，不重复施工。
- 新增 ADR：**ADR-052**（三通道映射、列车与晋升规则、`rc` 改名与别名）、**ADR-053**（分通道更新源与滚动 release，含 D3 被否方案与批次 5 的缓存实测结论）、**ADR-054**（为什么是桌面版本列车而不是并轨上游：F9/F11 的窗口实测 + 两条事实纠正——**上游没有 GitHub Release 只有 `dsh-*` tag；同版本号重发不被 Tauri updater 视为更新**）、**ADR-055**（产物上传与跨平台汇总为什么独立成 `publish-assets` job：判据 = 两处需求共用同一份 `needs` 图；含 F13 的起因记录）。
  - 📌 编号取 `docs/adr/` 当前最大值 `051` 之后的连续四个。
- **验收（可伪证）**：`npm run verify:claims` 全绿；**伪证**：把 README 里的发布通道表退回旧的「运行时通道」两列表述 → 必须判红。

---

### 批次 R2 — MANIFEST 记全身份元组

`MANIFEST.json` 增字段（现有 `target` / `versions.dsh` / `lockfileHash` 保留）：

```jsonc
{
  "desktopVersion": "0.8.0-rc.1",
  "dshVersion": "0.1.5-rc.3",
  "channel": "rc",                 // 派生值，但落盘供离线取证
  "upstream": { "package": "@deepseek-ai/dsh", "distTag": "next", "tag": "dsh-v0.1.5-rc.3" },
  "desktopCommit": "<sha>",
  "lockfileHash": "...", "patchSetHash": "..."
}
```

- `desktopVersion != dshVersion` **故意两个都写**：这文件是给日志、诊断包、反馈页看的。
- `upstream.tag` 带 `dsh-` 前缀：上游没有 GitHub Release、tag 名与我们不同（F10），不写清下一个读者会去找不存在的 release。
- 三处消费同步：`runtime_manifest.rs` 身份行、反馈页自述、诊断包 `README.txt`。
- **验收（可伪证）**：`MANIFEST.json` 含全部六个字段；**伪证**——逐个删字段，每次删都必须让 `verify:version` / `verify:release-workflow` 之一报红（六个字段配六条夹具，不接受「有校验」这种笼统说法）。

---

### 批次 R1 — 装配产物从「按通道键」改为「按精确版本键」

现状缺陷：`harness-locks/<target>/` 与 `patches/<target>/` 曾是**活的工作集**，每次推进上游版本就原地覆盖，于是**已发布版本无法精确重建**——`v0.7.0-alpha.4` 那份 lockfile 在下次 alpha 推进后就不存在了。而「能不能重建出当时那个包」恰恰是 Issue 取证的前提。

- `harness-locks/<dshVersion>/`：锁文件跟着它锁的版本走，通道只是读取时的入口。（已于批次 1a 落地。）
- `patches/` 保持**按通道为作者区**（`patches/<channel>/`），但每次发布把「本次实际生效的补丁集」按内容冻结（清单 + 内容哈希进 MANIFEST，见 R2）。
  - ❌ 不做 `patches/versions/<v>/` 全量分版本目录：相邻上游预发布版本的补丁集常常**只差 1～2 条**（`retireWhen` 退役机制正是为此），按版本全量铺开会产生多棵近乎相同的树；补丁的正确性权威是**上游版本 + 行号**，不是目录名。这与 §4-D4 是同一个取舍的两面：**复用要有退出条件**（版本分叉即各自独立）。
- **📌 冻结时点（写死，否则「冻结的到底是哪套补丁」又是两处真相）**：
  - 计算点 = `prepare-harness.mjs` **应用完补丁、写 `MANIFEST.json` 的那一刻**（不是打 tag 时，也不是 preflight 事后重算）。输入是「本次真正落到盘上的补丁文件内容 + 各自 applied/skipped/failed 结果」，按文件名排序后取 sha256——同一套补丁在任何机器上算出同一值。
  - preflight 的职责因此是**核对**而非计算：三个平台各自上报 MANIFEST，由一个 `needs` 三平台的汇总步骤断言三份 `patchSetHash` 逐字节相同，不同即失败（这说明补丁应用受平台顺序/文件系统差异影响，本身就是缺陷）。⚠️ 这个位置**历史上借住在 `cli-publish`，而该 job 已随 F12 消失**——与 F13 是同一个坑的两种表现：**汇总步骤不能借住在一个随时可能被裁掉的产物 job 上**。落点即批次 4 的 `publish-assets` job——**不要**默认「build 之后」这种在工作流里并不存在的时点。
  - 配套：Release 正文追加一行 `patchSet: <hash 前 12 位>`，让「这一版打了哪套补丁」在页面上就能比对，不必下载包。
- **验收（可伪证）**：
  1. 给出 `desktopVersion` 能反查 `(dshVersion, lockfile, patchSetHash)` 三件套；`prepare:harness --check` 对**旧版本**也能判定「树是不是那棵树」。**伪证**：改动一条已冻结的补丁内容 → `--check` 必须红。
  2. 三平台 `patchSetHash` 逐字节相同。**伪证**：让某一平台的补丁顺序不同 → 汇总步骤必须红。
  3. 可复现性自证：清空 staging 后重算 `lockfileHash`，与冻结值一致。**伪证**：手工改一条 `inputs.json` 的依赖项 → 重算值必须变化。

---

### 批次 R3 — 上游发现自动化升级为「同步 PR」，但不自动发布

今天的 `drift.yml` 只回答「上游领先了吗」，把后面的体力活（改锚点 → 重算补丁行号 → 重生成 lockfile → 跑适用性预检）留给人。方向是把它变成产出 PR 的自动化，但**必须停在人工确认前**：

```text
每日 / 手动：发现某通道 dist-tag 有新版本
  → 建分支：改 dshVersion 锚点 + recount-patches + 重生成 harness-locks/<新版本>/
  → 跑 check:patch-applicability（±20 窗口）+ verify:patches + 三平台 CI
  → 开 Sync PR（正文逐条列：补丁 applied/failed/retired、体积增量、失败项）
  → ★ 人合并才继续；合并后仍需人打 tag
```

- ❌ 明确否掉「发现即发布」：本仓在上游之上叠了 patch-package + vendored 包 + 运行时注入 + 壳层集成，上游任一变化都可能让补丁失效，自动发布等于把「装得上、起不来」直接推给用户。
- 频率沿用现有 `drift.yml` 的每日节奏，不改成每 6 小时（对上游这个发版节奏只是重复噪音）。
- **验收（可伪证）**：PR 正文里的补丁统计与 `MANIFEST.json:patches[]` 逐条一致（AGENTS.md §7.1 规则 3「不得无声降级」在此生效）；**伪证**：让某个补丁 failed 但不写进 PR 正文 → 必须判红。**负向**：构造「上游有新版本」→ 产出 PR 但**不产出 tag**（断言 ref 集合无新增 tag）。

---

## 6. 收尾验收（全部批次之后）

以下每条都给出**判据**与**负向构造**。只验正向的条目一律不计为通过。

1. **通道派生（正向 + 负向各半）**
   - 正向：`--channel-of 0.8.0` → `stable`；`--channel-of v0.9.0-alpha.1` → `alpha`。
   - 负向：`--channel-of v0.8.0-beta.1` → 硬失败。

2. **串道构造（必须判红；只验正向不够——一个恒真的映射表也能过）**
   - 拿 `v0.8.0`（stable）的 tag 配 `rc` 线锚点（`0.1.7-alpha.2`）跑 preflight → 判红（stable 要求锚点 == npm `latest` 且为无后缀版本）；
   - 拿 `v0.9.0-alpha.1` 配 `0.1.5-rc.3` → 判红（阶段不匹配）；
   - 拿 `v0.5.0-next.1` 作为**新 tag** 走 preflight → 判红（弃用别名只读不写，D1）；
   - 拿一个上游不存在的锚点（`0.1.9-rc.9`）→ 判红（CH-5），且错误文案必须是「版本不存在」而不是「查询失败」（§3.3 三态表）。
   - 四条全部写进 `verify-release-workflow` 的 `--self-test` 夹具，**并按本仓口径各配一条「打回旧写法必须变红」的可伪证检查**。

3. **组装与冒烟**：三通道各一次 `prepare:harness`（真组装、lockfile 命中，**断言不打印「回退在线解析」警告**）+ 一次 `smoke.yml scope=full`。
   - ⚠️ **两条通道要各自跑，且本轮升级为三条**：`smoke.yml` 的 `dsh_target` 有默认值，只按默认跑等于只验一条线。核验某次运行验的是哪条线的**唯一可靠判据**是日志里的 `DSH_TARGET:` 与 `harness-deps/<target>/`——两个运行的 job 名与结论完全一样，**不能**靠运行数量或 job 名推。

4. **真实通道切换演练**：发一个 alpha 预发布（draft 或指定内测 tag），验证从 alpha 安装的客户端能收到下一次 alpha 更新，且**收不到** rc/stable 的清单。同时跑批次 5 的滚动端点缓存三项实测。
   - 负向判据：从 alpha 客户端**取到** rc 或 stable 的清单 ⇒ 判红。

5. **静态门禁全绿**：`cargo clippy --workspace --all-targets -- -D warnings` + `npm run verify:ipc-surface` + `verify:shell-pages`（批次 5 动了命令面/页面则必过）。

6. **资产清单抽验（F12/F13/F14 三条的交汇点）**：按**清单**数而不是看 Release 页。应为 **13 个** = 9 平台安装包 + 1 `latest.json` + **3 个便携版**（`.zip` / `.zip.sha256` / `.manifest.json`），无 0 字节。
   - 负向：**不得出现任何 `dsh-host-cli-*` 资产**（出现即说明退役的通道又被接回来了）。
   - 同一份期望值写进 `verify:release-workflow` 的文档断言——本仓已经吃过「文档口径对、兑现路径没了」的亏（F13），期望值必须与工作流里的上传步骤**互相引用**。

---

## 7. 风险登记

| 风险 | 等级 | 处置 |
|------|------|------|
| `next → rc` 更名不可逆程度最高：CI 缓存、本地 `harness-deps/`、已安装包 MANIFEST 都可能带旧名 | 中 | 别名解析（读旧名）+ 新 tag 禁用旧名（写新名）两条同时成立，各配夹具 |
| 滚动 release 是新的长期手工/自动前置，建失败即更新链路断 | 中 | CI 幂等创建 + 发布后人工点一次 `releases/download/channel-alpha/latest.json` 确认可达（**看 `version` 字段是否等于刚发布的版本**） |
| **滚动 release 的 `latest.json` 被 CDN 缓存住**，`--clobber` 覆盖了但客户端仍读旧版 ⇒ 预发布用户「检查更新」却收不到 | 中高（未实测） | 不推定：批次 5 验收含「立即 / +30min / +6h 三次无缓存取回 + 干净虚拟机走一次真实更新闭环」；不成立则按 §8 的回退设计切换 |
| 正式版捆上游 rc 被读成「我们发的是上游正式版」 | 中 | D2 的三处声明（正文横幅 / MANIFEST / 反馈页）+ `verify:claims` |
| 三通道被误解为 CI 成本 ×3 | 低 | 出包仍只在打 tag 时发生；批次 4 不新增定时矩阵，drift 只比版本号 |
| **删一个 job 时连带删掉它借住的其他职责**（F13 已发生一次：`cli-publish` 一消失，便携版的核验与上传同时没了，而**全部门禁绿灯**——`checkCliArtifactShape` 只管 CLI 不得复活） | 高（已成事实，待修） | 批次 4 建 `publish-assets` 承接「便携版核验 + 上传」与 R1 的三平台哈希汇总；`verify-release-workflow` 补**前向**守卫「必须存在把 `dist/portable/*` 上传到 Release 的步骤」，配可伪证夹具（删掉即判红）。教训写进 AGENTS.md §4 与 ADR-055 |
| 便携版与 `dsh-host-cli` 被混为「同一类非核心产物」，下一次裁剪顺手把便携版一起摘掉 | 中 | F14 明确两者性质不同：便携版是**桌面交付形态**（免安装 zip，用户直接用它跑），CLI 归档是**仓内工具**且不含 runtime。§6 第 6 项与 AGENTS.md §8.5 都**逐项列出便携版三个文件**，缺任一即判发布不完整 |
| 提交式 lockfile 与通道名同时改，diff 很大难审 | 中 | 1a（更名 + lockfile）与 2（派生逻辑）分提交；lockfile 是生成物，单独一个提交 |

---

## 8. 回退与中止条件

### 8.1 回退方案（滚动 release 缓存实测不过时启用）——切换成本与实现链路

> ⚠️ **2026-09-24 口径修正（实跑取证）**：本节的「方案」把静态托管写成**唯一**手段，
> 这是把手段当成了目的。实测发现 `Cache-Control` 是**治标且不彻底**的——控制得了自己
> 这一跳，控制不了中间任何一跳；且 GitHub Pages **硬编码 `Cache-Control: max-age=600`**
> 且不可覆盖，想真控制头必须换 Cloudflare Pages / Netlify（引入新的发布面）。
> 真正的根治手段是 **不可变 URL**（`releases/download/<tag>/latest.json` 而非
> `releases/latest/download/latest.json`——后者是恒定别名，**必然**被缓存），它在
> GitHub Release 上就能实现，不需要换托管。
> 口径改为：**回退方案 = 不可变 URL（首选）→ 静态托管（次选）**。
> 完整论证、切换成本表、夹具隔离要求与「双写过渡期」这个被低估的成本，
> 见 [`docs/optimization-release-channels.md`](optimization-release-channels.md) §1。

**触发条件**：批次 5 的三条缓存实测任一不成立（见 §5 批次 5 验收第 4 项）。
**修正后的触发条件是三条可判定的量**（T1 `maxAge > 3600s` 连续两次 / T2 覆写后
`version` 与 `url` 的 tag 不一致 / T3 真机验签失败复现一次），任一条成立即触发；
**三条都不成立前不上 Pages**（它是净负债，与 §9 精神一致）。详见优化文档 §1.2。

**方案**：把三份 `latest.json` 托管到带可控缓存头的静态端点（GitHub Pages 或等价物），滚动 release 退化为「只承载资产、不承载清单」。清单里的 `url` 仍指向真实版本 tag 的资产。

**实现链路（5 步，按依赖顺序）**：

| # | 步骤 | 落点 | 是否改动运行时行为 |
|---|---|---|---|
| 1 | 选端点形态并确认缓存头可控 | 新建静态托管（Pages 或等价物） | 否 |
| 2 | 加一个「推送清单」步骤：把本次 `latest.json` 推到静态端点，**替换** `--clobber` 上传滚动 release | `release.yml`（批次 5 新增的那一步） | 否 |
| 3 | 端点基址换成静态托管地址 | `src-tauri/src/update.rs` 的映射函数 | **是**（唯一触及运行时的改动） |
| 4 | 改写 `tauri.conf.json` 默认端点（若它仍指向 GitHub） | `src-tauri/tauri.conf.json` | 是 |
| 5 | 改写 ADR-053：D3 的落选方案从「被否」改判为「已采用」，滚动 release 退化为资产宿主 | `docs/adr/` | 否 |

**切换成本评估**：

- **代码改动面小且已隔离**：批次 5 的设计刻意把「后缀 → 端点」收敛进**一个映射函数**，端点基址是它的输入。因此第 3 步只改函数里的基址常量，不改分支结构、不改后缀判定逻辑、不动 Rust 侧的版本解析。**Rust 单测的夹具结构不变**，只需替换期望端点字符串。
- **静态守卫要跟着改一处**：批次 5 验收第 2 项断言「`tauri.conf.json` 的默认端点仍是 stable 那条，且 alpha/rc 端点只能出现在映射函数的分支里」。若第 4 步启用了新的默认端点形态，该断言的**期望值字符串要更新**——但断言本身的结构（「不得有第二处通道声明」）不变。**这是本次切换唯一需要动判据的地方**，改动是替换常量而非重写逻辑。
- **清单推送步骤是纯替换**：第 2 步是把滚动 release 的 `--clobber` 换成推静态端点，不新增并行路径（**并行 = 两处真相**，与本计划的 CH-2 一致）。
- **不涉及**：版本号派生、MANIFEST 身份元组、`patchSetHash` 冻结、三通道模型、CI 矩阵、签名/公证。**切换只在「清单托管在哪」这一层。**

**判据（切换是否做对了）**：切换后，批次 5 现有的「后缀 → 端点」单测必须仍全绿（除期望端点字符串外不改任何夹具）；且干净虚拟机走一次真实更新闭环必须仍通过。**若需要改夹具的结构才能通过，说明批次 5 的隔离设计没做到位，应先修隔离而不是扩大切换范围。**

**不做的事**：不提前实现该方案。理由——提前实现等于为一个未实测的假设付出双份维护成本；而一旦实测不过，上面 5 步的改动面已足够小，来得及。

### 8.2 回滚条件（改动已发布出去之后）

回滚的**判断对象是「产物+更新链路的用户可见状态」**，不是代码。按下表逐条判：

| # | 触发条件 | 回滚动作 | 可逆性 |
|---|---|---|---|
| R-A | 新通道发出去的包**装得上、起不来**（启动即崩），且定位在通道切换改动（批次 5）内 | 把映射函数退回上一版（端点仍指向旧语义），并用 `version:bump --prerelease` 出一个**更高预发布号**的修复版；**不改写已发布的 tag** | 可逆 |
| R-B | 预发布客户端**收到 stable 的清单**（串道），或 stable 客户端收到预发布清单 | 立即停用出问题的那条滚动 release 的 `latest.json`（`gh release delete-asset`），使该通道退化为「无自动更新」而不是「错更新」；再修判定逻辑 | 可逆 |
| R-C | 滚动端点缓存导致**预发布用户收不到更新**，且 §8.1 的切换来不及 | 同上：先摘掉清单让该通道退化为手工重装（**比推错版本好**），再走 §8.1 | 可逆 |
| R-D | `patchSetHash` 三平台不一致（说明补丁应用受平台影响） | **不发布**；把该次 Release 保持为 draft 或删除未完成资产，修组装后再发 | 可逆 |
| R-E | 便携版上传步骤被再次误删（F13 复现） | 属于**前向守卫失效**，先修守卫再修步骤；已发出的 Release 用 `gh release upload --clobber` 补 3 个资产 | 可逆 |

**统一纪律**：

- **不改写已发布的 tag**。本仓的硬事实是 `release.yml` 的代码取自 tag（工作流 YAML 取自 dispatch ref），因此**改写 tag 才能改代码 = 把已发布的记录改成假的**。修复一律走新版本号。
- **摘清单优先于推修复版**：R-B/R-C 的处置顺序是先让「错的状态」停下（摘 `latest.json` 让用户退回手工重装），再修代码。理由——**错更新的代价高于无更新**，前者用户无法自救。
- **回滚判定要按资产清单数，不看页面**：GitHub 的草稿不显示在列表里（本仓已确认），「页面上看不到」不等于「已清理」。

### 8.3 中止条件（计划整体停止推进）

以下是**停止继续投入**的判据。任一成立即中止本计划剩余批次，而不是加大投入：

| # | 中止条件 | 中止后保留什么 |
|---|---|---|
| A-1 | **§2 主路径的最小可用集（批次 3 + R2 + 批次 5）中，批次 5 的实测在三轮尝试内仍不过，且 §8.1 的静态托管切换也不成立** | 保留批次 3 + R2（版本语义与身份元组本身独立成立）；放弃分通道自动更新，退回「预发布手工重装」（即今天的形态），并把结论写进 ADR-053 |
| A-2 | **批次 2 的通道派生改造被发现需要引入「第二处通道声明」才能工作**（即 CH-2 无法在 `dsh-targets.mjs` 单点派生下成立） | 中止并退回两通道；CH-2 是本计划的模型基石，动它就等于换模型，应重开 D0 而不是打补丁 |
| A-3 | **`next → rc` 更名在保留只读别名的情况下仍导致已安装客户端读不出运行时线** | 中止更名（保留 `next` 作为测试版名），继续其余批次；命名是 D1 的收益，不值得用兼容性换 |
| A-4 | **批次 4 的前向守卫被证明无法与 `checkCliArtifactShape` 共存**（两条判据互相误判） | 中止批次 4 的守卫部分，只做便携版上传的修复（F13 的实质是缺上传步骤，不是缺守卫）；守卫另立决策 |
| A-5 | **上游在计划执行期内发布了正式 stable 版本**（`latest` 不再是 rc） | 不中止，但**重开 D2**：条件已变，「正式版捆上游 rc」的声明横幅与硬校验都可能需要改口径。这是**范围复审点**而非中止点 |

**中止 ≠ 撤销**：中止后已完成的批次**不回退**（它们各自独立可验、独立提交）。中止的只是剩余批次，以及该条件对应的那个决策。

---

## 9. 明确不做

- 不引入 per-channel 分支模型或长期 `release/*` 分支。
- 不为三通道新开每日三平台 CI/烟雾矩阵（成本与价值不成立；仍靠手动 dispatch + 每日 drift 哨兵）。
- 不改补丁分级（`LAYERS.md` / `patch-layers.mjs`）的判据本身。
- 不调整 `verify:drift` 的阈值口径（要调严请另立决策，本计划只把它从 2 通道扩到 3 通道）。
- 不改签名/公证密钥归属与 `tauri-action` 的调用形状（批次 5 只在其后追加上传步骤）。
- **不为 `dsh-host-cli` 设计任何发布形态**：不上 Release、不进产物表、不恢复那两个已退役的 job、不加回 CI 矩阵。`crates/dsh-host-cli` 本身、`scripts/package-cli.mjs` 的**本地**打包能力与 `verify:cli-package` 门禁都不在此限（它们仍是 `doctor` / `fault-inject` 与可证伪守卫的资产）。**便携版明确不在此限**——它是要修好的发布形态之一。
- 不提前实现 §8.1 的静态托管回退（理由见该节末）。

---

## 10. 规模与顺序

### 10.1 规模

| 批次 | 状态 | 说明 |
|---|---|---|
| **P0** | 待办（**前置**） | 事实校验脚本 `verify-plan-facts.mjs`——见 §1 与风险评审 §1.2 |
| 1a | 待办（**曾被误标完成**） | 换键迁移 + 补新锁；实测证明未发生 |
| 1b | 待办（**可独立后置**） | 唯一会真实改变产物内容的一批 |
| 2 | 待办 | 通道契约层 |
| 3 | 待办 | **§2 主路径最小可用集** |
| 4 | 待办 | 含 F13 便携版修复，**可先于三通道改造单独执行**（Hotfix 独立发布） |
| 5 | 待办 | **§2 主路径最小可用集**；唯一涉及运行时行为 |
| 6 | 待办 | 宣称纪律与文档 |
| R2 | 待办 | **§2 主路径最小可用集** |
| R1 | 与 1a 同批 | 并入 1a 执行 |
| R3 | 待办（最后） | 依赖 R1 的锁文件键与 1b 的锚点推进工序 |

**待办批次数：7 个主干（P0/1a/1b/2/3/4/5/6）+ 2 个 R 系列（R2/R3）。** 各批次内部工作量按需拆分，不预设天数。

> ⚠️ **P0 必须先跑**：本表的状态词在 2026-09-24 被证明**不可信**（1a 被误标为完成）。在 P0 落地前，本表的任何「待办/已完成」都只是**待验证的声明**，不是事实。

> 📌 **2026-09-24 追加的四项优化（详见 §10.4 / 优化文档）对本表的修订**：
>
> | 项 | 修订 | 净效果 |
> |---|---|---|
> | 批次 2 | **删掉「清理三平台 CI Cache」**（实测无缓存面） | **减一项** |
> | 批次 4 / F13 | 新增**前置**：先改 `checkCliArtifactShape` 为三向断言（否则恒红） | **加一前置** |
> | 批次 4 / F13 | 新增**资产清单判据**（13 项逐项枚举）——现状**零判据**是 F13 潜伏的根因 | **加一验收** |
> | 批次 1a | 新增 **`patches/<target>/` 存在性硬断言**（堵静默降级）+ `inputs.json` 加 `target` 字段 | **加一验收** |
> | 批次 1b | 锁文件生成**机制已存在**，缺口是流程纪律；但**必须排在 1a 之后**（否则孤儿，重跑 40min） | **加一顺序约束** |
> | 批次 5 | 验收第 4 项**三条判据全部改写**（见批次 5） | **改判据** |

### 10.2 顺序与依赖

- **建议顺序**：`P0 → （F13 修复）→ 2 → 3 → R2 → 4 → 5 → 6`，`1a` 与 `R1` 同批、`1b` 作为独立升级提交插在任意时点，`R3` 放最后。
- **两个前置插入项**（都不等批次 2）：
  - **P0**：事实校验脚本。理由——本计划已在同一形态上失败三次，靠纪律重校已被证伪。
  - **F13 + CLI 正文段**：当前 HEAD 上的真实缺陷（资产少 3 个 + 正文声明不存在的 CLI 资产），**且都在全部门禁绿灯下发生**。
- ⚠️ **F13 修复有一处硬阻塞（2026-09-24 实跑发现）**：`scripts/verify-release-workflow.mjs`
  的 `checkCliArtifactShape` 第 2 条断言是「`gh release upload` 不得出现」，而 F13 的修复
  **必须**新增该动作。故修复前**先改守卫**（改为三向：只准 `dist/portable/*`、禁 `dist/cli/*`、
  `cli`/`cli-publish` job 仍须缺席），否则提交即恒红。详见
  [`docs/optimization-release-channels.md`](optimization-release-channels.md) §3.1。
- ⚠️ **F13 的真守卫是「资产清单判据」**：现状**没有任何判据断言资产数**——「期望值 13」
  只写在 `AGENTS.md` 里。这正是 F13 能藏这么久的根因。Hotfix 必须顺手补上逐项枚举的资产断言。
- ⚠️ **`1a` 必须早于 `1b` 的锁文件生成**（否则刚生成的 lockfile 在目录改版本键后立刻成孤儿，
  **重跑 40 分钟 / 8GB 堆**）。见优化文档 §4.2。
- **阻塞关系**：
  - **P0 阻塞一切**（它产出的是「其余批次的现状值」；若不先跑，所有状态词都不可信——本次 1a 误标即为实证）。
  - **批次 2 阻塞 3/4/5 与 R 系列**（通道名与派生是它们的输入）。
  - 批次 4 阻塞 5（更新源步骤挂在 preflight 输出上）。
  - `1a` 与 `R1` 合并为**一次**目录改动（原本两处各说了一遍换键）。
  - R1 阻塞 R3（同步 PR 要往 `harness-locks/<version>/` 写）。
  - **R2 与 3 互相不阻塞，但 §2 主路径要求两者都已落地**（R2 提供可核字段，批次 3 提供判红逻辑）。
  - `1b` 不阻塞任何批次，它只决定「本次要不要真的推进上游」。
- **按主路径排的优先级**：若要压缩投入，按 §2.1 的表取舍——**批次 3 / R2 / 批次 5 三项是主路径的最小可用集，其余都是门禁加固与宣称完善**。压缩时必须显式说明放弃了哪一项及其退化后果（即 §2.1 表中「缺了它的后果」那一列）。

### 10.3 已知风险与缺口的独立评审

五项主要风险的取证结论与逐项可执行方案，见 [`docs/risk-review-release-channels.md`](risk-review-release-channels.md)。该文件**不采信本计划的事实陈述**，全部结论由 2026-09-24 实跑得出，并记录了本计划三处过期/误标的底账。

### 10.4 四项优化的落地建议（2026-09-24 追加）

针对 CDN 缓存黑洞、`next → rc` 存量离线数据冲击、F13 优先剥离、锁文件成本分摊四项，
给出可执行的触发条件 / 切换成本 / 前置条件与顺序约束，见
[`docs/optimization-release-channels.md`](optimization-release-channels.md)。

该文**改写了本文三处结论**，实施前必须并读：

| # | 被改写的结论 | 本文原处 | 修正 |
|---|---|---|---|
| 1 | 批次 5 验收 A 用 `curl -H 'Cache-Control: no-cache'` 做「无缓存取回」 | §5 批次 5 | 实测**绕不过** Fastly（`X-Cache: MISS, HIT`、`Age` 单调递增至 63s+）→ 必须改 cache-busting nonce 或不可变 URL |
| 2 | 静态托管是缓存回退的**首选** | §8.1 | **不可变 URL 才是首选**；Pages 是次选，且其 `Cache-Control` 在 GitHub Pages 上**不可配**，另有「端点编译进客户端 ⇒ 需双写过渡期」这个被低估的成本 |
| 3 | 批次 2 落地时需「清理三平台 CI Cache」 | §10 顺序项 | **该动作不需要执行**——实测 CI 缓存面只有 `setup-node` 的 npm cache 与 `rust-cache`，`resources/` / `harness-deps/` / staging **均未被缓存**。正确待办是三条：`patches/<target>/` 存在性硬断言、`inputs.json` 加 `target` 自证字段、本机残留的显式清理清单 |

---

## 11. 未决项（本次取证暴露、尚需裁定）

以下三项由风险评审暴露，**本计划尚未给出裁定**，实施前必须处置：

| # | 未决项 | 为什么必须裁定 | 建议落点 |
|---|---|---|---|
| 1 | **D4 的判据从「目录存在性」改为「`patchSetHash` 差异」** | `next`/`latest` 已分叉，D4 的分支条件被激活；而现行 D4 要求「版本分叉 ⇒ 必须存在 `patches/stable/` 目录」，与 R1「不按目录名承担版本差异」自相矛盾。按目录判会奖励「复制一份」，按哈希判奖励「如实反映差异」 | 批次 R2 之前 |
| 2 | **stable 落后 rc 时的正文声明** | 分叉后「正式版锚点比测试版旧」成为常态。不说清则用户会以为是 bug | 批次 4 + §4-D2 |
| 3 | **正文链路三段的守卫补齐** | 正文是三段拼接（横幅 shell / 提交区间 changelog / CLI 表），现状只有前两段有守卫，第三段零判据——这正是 CLI 段能复活的原因 | 批次 6 |
