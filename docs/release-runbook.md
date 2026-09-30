# 发布与版本 Runbook

> 从 `AGENTS.md` 原 §8「版本与发布」迁入：§8.1~§8.5 全节 + §8.6 全节（含通道细则与历史发布记录）。被钉住的 DSH 版本表仍在 `AGENTS.md` §8.6 保留一份权威副本。

### 8.1 版本号的唯一真源

| 位置 | 角色 | 谁写 |
|------|------|------|
| `package.json` → `version` | **唯一真源** | `scripts/version.mjs` |
| `src-tauri/tauri.conf.json` → `version` | 写 `"../package.json"`，**原生继承**不存值 | 手工设一次，之后不动 |
| `Cargo.toml` → `[workspace.package] version` | 跟随真源（Cargo 读不了 package.json） | `scripts/version.mjs` |
| `Cargo.lock` | 生成物，跟随 Cargo.toml | cargo 自身 |
| `CHANGELOG.md` | 生成物，由提交历史推导 | `scripts/changelog.mjs` |

`tauri.conf.json` 之所以能不存值：Tauri 官方 schema 明确允许 `version` 写成
「`package.json` 的路径」（*"a semver version number **or a path to a `package.json` file**
containing the `version` field"*）。用满这个能力就把三处重复消掉一处——**不要**把它改回硬编码字面量。

### 8.2 版本号怎么推进（规则可执行，不靠人记）

| 提交内容 | 推进 | 例子 |
|---------|------|------|
| 任一破坏性变更（`!` 或正文 `BREAKING CHANGE:` 页脚） | `major` | 0.3.1 → 1.0.0 |
| 任一 `feat` | `minor` | 0.1.0 → 0.2.0 |
| 任一 `fix` / `perf` | `patch` | 0.2.0 → 0.2.1 |
| 只有 `docs` / `chore` / `ci` 等 | **不发版** | —（产物无行为变化） |

- 由 `npm run version:bump -- auto` 执行上面的判定，也可 `version:set <x.y.z>` 直接指定。
- **`0.y.z` 阶段（当前）**：破坏性变更升 `minor` 而非 `major`——API 本就未稳定，用 `major`
  会让版本号跑在实际成熟度前面。
- 预发布版本用 `-` 后缀（`0.2.0-beta.1`）。对应的 GitHub Release 会被标为 prerelease，
  且**不进入** updater 的正常更新通道。
- **先 `--dry-run` 再真改**：`npm run version:bump -- auto --dry-run`。
- 没有历史 tag 时 `auto` **会报错并要求显式指定**——首次发布不该由一个推导规则猜版本号。

### 8.3 变更日志与 Release 正文

`CHANGELOG.md` 与 Release 正文**来自同一份数据（git 提交历史）与同一套渲染逻辑**，因此不会出现
「Release 页说的」与「CHANGELOG.md 说的」不一致。

- 解析器 `scripts/conventional-commits.mjs`：类型分组、破坏性置顶、版本建议。
- 渲染器 `scripts/changelog.mjs`：`--write` 落 `CHANGELOG.md`，`--notes` 出 Release 正文。
- **两条硬规则**（都有自测钉着）：
  1. **不静默丢弃任何提交**。认不出的 `type`（例如历史上真实存在的 `debug(ci):`）归入「其他」
     并保留原文。静默丢弃会让变更日志**因遗漏而撒谎**——比分类不准严重得多。
  2. **破坏性变更同时出现在置顶章节与它的类型章节**——读者既要知道「有不兼容改动」，
     也要知道它属于哪一类工作。

> ⚠️ **为什么不用 GitHub 内置的 `--generate-notes`**：它按**已合并 PR** 归纳，而本仓库全程直推
> `main`（`gh pr list --state all` 为空）。2026-09-11 实测其产出只有一行
> `**Full Changelog**: …`、零条目。直推流程下这条路走不通，不要为了"少维护"换回去。

**段落区间是「写日志那一刻」，不是「tag 那一刻」**（2026-09-23 实测到的缺口）：

`version:bump --commit` 在**提交之前**生成段落，区间是「上一个 tag .. 当前 HEAD」。若此后到真正打 tag
之间还有提交，它们就落在区间之外：**提交在 tag 里、却不属于任何 CHANGELOG 段落**。而
`verify:changelog` 只是纯逻辑自测（`--self-test`），**不与 git 交叉核对**，所以这种遗漏**不会报红**——
它属于本仓库反复出现的那类「静默失效」。实测两例：`0.7.0-alpha.5` 段缺 5 条
（`ecde5e0` / `3f3c46c` / `eca0612` / `8ed0a9e` / `992aa75`，占该版本全部改动的大半），
`0.7.0-alpha.3` 段缺 1 条（`9560459`，二次重跑版本切换留下的重复提交）。

- **纪律**：写日志与打 tag 之间**不要再提交**。确实需要补提交时，用
  `changelog:write --version <同一版本> --force` 重生成该段——段落内容完全由 git 推导，重生成是幂等的。
- ✅ **Release 正文不受这个缺口影响**：`release.yml` 走 `--notes --to "$TAG"`，直接从 git 读区间。
  所以症状是「Release 页准确、`CHANGELOG.md` 缺条目」——这个方向本身就说明两条链路**读取方式不同源**
  （同源的是解析器与渲染器，不是区间来源）。

**流程推论：候选提交要攒齐再推（2026-09-23 的代价）**。既然「写日志之后不得再提交」，那么候选提交
每变动一次，就要连带重生成一次 CHANGELOG **并**重跑一轮 CI + 两条 Smoke（§8.5 第 2 步）。
alpha.6 的准备期正是这样跑掉了三轮：推 `9e112e2`（CI 三平台同一 step 红）→ 修镜像闭包推 `4ab3e2b`
→ 重生成日志推 `a7b1b2b`。其中第三轮**纯属自己造出来的**——`4ab3e2b` 之后本就还要改变更日志。
**正确顺序：本地把候选提交与 CHANGELOG 都定稿 → 一次性推 → 只跑一轮门禁 → 打 tag。**

**段间空行不变量**：每个 `## [x.y.z]` 标题前恰好一个空行。`insertSection` 的覆盖（`--force`）路径
一度会吃掉它——覆盖区间的结束边界取在「下一段标题字符」处，而分隔两段的空行**原属被覆盖的那一段**，
替换之后新段落与下一段被直接拼在一起（`…)\n## [0.1.0]`）。这种产出在编辑器与 GitHub 上**照样正常
渲染**，所以潜伏了很久（文件里 `0.7.0-alpha.3` → `alpha.2` 边界留着疤，那是某次 `--force` 重写的遗迹）。

- 修法刻意放在 `normalize()` 里，而不是只修覆盖路径：这样**任何一次**生成都会把整份文件的该不变量
  修好，历史遗留的疤无需专项清理，也不会在下一次发布时复发。
- 自测 6d 是**两向**断言：覆盖非末段后必须仍有空行，**并且**「紧贴标题」的输入必须被修正——只有前者
  的话，输入本来就带空行时断言会白过。

### 8.4 CI 工作流与触发条件

| 工作流 | 文件 | 触发 | 做什么 |
|--------|------|------|--------|
| CI | `.github/workflows/ci.yml` | 任意 `pull_request` / 手动 / **每日定时一次** | 三平台 `test`（静态门禁 + clippy + 单测）。**不组装资源、不打包、不跑烟雾** |
| Smoke | `.github/workflows/smoke.yml` | **仅手动**（`workflow_dispatch`，四个输入：`scope` / `os` / `fault_injection` / `dsh_target`） | 按 `scope` 分级：`l1`（mock 资源树 L1 会话烟雾 + 可选故障注入）/ `assembled`（组装真实资源树 + 真实树 L1）/ `full`（+ 打安装包 + L2 GUI 烟雾 + 体积采集）。`dsh_target` 选组装哪条上游通道（`next` / `alpha`）。**不发布任何东西** |
| Drift | `.github/workflows/drift.yml` | **每日定时一次** / 手动 | 上游 DSH 版本漂移哨兵：`verify:drift` **逐通道**对照各自的 npm dist-tag（`next` 对 `next`、`alpha` 对 `alpha`），落后即红。**不构建任何东西**——只回答「该规划升级了吗」 |
| Release | `.github/workflows/release.yml` | **推 `v*` tag** / 手动（指定 tag） | `preflight`（版本↔tag 一致性 + **从 tag 的预发布通道名推导 `dsh_target`** + 秒级静态门禁）→ 三平台并行出包（`build`）并**创建/更新 GitHub Release**、上传安装包与 `.sig`、生成 updater 的 `latest.json`；Windows 的 `portable` job 出便携 zip → `publish-assets` 把便携版三件挂到 Release（**F13 修复，2026-09-24 新增**：此前它们只停在 Actions artifacts 里，Release 上永远只有 10 项而非期望的 13）。🗄️ 原 `cli` / `cli-publish` 两个 job 已于 2026-09-24 退役（见 §8.4 末条） |

- **每日定时是「日常零自动化」的补偿，不是把它加回来**（2026-09-12 起）：`ci.yml` 增设
  `schedule`（每天一次）、新增 `drift.yml`。二者合起来让「main 的 HEAD 有没有烂」与「上游
  是否已甩开我们」最迟 24 小时内被证实——成本是**一天一次**而非每次提交一次。它们**不替代**
  发布前那两次手动 dispatch：定时 CI 不跑冒烟（起窗口那一步），drift 只比版本号。

- **日常提交不触发任何 CI**（2026-09-11 起）：`ci.yml` 摘掉了 `push: main`，**推 tag 也不会跑它**
  （tag 归 `release.yml`；同一件事两处实现必然漂移，出包只留一个产地）。日常提交要的是快反馈，
  静态门禁 + 单测就够了；组装 300MB 资源、打包、起窗口这些成本高的动作不该挂在每次提交上。
  `pr` 触发保留（拉 PR 时跑静态 + 单测），`workflow_dispatch` 保留（在分支上主动验证）。
- **冒烟测试改为手动触发**（2026-09-11 起）：冒烟（L1/L2）**从 `ci.yml` 迁到独立的 `smoke.yml`**，
  且**只**由 `workflow_dispatch` 触发。保留能力、去掉自动化，正是为了「需要时能跑、平时不占额度」。
  三种 `scope` 对应三档成本，见上表；`gh workflow run smoke.yml -f scope=l1` 是命令行等价物。
  与 `ci.yml` 的关系是**搬家不是另起一套**：用的是同一批脚本（`smoke-launch.mjs` / `fault-inject.mjs`）
  与同一套断言，只是触发方式从自动变成了手动。
- **为什么发布用 tag 触发而不是 main 提交**：发布是一次性、不可撤销的动作（Release 一旦公开
  就有人下载）。tag 是显式的单一意图声明；让 main 上每次提交都发版会把「发布」退化成无需决策的背景动作。
- **`workflow_dispatch` 兜底**：发布失败时可指定同一个 tag 重跑，不必删 tag 重建（删已发布的 tag
  是破坏性操作）。
- **与 CI 的边界（2026-09-11 重述）**：Release **不重跑** `cargo test` / clippy / 三平台烟雾矩阵，
  它只跑 `preflight` 的秒级静态门禁 + 版本校验，目的是在组装 300MB 资源**之前**失败。
  ⚠️ **但「tag 提交已经绿过」这个前提不再自动成立**——`ci.yml` 不再随 `push main` 触发，冒烟也
  不再自动跑，Release 成了 tag 上唯一会出包、也唯一会拦一道门的地方，而 preflight 看不见运行时行为。
  **发布前请手动 dispatch 一次 CI 工作流（静态 + 单测）与一次 Smoke 工作流（冒烟），都确认全绿，
  再打 tag。** 残留风险（给从未跑过门禁的提交打 tag，Release 不会发现）是**有意接受的边界，不是遗漏**。
- **各平台产物类型必须显式传 `--bundles`**：`tauri.conf.json` 的 `bundle.targets` 只写了 `nsis`
  （Windows 专属）。macOS/Linux 上必须显式声明 `app,dmg` / `deb,appimage`，不要依赖 Tauri 对
  不支持类型的平台回退行为（既无文档承诺，也无法在本机验证）。
- **`latest.json` 是更新链路的命门**：每个通道一个滚动 Release（`updater-<publishChannel>`）。
  tauri-action 的 `uploadUpdaterJson`（默认开）把它生成到**版本 Release** 的资产里，
  再由 `updater-channel` job 以 `--clobber` 覆盖到滚动 Release；端点即
  `releases/download/updater-<channel>/latest.json`。**它不在 Release 里，自动更新就是断的**。
- ⚠️ **不要再指向 `releases/latest/...`**（2026-09-30 起废弃，见 ADR-053）：GitHub 的 latest 排除
  预发布，而本仓版本全是预发布 ⇒ 那条路径自 2026-09-15 起零投递（实测返回 `0.5.0-next.1`，
  而已发布到 `0.7.x`）。端点 URL 的**唯一产地**是 `scripts/updater-manifest.mjs`，
  由 `tauri build --config` 在构建期注入。
- 🗄️ **CLI 产物发布通道 — 已退役（2026-09-24）**：`release.yml` 的 `cli`（三平台构建 +
  打包 + upload-artifact）与 `cli-publish`（下载核验 → `gh release upload` → 正文渲染）
  两个 job **已删除**。原位留有退役说明（含恢复条件）。
  **退役依据**（逐条实测，见 [`docs/dev-plan-cli-distribution.md`](docs/dev-plan-cli-distribution.md) §5）：
  · **本仓之外零消费者**——三个消费者（`smoke-launch.mjs` / `fault-inject.mjs` /
  `cli_blackbox.rs`）全部使用 `target/debug/` 的本地构建，与上传产物**零交集**；
  · **产物不自足**——归档不含 runtime，`start` 必然退出码 3；而已装桌面的用户本地就有
  `resources/`、第三方又跑不起来，故「可引用」名不副实；
  · **定位不依赖产物**——INV-6 靠「存在一个能跑二进制的入口」，不靠「挂在 Release 上」。
  ⚠️ **退役的是发布，不是能力**：`crates/dsh-host-cli`、`scripts/package-cli.mjs`（约 40 项
  可证伪打包判据）与 `preflight` 的 `verify:cli-package` **全部保留**。
  「取消发布」与「删掉 crate」是两件不同的事——`verify-release-workflow.mjs` 的
  `checkCliCrateRetained` 专门守着后者（防止退役时顺手把 INV-6 的兑现载体删掉）。
  ⚠️ **归档**：`scripts/dry-run-cli-publish.mjs` → `docs/archive/`（它 100% 服务于上传步骤）。
  ⚠️ **历史资产不删**：已发布 Release 上的 9 个 CLI 资产保留（可下载、链接有效；
  GitHub 删资产**不可逆**）。**后续发布的期望资产数由 22 改为 13**
  （9 平台 + 1 `latest.json` + 3 便携版）。
  🔁 **恢复条件（未失效）**：出现第一个非本仓消费者时按 ADR-045 恢复——须先改 ADR 状态、
  同步 README/AGENTS 宣称、再把 `checkCliArtifactShape` 改回正向断言。

### 8.5 发布操作步骤（人看的）

```bash
# 1. 确认待发布提交在 main 上
git checkout main && git pull

# 2. 手动 dispatch CI 与 Smoke 并确认全绿（★ 2026-09-11 起为必需步骤）
#    日常提交已不触发 CI，冒烟也不再自动跑，Release 的 preflight 只跑静态门禁、
#    看不见运行时行为，因此「静态 + 单测」与「冒烟」这两轮只能在发布前手动补齐。
#    gh CLI 示例（在 Actions 页点 Run workflow 等价）：
gh workflow run ci.yml --ref main                                      # 三平台静态门禁 + clippy + 单测
gh workflow run smoke.yml --ref main -f scope=full -f dsh_target=next  # 组装真实资源 + 打包 + L2 冒烟
gh workflow run smoke.yml --ref main -f scope=full -f dsh_target=alpha # ★ 另一条通道也要跑，不能只跑默认
gh run watch   # 等到三个都全绿再继续，且都必须跑在「将要打 tag 的那个提交」上

# 3. 看将要升到哪个版本（不写任何文件）
npm run version:bump -- auto --dry-run

# 4. 落版本号 + 重新生成 CHANGELOG 段落 + 提交 + 打本地 tag（一个原子发布提交）
npm run version:bump -- auto --commit --tag

# 5. 推送（tag 推送即触发 Release 工作流）
git push origin main --follow-tags
#    ⚠️ --follow-tags 会把「本机有、远端没有」的注释标签一并推上去，而推 v* tag 会再次
#    触发 release.yml。若历史上删过某个远端 tag，先在本机也删掉（git tag -d <tag>），
#    否则下一次发布会凭空再造一个旧版本的 Release。见下文 2026-09-23 记录。
```

> 第 4 步的 `--tag` 只创建**本地** tag，推送与否由人决定——这是刻意的：打 tag 就是发布意图，
> 不该由脚本替人按下。
>
> `--commit` 会**一并重新生成 CHANGELOG.md 的对应段落**并纳入同一个提交。版本号与变更日志
> 同属「这一次发布」，分成两个提交就会出现「tag 指向有版本号、没变更日志的那个提交」——
> CHANGELOG.md 从此永久滞后一版。
>
> ⚠️ 第 2 步不是可选的仪式：`ci.yml` 不再随 `push main` 触发、冒烟也改为手动之后，这两次
> dispatch 是你的提交在打 tag 前**唯一**几次会跑 `cargo test` / clippy / 真实进程冒烟的机会。
> 跳过它们，Release 不会替你拦。只想要快速一档时，`smoke.yml` 用默认的 `scope=l1` 即可
> （几十秒、不起窗口）；要复现发布形态就用 `scope=full`。
>
> ⚠️ **`smoke.yml` 的 `dsh_target` 默认是 `next`**——只按默认跑一次 = 只验了一条线，日志全绿
> 也说明不了 `alpha` 线。2026-09-23 就踩过：一次全绿的 `scope=full` 实际组装的正是
> `harness-deps/next`，而待发布的 alpha 线**从未被冒烟过**。核验某次运行验了哪条线，
> 看日志里的 `harness-deps/(next|alpha)`。规则见 §8.6「发布前两条线各自都要有证据」。

**发布后按资产清单核对（★ 唯一可信的完整性判据）**：`build` job 里的 tauri-action 会在
**半途**就把 Release 建出来并公开（`releaseDraft: false`），所以「Release 页存在」完全
不等于「发布成功」；而 `portable` 是 Windows 独占 job，它一失败，本次发布的便携版 zip
就**永久缺**，且**无声**（历史上 `cli-publish` 的 `needs` 含它，会被**整体跳过**，
连带 9 个 CLI 资产一起缺——那条上传通道已于 2026-09-24 退役，现在只影响便携版 3 个）。

```bash
TAG=v0.7.0-alpha.7
gh release view "$TAG" --json assets --jq '.assets|length'          # 2026-09-24 起期望 13
gh api "repos/wang-yi-bit64/dsh-desktop/releases?per_page=100" \
  --jq ".[]|select(.tag_name==\"$TAG\")|\"\(.assets|length)\""
```

**期望值 13**（2026-09-24 起）= 9 平台安装包 + 1 `latest.json` + 3 便携版
（`.zip` / `.zip.sha256` / `.manifest.json`）。
⚠️ **历史发布仍是当时的值**，核对**旧 tag** 时不要套用 13：`alpha.7` 及更早的完整发布是
**22**（多出 9 个 CLI：3 triple × {归档, `.sha256`, `.manifest.json`}）、更早还有 19
（`alpha.1` / `alpha.2`，当时尚无便携版；`alpha.3` 没有 Release）。
再抽一遍最小资产体积，确认**没有 0 字节**——`.sha256` 约 100 B 量级是正常的：

```bash
gh release view "$TAG" --json assets --jq '.assets[]|"\(.size)\t\(.name)"' | sort -n | head -5
```

**发布后核对（自动化，2026-09-24 起）**：上面那个「数资产个数」的人工步骤现在有脚本了——
`npm run verify:release-assets -- --check-release <tag>` 会**逐项比对资产名字**，而不只是数个数：

```bash
TAG=v0.7.0-alpha.7
npm run verify:release-assets -- --check-release "$TAG"
# 通过 → ✅ Release <tag> 的资产清单完整（13 项）
# 失败 → 逐条列出缺了哪一项（含 kind / platform），并单独报「出现了 CLI 资产」
npm run verify:release-assets -- --print-expected   # 打印期望清单，供人工比对
```

⚠️ **为什么必须有脚本而不是照旧人工数个数**：F13（2026-09-24 发现）的形态是
「CLI 通道退役时只数了 `cli-publish` 的一类职责，便携版『核验 + 上传』那半截没被搬走」
⇒ 此后**每次发布的实际资产是 10 而不是 13，而全部门禁绿灯**。根因不是「忘了调一次上传」，
而是**全仓零判据断言资产数**——13 只活在本节文字里，是一句**承诺**而非**断言**。
现在判据有三个层次，各守一件事：

| 判据 | 守什么 | 跑在哪 |
|---|---|---|
| `verify:release-assets`（默认） | `release.yml` **形状上能不能**产出 13 项 | 静态，进 `ci.yml` 与 release `preflight` |
| `verify:release-assets -- --check-release <tag>` | 某次发布**实际**产出几项 | 发布后手动（需 `gh` + 联网） |
| `verify:release-workflow` | 上传动作的**宾语**是 `dist/portable/*` 而非 `dist/cli/*` | 静态，进 `ci.yml` 与 `preflight` |

🔴 **命名模式取自实测，不得从 `tauri.conf.json` 反推**。`productName` 是 `DSH Desktop`（带空格），
tauri-bundler 把它渲染成 `DSH.Desktop_<ver>_x64-setup.exe`（**点号分隔产品名、下划线分隔版本**），
而 macOS 的 updater 包是 `DSH.Desktop_aarch64.app.tar.gz`（**没有版本段**）。
第一版判据把模式写成 `DSH-Desktop-…`（连字符），**自测夹具也用同一套错名字** ⇒ 13 项全绿、
实际一个资产都匹配不上——这是本仓「自测与被测犯同一个错 → 对称失效」的又一例。
`judgeAssets` 因此额外配了一条**反向夹具**：喂入连字符命名必须判红。

#### 发布失败后的 tag 清理

失败的 tag 不留：它会被 `git describe` / `changelog.mjs` 的 `latestTag()` 当成基线，一个
没有产物的 tag 留在盘上，下一次 `version:bump -- auto` 与 CHANGELOG 区间都可能对着它算。
判据按**资产清单**数，不按「Release 页面存不存在」——`build` job 的 tauri-action 会先把
Release 建出来（`releaseDraft: false`），所以 Release 在、tag 在，都不等于发布成功。

```bash
git push origin --delete <tag>   # ⚠️ 只删 ref，不删 Release——见下条
git fetch --prune --prune-tags   # 让本地跟随远端清掉
```

- 🔴 **删 tag ≠ 删 Release**（2026-09-23 实测）：tag 一消失，GitHub 把该 Release 降级成
  **未标记的草稿**（`draft: true`、`html_url` 变成 `releases/tag/untagged-<hash>`），对象与
  资产**原样留着**。`gh release list` 与 Releases 页都不显示它，所以从页面上看像「已经清干净了」，
  而 `releases/download/<tag>/…` 的公开链接确实断掉了（updater 因此不会再取到）。要真正删掉：

  ```bash
  gh release view <tag> --json isDraft,assets --jq '{draft:.isDraft,n:(.assets|length)}'
  gh release delete <tag> --yes          # 用 tag 名仍能定位到那份草稿
  ```

  ⚠️ **这一步与前一步的性质完全不同**：删 tag 只动 ref，可逆；删草稿会**连它的全部资产一起
  永久删除**（`gh release delete` 没有「保留资产」的选项），且**不可恢复**。所以是否要走到
  这一步是**独立的一次判断**，别把它当成「清理」的默认收尾。判据建议：这份产物是否还有人
  可能装到——`alpha.1` 的 Windows 安装包缺 `parent-death-watchdog.mjs`（装完即崩），
  那它留着反而是风险；而一份资产齐全、只是被取代的旧版，留着草稿没有坏处。
  实测：`alpha.4` 的草稿经确认后用 `gh release delete v0.7.0-alpha.4 --yes` 删除，
  10 个资产随之丢失；`alpha.1` 的草稿同样经确认删除（19 个资产丢失）。
  **两次都在删前把资产清单（名字 + 字节数）导成 JSON 存档**——资产本身不可恢复，
  至少留下「删掉了什么」的记录：

  ```bash
  gh release view <tag> --json tagName,isDraft,createdAt,assets \
    --jq '{tag:.tagName,draft:.isDraft,created:.createdAt,assets:[.assets[]|{n:.name,s:.size}]}' \
    > /tmp/<tag>-draft-backup.json     # 先存证，再 gh release delete
  ```

- **2026-09-23 清理掉的 tag**：`v0.7.0-alpha.3`（组装期被 picker 位置断言卡死）、
  `v0.7.0-alpha.5`（`finally` 里的 `rmSync` 否决了通过的核验）、
  `v0.7.0-alpha.6`（Linux 侧 `unzip` 反斜杠条目名，`cli-publish` 红，Release 从未产出）、
  `v0.7.0-alpha.4`（`portable` job 失败 → `cli-publish` 被跳过，10/22 资产）、
  `v0.7.0-alpha.1`（链路跑通、资产齐全，但 Windows 安装包缺 `parent-death-watchdog.mjs`，
  装完即崩——按「用户能装到一个坏包」即视为失败清理，由 `alpha.2` 取代）。
  清理后远端只剩 9 个 tag，本机同名 tag 已同步删除（否则 `--follow-tags` 会推回去，见 §8.6 记录）。
- **CHANGELOG.md 的对应段落原样保留**：它是生成物、按提交历史推导，删 tag 不会重写出这些段，
  于是留下「有段落、无 tag」的历史版本。这是**预期结果**，不要手工删段落去「对齐」。
- **取代关系写进后继版本的 Release 正文**，不写进被取代那一版（它的 tag 会被删掉）。
- 发同一版本号时**换新号而不是复用 tag**：删 tag 后重推同一版本号，updater 的 `latest.json`
  与用户本地已装版本都会把它当成「已经是最新」，等于永久漏更。

### 8.6 双上游运行时通道（next / alpha）

自 2026-09-15 起，本仓**同时维护两条上游运行时通道**，各自钉一个 DSH 版本、持有一套
补丁与 vendored 覆盖包：

| 目标 | 上游线（`channel`） | 固定的 DSH | 补丁 / vendored | 桌面后缀（`publishChannel`） | 对应的桌面版本形态 |
|------|--------|-----------|----------------|------------------|------------------|
| `next`（默认） | 目标对应 npm `next` dist-tag，⚠️ **但当前锚在上游 `latest`** | `0.1.5-rc.3` | `patches/next/`（14 个）、`packages/next/`（已清空） | `rc` | `0.7.0-rc.1` |
| `alpha` | npm `alpha` dist-tag | `0.1.6-alpha.2` | `patches/alpha/`（13 个）、`packages/alpha/`（已清空） | `alpha` | `0.7.0-alpha.2` |

> ⚠️ **`next` 目标的锚点当前低于它对应的上游线**（2026-09-24）：上游 `next` 已前进到
> **`0.1.7-rc.1`**，而本仓锚在 `latest` 的 **`0.1.5-rc.3`**。原因是跨两个 minor 的移植含
> **上游重构**（预检 clean 5 / conflict 9，**79 个 hunk 需重新撰写**），已另立批次；
> 本批次先锚 `latest` 以取得可用基线。**`verify:drift` 对此会告警，属已知且已记录的状态**。
> 详见 [`patches/LAYERS.md`](patches/LAYERS.md) 的「next 线（0.1.5-rc.3）的移植裁定」。

> **两条线的补丁数可以不同，这是正常的**：`alpha` 线上游已补齐平台化侧栏宽度，
> 本仓那条补丁按 `retireWhen` 退役（14 → 13）；`next` 线尚未跟进到同版本，因此仍保留。
> 补丁**净减少**是补丁退役机制想要的方向——不要为了「两条线一样多」而把退役的补丁加回去。

- **唯一事实源是 [`scripts/dsh-targets.mjs`](scripts/dsh-targets.mjs)** 的 `DSH_TARGETS`：
  目标名 ↔ 通道 ↔ 版本号。`prepare-harness.mjs` 不再写死版本，而是按 `--dsh-target=<name>`
  从该表推导（含该目标的补丁目录、vendored 目录与 staging 目录 `harness-deps/<target>/`）。
- 🔴 **两个「通道名」不是一回事（2026-09-24 解耦，此前被混为一谈）**：

  | 字段 | 回答的问题 | 值的来源 | 现取值（`next` 目标） |
  |---|---|---|---|
  | `channel` | 组装时**拉上游哪条 npm dist-tag** | 上游客观事实，**不可改** | `next` |
  | `publishChannel` | 桌面 tag 的**预发布后缀** | 本仓命名，**可改** | `rc` |

  造成为何必须分开：上游 `next` dist-tag 现在**指向一个 `rc` 阶段版本**——dist-tag 是
  「哪条发布线」，预发布标识是「这条线走到哪一步了」，两者独立。本仓想把桌面后缀改成语义
  更准的 `rc`（因为发的确实是 rc 阶段的包），但**不能**因此去查一个上游根本不存在的 `rc` tag
  （那会让漂移哨兵静默退回 `latest`，把一条自己管着的线永久误报成落后或持平）。
- **桌面版本号的预发布后缀是 `publishChannel`**，`release.yml` 的 preflight 用
  `node scripts/dsh-targets.mjs --channel-of "$VERSION"` 从 tag 反推该组装哪个运行时，
  因此**不需要在 tag 之外再声明一次通道**。未知后缀（如 `0.7.0-beta.1`）**直接失败**，
  不回退默认目标——静默回退会产出「版本号说 beta、运行时却是 next 线」的包，
  而这类错配只有用户装上才会发现（updater 的版本比较会跟着一起错）。
  ⚠️ 后缀是 `publishChannel` 而**不是**目标键：`v0.7.0-rc.1` 组装的是 **`next`** 目标。
  `v0.7.0-next.1` 这类**旧后缀已不再是合法输入**（会报错），改名后不要再用。
- **两条线的补丁做的是同一件事，只是行号随上游版本变化**。因此 `patch-layers.mjs` 的
  分级表按**包名**索引：新增一条上游线**不需要**动它；只有引入新包才要补登记。
- **移植补丁必须重算行号**：`patch-package` 按 `@@ -N` 的行号定位，偏移取 0、-1、+1…
  **超过 ±20 行即放弃**。而「把补丁从一条线复制到另一条、只改文件名」会让行号漂到
  20 行以上——此时只按内容搜索的预检（`check:patch-applicability`）报 clean，
  真实组装报 failed，缺陷只在下载 300MB 之后才暴露（2026-09-15 alpha 线移植实测：
  `trajectory` 漂 135 行、`llm-deepseek` 漂 369 行）。修法与守卫：
  `node scripts/recount-patches.mjs --dsh-target=<target> --pristine=<未打补丁的包根>`，
  外加预检里那条按 ±20 窗口判定的断言（含可证伪自检）。
  **替代路径**（本机 `spawnSync git` 不可用、或只想动行号而不想补丁被重新规范化时）：
  `node scripts/relocate-patch-hunks.mjs --dsh-target=<target> --pristine=<未打补丁的包根> [--write]`
  ——只改写 `@@` 行、原文逐字节保真、无外部进程。**同一份补丁只用其中一条路径**：
  两者行号结论一致，但产出的补丁不完全相同（重生成会规范化上下文与计数行）。
- **通道之间不会互相污染**：端点按通道各自指向 `updater-<channel>` 滚动 Release，alpha 用户
  不会被判给 rc 的包。tauri updater 取**首个能响应的**端点、**不做跨端点版本比较**——
  这正是不能把两条通道塞进同一个 endpoints 数组的原因。
- **滚动 tag 不得污染 tag 发现路径**（ADR-053）：`updater-rc` 这类非 `v*` tag 会让
  `git describe --tags` 在下个发布周期把上一次的滚动 tag 当成「上一个发布」。
  release.yml 的 `PREV` 取值已加 `--match 'v*'`；`conventional-commits.mjs::latestTag` 本就有。
- **prerelease 标记仍必须从版本号派生**（`verify:release-workflow` 守着）：标记一旦硬编码，
  预发布会被标成正式版并劫持仓库的 Latest 徽标。
- **发布前两条线各自都要有证据**：`smoke.yml` 的 `dsh_target` 输入分别跑一次
  `scope=full`；`verify:patches` 已在 CI 里逐目标检查。若只验默认目标，
  另一条线的补丁可以整目录漏登记而无人发现——而它同样会发布给用户。

> ✅ **首发记录（2026-09-15）**：两条通道同日发出，各自 8/8 release job 绿、19 个资产、
> `prerelease: true`；三平台 CI 与 Smoke `scope=full`（真实资源树 L1 + 打包 + L2 GUI + 故障注入）
> 在 tag 指向的**同一提交**上全绿。
>
> | 版本 | 内置运行时 | 备注 |
> |---|---|---|
> | `v0.5.0-next.1` | DSH `0.1.5-rc.2` | rc.1 → rc.2，14 个补丁全部干净可用 |
> | `v0.6.0-alpha.1` | DSH `0.1.6-alpha.1` | 补丁按语义重做（含行号重算），两处有意差异见 `patches/LAYERS.md` |
> | `v0.6.0-alpha.2` | DSH `0.1.6-alpha.2` | **补丁 14 → 13**（`layout` 按 `retireWhen` 退役、vendored 覆盖包退役）；上游反向采纳了我们的键盘导航修复 |
>
> 实测确认 `releases/latest` 仍指向 `v0.4.0`——**预发布没有污染 stable 更新链路**。
> 首次发布当场抓到并修掉两个真实缺陷（见上文两节事故记录：Windows shell 传参丢值、
> `beforeBuildCommand` 覆盖资源树），两个都只在三平台真跑时才暴露。
>
> **alpha.2 是「上游追上我们」的第一次**：平台化侧栏宽度被上游原生实现（我们那条退役）、
> 键盘导航修复被上游反向采纳。这说明补丁面在收缩——维持这些补丁的成本在下降，
> 而不是无限增长。
>
> 📌 **表里的 `v0.5.0-next.1` 是历史形态，不改写**：2026-09-24 起 `next` 目标的桌面后缀
> 改为 `rc`（因为它发的确实是 rc 阶段的包），此后同一条线发的是 `v0.7.0-rc.1` 之类。
> **这两者是同一个目标**——目标键始终是 `next`（上游 dist-tag 名），变的只是桌面后缀。

> ✅ **发布链路首次全绿（2026-09-23，`v0.7.0-alpha.7`）**：**22 / 22 个资产**、
> `0 个 0 字节`、`prerelease: true`，`release.yml` **9/9 job success**——包含
> `publish CLI + portable artifacts`，而它自 `v0.7.0-alpha.3` 起**一直是 failure 或被 skipped**
> （alpha.3 压根没有 Release，alpha.4/5/6 各只发出 10 个资产）。
>
> | 项 | 结果 |
> |---|---|
> | tag | `v0.7.0-alpha.7` → `55146e1`（注释标签） |
> | CI（`55146e1`） | run `35872317716` ✅ |
> | Smoke `next`（`55146e1`） | run `35872333129` ✅ ——日志里 `DSH_TARGET: next` |
> | Smoke `alpha`（`55146e1`） | run `35872325927` ✅ ——日志里 `DSH_TARGET: alpha` |
> | `release.yml` | run `35874269170`，9/9 job success |
> | 资产 | 9 平台 + `latest.json` + 9 CLI + 3 便携版 = **22** |
> | 体积抽样 | 便携版 zip 207,563,171 B、AppImage 219 MB、deb 150 MB、exe 132 MB |
> | 内置运行时 | DSH `0.1.6-alpha.2`（`alpha` 通道） |
>
> **两条通道各跑一次是这里唯一能证明「两条线都验过」的办法**：两个运行的 job 名与结论
> 完全一样，只有日志里的 `DSH_TARGET` 能区分——差异是**无声**的。

>
> **这一版之前，链路是「修一个红灯 → 暴露下一个从未跑过的红灯」**，共 **六处**
> 被前置失败掩盖的潜伏缺陷（按暴露顺序）：
>
> | # | 缺陷 | 修在 |
> |---|---|---|
> | 1 | `cargo fmt` / clippy 门禁 | `v0.7.0-alpha.4` 准备期 |
> | 2 | 签名私钥缺失（`createUpdaterArtifacts` 让它成为**所有** job 的硬要求） | 同上 |
> | 3 | portable job 的 YAML 用了 `\` 续行却无 `shell: bash`（Windows 默认 PowerShell） | 同上 |
> | 4 | 临时目录清理失败否决主结论（`finally` 里 `rmSync` 的 EACCES 把**通过**判成失败） | `12e7e49` |
> | 5 | 镜像目录的脚本清单**写死**（`ERR_MODULE_NOT_FOUND: remove-tree.mjs`） | `4ab3e2b` |
> | 6 | `Compress-Archive` 在 Windows PowerShell 5.1 下写**反斜杠**条目名，Linux `unzip` 退 1 | `59bd75c` |
>
> 每一处的成因都是同一句话：**改动的代码在上一处红灯修好之前从未被执行过**。
> 因此修完一个红灯**不要**假定下一个也绿。
>
> **残留状态（快照：2026-09-23 清理**收尾完成**；操作口径见 §8.5「发布失败后的 tag 清理」）**：
> `alpha.3` 连 Release 都没建成；`alpha.4` / `alpha.5` / `alpha.6` 各只发出 10 个资产
> （缺 9 CLI + 3 便携版）。五个版本均已由 `alpha.7` 取代。**清理的最终形态**：远端与本机都只剩
> 9 个 tag，**Release 侧 `draft` 数为 0**——`alpha.3` / `alpha.5` / `alpha.6` 无 Release 残留，
> `alpha.1` / `alpha.4` 那份因删 tag 而降级成的未标记草稿也已用 `gh release delete --yes`
> 一并删除（**各自 19 / 10 个资产随之永久丢失，均为批准过的处置**）。
>
> ```bash
> $ gh api "repos/wang-yi-bit64/dsh-desktop/releases?per_page=100" \
>     --jq '.[]|"\(.tag_name) draft=\(.draft) assets=\(.assets|length)"'
> v0.7.0-alpha.7 draft=false assets=22      ← 唯一完整发布
> v0.7.0-alpha.2 draft=false assets=19
> …
> $ gh api ... --jq '[.[]|select(.draft==true)]|length'   # → 0
> ```
>
> ⚠️ **`gh release list` 与 Releases 页都不显示草稿**，所以从页面上看像「已经清干净了」——
> 判断有没有残留**必须**用上面那条 API（带 `draft` 字段），不能看页面，也不能数「页面上有几个 Release」。
>
> ⚠️ **清理只能逐项手动核对，不能用事件流反推**：远端 tag 集合曾在几分钟内由 12 个变成 9 个，
> 而公开的仓库事件流只记到其中**两条**（`alpha.3`、`alpha.6` 的 `DeleteEvent`），
> `alpha.1` / `alpha.4` / `alpha.5` 的删除**一条事件都没有**。所以「事件流里没有」
> **不等于**「没发生过」——它甚至证明不了「这个 tag 曾经存在过」。
>
> ⚠️ **本机 `git tag` 里被删的 tag 全都还在**（**修复前**：本机 14 个 vs 远端 9 个），而它们是
> **注释标签**且指向 main 可达的提交——于是 §8.5 第 5 步那条
> `git push origin main --follow-tags` 会把它们当**新 tag 推回远端**，而推 `v*` tag
> 会**再次触发 `release.yml`**，把刚清掉的残缺 Release 又造回来。当时实测（列表随远端删除
> 进度增长，故那次是 5 个而不是当初的 2 个）：
>
> ```bash
> $ git push --dry-run --follow-tags origin main
>  * [new tag]         v0.7.0-alpha.1 -> v0.7.0-alpha.1
>  * [new tag]         v0.7.0-alpha.3 -> v0.7.0-alpha.3
>  * [new tag]         v0.7.0-alpha.4 -> v0.7.0-alpha.4
>  * [new tag]         v0.7.0-alpha.5 -> v0.7.0-alpha.5
>  * [new tag]         v0.7.0-alpha.6 -> v0.7.0-alpha.6
> ```
>
> 对策：删了远端 tag 之后，**本机同名 tag 要一并删掉**（`git tag -d <tag>`），否则
> 「本地干净」只是假象，会在下一次发布时被 `--follow-tags` 打破。已实测不带 `--follow-tags`
> 的 `git push origin main` 不会上推任何 tag——但那只是绕开症状，本机留着一个远端已删的
> tag，本身就是不一致状态。
>
> ✅ **该对策已于 2026-09-23 执行完毕**：本机与远端 tag 集合一致（9 个），
> `git fetch --prune --prune-tags` + 逐个 `git tag -d` 后，
> `git push --dry-run --follow-tags origin main` 不再列出任何 `[new tag]`。
>
> 📌 **判断远端 tag 现状**用 `gh api repos/wang-yi-bit64/dsh-desktop/tags --jq '.[].name'`
> （读的是 ref，权威）；**不要**用本机 `git tag`，也**不要**信事件流。
> 要看 `--follow-tags` 到底会推哪些，用 `git push --dry-run --follow-tags origin main`——
> 本机 `git push` 会挂在凭据提示上，要加
> `-c credential.helper= -c credential.helper='!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f'`
> （`GH_TOKEN=$(gh auth token)`）。

> ✅ **通道化首发（2026-09-30，`v0.7.1-rc.1`）**：ADR-053 端点通道化后的第一次发布，
> 也是 D1（更新零投递）在 rc 通道的闭环点。三轮发布前门禁都跑在 tag 指向的**同一提交**上。
>
> | 项 | 结果 |
> |---|---|
> | tag | `v0.7.1-rc.1` → `2a0b04c`（注释标签） |
> | CI（`2a0b04c`） | run `36661995358` ✅ |
> | Smoke `next`（`2a0b04c`） | run `36662000823` ✅ ——日志里 `DSH_TARGET: next` |
> | Smoke `alpha`（`2a0b04c`） | run `36662006140` ✅ ——日志里 `DSH_TARGET: alpha` |
> | `release.yml` | run `36663389288`：preflight / 3×build / portable / publish-assets ✅；`updater-channel` ❌（见下） |
> | 资产 | 9 平台 + `latest.json` + 3 便携版 = **13**（`verify:release-assets --check-release` 逐项通过，`prerelease: true`） |
> | 端点 | `updater-rc/latest.json` 实测返回 `0.7.1-rc.1` = 该通道最新 tag ✅ |
> | 内置运行时 | DSH `0.1.5-rc.3`（`next` 目标，rc 后缀） |
>
> **首发抓到的缺陷**：`updater-channel` job 的发布后自检断言**全部在役通道**，而
> `updater-alpha` 滚动 Release 要等 alpha 通道第一次通道化发布才会存在（HTTP 404），
> 于是本次发布被该 job 误判失败——产物本身 13/13 完整。修法（`8205a17`）：
> `--verify` 增加 `--tag` 作用域，发布时只核对本次发布的通道；全通道核对接线进每日
> drift（checkout 同步 `fetch-depth: 0`，否则浅克隆拿不到 tag，判据退化成永远通过）。
>
> **两条诚实边界**：① alpha 通道在它的第一次通道化发布之前仍是零投递（每日 drift
> 对 alpha 报红为预期状态）；② 存量安装不自愈——端点是构建期注入的，`v0.7.1-rc.1`
> 之前的构建仍指向旧端点 `releases/latest/...`（GitHub latest 排除预发布，停在
> `0.5.0-next.1`），修复只覆盖今后新装的构建。

