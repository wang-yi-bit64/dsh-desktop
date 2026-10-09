# 命令速查

> 从 `AGENTS.md` 原 §2「常用命令速查」原样迁入（含 `### 开发与构建`、`### 快速测试与校验门禁`）。
>
> **2026-10-03 起命令面分两层**（治理 G1/G2，见 `docs/dev-plan-defect-remediation.md` §11 的 S4-5）：
>
> | 层 | 在哪 | 说明 |
> |----|------|------|
> | **门禁清单** | `scripts/gate-manifest.mjs` | **唯一产地**：门禁的脚本 / 参数 / 分档 / 「为什么有它」。CI 与 release preflight 都从这里派生，不再手抄。⚠️ 条目数**不在这里写死**——它随增删漂，而这一格没有任何守卫；实时条数与分档步数请跑 `npm run gate -- --list`（`npm run gate -- gates` 会打印汇总行） |
> | **编排器** | `npm run gate`（`scripts/gates.mjs`） | 按分档或按名跑门禁 |
> | **package.json 入口** | 22 条 | 只留给人用的入口（`dev`/`build`/`gate`/`verify:*`/`version:*`/…）。**门禁不再各占一条 script**——此前 62 条里 41 条是门禁入口 |
>
> **旧名仍然可用**（兼容层，不是遗漏）：`npm run gate -- verify:claims`、
> `npm run gate -- claims:self-test`、`npm run gate -- verify:doc-facts --self-test`
> 都能解析。`CHANGELOG.md`、`docs/adr/`、`docs/archive/`、`docs/incidents/` 与计划台账里
> 的历史命令**刻意不改**（它们是当时的记录），需要重放时用上面的旧名形态即可。
>
> 本文件自称**含全部 npm script 名**：`package.json` 的每个 script 都必须在这里以
> `npm run <name>` 的形式出现，这条由 `npm run gate -- doc-facts` 断言
> （2026-10-03 前正是该守卫漏在 CI 之外，才让漏登四个名字的漂移无人发现）。

## 2. 常用命令速查

### 门禁：一个入口 + 一份清单
```bash
# 列出全部门禁与它们各自的分档（清单的唯一产地是 scripts/gate-manifest.mjs）
npm run gate -- --list

# 按分档跑（分档语义见下表）
npm run gate -- --tier=fast        # 等价于 npm run verify:fast（末尾追加 cargo test --tests）
npm run gate -- --tier=full        # fast + doc-test
npm run gate -- --tier=ci          # ci.yml 三平台静态门禁档
npm run gate -- --tier=release     # release.yml preflight 档
npm run gate -- --tier=sentinel    # 联网哨兵（drift / update-channel）

# 按名跑单条门禁（旧名 verify:<name> / <name>:self-test 同样可解析）
npm run gate -- claims
npm run gate -- claims --self-test
npm run gate -- --only=claims,plan-facts,doc-facts

# 只看要跑什么、不真跑
npm run gate -- --tier=ci --dry-run
```

| 分档 | 谁在跑 | 内容 |
|------|--------|------|
| `fast` | 本地 `npm run verify:fast` | 秒级、离线、无需组装产物的门禁（含自检）+ `cargo test --tests`。**2026-10-03 实测 44 步 / 22.4s 温编译**（预算 ≤60s） |
| `full` | 本地 `npm run verify:full` | `fast` + doc-test（44 项 ≥258s，是快反馈的最大单项成本，故分档） |
| `ci` | `ci.yml`（三平台） | 契约 / 壳面 / 补丁 / 发布链路的静态判据 + 打包器自检 |
| `release` | `release.yml` preflight | `ci` 档 + 需要组装树的真检查（`target` / `harness-tree`） |
| `sentinel` | `drift.yml`（每日）| **联网**真检查：上游漂移 / 更新通道。刻意不进 `fast`/`ci`——它们会因**外部状态**红，属哨兵而非快反馈（ADR-030 / S1-3） |

- 平台受限的门禁（`portable-package` 仅 Windows）由编排器**打印 skip 与理由**，不静默略过（§7.1 规则 3）。
- **清单自己的守卫**：`npm run gate -- gates` —— scripts/ 下每个支持 `--self-test` 的脚本都必须在总表里登记或带理由豁免，且每个分档的步数必须 > 0（扫出数为 0 即报错，不打印绿色）。
- **需要额外参数的一次性核验**直接调脚本，不经编排器：
  `node scripts/verify-release-assets.mjs --check-release <tag>`、
  `node scripts/version.mjs check --tag <tag>`、
  `npm run check:patch-applicability -- --pristine=… --target=…`。

### 开发与构建
```bash
# 组装资源并启动 Tauri 开发调试环境
npm run dev

# 构建安装包 / 二进制产物
npm run build
# 或直接调用
npm run tauri build

# 只组装内置运行时资源树（`--check` 仅校验树；`--dsh-target` 选上游通道）
npm run prepare:harness -- --dsh-target=<next|alpha>


# 一站式准备内置运行时（Harness 树 + primary runtime 载荷）——dev/build 默认走这条
#   默认带载荷；DSH_SKIP_PRIMARY_RUNTIME=1 可跳过（跳过则 office skills 保持禁用）
npm run prepare:runtime
DSH_SKIP_PRIMARY_RUNTIME=1 npm run dev

# 组装 primary runtime 载荷（office skills / workspace-dependencies 的门控，CX-17）
#   缺席合法（office skills 保持禁用）；残缺（缺任一项）会让 Harness 起不来，
#   因此构建与 `npm run gate -- primary-runtime` 都拒绝。本仓刻意不写死下载 URL。
# 注意：载荷只含解释器 + office-skills + node + pnpm，不含 numpy/pandas 等 8 个创作库。
npm run prepare:primary-runtime -- \
  --source <已备好 python 解释器的目录> \
  --office-skills <上游 office-skills 目录> \
  --node-source src-tauri/resources/node --pnpm-source <pnpm 目录> \
  --desktop-version "$(node -p 'require("./package.json").version')" \
  --python-version 3.10.22 --node-version 24.19.0 --pnpm-version 11.7.0
# 只检验已落盘的载荷（缺席=合法 / 残缺=红 / 达标=绿）
npm run prepare:primary-runtime -- --check

# 拉取载荷输入（CPython 解释器 + office skills + pnpm）
#   URL / 版本 / sha256 全部钉在 runtime-locks/primary-runtime.json
npm run fetch:primary-runtime -- --self-test                     # 离线自检（不联网）
npm run fetch:primary-runtime -- --target win32-x64              # 源目录 → .desktop-build/primary-runtime/<target>
# 拉完交给组装脚本（它做完整性判定）
npm run prepare:primary-runtime -- --source .desktop-build/primary-runtime/<target> \
  --office-skills .desktop-build/primary-runtime/<target>/office-skills …
# 载荷在 src-tauri/resources/runtime/ 时会被 tauri build 整个打进安装包
# 载荷在 src-tauri/resources/runtime/ 时会被 tauri build 整个打进安装包
```

### 快速测试与校验门禁
```bash
# 0. 门禁分档入口（清单唯一产地 scripts/gate-manifest.mjs；详见上面「门禁」一节）
npm run verify:fast        # = npm run gate -- --tier=fast
npm run verify:full        # = …--tier=full（多 doc-test）
npm run verify:sentinels   # = …--tier=sentinel（两条联网哨兵）
npm run verify:all         # = verify:full + verify:sentinels（发布前一次性核验）

# 1. 快速无头测试门禁（无需 GUI，无需组装资源包 - INV-6）
cargo test -p dsh-contracts -p dsh-host -p dsh-host-cli

# 2. 编译 src-tauri 前生成桩资源（全新 checkout 缺少 resources/ 时必跑）
node scripts/stub-tauri-resources.mjs

# 3. 格式化与 Clippy 静态检查
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings

# 4. 全 Workspace 编译检查
cargo check --workspace

# 5. 补丁分级自检（patches/ 与 patch-layers.mjs 登记表一致性）
npm run gate -- patches

# 6. 壳接口面一致性（命令定义 ↔ 注册 ↔ 前端 invoke/listen ↔ 页面可达性）
#    这是唯一能捕获「写了但没人调用」类断线的门禁——见 §7.3
npm run gate -- ipc-surface
npm run gate -- ipc-surface --self-test

# 6b. 生产路径 unwrap 清零（S4-4，治 D10）：src-tauri/src 与 crates 下每个 crate
#     的 src 生产段（首个 #[cfg(test)] 之前；行注释/块注释/字符串字面量不计）
#     不得出现 .unwrap()——锁中毒曾让 state.rs 15 处 unwrap 成为「一次 panic
#     瘫痪整个壳」的崩溃面。.expect("归因") 是允许形态；无允许清单。
#     含可证伪夹具的自测（修复前的真实形态必须报红）；真检查与自检都在 fast 档
npm run gate -- unwrap-hygiene
npm run gate -- unwrap-hygiene --self-test

# 6c. 组装后的 Harness 依赖树健全性（需先 `prepare:harness`；npm 解包 warn 与误删
#     判据都会**静默**留下缺文件的树，只有启动时才暴露）
npm run gate -- harness-tree

# 7. 壳内页面运行时冒烟（DOM 桩执行内联脚本 + 点一遍所有按钮）
npm run gate -- shell-pages

# 8. Harness 页注入脚本行为自测（19 项断言 + 可证伪性检查）
npm run gate -- harness-inject

# 8b. 插件故障归因模式守卫（F1~F6；夹具逐字抄自 2026-09-22 装机日志）。
#     2026-09-30 前它是零消费者的孤儿守卫；2026-10-03 起真检查进了 fast/ci/release 三档
#     （此前只在本地的快速静态清单里，CI 完全不跑它）
npm run gate -- fault-patterns

# 9. 打包目标守卫（构建主机 vs 目标平台；自动推断，亦可自检）
npm run gate -- target
npm run gate -- target --self-test

# 10. 故障注入（孤儿进程清理 + 退出码归因，10 项断言）
#    前置：cargo build -p dsh-host-cli
npm run fault-inject

# 11. 分层烟雾（L1 无头硬门禁；L2 需已构建产物，缺失则 SKIP）
npm run smoke:headless
npm run smoke

# 12. 产物体积三口径（壳二进制 / 安装包 / 资源树）
npm run size:report

# 13. 版本号一致性（package.json 唯一真源 ↔ tauri.conf.json ↔ Cargo.toml；
#     tag 构建时额外校验 tag 与版本号匹配）——发布前的关键防线
npm run gate -- version
# 本地查看各处版本、最近 tag、以及「上个 tag 以来的提交建议升哪一位」
npm run version:show

# 14. 变更日志/版本推进生成器自测（纯逻辑，无 git 依赖）
npm run gate -- commits
npm run gate -- changelog

# 15. 依赖树瘦身自测（删目录判据是「内容」不是「名字」，含可证伪性检查）
npm run gate -- prune

# 16. 原生平台变体剪枝自测（删 musl / 非目标架构 prebuilds；
#     Linux AppImage 打包的必要前置——见「linuxdeploy 撞上外来变体」一节）
npm run gate -- variants

# 17. 发布工作流守卫（tauri-action 参数拼装 + shell 变量终止；含自测）
#     守两类「只有真跑 release 才炸」的缺陷——见「发布工作流的两个静默缺陷」一节
npm run gate -- release-workflow
npm run gate -- release-workflow --self-test

# 17b. 发布资产清单守卫（期望 13 项，按名字逐一枚举；含自测）
#      F13 的真守卫：此前「13」只活在文档里，全仓零判据 ⇒ 实际产出 10 而门禁全绿。
#      另可核对真实 Release（需参数，直接调脚本）：
#        node scripts/verify-release-assets.mjs --check-release <tag>
npm run gate -- release-assets
npm run gate -- release-assets --self-test

# 18. 官方 profile 保留名守卫（`desktop` 大小写变体）+ 契约锚点；含自测
npm run gate -- profile-names
npm run gate -- profile-names --self-test

# 19. 宣称纪律守卫（README ↔ AGENTS：禁止表述 / 状态词表 / §7.2 欠债登记）；含自测
npm run gate -- claims
npm run gate -- claims --self-test

# 19b. 计划事实守卫（文档里的「钉住的 DSH 版本」必须等于锚点；
#      计划文档的批次状态词在「头部摘要 / §5 标题 / §10.1 表行」三处必须自洽）；含自测
npm run gate -- plan-facts
npm run gate -- plan-facts --self-test

# 19c. 文档↔常量派生事实对账（S2-3）：rust-version / .nvmrc / license 三处 /
#      ADR 计数——文档是被测方，常量是产地；含真实漂移夹具的自测
npm run gate -- doc-facts
npm run gate -- doc-facts --self-test

# 20. 上游版本漂移哨兵（基准 = **上游最新 GitHub Release**；2026-10-09 / 计划 2f 由
#      npm dist-tag 换过来。真检查会因上游领先而红，跑在 nightly；CI 只跑自测。
#      npm dist-tag 仍打印但只作参考；slug 404 判红（配置缺陷），离线才 SKIP）
npm run gate -- drift
npm run gate -- drift --self-test

# 20i. 上游**发布面**（GitHub Release）取用判据自检：tag 形态 `dsh-v<x.y.z>`（不是 `v<x>`）、
#      四态取数（ok/empty/skip/error）、commit 必须经 commits 端点解析
#      （`target_commitish` 实测多是分支名 `master`）。真检查要联网，故只登记自检；
#      排障时可直跑：node scripts/upstream-release.mjs
#      ⚠️ 本项 2026-10-09 由 `20g` 改号为 `20i`：`20g` 已被同文件的「.github 配置准入」
#         （commit 1b9a323）占用，2f 那次新增时重号了——编号重复会让「§20x」失去指代力。
npm run gate -- upstream-release

# 20b. 双上游通道：目标表自检（目标键 ↔ 目录 ↔ 上游锚点 ↔ 桌面后缀；未知通道必须失败不得回退）。
#      2e（2026-10-09）起本表**只**拥有目标表：桌面合成号与「上游精确版本 → patchTarget + n」
#      归台账（harness-locks/dsh-releases.json + scripts/release-ledger.mjs 的 resolveReleaseFor）。
#      字段 `channel` 已改名 `upstreamDistTag`（仅用于发现）；桌面通道由版本后缀推
#      （desktopChannelForVersion）。自测成对钉「通道不可挪位」：0.2-rc.3 判红 / 0.2.0-rc.3 判绿
npm run gate -- targets

# 20h. MANIFEST v3 身份块合成自测（计划 2g，2026-10-09）：upstreamDsh / desktopVersion /
#      release / desktop / runtime / changelogPointers 六块的形状。
#      ⚠️ 它必须是**纯逻辑**模块（scripts/manifest-v3.mjs）：写入点 prepare-harness.mjs
#      在模块顶层就跑整趟组装，本机跑不起来 ⇒ 逻辑留在那里等于「形状自测只能靠一次
#      真实组装触发」= 没有守卫。
#      判据三条：① 上游身份**只认台账键**（桌面号与上游号同构，反推会得到假值；序号同理，
#      无台账背书时 seq 落 null 而不是照抄 splitRepoSequence）；② 无产地字段一律 null +
#      unresolvedFields[] 逐条记因，不得编造（AGENTS.md §7.1 规则 2/3）；③ tag 与版本号
#      不符属**矛盾**（判红），字段缺失属**如实**（放行）——两者不得混成一个出口。
npm run gate -- manifest-v3

# 20c. 提交式 lockfile 纯逻辑自检（inputs 一致性三规则 + 家族钉死推导 +
#      闭包字段抽取 + 安装位置推导）
npm run gate -- harness-lockfile

# 20d. 重新生成某目标的提交式 lockfile（版本锚点/补丁集/vendored 变更后必跑；
#      需联网——先直连 registry 并发算家族传递闭包，再 npm install --package-lock-only；
#      产出 harness-locks/<target>/ 下 package-lock.json + inputs.json，两者必须成对提交）
npm run harness:lockfile -- --dsh-target=<next|alpha>

# 20e. 临时目录清理判据自测（三级降级 / 永不抛错 / 不跟随符号链接）
npm run gate -- remove-tree

# 20f. 更新通道（ADR-053）：纯逻辑自检（含可证伪夹具）+ 真检查
#      真检查核对「端点 version ≥ 该通道最新 tag」——它正是 2026-09-15~09-30 零投递的判据
npm run gate -- update-channel --self-test
npm run gate -- update-channel

# 20g. .github 配置准入（ADR-054）：工作流必须在 workflows/ 下；第三方 action 必须钉 40 位 SHA
#      2026-10-09 增规则 F：`dependabot.yml` 声明的目录必须真有清单文件——目录里没有清单时
#      Dependabot 在**取文件阶段**就失败（实测 job 1618552559：
#      `Error during file fetching; aborting: /harness-locks/alpha/package.json not found`），
#      而失败原因写在远端、仓库内没有任何东西会变红。判据**先剥整行注释**再扫。
npm run gate -- github-config
npm run gate -- github-config --self-test

# 20j. Dependabot 安全更新开关（**联网**；2026-10-09 裁定：必须保持关闭）——**前提面**
#      开关住在仓库设置里，打开/关闭都不改变任何产物 ⇒ 本地静态扫描永远看不见它被重新打开；
#      它一打开，每条落在 harness-locks/ 快照目录的告警都会派生一个必然失败的 job。
#      两个来源并读、**危险优先**取并集：
#        · GET /repos/{owner}/{repo}/automated-security-fixes（规格原文：需要 **admin 读**）
#        · 仓库对象的 security_and_analysis（需要 **push 身份**；两者权限要求不同）
#      出口：至少一路说 disabled 且无人说 enabled ⇒ 绿；任一来源说 enabled ⇒ 红（两来源矛盾时
#      以危险为准并明写「矛盾」）；slug 404 ⇒ 红（配置缺陷）；其余（形态不认识 / 都看不见 /
#      取数失败）先落 skip，**再由下面的令牌纪律收口**。
#      🔴 令牌纪律：**提供了令牌时，skip 不成立**（除暂时性失败外）—— 收口在 `applyTokenStrictness()`。
#        · GH_TOKEN 为空 ⇒ skip（环境问题；CI 那侧由 job 的前置步显式判红，不退化成「未核对」）；
#        · 配了令牌、失败**全属暂时性**（429 / 限流 / 5xx / 网络，**含文字形态** —— 实测
#          `GH_HOST=<不存在>` 时 gh 只给 `Bad Gateway`，**一个数字都没有**）⇒ skip，下次自愈；
#        · 配了令牌、**其余一切** ⇒ 红：401/403、响应形态漂移、以及「两路都 200 却都看不见」。
#      收口的判据：**配上正确权限的令牌后，至少有一路必然可读**（实测 owner 令牌两路都读到
#      `disabled`）⇒ 一路证据都拿不到就不是环境问题，是有明确修法的缺陷。
#      ⇒ 于是 CI 里这台 job **只有红与绿两种结果**，绿的含义唯一：真核对过，且开关是关的。
#      ⚠️ 令牌来源是仓库 secret `DSH_REPO_ADMIN_TOKEN`（细粒度 PAT，Administration: Read）。
#         **不能**用 GITHUB_TOKEN：两个来源都要求更强身份（Actions 的 permissions 里根本没有
#         administration 这一项），实测三次只给 contents: read / 再加 security-events: read
#         都一样看不见。secret 缺失时由 drift.yml 的前置步判红，不退化成「未核对」。
#      ⚠️ 本条在总表里带 `echoOutput: true`：编排器默认**只在失败时**回显脚本输出，于是
#         「已核对」与「skip 未核对」都是 ✅，日志里分不出来——那正是本仓最怕的假绿。
npm run gate -- dependabot-setting --self-test
npm run gate -- dependabot-setting

# 20k. Dependabot 更新 job 的**目标目录范围**（**联网**）——**症状面**（D13）
#      断言：基线之后不存在「目标目录未被 .github/dependabot.yml 声明」的 Dependabot 更新 job。
#      dependabot.yml 的 directory **只**约束版本更新，安全更新按**告警的 manifest_path** 开 job、
#      不读该文件 ⇒ 目标目录超出声明范围就是开关被打开的**直接函数**（本仓只声明 `/`，而历史
#      全部 11 个 job 的目标都是 /harness-locks/* 或 /src-tauri，根目录一个都没有）。
#      ⚠️ 这条**不需要** PAT，正是它与 20j 并存的意义：它读 Actions **运行记录**，
#         GITHUB_TOKEN 的 `actions: read` 就够（公开仓库连匿名都可读，实测 http=200）。
#         跑在 drift.yml 的独立 job 里。两条互补：20j 抓**前提**（即时，依赖令牌），
#         20k 抓**后果**（滞后，但零 secret、全自动）。
#      ⚠️ 窗口左端取**固定基线**（脚本内的 SCOPE_BASELINE_ISO）而不是「最近 N 天」：关闭当天的
#         历史 job 会落在滚动窗口里，让目标状态常驻红灯（ADR-030）。代价是补救（重新关闭开关）
#         之后要把基线前移到补救时刻 —— 那是**显式记账**，不是可省的步骤。
#      ⚠️ 「job 名解不出目录」**判红**（判据失效＝我们这边的缺陷，有明确修法），与「取不到」
#         （环境问题，skip 并明写「未核对」）**分开** —— 同 drift 的 slug 404 裁定。
#      三出口：窗口内 job 全落在声明目录内（含 0 个）⇒ 绿；落在未声明目录 / 名字解不出 /
#      声明集合为空 / run 清单没扫完 ⇒ 红；取不到 Actions 数据 ⇒ skip。
npm run gate -- dependabot-scope --self-test
npm run gate -- dependabot-scope

# 21. 补丁健康度报告（层 / 退役条件 ↔ MANIFEST 实际结果；报告，非门禁）
#     默认按 MANIFEST 里记录的 target 取补丁表，也可 --dsh-target=<name> 指定
npm run report:patches

# 22. 上游升级预检：补丁在新版本上的适用性（~4MB，不必组装 300MB）
#     `--dsh-target` 选**哪一套补丁**，`--target` 是**待检的上游版本**，两者不同
npm run check:patch-applicability -- --dsh-target=next --target=0.2.0-rc.2

# 22a. 三路合并移植补丁（2026-09-30 新增）：merge 产出「新版纯净 ↔ 已解决」两棵树与
#      冲突清单，人工逐条解冲突后 regen 重新生成补丁。冲突必须人判语义——
#      它只保证文本合并与行号正确，判据是 patches/LAYERS.md 的 why/retireWhen
node scripts/merge-migrate-patches.mjs merge --dsh-target=next --to=<新版本> --out=<工作目录>
node scripts/merge-migrate-patches.mjs regen --dsh-target=next --to=<新版本> --out=<工作目录> --write

# 22b. 移植补丁后**重算行号**（patch-package 按行号定位，偏移超 ±20 行即失败；
#      只按内容搜索的预检会漏报这类失败，真实组装才炸——见 §8.6）
#      ⚠️ 默认 --pristine 是 harness-deps/<target>-pristine，**目标键、不带版本**，
#      目录名证明不了里面是哪一版；换锚点后请显式指定带版本的目录，
#      或改用 relocate-patch-hunks.mjs（它有版本判据，本脚本没有）。
node scripts/recount-patches.mjs --dsh-target=<next|alpha> --pristine=<未打补丁的包根>

# 22c. 行号重算的**另一条路径**（只改 `@@` 行、原文保真、无外部进程）：与 22b 的
#      recount-patches **二选一**——同一份补丁只用一条路径（见 AGENTS §7.2）
npm run gate -- relocate-hunks          # 该工具的自检
node scripts/relocate-patch-hunks.mjs --dsh-target=<next|alpha> --pristine=<纯净包根> [--write]

# 23. 壳入口 ↔ 上游 CLI 调用约定 + macOS 父死看门狗 + **打包资源清单推导**（含自测）
#     守三类静默失效：上游改自执行方式、看门狗装错进程/unref、
#     入口依赖的模块或 Rust 资源常量漏登记进 bundle.resources
#     （漏登记的后果只有安装包坏：本地目录齐全、门禁全绿——见 §4）
npm run gate -- harness-entry
npm run gate -- harness-entry --self-test

# 24. CLI 打包能力：打包 / 命名 / sha256 边车 / 回读校验 / 产物执行自检（含自测）
#     产物名由 package.json + 目标三元组推导；归档解包回读并真的执行一次
#     ⚠️ 2026-09-24 起这是**本地能力**，不再有 Release 上传通道（见 §8.4）
npm run gate -- cli-package
#     便携版同一条链路（命名 / 边车 / 「解 zip 按平台选命令」）。真打包与可伪证
#     夹具依赖 PowerShell，故本步只在本机为 Windows 时有意义
npm run gate -- portable-package
#     真打一份产物（先 cargo build --release -p dsh-host-cli）
npm run package:cli -- --bin target/release/dsh-host-cli --out dist/cli
#     核验下载回来的那份（manifest 由打包步骤落盘；上传通道退役后用于人工分发核对）
npm run package:cli -- --verify-download dist/cli --manifest dist/cli/<base>.manifest.json

# 25. 🗄️ 已归档（2026-09-24）：cli-publish 发布步骤的原文演练
#     scripts/dry-run-cli-publish.mjs → docs/archive/dry-run-cli-publish.mjs
#     归档理由：上传通道退役后它失去唯一标的（它 100% 服务于「上传步骤正确性」）。
#     文件头写明恢复清单（四处一起做）。**不要再从 scripts/ 里找它。**
#     注：它验证过的两条经验仍然有效，恢复时不必重踩：
#       · 手抄一份实现去验收，验的是抄件而非真正发布的那段；
#       · 豁免判据不得锚在散文上，必须锚在机器可读标记（missing-artifact-class:）上。

# 26. 推进版本号（dry-run 先看，再真改）
npm run version:show                       # 显示真源与跟随处、最近 tag
npm run version:show -- --explain          # 解释合成号（上游身份取自台账索引键）
npm run version:set  -- 0.2.0              # 直接指定（非发布场景）
npm run version:bump -- auto --dry-run     # 依提交历史判定升 major/minor/patch
npm run version:bump -- minor --commit --tag   # 改文件 + 提交 + 打本地 tag（不推送）

# 26b. **合成号发布主路径**（ADR-061；序号 n 只能由台账推导）
npm run version:sync-upstream -- --plan     # 只读：打印将写的文件与委托步骤（--plan 是默认）
npm run version:sync-upstream -- --apply    # 显式写：快照 → 台账 + 版本真源 → 跑守卫 → 失败回滚
npm run version:verify-upstream             # 只核上游可信性（不推 n、不写盘；= 前门 --no-counter）
#     步骤①②（上游 Release / commit）**缺省即真检查**（slug 唯一产地 scripts/upstream-release.mjs）；
#     离线时可显式关闭，但必须说出来：node scripts/sync-upstream-release.mjs --plan --no-upstream-release

# 26c. Release Plan（第 3 步的人工决策面）：release-manifest.json
#      它与 MANIFEST.json **不是一回事**：那份是发布**证明**（产物里的事实），这份是发布**计划**。
#      它只答两件事：这一次发哪几条线；每条线是第几次交付（n）。
#      它**不**答：合成号（第 4 步从台账派生）、上游精确版本（台账的键）、通道（由 patchTarget 现算）。
node scripts/release-ledger.mjs --show                    # 台账 + 桥接版 + 计划（两边是否一致一眼可见）
node scripts/release-ledger.mjs --validate                # 门禁档：恒时判据（结构/目标/在役键唯一/字段白名单/w）
node scripts/release-ledger.mjs --validate --strict-plan  # 额外跑时点判据（n == 台账现算的下一个）
npm run version:sync-upstream -- --plan                   # 发布前门：读计划，未批准的线**不派生**
npm run gate -- release-ledger                            # 上述 --validate 的门禁入口（fast/ci/release 全档）
#     ⚠️ 判据刻意分两组，**不要**把时点判据塞进每次 PR 都跑的门禁：
#        · **恒时**（结构 / 目标 / 在役键唯一 / 字段白名单 / w 字符集）——永远为真，进全档门禁；
#        · **时点**（n 逐字等于台账现算的下一个）——**只在决策时刻成立**。计划是时点快照：
#          发出去之后台账 next n 前进一格，n 立刻成为历史值。把它放进全档门禁只会得到两种收场：
#          每个与发布无关的 PR 都要顺手改一个 n（人会开始乱改），或者有人把判据删掉。
#          故它去**有意义的地方**：发布前门 + --strict-plan。
#        · 完整理由见 scripts/release-ledger.mjs::diagnoseReleasePlan() 的 boxed 段；
#          自测里有一对「同一份输入、两种意图、相反结论」的夹具钉住这个分工。
#     ⚠️ 计划**不是**版本号的产地：它写的是决策（发哪条线、第几次），派生仍由台账现算。
#        两者不一致时以**台账**为准，改计划（n 不由人填）。

# 27. 变更日志（产物入库 / 供 Release 正文使用）
npm run changelog:write -- --version 0.2.0     # 写入 CHANGELOG.md
npm run changelog:notes                        # 打印上个 tag..HEAD 的 Release 正文
```

集成测试（`crates/dsh-host/tests/`）会真实派生 Node 进程运行 `scripts/mock-harness.mjs`，需要 `PATH` 上有 Node.js（可用 `DSH_TEST_NODE` 指定）；找不到时测试自行跳过而非失败。故障模式经 `mock-harness.mjs` 的 argv / 环境变量注入，不在 Rust 侧打桩。

