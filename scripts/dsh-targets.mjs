#!/usr/bin/env node
/**
 * dsh-targets.mjs — 内置 DSH 运行时的**构建目标**总表（双通道的单一事实源）。
 *
 * ## 为什么需要「目标」这一层
 *
 * 本仓把上游 `@deepseek-ai/dsh` 钉死在一个版本上，并叠加一整套 `patch-package`
 * 行级补丁（见 [`../patches/LAYERS.md`](../patches/LAYERS.md)）。补丁是**行级 diff**，
 * 换一个上游版本就必须整套重做——因此历史上一次只能跟一条上游线。
 *
 * 2026-09-15 起改为**双通道并存**：
 *
 * | 桌面发布通道 | 上游线 | 该通道的产物 |
 * |---|---|---|
 * | `next`（默认线） | npm `next` dist-tag（rc 阶段） | `v0.5.0-rc.1` 之类 |
 * | `alpha` | npm `alpha` dist-tag（下一 minor 的早期预览） | `v0.6.0-alpha.1` 之类 |
 *
 * 两个目标各自持有一套**补丁集**（`patches/<target>/`）与**vendored 覆盖包**
 * （`packages/<target>/`），互不干扰；`prepare:harness` 按 `--dsh-target` 选一套。
 *
 * ## 🔴 本模块的职责边界（计划 §4.6 **2e** 拆分：2026-10-09）
 *
 * 它**只**拥有「运行时目标表」这一件事——目标键 → 目录契约与上游锚点：
 *
 * | 它拥有 | 含义 |
 * |---|---|
 * | 目标键 ↔ 目录 | `patches/<key>/`、`packages/<key>/`、`harness-deps/<key>/`（**目录键保持不动**） |
 * | `dshVersion` | 该目标钉的**上游精确版本**；补丁文件名的版本段锚它（**不得**改成锚桌面号） |
 * | `publishChannel` | 桌面 tag 的**预发布后缀**（本仓命名，可改） |
 * | `upstreamDistTag` | 上游 npm dist-tag 名 —— **仅用于发现/参考**，不是发布依据 |
 * | `status` | 在役 / 休眠（ADR-056 / ADR-057） |
 *
 * 它**刻意不拥有**（越界即职责回涨；`docs/version-policy.md` §职责划分 有同一张表）：
 *
 * - ❌ **桌面合成版本号**的推导（`n` / `w` 与逐位复算）→ `harness-locks/dsh-releases.json`
 *   与 `scripts/release-ledger.mjs`（`composeDesktopVersion()` / `planNextDesktopVersion()`）；
 * - ❌ 「上游**精确**版本 → `patchTarget` + 本仓计数」的解析 → 同上（`resolveReleaseFor()`）；
 * - ❌ 任何「桌面版本 ⇒ 选哪条上游线」的映射：V3（ADR-061）下该关系**不存在**。
 *
 * ## 🔴 `upstreamDistTag` 不是发布通道（2026-09-24 解耦，2026-10-09 改名）
 *
 * 两个字段回答两个独立的问题，**且都不叫 `channel`**（旧名易被读成「发布通道」）：
 *
 * | 字段 | 回答的问题 | 值的来源 | 可否随意改 |
 * |---|---|---|---|
 * | `upstreamDistTag` | 组装/发现时**上游有哪条 npm dist-tag 线** | 上游客观事实（`next` / `alpha`） | ❌ **不能**——上游就叫这个名 |
 * | `publishChannel` | 桌面 tag 的**预发布后缀**叫什么 | 本仓自己的命名决定 | ✅ 能（`next` → `rc` 就是这么改的） |
 *
 * 混为一谈的代价（这正是 2026-09-24 要修的东西）：上游的 `next` dist-tag 现在
 * **指向一个 `rc` 阶段版本**（`dist-tag` 是「哪条发布线」，预发布标识是「这条线
 * 走到哪一步了」，两者独立——这一点 `verify-upstream-drift.mjs` 的注释早已写明）。
 * 若强行让两者同名，想把桌面后缀改成语义更准的 `rc` 时，就会连带去查一个
 * **上游根本不存在的 `rc` dist-tag**，让漂移哨兵静默退回 `latest`、永久误报。
 *
 * `targetForVersion` / `desktopChannelForVersion` 走**版本后缀**；
 * `upstreamDistTagFor` 只把 dist-tag 名交给**发现/参考**用途（漂移哨兵参考段）。
 * 两条路互不读取对方 ⇒ 自测里 `upstreamDistTagFor('next') === 'next'` 与
 * `desktopChannelForVersion('0.2.0-rc.3') === 'rc'` **同时**成立。
 *
 * ## 目标状态（status）：在役 / 休眠（ADR-056）
 *
 * `status: 'active' | 'dormant'`，**唯一产地**。休眠 = 不发布、不做漂移追赶、
 * 补丁与 vendored 冻结保留；`publishChannel` 后缀仍可解析（删除目标是另一个决策，
 * 属 ADR-022 意义上的收敂）。消费方：
 *   · release preflight 的 `--channel-of` —— 休眠目标**直接失败**（休眠通道不得发布，
 *     恢复在役须先修订 ADR-056 并把 status 改回 active）；
 *   · verify:update-channel / verify:drift —— 休眠目标**显式跳过**（不是静默消失）；
 *   · 默认目标必须在役（self-test 断言）——全部休眠时哨兵无事可做，属配置矛盾。
 *
 * ## 未知通道必须失败，不得回退到默认目标
 *
 * `v0.5.0-beta.1` 这种 tag：`beta` 不是任何目标的 `publishChannel`。此时
 * {@link targetForVersion} 返回 `null`，调用方**必须报错**——静默回退到默认目标
 * 会产出「版本号说 beta、运行时却是 next 线」的包，而这类错配只有用户装上才会
 * 发现（且 updater 的版本比较会跟着一起错）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/dsh-targets.mjs                      # 打印目标表
 * node scripts/dsh-targets.mjs --self-test          # 纯逻辑自检（不联网）
 * node scripts/dsh-targets.mjs --channel-of v0.5.0-rc.1   # 版本/桌面 tag → 目标名（走 publishChannel）
 * ```
 *
 * 退出码：`0` 正常 · `1` 自检失败或未知通道 · `2` 参数错误。
 */

import { argv, env as processEnv, exit } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 构建目标总表。
 *
 * `dshVersion` 是**唯一产地**：`prepare:harness` 的 `dependencies['@deepseek-ai/dsh']`
 * 与补丁文件名里的版本段都由它推导，不要在任何别处再写一遍版本字符串。
 * （`check-patch-applicability` 会用「补丁文件名里的版本段是否等于当前目标版本」
 * 判断该包的版本要不要跟着上移，见其 `targetPackageVersion()`。）
 *
 * ⚠️ **字段名 `channel` 已于 2026-10-09（2e）改名为 `upstreamDistTag`**：旧名与
 * 「发布通道」同形，读的人会把「上游 dist-tag」误当成「本仓发布通道」。改名后
 * 与台账（`harness-locks/dsh-releases.json`）的同名字段一致，且**不再有** `channel`
 * 字段（自测里有一条「旧字段名不得残留」的判据）。
 */
export const DSH_TARGETS = {
  next: {
    upstreamDistTag: 'next',
    publishChannel: 'rc',
    status: 'active',
    dshVersion: '0.2.0-rc.2',
    summary:
      '上游 rc 线（当前 0.2.0-rc.2，2026-09-30 从 0.1.5-rc.3 跨两个 minor 推进；补丁按 retireWhen 退役 4 个、语义重做 3 个；2026-10-10 另加 2 个 functional 补丁修启动缺陷。当前条数不在此写死——以 node scripts/patch-layers.mjs --list 为准。见 patches/LAYERS.md）'
  },
  alpha: {
    upstreamDistTag: 'alpha',
    publishChannel: 'alpha',
    status: 'active',
    dshVersion: '0.2.1-alpha.1',
    summary:
      '上游 alpha 线（2026-10-07 从 0.1.7-alpha.2 跨 minor 推进到 0.2.1-alpha.1：补丁按 retireWhen 退役 1 个、语义重做 4 个；2026-10-10 另加 2 个 functional 补丁修启动缺陷。当前条数不在此写死——以 node scripts/patch-layers.mjs --list 为准。见 patches/LAYERS.md）'
  }
}

/** 未显式指定 `--dsh-target` 时使用的目标。 */
export const DEFAULT_TARGET = 'next'

/**
 * **正式版**（无预发布段）的桌面通道名。
 *
 * 它不是目标名（目标表里没有 `stable` 键，见 {@link desktopChannelForVersion} 的说明）。
 */
export const STABLE_CHANNEL = 'stable'

/** 列出全部目标名（稳定顺序：`DSH_TARGETS` 的键序）。 */
export function listTargetNames() {
  return Object.keys(DSH_TARGETS)
}

/**
 * 取目标定义。
 *
 * @param {string} name 目标名（如 `next`）。
 * @returns {{name: string, upstreamDistTag: string, publishChannel: string, status: 'active'|'dormant', dshVersion: string, summary: string}}
 *   目标定义（含名字）。`upstreamDistTag` **仅用于发现**，不决定发布通道。
 * @throws {Error} 名字不在总表里——**不**回退到默认目标：静默回退会让产物捆错运行时。
 */
export function resolveTarget(name) {
  const entry = DSH_TARGETS[name]
  if (entry === undefined) {
    throw new Error(
      `未知的 DSH 目标：${JSON.stringify(name)}；可用目标：${listTargetNames().join(' / ')}`
    )
  }
  return { name, ...entry }
}

/** 目标名 → 该目标的补丁目录（`patches/<target>/`）。 */
export function patchesDirFor(name) {
  return join(projectRoot, 'patches', resolveTarget(name).name)
}

/**
 * 目标名 → 该目标的 vendored 覆盖包目录（`packages/<target>/`）。
 *
 * 目录**可以不存在**（没有需要冻结字节的包时）；调用方按空目录处理。
 */
export function packagesDirFor(name) {
  return join(projectRoot, 'packages', resolveTarget(name).name)
}

/** 目标名 → 该目标的 staging 目录（`harness-deps/<target>/`）。 */
export function stagingDirFor(name) {
  return join(projectRoot, 'harness-deps', resolveTarget(name).name)
}

/**
 * 版本的**形状解析**——非抛错，供**语料扫描**用。
 *
 * 与 {@link channelOfPrerelease} 是**同一规则的两种意图**（形状正则只写一次，本函数是产地）：
 *
 * | 意图 | 入口 | 输入是脏的时 |
 * |---|---|---|
 * | 「我手里这个版本号应当是真的」 | {@link channelOfPrerelease} | **抛错**（异常） |
 * | 「我在扫一批来路不明的字符串」 | 本函数 | 返回 `{ ok: false }`（跳过） |
 *
 * 为什么必须分开：`git tag --list 'v*'` 的结果是**语料**，里面可能有非 semver 的 tag
 * （人工 tag、命名变更期的旧 tag）。若扫描谓词直接调抛错的入口，**任一脏元素就会让整趟
 * 扫描失败**，且失败信息与真正的低投递问题混在一起无法区分（本仓缺陷族「守卫只覆盖 N 段里
 * 的 N-1 段」的镜像：把校验用的判据错用在扫描点上）。
 *
 * @param {string} version 任意字符串；可带前导 `v`。
 * @returns {{ ok: true, major: number, minor: number, patch: number,
 *   prerelease: string|null, build: string|null } | { ok: false }}
 *   解析成功给出各段（`prerelease` / `build` 为 `null` 表示该段不存在）；
 *   失败给出 `{ ok: false }`。
 */
export function parseVersionShape(version) {
  const raw = String(version ?? '').trim().replace(/^v/i, '')
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(raw)
  if (!m) return { ok: false }
  return {
    ok: true,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
    build: m[5] ?? null,
  }
}

/**
 * 从语义化版本的**预发布标识符**里取通道名。
 *
 * `0.2.1-alpha.1.3` → `alpha`；`0.2.0-rc.3.1` → `rc`；`0.5.0` → `null`（正式版无通道）。
 * 只取第一段标识符：`alpha.1.3` 的通道是 `alpha`，不是 `alpha.1`。
 *
 * 🔴 **无法解析的输入必须抛错，不得返回 `null`**（缺口 **2i**，见 `ADR-061`）。
 * 早期实现把「格式不符」与「无预发布后缀」合并成同一个 `null`，于是
 * `targetForVersion('0.2.1.3-rc.1')` 会**静默**落回默认目标，按**错的**补丁集与
 * lockfile 组装而**不报错**——这是最危险的一类缺陷：产物看起来正常，但装错了通道。
 * 分开之后，「正式版」仍是 `null`（合法语义），「不识别的形状」是异常。
 *
 * ⚠️ **扫语料时不要用本函数**——那是 {@link parseVersionShape} 的场景，用错会让脏 tag
 * 炸掉整趟扫描。
 *
 * @param {string} version 语义化版本（可带前导 `v`）。
 * @returns {string|null} 通道名；**仅**在确为正式版（无预发布段）时为 `null`。
 * @throws {Error} 输入不是 `major.minor.patch[-预发布][+build]` 形状时。
 */
export function channelOfPrerelease(version) {
  const parsed = parseVersionShape(version)
  if (!parsed.ok) {
    throw new Error(
      `无法解析的版本号：${JSON.stringify(String(version ?? ''))}——` +
        `要求 <major>.<minor>.<patch>[-<预发布>][+<build>]。` +
        `若是四段式（如 0.2.1.3-rc.1），它以前会被静默判成正式版并落回默认目标，` +
        `现已改为抛错（ADR-061 缺口 2i）。` +
        `若你在**扫一批来路不明的字符串**（如 git tag 列表），请改用 parseVersionShape()。`
    )
  }
  if (parsed.prerelease === null) return null
  return parsed.prerelease.split('.')[0]
}

/**
 * 桌面版本的预发布后缀 → 构建目标名。
 *
 * 规则（与 `AGENTS.md` §8.4 的通道约定一致）：
 *   · 无预发布后缀（正式版）→ 默认目标（stable 线跟随默认目标）；
 *   · 预发布且后缀命中某目标的 `publishChannel` → 该目标；
 *   · 预发布但后缀未命中（如 `beta`）→ `null`，调用方**必须报错**（见模块文档）；
 *   · **形状不合法**（如四段式 `0.2.1.3-rc.1`）→ **抛错**，不落回默认目标（缺口 2i）。
 *
 * 合成版本号（`ADR-061`）下，合成号的**首段预发布标识符就是上游自己的**标识符
 * （`0.2.1-alpha.1.3` 的 `alpha`、`0.2.0-rc.3.1` 的 `rc`），而现有目标的
 * `publishChannel` 恰好与之同名（`alpha` / `rc`）⇒ **本函数无需为合成号改动**。
 * 本仓序号是第二段（`alpha.1.3` 里的 `3`），不参与通道判定。
 *
 * 🔴 查的是 **`publishChannel`**（本仓自己的 tag 后缀约定），**不是** `channel`
 * （上游 dist-tag 名）。两者独立——上游 `next` dist-tag 当下指向一个 `rc` 阶段
 * 版本，因此本仓的 tag 后缀写 `rc` 却要组装 `next` 目标的补丁集，这是**正常**的。
 * 详见 {@link targetForPublishChannel} 与模块文档的「两个通道名不是一回事」。
 *
 * @param {string} version 语义化版本（可带前导 `v`）。
 * @returns {string|null} 目标名；未知后缀时为 `null`。
 * @throws {Error} 版本形状不合法时（由 {@link channelOfPrerelease} 抛出）。
 */
export function targetForVersion(version) {
  const suffix = channelOfPrerelease(version)
  if (suffix === null) return DEFAULT_TARGET
  return targetForPublishChannel(suffix)
}

/**
 * 桌面 tag 的预发布后缀 → 构建目标名。
 *
 * 与 {@link targetForVersion} 的分工：本函数只做「后缀 → 目标」这一步，方便
 * 调用方在已经拿到后缀时不必再拼一个假版本号。未知后缀返回 `null`（不回退）。
 *
 * @param {string} suffix 预发布后缀（如 `rc` / `alpha`）。
 * @returns {string|null} 目标名；无匹配时为 `null`。
 */
export function targetForPublishChannel(suffix) {
  const wanted = String(suffix ?? '').trim()
  if (wanted.length === 0) return null
  for (const name of listTargetNames()) {
    if (DSH_TARGETS[name].publishChannel === wanted) return name
  }
  return null
}

/**
 * 桌面**发布通道名**：由**版本后缀**推导，与 {@link targetForVersion} 同源、不同出口。
 *
 * | 输入 | 结果 |
 * |---|---|
 * | `0.2.0`（无预发布段） | `'stable'`（{@link STABLE_CHANNEL}） |
 * | `0.2.0-rc.3` / `0.2.0-rc.3+w3` | `'rc'`（命中 `next` 目标的 `publishChannel`） |
 * | `0.2.1-alpha.1` / `0.2.1-alpha.1.3` | `'alpha'` |
 * | `0.5.0-next.1` | `null`——`next` 是**上游 dist-tag 名**，不是桌面通道名 |
 * | 形状非法（`0.2-rc.3`、`0.2.1.3-rc.1`） | **抛错**（沿用 2i 纪律：形状不可识别 ≠ 正式版） |
 *
 * ⚠️ **`stable` 不是目标名**：目标表里没有 `stable` 键（正式线的载体是 ADR-061 决策 7 的
 * 未决开口）。因此 {@link targetForVersion} 对正式版**照旧落默认目标**（`next`），
 * 而本函数对同一版本给出 `stable`——两者**刻意不同**：一个答「用哪套补丁目录」，
 * 一个答「这一版对外属于哪条通道」。自测同时钉住这两条。
 *
 * 🔴 **本函数只读版本后缀，不读 `upstreamDistTag`**。若实现改成读目标表的
 * `upstreamDistTag`，`desktopChannelForVersion('0.2.0-rc.3')` 会变成 `'next'`，
 * 自测里那条期望 `'rc'` 的断言立刻变红——这正是 2e 拆分要守的边界。
 *
 * @param {string} version 语义化版本（可带前导 `v`）。
 * @returns {'stable'|'rc'|'alpha'|null} 通道名；后缀未命中任何 `publishChannel` 时为 `null`。
 * @throws {Error} 版本形状不合法时（由 {@link channelOfPrerelease} 抛出）。
 */
export function desktopChannelForVersion(version) {
  const suffix = channelOfPrerelease(version)
  // 无预发布段 ⇒ 正式版；**不**回退默认目标（那是 targetForVersion 的出口）。
  if (suffix === null) return STABLE_CHANNEL
  return targetForPublishChannel(suffix) === null ? null : suffix
}

/**
 * 组装目标名 → 它**发现/参考**用的上游 npm dist-tag 名。
 *
 * ⚠️ **降级说明（2e）**：本函数返回的是 `upstreamDistTag`——上游客观事实，**仅用于
 * 发现**（如漂移哨兵的参考段打印「上游现有哪些 dist-tag」）。它**不**参与：
 *   · 桌面通道判定（那是 {@link desktopChannelForVersion}，只看版本后缀）；
 *   · 目标解析（那是 {@link targetForVersion}，只看 `publishChannel`）。
 * 旧名 `upstreamTagFor` 与之同名易混（`Tag` 到底指上游 tag 还是桌面 tag），2026-10-09 改名。
 *
 * @param {string} name 目标名。
 * @returns {string} 上游 dist-tag 名。
 * @throws {Error} 目标名未知。
 */
export function upstreamDistTagFor(name) {
  return resolveTarget(name).upstreamDistTag
}

/**
 * 解析构建目标：`--dsh-target=<name>` → 环境变量 `DSH_TARGET` → 默认目标。
 *
 * ## 为什么必须有环境变量这条路（2026-09-15 的真实事故）
 *
 * CI 里最自然的写法是 `npm run prepare:harness -- --dsh-target="${DSH_TARGET}"`，
 * 但在 **Windows runner**（默认 shell 是 PowerShell）上那次调用把值丢了：参数变成
 * `--dsh-target=`，node 读到空串后抛错，Windows 的 Smoke job 全红，而 macOS/Linux
 * 两个平台**正常通过**——三个平台给出相反的结论，原因只是 shell 不同。
 *
 * 用环境变量传值把这段 shell 引用整个消掉：workflow 里只写
 * `env: { DSH_TARGET: … }` + `run: npm run prepare:harness`，任何 shell 都只是
 * 启动一个进程、设一个变量。这与本仓给 `TAURI_SIGNING_PRIVATE_KEY` 用 env 而非
 * 内联插值是同一套理由（那次是防密钥进日志，这次是防 shell 改写语义）。
 *
 * 刻意**不用** `--target`：`prepare-harness.mjs` 已经把 `--target=<platform>/<arch>`
 * 用于**打包目标**守卫，`check-patch-applicability.mjs` 又把 `--target=<版本>` 用于
 * **待检的上游版本**。三个概念各占一个参数名，避免读的人（和写的人）弄混。
 *
 * @param {string[]} args 命令行参数（不含 node 与脚本名）。
 * @param {Record<string, string|undefined>} [env] 环境变量（默认 `process.env`）。
 * @returns {string} 目标名。
 * @throws {Error} 传了 `--dsh-target=` 但为空、或指向未知目标。
 */
export function resolveDshTargetArg(args = argv.slice(2), env = processEnv) {
  const raw = args.find((arg) => arg.startsWith('--dsh-target='))
  if (raw !== undefined) {
    const value = raw.slice('--dsh-target='.length).trim()
    if (value.length === 0) throw new Error('--dsh-target= 后面必须跟目标名（如 next / alpha）')
    return resolveTarget(value).name
  }
  const fromEnv = String(env?.DSH_TARGET ?? '').trim()
  if (fromEnv.length > 0) return resolveTarget(fromEnv).name
  return DEFAULT_TARGET
}

/** 自检：纯逻辑，不联网、不读磁盘。 */
export function selfTest() {
  const failures = []
  let passed = 0
  const eq = (label, got, want) => {
    passed += 1
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`${label}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
    }
  }
  const throws = (label, fn) => {
    passed += 1
    try {
      fn()
      failures.push(`${label}：应当报错但没有`)
    } catch {
      /* 预期内 */
    }
  }

  // 通道解析：预发布标识符的第一段才是通道名。
  eq('channel：next 线', channelOfPrerelease('0.5.0-next.1'), 'next')
  eq('channel：alpha 线', channelOfPrerelease('0.6.0-alpha.1'), 'alpha')
  eq('channel：带前导 v', channelOfPrerelease('v0.5.0-next.1'), 'next')
  eq('channel：多段标识符只取首段', channelOfPrerelease('0.5.0-next.1.2'), 'next')
  eq('channel：正式版无通道', channelOfPrerelease('0.5.0'), null)
  eq('channel：build metadata 不算通道', channelOfPrerelease('0.5.0+build.7'), null)

  // 合成版本号（ADR-061）：本仓序号追加在**上游预发布段之后**，首标识符仍是通道名。
  eq('channel：合成号 alpha.1.3 → alpha', channelOfPrerelease('0.2.1-alpha.1.3'), 'alpha')
  eq('channel：合成号 alpha.1.10 → alpha', channelOfPrerelease('0.2.1-alpha.1.10'), 'alpha')
  eq('channel：合成号 rc.3.1 → rc', channelOfPrerelease('0.2.0-rc.3.1'), 'rc')
  eq('channel：合成号带 w 标签', channelOfPrerelease('0.2.1-alpha.1.3+w1'), 'alpha')
  eq('channel：合成号带前导 v', channelOfPrerelease('v0.2.1-alpha.1.3'), 'alpha')

  // 🔴 缺口 2i：**不识别的形状必须抛错**，不得静默返回 null。
  //    ⚠️ 这几条以前断言的是 `null` —— 那个断言本身就是缺陷（静默落回默认目标 = 装错通道）。
  throws('channel：非版本串必须抛错（2i）', () => channelOfPrerelease('not-a-version'))
  throws('channel：空串必须抛错（2i）', () => channelOfPrerelease(''))
  throws('channel：四段式必须抛错（2i）', () => channelOfPrerelease('0.2.1.3-rc.1'))
  throws('channel：两段式必须抛错（2i）', () => channelOfPrerelease('0.2'))

  // 形状解析（非抛错）：**语料扫描**入口。与上面的抛错入口是同一规则的两种意图。
  // ⚠️ 断言逐字段取，不整体 JSON 比对——整体比对会把「多加一个字段」误报成失败，
  //    于是以后没人敢扩这个返回结构。
  const s1 = parseVersionShape('0.5.0')
  eq('形状：合法正式版的 ok', s1.ok, true)
  eq('形状：核心三段', [s1.major, s1.minor, s1.patch], [0, 5, 0])
  eq('形状：正式版无预发布', s1.prerelease, null)
  eq('形状：正式版无 build', s1.build, null)
  const s2 = parseVersionShape('0.2.1-alpha.1.3')
  eq('形状：合法预发布', s2.prerelease, 'alpha.1.3')
  eq('形状：预发布的数字段是数字', [s2.major, s2.minor, s2.patch], [0, 2, 1])
  const s3 = parseVersionShape('0.5.0+build.7')
  eq('形状：build 不算预发布', s3.prerelease, null)
  eq('形状：build 被单独取到', s3.build, 'build.7')
  eq('形状：带前导 v', parseVersionShape('v0.2.1-alpha.1.3').prerelease, 'alpha.1.3')
  eq('形状：四段式不可解析但不抛错', parseVersionShape('0.2.1.3-rc.1').ok, false)
  eq('形状：任意垃圾串不可解析但不抛错', parseVersionShape('vNext').ok, false)
  eq('形状：空串不可解析但不抛错', parseVersionShape('').ok, false)

  // 🔴 两分法（对称失效守卫）：**同一个输入、两种意图、相反结果**，期望值全部硬编码。
  //    若有人把扫描点改回抛错入口（或把本函数改成抛错），必有一侧变红。
  throws('两分法：已知版本号（四段式）抛错', () => channelOfPrerelease('0.2.1.3-rc.1'))
  eq('两分法：同一串在语料扫描里只是「不可解析」', parseVersionShape('0.2.1.3-rc.1').ok, false)
  eq(
    '两分法：合法版本号两侧都能用',
    [channelOfPrerelease('0.2.1-alpha.1.3'), parseVersionShape('0.2.1-alpha.1.3').ok],
    ['alpha', true]
  )

  // 版本 → 目标：正式版落默认目标；后缀按 publishChannel 查表，未知后缀必须判 null。
  eq('target：正式版 → 默认目标', targetForVersion('0.5.0'), DEFAULT_TARGET)
  eq('target：rc 后缀 → next 目标（publishChannel 解耦）', targetForVersion('0.5.0-rc.1'), 'next')
  eq('target：alpha 通道', targetForVersion('0.6.0-alpha.1'), 'alpha')
  eq('target：未知后缀（beta）必须是 null', targetForVersion('0.5.0-beta.1'), null)
  eq('target：合成号 alpha.1.3 → alpha', targetForVersion('0.2.1-alpha.1.3'), 'alpha')
  eq('target：合成号 rc.3.1 → next（与上游 dist-tag 解耦）', targetForVersion('0.2.0-rc.3.1'), 'next')
  // 🔴 2i 的端到端形态：错的形状必须炸，不能装错通道。
  throws('target：四段式必须抛错（2i 端到端）', () => targetForVersion('0.2.1.3-rc.1'))
  // 🔴 可伪证性：`next` 作为**桌面后缀**已不再是任何目标的 publishChannel
  //    （它现在是纯上游 dist-tag 名）。若有人把 targetForVersion 改回按
  //    `channel` 查表，这条会立刻红——那正是本次解耦要防的倒退。
  eq(
    'target：旧后缀 next 必须判 null（已不再是 publishChannel）',
    targetForVersion('0.5.0-next.1'),
    null
  )

  // publishChannel 反查：后缀 → 目标名，独立于 upstreamDistTag。
  eq('publishChannel：rc → next', targetForPublishChannel('rc'), 'next')
  eq('publishChannel：alpha → alpha', targetForPublishChannel('alpha'), 'alpha')
  eq('publishChannel：未知后缀 → null', targetForPublishChannel('beta'), null)
  eq('publishChannel：空串 → null', targetForPublishChannel('  '), null)
  // 两个名字**必须**不同：这是解耦的立论点，也是「上游 next dist-tag 指向 rc 版本」的编码。
  eq('next 目标的 upstreamDistTag（上游 tag，仅发现）', upstreamDistTagFor('next'), 'next')
  eq('next 目标的 publishChannel（桌面后缀）', resolveTarget('next').publishChannel, 'rc')
  eq(
    '两个字段确实不同（解耦的证明）',
    upstreamDistTagFor('next') !== resolveTarget('next').publishChannel,
    true
  )

  // === 2e（2026-10-09）：职责边界 ==========================================
  // 通道**由版本后缀推导**，不由 upstreamDistTag 推导——这是 2e 拆分的正面判据。
  eq(
    '2e：正式版 ⇒ stable（不是目标名，见 desktopChannelForVersion 文档）',
    desktopChannelForVersion('0.2.0'),
    STABLE_CHANNEL
  )
  eq('2e：rc 后缀 ⇒ rc', desktopChannelForVersion('0.2.0-rc.3'), 'rc')
  eq('2e：合成号（带 +w）⇒ rc —— build 段不得污染通道', desktopChannelForVersion('0.2.0-rc.3+w3'), 'rc')
  eq('2e：alpha 后缀 ⇒ alpha', desktopChannelForVersion('0.2.1-alpha.1'), 'alpha')
  eq('2e：合成号（多段）⇒ alpha', desktopChannelForVersion('0.2.1-alpha.1.3'), 'alpha')
  // 🔴 边界反证：`next` 是**上游 dist-tag 名**，不是桌面通道名。若把 desktopChannelForVersion
  //    改成读目标表的 upstreamDistTag，上面「0.2.0-rc.3 ⇒ rc」会变成 'next'，本条与那条
  //    **同时**变红——两个方向都钉住了。
  eq('2e：上游 dist-tag 名（next）不得当桌面通道', desktopChannelForVersion('0.5.0-next.1'), null)
  eq('2e：未知后缀 ⇒ null', desktopChannelForVersion('0.5.0-beta.1'), null)
  throws('2e：形状非法必须抛错（0.2-rc.3）', () => desktopChannelForVersion('0.2-rc.3'))
  // 正式版的两条口径**刻意不同**：通道名 `stable`（后缀推的）vs 目标 `next`（默认线）。
  // 若有人把二者「统一」，必有一条变红——这是 ADR-061 决策 7 的未决开口在代码里的显式位置。
  eq('2e：正式版的目标仍是默认目标（既有语义保留，不得改）', targetForVersion('0.2.0'), DEFAULT_TARGET)
  eq(
    '2e：stable 与默认目标刻意不同名（决策 7 的开口）',
    desktopChannelForVersion('0.2.0') !== DEFAULT_TARGET,
    true
  )

  // 🔴 §4.9 判据 9：**通道不可挪位**——把通道名写进核心三段（`0.2-rc.3`）必须判红。
  //    关键在**成对**：同一个通道名位置正确时（`0.2.0-rc.3`）必须绿，否则「一律抛错」也能过。
  throws('2e：通道名挪进前两段（0.2-rc.3）⇒ targetForVersion 必须报错', () =>
    targetForVersion('0.2-rc.3')
  )
  eq('2e：同一通道名位置正确 ⇒ next（正控）', targetForVersion('0.2.0-rc.3'), 'next')
  eq('2e：语料扫描入口对挪位版本只判「不可解析」，不炸整趟扫描', parseVersionShape('0.2-rc.3').ok, false)

  // 目标表本身：`upstreamDistTag` 必须与键一致（本仓两条线的 dist-tag 名恰好同键），
  // 而「版本后缀能反推回自己」要走 **publishChannel** —— 这正是解耦后的分工。
  // 另：**旧字段名 `channel` 不得残留**（改名半途 = 两套名字并存，读的人不知道信哪个）。
  for (const name of listTargetNames()) {
    const target = resolveTarget(name)
    eq(`目标 ${name} 的 upstreamDistTag 与键一致`, target.upstreamDistTag, name)
    eq(
      `目标 ${name} 的 upstreamDistTag 是已知 npm dist-tag 名`,
      ['latest', 'next', 'alpha'].includes(target.upstreamDistTag),
      true
    )
    eq(`目标 ${name} 已无旧字段 channel（2e 改名）`, Object.hasOwn(DSH_TARGETS[name], 'channel'), false)
    eq(`目标 ${name} 的 status 合法`, ['active', 'dormant'].includes(target.status), true)
    eq(
      `目标 ${name} 的 publishChannel 能反推回自己`,
      targetForVersion(`9.9.9-${target.publishChannel}.1`),
      name
    )
  }
  // 目标状态（ADR-056 → ADR-057）：alpha 休眠于 2026-09-30 当日即因用户指令复役
  // （修订见 ADR-057），两线均在役；默认目标必须在役（全部休眠时哨兵无事可做，属配置矛盾）。
  eq('目标状态：alpha 已复役（ADR-057 修订 ADR-056）', resolveTarget('alpha').status, 'active')
  eq('目标状态：next 在役', resolveTarget('next').status, 'active')
  eq('默认目标必须在役', resolveTarget(DEFAULT_TARGET).status, 'active')

  // 未登记目标必须抛错，而不是回退（静默回退 = 捆错运行时）。
  throws('未知目标名必须抛错', () => resolveTarget('stable'))
  throws('--dsh-target= 空值必须抛错', () => resolveDshTargetArg(['--dsh-target=']))
  eq('缺省 --dsh-target 落默认目标', resolveDshTargetArg([]), DEFAULT_TARGET)
  eq('显式 --dsh-target', resolveDshTargetArg(['--dsh-target=alpha']), 'alpha')

  // 环境变量分支（CI 用这条：避免 shell 引用把值丢掉）。
  eq('DSH_TARGET 环境变量生效', resolveDshTargetArg([], { DSH_TARGET: 'alpha' }), 'alpha')
  eq('CLI 参数优先于环境变量', resolveDshTargetArg(['--dsh-target=next'], { DSH_TARGET: 'alpha' }), 'next')
  eq('空 DSH_TARGET 落默认目标', resolveDshTargetArg([], { DSH_TARGET: '   ' }), DEFAULT_TARGET)
  eq('未设 DSH_TARGET 落默认目标', resolveDshTargetArg([], {}), DEFAULT_TARGET)
  // 可证伪性：环境变量里的未知目标同样必须报错——静默回退默认目标会捆错运行时。
  throws('DSH_TARGET 是未知目标必须抛错', () => resolveDshTargetArg([], { DSH_TARGET: 'beta' }))

  if (failures.length > 0) {
    throw new Error(`dsh-targets 自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`)
  }
  return { passed }
}

function main() {
  const args = argv.slice(2)
  if (args.includes('--self-test')) {
    try {
      const { passed } = selfTest()
      console.log(`✅ dsh-targets 自测通过（${passed} 项）`)
    } catch (error) {
      console.error(error.message)
      exit(1)
    }
    return
  }
  if (args.includes('--version-of')) {
    const value = args[args.indexOf('--version-of') + 1]
    if (value === undefined) {
      console.error('用法：node scripts/dsh-targets.mjs --version-of <目标名>')
      exit(2)
    }
    try {
      console.log(resolveTarget(value).dshVersion)
    } catch (error) {
      console.error(error.message)
      exit(1)
    }
    return
  }

  if (args.includes('--channel-of')) {
    const value = args[args.indexOf('--channel-of') + 1]
    if (value === undefined) {
      console.error('用法：node scripts/dsh-targets.mjs --channel-of <版本或 tag>')
      exit(2)
    }
    const target = targetForVersion(value)
    if (target === null) {
      console.error(
        `❌ ${value} 的预发布后缀（${channelOfPrerelease(value)}）不对应任何 DSH 目标的 publishChannel；` +
          `可用后缀：${listTargetNames()
            .map((n) => DSH_TARGETS[n].publishChannel)
            .join(' / ')}`
      )
      exit(1)
    }
    // 休眠通道不得发布（ADR-056）：release preflight 走这条路推导目标，
    // 在这里失败 = 「给休眠通道打 tag」在组装 300MB 之前就被拦下。
    if (resolveTarget(target).status === 'dormant') {
      console.error(
        `❌ 目标 ${target}（后缀 ${channelOfPrerelease(value)}）已裁定休眠（ADR-056），休眠通道不得发布。` +
          `恢复在役须先修订 ADR-056 并把目标表 status 改回 active。`
      )
      exit(1)
    }
    console.log(target)
    return
  }

  console.log('DSH 构建目标（双通道）：')
  for (const name of listTargetNames()) {
    const target = resolveTarget(name)
    const mark = name === DEFAULT_TARGET ? ' ← 默认' : ''
    const statusMark = target.status === 'dormant' ? '  🗄️ 休眠（ADR-056）' : ''
    console.log(`  ${name.padEnd(6)} DSH ${target.dshVersion.padEnd(14)} ${target.summary}${mark}${statusMark}`)
    console.log(
      `         上游 dist-tag（仅发现）：${target.upstreamDistTag}   桌面后缀：${target.publishChannel}   ` +
        `状态：${target.status}   补丁：patches/${name}/   vendored：packages/${name}/`
    )
  }
}

const isDirectRun = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(argv[1] ?? '')
  } catch {
    return false
  }
})()

if (isDirectRun) main()

/** 供 `--self-test` 之外的调用方复用的模块入口（无副作用）。 */
export const dshTargetsModuleUrl = pathToFileURL(join(projectRoot, 'scripts', 'dsh-targets.mjs')).href
