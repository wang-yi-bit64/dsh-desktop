# Feature Log

> **这是什么**：`docs/version-policy.md` §3.1「唯一权威链路」的**第 2 步**产物（Feature Log）。
> 它把「上个 tag..HEAD」的提交**分类累积**下来，供第 3 步（Release Plan）判断「这一版该不该切、切什么类型」。
>
> **它的权威边界**：本文件**不是**版本号的产地，也**不**批准发布。版本号由 `release-manifest.json`
> （第 3 步）批准、第 4 步从台账派生。本文件只回答「上次发布之后，仓库里多了哪些改动」。

---

## 0. 本轮基线与生成方式（先读这段）

### 0.1 基线的选择：**两条线各有各的基线**

`§5.1` 步骤 2 写的是「上个 tag..HEAD」。**在两条通道并存时，「上个 tag」不是唯一的**——
全局最新的 tag 属于 alpha 线，rc 线自己的上一个 tag 更早。两者相差 30 条提交。
把两者混成一句「上个 tag」会掩盖一个事实：**rc 线用户比 alpha 线用户少拿了 30 条改动**。

| 线 | 上一条已发布 tag | 日期 | 区间内提交数 |
|---|---|---|---|
| `alpha`（目标 `alpha`） | `v0.7.3-alpha.1` | 2026-10-07 | **17** |
| `next` / rc（目标 `next`） | `v0.7.2-rc.1` | 2026-09-30 | **47** |

⇒ 本文件的主体清单按 **alpha 基线（17 条）** 组织（那是「本轮新做的东西」），
并把 rc 线多出来的 30 条单列（§3.3）——它们是**已经随 alpha 发过、rc 线尚未交付**的存量。

### 0.2 上游锚点：**两条线在区间内都没有前进**

这是「为什么本轮不是 `upstream` 类型」的判据，逐 tag 核对过：

| 目标 | `v0.7.2-rc.1` 时的 `dshVersion` | `v0.7.3-alpha.1` 时的 | HEAD 上的 | 结论 |
|---|---|---|---|---|
| `next` | `0.2.0-rc.2` | `0.2.0-rc.2` | `0.2.0-rc.2` | 未前进 |
| `alpha` | `0.1.7-alpha.2` | `0.2.1-alpha.1` | `0.2.1-alpha.1` | 在 `v0.7.3-alpha.1` **之前**已前进完毕 |

⇒ 两个区间内**均无**上游前进 ⇒ 按 `§3.2` 排除 `upstream` 与 `mixed`；本仓有 `feat:` ⇒ **`desktop-feature`**。

### 0.3 生成方式（如实声明，不冒充机器产物）

`§3.1` 的表格把 Feature Log 的所有者写成「**机器 + 人工复核**」，落点写的是 `feature-log.mjs`。

**该脚本目前不存在**（全仓按 `**/feature-log*.mjs` 检索无命中）。因此本文件当前是
**人工按同一判据复核**写出的：分类规则与 `scripts/conventional-commits.mjs` 一致——
`parseCommit()` 解析、`classify()` 分组、`suggestBump()` 判版本位
（破坏性 → `major`；任一 `feat` → `minor`；任一 `fix` / `perf` → `patch`；
只有 `docs` / `chore` / `ci` 等 → `none`，即**不发版**）。本文件使用的「计入版本判定」一词
即指后者的前四类。⇒ 「机器生成」这件事**尚未落地**，不要把它读成已完成。

---

## 1. 分类统计

> 列「§3.1 计入」= `docs/version-policy.md` §3.1 的口径（`feat` / `fix` / `perf` / `security` / `refactor`
> 计入 Feature Log）。⚠️ 它与「升级位」**不是同一件事**：`suggestBump()` 只在
> 破坏性 → `major`、`feat` → `minor`、`fix` / `perf` → `patch` 时给建议，
> 只有 `refactor` / `docs` / `chore` … 时返回 `none`（不发版）。
> 本轮两条线都落在 §3.2 的 `desktop-feature`（`x.y.z` 不变、`n+1`）。

### 1.1 alpha 基线（`v0.7.3-alpha.1..HEAD`，17 条）

| 分类 | §3.1 计入 | 条数 |
|---|---|---|
| `feat` | ✅ | 6 |
| `fix` | ✅ | 4 |
| `refactor` | ✅ | 2 |
| `docs` | — | 2 |
| `chore` | — | 3 |
| **破坏性（`!`）** | — | **0** |

### 1.2 rc 基线（`v0.7.2-rc.1..HEAD`，47 条，含 8 条 merge/release 提交）

| 分类 | §3.1 计入 | 条数 |
|---|---|---|
| `feat` | ✅ | 8 |
| `fix` | ✅ | 13 |
| `refactor` | ✅ | 3 |
| `test` | — | 2 |
| `docs` | — | 4 |
| `chore` | — | 8 |
| `style` | — | 1 |
| merge / release | — | 8 |
| **破坏性（`!`）** | — | **0** |

---

## 2. 破坏性变更：**无**

**判据（可证伪，不是「我看了觉得没有」）**：

| # | 判据 | 命令 | 结果 |
|---|---|---|---|
| 1 | 区间内没有任何 `type(scope)!:` 形态的提交 | `git log --format='%s' v0.7.2-rc.1..HEAD \| grep -E '[a-z]+(\([^)]*\))?!:'` | 零命中 |
| 2 | 无公开运行时接口被移除 | 见 §4 内部契约变更表（均为仓库内脚本契约，不进用户可见面） | 0 |

⇒ `release-manifest.json` 的 `breaking` 为 `false`。

---

## 3. 清单

### 3.1 `feat`（6 条，alpha 基线）

| # | 提交 | 摘要 |
|---|---|---|
| 1 | `60d703f` | 落地合成版本号模型（ADR-061）—— 2b 台账 + 2i 缺口修复 + 两条门禁 |
| 2 | `51caac8` | 2c 落地 `sync-upstream-release.mjs`（`--plan` 默认只读 / `--apply` 显式写） |
| 3 | `0251178` | 2d `version.mjs` 子命令 + 修复步骤⑦ 恒判失败（`writeVersion` 契约不一致） |
| 4 | `a1605d3` | 2f 漂移哨兵换基准（npm dist-tag → 上游 GitHub Release）+ 修复前门步骤①② |
| 5 | `7ef96db` | MANIFEST v3 与 C1 改指台账 SSOT（2g + 2h 同批） |
| 6 | `fb95226` | 恢复 Dependabot 哨兵 —— 症状面零 secret 自动跑，前提面改由 PAT 驱动 |

### 3.2 `fix` / `refactor` / `docs` / `chore`（11 条，alpha 基线）

| # | 提交 | 类型 | 摘要 |
|---|---|---|---|
| 7 | `1b19b62` | `fix(gates)` | 令牌纪律收口 —— 提供了令牌时 skip 不成立（D13 前提面残余漏洞） |
| 8 | `853d78f` | `fix(gates)` | 哨兵成功时也回显输出（`echoOutput`）+ M6 字段白名单 |
| 9 | `b318252` | `fix(deps)` | Dependabot 安全更新不读 `dependabot.yml` 的 directory（D13）—— 关闭开关 + 两条守卫 |
| 10 | `eabbb7f` | `fix(deps)` | 删除孤儿 `src-tauri/Cargo.lock` —— 消幽灵 Dependabot 告警，补 cargo-lock-scope 守卫 |
| 11 | `856876f` | `refactor(targets)` | 2e 拆分 `dsh-targets` 职责（目标表 / 台账 / 写入面三产地互斥） |
| 12 | `a7ce8ed` | `refactor(gates)` | 撤回 `dependabot-setting` 的 CI job —— 实测 CI 核不了，不做变相背书 |
| 13 | `e1e9210` | `docs` | `§6` 登记上游依赖漏洞等待项（第 4 条）+ 区分本仓 rustls |
| 14 | `8f4421b` | `docs` | CODEOWNERS 头部状态同步 —— ruleset 已接通 code owners review |
| 15 | `cacc9b9` | `chore` | 永久移除 `pullfrog.yml`（ADR-062 关闭 ADR-058 决策 1 的恢复路径） |
| 16 | `1e0ea04` | `chore` | 新增 CODEOWNERS 并为其补可证伪守卫 |
| 17 | `915c07d` | `chore` | 探测 `GITHUB_TOKEN` 能否读到 `security_and_analysis` |

> ⚠️ 第 15 条（移除 `pullfrog.yml`）**不是**破坏性变更：它是 CI 侧的**决策落地**
> （ADR-058 → ADR-062），面向贡献者流程而非用户可见接口。此处单列，是为了避免
> 「看到『移除』就判 disruptive」这种按字面猜的读法。

### 3.3 rc 线额外持有的 30 条（`v0.7.2-rc.1..v0.7.3-alpha.1`）

这些提交已随 alpha 线发过（`v0.7.3-alpha.1`，2026-10-07），但 **rc 线上一次发布
（`v0.7.2-rc.1`，2026-09-30）时它们还不存在**。若本轮 `next` 线发布，rc 线用户将一并拿到它们。

按主题归类（完整 hash 见 `git log v0.7.2-rc.1..v0.7.3-alpha.1`）：

| 主题 | 条数（约） | 代表性提交 |
|---|---|---|
| primary runtime 载荷：拆除档2、默认带载荷、观测/退出/快捷键 | 4 | `115161b`、`a6e4ba9` |
| alpha 线上游推进至 `0.2.1-alpha.1`（锚点+补丁集+lockfile 原子提交） | 1 | `29093a7` |
| 测试竞态与平台差异收敛（`quit_probe` 桩、临时目录冒号、journal 轮转） | 4 | `05c1a83`、`2660287`、`2dfb24c`、`1ee03eb` |
| CI / workflow 收敛（runner 钉死、步骤名引号、PR Agent 门控、pullfrog 退役） | 5 | `78c3ab8`、`d6c8809`、`45d7327`、`9f7ec0e`、`47380f6` |
| 打包修复（剪枝 napi-rs 后缀式 `-musl` 变体，修 alpha 线 Linux AppImage） | 1 | `b197409` |
| 文档与门禁一致性、生产 `unwrap` 收敛 | 3 | `ad3b2a4`、`15b9169`、`9138545` |
| merge / release 提交 | 8 | `acc6972`、`5f715f2`、`521a8c7`（`chore(release): 0.7.3-alpha.1`）等 |
| 其他 chore / style | 4 | `5112173`、`ec56914`、`cc2cad0`、`d286f44` |

---

## 4. 仓库内契约变更（**不进**用户可见面的 breaking 判定，但必须写清楚）

| 变更 | 影响面 | 依据 |
|---|---|---|
| 台账 `harness-locks/dsh-releases.json` 的 `schemaVersion` 1 → 2，新增 `bridges[]` | 仓库内脚本（`readLedger` 对旧版本**显式报错**，不静默当空台账） | ADR-063 |
| 目标表字段 `channel` → `upstreamDistTag`（"channel" 一词从此**只**指桌面通道） | 仓库内脚本与文档 | `docs/version-policy.md` §3.3 |
| `dsh-targets.mjs` 不再回答「上游精确版本 → patchTarget + n」，改由台账侧 `resolveReleaseFor()` | 仓库内脚本 | `docs/version-policy.md` §3.3（2e） |
| 更新器配置新增可选键 `plugins.updater.allowDowngrades`（仅桥接版写 `true`） | **用户可见但行为不变**：非桥接版不写该键，比较器语义与原来逐字一致 | ADR-063 |

> 最后一行值得单独说明：`allowDowngrades` 会让比较器从「必须更新」放宽为「必须不同」，
> 因此它**只**写在换代桥接版上（本轮的 `v0.7.3-rc.1` / `v0.7.4-alpha.1`），
> 由构建期按台账 `bridges[]` 注入 —— 见 `ADR-063` 与 `scripts/updater-manifest.mjs::composeUpdaterConfig()`。

---

## 5. 与 Release Plan 的关系

第 3 步据此出计划（`release-manifest.json`）：

| 线 | `releaseType` | `n` | `w` | 派生出的合成号 |
|---|---|---|---|---|
| `alpha` | `desktop-feature` | 1 | `null` | `0.2.1-alpha.1.1` |
| `next` | `desktop-feature` | 1 | `null` | `0.2.0-rc.2.1` |

`n = 1` 的含义：该 (上游精确版本, 通道) 组的**首次**交付（台账 `builds[]` 里尚无记录）。

> ⚠️ **顺序不可颠倒**：本轮的合成号（`0.2.x-…`）在排序上**低于**线上现有的旧模型号
> （`v0.7.2-rc.1` / `v0.7.3-alpha.1`）。因此必须先发两条桥接版、再发本表的两条合成号——
> 否则已安装的客户端按默认判据（`release > current`）收不到更新。机制与豁免判据见 `ADR-063`
> 与 `docs/version-policy.md` §7.4。
