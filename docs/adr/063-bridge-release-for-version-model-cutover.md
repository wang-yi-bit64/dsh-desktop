# ADR-063 — 换代桥接版：合成号排序低于旧模型号时的一次性放宽（`plugins.updater.allowDowngrades`）

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-09 |
| 唯一产地 | `harness-locks/dsh-releases.json` 的 `bridges[]`（**哪些版本是桥接版**）+ `scripts/release-ledger.mjs::findPermittingBridge`（**豁免是否成立**）+ `scripts/updater-manifest.mjs::composeUpdaterConfig`（**构建期注入什么**） |
| 修订 | ADR-061（**不取代**其合成号模型；本 ADR 补上它未覆盖的「换代后第一次投递」缺口）；ADR-057（跨通道单调守卫的**基础判据继续有效**，本 ADR 只增加一条**有凭据的**豁免通道） |
| 关联 | ADR-061（合成号）；ADR-057 / ADR-056（跨通道单调守卫）；ADR-053（通道化更新清单）；ADR-007（宣称纪律）；`docs/version-policy.md` §6.5 / §7；`docs/dsh-upgrade-checklist.md` §6 |

## 背景

ADR-061 把桌面版本号换成**合成号**（`<上游精确 x.y.z>-<上游预发布>.<n>[+<w>]`）。合成号跟随**上游**的版本线，而本仓线上历史 tag 属于**旧模型**（桌面自己的 `0.7.x`）。两者第一次相遇时出现一个 ADR-061 未覆盖的缺口：

| 事实 | 实测值（2026-10-09） |
|---|---|
| 已发布 `v*` tag | 14 个（本地 `git tag` 与 `gh api repos/wang-yi-bit64/dsh-desktop/tags` **双侧一致**） |
| 线上最高 tag | `v0.7.3-alpha.1`（rc 线最高 `v0.7.2-rc.1`） |
| 本轮候选合成号 | alpha 线 `0.2.1-alpha.1.1`、next 线 `0.2.0-rc.2.1` |
| 候选 vs 最高 tag | `compareSemver` 均为 **-1**（候选更低） |

两个后果，**第二个比第一个严重**：

1. **守卫会红**：`version.mjs::checkVersionMonotonic`、`release.yml` preflight、`updater-manifest.mjs --verify` 三处都会报「版本线非单调」/「更新零投递」。这一条只是症状。
2. **发出去也没人收到**：已装客户端的 updater 默认判据是 `release > current`。客户端的 `current` 是 `0.7.x`，收到的候选是 `0.2.x` ⇒ **不更新**。这不是守卫过严，是投递真的断了。

策略文档已经点到过手段但**没有定案**：`docs/version-policy.md` §6.5 把 `allow_downgrades` 记为「把 `must be newer` 变成 `must be **different**`，仅用于 bridge 版」，但当时既无 ADR，也无任何代码落地 —— 也就是说，**「先发一个 bridge 版」此前只是一句散文**，没有执行者（与 ADR-062 记录的「禁令只写在散文里」属同一失效形态）。

仓库侧可执行证据（本 ADR 依赖的前提）：

- `src-tauri/src/lib.rs` 第 66 行是 `.plugin(tauri_plugin_updater::Builder::new().build())` —— **没有**设置自定义 `version_comparator`。
- ⇒ 插件配置里的 `plugins.updater.allowDowngrades` **会生效**（`tauri-plugin-updater` v2：自定义比较器缺席时使用默认实现，而默认实现读该键决定「必须更新」还是「必须不同」）。
- `.github/workflows/release.yml` 已用 `node scripts/updater-manifest.mjs --write-config "$TAG" .updater-config.json` 覆盖 `plugins.updater.endpoints`，因此新键可以**沿同一条路**注入，无需改工作流。

## 决策

1. **换代用「桥接版」（bridge）**：在合成号之前，先在**同一条桌面通道**上发布一个**版本号更高**、且**内置放宽比较器**的版本。已装用户升上它之后，才可能接收排序更低的合成号。
2. **放宽手段当前只有一种**：`plugins.updater.allowDowngrades`。它被登记为 `release-ledger.mjs::BRIDGE_RELAXATIONS` 的**唯一**成员；`validateBridge` 与 `composeUpdaterConfig` 都据此判红未知手段 —— 换机制必须**同批**改登记表与消费点，不许只改台账。
3. **桥接版登记在台账**：`harness-locks/dsh-releases.json` 新增 `bridges[]`（`schemaVersion` 1 → 2）。字段：`version` / `tag` / `channel` / `target` / `upstreamDsh` / `relaxes` / `date` / `why`。`bridges[]` **不承担排序**，只回答两件事：① 构建期要不要写 `allowDowngrades`；② 豁免有没有凭据。
4. **豁免判据三条，缺一不可**（唯一产地 `findPermittingBridge`）：
   1. **同通道** —— 每个桌面通道有自己的滚动 Release 与 `latest.json`，别的通道的桥接版管不到这里的客户端；
   2. **`bridge.version ≥ 该通道已发布的最高版本`** —— 若桥接版本身比该通道已知最高 tag 低，它当年根本没送达，豁免就变成「用一个没生效的机制绕过守卫」；
   3. **该桥接版的 tag 已在 tag 语料里** —— 台账记录只是**意图**。少了这一条，一条「登记了但永不发布」的记录就能永久给出豁免，而这正是最该被拦下的形态（豁免在跑、客户端其实收不到）。因此**不给 `tags` 语料一律不豁免**：无凭据不等于默认成立。
5. **豁免只降级两条守卫的「后果」，不改判据本身**：
   - `version.mjs::diagnoseVersionMonotonic`：命中豁免 ⇒ `problems` 为空、`notes` 写入可读依据（**禁止无声通过** —— 否则「豁免成立」与「判据没查」在输出上完全一样）；
   - `updater-manifest.mjs::diagnoseChannelManifest`：同上，且结论行**按实际结局分项写**，不得再宣称「端点 version ≥ 该通道最新已发布 tag」（豁免场景的定义就是端点 version 低于它）。
6. **豁免是长期的，不逐次补登记**：合成号排序永远低于旧模型号，所以只要该通道最新的号仍是桥接版（合成号更小 ⇒ 必然如此），后续合成号沿用同一条依据。一旦有人在桥接版之上发了**更高的号**（那一版**没有**放宽比较器），豁免**自动失效**并重新判红 —— 无需人工清理。
7. **放宽只对「装过桥接版的人」生效**（本方案的核心代价，如实登记）：从未安装过桥接版的用户（全新安装、或长期未更新者）拿到的仍是一个比 `current` 更低的号 ⇒ 照旧不更新。他们必须经历一次桥接版。**本 ADR 不假装解决了这一点**。
8. **注入只发生在桥接版上**：`composeUpdaterConfig` 只在 `bridges[]` 命中时才写 `allowDowngrades`；非桥接版的产物里**不许出现该键**。放宽 = 放开**任意**回滚，代价只该付一次。

## 备选方案与取舍

- **B) 守卫层直接给合成号开白名单，接受已装用户零投递**：否决。那会让「守卫绿」与「更新可达」变成两件事，且零投递是**不可观测**的失败（没有红灯，只是没人升级）—— 本仓已有一次真实教训（ADR-053 背景：`releases/latest` 排除预发布，自动更新自 2026-09-15 起**零投递**而无人察觉）。
- **C) 等上游 `x.y.z` 越过 `0.7.x` 再切号**：否决，但**代价已如实记录**。它的好处是零改动、零放宽；否决理由是等待期不可控（取决于上游发布节奏），而合成号机制（ADR-061）与双通道已在役，等待会让「已修好的东西一直不能用」。
- **一次性把「降级即拒」烧掉（每版都写 `allowDowngrades`）**：否决。放宽是**永久**的（内置在那一版的产物里），每版都烧 = 把「可任意回滚」变成常态，而这与 updater 存在的意义相反。ADR-061 的守卫体系也会随之失去意义。
- **自定义 `version_comparator`**：否决。它与 `allow_downgrades` **互斥**（后者是插件配置、前者是 Rust 侧代码），且自定义比较器要写进 `src-tauri` 并被所有后续版本继承 —— 等于把一次过渡变成一条永久的分支代码。当前仓里没有比较器（`lib.rs:66`），保持这一状态就是保持「配置层能解决的事不上升为代码」。
- **把豁免写成「合成号形状即豁免」**：否决。豁免的依据必须是**事实**（该通道发过一个放宽过的版本），不是**形状**。形状判据在本仓已被证伪三次：`0.7.3-alpha.1`（历史遗留）与 `0.2.1-alpha.1.3`（真合成号）**同构**，`splitRepoSequence` 无法区分（见 `release-ledger.mjs` 模块文档）。
- **用「全局最高 tag」当豁免基准**：否决。`rc` 的客户端从来收不到 `alpha` 的号；拿 `0.7.4-alpha.1` 去要求 `rc` 线的桥接版 `0.7.3-rc.1`，只会得到一个**永远不成立**的豁免 —— 那是「守卫看起来在跑、其实永不生效」，比没有守卫更坏。

## 后果

- **代价（已登记，不掩盖）**：装过桥接版的用户此后可以**回滚到任意更旧版本**（放宽内置在那一版，永久生效）。这是「让换代能启动」必须付的一次性代价；决策 8 把它的范围限制在桥接版一个版本上。
- **未装过桥接版的用户仍需一次桥接**（决策 7）。因此桥接版**必须先发布**、且必须真的发出 tag —— 这条不再是倡议，而是判据（决策 4 第 3 条）。
- **守卫层保留一处刻意的不对称**：`version.mjs` 的**基础**单调判据仍以**全局**最高 tag 为基准（历史守卫，宁可过严：它正是为 2026-09-25「先 `v0.7.0-rc.1`、后 `0.7.0-alpha.8`」那次的形态建立的），而**豁免**以**本通道**最高 tag 为基准（否则豁免永不成立）。两处的口径差异已用自测夹具显式钉住（`version.mjs` 自测「不对称：…」两条），避免后续「统一成按通道」时误改。
- **不变式**：豁免成立时 `bridge.version === 该通道最高已发布 tag`。推导：已发布 ⇒ `bridge.version ≤` 该通道最高；判据 4-2 ⇒ `≥` ⇒ 恒等。它一旦不成立，就意味着「豁免覆盖了一个比桥接版更高的号」，那种客户端不会接受本版 —— 自测里有一条断言守着它。
- **台账格式版本 1 → 2**：`readLedger` 对旧 `schemaVersion` **显式报错**（不静默当空台账）。
- **自测项数**：`dsh-targets` 80；`release-ledger` 146（新增桥接版层 / 通道推导 / 通道最高版本 / 豁免判定四段夹具）；`version` 70；`updater-manifest` 64。

## 守卫与证据

- **可伪证夹具**（`--self-test`，全部通过）：
  - 「台账登记了但该 tag **未发布** ⇒ 不豁免」（豁免不得靠意图成立）；
  - 「**不给 `tags`** ⇒ 一律不命中」（无凭据不等于默认成立）；
  - 「登记最高但未发布时，回落到**真正送达**的那条」（一条永不发布的高号不得永久压过生效的那条）；
  - 「只有 alpha 桥接版时 rc 合成号仍必须报红」（跨通道不得互相豁免）；
  - 「本通道出现高于桥接版的号之后豁免失效」；
  - 「桥接版**不得**登记成真合成号」（判据是**台账键**，不是形状 —— `splitRepoSequence('0.7.3-rc.1')` 也会成功）；
  - 「普通版产物里**不许出现** `allowDowngrades`」；
  - 「两条桥接版**自己**的发布必须能过单调守卫」（否则第一步就走不动）。
- **实测两态**（真实台账 + 真实 14 个 tag）：
  - 桥接版 tag **尚未发布**（本 ADR 落地时）：`0.2.0-rc.2.1` 与 `0.2.1-alpha.1.1` 均 `granted=false reason=bridge-not-delivered` ⇒ 合成号被正确拦住；
  - 模拟桥接版已发布：两者 `granted=true`，`channel` 分别为 `rc` / `alpha`，基准 `atLeast` 分别为 `0.7.3-rc.1` / `0.7.4-alpha.1`。
- **构建期注入实测**：`updater-manifest.mjs --write-config v0.7.3-rc.1` 产物含 `"allowDowngrades": true`；`--write-config v0.7.2-rc.1`（非桥接版）产物**不含**该键。
- **本轮两条桥接版**（已登记进 `bridges[]`，各线均高于该通道当时最高 tag）：`v0.7.3-rc.1`（`next` 目标 / `rc` 通道，> `v0.7.2-rc.1`）、`v0.7.4-alpha.1`（`alpha` 目标 / `alpha` 通道，> `v0.7.3-alpha.1`）。
