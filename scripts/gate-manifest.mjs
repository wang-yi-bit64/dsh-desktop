#!/usr/bin/env node
/**
 * gate-manifest.mjs — **门禁总表（唯一产地）**。
 *
 * ## 为什么存在
 *
 * 2026-10-03 的治理复盘（G0~G3）发现三件事实：
 *
 *   1. 门禁清单在**三处**手抄：scripts/verify-fast.mjs（本地快档）、ci.yml、
 *      release.yml 的 preflight。三份清单互相漂移，且漂移**不会报错**；
 *   2. 于是出现「写了守卫但没人跑」——verify:unwrap-hygiene / verify:doc-facts /
 *      verify:github-config / verify:fault-patterns 都**不在任何自动流程里**，
 *      而文档（AGENTS.md §7.2、缺陷治理台账）已经宣称它们在盯着代码。
 *      这是 §7.3「门禁替一段不存在的检查背书」的原文形态；
 *   3. 每加一个守卫要改 4~5 处（package.json / 快档 / ci / release / 文档），
 *      漏改任何一处依然全绿。
 *
 * 本文件把第 1 条修掉：门禁只在这里登记一次，编排器（scripts/gates.mjs）、
 * 本地快档、CI、发布 preflight 都从它派生。漂移由 verify-gates.mjs 判红。
 *
 * ## 一条门禁 = 什么
 *
 * 一个**可独立判真假的检查**，带两种模式：
 *   · real     —— 真检查（读仓库 / 组装产物 / 联网），失败即「仓库有问题」；
 *   · selfTest —— 自检（用夹具检查判定函数本身），失败即「守卫有问题」。
 *
 * tiers 决定它在哪个流程里跑：
 *   · fast     —— 本地 npm run verify:fast（秒级、离线、无需组装产物）
 *   · ci       —— ci.yml 的三平台静态门禁
 *   · release  —— release.yml preflight（发布前的秒级静态门禁）
 *   · sentinel —— **联网哨兵**（上游 drift / 更新通道）。刻意不进 fast/ci：
 *                 它们会因**外部状态**红，属「提醒升级」而非「代码有问题」
 *                 （ADR-030 / S1-3）。
 *
 * ⚠️ tiers: [] 是合法且必须写理由的：它表示「这个门禁存在、可以手动跑，但刻意
 * 不进任何自动流程」。没有理由的空 tiers 由 verify-gates.mjs 判红——否则
 * 「忘了登记」与「刻意不跑」长得一模一样。
 *
 * ## 与 package.json 的关系
 *
 * 2026-10-03 起 package.json 不再为每个门禁各留一条 script（此前 62 条里 41 条是
 * 门禁入口）。统一入口是：
 *
 *   npm run gate -- <name> [--self-test]     # 单个门禁
 *   npm run gate -- --tier=<fast|ci|release|sentinel>
 *   npm run gate -- --list                   # 列出全部
 *
 * **旧名仍然可用**：npm run gate -- verify:claims 与 npm run gate -- claims:self-test
 * 都能解析（见 normalizeGateName）。历史文书（ADR / CHANGELOG / docs/archive /
 * docs/incidents / 计划台账）里的旧命令因此不会变成死链——这是刻意保留的兼容层，
 * 不是遗漏。
 */

/** 合法分档（顺序即展示顺序；执行顺序由 resolveTier 决定）。 */
export const TIERS = ['fast', 'ci', 'release', 'sentinel']

/**
 * 门禁总表。字段：
 *   · name       —— 门禁名（同时是旧名 verify:<name> / verify:<name>:self-test 的键）
 *   · script     —— 仓库内相对路径（**必须存在**，由 verify-gates 断言）
 *   · title      —— 一行说明（打印用）
 *   · why        —— **为什么有这条门禁**：守的是哪一类缺陷 / 哪次事故。
 *                   这段文字原先散在 ci.yml 的步骤注释里；放在这里才能与门禁同生共死。
 *   · real       —— 真检查：{ tiers, args }；无真检查写 null
 *   · selfTest   —— 自检：同上；无自检写 null
 *   · platforms  —— 可选，限制平台（如 ['win32']）。跳过的项**必须打印**，
 *                   不得静默（§7.1 规则 3）
 *   · manual     —— 可选，配合空 tiers 说明「为什么刻意不自动跑」
 *   · needsAssembly —— 可选，需要组装好的运行时资源树（本地/发布链路才有）
 */
export const GATES = [
  // ------------------------------------------------------------------
  // 契约 / 宣称 / 文档面
  // ------------------------------------------------------------------
  {
    name: 'claims',
    script: 'scripts/verify-claims.mjs',
    title: '宣称纪律（README ↔ AGENTS §7）',
    why: '禁止表述不得出现在 README；五种状态词表三处一致；§7.2 表里每个「未接线/未实现」行都必须登记销账。2026-09-12 评估抓到 README 一处「插件无法拖垮 Harness」的过度宣称——这类漂移编译器看不见、跨语言 grep 也不全。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'plan-facts',
    script: 'scripts/verify-plan-facts.mjs',
    title: '计划文档事实（锚点 ↔ 文档 ↔ 决策账本）',
    why: '守「不重读仓库就写现状」这类已发生四次的缺陷，并补上一个零守卫缺口：所有读 dshVersion 的代码都动态解析，没有任何守卫读文档。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'doc-facts',
    script: 'scripts/verify-doc-facts.mjs',
    title: '文档↔仓库事实（license / 命令速查覆盖 / 状态词）',
    why: '守文档与代码的**派生关系**：package.json 的每个 script 名必须出现在 docs/commands.md（该文件自称「含全部 npm script 名」）。2026-10-03 的真实漂移（漏登 4 个名字）是它的第一个夹具。⚠️ 2026-10-03 前它只在本地跑，CI 完全不跑它——正是「有守卫没人跑」的样本。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'github-config',
    script: 'scripts/verify-github-config.mjs',
    title: '.github 配置准入（工作流位置 / SHA 钉死）',
    why: 'A：工作流必须住在 .github/workflows/ 下（2026-09-29 e9f8dc5 把 pr-agent 放错目录 ⇒ 看得见、从不运行）。B：第三方 action 必须钉 40 位 SHA（本仓持有发布签名私钥）。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'version',
    script: 'scripts/version.mjs',
    title: '版本号三处一致（package.json / tauri.conf.json / Cargo.toml）',
    why: '版本漂移会让包自称另一个版本，而 updater 据此决定推不推更新——错一次所有已安装用户收不到更新。这是契约门禁，不是格式美化。',
    real: { tiers: ['fast', 'ci', 'release'], args: ['check'] },
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'release-ledger',
    script: 'scripts/release-ledger.mjs',
    title: '发布台账自洽（合成号序号不重复 / 记录与版本号逐字自洽）',
    why: '合成号（ADR-061）的 <n> 只能由台账推导，「这一版是第几次交付」这件事没有任何别的地方记录。守卫 1：已发布构建不得共享 (上游, n) 二元组——重复意味着两次发布声称同一版，updater 会把其中一个当作已安装 ⇒ 那份更新永远推不出去。字段自洽断言 desktopVersion 必须逐字等于由 (upstreamDsh, n, w) 合成出来的串，否则「台账里的 n」与「版本号里的 n」可以各说各话而无人发现。⚠️ 台账为空时它打印「空集判据」而不是静默通过——「没有可断言的东西」不得冒充「已断言且通过」。2e（2026-10-09）起台账同时是「上游**精确**版本 → patchTarget + 本仓下一个 n」的**唯一入口**（`resolveReleaseFor()`）：未知版本**抛错**而非返回 null（返回 null 会诱出「回退默认目标」，正是 2i 的形态），且计数必须走 allBuilds（`builds[]` 不存 upstreamDsh，直接喂 entry.builds 会恒返回 1 —— 静默算错，已有专门夹具）。',
    real: { tiers: ['fast', 'ci', 'release'], args: ['--validate'] },
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'version-policy',
    script: 'scripts/verify-version.mjs',
    title: '版本策略三守卫（台账序号 / w 不参与排序 / 通道解析严格）',
    why: '这三条是**矩阵型**缺陷：每一处单独看都合理，合起来才致命。守卫 2 尤其隐蔽——本仓 JS 比较器忽略 build，而 tauri-plugin-updater 用的 Rust Ord **包含** build，两套实现今天不一致；排序键刻意只落在预发布段，就是为了不依赖这个巧合。守卫 3 对应缺口 2i（四段式会让 targetForVersion 静默给 next ⇒ 按错的补丁集组装而不报错）。⚠️ 本守卫的被探测实现是**参数化注入**的，自测里喂了「比较 build 的比较器」与「缺口 2i 的旧实现」两个已知有缺陷的实现并断言报红——否则判据本身写坏时同样给绿。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'sync-upstream',
    script: 'scripts/sync-upstream-release.mjs',
    title: '2c 前门的纯逻辑判据（锁 exact / 台账记录构造 / 发布前核算）',
    why: '合成号的 n 只能由台账推出，而「写台账 + 写版本号」发生在同一次发布里——任何一步算错都会把一个没人发布过的版本号写进 package.json，updater 从此按它比较。这里守住三件事：④ 锁 exact（范围 / dist-tag / 带 build 段一律判红，否则两次组装可能装进两个不同上游）；台账记录必须由 (上游键, n, w) 合成且 channel 由 patchTarget 现算（台账刻意不存 releaseChannel）；发布前核算对「锚点未动的上游前进」显式判红（不静默新建台账键）。⚠️ 真检查要联网（npm view 上游精确版本），故不进任何分档；self-test 保持纯逻辑（不读盘、不联网）。正式线（无预发布段）在合成函数唯一产地显式抛错（ADR-061 决策 7）。',
    real: { tiers: [], args: [] },
    manual: '真检查联网（npm view 上游精确版本 + 可选 gh api 上游 Release），由发布流程按需调用：node scripts/sync-upstream-release.mjs（--plan 默认只读 / --apply 显式写）。进分档只会得到一条恒定绿或依赖网络的步骤。',
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },

  // ------------------------------------------------------------------
  // 壳面（IPC / 页面 / 注入 / 入口约定）
  // ------------------------------------------------------------------
  {
    name: 'ipc-surface',
    script: 'scripts/verify-ipc-surface.mjs',
    title: '壳 IPC 面一致性（命令 ↔ 注册 ↔ 前端 ↔ 页面可达）',
    why: 'src-tauri 是 rlib，pub 项在 clippy 看来一律可达，dead_code 永远报不出「写了但没人调用」。这类跨语言断线只能静态比对——error.html 曾调用不存在的 harness_start_safe_mode，按钮静默失效。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'shell-pages',
    script: 'scripts/verify-shell-pages.mjs',
    title: '壳内页面运行时冒烟（DOM 桩 + 按钮接线）',
    why: '抓 E1~E6 看不见的两类缺陷：getElementById 拿到 null 导致整页监听失效；HTML 留了按钮但脚本忘绑监听（显示正常、按钮是死的）。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: null
  },
  {
    name: 'harness-inject',
    script: 'scripts/verify-harness-inject.mjs',
    title: 'Harness 页注入脚本行为（无头 + DOM 桩）',
    why: '注入脚本工作在真浏览器 DOM 上，可见性规则与「元素带未定态漏出」这类上游回归没有别的自动化防线。脚本自带可证伪性检查（把行为打回变体必须报红）。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: null
  },
  {
    name: 'harness-entry',
    script: 'scripts/verify-harness-entry.mjs',
    title: '壳入口 ↔ 上游 dsh CLI 调用约定',
    why: '上游 0.1.5-rc.1 把 CLI 从顶层自执行改成 if (import.meta.main) runCli()，而本仓入口是 import 它——不显式调用 runCli() 则 CLI 从不运行、进程静默退出 0，表现为「就绪超时但日志无报错」。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'primary-runtime',
    script: 'scripts/prepare-primary-runtime.mjs',
    title: 'primary runtime 载荷的完整性判据',
    why: '载荷缺任何一块（python 解释器 / site-packages / node / node_modules / pnpm / office skills 任一）都会让 Harness 在启动期 stat 失败——那是「应用起不来」而不是「少个功能」。因此组装必须 fail-closed：全齐才落盘。三态判据：缺席=合法（不打载荷时 office skills 保持禁用）、残缺=红、完整=绿。self-test 用夹具把每一项轮流抽走，判据必须转红；若有人把实现改成「目录存在就算齐」，这条会红。',
    // 真检查刻意**不进任何分档**：它读的是 src-tauri/resources 下的载荷，而普通检出
    // 与 CI 都不带 python 载荷（体积按百 MB 计）。此时正确的结论就是「缺席=合法」，
    // 跑它只会得到一条恒定绿色、零信息的步骤。夹具化的 self-test 才承载真判据。
    // 一旦本仓开始随包发布载荷，把 real.tiers 改成 ['fast','ci','release'] 即可。
    real: { tiers: [], args: ['--check'], needsAssembly: false },
    manual: '真检查读本地载荷；普通检出与 CI 都不带 python 载荷（缺席合法），跑它只会得到恒定绿色、零信息的步骤。要校验某台具体机器的载荷时手动跑。一旦本仓开始随包发布载荷，就把 real.tiers 改成 ["fast","ci","release"]。',
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'profile-names',
    script: 'scripts/verify-profile-names.mjs',
    title: 'DSH profile 保留名 + 两个契约锚点',
    why: '官方桌面版独占 desktop 这个 profile 名及其全部大小写变体。当前未使用保留名，因此这是一道防回归门禁：哪天有人把 profile 命名成 desktop，在这里就红。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'fault-patterns',
    script: 'scripts/verify-plugin-fault-patterns.mjs',
    title: '插件故障归因模式（formatFaultDetails 的文案）',
    why: 'AGENTS §7.2 宣称「插件故障归因（进程内）已接线」，唯一产地是 build/plugin-safety-guard.mjs 的 formatFaultDetails——它一旦被改坏，归因文案会静默退化而没有任何编译错误。⚠️ 2026-10-03 前它不在任何自动流程里。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: null
  },
  {
    name: 'unwrap-hygiene',
    script: 'scripts/verify-unwrap-hygiene.mjs',
    title: '生产路径 unwrap 清零（S4-4，治 D10）',
    why: 'src-tauri 与各 crate 的 src 生产段（首个 #[cfg(test)] 之前）不得出现裸 unwrap。29 处已收敛为 poison 恢复原语。⚠️ 2026-10-03 前**真检查**不在任何自动流程里，只有自检在本地跑：缺陷治理台账却写着「逐行由 verify:unwrap-hygiene 盯着」。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: { tiers: ['fast', 'ci'], args: ['--self-test'] }
  },

  // ------------------------------------------------------------------
  // 补丁 / 上游通道
  // ------------------------------------------------------------------
  {
    name: 'patches',
    script: 'scripts/verify-patch-layers.mjs',
    title: '补丁分级总表一致性（patches/<target>/ ↔ patch-layers.mjs）',
    why: '逐目标检查：双通道各有自己的补丁集，只验默认目标会让另一条线的补丁整目录漏登记。登记缺失会让 prepare:harness 在打包时才报错，代价高得多。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: null
  },
  {
    name: 'patch-layers-selftest',
    script: 'scripts/patch-layers.mjs',
    title: '补丁分级表推导逻辑自检',
    why: 'prepare-harness 把这套分级当硬门禁，而 prepare-harness.mjs 的注释写着「CI 的 --self-test 才是硬门禁」——那条 CI 步骤**并不存在**（2026-10-03 登记）。分级表的推导逻辑（按包名索引、默认层回退）此前没有任何接线。',
    real: null,
    // 实测 0.17s（2026-10-03）：纯逻辑，进快档零成本。
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'relocate-hunks',
    script: 'scripts/relocate-patch-hunks.mjs',
    title: '补丁 hunk 重定位工具自检',
    why: 'patch-package 按 @@ 行号定位、偏移超 ±20 行即放弃，而只按内容搜索的预检仍报 clean——两条结论相反，因此重定位是移植补丁的必需步骤。它只改 @@ 行、其余逐字节保真，判据写错不会有别的检查变红。',
    real: null,
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'targets',
    script: 'scripts/dsh-targets.mjs',
    title: '构建目标总表自检（目标 ↔ 上游 dist-tag ↔ 桌面通道 ↔ 版本）',
    why: '含「未知通道不得回退默认目标」这条硬约束——通道解析决定装哪个运行时，回退 = 出错包的运行时。2e（2026-10-09）后本表**只**拥有「目标键 → 目录 / 上游锚点 / 桌面后缀」，合成号与序号归 release-ledger，越界即职责回涨；原字段 `channel` 已改名 `upstreamDistTag`（旧名会把它读成「发布通道」，而它其实是上游客观事实），并新增由**版本后缀**推导桌面通道的 desktopChannelForVersion。自测成对钉两件事：①「通道不可挪位」——`0.2-rc.3`（通道名写进核心三段）必须判红，而 `0.2.0-rc.3` 必须判绿；②「upstreamDistTag 不是桌面通道」——`0.5.0-next.1` 必须判 null（若有人把桌面通道改成读 dist-tag，这条与「rc 后缀 ⇒ rc」同时变红）。',
    real: null,
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'target',
    script: 'scripts/verify-target.mjs',
    title: '组装产物的目标一致性（真检查需组装树）',
    why: '真检查读组装好的 resources/ 树，因此只在本地/发布链路有意义；CI 只跑它的自检。',
    real: { tiers: [], args: [], needsAssembly: true },
    manual: '需组装树：由 release.yml 的 build job 与 portable job 在 prepare:harness 之后按名点名',
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'harness-tree',
    script: 'scripts/verify-harness-tree.mjs',
    title: '组装树完整性（package.json 入口目标必须存在）',
    why: '缺入口时 package.json 与文件都在、看起来完全正常，只有 Harness 启动才抛 Cannot find module——「装得上、起不来」。真检查需要组装树，因此只在发布链路跑。',
    real: { tiers: [], args: ['src-tauri/resources/harness/node_modules'], needsAssembly: true },
    manual: '需组装树：由 release.yml 的 build job 与 portable job 在 prepare:harness 之后按名点名',
    selfTest: { tiers: ['ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'upstream-release',
    script: 'scripts/upstream-release.mjs',
    title: '上游发布面（GitHub Release）取用判据自检',
    why: '上游 Release 是漂移哨兵与发布前门（步骤①②）的共同基准，而它的取用有三处**实测**的反直觉事实：① tag 形态是 `dsh-v<x.y.z>` 而不是 `v<x.y.z>`（旧实现写错 ⇒ 一旦配上 slug 就恒报「Release 不存在」）；② 上游**全部** Release 都是 prerelease ⇒ `/releases/latest` 恒 404，必须列清单按 semver 取最大；③ `target_commitish` 实测多数是分支名 `master` 而不是 commit（照抄会把分支名写进台账的 upstreamCommit = 伪造一个不存在的 commit 身份）。另守「排除项必须如实报出」——上游若改了 tag 形态，过滤后清单会变成空的，而「空的」与「没有漂移」长得一样。',
    real: null,
    // 真检查要联网（gh api）且会把整份 Release 清单打出来；它承载的判据是纯逻辑的，
    // 联网那部分由 drift 的 sentinel 档覆盖（同一个 slug、同一条取数路径）。
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'drift',
    script: 'scripts/verify-upstream-drift.mjs',
    title: '上游版本漂移哨兵（**联网**）',
    why: '落后上游是「该规划升级了」，不是「这次发布有问题」。因此真检查**刻意不进** fast/ci：挂在每次提交上会长期制造红灯噪声（ADR-030 / S1-3）。真检查跑在 drift.yml 的定时任务里。基准已于 2026-10-09（计划 2f）由 npm dist-tag 换成**上游 GitHub Release**：dist-tag 滞后可见（同一天内前进过一版），且上游出现过「tag 已动、依赖树未齐」的波次。⚠️ 换基准带来一个**新形状** `patch-line-behind`（上游在新补丁线上重新起预发布：patch 前进 + 阶段回退）——旧实现会把它误报成「上游已进入**更晚**的预发布阶段」（与事实相反），本哨兵沿用阻断但把归因说准，是否继续阻断**待重算**（计划 §17 → P0-2）。',
    real: { tiers: ['sentinel'], args: [] },
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'update-channel',
    script: 'scripts/updater-manifest.mjs',
    title: '更新通道端点核验（**联网**，发布后）',
    why: '断言「端点 version ≥ 该通道最新 tag」——更新链路断掉时用户永远收不到更新，而这个事实只有真发布后才可观测。真检查进 sentinel 档（drift.yml 每周 + 发布后手动）。',
    real: { tiers: ['sentinel'], args: ['--verify'] },
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },

  // ------------------------------------------------------------------
  // 依赖树 / 打包器
  // ------------------------------------------------------------------
  {
    name: 'prune',
    script: 'scripts/prune-harness-deps.mjs',
    title: '依赖树瘦身判据自检（按内容而非名字）',
    why: 'prepare:harness 会整目录删掉「像开发产物」的目录，而 doc/docs 这类名字在某些包里恰好是运行时路径（yaml/dist/doc/directives.js）。删错不会让任何静态检查变红：打包、签名、安装全成功，只有启动时抛 Cannot find module。',
    real: null,
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'variants',
    script: 'scripts/prune-platform-variants.mjs',
    title: '原生平台变体剪枝判据自检',
    why: 'musl / 非目标架构的 prebuild 留在树里时 linuxdeploy 会在打包阶段解析它们的动态依赖并失败，而 tauri-bundler 默认吞掉真实报错，只留下 failed to run linuxdeploy。',
    real: null,
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'harness-lockfile',
    script: 'scripts/harness-lockfile.mjs',
    title: '提交式 lockfile 校验规则自检',
    why: '守住「lockfile 与组装输入脱节后 CI 照样用旧树装包」的事故——判据本身写错时任何静态检查都不会红。',
    real: null,
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'remove-tree',
    script: 'scripts/remove-tree.mjs',
    title: '临时目录清理不得否决主结论',
    why: '守 2026-09-23 alpha.5 事故：cli-publish 的 finally 里 rmSync 报 EACCES 冒泡，把一次**通过**的核验判成发布失败，还吞掉了 problems 的真实内容。这类缺陷只有真跑发布才炸。',
    real: null,
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'cli-package',
    script: 'scripts/package-cli.mjs',
    title: 'CLI 打包链路自检（纯逻辑 + 当前平台真归档回读）',
    why: '守三类「哈希对得上但产物没用」的缺陷：产物名里的版本与 package.json 漂移、边车格式不是 sha256sum 能读的形状、归档丢掉可执行位。CLI **发布通道**已退役，但打包判据与上传无关，属 ADR-031 的可证伪守卫资产。',
    real: null,
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'portable-package',
    script: 'scripts/package-portable.mjs',
    title: '便携版打包器自检（**仅 Windows**）',
    why: 'packagePortable 的 stage 与归档两步都走 PowerShell，portable job 本身也是 windows-only。纯逻辑判据（命名 / 边车 / 解 zip 按平台选命令）与宿主无关，因此跑一次两个分支都验到了。',
    real: null,
    // 实测 41.5s（2026-10-03）：它真在 Windows 上打 zip，是快档里最贵的一步。
    // 因此刻意不进 fast——快档的预算纪律（≤60s 温编译）优先，它与 cli-package
    // 覆盖的判据族相同，留在 ci/release 两档。
    selfTest: { tiers: ['ci', 'release'], args: ['--self-test'] },
    platforms: ['win32']
  },
  {
    name: 'patch-applicability',
    script: 'scripts/check-patch-applicability.mjs',
    title: '补丁可适用性预检（真检查需 --pristine 参数）',
    why: '升级/移植工序用（±20 行窗口判据）。真检查需要纯净树参数，属人工工序，因此只登记自检。',
    real: null,
    selfTest: { tiers: ['fast', 'ci'], args: ['--self-test'] }
  },
  {
    name: 'report-patches',
    script: 'scripts/report-patches.mjs',
    title: '补丁报告生成器自检',
    why: 'report:patches 的 Markdown 输出会进 Release 正文，渲染写错不会让别的检查变红。',
    real: null,
    selfTest: { tiers: ['fast', 'ci'], args: ['--self-test'] }
  },

  // ------------------------------------------------------------------
  // 发布链路自身
  // ------------------------------------------------------------------
  {
    name: 'release-workflow',
    script: 'scripts/verify-release-workflow.mjs',
    title: '发布工作流静态判据（tauri-action 拼装 / shell 可移植性 / CLI 产物形状）',
    why: '守两类「只有真跑发布才炸」的缺陷：tauri-action 会自己插入 build 与 -- 导致 repeated build；macOS bash 3.2 会把变量名吞进紧邻的全角字符。两者让 v0.1.0 首次发布三平台全红。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'release-assets',
    script: 'scripts/verify-release-assets.mjs',
    title: 'Release 资产清单判据（期望 13 个，逐项枚举名字）',
    why: '守 2026-09-24 实测缺口：CLI 通道退役时便携版「核验 + 上传」那半截职责没被搬走 ⇒ 每次发布实际只有 10 个资产，而 AGENTS §8.5 承诺 13 个，全部门禁绿灯。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'commits',
    script: 'scripts/conventional-commits.mjs',
    title: 'Conventional Commits 解析器自检',
    why: '变更日志由提交消息渲染。解析器写错会静默产出空/错序的变更日志，而 Release 页会显示「没有任何改动」——比没有脚本更危险。',
    real: null,
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },
  {
    name: 'changelog',
    script: 'scripts/changelog.mjs',
    title: '变更日志渲染器自检',
    why: '同 commits：渲染逻辑与区间解析的自测是发布正文正确性的唯一防线。',
    real: null,
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  },

  // ------------------------------------------------------------------
  // 门禁自身
  // ------------------------------------------------------------------
  {
    name: 'gates',
    script: 'scripts/verify-gates.mjs',
    title: '门禁总表自身的守卫（登记完整性 / 扫出数 > 0 / 旧名兼容）',
    why: '守「有守卫没人跑」的根因：scripts/ 下每个支持 --self-test 的脚本都必须在总表里登记或显式豁免（带理由）；每个分档的条目数必须 > 0；总表被清空时判红而不是全绿。这就是 §7.3 的「扫出数必须 > 0」纪律在**编排层**的落地。',
    real: { tiers: ['fast', 'ci', 'release'], args: [] },
    selfTest: { tiers: ['fast', 'ci', 'release'], args: ['--self-test'] }
  }
]

/**
 * 刻意**不**登记的门禁形态（带理由）。表为空是目标状态。
 *
 * 判据由 verify-gates.mjs 执行：scripts/ 下每个支持 --self-test 的脚本要么在
 * GATES 里登记，要么在这里带理由豁免。新增豁免必须写理由。
 */
export const EXEMPT_SELF_TEST_SCRIPTS = [
  {
    script: 'scripts/gates.mjs',
    reason:
      '编排器：它接受 --self-test 是为了把它**转发**给被点名的门禁，本身不是一条门禁，也没有自己的自检模式（判定逻辑在 verify-gates.mjs 里）。'
  }
]

/** 支持 --self-test 的脚本的**可证伪**识别式（不是「文件里出现该字符串」）。 */
export const SELF_TEST_CLI_PATTERN = /(?:argv|args|arg)\s*(?:\.includes\(\s*|===\s*)['"]--self-test['"]/

/** 按名取门禁；不存在则返回 undefined。 */
export function gateByName(name) {
  return GATES.find((gate) => gate.name === name)
}

/**
 * 把「用户写的名字」解析成 { name, selfTest }。
 *
 * 接受形态（历史文书里的旧命令因此不会变成死链）：
 *   · claims / verify:claims                      → 真检查
 *   · claims:self-test / verify:claims:self-test  → 自检
 *   · verify:doc-facts --self-test                → 自检（旧名 + 显式开关）
 *
 * @param {string} raw
 * @param {boolean} forceSelfTest 命令行带 --self-test 时为 true
 * @returns {{ name: string, selfTest: boolean } | { error: string }}
 */
export function normalizeGateName(raw, forceSelfTest = false) {
  let name = String(raw ?? '').trim()
  if (name === '') return { error: '空门禁名' }
  if (name.startsWith('verify:')) name = name.slice('verify:'.length)
  let selfTest = Boolean(forceSelfTest)
  if (name.endsWith(':self-test')) {
    name = name.slice(0, -':self-test'.length)
    selfTest = true
  }
  if (gateByName(name) === undefined) return { error: '未知门禁：' + raw }
  return { name, selfTest }
}

/**
 * 解析一个分档 → 待执行步骤列表（保序、去重）。
 *
 * 每个步骤：{ gate, mode, args, label }。同一门禁的真检查排在其自检之前——
 * 先看仓库有没有问题，再看守卫坏没坏。两者都跑是刻意的：自检与被测对称失效
 * 是本仓已踩过五次的坑。
 *
 * @param {string} tier
 */
export function resolveTier(tier) {
  if (!TIERS.includes(tier)) throw new Error('未知分档：' + tier + '（合法值：' + TIERS.join(' / ') + '）')
  const steps = []
  for (const gate of GATES) {
    for (const mode of ['real', 'self-test']) {
      const spec = mode === 'real' ? gate.real : gate.selfTest
      if (spec === null || spec === undefined) continue
      if (!spec.tiers.includes(tier)) continue
      steps.push({
        gate,
        mode,
        args: spec.args ?? [],
        label: mode === 'real' ? gate.name : gate.name + ':self-test'
      })
    }
  }
  return steps
}

/** 某门禁在哪些分档里被自动跑到（供「有守卫没人跑」检查用）。 */
export function autoRunTiers(gate) {
  const tiers = new Set()
  for (const spec of [gate.real, gate.selfTest]) {
    for (const tier of spec?.tiers ?? []) tiers.add(tier)
  }
  return TIERS.filter((tier) => tiers.has(tier))
}

/** 人类可读的登记摘要（--list 用）。 */
export function describeGates() {
  return GATES.map((gate) => ({
    name: gate.name,
    script: gate.script,
    title: gate.title,
    real: gate.real ? gate.real.tiers : [],
    selfTest: gate.selfTest ? gate.selfTest.tiers : [],
    platforms: gate.platforms ?? null,
    needsAssembly: gate.needsAssembly === true,
    manual: gate.manual ?? null
  }))
}
