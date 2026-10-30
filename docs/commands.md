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

# 20. 上游版本漂移哨兵（判定基准 = **各目标自己那条线**的上游 npm dist-tag；2026-10-10 裁决
#      恢复「按线判定」，取代 2f 的「全局最新 Release」——那次换基准让 next 拿 alpha 线的版本
#      判自己落后。真检查会因该线领先而红，跑在 nightly；CI 只跑自测。
#      上游 GitHub Release 保留为**信息层**（打印 + stable 线叫号），不参与判定；
#      线名在响应里不存在 ⇒ 判红（upstreamDistTag 是本仓常量），信息层 slug 404 ⇒ 判红，取不到才 SKIP）
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
#      全部 12 个 job 的目标都是 /harness-locks/* 或 /src-tauri，根目录一个都没有）。
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

# 28. **本地** AI 代码评审（Gito CLI；ADR-065）——不进 CI、无仓库外服务
#     定位：推之前自己先审一遍。它与 `.github/workflows/` 下的任何工作流**无关**，
#     本仓刻意没有为它接线 `pull_request`（理由见 ADR-065「备选方案」）。
#
#     ⚠️ 为什么**不是** npm script：本工具是 Python 包（`gito.bot`，元数据要求
#        `python >=3.11,<4.0`），且需要**每台机器各自的** venv 路径与一把模型 key。
#        塞进 package.json 会让它看起来像一条「检出即可用」的仓库能力，而它其实依赖
#        本机环境与凭据——那正是本仓 §7.1 规则 1 要防的形态（把未接线的东西呈现成可用能力）。
#
#     前置：Python 3.11~3.13 + git。按本机隔离纪律装进托管 venv。
#     🔴 **本机必须先做这一步，否则 pip 静默卡死**：本机 `rustc` 由 mise shim 提供（启动 2.47s），
#        而 pip 每条安装/下载命令都会去探它（`network/session.py:179-192`，`timeout=0.5`）
#        ⇒ 必然超时 ⇒ Windows 的超时清理路径死锁。**先把 mise shims 从 PATH 摘掉**
#        （不要整体替换 PATH——那会连带干掉 Git Bash 的 coreutils）：
#          export PATH="${PATH//\/c\/Users\/Administrator\/AppData\/Local\/mise\/shims:/}"
#        真因、15 行最小复现与「同命令红→绿」见文末「已登记的本机异常 ②」与 ADR-065 同节。
C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\pip install -v gito.bot
#     等价形态（无需自建 venv）：uvx gito.bot review
#     ⚠️ 本机**没装** uv / uvx / pipx ⇒ 上面这条**当前不可执行**；要用得先自行装 uv。
#     ✅ 本机现状（2026-10-15）：已装成 `gito.bot-4.5.0` + 110 个依赖（exit 0，3m45s），
#        `Scripts/gito.exe` 与 `Scripts/gito.bot.exe` 均在位，`gito --help` 已实跑通过。
#
#     ── 跑起来的最短顺序（①② 都**不需要模型 key**，③ 才消耗额度）────────────────────
#       ① gito setup                        # 生成 ~/.gito/.env（每台机器只做一次）
#       ② gito files                        # 零 LLM：打印「本次会审哪些文件」
#       ③ gito review --out .workbuddy/tmp   # 真评审
#     ⚠️ `gito -v` 是 **gito 自己的详细度**（0-3，`--verbosity`），与 pip 的 `-v` 毫无关系。
#     ⚠️ `gito files`/`gito review` 都必须在**仓库根**里跑（它按 cwd 解析 `.gito/config.toml`）。
#
#     凭据（**机器本地，绝不入库**）：`~/.gito/.env`。两种生成方式：
#       · 交互式向导；· 手写（本机采用，见下）
C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\gito setup
#     🔴 **凭据落点有两处，只有一处是对的**，而错的那处此前**没有任何东西拦着**：
#        · 对：`~/.gito/.env`（仓库外）——`constants.py:13` 只认这个路径；
#        · 错：`<repo>/.gito/.env`——**Gito 永远不会读它**（`bootstrap.py:71` 把路径**显式**
#          传给 `load_dotenv`，不在 cwd 搜 `.env`），但本仓的 `.gito/` 是**入库目录**
#          ⇒ 一次误跑的 `gito setup` + 一次 `git add .gito/` = **明文密钥入库**。
#        ⇒ 已加**嵌套 `.gito/.gitignore`**（只有一条规则 `.env`，位于该文件第 23 行）拦住它。为什么不用根 `.gitignore`：
#          根那份在 HEAD 里是 **CRLF blob**，编辑器把整份文件重写成 LF 时会带出 50 行纯 EOL 差异（见下方仓库异常②）；
#          嵌套 .gitignore 是**新文件、纯 LF** ⇒ 同一个保护，改动面 0 行噪音。
#        ✅ 取证（成对）：`git check-ignore -v .gito/.env` ⇒ `.gito/.gitignore:23:.env`（exit 0）；
#          真实写一个含哨兵值的 `.gito/.env` 后 `git status --untracked-files=all` **不列它**，
#          而 `config.toml` 仍被列出（**保护没过度**）；**反向对照**：把该 .gitignore 移开 ⇒
#          `?? .gito/.env` **立刻出现** ⇒ 证明起效的就是它（不是别的全局规则）。
#
#     ✅ **本机实际配置（2026-10-15 生成，已实测打通）**——来源是本机 DSH 用户层
#        `%APPDATA%\io.dsh.desktop\harness\profiles\web\cordis.patch.yml` 的 `stepfun`
#        provider（`displayName: 跃阶星辰`）。字段逐一对应：
#
#          DSH 字段                              →  gito / ai-microcore 字段
#          apiKeyEnv: STEPFUN_API_KEY            →  LLM_API_KEY
#          api: openai-completions               →  LLM_API_TYPE=openai
#          baseURL: https://api.stepfun.com/step_plan/v1
#                                                →  LLM_API_BASE（同值）
#          models[].id                           →  MODEL
#
#        落盘内容（`~/.gito/.env`；**值只在本机，不要抄进仓库**）：
#          LLM_API_TYPE=openai
#          LLM_API_KEY=<STEPFUN_API_KEY>
#          LLM_API_BASE=https://api.stepfun.com/step_plan/v1
#          MODEL=step-5-preview
#          MAX_CONCURRENT_TASKS=2
#          （`=2` 是**实测选定值**，不是随手写的；推导见下面四条事实）
#
#        🔴 `MAX_CONCURRENT_TASKS` **必须按订阅的并发上限压下来**，否则**不是「慢」，
#        是「静默少审文件」**。四个实测事实：
#          ① 订阅上限 = **5 并发**。两个独立来源一致：**订阅持有者 2026-10-15 确认**；
#             定标实测亦为 5——关掉 SDK 自带重试后并发打 N 个最小请求，
#             N=1..5 全成功、N=6 恰好 1 个 429 ⇒ 可用坑位 5。
#             🔴 **因此 `MAX_CONCURRENT_TASKS` 不能填 5**：见③，填 5 会让实际在飞达到 7。
#          ② 库默认 `constants.py: DEFAULT_MAX_CONCURRENT_TASKS = 40` ⇒ **不设必炸**。
#          ③ **gito 的实际在飞请求会超过这个设定值**：设为 4 时服务端**恒定**报
#             `current: 6, limit: 5`（45 次采样全是 6），即 gito 侧多出约 2 个在飞请求。
#             ⚠️ **根因未定，不猜**：`run_parallel` 的 `asyncio.Semaphore` 写法本身是对的
#             （`microcore/utils.py:441`，`async with` 包住整个 task 含内部重试）；
#             已**排除**「DSH 桌面端在占坑」（复核时该进程对外连接数为 0）。
#             ⇒ 按「设定值 + 2」留余量，取 **2**（**已验证 0 跳过**）。
#        🔴 **代价不是变慢，是覆盖率静默缩水**（这条比上面更值得记）——同一份 diff 的成对对照：
#
#            MAX_CONCURRENT_TASKS │ 429 次数 │ 被跳过 │ processing_warnings │ 真审文件 │ total_issues
#            ─────────────────────┼──────────┼────────┼─────────────────────┼──────────┼─────────────
#                    4             │   132    │ 11/15  │         11          │    4     │      3
#                    2             │    **0** │  **0** │         **0**       │  **15**  │    **10**
#
#          ⇒ 那场 429 风暴里，报告抬头写的是 `**⚠️ 3 issues found** across 15 files`、
#            JSON 里 `number_of_processed_files: 15`、**exit 0** —— 三处都看不出问题，
#            **而它藏掉了 7 条真问题（占全部发现的 70%）**。
#          ⇒ 判据只能这样下：**`number_of_processed_files` 数的是 diff 里的文件数、不是真审过的
#            文件数；`exit 0` 也不代表全审过。脚本化调用必须读 `processing_warnings`。**
#            （本仓 AGENTS.md §7.1/§7.2 治的正是这个形态：绿了但没验。）
#          ⚠️ 全量覆盖的真实代价：15 个文件、并发 2、模型 `step-5-preview`，实测 **18 分 12 秒**。
#            想快就在 `-f` 上限定文件集（见下），不要靠加并发——加了就回到上面那行的假绿。
#
#        ⚠️ 为什么 `LLM_API_TYPE` 写 `openai` 而不是某种 stepfun 专用取值：microcore 的
#        `ApiType` 枚举里**没有** stepfun；官方注释原文「To use services that are not
#        listed in `ApiType`, but provides OpenAI interface, use `ApiType.OPENAI`」——
#        跃阶星辰正属此类（`step_plan/v1` 是 OpenAI Chat Completions 兼容端点）。
#
#        ✅ **实测（2026-10-15，真实调用，非夹具）**：`step-5-preview` 返回 `'OK'` ⇒
#        「端点 + 模型名被 ai-microcore 接受」这一条**已闭合**（原 ADR-065 未闭合项 ②）。
#        ⚠️ `step-3.7-flash` 是 **reasoning 模型**：先吐 `reasoning_content` 再吐 `content`。
#        实测 `max_tokens=32` ⇒ `finish_reason=length` 且 **`content` 为空串**；
#        给到 512 ⇒ `content='OK'`。**空串对评审工具就是静默假绿**（会被读成「0 issues」），
#        所以**别给这个模型配小输出预算**。好消息：gito 评审路径 `mc.llm_parallel(...)`
#        不传 `max_tokens`（core.py:496）⇒ 走服务端默认，当前路径安全。
#        ⚠️ reasoning 强度**在本仓改不了**：microcore 只在 `azure_responses` 后端读
#        `reasoning_effort`，`openai` 后端不传该参数 ⇒ 沿用服务端默认；DSH 里写的
#        `defaultEffort: high` 只对 DSH 生效，gito 这边拿不到。
#        开关 `SHOW_THINKING`（默认 false）决定是否把思考内容包进 `<think>`——评审要的是
#        纯 JSON，**保持默认关闭**。
#        切模型只改一行：`MODEL=step-3.7-flash`（上下文 262144，快而便宜）或
#        `step-5-preview`（上下文 1024000，旗舰、带推理，本机默认选它）。
#
#     评审配置（**入库**，唯一产地 `.gito/config.toml`）：
#       · `exclude_files` —— A 组真实命中 86 个已跟踪文件（`vendor/**/lib/**` 占 80），
#         B 组是纵深防御（实测 0 命中，被 ignore 的目录，正常 diff 看不到）；
#       · `[prompt_vars].requirements` —— 本仓判据进入模型的**唯一**通道。
#     🔴 **不要加 `aux_files`**：它在 `gito review` 路径上**不生效**（源码级证据见
#        `.gito/config.toml` 文件头与 ADR-065），加它只会让人以为判据已经喂进去了。
#     核对「配置真的生效」——**下面三步都不需要模型 key**（前两步任意 shell 可跑，末步需装好 gito）：
C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe -c "import tomllib,pathlib;print(sorted(tomllib.loads(pathlib.Path('.gito/config.toml').read_text(encoding='utf-8'))))"
#       ↑ 应打印 ['exclude_files', 'prompt_vars']；出现 'aux_files' 即说明配置被退回旧写法
C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe -c "import tomllib,pathlib;d=tomllib.loads(pathlib.Path('.gito/config.toml').read_text(encoding='utf-8'));print(len(d['exclude_files']), sorted(d['prompt_vars']))"
#       ↑ 应打印 20 ['awards', 'requirements']
C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\gito files
#       ↑ 零 LLM、免 key，打印「本次会审哪些文件」——**这才是验 `exclude_files` 的正解**
#     🔴 **`gito review --help` 不是免 key 步骤**（本轮实测更正）：`review` 的**任何**形态
#        （`--help` / `-h` / `help review` / 裸 `review`）都在打印帮助**之前**先校验凭据，
#        无 key 时一律 **rc=2** + `LLM configuration error: LLM_API_KEY is absent.`。
#        只有顶层 `gito --help` 免 key（已实测通过）。
#     真评审——⚠️ **一律带上 `--out .workbuddy/tmp`**（**需要 key**，先跑 `gito setup`）：
C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\gito review --out .workbuddy/tmp
#     为什么：报告默认写在**仓库根**（`out_folder` 缺省 = `repo.working_tree_dir`，core.py:553），
#     而那两个文件（`code-review-report.md` / `.json`）**没有被 .gitignore 覆盖** ⇒ 会在
#     `git status` 里常驻成未跟踪文件，稍不留意就被 commit 进去。`.workbuddy/` 早在
#     `.gitignore:28` 被忽略，把报告导进去等于**不新增任何 ignore 规则**就解决这件事。
#     （本仓刻意**没有**为这两个文件改 .gitignore：那个文件在 HEAD 里的 blob 是 CRLF，
#      其余文件都是 LF，编辑器把整份文件重写成 LF 时会带出 **50 行**纯 EOL 差异（原地保留 CRLF 追加 = 零噪音）
#      ——见下面「已登记的仓库异常」。用 `--out` 绕开比修那行更划算。）
#
#     ⚡ **要快就用过滤器收窄文件集——这是本工具**唯一**安全的提速手段**（别加并发，见上）。
#     🔴 **但在 Windows 上必须用 `--filter=模式` 的「单 token 带 `=`」形态**，不能用 `-f 模式`：
C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\gito review --out .workbuddy/tmp --filter=scripts/**
#     🔴 为什么——**Click 会在 Windows 上把整个 argv 做 glob 展开**（不是 gito，也不是 bash）：
#        `click/core.py:1535-1539`，取 `sys.argv` 时若 `os.name == "nt" and windows_expand_args`
#        （默认 True）就调 `_expand_args()`；而 `_expand_args`（`click/utils.py:649-666`）对**每个**
#        token 依次做 `expanduser` → `expandvars` → `glob.glob(token, recursive=True)`，
#        **命中就替换成匹配到的真实路径列表，不命中才保留字面量**。
#        ⇒ `-f 'scripts/**'` 的**值**在 gito 看到之前就被换成 54 个 `scripts\*.mjs` 路径，
#          于是 `-f` 只吃掉第一个、其余全变成多余位置参数 ⇒ **exit 2**
#          + `Got unexpected extra arguments (scripts\changelog.mjs ...)`。
#        ⇒ `--filter=scripts/**` 是一个**整体 token**，`glob.glob('--filter=scripts/**')` 匹配不到
#          任何路径 ⇒ 原样保留 ⇒ gito 才真的拿到这个模式。
#     ✅ **红→绿成对取证**（同命令、同树、**只差走不走 argv 展开**，据此排除「模式本身写错」）：
#          gito files -f 'scripts/**'                       → exit 2（Got unexpected extra arguments）
#          python -c "...from gito.cli import app; app(sys.argv[1:])" files -f 'scripts/**'
#                                                          → exit 0（filtered by scripts/** --> 2 file(s)）
#        后者把 args **显式**传给 Click ⇒ 走 `args is not None` 分支 ⇒ 跳过展开 ⇒ 模式生效。
#     ⚠️ 另外三个由此派生的坑：
#       · **短选项带 `=` 是坏的**：`-f=scripts/**` 传给 gito 的值是 `=scripts/**`（含那个 `=`），
#         实测 `filtered by =scripts/** --> 0 file(s)` ⇒ 短形式只能分开传，而分开传又被展开
#         ⇒ **本机用过滤器只能写 `--filter=` / `--filters=`**（长名）。
#       · **任何 argv token 里的 `$VAR` 与 `~` 也会被展开**（`expandvars` / `expanduser`）——
#         路径里带 `$` 或 `~` 的参数在本机会被改写，POSIX 上不会。
#       · `--out .workbuddy/tmp` 之所以一直没事，只是因为它**恰好**是已存在的目录
#         （glob 命中后替换回等值字符串）；若该目录不存在则原样保留，两种都无害。
#       · 别名：`--filter` / `--filters` / `-f`（`cli_base.py:96-106`），值为 **glob/fnmatch** 模式；
#         **可用逗号分隔给多个**：`--filter=scripts/**,docs/adr/**,AGENTS.md`
#         （源码 `core.py:229`：`[f.strip() for f in filters.split(",") if f.strip()]`）；
#       · **与 `exclude_files` 是叠加、不是覆盖**。顺序在 `core.py:345-348`：先 `filter_diff(filters)`
#         取「只要这些」，再 `filter_diff(config.exclude_files, exclude=True)` 剔掉排除项
#         ⇒ 一个文件**同时**命中过滤器与 `exclude_files` 时**仍被排除** ⇒ 不必临时改 config；
#       · 全被排掉时抛 `AllChangesExcludedError`（**不是**静默空报告）——这条是设计，可依赖。
#     ⚠️ **模式语义两个坑**（`fnmatch` 与 glob **不同**，实测见下方「已取证」）：
#       ① `**` 与 `*` **完全等价**（都跨 `/`），写 `scripts/*` 与 `scripts/**` 是同一件事；
#          反过来：`src/*.py` **会**匹配到 `src/a/b/c.py`，别按 glob 直觉当「只一层」。
#       ② 本机（Windows）匹配**大小写不敏感**——`fnmatch.fnmatch` 内部先调 `os.path.normcase`
#          （win32 下转小写并把 `/` 换成 `\`），而 POSIX 下 normcase 是恒等函数。
#          实测：`'SRC-TAURI/RESOURCES/x.txt'` 对 `'src-tauri/resources/**'` 在 Windows **命中**、
#          在 POSIX **不命中**。⇒ 同一份模式**两平台不等价**，且失效方向是**静默多排除**。
#          本仓当前所有真实路径均为小写 ⇒ 现状不受影响；改模式时若引入大写字母，必须两平台各想一遍。
#
#     查看「本次会审哪些文件」（**零 LLM**，不需要 key——验 exclude_files 的正解）：
C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\gito files
#       ✅ 本机实跑（2026-10-15）：`Changed files: INDEX vs origin/main --> 15 file(s).`
#       ⚠️ 它的 stdout **带 ANSI 颜色码**（形如 `- \x1b[34mAGENTS.md\x1b[39m`）⇒ 用脚本解析
#          输出时**必须先剥色**（`re.sub(r"\x1b\[[0-9;]*m", "", s)`），否则「某文件在不在列表里」
#          这类断言会**静默恒为假**——本轮夹具就栽在这里：它是**漏报**而不是报错。
#     从仓库源码装（调试或钉特定 tag 时）：
#       pip install git+https://github.com/Nayjest/Gito.git@<tag>
#     重建项目配置的完整默认副本（**拒绝覆盖已有文件**，须 --force）：
C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\gito populate-project-config
#     命令没进 PATH 时用模块形态调用：
#       C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe -m gito review
#
#     ⚠️ 已登记的限制（Gito 自述）：它在响应 PR 评论时**无法修改 `.github/workflows/` 下的
#        文件**（GitHub 的安全限制，官方明确不建议用 PAT 绕过）。本仓的 PR 高频就是改
#        workflows 与 patches ⇒ 这条是本仓选「本地 CLI 而非 PR 评论」的直接原因之一。
#
#     ✅ **已取证（2026-10-15，不需要 key 即可复核）**：① `fnmatch` 模式语义与命中数——
#        对 `git ls-files` 实测（当时 543 个，2026-10-19 复核 545 个），A 组命中 86、B 组命中 0，且做注入
#        试验（去掉 `vendor/**/lib/**` 后总数恰降 80）⇒ 模式列表可独立证伪；② 判据通道——
#        `gito review` 只渲染 `cfg.prompt` / `cfg.summary_prompt` 且只传 `**prompt_vars`，
#        `aux_files` 只被 `answer()` 读取 ⇒ 本仓不配它（源码级证据，不需要跑模型）；
#        ③ **端到端**（**比较器取自被测对象本身**，不再是我复算的 `fnmatch`）：基线
#        `gito files` = 15 个变更文件 → 注入 `'AGENTS.md'` ⇒ **14** 个、AGENTS.md 消失、
#        其余**逐字不变** → 注入 `'docs/**'` ⇒ **10** 个、5 个 `docs/*` 全消失、`AGENTS.md`
#        仍在（顺带证实通配 `**` **跨 `/`**，与 `filter_diff` 的 `fnmatch` 语义一致）→
#        两次注入后 `.gito/config.toml` `sha256[:16] = de90fa4e5a1b72fe` **字节级复原**。
#        ⚠️ 上面③那条「`docs/**` 删掉 5 个 `docs/*`」只能证明「`**` 跨 `/`」——**证明不了**
#        「`*` 不跨」，也就**区分不了** `fnmatch` 与 glob 语义。要区分得直接比翻译结果：
#          python -c "import fnmatch;print(fnmatch.translate('docs/*'));print(fnmatch.translate('docs/**'))"
#        ⇒ 两者**逐字相同** `(?s:docs/.*)\Z` ⇒ `**` ≡ `*`（`*` 同样翻成 `.*`，照样跨 `/`）。
#        ④ **跨平台差异**（本轮实测，两平台不等价）：`fnmatch.fnmatch` 先 `os.path.normcase`
#        （win32 转小写 + `/`→`\`；POSIX 恒等）⇒ 本机大小写不敏感。实测
#        `'SRC-TAURI/RESOURCES/x.txt'` vs `'src-tauri/resources/**'`：Windows **True** / POSIX **False**。
#        ⇒ 失效方向是**静默多排除**（本机少审文件而看不出来），与本仓最忌的形态同类。现状不受影响
#        （所有真实路径均小写），但这是「本机绿 ≠ CI 绿」的一个潜在产地，见上方 `-f` 段。
#
#     ✅ **已跑成第一次真实评审**（2026-10-15，实测，非夹具）：模型调用路径**已自证**——
#        `step-5-preview` 经 `https://api.stepfun.com/step_plan/v1` 真实返回 `'OK'`；
#        并已对真实 diff 跑出报告：`--filter=scripts/**` ⇒ `exit 0`、**0 次 429**、
#        `**⚠️ 2 issues found** across 2 files`（**2/2 全覆盖、无跳过**）、耗时 **231 s**，
#        且抓出 **2 条门禁未覆盖的真缺陷**（已修，见 `docs/dev-plan-defect-remediation.md` §11 对应行）。
#        ⚠️ 「已接线能力」仍留给维护者定性：2026-10-19 已跑过一次**全量**真实评审（PR #12，12 文件 / 零跳过），但它**不进任何 CI 档位**，
#        且它**不进任何 CI 档位**（ADR-065）⇒ AGENTS.md §7.2 的口径仍然适用。
#        ⚠️ 另有一条**降级预警**（不影响结论，但要知道）：日志会刷
#        `WARNING: Can't resolve tiktoken encoding for 'step-5-preview'` ⇒ 该模型名不在 tiktoken
#        词表里，**token 计数走回落编码** ⇒ 与 `max_code_tokens` 相关的预算只是近似值。
#        另：`max_code_tokens` 本仓**刻意用默认值**（32000），不写进 config——它只管
#        diff / 全文上下文的预算上限，与本仓判据无关。
#
#     ⚠️ **已登记的仓库异常（本次发现，未修，等你裁定）**：`.gitignore` 在 HEAD 里的 blob
#        带 **50 个 CR**（CRLF），而其余所有跟踪文件都是 **LF blob**。在 `core.autocrlf=true`
#        下这意味着一件事：**编辑器把整份文件重写成 LF 时，提交里会多出 50 行纯 EOL 差异**（原地保留 CRLF 追加 = `5 0` 零噪音，2026-10-19 受控复测）
#        （实测：`git add` 后 `--numstat` 为 `55 50`，而 `-w` 忽略空白后只剩 **5 行**真改动）。
#        本次实现 Gito 时踩到了它，改为用 `--out` 绕开、**不动那个文件**。判据与复核：
#          git cat-file -p HEAD:.gitignore | tr -cd '\r' | wc -c    # 50（其余文件皆为 0）
#        要修就是一次性的 `git add --renormalize .gitignore`（50 行 EOL 差异只在这一次提交里
#        出现，之后不再复现）；不修则整份重写式编辑都要重新解释一遍这 50 行。**两者都行，但要有记录。**
#
#     ⚠️ **已登记的本机异常 ②：本机 `pip` 的任何安装/下载命令都会静默卡死**
#        （表现是「什么都没发生」，所以比上一条更值得记）。**根因已定位到行**：
#          · 必要条件——本机 `rustc` 由 **mise shim** 提供
#            （`%LOCALAPPDATA%\mise\shims\rustc.EXE`），实测启动 **2.47s**。
#          · pip 每条安装/下载命令都会构造 `PipSession`，其 `user_agent()`
#            （`pip/_internal/network/session.py:179-192`）在 `shutil.which("rustc")` 命中时执行
#            `subprocess.check_output(["rustc","--version"], timeout=0.5)`。2.47s > 0.5s
#            ⇒ **必然** `TimeoutExpired`。
#          · 充分条件——Windows 分支在超时后的清理里**再调一次** `process.communicate()`
#            （`subprocess.py:565` → `_communicate` → `join`）。mise shim 是转发进程：shim 被 kill
#            后它派生出的**孙进程仍持有继承来的 stdout 写端** ⇒ `_readerthread` 永不 EOF
#            ⇒ 永久阻塞。
#          · 反证（证明「慢」单独不成立）：`~/.cargo/bin/rustc.exe` 实测 **0.70s**，同样 > 0.5s、
#            同样走超时分支，但**不死锁**——它自身持有写端，kill 即释放
#            ⇒ 充分条件是 shim 的**进程转发结构**。
#        取证：① `faulthandler.dump_traceback_later(25)` 抓到的栈逐帧为
#        `user_agent → check_output → run → communicate → _communicate → join`（+ `_readerthread`）；
#        ② 15 行最小复现（只用 stdlib、与本仓无关）：`check_output(["rustc", "--version"],
#        stderr=STDOUT, timeout=0.5)` **卡死**，同调用 `timeout=10` **返回 OK**（2.1s）；
#        ③ **同命令红→绿**（只差 PATH 里的一个目录）：
#             pip install -v --no-index --no-deps --dry-run <whl>     → 卡死（exit 124，只打印横幅）
#             同上 + PATH 剔除 mise/shims                             → exit 0（正常三行输出）
#        ⇒ **处置**：pip 命令前把 mise shims 从 PATH 里**摘掉**——不要整个替换 PATH，那会连带干掉
#        PortableGit 的 coreutils（`ls` / `rm` / `command` 全部 `command not found`）：
#          export PATH="${PATH//\/c\/Users\/Administrator\/AppData\/Local\/mise\/shims:/}"
#        ⚠️ 另一陷阱：pip 输出重定向到文件时是**块缓冲**的 ⇒ **日志 0 字节能被误读成「下载中」**，
#        别据此判断「在跑」。（可读性上仍建议 pip 加 `-v`，但它**不是**判别量、也治不了这个卡死。）
#        📌 **本轮推翻了两条自己先前的结论**：① 「出口代理慢」——证伪（`--noproxy` 无效）；
#        ② 「判别变量是详细度」——证伪（当时那次 `-v` 成功只是因为那个 shell 的 PATH 恰不含
#        mise shims；现在含 mise 的 PATH 下 `-v` 同样卡死，已复现）。
```

集成测试（`crates/dsh-host/tests/`）会真实派生 Node 进程运行 `scripts/mock-harness.mjs`，需要 `PATH` 上有 Node.js（可用 `DSH_TEST_NODE` 指定）；找不到时测试自行跳过而非失败。故障模式经 `mock-harness.mjs` 的 argv / 环境变量注入，不在 Rust 侧打桩。

