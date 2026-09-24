# 主要风险与缺口：取证结论与可执行方案

> 对象：`docs/dev-plan-release-channels.md`
> 取证时间：2026-09-24（全部命令实跑，结论附原始输出）
> 纪律：本文件**不采信计划文档自身的事实陈述**，每条结论都由本次实跑得出。

---

## 0. 取证汇总：五条底账里三条已过期

| # | 用户提出的风险 | 核实结果 | 严重度 |
|---|---|---|---|
| 1 | 事实底账过期（F1、1a 完成态） | ✅ **成立，且比预期严重**——F1 已过期；**1a 的「已完成」是错的** | 🔴 高 |
| 2 | `next` 已与 `latest` 分叉 | ✅ **成立，已实测确认分叉**，且幅度超出历史窗口 | 🔴 高 |
| 3 | F13 未修即打 tag | ✅ **成立**，另**发现同族第二处缺陷**（CLI 正文段） | 🔴 高 |
| 4 | 批次 5 缓存行为未实测 | ✅ 成立；**结论：三次取回 + 真机闭环是必需的，但不是充分的** | 🟠 中高 |
| 5 | 历史 Release 正文含 CLI 段 | ✅ **成立，且不是"历史遗留"而是活跃缺陷** | 🔴 高 |

**本次取证的原始输出（关键四条）**：

```text
$ npm view @deepseek-ai/dsh dist-tags
{ latest: '0.1.5-rc.3', next: '0.1.7-rc.1', alpha: '0.1.7-alpha.2' }
   ↑ latest 与 next 已分叉（计划假设是二者相同）

$ ls harness-locks/
alpha  next
   ↑ 仍是通道键，1a 声称的「换成 0.1.5-rc.2 这类版本键」未发生

$ ls patches/
LAYERS.md  alpha  next
   ↑ 同上，patches/next → patches/rc 也未发生

$ sed -n '50,80p' scripts/dsh-targets.mjs
  next:  { channel: 'next',  dshVersion: '0.1.5-rc.2' }
  alpha: { channel: 'alpha', dshVersion: '0.1.6-alpha.2' }
   ↑ 锚点为硬编码通道键，且 next 锚点(0.1.5-rc.2)比上游 latest(0.1.5-rc.3)还旧
```

---

## 1. 事实底账过期（F1、1a 完成态）

### 1.1 取证结论

**F1 过期。** 原表述「`latest`=0.1.5-rc.3、`next`=0.1.5-rc.3（两者指向同一 rc）」在 2026-09-24 已不成立：`next` 前进到 `0.1.7-rc.1`。这一天变化直接推翻计划的两处推理前提（见第 2 节）。

**1a 完成态是错的，且这是我上一轮引入的错。** 计划 §5 批次 1a 现写「✅ 已完成」，理由列了三条，逐条核对：

| 1a 声称 | 实情 | 判定 |
|---|---|---|
| 锁文件按 version 键命名（如 `0.1.7-alpha.2/`） | `harness-locks/` 下仍是 `alpha` / `next` | ❌ 未发生 |
| 目录更名 `patches/next → patches/rc` 已落地 | `patches/` 下仍是 `alpha` / `next` | ❌ 未发生 |
| 期望资产 13 已成核对口径 | 口径确实是 13，但**兑现不了**（F13） | ⚠️ 口径对、路径缺 |

事故形态与计划 §1 自己承认过两次的完全一样：**不重读仓库就写现状**。这次是我在改写文档时，把「计划里描述过」当成了「仓库里已完成」。

### 1.2 可执行方案：开工前的事实重校（前置门禁）

新增一道**一次性前置步骤，且它本身必须有判据**（否则又是一次「人工确认」）：

```text
步骤 P0（开工前，约 30 分钟）
  1. 写 scripts/verify-plan-facts.mjs —— 把计划 §1 表的「证据」列抽成可执行检查：
     · F1  → npm view 后断言 dist-tags 的三元组与表内一致
     · F2/F3 → 读 dsh-targets.mjs，断言通道集合与 targetForVersion 回落行为
     · F4  → ls harness-locks/，断言键形态（通道键 or 版本键，二者必居其一且与表一致）
     · F6  → 读 tauri.conf.json 的 endpoints
     · F7  → import increment()，断言对 '0.9.0-alpha.3' 的行为
     · F9/F11 → npm view ... time，断言窗口事实未变
     · F12/F13/F14 → 读 release.yml，断言 job 集合与 portable 上传步骤存在性
  2. 输出一张「表内值 vs 实测值」对照表，任一不一致即 exit 1
  3. 脚本自身的 --self-test 必须含「改一处期望值 → 必须判红」的夹具
```

**为什么必须脚本化而不是「开工前重跑一遍」**：这份计划在两天内已于同一形态栽了三次（F4、F12 初稿、这次的 1a）。**靠纪律重复失败的环节，要用机器替代纪律。**

**并同步修正 §5 批次 1a 的状态**：`✅ 已完成` → **待办**，且其内容恢复为「换键迁移 + 补新锁」（原 v3 的表述是对的，是改写时被误标为完成）。

---

## 2. 上游 `next` 与 `latest` 已分叉：D2/D4 的日常形态变了

### 2.1 取证结论：分叉已发生，且幅度超出计划的参照窗口

```text
上游 latest = 0.1.5-rc.3      （rc 线）
上游 next   = 0.1.7-rc.1      （rc 线，但已跨过一个 minor）
上游 alpha  = 0.1.7-alpha.2   （alpha 线）
```

分叉的**性质**比幅度更重要：`next` 不再与 `latest` 同版本，而是**爬到了与 alpha 同一个 minor（0.1.7）**。计划 §4-D2/D4 的核心假设是：

> 「上游 `latest` 与 `next` 指向同一个 rc」（F1）

以及 D4 的裁案：

> 「`stable` 在 `dshVersion` 与 `rc` **逐字相同**时复用 `patches/rc/`；一旦两线版本分叉，必须存在 `patches/stable/`」

**D4 的分支条件现在被激活了。** 不再是「理论上可能分叉」，而是「已经分叉」。这意味着：

- `stable` 锚 `0.1.5-rc.3`、`rc` 锚 `0.1.7-rc.1` ⇒ **逐字不相同** ⇒ 按 D4 必须存在 `patches/stable/`。
- 而 `patches/stable/` 目录**不存在**（`patches/` 下只有 `alpha` / `next`）。

### 2.2 维护成本评估：结论是「超出原假设，但不致命」

用户的问题问得很准：**补丁与锁的维护成本是否超出「latest==next」的假设？** 答案分三层：

**（a）锁的成本：可接受，因为锁按版本键后天然解耦**

| 情形 | 锁文件数 | 在线解析成本 |
|---|---|---|
| `latest == next`（计划假设） | 2 份（rc 与 stable 同源） | 1 次 |
| `latest` ≠ `next`（**当前实情**） | 3 份（stable / rc / alpha 各自） | 2~3 次 |

每份 `next` 线锁的在线解析成本计划已实测约 **40 分钟 / 8 GB 堆**。所以分叉的增量成本 ≈ **多一次 40 分钟解析**。这是可接受的，且是**一次性**的（锚点不动时不重生成）。**R1（锁按精确版本键）正是让这项成本从「随通道数线性增长」变成「随不同版本数增长」**——分叉恰好证明 R1 的必要性。

**（b）补丁的成本：这是真正的增量，也是计划低估的地方**

补丁目录按**通道**为作者区（计划 §3.2 的定案）。分叉后的隐含要求：

| 通道 | 锚点 | 补丁目录 | 现状 |
|---|---|---|---|
| `stable` | 0.1.5-rc.3 | `patches/stable/`（D4 要求） | ❌ 不存在 |
| `rc` | 0.1.7-rc.1 | `patches/rc/`（原 `patches/next/`） | 现名 `next`，14 条 |
| `alpha` | 0.1.7-alpha.2 | `patches/alpha/` | 13 条 |

**成本量化**：`stable` 与 `rc` 分叉后，两套补丁**不能复用**。而两线的差异可能很小（记住计划的实测：相邻上游预发布版本的补丁集常只差 1~2 条）。于是产生一个真实的张力：

- **D4 的字面要求**（版本分叉即各自独立目录）⇒ 要为 `stable` 建一份约 14 条的目录，其中 12~13 条与 `rc` 逐字节相同 ⇒ **每次稳定版升级要改两份**。
- **D4 的设计意图**（复用要有退出条件，靠内容哈希表达差异）⇒ 用 `patchSetHash` 判断复用，不靠目录复制。

**这里计划内部有一处未自洽**：§3.2 说「补丁的正确性权威是上游版本 + 行号，不是目录名」，R1 说「不采纳全量分版本目录」；但 D4 又说「版本分叉必须存在 `patches/stable/`」——**后者是按目录名承担版本差异，正是 R1 否掉的做法**。

**（c）裁决建议：把 D4 从「目录条件」改为「哈希条件」**

| 现行 D4 | 建议改为 |
|---|---|
| 版本分叉 ⇒ 必须存在 `patches/stable/` 目录 | 版本分叉 ⇒ **`stable` 的 `patchSetHash` 必须与 `rc` 不同**；相同则复用同一目录并如实声明 |
| 判据落在目录存在性 | 判据落在**内容哈希**（与 R1/R2 同源） |

理由：目录存在性判据会**奖励「复制一份」**（复制即满足），而内容哈希判据会**奖励「如实反映差异」**。且后者与计划其余部分的哲学一致。**代价**：`patchSetHash` 的冻结时点必须在 R2 之前落地，即 D4 的判据从「preflight 查目录」改为「preflight 比对两份 MANIFEST 的 `patchSetHash`」。

**（d）对 D2 的影响**

D2（允许正式版捆上游 rc）在这条分叉下**变得更常用**：`stable` 锚在 `0.1.5-rc.3`，而 `rc` 已经在 `0.1.7-rc.1`。**「正式版落后于测试版」会成为常态**，而不是例外。这需要在 Release 正文的声明里说清楚——否则用户看到 stable 的运行时比 rc 旧会以为是 bug。

建议在 §4-D2 加一条声明要求：**stable 的正文必须写明「本版落后测试版 X 个上游版本」**（当 `stable` 锚 < `rc` 锚时）。

---

## 3. F13 未修即打下一个 tag（另发现同族第二处）

### 3.1 取证结论

**F13 成立**：`release.yml` 全流程无 `gh release upload`；`portable` job 只 `upload-artifact`；`verify-release-workflow.mjs` 里 `grep -i portable` **只命中注释，零判据**。

**并且发现同族第二处缺陷（本次新发现，计划未记）**：

```text
$ gh api repos/.../releases/tags/v0.7.0-alpha.7 --jq .body | grep -n "dsh-host-cli"
13:<!-- dsh-host-cli -->
15:## Headless CLI (`dsh-host-cli`)
21: | `aarch64-apple-darwin` | [`dsh-host-cli-v0.7.0-alpha.7-...`] | `5148...` |

$ grep -rn "NOTES_MARKER" scripts/ 
scripts/package-cli.mjs:317: export const NOTES_MARKER = '<!-- dsh-host-cli -->'
scripts/package-cli.mjs:771:  ... --release-notes <manifest 所在目录> --tag <tag> ...
```

**这是一个「生成器还在、调用者已删、无人断言它不被调用」的活口**。`package-cli.mjs` 的 `--release-notes` 会**向 Release 正文追加一整段 CLI 下载表格**（含注释标记 `<!-- dsh-host-cli -->`）。该脚本被**刻意保留**（计划 §9 明确「不删」），因此：

- 它**仍可被调用**（任何人在工作流里加一行就复活）。
- 现有守卫 `checkCliArtifactShape` 断言 `cli` / `cli-publish` **job 不存在**——但**不禁止有人写一个新的内联步骤调用 `--release-notes`**。
- 结果：**正文会声明一批不存在的 CLI 资产**。这正是计划 §7.1「不得无声降级 / 不得声明不存在的东西」禁止的形态。

**与 F13 的关系**：两者是**同一个坑的两种表现**——都源于「删 `cli-publish` job 时只数了它的一类职责」：

| 被删 job 承载的职责 | 现状 | 计划是否已记 |
|---|---|---|
| 便携版「下载核验 → 上传」 | 消失（F13） | ✅ 已记，批次 4 修复 |
| 写 Release 正文的 CLI 段 | **生成器仍在，无守卫禁止调用** | ❌ **本次新发现** |

### 3.2 可执行方案

**（a）F13 本体：前向守卫 + 三步一起补**

按计划批次 4 的方案 b（新建 `publish-assets` job）执行，并加前向守卫：

```js
// verify-release-workflow.mjs 新增
function checkPortableAssetsPublished(yaml) {
  const stripped = stripYamlComments(yaml)   // 复用既有函数（本仓已有）
  // 判据 1：必须存在把 dist/portable/* 上传到 Release 的路径
  // 判据 2：该路径必须包含 --verify-download 核验（只补上传 = 未核验就上架）
  // 判据 3：断言 cli / cli-publish job 仍不存在（现有 checkCliArtifactShape 不变）
}
```

**可伪证夹具**（三条，缺一即判据无效）：

1. 删掉上传步骤 → 判红；
2. 删掉 `--verify-download` 只留上传 → 判红；
3. 把 `cli` job 加回来 → 判红（沿用既有）。

**（b）新发现的 CLI 正文段：加「不得复活」守卫**

```js
// 判据：release.yml 的可执行部分不得调用 package-cli.mjs 的 release-notes 路径
function checkCliNotesRetired(yaml) {
  const stripped = stripYamlComments(yaml)
  // 断言 stripped 中不含 '--release-notes' 与 'package-cli.mjs'
}
```

**关键设计点（本仓已踩过一次同类坑）**：这条是「不得出现类判据」，**必须复用 `stripYamlComments()`**。因为 `release.yml:456/476` 的退役说明注释里**逐字引用了 `package-cli.mjs`** 来解释什么被保留了——不剥注释的话，**守卫会被自己的文档命中，恒红**。这正是 2026-09-24 已修的那个缺陷的复现路径。

**可伪证夹具（两条互补，本仓既有范式）**：

1. 注释里引用 `package-cli.mjs` → **必须放行**；
2. 可执行位置调用 `--release-notes` → **必须判红**。

（只验第 2 条的话，把判据整个删掉也能过——本仓已明确记录过这个陷阱。）

**（c）历史 6 个 Release 的 CLI 段：不改**

| 处置 | 理由 |
|---|---|
| **不回填历史 Release 正文** | 那 6 个 release（`v0.4.0` ~ `v0.7.0-alpha.7`）**当时确实发布了 CLI 资产**，正文声明是真的。改它等于伪造历史记录 |
| 新 release 不得再出现该段 | 由 (b) 的守卫保证 |

**判据**：下一次发布后，`gh api .../releases/tags/<新tag> --jq '.body | test("dsh-host-cli -->")'` 必须为 `false`；同时资产清单必须为 **13**（含 3 便携版）。两条一起看——**只有当资产与正文同时正确，才算 F13 + 新缺陷都已修**。

---

## 4. 批次 5 的滚动 release 缓存行为

### 4.1 结论：三次取回 + 真机闭环是**必需的，但不充分**

用户问的是「是否需三次取回加真机闭环」。答案是**需要，但按计划现有的三条验收会漏掉两类失败**：

| 计划现有验收 | 能测到 | **漏掉** |
|---|---|---|
| 立即取回一次 | 覆盖是否即时可见 | — |
| +30min、+6h 各一次 | 是否会回退成旧内容 | — |
| 干净 VM 走一次真实更新闭环 | 端到端是否通 | — |
| — | — | ❌ **不同地域/网络路径的 CDN 节点不一致** |
| — | — | ❌ **`--clobber` 覆盖后 `latest.json` 的 `url` 仍指向旧 tag** |

**第二类漏检是真正危险的**：`--clobber` 只替换清单文件，但清单**内部**的 `url` 字段必须指向**新版本** tag。若上传步骤把旧清单 clobber 上去（或在 `needs` 竞态下 clobber 了错的那份），三次取回**全都是旧内容、且稳定不变**——三条验收里「不回退」这条**反而会通过**（因为它一直就是旧的）。

### 4.2 可执行方案：把验收从「三次取回 + 闭环」升级为「四类断言」

```text
批次 5 验收（替换原三条）
  A. 内容新鲜度（时序）
     · 立即 / +30min / +6h 三次取回
     · ⚠️ 2026-09-24 实测修正：`curl -H 'Cache-Control: no-cache'` **绕不过 CDN 缓存**
       （Fastly 双层，实测仍 X-Cache: MISS, HIT 且 Age 单调递增至 63s+）。
       故「无缓存取回」必须改为 **cache-busting**：每次附加独立 nonce
       （`?nonce=$(date +%s%N)`）或改用**不可变 URL**（带 tag 的路径）。
       详见 docs/optimization-release-channels.md §1.5。
     · 断言：三次的 version 字段都 == 刚发布的版本（不是「不回退」，是「必须等于新版」）
  B. 内容正确性（结构）        ← 新增，堵上面那个漏检
     · 断言：清单里 url 字段包含的 tag == 刚发布的 tag
     · 判据：若 url 指向旧 tag ⇒ 判未完成（哪怕 version 字段是新的）
  C. 网络路径（多源）          ← 新增
     · 至少两个不同网络出口各取一次（例如本机 + CI runner）
     · 断言：两次拿到的 version 与 url 完全一致
     · 理由：CDN 缓存的失效是**按边缘节点**的，单点取回不能代表全体用户
  D. 端到端（真机）
     · 干净 VM 装 alpha 版 → 触发检查更新 → 确认收到、下载、装上
     · 追加断言：装完后 `app.package_info().version` == 新版本（不是「有更新提示」）
  E. 反向（不得串道）
     · 同一 VM 上的 alpha 客户端**取不到** rc / stable 的清单
```

**若 B / C 任一不过**：按 §8.1 启用静态托管回退（该方案的实施链路已在本计划中给出 5 步）。

> ⚠️ **2026-09-24 追加修正**：**静态托管不应是首选回退**。实测表明 `Cache-Control`
> 是治标且不彻底的——控制得了自己这一跳，控制不了中间任何一跳。真正的根治手段是
> **不可变 URL**（`releases/download/<tag>/latest.json` 而非 `releases/latest/download/`），
> 它在 GitHub Release 上就能实现，不需要换托管。且切 Pages 引入一个被低估的成本：
> updater 端点是**编译进客户端**的，改端点后老用户永远读不到新端点 ⇒ 需要双写过渡期。
> 完整论证与切换成本表见 [`docs/optimization-release-channels.md`](optimization-release-channels.md) §1.3。
> 建议口径改为：**回退方案 = 不可变 URL（首选）→ 静态托管（次选，仅当不可变 URL 亦失效）**。

**成本说明**：C 类（多网络出口）需要一次额外的 CI runner 跑或换网络环境，属一次性验证，不进日常矩阵（符合 §9「不为三通道新开每日矩阵」）。

---

## 5. 历史 Release 正文的 CLI 段

见 **§3.1 与 §3.2(b)**——这两项是同一个发现，合并处置。

**补充一条独立判据**（防止「新 release 干净但模板又长回来」）：

```js
// verify:changelog 或 verify:release-workflow 中新增
// 判据：changelog.mjs 的 --notes 输出不得包含 '<!-- dsh-host-cli -->'
// 现状：changelog.mjs 全文无 CLI 段落生成逻辑（已核实，grep 只命中无关的注释）
//   ⇒ 这是一条「防未来」判据，不是修现状
```

**为什么仍要加**：CLI 段不是 `changelog.mjs` 生成的，而是 `package-cli.mjs --release-notes` **追加**的（见 §3.1）。而正文是**三段拼接**——横幅（shell）/ 提交区间（changelog）/ CLI 表（已无调用者）——**三段必须都有守卫**。现状是只有前两段有，第三段零判据（详见 §6.1）。

---

## 6. 被低估的工作量：六处「以为改完其实漏一处」

用户列出的五项我逐条核实，**全部成立**，并补充一处。统一规律：**这些环节的失败形态都不是「红」，而是「静默地少改一处」。**

| # | 环节 | 漏一处的具体形态 | 判据（怎么知道没漏） |
|---|---|---|---|
| 1 | `next → rc` 目录更名 | `patches/next` 改名了，但 `packages/next`、`patches/LAYERS.md`、`verify:patches` 的目标枚举、`staging` 目录名有一处没跟 | **不留旧名残留**：`grep -rn "'next'\|\"next\"\|/next\b" scripts/ patches/` 的命中必须**逐条能用「读历史/别名」解释**，否则判红 |
| 2 | 只读别名 | 别名被写进**新写入路径**（如 CHANGELOG 段落标题、新 tag 的 MANIFEST），历史能读但新数据带旧名 | 双向夹具：读 `v0.5.0-next.1` → 必须成功；写新 tag 带 `next` → 必须判红（**两条都要有**，只验一条无效） |
| 3 | CI / 烟雾矩阵 choice | `smoke.yml` 的 choice 改了，`ci.yml` / `drift.yml` 漏了；或改了 options 但 `default:` 仍是 `next` | 断言**三个工作流**的 choice options 集合都 == `{stable, rc, alpha}`，且 default 不再是 `next`；配夹具「删掉某个 workflow 的 options 一项 → 判红」 |
| 4 | 三处声明（Release / MANIFEST / 反馈页） | 改了 Release 正文与 MANIFEST，**反馈页漏了**（它是 Rust 里拼的字符串，不在 workflow 里） | 三处各一条断言，且**必须都是「值必须出现」而非「模板存在」**：断言实际渲染结果包含 `dshVersion` 与通道名 |
| 5 | R1 的三平台 `patchSetHash` 汇总 | 汇总步骤建了，但**漏了「三份一致性」断言**（只收集不比对）；或汇总点挂在会被裁掉的 job 上（F13 的形态） | 断言：存在一个 `needs` 三平台的 job；该 job 内**存在比对三份 hash 的逻辑**（不是只上传）；配夹具「让两份 hash 不同 → 必须判红」 |
| 6 | **（补充）正文组装是两步，但有守卫的只有一步** | `changelog.mjs` 只产「提交区间」，`release.yml` 用 shell 拼**运行时横幅**（`DSH_VERSION` + `DSH_TARGET`）；`package-cli.mjs --release-notes` 是**第三步追加**（见第 3 节）。三步里只有横幅那步有守卫 | 见下方「正文链路三段的守卫现状」 |

### 6.1 正文链路三段的守卫现状（本次实测）

**这是「漏一处」最容易发生的地方——因为正文不是一处生成，而是三段拼接。** 实测现状：

| 段 | 生产者 | 载体 | 现有守卫 |
|---|---|---|---|
| ① 运行时横幅 | `release.yml:264` 的 **shell echo** | `${DSH_VERSION}` + `${DSH_TARGET}` | ✅ `verify-release-workflow.mjs:460` 有正则断言 |
| ② 提交区间 | `node scripts/changelog.mjs --notes` | 提交历史 | ✅ `verify:changelog` |
| ③ CLI 下载表 | `package-cli.mjs --release-notes`（**已无调用者**） | 追加 + `<!-- dsh-host-cli -->` 标记 | ❌ **零判据** |

**两个推论**：

1. **第 3 节发现的 CLI 段，本质是「三段里唯一的零判据段被复活」**——它不是历史遗留，是**守卫覆盖的空白**。
2. **①的横幅在演进为三通道时要改，而它是一段 shell 字符串拼接**。计划批次 4 要求「Release 正文三行：所属通道 / 内置运行时及其上游阶段 / 该通道的晋升预期（现在只有一行）」——**这一改动落在 shell 里，不在 `changelog.mjs` 里**。

   ⚠️ **该 shell 块有一条已知的跨平台陷阱**（`release.yml` 内注释已记录）：**变量必须用 `${VAR}` 花括号形式**——macOS runner 的 bash 3.2 在无 UTF-8 locale 时不会把紧跟其后的**全角标点**当变量名终止符，`$TAG）` 会被解析成变量 `TAG）` 并报 unbound variable。**这是发布链路只在 macOS 上失败过的根因**。批次 4 扩写这个块时必须沿用花括号形式，且新加的每一行都要如此。

**建议的守卫（补上③的空白 + 加固①）**：

```js
// ①：从「横幅存在」升级为「三行齐全且值来自 preflight」
//    断言 release.yml 的 notes 块输出含：通道行 / 运行时行 / 晋升预期行
// ③：断言可执行部分不调用 --release-notes（见 §3.2(b)）
// ②：changelog 输出不得含 '<!-- dsh-host-cli -->'
```

**统一可执行方案：加一道「跨文件一致性」静态检查，而不是逐个环节手改。**

```text
新增 scripts/verify-channel-consistency.mjs（建议与批次 2 同期落地）

做三件事：
 1. 枚举「通道名」应出现的全部位置（SSOT 清单，硬编码在脚本里）：
    scripts/dsh-targets.mjs / .github/workflows/{ci,smoke,drift,release}.yml
    patches/*/ / packages/*/ / harness-locks/*/ / docs/升级清单 / README 双语
 2. 对每个位置断言「三通道齐全且无残留旧名」
 3. 对「三处声明」类位置，断言**运行时渲染值**而非模板文本
```

**为什么必须是一个脚本而不是六条分散的判据**：用户点出的规律正是「容易以为改完其实漏一处」。分散判据的失败模式是**漏建某条判据也没人发现**（F13 就是「零判据」的后果）。集中枚举 + 单点 SSOT 清单，让「漏一处」变成「脚本里少一行枚举」——而枚举清单本身可以被 review 一眼看全。

**可伪证夹具（三条）**：

1. 从枚举清单里删掉 `drift.yml` → 该文件漏改时必须判红（证明枚举有效）；
2. 在 `packages/` 下建一个 `stable/` 但 `patches/` 没有对应项 → 判红（证明跨目录一致性被覆盖）；
3. 把某处三通道减为两通道 → 判红。

---

## 7. 汇总：建议的执行顺序（含前置）

| 序 | 项 | 依赖 | 是否可独立执行 |
|---|---|---|---|
| **P0** | `verify-plan-facts.mjs` 事实重校（第 1 节） | 无 | ✅ **先做，它决定后面所有条目的现状值** |
| **P1** | F13 便携版上传修复 + CLI 正文段守卫（第 3 节） | 无 | ✅ **可先于三通道改造**（当前 HEAD 的真实缺陷） |
| **P2** | D4 改为哈希条件 + stable 正文落后声明（第 2 节） | P0（需确认分叉仍成立） | ✅ 独立 |
| **P3** | `verify-channel-consistency.mjs`（第 6 节） | 批次 2 定名 | ⚠️ 与批次 2 同期 |
| **P4** | 批次 5 验收升级为 A~E 五类（第 4 节） | 批次 5 | ⚠️ 属批次 5 内部 |
| **P5** | 修正批次 1a 状态为「待办」（第 1 节） | 无 | ✅ 立即 |

**最高优先级两条**：P0（不先重校事实，后面全部推理都建在过期底账上）与 P1（当前 HEAD 有真实缺陷，下一次发布就会踩）。

---

## 8. 一句话结论

五项风险**全部成立**，其中三项（F1 过期、1a 误标完成、CLI 正文段）**是本次取证新确认的、且都属同一形态**——「不重读仓库就写现状」与「删一个 job 时不数它承载几类职责」。

> 📌 **2026-09-24 后续**：本文的四项落地优化（CDN 缓存黑洞 / next→rc 存量冲击 /
> F13 Hotfix 剥离 / 锁文件成本分摊）已另文展开，见
> [`docs/optimization-release-channels.md`](optimization-release-channels.md)。
> 其中**三条改写了本文的结论**：
> 1. `Cache-Control: no-cache` 实测**绕不过** Fastly（本文 §4.2 验收 A 已就地修正）；
> 2. **静态托管不是首选回退**（不可变 URL 才是）；
> 3. **「清理三平台 CI Cache」这条待办基于错误前提**——本仓 CI 缓存面只有
>    `setup-node` 的 npm cache 与 `rust-cache`，`resources/` / `harness-deps/` / staging
>    **均未被缓存**（实测 `release.yml` 全文件），故该动作**不需要执行**。

**最该立刻做的两件事**：

1. **P0 — 把事实校验脚本化**（`verify-plan-facts.mjs`）。不先重校事实，后面全部推理都建在过期底账上；而这份计划已证明「靠纪律重校」不可靠（两天内三次同形态失败）。
2. **P1 — 修 F13 与 CLI 正文段**。这是当前 HEAD 上**会让下一次发布静默变残缺**的真实缺陷：资产少 3 个（F13）+ 正文声明一批不存在的 CLI 资产（本次新发现），**两者都在全部门禁绿灯的情况下发生**。

第 2 项的补充结论值得单独记住：**正文是三段拼接（横幅 shell / 提交区间 changelog / CLI 表），而其中只有前两段有守卫。** 「发布正文正确」当前不是被保证的，是被**两段守卫 + 一段运气**共同维持的。
