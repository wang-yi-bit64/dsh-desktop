# ADR-061 — 合成版本号：上游 `x.y.z-<上游预发布>` 原样保留 + 本仓 `<n>` 追加

|  |  |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-08 |
| 取代 | 同日的 `061` 草稿（`<上游x.y.z>-<通道>.<n>+<w>`）。草稿把**排序键放在 build 段**，被 §3 的实测否掉；本文件是同一决策位的**现行版本** |
| 唯一产地 | `harness-locks/dsh-releases.json`（**序号 `n` + `w` + 已发布台账 `builds[]`**）；`harness-locks/<target>/inputs.json`（上游精确版本 `dshVersion` 与预发布段）；`package.json`（合成号的落点，经 `tauri.conf.json` 原生继承到 Tauri / Windows 资源） |
| 关联 | ADR-057（**跨通道单调守卫，继续有效**，本 ADR **不取代**它）；ADR-056（ADR-057 的被修订前身）；ADR-060（其决策 3 与「桌面版本单调性」校验行的**表达形式作废**）；ADR-028（版本号唯一真源保留；**其决策 4 的推进规则由本 ADR 接管**） |
| 落实 | `docs/version-policy.md`（策略唯一口径；本 ADR 是其上位决策记录） |

## 背景

原提案主张「公开版本号由 DSH 唯一拥有、桌面壳不再拥有独立 SemVer 生命周期」。**维护者 2026-10-08
否决了这一主张**，并给出三条约束：

1. **大版本号跟随上游版本变化**；
2. **功能版本号需维护独立的版本日志与变更记录**；
3. 需兼顾 **rc 与 alpha 双通道**发布策略。

约束 2 是决定性的：**版本号里必须有一个位用于标注本仓自身的功能变化**。这直接排除了
「桌面 version := 上游 version」——那种形态下本仓没有可标注的位。

维护者随后提案字形 **`x.y.z.w`**（前三段沿用上游，第四段标识本地功能更新），并要求论证可行性。
**实测结论：该字形不可行**，有三条**互相独立**的失败路径：

| 失败点 | 事实 |
|---|---|
| 解析期 | `0.2.1.3` 一律 `REJECT`：`unexpected character '.' after patch version number`（SemVer 在 patch 后只接受 `-` 或 `+`） |
| **构建期** | `tauri-codegen` 在 `context.rs` 写死 `semver::Version::from_str(version)?`，而 `tauri.conf.json` 的 `version = "../package.json"` ⇒ **`tauri build` 在 codegen 阶段即失败，产不出产物** |
| **静默回退** | 仓库自己的 `dsh-targets.mjs` 会把它**静默**判成 stable → `next`，按错的补丁集与 lockfile 组装而**不报错** |

⇒ 维护者想表达的**语义**可行，但**载体**必须换。

同日晚先接受了第一版合成方案 `<上游x.y.z>-<通道>.<n>+<w>`（序号在预发布段、桌面功能标识在 build 段）。
**该版随即被本 ADR 取代**，原因是 §3 的实测：**build 段的排序语义在三套并存的比较器之间不一致**，
而 SemVer 规范明确规定 build metadata **不参与**优先级。

## 决策

### 1. 桌面版本号 = 合成号

```text
<上游精确 major.minor.patch>-<上游预发布>.<纯数字序号 n>[+<w>]
              ↑                      ↑              ↑       ↑
        逐位抄上游            原样保留上游预发布   本仓序列  可选纯标签
```

| 上游版本 | 桌面第 1 / 第 2 次构建 |
|---|---|
| `0.2.1-alpha.1` | `0.2.1-alpha.1.1` / `0.2.1-alpha.1.2` |
| `0.2.0-rc.3` | `0.2.0-rc.3.1` / `0.2.0-rc.3.2` |
| `0.2.1`（正式版，**开口见决策 7**） | `0.2.1-1` / `0.2.1-2` |

### 2. 各段的归属与规则

| # | 规则 |
|---|---|
| 1 | `major.minor.patch` **逐位等于上游**，本仓**不占用 patch 段**。只有上游前进才能改这三段 |
| 2 | `<上游预发布>` 段**原样保留**（`alpha.1`、`rc.3`…），本仓**不改写、不替换** |
| 3 | `n` 是 `(major.minor.patch, 上游预发布)` 组内的**纯数字**序号，从 `1` 起，**无前导零** |
| 4 | **`n` 是本仓段里唯一的排序键**（`x.y.z` 与预发布段由上游决定，优先级更高） |
| 5 | 上游前进（含预发布段前进）⇒ `n` **归 1** |
| 6 | `w` 字符集 `[0-9A-Za-z-]`（**禁 `_`**、禁前导零）；**永不参与排序**，只作人读标签；不需要时可**整个省略** |
| 7 | 建议的 `w` 词汇：`feat`/`fix`/`perf`/`sec`/`refactor` 或批次代号 |
| 8 | 🔴 **结构性不变量**：**已发布构建不得共享 `(major.minor.patch, 上游预发布, n)` 三元组** |

### 3. 为什么排序键必须落在预发布段（本 ADR 的核心实测）

本仓**同时存在三套 semver 比较实现**，而它们对 **build metadata** 的态度**并不一致**：

| 实现 | 产地 | `compare('…rc.3+w1','…rc.3+w2')` |
|---|---|---|
| **Rust**（updater 实际使用） | `semver 1.0.28`：`Version` 用 `#[derive(…, Ord)]` ⇒ **比较 build**（其 `Ord` 示例**明写** "including comparing the build metadata"；规范口径在另一函数 `cmp_precedence()`） | `w2 > w1` |
| **本仓 JS** | `scripts/conventional-commits.mjs` 的 `compareSemver`：`parseAnySemver` 用**非捕获组**丢弃 `+…` ⇒ **忽略 build** | **`0`（相等）** |
| **NSIS 安装器** | `installer.nsi` 调 `nsis_tauri_utils::SemverCompare`，比的是**原始版本串** | 未验证 |

本仓 JS 的这个比较器被 **`updater-manifest.mjs`（滚动清单取哪份）** 与 **`version.mjs`（版本不得倒退的守卫）**
使用 ⇒ **只要让 build 段承担排序，这两处就会静默失效**。

更根本的是：**SemVer 规范规定 build metadata 不参与优先级**。Rust 侧的 `Ord` 认 build 是**实现细节**
（虽然已被文档化），`semver` 升到 2.x 对齐规范时**可能静默改变**。

⇒ 把序号放进**预发布段**后，排序由规范本身保证（**数字标识符按数值比较**），
**三套实现语义一致**，且不依赖任何第三方实现细节。

### 4. 上游身份的可辨识度

本形态下合成号可以读出：`major.minor.patch` **精确**、上游预发布段 **精确**、本仓序号可辨。
这比第一版草稿更强（草稿丢弃上游预发布段，会与上游自己的 `rc.N` 序号**字形撞车**）。

### 5. 与既有 ADR 的处置

| ADR | 处置 |
|---|---|
| **ADR-057**（跨通道单调守卫） | **继续有效，本 ADR 不取代它**。`x.y.z` 来自上游、序号归本仓 ⇒ 守卫可自由排序，**数学上可满足** |
| ADR-056 | 是 ADR-057 的被修订前身，不受影响 |
| **ADR-060 决策 3** 与「桌面版本单调性」校验行（`0.7.3-alpha.1 > v0.7.2-rc.1`） | **表达形式作废**（那是旧模型下的下游结论） |
| **ADR-028** | **决策 1（`package.json` 是唯一真源）保留**；**决策 4（`feat` 升 minor / `fix` 升 patch 的推进规则）由本 ADR 接管**——新模型下版本号**不再由提交类型决定**，而由台账派生 |

### 6. 谁有权决定版本号

版本号**不由人填写**，由链路派生：

```text
git commits → Feature detection → Feature Log → Release Plan → 机器派生 Version
```

`release-manifest.json` 里的 `n` 取值 = 台账 `builds[]` 中同组 `max(n) + 1`。
人只在 **Release Plan** 这一步做「何时切一版」的决策。

### 7. 🔴 尚未定案的开口：正式线（上游无预发布）的序号载体

本形态要求「上游预发布段」存在。当上游为**正式版**（如 `0.2.1`）时，`0.2.1-<n>` 的首标识符是**纯数字**，
而 `channelOfPrerelease` 会把它当成通道名 ⇒ `targetForPublishChannel('1')` 返回 `null` ⇒ 调用方报错。

**当前不可达**：本仓只有 `next`（`publishChannel` = `rc`）与 `alpha`（`publishChannel` = `alpha`）两条线，
`stable` 语义尚未开工。**建议的扩展规则**：首预发布标识符为**纯数字**即判定为**正式线**，走 `stable` 目标；
该规则需在 `stable` 目标落地时（P2）另行确认并补进 `dsh-targets.mjs` 与本节。

## 备选方案与取舍

| 方案 | 取舍 |
|---|---|
| `x.y.z.w`（四段式） | ❌ **实测证伪**（三条独立失败路径，见背景表） |
| 甲：`<上游major>.<上游minor>.<本仓计数>-<通道>.<n>` | ❌ patch 段被顶掉 ⇒ 上游补丁级前进在版本号上不可见 |
| 乙：`<上游major>.<本仓功能>.<本仓修订>-<通道>.<n>` | ❌ 读不出上游 minor/patch；且会让目标线 `0.8.x > 0.7.3` ⇒ **无降级路径**，推翻 bridge 决策 |
| 第一版：`x.y.z-<通道>.<n>+<w>` | ❌ 排序键落在 **build 段** ⇒ 依赖 `semver::Ord` 含 build 这一**未承诺**实现细节，且本仓 JS 比较器忽略 build ⇒ 两处守卫静默失效；另丢弃上游预发布段 ⇒ 与上游 `rc.N` 字形撞车 |
| `+N` 承担排序 + 自定义 `version_comparator` | ❌ 实测**不需要**（updater 默认判据就是 `release.version > current_version`，即活体 `Ord`，`+N` 今天就能排序）；且自定义 comparator **解不了**本仓 JS 的分歧，反而新增「已安装二进制内置逻辑」的维护面 |

## 后果

**正面**

- 排序**全部由 SemVer 规范保证**（数字预发布标识符按数值比较），不依赖任何实现细节；`semver` 升 2.x 不受影响。
- 三套比较器（Rust `Ord` / 本仓 JS / NSIS）**语义一致**，本仓 JS 比较器**无需改动**。
- `dsh-targets.mjs` 的通道解析**零改动即可读懂**本形态（已实测：`'0.2.1-alpha.1.3'` → `alpha`/`alpha`；
  `'0.2.0-rc.3.1'` → `rc`/`next`）。
- 上游身份精确到 `major.minor.patch` **且**预发布段可读。

**代价（均已记账）**

1. 序号变成**两级**（`alpha.1.3` 里 `1` 属上游、`3` 属本仓），读者需要懂这条约定。
2. 合成号含**两段**预发布 ⇒ 产出物文件名随之变长（`{productName}_{version}_{arch}-setup.exe`）。
3. Windows `VIProductVersion` 第 4 槽恒为 `0`（无 build 段）。
   ⚠️ 但**真实的升降级判定**走 `SemverCompare "${VERSION}"`（原始串），**不受影响**。
4. 上游预发布段进入桌面号 ⇒ 上游 `alpha.1 → alpha.2` 会让桌面号**跳变**（这是刻意的：上游身份必须可见）。
5. macOS `CFBundleShortVersionString` / deb `Version:` 含两段预发布。
   ⚠️ `bundle.macOS.bundleVersion` **未设置**是**既有**问题（与本次无关），建议另行补一个纯数字单调值。

**已登记的已知缺口**

- **2i**：`channelOfPrerelease` 把「格式不符」与「无预发布后缀」合并成同一个 `null`
  ⇒ 形如 `0.2.1.3-rc.1` 的版本会被**静默**判成 stable → `next`。**与是否采纳本形态无关**，须单独修。
- **正式线开口**：见决策 7。

## 守卫与证据

| 守卫 | 断言 | 反例（必须判红） |
|---|---|---|
| 序号唯一 | 台账 `builds[]` 内不得出现两条同 `(x.y.z, 上游预发布, n)` | 两条 `(0.2.1, alpha.1, 1)` |
| `w` 不排序 | `compareSemver('0.2.0-rc.3.1+w1','0.2.0-rc.3.1+w2')` 必须为 `0` | 实现改成比较 build ⇒ 判红 |
| `n` 单调 | 同组内 `n` 单调不减且无重复 | `n` 回退或复用 |
| 上游段一致 | 台账与交付物的 `major.minor.patch`、上游预发布段逐位等于锚点 | 手抄漂移 |
| 通道解析不静默回落 | `channelOfPrerelease('0.2.1.3-rc.1')` 必须**抛错**，不得返回 `null` | 返回 `null` ⇒ 判红 |
| 上游段冻结 | `changelog:write --force` 后上游段**字节不变** | 上游段被重生成 |

| 证据 | 内容 |
|---|---|
| 解析期证伪 | `semver::Version::from_str('0.2.1.3')` → `unexpected character '.' after patch version number` |
| 构建期证伪 | `tauri-codegen` 的 `context.rs` 对 `config.version` 调 `Version::from_str(…)`，失败即 `?` 上抛 |
| build 语义分叉 | `semver 1.0.28` 的 `Version` 派生 `Ord` 含 build（其示例明写），而本仓 `parseAnySemver` 用非捕获组丢弃 build |
| updater 默认判据 | `tauri-plugin-updater` 的 `updater.rs`：`match self.version_comparator.as_ref() { Some(f) => f(…), None => release.version > self.current_version }` |
| 通道解析实测 | `dsh-targets.mjs` 对 `'0.2.1-alpha.1.3'` / `'0.2.0-rc.3.1'` 分别返回 `alpha`/`alpha`、`rc`/`next`；对 `'0.2.1.3-rc.1'` 返回 `null`（即缺口 2i） |
| Windows 侧 | `tauri-build` 的 `to_winres_version` 把**数字** build 放进第 4 槽，**非数字静默取 0**；本形态无 build 段 ⇒ 恒 0 |
