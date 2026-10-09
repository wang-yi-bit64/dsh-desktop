# DSH Desktop 版本号更新策略

> **地位**：本文件是版本号的**唯一策略口径**。它回答四个问题：
> ① 版本号长什么样（命名规则）；② 什么改动会让它动、怎么动（递增条件）；
> ③ **谁有权决定它**（递增权限）；④ 一次发布要走哪些步骤（流程与规范）。
>
> **权威顺序**：本文件是版本号的**唯一权威**。原 V3 执行计划与输入提案已于 2026-10-08 从库中移除，
> 备查见 `.workbuddy/backup/2026-10-08-v3-docs-before-delete/`。
> 与 `docs/release-runbook.md` 冲突时以本文件为准（发布步骤已按 D5 更新）。
>
> **已定案的上位决策（不得被本文件悄悄推翻）**：
> - **D3 = 方案丙-A**：桌面版本号 = 上游精确 `x.y.z` + 本仓变更段。甲/乙作废。
> - **D4 = 方案 a**：本仓变更段的机器可读台账落在 `harness-locks/dsh-releases.json`，
>   **不新开第三个 lock 目录**。
> - **D5**：两步推送 + tag 显式引号 + **禁 `--follow-tags`**。
> - **D7**：变更日志两股同段落、段键含本仓变更段、上游股冻结入库。
>
> ✅ **ADR 前置已满足**：`docs/adr/061-synthetic-version-model.md` 定义本合成版本号方案，
> 并显式处置 ADR-057（**守卫继续有效**）/ ADR-060（决策 3 与「桌面版本单调性」校验行的表达形式作废）/
> ADR-028（决策 1 保留、**决策 4 由 ADR-061 接管**）。
> ⚠️ 该 ADR 曾于 2026-10-08 被移除后**按现行形态补写**（首版草稿把排序键放在 build 段，已否）；
> 首版原文在 `.workbuddy/backup/2026-10-08-v3-docs-before-delete/`。
>
> 📌 **本文件新增的唯一未决事项**见 §8（4 条编号决策点）。在它们被裁决前，
> 本文件描述的形态即 **丙-A 定案版**，可直接施工。

---

## 1. 命名规则

### 1.1 正式语法

```
<上游精确 x.y.z>-<上游预发布>.<n>[+<w>]

   上游段（原样保留）        本仓段
```

| 段 | 产地 | 语法 | 是否参与排序 |
|---|---|---|---|
| `x.y.z` | **上游**（`@deepseek-ai/dsh` 的版本号） | 逐位原样抄写，**本仓不占 patch 段** | ✅ 最高优先级 |
| `-<上游预发布>` | **上游** | **原样保留**（`alpha.1` / `rc.3`…），本仓**不改写不替换** | ✅ |
| `.<n>` | 本仓 | **纯数字，无前导零**，从 `1` 起 | ✅ **本仓段里唯一的排序键** |
| `+<w>` | 本仓 | `[0-9A-Za-z-]`，**禁 `_`**；不需要时可**整个省略** | ❌ **永不参与排序** |

**示例**

| 版本号 | 通道 | 上游 | 本仓第几次构建 |
|---|---|---|---|
| `0.2.1-alpha.1.3` | `alpha` | `0.2.1-alpha.1` | 第 3 次 |
| `0.2.1-alpha.1.10` | `alpha` | `0.2.1-alpha.1` | 第 10 次 |
| `0.2.0-rc.3.1` | `next`(rc) | `0.2.0-rc.3` | 第 1 次 |
| `0.2.0-rc.4.1` | `next`(rc) | `0.2.0-rc.4` | 第 1 次（上游前进 ⇒ `n` 归 1） |

⚠️ **序号是两级**：`alpha.1.3` 里 `1` 属**上游**、`3` 属**本仓**。这是为「上游身份必须可辨」付的代价。
⚠️ **正式线（上游无预发布）的载体仍是开口**（ADR-061 决策 7）：`0.2.1-<n>` 会让首标识符变成纯数字。
当前只有 `alpha` 与 `next`(rc) 两条线，**该分支不可达**；`stable` 落地时须另行定规则。

### 1.2 三条硬约束（各有实测依据）

1. **`x.y.z` 必须逐位等于上游**。「大版本号跟随上游」这句话**有歧义**——是整个版本号跟随，还是只有 major？
   定案取**前者**。理由：只有整段抄写才能从版本号本身辨识上游身份；`major.minor` 粒度会让上游
   `0.2.0 → 0.2.1` 这类前进在版本号上**不可见**。
2. **`n` 按 `(x.y.z, 上游预发布)` 分组**，跨组**不共享**。上游前进（含**预发布段前进**）⇒ `n` **归 1**。
3. **🔴 已发布构建不得共享 `(x.y.z, 上游预发布, n)` 三元组**（**结构性不变量**，见 §7.1 守卫 1）。
   见 §7.1 的守卫与 §6.2 的根因。

### 1.3 为什么 `w` 不承担排序（一条实测出来的教训）

`w` 写成 `w1…w10` 这种**混排字母数字**时，只有 **ASCII 字典序**可用（`-w9 > -w10` 为真）；
`n` 写成**纯数字**时才按数值比较（`n=2 < n=10` 成立）。因此：

- **禁止**让混排串承担排序职责；
- `w` 的定位是**人读的标签**（批次代号 / 组件标记），版本号里**只有一个排序键**就是 `n`。

### 1.4 🔴 上游身份**不能**由桌面号反推（施工中实测出来的结构性约束）

这两个版本号**形状同构**——都是「三段核心 + 两段预发布标识符」：

| 版本号 | 上游 | 本仓序号 |
|---|---|---|
| `0.7.3-alpha.1` | `0.7.3-alpha.1`（合成号机制**之前**的历史版本） | **无** |
| `0.2.1-alpha.1.3` | `0.2.1-alpha.1` | `3` |

仅凭桌面号**无法**判断末段标识符是上游自己的还是本仓追加的。⇒

- **上游身份的唯一产地是台账的 `upstreamDsh` 字段**（`harness-locks/dsh-releases.json`），
  **不是**从桌面号解析出来的；
- 因此守「当前版本是否已入账」的判据**不得**用「它是不是合成号形状」当触发条件——
  那会让全部历史版本假红。正确做法是**显式传入**「我要发布的那个版本」；
- 推论：**不要回填历史 tag 进台账**。`v0.7.3-alpha.1` 的序号位在语义上是**空的**，
  回填会把「上游标识符」与「本仓序号」两种语义混进同一字段且此后无法区分。
- 该约束落地为 `scripts/release-ledger.mjs` 模块文档里的 🔴 段与
  `checkLedgerAgainstVersion()`（**显式传参**版判据）；实测证据见 `verify:version` 自测的
  「同构」夹具组。

---

## 2. 递增条件：变更类型 → 版本号变动

**判定顺序**：先看**上游是否前进**（第 1 行），再看**本仓是否有「需要发版」的提交**（第 2–9 行）。
两类同时发生即为 **mixed** 版本（见 §3.2）。

| # | 变更类型 | 判据（commit / 事实） | 上游段 `x.y.z` | 上游预发布段 | `n` | `w` | 是否发版 |
|---|---|---|---|---|---|---|---|
| 1 | **上游同步** | `harness-locks/` 锚点换代 | **前进**（逐位抄新值） | 按新上游线 | **归 1** | 可留空 | ✅ |
| 2 | **上游同步 + 本仓适配** | 上面 + `patches/<target>/` 改名 | 前进 | 按新上游线 | **归 1** | 标批次 | ✅ |
| 3 | **功能新增** | `feat:` | 不变 | 不变 | **+1** | 标 `feat` 或代号 | ✅ |
| 4 | **缺陷修复** | `fix:` | 不变 | 不变 | **+1** | 标 `fix` | ✅ |
| 5 | **性能优化** | `perf:` | 不变 | 不变 | **+1** | 标 `perf` | ✅ |
| 6 | **安全修复** | `fix(security):` / `security:` | 不变 | 不变 | **+1** | 标 `sec` | ✅ **必须** |
| 7 | **重构（无行为变化）** | `refactor:` | 不变 | 不变 | **+1** | 标 `refactor` | ✅ |
| 8 | **依赖升级（不动组装锚点）** | `chore(deps):` | 不变 | 不变 | **+1** | 可留空 | ✅ |
| 9 | **🔴 破坏性变更** | `feat!:` / `BREAKING CHANGE:` | **不动** | 不动 | **+1** | 标 `breaking` | ✅ |
| 10 | **回滚（撤回一个已发布版本）** | `revert:` | 不变 | 不变 | **新 `n`**（**严禁复用旧 `n`**） | 标 `revert` | ✅ |
| 11 | **文档 / CI / 注释 / 测试** | `docs:`、`chore(ci):`、`test:` | 不变 | 不变 | **不产生 `n`** | — | ❌ **不发版** |

### 2.1 三条需要展开的规则

**① 破坏性变更不动 major（第 9 行）** —— major 属于上游。
本仓的破坏性变更（IPC 契约变更、Profile 格式变更、CLI 参数语义变更等）**只能**通过
`n+1` + Feature Log 里 `breaking: true` 表达，并在 Release 正文与 CHANGELOG 里显式标注。
判据：**若某次改动让 `x.y.z` 的某一位发生变化，而上游对应位没变，即为违规**。

**② 已发布的 `n` 永不复用（第 10 行）** —— 回滚**不是**「把版本号退回去」，
而是「用一个更大的 `n` 发布回滚后的内容」。

**③ 只有前三类提交会触发发版，其余（如 `chore:`、`docs:`）只累积不推动版本。**

### 2.2 `n` 的递增粒度：**按 Release，不按 commit**

一个 Release 内含 5 个 `feat:` 提交，`n` 仍然只 **+1**。
`n` 度量的是**对外交付了几次**，不是代码改了几次。
判据：**同一次 `n` 对应且仅对应一个 git tag**。

### 2.3 `n` 是否跨 alpha / RC：**不跨**

「不跨」的精确定义：**上游预发布段前进（含上游 `x.y.z` 前进）⇒ `n` 归 1**。

| 序列 | 合法？ |
|---|---|
| `0.2.0-alpha.1+1` → `0.2.0-alpha.1+2` | ✅ 同一上游版本内 `n` 递增 |
| `0.2.0-alpha.1+2` → `0.2.0-rc.1+1` | ✅ 通道切换，`n` **归 1** |
| `0.2.0-rc.1+1` → `0.2.1-rc.1+1` | ✅ 上游前进，`n` **归 1** |
| `0.2.0-alpha.1+2` → `0.2.0-alpha.1+1` | 🔴 已发布序号复用/倒退 ⇒ 守卫判红 |

---

## 3. 递增权限：**谁有权决定版本号**

> 这是本次重新设计里**唯一真正的结构性改动**。
> 原形态是「人在发版时用一个命令把版本号设成某个值」。新形态是：
> **版本号不由人指定，而是由提交与台账推导出来。**

### 3.1 唯一权威链路

```
git commits
      │  ① 分类（只有 feat/fix/perf/security/refactor 计入）
      ▼
Feature detection
      │  ② 累积
      ▼
Feature Log            docs/releases/FEATURES.md
      │  ③ 决定「什么时候切一版」
      ▼
Release Plan           release-manifest.json（releaseType / breaking / n / w）
      │  ④ 派生
      ▼
Version                package.json（唯一 SSOT，Cargo.toml/Cargo.lock 由脚本同步）
```

| 环节 | 所有者 | 落点 | 谁来写 |
|---|---|---|---|
| 分类 | **机器** | commit 类型 | 提交者只需守 commit 规范 |
| Feature Log | 机器 + 人工复核 | `docs/releases/FEATURES.md` | `feature-log.mjs` |
| Release Plan | **人工决策**（唯一的自由意志节点） | `release-manifest.json` | 发版人 |
| Version | **机器派生** | `package.json` | `version:next` |

### 3.2 四种 release 类型

| 类型 | 触发 | 版本号表现 |
|---|---|---|
| `upstream` | 只有上游锚点变化，本仓零改动 | `x.y.z` 前进，`n=1`，`w` 空 |
| `desktop-feature` | 本仓有 `feat:` | `x.y.z` 不变，`n+1` |
| `desktop-fix` | 只有 `fix:`/`perf:`/`security:` | `x.y.z` 不变，`n+1` |
| `mixed` | 上游前进 **且** 本仓有需发版改动 | `x.y.z` 前进，`n=1`，`w` 标批次 |

⚠️ **`n` 的当前值不由人填**，从台账取：`next n = max(该 (x.y.z, 通道) 组的 n) + 1`。
台账即 `harness-locks/dsh-releases.json` 的 `builds[]`（D4 定案）：
`{ channel, n, w, desktopVersion, tag, date }`。
其中 `channel` 是**桌面通道**（`rc` / `alpha`）——**不是**上游 dist-tag，见 §3.3 的命名规则。

### 3.3 🔴 谁拥有哪个字段（2e 职责划分，2026-10-09）

版本号链路上有**三个互斥的产地**。**一个概念只能有一个产地**——这是 2e 拆分的全部理由
（此前目标表同时答「目录 / 上游锚点 / 发布通道 / 桌面版本」，读的人分不清哪个字段能被谁改）。

| 产地 | 文件 | 它回答的问题 | 它**不**回答 |
|---|---|---|---|
| 运行时**目标表** | `scripts/dsh-targets.mjs` | 目标键 → 目录（`patches/` `packages/` `harness-deps/`）；上游锚点 `dshVersion`；桌面后缀 `publishChannel`；`upstreamDistTag`（**仅用于发现**）；`status` | 合成号 / 本仓序号 `n` / `w`；「上游精确版本 → `patchTarget`」 |
| 上游**索引与台账** | `harness-locks/dsh-releases.json` + `scripts/release-ledger.mjs` | 「上游**精确**版本 → `patchTarget` + `status`」（`resolveReleaseFor()`）；`n` 与 `w`（`planNextDesktopVersion()`）；合成号（`composeDesktopVersion()`）；发布通道（`deriveReleaseChannel()`，由 `patchTarget` 现算） | 目录怎么摆；本仓钉的上游锚点是多少 |
| 版本**写入面** | `scripts/version.mjs`、`scripts/sync-upstream-release.mjs` | 把上面两者组装成 `package.json` / `Cargo.toml` / `Cargo.lock` | 自己拼合成号（调台账）；自己查目标表选通道 |

**命名规则（只有一条）**：本仓「`channel`」**只**指**桌面通道**
（`stable` / `rc` / `alpha`，由**版本后缀**推导，见 `desktopChannelForVersion()`）；
上游那条 npm dist-tag 一律叫 **`upstreamDistTag`**，且只用于发现/参考。
目标表里那个旧名 `channel` 的字段已于 2026-10-09 改名（`release-ledger.mjs` 单向依赖
`dsh-targets.mjs`，反向 import 会让「目录契约」与「发布事实」互相绑定）。

⚠️ **`stable` 不是目标名**：目标表里没有 `stable` 键——正式线的载体仍是未决开口
（ADR-061 决策 7；条件化等待项登记在 `docs/dsh-upgrade-checklist.md` §6）。
因此 `targetForVersion('0.2.0')` 仍落**默认目标**（`next`），而
`desktopChannelForVersion('0.2.0')` 给 `stable`——两者**刻意不同**：一个答「用哪套补丁目录」，
一个答「这一版对外属于哪条通道」。自测同时钉住这两条，改动其一必红。

---

## 4. 上游同步规则

| 项 | 口径 |
|---|---|
| `x.y.z` 的唯一产地 | `harness-locks/dsh-releases.json` 里该次构建的 `upstreamDsh.version` |
| 上游预发布段（如 `rc.3`） | **原样保留进版本号**（§1.1 已定案，`0.2.0-rc.3.1`）；它**同时**落在 `MANIFEST.upstreamDsh` 与 CHANGELOG 的上游股里 |
| 「上游前进」的判据 | 上游 npm dist-tag 指向的版本发生变化（**dist-tag 是活的，任何「当前是 X」都要带测量日期**） |
| 补丁 / 包目录命名 | 按**目标键**命名，**不按桌面后缀**；`verify:patches` 判「补丁文件名版本段 == `dshVersion`」⇒ **改锚点与重命名补丁必须同批** |
| 🔴 锚点判据的口径 | 补丁文件名锚的是**上游精确版本段**（`dshVersion`），桌面号是**合成号**——两者**不是同一字符串**。判据须继续锚 `dshVersion`，**不得**锚桌面号 |

⚠️ **上游没有 `rc` 这条 dist-tag**（只有 `latest` / `next` / `alpha`）。因此
`upstreamDistTag`（上游 dist-tag）与 `publishChannel`（桌面后缀）**必须解耦**：若两者同名，
`tags['rc'] ?? latest` 会**静默退回 `latest`**，漂移哨兵永久误报。见 §3.3 的字段归属表。

---

## 5. 发布流程与规范

### 5.1 九个步骤（按序，缺一步即视为未完成）

| # | 步骤 | 命令 / 判据 |
|---|---|---|
| 1 | 上游同步 | `sync-upstream-release.mjs` → 更新 `harness-locks/dsh-releases.json` 与 `dshVersion` 锚点 |
| 2 | 功能检测 | 从「上个 tag..HEAD」分类提交 → `docs/releases/FEATURES.md` |
| 3 | 出 Release Plan | `release-manifest.json`：`releaseType` + `breaking` + `n` + `w` |
| 4 | **派生**版本号 | `npm run version:next`（**不手填**）→ 写 `package.json` |
| 5 | 原子发布提交 | `package.json` + `Cargo.toml` + `Cargo.lock` + `CHANGELOG.md` **同一个提交** |
| 6 | 门禁 | `npm run gate -- --tier=release`；命中敏感路径再跑条件式人工 smoke |
| 7 | 推送 | `main:main` → 确认 → **`"<tag>"`**（两步；**禁 `--follow-tags`**；tag **加引号**） |
| 8 | Release | **Draft → Verify → Publish**；按**资产清单**核数（期望 **13**） |
| 9 | 发布后回读 | 见 §5.3 |

### 5.2 两条顺序纪律（都是踩过的坑）

**① 变更日志与打 tag 之间不要再提交。**
段落区间取「写日志那一刻」=「上个 tag..当时 HEAD」。此后到打 tag 的提交**不属于任何段落**，
而 `verify:changelog` 是**纯逻辑**（不与 git 交叉核对）⇒ **不报红**。
正确顺序：非发布提交先落 → 生成段落 → 提交发布（第 5 步原子）→ **立刻打 tag**。

**② 发布提交必须原子。** 分两个提交会出现「tag 指向有版本号、没变更日志的那个提交」。

### 5.3 发布后回读断言（不可省的验收）

| 断言 | 判据 |
|---|---|
| 资产完整 | 按清单数 = **13**（9 安装包 + 1 `latest.json` + 3 便携版）；核对旧 tag **别套 13** |
| 无空文件 | 无 0 字节；`.sha256` 约 100 B 属正常 |
| 滚动端点 | `version == 新版` **且** `url 里的 tag == 新 tag`（⚠️「间隔取回不回退」是**错的判据**——上传错的那份会让三次取回全是旧内容且稳定，**反而通过**） |
| ⚠️ URL 可达 | `latest.json` 里的 `url` 必须回读 **HTTP 200**。**理由**：合成本仓段含 `+`，而安装包**文件名本身**就含它（NSIS 命名为 `{productName}_{version}_{arch}-setup.exe`）⇒ 若下游按**表单编码**处理 `+` 会变空格 ⇒ 404 |
| Release 属性 | `prerelease` / `draft` 与目标通道一致（⚠️ `v0.7.2-rc.1` 曾出现 `prerelease=false` 的**带外人工改**，GitHub **无编辑历史** ⇒ 只能靠回读断言发现） |

---

## 6. 与所提交《DSH Desktop V3 版本号更新策略》的逐条对照

**结论先行**：该文档的**组织原则与大部分细则被采纳**；其 **§4 的技术前提经实测证伪**，
据此从「必须写自定义比较器」改为「**不得**依赖 build 段承担排序」。

### 6.1 采纳（文档说得对，且与本仓事实相符）

| 文档节 | 内容 | 处置 |
|---|---|---|
| §11 | 破坏性变更**不**升 major（major 属上游） | ✅ 采纳，落为 §2.1① |
| §33 | 功能修订号**不跨** alpha / RC | ✅ 采纳，落为 §2.3 |
| §35 | 修订号**按 Release 递增，不按 commit** | ✅ 采纳，落为 §2.2 |
| §36 | 增加 release 类型 `upstream` / `desktop-feature` / `desktop-fix` / `mixed` | ✅ 采纳，落为 §3.2 |
| §41 / §51 | 真正要重构的是「**谁有权决定版本号**」 | ✅ **采纳为组织原则**，落为 §3.1 的链路 |

### 6.2 🔴 修正：§4「`+N` 必须由 Updater 自定义比较器支持」——**实测证伪**

文档的推理是：标准 SemVer 下 build metadata **不参与**优先级 ⇒ 默认比较器不会把 `+1` 当更新
⇒ 必须写 `version_comparator`。

**链路实测（逐环，可复现）**

| 环 | 证据 | 结论 |
|---|---|---|
| 默认判据 | `tauri-plugin-updater-2.13.0/src/updater.rs:669-672`：`None => release.version > self.current_version` | 默认就是**活体 `Ord`**，不是"规范优先级"函数 |
| 远端版本类型 | 同文件 `pub version: Version`（`semver::Version`），经 `parse_version` = `Version::from_str(...)` | **保留 build** |
| 本机版本类型 | `tauri-utils-2.10.1/src/lib.rs:53` `PackageInfo { version: Version }`；上游 `tauri-codegen-2.7.0/src/context.rs:255-264` 用**原始串**再 `.parse()` | **保留 build** |
| `Ord` 语义 | `semver-1.0.28/src/lib.rs:157` `#[derive(Clone, Eq, PartialEq, Ord, PartialOrd, Hash)] pub struct Version`；同文件 `:456` 的 `Ord` 示例**明写** *"Totally order the versions, **including comparing the build metadata**"* | **`Ord` 比较 build**——且是**文档化**行为，不是意外 |
| 实测 | `0.2.1-alpha.1+1 > 0.2.1-alpha.1` = **true**；`0.2.1+2 > 0.2.1+1` = **true** | 与文档断言相反 |

⇒ **在本仓技术栈上，默认比较器「认」`+N`，自定义比较器不必要。**

**但真正的分歧确实存在，只是位置不同 —— 在本仓自己的 JS 里（E14）：**

| 实现 | `compareSemver('0.2.0-rc.3+w1','0.2.0-rc.3+w2')` | 产地 |
|---|---|---|
| Rust（updater 实际使用） | `w2 > w1`（`Ord` 含 build） | `semver 1.0.28` |
| **本仓 JS** | **`0`（相等）** | `scripts/conventional-commits.mjs:267`；根因是 `:282` 的 `parseAnySemver` 用**非捕获组** `(?:\+[0-9A-Za-z.-]+)?` 丢弃 build |
| 第三套（NSIS 安装器，仅用于措辞） | 未验证 | `installer.nsi:234` `nsis_tauri_utils::SemverCompare "${VERSION}" $R0`（比**原始串**） |

🔴 **危害是具体的**：`scripts/updater-manifest.mjs:112` 与 `scripts/version.mjs:323,326`
都用这个 JS 比较器——前者决定滚动通道取哪份清单，后者是「版本不得倒退」的守卫。
若让 build 段承担排序，这两处会**静默失效**。

### 6.3 修正：§5「Windows 兼容性」——实测结果比文档的猜测更宽松，但有两条要注意

| 目标 | 版本从哪来 | `+` 的命运 |
|---|---|---|
| **NSIS**（本仓实际使用） | `try_add_numeric_build_number()`（`windows/nsis/mod.rs:149-172`） | **数字 build 进第 4 槽**（`0.2.1+3` → `VIProductVersion 0.2.1.3`）；**非数字 build → 记 warning 并用 `0`**（`0.2.1+w3` → `0.2.1.0`） |
| **NSIS 真实升降级判定** | `installer.nsi:234` `SemverCompare "${VERSION}" $R0` | 比的是**原始版本串**，**不是**那个 4 段数字。⇒ 第 4 槽只影响文件属性显示 |
| **macOS**（`app,dmg`） | `bundle/macos/app.rs:241-250` | `CFBundleShortVersionString` = **原始串**（`+` 直达）；`CFBundleVersion` = `bundle.macOS.bundleVersion` **未设置时也回落原始串** ⇒ 与 Apple「数字点分」约定不符（**此问题在 `+` 出现前就存在**，非本次引入） |
| **deb** | `bundle/linux/debian.rs:174` `Version: {version_string()}` | Debian `upstream_version` 允许字符**含 `+`** ⇒ 通过 |
| **rpm** | `bundle/linux/rpm.rs:22,78` | 本仓 `bundles` **不用 rpm**；且 rpm 的 version **不允许 `-`**，若将来启用需单独评估 |
| **AppImage** | 只体现在文件名 | 无版本语义 |
| **MSI**（本仓不用） | `convert_version()`（`windows/msi/mod.rs:342-370`） | **会 `bail!`**：prerelease 必须是**纯数字**且 ≤65535 ⇒ `0.2.1-alpha.1` 直接失败 ⇒ **切勿启用 MSI** |

⇒ 文档 §5 担心的「Windows 兼容性」在本仓**不构成阻断**；真正的残留未知项见 §8-3。

### 6.4 采纳：§3 的格式（**已于 2026-10-08 按裁决落到 §8.1**）

| 文档主张 | 处置 |
|---|---|
| Release Version = 上游版本 + 本仓功能修订号 | ✅ **采纳**——本策略的全部内容 |
| 格式 `<upstream-semver>[+<revision>]` | ✅ **采纳其结构**，但修订号落在**预发布段**（`…<上游预发布>.<n>`），**不落在 build 段**；`+<w>` 只作可选标签 |
| **完整保留上游预发布段** | ✅ **完全采纳** ⇒ 见 §8.1 |

### 6.5 明确不采纳

| 文档主张 | 不采纳理由 |
|---|---|
| **让 `+N` 承担排序**（把排序键放进 build 段） | SemVer **规范**明确规定 build metadata 不参与优先级；本栈今天能排是**实现意外**（虽已文档化）。一旦 `semver` 升到 2.x 去对齐规范，排序会**静默失效**。用 §1.2-3 的不变量把排序留在**预发布段**，则**不依赖任何第三方行为** |
| 自定义 `version_comparator` 作为**必需项** | §6.2 已证伪。且它**解不了**真正的问题（本仓 JS），反而增加一条「已安装二进制内置逻辑」的维护面 |
| `allow_downgrades` 作为放宽手段 | 它把「must be newer」变成「**must be different**」= 放开**任意**回滚，与 `version_comparator` **互斥**。仅用于 bridge 版（内置放宽比较器的那一版） |

---

## 7. 守卫与验收

### 7.1 三条必须存在的守卫（缺一即视为策略未落地）

| # | 断言 | 反例（必须判红） |
|---|---|---|
| 1 | **已发布构建不得共享 `(x.y.z, 上游预发布, n)`** | 台账里出现两条 `(0.2.1, alpha.1, 3)` |
| 2 | **`w` 永不参与排序** | `compareSemver('0.2.1-alpha.1.3+w1','0.2.1-alpha.1.3+w2')` 必须 **`0`**；若实现改成参与，判红 |
| 3 | **通道解析不得静默回落** | `channelOfPrerelease('0.2.1.3-rc.1')` 现在返回 `null` → `targetForVersion` 静默给 `next`（**既有缺口 2i**）。修正后必须 **`throw`**，不得返回 `null` |

### 7.2 三条不变式（每批改完都要跑）

1. `x.y.z` 逐位等于上游；`n` 在同组内单调不减、且无重复（守卫 1）。
2. `w` 字符集 `[0-9A-Za-z-]`，**无 `_`**，无前导零出现在 `n` 上。
3. 变更日志：`changelog:write --force` 后**上游股字节不变**（上游股冻结入库）。

### 7.3 门禁与文档守卫

- 版本/发布相关：`verify:release-workflow`、`verify:changelog`、`verify:patches`、`verify:targets`，
  以及本次新增的两条（**已于 2026-10-08 注册进 `scripts/gate-manifest.mjs`**）：
  - **`release-ledger`** —— `scripts/release-ledger.mjs`：台账自洽（守卫 1：二元组不重复 + `n` 序列无空洞）
    与「`desktopVersion` 逐字等于由 `(upstreamDsh, n, w)` 合成出来的串」。空台账时**打印「空集判据」**，
    不静默通过。
  - **`version-policy`** —— `scripts/verify-version.mjs`：守卫 1（台账）+ 守卫 2（`w` 不参与排序）
    + 守卫 3（通道解析严格）。⚠️ 它的被探测实现是**参数化注入**的，自测里喂「比较 build 的比较器」
    与「缺口 2i 的旧实现」并断言报红——否则判据写坏时同样给绿。
- 改 `docs/` 后必须同时跑：`verify-claims` / `verify-plan-facts` / `verify-doc-facts`
  （最后一个含 **ADR 计数**断言——新增 ADR 会改计数）。
- 唯一门禁入口：`npm run gate -- --tier=<fast|ci|release|sentinel|full>`；清单产地
  `scripts/gate-manifest.mjs`。

### 7.4 发布前门禁（按序）

1. `gh workflow run ci.yml --ref main`
2. **两条通道各一次** `smoke.yml -f scope=full -f dsh_target=next|alpha`，须落在**将要打 tag 的那个提交**上
   （⚠️ `dsh_target` **默认 `next`**：只按默认跑 = 只验一条线；核验靠日志里的 `DSH_TARGET:` 与 `harness-deps/(next|alpha)`，两个 run 的 job 名与结论**完全一样**）
3. 全绿后打 tag（两步推送，见 §5.1 步 7）
4. 按资产清单核数（13）并做 §5.3 的回读断言

---

## 8. 决策点

> ✅ **1 与 2 已于 2026-10-08 裁决**；**3 与 4 仍待裁决，但不阻塞施工**。

### 8.1 ✅ 已裁决：本仓序号落在**预发布段**

**裁决（维护者，2026-10-08）**：采 `x.y.z-<上游预发布>.<n>`（如 `0.2.1-alpha.1.3`）；
`+<w>` 降为**可选的纯标签**。原决策表保留为记录：

| | **已采纳**：`…<上游预发布>.<n>` | 首版草稿：`…<通道>.<n>+<w>`（已否） |
|---|---|---|
| 上游身份可辨识 | ✅ 含上游预发布段 | ⚠️ 丢上游预发布段 ⇒ 与上游 `rc.N` **字形撞车** |
| 排序由**规范**支持 | ✅ 数字预发布标识符按数值比较 | ❌ 靠 `Ord` 含 build 的实现细节 |
| 三套比较器一致 | ✅ **全部一致** | ❌ Rust 认、本仓 JS 不认 |
| 需改本仓 JS 比较器 | ❌ 不需要 | ✅ 必须 |
| `semver` 升 2.x 后 | 🟢 不受影响 | 🔴 可能**静默**失效 |
| Windows `VIProductVersion` 第4槽 | 恒 `0`（真实升降级判定走原始串，不受影响） | 数字 `n` 可见 |
| 通道解析零改动 | ✅ 实测 `alpha.1.3` → `alpha` | ✅ 实测 `rc.3+w3` → `next` |

⇒ 已落为 **ADR-061** 的决策 1–4。首版草稿「必须同批修改本仓 JS 比较器」那笔代价
（`parseAnySemver` 加 build 捕获组 + `compareSemver` 比较 build，否则 `updater-manifest` 与
版本单调守卫静默失效）**不再需要支付**。

### 8.2 仍待裁决（**不阻塞施工**）

**3. 是否设置 `bundle.macOS.bundleVersion` 为纯数字单调值？**
`CFBundleVersion` 现状 = 原始版本串（含 `-alpha.1`），不符 Apple「数字点分」约定。
这是**既有**问题（与本方案无关），但合成本仓段会让它更显眼。建议设为从 `n` 派生的数字串。

**4. `w` 是否保留？** 若它不承担排序、只作人读标签，是否直接废除以简化版本号与守卫？

---

## 9. 一页速查

```
命名：  <上游精确 x.y.z>-<上游预发布>.<n>[+<w>]    例 0.2.1-alpha.1.3
排序：  x.y.z  →  上游预发布  →  n     （w 永不参与）
发版：  上游前进 → n 归 1 ；本仓 feat/fix/perf/sec/refactor → n+1
不发版：docs / ci / test / 注释
破坏性：n+1 + Feature Log 标 breaking，**不动 major**
粒度：  按 Release 递增，不按 commit；n 不跨上游版本/预发布段
权限：  commits → Feature Log → Release Plan → **机器派生** Version（人不填）
流程：  同步 → 检测 → 计划 → 派生 → 原子提交 → 门禁 → 两步推送 → Draft/Verify/Publish → 回读
守卫：  n 不重复 / w 不排序 / 通道解析不静默回落
开口：  正式线（上游无预发布）的序号载体 —— ADR-061 决策 7
```
