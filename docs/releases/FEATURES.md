# Feature Log

> **这是什么**：`docs/version-policy.md` §3.1「唯一权威链路」的**第 2 步**产物（Feature Log）。
> 它把「上个 tag..HEAD」的提交**分类累积**下来，供第 3 步（Release Plan）判断「这一版该不该切、切什么类型」。
>
> **本轮标记**：next 单线推进轮（`0.2.2-rc.3.1`，运行时 `0.2.2-rc.1` → `0.2.2-rc.3`）。
> 上一轮（双线重锚轮 `0.2.2-rc.1.1` / `0.2.2-alpha.3.1`）的同类清单已随 git 历史留档
> （24a58dc），本文件按「本轮」重写（§0.1 的基线因此前移）。

---

## 0. 本轮基线与生成方式（先读这段）

### 0.1 基线的选择：**两条线各有各的基线**

`§5.1` 步骤 2 写的是「上个 tag..HEAD」。**两条通道并存时「上个 tag」不是唯一的**——
本轮基线**按通道各取一条**（`changelog.mjs --print-baseline` 是同一套判据的机器实现）：

| 线 | 上一条已发布 tag | 指向提交 | 日期 | 区间内提交数 |
|---|---|---|---|---|
| `next` / rc（目标 `next`） | `v0.2.2-rc.1.1` | `d57d20d` | 2026-11-08 | **10** |
| `alpha`（目标 `alpha`） | `v0.2.2-alpha.3.1` | `8e36188` | 2026-11-08 | **1**（仅 alpha 线自己的发布提交） |

**本轮只发布 `next` 线**（rc 通道）：区间内的 10 条提交是「上游 rc.1 → rc.3 推进
（#22，`upstream` 面）+ 门禁与发布工具修复（#23 / #24 / #26 / #31，`fix` / `feat`）+ 文档与
证据链（#28 / #29 / #30 / #32，`docs`）+ alpha 线自己的发布提交（1 条 `chore(release)`）」。
alpha 线自 `0.2.2-alpha.3.1` 以来**零实质改动**（唯一新提交是它自己的发布提交），本轮不发
alpha 版本；Release Plan 的 `lines` 因此只含 `next`（第 3 步答「这一次发哪几条线」）。

> ⚠️ **本轮必须发的判据**（§0.2）：上游锚点前移 `0.2.2-rc.1` → `0.2.2-rc.3` 属 §3.2 的
> `upstream` 面——`x.y.z` 必须前进。同时区间内有 3 条 `fix` + 1 条 `feat`（需发版改动）。
> 另外**上游 rc.2 起把 `client-ui-*` 与 `typert-registry` 的浏览器产物改为 minified 打包**，
> 5 个补丁按 minified 锚点重建——继续停在 rc.1 等于在上游已离开的产物形态上打补丁。

### 0.2 上游前进面（判据：`scripts/dsh-targets.mjs`）

| 目标 | 上一 tag 时的 `dshVersion` | 本轮锚定 | 结论 |
|---|---|---|---|
| `next` | `0.2.2-rc.1` | `0.2.2-rc.3` | **前进**（同 minor 内跨 2 个补丁位；上游 rc.2 起 client-ui-* 产物 minified 化） |
| `alpha` | `0.2.2-alpha.3` | `0.2.2-alpha.3`（不动） | 无前进（上游 `alpha` dist-tag 未动） |

判据命令：

```bash
node scripts/dsh-targets.mjs --version-of next    # 0.2.2-rc.3
node scripts/dsh-targets.mjs --version-of alpha   # 0.2.2-alpha.3
```

### 0.3 生成方式（如实声明，不冒充机器产物）

`§3.1` 的表格把 Feature Log 的所有者写成「**机器 + 人工复核**」，落点写的是 `feature-log.mjs`。
**该脚本目前仍然不存在**——本文件当前是**人工按同一判据复核**写出的：分类规则与
`scripts/conventional-commits.mjs` 一致。⚠️ 本轮的分类统计由下面这组命令现算，可逐条复现：

```bash
BASE=$(node scripts/changelog.mjs --print-baseline --version 0.2.2-rc.3.1)   # → v0.2.2-rc.1.1
git log --oneline "$BASE..HEAD" | wc -l                                      # 10
git log --format='%s' "$BASE..HEAD" | sed -E 's/^([a-zA-Z]+)(\([^)]*\))?!?:.*/\1/' | sort | uniq -c
git log --format='%s%n%b' "$BASE..HEAD" | grep -cE '[a-z]+(\([^)]*\))?!:|BREAKING CHANGE' || echo 0
```

---

## 1. 分类统计（`v0.2.2-rc.1.1..HEAD`，10 条）

| 分类 | §3.1 计入 | 条数 |
|---|---|---|
| `fix` | ✅ | **3** |
| `feat` | ✅ | **1** |
| `build` | — | 1（#22：上游锚点推进 rc.1 → rc.3，12 补丁移植） |
| `docs` | — | 4 |
| `chore` | — | 1（alpha 线自己的发布提交，落在 next 区间内） |
| **破坏性（`!`）** | — | **0** |

---

## 2. 破坏性变更：**无**

**判据（可证伪）**：

| # | 判据 | 命令 | 结果 |
|---|---|---|---|
| 1 | 区间内无 `type(scope)!:` 形态的提交 | 见 §0.3 第三条命令 | **0 命中** |
| 2 | 区间内无 `BREAKING CHANGE:` 页脚 | 同上（同一 grep 的第二分支） | **0 命中** |
| 3 | 无公开运行时接口被移除 | 区间内的 `fix` 均为既有行为的**修正与加固**（sync-upstream 的崩溃守卫 / 并发防线 / 台账锁所有权模型；补丁语义修复对齐两线）；`feat` 是**新增**的发布工具模式（`--advance-key`），不触碰任何公开命令 / IPC / HTTP 接口 | 0 |
| 4 | 无用户可见的配置键被新增/移除 | 本轮**未**触碰 `plugins.updater.*`；`tauri.conf.json` 的 `version` 仍是 `"../package.json"` 继承写法 | 0 |

⇒ `release-manifest.json` 的 `breaking` 为 `false`。

---

## 3. 清单（10 条，按类型分组）

**`fix`（3 条）**

| 提交 | 类型 | 摘要 |
|---|---|---|
| `d17d10f` | `fix(release)` | sync-upstream null-plan 消费点加守卫——「锚点已动、台账键未建」如实判红而非 TypeError 崩溃（PR #23） |
| `4be5edf` | `fix` | qodo 评审五项 findings 全量修复（跨 #22/#23/#24）（PR #26） |
| `a96a6c4` | `fix` | CodeRabbit 11 条 actionable 全量复核——补丁侧 4 项语义修正 + 门禁侧 1 项 + 文档 3 项（PR #31） |

**`feat`（1 条）**

| 提交 | 类型 | 摘要 |
|---|---|---|
| `4fdb4a9` | `feat(release)` | sync-upstream `--advance-key` 推进期建键 + planSync null 出口改构造级保证（PR #24） |

**`build`（1 条）**

| 提交 | 类型 | 摘要 |
|---|---|---|
| `4e85aca` | `build(next)` | 上游推进 `0.2.2-rc.3`：5 个 minified 宿主补丁逐锚点重建 + sidebar padding 补裁退役（PR #22） |

**`docs`（4 条）**

| 提交 | 类型 | 摘要 |
|---|---|---|
| `a92d283` | `docs(commands)` | 26b 节补 `--advance-key` 旗标（PR #28） |
| `d03d708` | `docs` | rc.3 推进补登 scope=full 三平台烟雾证据（PR #29） |
| `3e14035` | `docs(checklist)` | 第 4 条 Dependabot 台账补 2026-11-15 复核（PR #30） |
| `b21be9b` | `docs(AGENTS)` | 合并前评审机器人双通道核查规则（§7.3）（PR #32） |

**`chore`（1 条）**

| 提交 | 类型 | 摘要 |
|---|---|---|
| `8e36188` | `chore(release)` | `0.2.2-alpha.3.1`（alpha 线发布提交，落在 next 区间内） |

---

## 4. 仓库内契约变更（**不进**用户可见面的 breaking 判定，但必须写清楚）

| 变更 | 影响面 | 依据 |
|---|---|---|
| **上游推进 rc.1 → rc.3**：`client-ui-*` 与 `typert-registry` 浏览器产物自上游 rc.2 起 **minified 化**，5 个补丁按 minified 锚点重建；`ui-sidebar` 自定义 padding hunk 补裁退役（§3 分级表 2026-09-16 已裁定） | `patches/next/**`、组装产物；裁定见 `patches/LAYERS.md` 2026-11-14 节 | `4e85aca` |
| **台账互斥锁改 PID 存活性判据**（活持有者绝不被接管，fs 错误 fail-closed）+ `--advance-key` 推进期建键 | `scripts/sync-upstream-release.mjs`、`scripts/release-ledger.mjs`（`readLedgerFromRaw` 同源读取）、台账 `$comment` | `4fdb4a9` `a96a6c4` |
| 合并前评审机器人双通道核查规则 | `AGENTS.md` §7.3（流程规则，非运行时） | `b21be9b` |
| Dependabot 台账复核：跟踪的 3 条告警清掉（锚点推进），open 集换血为 undici 族（跟随上游裁决不变） | `docs/dsh-upgrade-checklist.md` §4 | `3e14035` |

> ⚠️ **本表不含 `plugins.updater.*`**：本轮两条合成号（含上轮）**不写** `allowDowngrades`，
> 比较器语义与原来逐字一致（该键是换代桥接版专属，ADR-063）。

---

## 5. 与 Release Plan 的关系

第 3 步据此出计划（`release-manifest.json`）：

| 线 | `releaseType` | `n` | `w` | 派生出的合成号 | 上一版 |
|---|---|---|---|---|---|
| `next` | `mixed` | 1 | `null` | `0.2.2-rc.3.1` | `0.2.2-rc.1.1` |

`n = 1` 的含义：上游键 `0.2.2-rc.3` 在台账里的 `builds[]` **为空**，这是它的**第 1 次**交付。
本轮**单发 next**：`lines` 只含 `next`（第 3 步答「这一次发哪几条线」）；alpha 线自
`0.2.2-alpha.3.1` 以来零实质改动，不发版。

> ⚠️ **`w` 取 `null` 与上一轮同判**：`+w` 会进安装包文件名与 `latest.json` 的 URL（多一处
> `+` 编码面），批次身份已由台账 upstream 键 + `n` 唯一确定，且 `w` 不承担排序。

### 5.1 换代桥接版的豁免**仍然成立**（不是待办）

合成号在排序上低于旧模型号（`0.7.x`），豁免判据三条已于 2026-10-09 全部成立（桥接版
`v0.7.3-rc.1` / `v0.7.4-alpha.1` 已发布且为当时通道最高 tag）。本轮的 `0.2.2-rc.3.1` 远低于
桥接版、不改变该不变式；若桥接版之上已发布更高号，豁免**自动失效**并重新判红（当前实测
该通道最高 tag 仍为桥接版）。
