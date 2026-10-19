# Feature Log

> **这是什么**：`docs/version-policy.md` §3.1「唯一权威链路」的**第 2 步**产物（Feature Log）。
> 它把「上个 tag..HEAD」的提交**分类累积**下来，供第 3 步（Release Plan）判断「这一版该不该切、切什么类型」。
>
> **它的权威边界**：本文件**不是**版本号的产地，也**不**批准发布。版本号由 `release-manifest.json`
> （第 3 步）批准、第 4 步从台账派生。本文件只回答「上次发布之后，仓库里多了哪些改动」。
>
> **本轮标记**：双线重锚轮（`0.2.1-alpha.5.1` / `0.2.1-rc.2.1`）。上一轮（alpha 单线：曲线修复轮
> `0.2.1-alpha.2.1`，更早是 `0.2.0-rc.2.2` / `0.2.1-alpha.1.2`）的同类清单已随 git 历史留档，
> 本文件按「本轮」重写（§0.1 的基线因此前移）。

---

## 0. 本轮基线与生成方式（先读这段）

### 0.1 基线的选择：**两条线各有各的基线**

`§5.1` 步骤 2 写的是「上个 tag..HEAD」。**两条通道并存时「上个 tag」不是唯一的**——
两条线各自发过不同的合成号，因此本轮基线**按通道各取一条**（`changelog.mjs --print-baseline`
是同一套判据的机器实现，见 §0.3 的复现命令）：

| 线 | 上一条已发布 tag | 指向提交 | 日期 | 区间内提交数 |
|---|---|---|---|---|
| `alpha`（目标 `alpha`） | `v0.2.1-alpha.2.1` | `80c3d9b` | 2026-10-18 | **1** |
| `next` / rc（目标 `next`） | `v0.2.0-rc.2.2` | `90df420` | 2026-10-10 | **36** |

两条基线的间隔是 **35 条**，全部落在 rc 线「本轮新增」里——这是**两条线各自记自己的账**的正常结果：
alpha 线在 2026-10-18 单独发过一版（`0.2.1-alpha.2.1`），那批东西已经交付给 alpha 用户了。

> ⚠️ **alpha 线本轮只有 1 条提交**（`e66f04c`，PR #11 的 squash）。它的类型是 `build:`
> ——**严格按 Conventional Commits 分类，`build` 不产生 `n`**。本轮仍要发 alpha，判据不是这条
> 提交的类型，而是**上游锚点前移**（§0.2）：`0.2.1-alpha.2` → `0.2.1-alpha.5` 属 §3.2 的
> `upstream` 面，`x.y.z` 必须前进。**这类「提交类型说不用发、锚点说必须发」的情形下以锚点为准**
> ——否则用户会永远停在旧运行时上，而台账里那条在役键的 `builds[]` 永远是空的。

> 📌 **快照边界（结构性限制，不是笔误，也**不要**为了刷新数字而再加提交）**：
> 本表的计数是「**承载本文件的那次提交的父提交** `e66f04c` 之前」的全部提交。
> 本文件自己的提交、以及它之后的任何提交**按定义不在区间内**——写它的时候它们还不存在。
> 所以你在 HEAD 上原样复算会得到 **2 / 37**（各多 1 条 `docs`），差值就是本文件的提交本身。
> `docs` 按 `§2` 不产生 `n`，因此这不影响版本判定。

### 0.2 上游锚点：**两条线在区间内都前进了**（本轮的主因）

| 目标 | 上一 tag 时的 `dshVersion` | HEAD 上的 | 结论 |
|---|---|---|---|
| `next` | `0.2.0-rc.2` | `0.2.1-rc.2` | **前进**（补丁线从 `0.2.0` 走到 `0.2.1`） |
| `alpha` | `0.2.1-alpha.2` | `0.2.1-alpha.5` | **前进**（同 minor 内前进 3 个预发布位） |

判据命令（唯一产地 `scripts/dsh-targets.mjs`）：

```bash
node scripts/dsh-targets.mjs --version-of next    # 0.2.1-rc.2
node scripts/dsh-targets.mjs --version-of alpha   # 0.2.1-alpha.5
```

⇒ 两条线**都有**上游前进，且**都**带本仓需发版改动（alpha：补丁重锚 + 退役 + 兜底守卫修正；
rc：另有 3 条 `feat`、1 条 `perf`、12 条 `fix`）⇒ 按 `§3.2` 是 **`mixed`**
（`x.y.z` 前进、`n = 1`），不是 `upstream`（本仓并非零改动）、也不是 `desktop-fix` / `desktop-feature`
（`x.y.z` 已随锚点前进，`n` 按新组从 1 起算，与「`x.y.z` 不变、`n+1`」无关）。

### 0.3 生成方式（如实声明，不冒充机器产物）

`§3.1` 的表格把 Feature Log 的所有者写成「**机器 + 人工复核**」，落点写的是 `feature-log.mjs`。

**该脚本目前仍然不存在**（`ls scripts/feature-log*.mjs` 无命中）。因此本文件当前是
**人工按同一判据复核**写出的：分类规则与 `scripts/conventional-commits.mjs` 一致——
`parseCommit()` 解析、`classify()` 分组、`suggestBump()` 判版本位。
⇒ 「机器生成」这件事**尚未落地**，不要把它读成已完成。

⚠️ 本轮的分类统计与破坏性判定**不止是人工看**：§1 与 §2 每一行的数字都由下面这组命令现算，
可逐条复现（`$BASE` 取该通道的上一 tag）：

```bash
BASE=$(node scripts/changelog.mjs --print-baseline --version 0.2.1-rc.2.1)   # → v0.2.0-rc.2.2
git log --format='%s' "$BASE..HEAD" | sed -E 's/^([a-zA-Z]+)(\([^)]*\))?!?:.*/\1/' | sort | uniq -c
git log --format='%s%n%b' "$BASE..HEAD" | grep -cE '[a-z]+(\([^)]*\))?!:|BREAKING CHANGE'
```

`--print-baseline` 本身就是**按通道**取基线的实现，两条线的基线与上表逐字一致（alpha → 
`v0.2.1-alpha.2.1`，rc → `v0.2.0-rc.2.2`）。

---

## 1. 分类统计

### 1.1 alpha 基线（`v0.2.1-alpha.2.1..e66f04c`，1 条）

| 分类 | §3.1 计入 | 条数 |
|---|---|---|
| `build`（锚点推进 + 补丁重锚的 squash） | —（按类型） | 1 |
| **破坏性（`!`）** | — | **0** |

> ⚠️ 「计入列全空」不等于「不该发版」：判据是 §0.2 的锚点前移 + 本仓改动，见 §0.1 的 boxed 段。

### 1.2 rc 基线（`v0.2.0-rc.2.2..e66f04c`，36 条）

| 分类 | §3.1 计入 | 条数 |
|---|---|---|
| `fix` | ✅ | 12 |
| `feat` | ✅ | **3** |
| `perf` | ✅ | 1 |
| `docs` | — | 5 |
| `chore` | — | 4（含 2 条 `chore(release)`、1 条空提交 `chore(ci)`） |
| `build` | — | 2 |
| `reset`（非规范类型，原文保留） | — | 2 |
| 非 Conventional（`Update …` ×2、merge 提交 ×5） | — | 7 |
| **破坏性（`!`）** | — | **0** |

> **两条线的差额（35 条）**全部是 rc 侧「本轮新增」或「alpha 已交付」的提交，逐条见 §3.2。
> rc 区间里的 3 条 `feat` 是**本仓能力**（Supervisor 接线 / CLI recover / supervisor env-profile 通道），
> 它们从未进入 rc 通道的交付物——`v0.2.0-rc.2.2` 之后 rc 线一版未发。

---

## 2. 破坏性变更：**无**

**判据（可证伪，不是「我看了觉得没有」）**：

| # | 判据 | 命令 | 结果 |
|---|---|---|---|
| 1 | 两条区间内均无 `type(scope)!:` 形态的提交 | 见 §0.3 第二条命令 | **0 命中** |
| 2 | 两条区间内均无 `BREAKING CHANGE:` 页脚 | 同上（同一 grep 的第二分支） | **0 命中** |
| 3 | 无公开运行时接口被移除 | §4 内部契约变更表：**全部**是仓库内脚本契约 / 日志契约 / 补丁资产，不进用户可见面 | 0 |
| 4 | 无用户可见的配置键被新增/移除 | 本轮**未**触碰 `plugins.updater.*`（桥接版专属面）；`tauri.conf.json` 的 `version` 仍是 `"../package.json"` 继承写法 | 0 |

⇒ `release-manifest.json` 的 `breaking` 为 `false`。

---

## 3. 清单

### 3.1 alpha 区间（1 条）

| # | 提交 | 类型 | 摘要 |
|---|---|---|---|
| 1 | `e66f04c` | `build` | 推进 DSH 锚点 alpha `0.2.1-alpha.2→alpha.5` / next `0.2.0-rc.2→0.2.1-rc.2`（PR #11，双线） |

这一条是**整个 PR #11 的 squash**，内容（同一份树，两条线各自消费）：

| 面 | 内容 |
|---|---|
| 补丁重锚 | 两线补丁全部改名为 `+0.2.1-alpha.5` / `+0.2.1-rc.2`，并把冲突补丁按语义重放（三路合并移植，非「只改文件名」） |
| 补丁退役 | `settings-models` **双线退役**（上游已自带）；alpha / next 各 13 → 12 |
| 真实缺陷修正 | `ui-deliverables` 的兜底解析改挂三元守卫（歧义引用曾被错误解析成 `index.js`）；`typert-registry` 覆盖 3 个入口文件（`client.browser.js` / `client.node.js` / `index.js`） |
| 工具缺陷 | `merge-migrate-patches.mjs` 补回 `targetPackageVersion` 的 import（此前 merge 模式一跑就抛错，且**退出码为 0** —— 假成功形态） |
| 供应链门禁 | `deny.toml` 加 `RUSTSEC-2026-0370/0371/0372` 豁免（`zbus` 族 unmaintained，`patched=[]`，两消费者仍 `^5`，无升级路径），双 README 的 Security Notes 同源登记 |
| 锁文件 | `harness-locks/{alpha,next}` 提交式锁文件按新锚点重生成（家族子包逐个钉新版本） |

### 3.2 rc 区间（36 条，按类型分组）

**`feat`（3 条，本仓能力）**

| 提交 | 类型 | 摘要 |
|---|---|---|
| `30c6948` | `feat(host)` | Supervisor 补齐 env/profile 通道、修稳定窗口零值语义，并加三层测试 |
| `f3a9e97` | `feat(cli)` | 新增 `recover` 子命令——一条命令跑通崩溃自愈三段流程（S6-2） |
| `c8f2b17` | `feat(shell)` | 桌面壳改用 `dsh_host::Supervisor`（L1→L2 接线，ADR-064） |

**`perf`（1 条）**

| 提交 | 类型 | 摘要 |
|---|---|---|
| `275b789` | `perf(host)` | 日志热路径去每行正则重编译 + 落盘移出 async 任务 |

**`fix`（12 条）**

| 提交 | 类型 | 摘要 |
|---|---|---|
| `a500047` | `fix(release)` | 按通道取发布基线 + 补 `prerelease` / 草稿两道发布门禁（F14/F15） |
| `db74080` | `fix(host)` | `Supervisor::stop` 在「启动中」窗口漏杀子进程，Linux/macOS 上产生孤儿 |
| `0d62511` | `fix(clippy)` | 修 3 类 4 处被 `-D warnings` 拦下的 lint，并订正误导性的本地回退建议 |
| `2f0106a` | `fix(clippy)` | 删除 `state.rs` 两处多余 `return`（main 自带，CI 未捕获） |
| `704027e` | `fix(ci)` | 修 supervisor 集成测试里的 clippy 告警 |
| `94026e3` | `fix(drift)` | npm 查询失败时保留发布检查，仅在 HTTP 404 时判红 |
| `6ed6550` | `fix(plan-facts)` | 守卫锚点随 README 新措辞更新（`78c6b90` 漏改） |
| `0ab727b` | `fix(patches)` | typert lookup 族重放不再致命——三处注册器接管 + `warn`，并订正上游写死的错误前提（双线） |
| `5c7ee6d` | `fix(patches)` | 修 alpha 线两个既有补丁冲突——`deliverables` 补 context、`trajectory` 拆回三 hunk |
| `6e53e70` | `fix(update)` | 安装形态判定改用正向信号——`executable_dir` 在 Windows/macOS 恒为 `None` |
| `64a698d` | `fix(harness)` | 重建 alpha 提交式锁文件——锁内仍解析到 prerelease，`npm ci` 必红 |
| `bfdd236` | `fix(patches)` | alpha 主补丁的 hunk 头计数写错——`patch-package` 无法解析 |

**`docs` / `chore` / `build` / 非规范类型（20 条，均不产生 `n`）**

| 提交 | 类型 | 摘要 |
|---|---|---|
| `bec7edb` | `docs(release)` | 批准 alpha 线 `0.2.1-alpha.2.1` |
| `80c3d9b` | `chore(release)` | `0.2.1-alpha.2.1`（alpha 上一版发布提交） |
| `02f7677` | `chore(release)` | 升级 alpha 通道到 `0.2.1-alpha.2` |
| `b5db45b` | `build(alpha)` | 升级 DSH 到 `0.2.1-alpha.2` 并刷新运行时锁 |
| `a4f7df9` | `chore(gates)` | 新增 `dsh-host` 零窗口层依赖守卫（S6-1） |
| `e21dfb3` | `chore(ci)` | 空提交——用一次 `pull_request` 事件触发 main 的完整 CI 矩阵 |
| `78c6b90` | `docs(readme)` | 澄清 next / alpha 的锚定上游版本 |
| `bc51e95` | `docs(release)` | 澄清脚本契约与失败行为 |
| `c2f5828` | `docs(shell)` | 接线文档订正 E3——它从「需补测试」变成「抓到真实跨平台缺陷」 |
| `7a1aa77` | `docs(defects)` | 订正台账的门禁计数与 alpha 通道销账事实 |
| `f94732e` / `8383225` | 非规范（`Update …`） | 直接改 `patches/LAYERS.md` / alpha `trajectory` 补丁正文 |
| `916fecb` / `622ffef` | `reset`（非规范类型，原文保留） | 内容为零改动；按「不静默丢弃」规则原文留在这里 |
| `6525ca0` / `84a6b33` / `467b89e` / `475c103` / `a7b9e56` | merge | 五个 `--no-ff` 合并提交（把远端 main / PR #7/#8/#9 并入补丁分支） |

---

## 4. 仓库内契约变更（**不进**用户可见面的 breaking 判定，但必须写清楚）

| 变更 | 影响面 | 依据 |
|---|---|---|
| 新增 `dsh-host` **零窗口层依赖**守卫（S6-1） | 仓库内门禁：`dsh-host` 不得依赖 Tauri 窗口层 | `a4f7df9` |
| `Supervisor` 的**稳定窗口**语义订正：`stable_uptime == 0` 不再让退避与断路器同时失效 | 仓库内运行时行为（桌面壳的崩溃自愈）；用户可见面表现为「崩溃后先退避重启，最坏约 15.5s 才见错误页」 | `30c6948` `c8f2b17` |
| 启动阶段埋点日志契约 `[harness-node] phase <名> <段耗时>ms total=…` | **仓库内诊断面**：`harness.log` 的读法变了，用户可见面无变化 | `275b789`（同一契约的后续） |
| `patches/LAYERS.md` + `scripts/patch-layers.mjs` 的分级表随两线退役与重锚同步（`settings-models` 双线退役） | 仓库内补丁资产与登记表 | `e66f04c` |
| `deny.toml` 的 `advisories.ignore` 新增三条 `RUSTSEC-2026-0370/0371/0372`（`unmaintained`，`patched=[]`） | 仓库内供应链门禁；**不是**放宽安全策略——三类均在 `unmaintained` 通道，且两消费者仍声明 `zbus ^5`，本仓无升级路径 | `e66f04c` |

> ⚠️ **本表刻意不含 `plugins.updater.*`**：`allowDowngrades` 是**换代桥接版专属**的放宽手段
> （ADR-063），只写在 `v0.7.3-rc.1` / `v0.7.4-alpha.1` 上；本轮两条合成号**不写**该键，
> 比较器语义与原来逐字一致。

---

## 5. 与 Release Plan 的关系

第 3 步据此出计划（`release-manifest.json`）：

| 线 | `releaseType` | `n` | `w` | 派生出的合成号 | 上一版 |
|---|---|---|---|---|---|
| `alpha` | `mixed` | 1 | `null` | `0.2.1-alpha.5.1` | `0.2.1-alpha.2.1` |
| `next` | `mixed` | 1 | `null` | `0.2.1-rc.2.1` | `0.2.0-rc.2.2` |

`n = 1` 的含义：该 (上游精确版本, 通道) 组的**第 1 次**交付——两条在役键（`0.2.1-alpha.5` /
`0.2.1-rc.2`）在台账里的 `builds[]` **均为空**。两条线的 `n` 各自独立递增，**不共享序号**。

> ⚠️ **`w` 取 `null` 是偏离 §3.2 的显式裁定**：该表对 `mixed` 建议「`w` 标批次」。本轮不取，理由：
> `+w` 会进安装包文件名与 `latest.json` 的 URL（多一处必须正确处理的 `+` 编码面），
> 而批次身份已由台账的 upstream 键 + `n` 唯一确定，且 `w` **不承担排序**（§1.3）。

### 5.1 换代桥接版的顺序**本轮仍然满足**（不是待办）

合成号在排序上低于旧模型号（`0.7.x`），必须先发桥接版、再发合成号。**该前置已于 2026-10-09 完成**，
本轮实测核对如下：

| 通道 | 桥接版 tag | 已发布？ | 该通道当前最高已发布 tag | 是否是同一个 |
|---|---|---|---|---|
| `rc` | `v0.7.3-rc.1` | ✅ Release 存在（13 资产） | `v0.7.3-rc.1` | ✅ |
| `alpha` | `v0.7.4-alpha.1` | ✅ Release 存在（13 资产） | `v0.7.4-alpha.1` | ✅ |

⇒ 按 `docs/version-policy.md` §7.4，豁免判据三条**全部成立**（同通道 / `bridge.version ≥` 该通道
最高已发布 tag / 该 tag 已在 tag 语料里），本轮的合成号可以发。
⚠️ **不变式**：豁免成立时 `bridge.version === 该通道最高已发布 tag`——一旦有人在桥接版之上
发了更高的号（那一版没放宽比较器），豁免**自动失效**并重新判红。
本轮的 `0.2.x-*` 远低于桥接版，不改变该不变式。
