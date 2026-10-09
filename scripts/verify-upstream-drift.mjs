#!/usr/bin/env node
/**
 * verify-upstream-drift.mjs — 上游 DSH 版本漂移哨兵。
 *
 * ## 为什么存在
 *
 * 本仓库把 `@deepseek-ai/dsh` 的目标版本钉在 `scripts/dsh-targets.mjs`（**唯一产地**；
 * `prepare-harness.mjs` 只是消费方），并在其上按通道叠加 `patch-package` 行级补丁。
 * 上游 DSH 处于灰度迭代期，**明确声明会有破坏性变更**——落后越多，
 * 补丁冲突就越会集中到某一次升级里一起爆发。
 *
 * 这个风险过去是**被动发现**的：等到真的动手升级时才知道有多少补丁冲突。
 * 本脚本把它变成**主动预警**：每次跑（或由 `schedule` 定时跑）就与上游比一次，
 * 落后到阈值就非零退出。
 *
 * ## 🔄 基准 = 上游 **GitHub Release**（计划 2f，2026-10-09 换掉 npm dist-tag）
 *
 * | 基准 | 它回答的问题 | 什么时候动 |
 * |---|---|---|
 * | npm dist-tag（旧基准） | 上游**包分发**指向哪一版 | 走到「发 npm」那一步才动 |
 * | **GitHub Release（现基准）** | 上游**宣布发了哪一版** | tag 一打就动 |
 *
 * 换基准的理由是**实测**的两条：① 同一天内 dist-tag 就前进过一版（滞后可见）；
 * ② 上游出现过「tag 已动、依赖树未齐」的波次（Release 先到，npm 后到）。
 * 想看「上游走到哪了」，Release 更早可见。
 *
 * npm dist-tag **保留为参考段**（打印出来但不参与判定）——它的差值正是「上游还没发 npm」
 * 的可观察证据。取不到时只影响这一段，不影响结论。
 *
 * ⚠️ 上游全部 Release 都是 `prerelease: true` ⇒ **`/releases/latest` 恒 404**，
 * 基准必须「列清单 + 按 semver 取最大」。该陷阱与 tag 形态（`dsh-v<x.y.z>`）的
 * 唯一产地都在 [`upstream-release.mjs`](./upstream-release.mjs)（文件头有实测记录）。
 *
 * ## 判定
 *
 * | 情形 | 判据 | 结果 |
 * |------|------|------|
 * | `minor-behind` | major 或 minor 位落后 | **失败**（exit 1） |
 * | `stage-behind` | 同 major.minor.patch，但上游预发布阶段更晚（如 alpha → rc） | **失败**（exit 1） |
 * | `patch-line-behind` | 同 major.minor，上游 patch 前进**且**预发布阶段回到更早一档 | **失败**（exit 1） |
 * | `patch-behind` | 同 major.minor **且**同阶段，只落后补丁位/阶段内序号 | 仅提示（exit 0） |
 * | `ok` | 持平或领先 | 通过 |
 *
 * ⚠️ `patch-line-behind` 是换基准后**新出现**的形状（旧基准是 dist-tag，一条线内不会
 * 出现「patch 前进 + 阶段回退」）。它**沿用阻断**——与旧口径对该形状的**结果一致**，
 * 只是把归因说准了：旧实现把它报成「上游已进入更晚的预发布阶段」，而事实相反
 * （上游是回退到更早的阶段、同时前进了补丁线）。是否该继续阻断**待重算**（计划 §17 → P0-2）。
 *
 * ## 取不到上游时：SKIP，而不是「通过」
 *
 * 拿不到 Release 清单（`gh` 缺失 / 离线 / 限流）时打印 `SKIP` 并 **exit 0**。
 * 但它**明确不等于「已核对」**：输出里会说清楚这一点，避免「没连上」被读成「没有漂移」。
 * ⚠️ 唯一的例外是 **404**：slug 是本仓写死的常量，404 说明**我们**错了（配置缺陷），
 * 那种情形判红而不是 SKIP。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-upstream-drift.mjs              # 真查上游 Release
 * node scripts/verify-upstream-drift.mjs --self-test  # 纯逻辑 + 无网络分支自检
 * DSH_UPSTREAM_REPO=owner/name node scripts/verify-upstream-drift.mjs
 * ```
 *
 * 退出码：`0` 通过 / 仅提示 / SKIP · `1` 落后到阈值（或上游查询是配置缺陷）。
 */

import { argv, env, exit } from 'node:process'
import { pathToFileURL } from 'node:url'

import { DSH_TARGETS, listTargetNames, resolveTarget, targetForVersion } from './dsh-targets.mjs'
import {
  UPSTREAM_REPO,
  fetchUpstreamReleases,
  pickNewestRelease
} from './upstream-release.mjs'

const PKG = '@deepseek-ai/dsh'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_TIMEOUT_MS = 10000

/** 预发布阶段序：alpha < beta < rc < 正式版。 */
const STAGE_RANK = { alpha: 0, beta: 1, rc: 2 }
const RELEASE_RANK = 3
/**
 * 不认识的预发布标签（如 `canary`）按「较晚」处理。
 * 宁可漏报，也不要把一个不认识的标签误判成「落后」而误报。
 */
const UNKNOWN_PRERELEASE_RANK = 2

/**
 * 解析 semver（仅支持本仓库会遇到的形状，不追求 semver 全集）。
 *
 * @param {string} input 版本串，可带前导 `v`
 * @returns {{major:number,minor:number,patch:number,stage:number,preNumber:number,preRaw:string}|null}
 */
export function parseVersion(input) {
  const raw = String(input ?? '').trim().replace(/^v/i, '')
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw)
  if (!m) return null
  const [, major, minor, patch, pre] = m
  const parsed = {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    stage: RELEASE_RANK,
    preNumber: 0,
    preRaw: pre ?? ''
  }
  if (pre) {
    const tokens = pre.split('.')
    const head = tokens[0].toLowerCase()
    parsed.stage = STAGE_RANK[head] ?? UNKNOWN_PRERELEASE_RANK
    const numeric = /^\d+$/.test(tokens[0]) ? tokens[0] : tokens.find((t) => /^\d+$/.test(t))
    parsed.preNumber = numeric ? Number(numeric) : 0
  }
  return parsed
}

/**
 * 比较两个已解析版本。
 * @returns {-1|0|1} a < b 返回 -1，a === b 返回 0，a > b 返回 1
 */
export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.stage !== b.stage) return a.stage < b.stage ? -1 : 1
  if (a.preNumber !== b.preNumber) return a.preNumber < b.preNumber ? -1 : 1
  return 0
}

/**
 * 若上游出现**非预发布** Release，返回一条指向「等上游」登记的口号（否则 `null`）。
 *
 * 这不是判定，是**指路**：非预发布 Release 正好是 `stable` 线的触发条件，而本仓在这一刻
 * 是**硬阻塞**的（`release-ledger.mjs::composeDesktopVersion()` 对无预发布段的上游直接抛错，
 * 因为 `0.2.1-<n>` 会让合成号的首个预发布标识符变成纯数字）。
 * 登记在 `docs/dsh-upgrade-checklist.md` §6 第 1 条——**散文登记需要一个自动叫号的人**，
 * 否则它会变成一段没人重读的文本（本仓纪律：没有执行者的规矩等于没有规矩）。
 *
 * @param {object[]} releases - {@link fetchUpstreamReleases} 的 `releases`。
 * @returns {string|null}
 */
export function noteStableLineRelease(releases) {
  const stable = (Array.isArray(releases) ? releases : []).filter((release) => release?.prerelease !== true)
  if (stable.length === 0) return null
  const tags = stable.map((release) => release.tag).join('、')
  return (
    `上游出现**非预发布** Release（${tags}）⇒ stable 线的序号载体必须先定：` +
    `见 docs/dsh-upgrade-checklist.md §6 第 1 条（ADR-061 决策 7 的开口；` +
    `composeDesktopVersion() 对无预发布段的上游当前直接抛错，属硬阻塞）。`
  )
}

/** 人类可读的阶段名（报错文案里必须出现**实际**的阶段，不能只写「更晚的一档」）。 */
function stageLabel(parsed) {
  if (parsed.stage === RELEASE_RANK) return '正式版'
  const head = String(parsed.preRaw).split('.')[0]
  return head === '' ? '未知阶段' : head
}

/**
 * 供 `upstream-release.mjs` 的 `pickNewestRelease` 使用的比较器 —— **输入是版本字符串**。
 *
 * 🔴 这个适配器**不可省**，而且它的必要性是**实测抓到的**：`pickNewestRelease` 把
 * `release.version`（字符串）交给比较器，而 {@link compareVersions} 期望的是
 * `parseVersion()` 的结果（对象）。直接把字符串喂进去，每个字段都会是 `undefined`、
 * 逐位比较全部「相等」⇒ 比较退化成返回 `0` ⇒ **「取最新」静默变成「取第一条」**，
 * 而数组顺序来自 GitHub 的返回顺序，不是任何判据。
 * 自测里有一条反证夹具把该退化形态钉住（见 selfTest）。
 *
 * @param {string} a 版本字符串
 * @param {string} b 版本字符串
 * @returns {-1|0|1}
 */
export function compareVersionStrings(a, b) {
  const parsedA = parseVersion(a)
  const parsedB = parseVersion(b)
  if (!parsedA || !parsedB) return 0
  return compareVersions(parsedA, parsedB)
}

/**
 * 判定漂移。纯函数，便于自检。
 *
 * ## 为什么文案要逐位说出「哪一位不同」
 *
 * 旧实现只用 `level` 决定文案，于是 `0.2.0-rc.2` vs `0.2.1-alpha.1` 会被报成
 * 「上游已进入**更晚**的预发布阶段」——而事实是上游**回到**了更早的阶段、同时前进了
 * 补丁线（换基准后才成为高频形状）。**归因错**比不报更坏：它会把排查引到错误的方向。
 *
 * @param {string} currentRaw 仓库钉住的版本
 * @param {string} latestRaw 上游最新 Release 的版本
 * @returns {{ok:boolean, level:string, message:string}}
 */
export function judgeDrift(currentRaw, latestRaw) {
  const current = parseVersion(currentRaw)
  const latest = parseVersion(latestRaw)
  if (!current || !latest) {
    return {
      ok: false,
      level: 'unparsable',
      message: `无法解析版本号（current=${currentRaw} latest=${latestRaw}）`
    }
  }

  if (compareVersions(current, latest) >= 0) {
    return { ok: true, level: 'ok', message: `未落后（${currentRaw} ≥ ${latestRaw}）` }
  }

  // 落后。先看版本位（major/minor）——那是「跨了版本线」。
  if (current.major !== latest.major || current.minor !== latest.minor) {
    return {
      ok: false,
      level: 'minor-behind',
      message: `版本位落后上游（${currentRaw} < ${latestRaw}）——major/minor 已不同`
    }
  }

  const patchAhead = current.patch !== latest.patch
  const stageAhead = latest.stage > current.stage
  const stageBack = latest.stage < current.stage

  if (patchAhead && stageBack) {
    // 上游在同 major.minor 上开了一条**新补丁线**，并回到更早的预发布阶段。
    // 结果沿用阻断（与旧口径一致），但归因必须说准。
    return {
      ok: false,
      level: 'patch-line-behind',
      message:
        `上游已前进到更新的补丁线并回到更早的预发布阶段（${currentRaw} < ${latestRaw}）——` +
        `patch ${current.patch} → ${latest.patch}，阶段 ${stageLabel(current)} → ${stageLabel(latest)}`
    }
  }
  if (stageAhead) {
    // 上游进入了**更晚**的预发布阶段（如 alpha → rc）。补丁位可能同时前进，一并说出。
    return {
      ok: false,
      level: 'stage-behind',
      message:
        `上游已进入更晚的预发布阶段（${currentRaw} < ${latestRaw}）——` +
        (patchAhead ? `patch ${current.patch} → ${latest.patch}，` : '') +
        `阶段 ${stageLabel(current)} → ${stageLabel(latest)}`
    }
  }
  // 同一 major.minor **且**同一阶段：只落后补丁位或阶段内序号——提示，不阻断。
  const detail = patchAhead ? `patch ${current.patch} → ${latest.patch}` : `阶段内序号 ${current.preNumber} → ${latest.preNumber}`
  return {
    ok: true,
    level: 'patch-behind',
    message: `同一预发布阶段内落后（${currentRaw} < ${latestRaw}）——${detail}；提示，不阻断`
  }
}

/**
 * 从源码文本里读 `const DSH_VERSION = '…'` 字面量。
 * ⚠️ **遗留助手**：锚点唯一产地已迁到 `scripts/dsh-targets.mjs`，主流程不再调用它
 * （只由自检夹具覆盖）；新代码请用 `resolveTarget(name).dshVersion`。
 * @param {string} text 文件内容
 * @returns {string|null}
 */
export function readDshVersion(text) {
  const m = /const\s+DSH_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(text ?? '')
  return m ? m[1] : null
}

/**
 * 拼 dist-tags 端点。作用域名不整体编码（registry 接受 `@scope%2Fname` 形式，
 * 把 `@` 也编码成 `%40` 则会被拒），只把 `/` 换成 `%2F`。
 *
 * @param {string} registry registry 根
 * @returns {string}
 */
export function distTagsUrl(registry) {
  return `${String(registry).replace(/\/+$/, '')}/-/package/${PKG.replace('/', '%2F')}/dist-tags`
}

/**
 * 拉取 npm dist-tags —— **仅作参考段**（不参与判定）。
 *
 * 任何取不到的情形都返回 `status: 'skip'`，**不抛异常**：它已经不是基准了，
 * 不该让一个参考段把整次检查弄红。
 *
 * @returns {Promise<{status:'ok',tags:object}|{status:'skip',reason:string}>}
 */
export async function fetchDistTags({
  registry = DEFAULT_REGISTRY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(distTagsUrl(registry), {
      headers: { accept: 'application/json' },
      signal: controller.signal
    })
    if (!res.ok) return { status: 'skip', reason: `registry 返回 HTTP ${res.status}` }
    const tags = await res.json()
    if (!tags || typeof tags !== 'object' || typeof tags.latest !== 'string') {
      return { status: 'skip', reason: 'registry 响应缺少 dist-tags.latest' }
    }
    return { status: 'ok', tags }
  } catch (error) {
    return { status: 'skip', reason: `网络不可达：${error?.message ?? error}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 自检：覆盖四个判定等级 + 解析边界 + 目标表完整性 + 无网络分支。
 * 「无网络」分支用一个必然拒绝连接的地址真跑一次 fetchDistTags。
 */
async function selfTest() {
  let failed = 0
  const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) {
      failed += 1
      console.error(`FAIL ${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
    } else {
      console.log(`PASS ${label}`)
    }
  }

  // 落后（minor 位不同）→ 必须失败
  check('落后 minor → level', judgeDrift('0.1.5', '0.2.0').level, 'minor-behind')
  check('落后 minor → ok=false', judgeDrift('0.1.5', '0.2.0').ok, false)

  // 落后（同版本、更晚的预发布阶段，即「出现新 rc 线」）→ 必须失败
  check('新 rc 线 → level', judgeDrift('0.1.5-alpha.2', '0.1.5-rc.1').level, 'stage-behind')
  check('新 rc 线 → ok=false', judgeDrift('0.1.5-alpha.2', '0.1.5-rc.1').ok, false)

  // 🔴 换基准后成为高频形状：patch 前进 **且** 阶段回退（rc → alpha）。
  //    旧的归因是「上游已进入更晚的预发布阶段」——与事实相反。这里钉住**准确的**归因。
  check('patch 前进 + 阶段回退 → level', judgeDrift('0.2.0-rc.2', '0.2.1-alpha.1').level, 'patch-line-behind')
  check('patch 前进 + 阶段回退 → ok=false（沿用阻断）', judgeDrift('0.2.0-rc.2', '0.2.1-alpha.1').ok, false)
  check(
    'patch 前进 + 阶段回退 → 文案不得称「更晚的阶段」',
    judgeDrift('0.2.0-rc.2', '0.2.1-alpha.1').message.includes('更晚的预发布阶段'),
    false
  )
  check(
    'patch 前进 + 阶段回退 → 文案必须点出两个阶段名',
    ['rc', 'alpha'].every((name) => judgeDrift('0.2.0-rc.2', '0.2.1-alpha.1').message.includes(name)),
    true
  )
  // 同形状的另一个实例（历史真实基线：patch 前进 **且** 阶段前进 alpha → rc）
  check('真实基线 0.1.2-alpha.4 → 0.1.5-rc.1 → level', judgeDrift('0.1.2-alpha.4', '0.1.5-rc.1').level, 'stage-behind')
  check('真实基线 → ok=false', judgeDrift('0.1.2-alpha.4', '0.1.5-rc.1').ok, false)
  // 两者靠「阶段是前进还是回退」区分：同为 patch 前进，阶段方向不同 → 等级不同。
  check(
    '区分：patch 前进 + 阶段前进 ⇒ stage-behind（两者不可混为一谈）',
    [judgeDrift('0.1.2-alpha.4', '0.1.5-rc.1').level, judgeDrift('0.2.0-rc.2', '0.2.1-alpha.1').level],
    ['stage-behind', 'patch-line-behind']
  )

  // 持平 / 领先 → 通过
  check('持平', judgeDrift('0.1.5-rc.1', '0.1.5-rc.1').level, 'ok')
  check('领先', judgeDrift('0.1.6', '0.1.5-rc.1').level, 'ok')

  // 同阶段补丁位/序号落后 → 仅提示（不阻断）
  check('阶段内序号落后 → level', judgeDrift('0.1.5-rc.1', '0.1.5-rc.2').level, 'patch-behind')
  check('阶段内序号落后 → ok=true', judgeDrift('0.1.5-rc.1', '0.1.5-rc.2').ok, true)
  // 🔴 阈值不变的证据：同 major.minor **且同阶段**只落后 patch 位 ⇒ 仍是「仅提示」。
  //    换基准不该顺手把它升成阻断——那会是一次没人裁决过的口径变更。
  check('同阶段只落后 patch → level', judgeDrift('0.2.0-rc.2', '0.2.1-rc.2').level, 'patch-behind')
  check('同阶段只落后 patch → ok=true（仅提示）', judgeDrift('0.2.0-rc.2', '0.2.1-rc.2').ok, true)
  check('同阶段只落后 patch → 文案点出 patch 位', judgeDrift('0.2.0-rc.1', '0.2.1-rc.1').message.includes('patch 0 → 1'), true)
  // 正式线（无预发布段）
  check('正式线落后补丁位 → 仅提示', judgeDrift('0.2.0', '0.2.1').level, 'patch-behind')
  check('正式线落后 minor → 阻断', judgeDrift('0.2.0', '0.3.0').level, 'minor-behind')

  // 解析边界
  check('无法解析', judgeDrift('not-a-version', '0.1.5').level, 'unparsable')
  check('readDshVersion', readDshVersion("const DSH_VERSION = '0.1.2-alpha.4'"), '0.1.2-alpha.4')
  check('readDshVersion(缺失)', readDshVersion('const OTHER = 1'), null)
  check('distTagsUrl', distTagsUrl('https://registry.npmjs.org/'), `https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags`)

  // ---- 基准接线：只有接对了才绿 ----
  // 用一个**真实形态**的上游 Release 清单（2026-10-09 实测截取）验证
  // 「列清单 + 按 semver 取最大 → 判定」。数组顺序刻意打乱：端点返回顺序不是判据。
  const upstreamLike = [
    { tag: 'dsh-v0.2.0-rc.2', version: '0.2.0-rc.2', prerelease: true },
    { tag: 'dsh-v0.1.7-rc.2', version: '0.1.7-rc.2', prerelease: true },
    { tag: 'dsh-v0.2.1-alpha.1', version: '0.2.1-alpha.1', prerelease: true },
    { tag: 'dsh-v0.1.6-alpha.2', version: '0.1.6-alpha.2', prerelease: true }
  ]
  const newest = pickNewestRelease(upstreamLike, compareVersionStrings)
  check('基准接线：取到的是 semver 最大那条（不是数组首条）', newest.version, '0.2.1-alpha.1')
  check('基准接线：顺序颠倒结果不变', pickNewestRelease([...upstreamLike].reverse(), compareVersionStrings).version, '0.2.1-alpha.1')
  check('基准接线：判定用的就是它', judgeDrift('0.2.0-rc.2', newest.version).level, 'patch-line-behind')
  // 反证：若有人把比较器换成「永远返回 0」，就会取到首条 —— 断言它**必须**不等于真最新。
  check('反证：退化比较器会取错（证明这条判据非空转）', pickNewestRelease(upstreamLike, () => 0).version !== '0.2.1-alpha.1', true)
  // 🔴 这条反证记录的是**实际抓到过的接线错**：不解析就直接比较 ⇒ 逐位皆「相等」⇒
  //    「取最新」退化成「取第一条」。它就是「适配器不可省」的可执行证据。
  check('反证：把字符串直接喂给 compareVersions 会退化成取首条', pickNewestRelease(upstreamLike, compareVersions).version, '0.2.0-rc.2')
  check('适配器：确实按 semver 排（alpha.1 的 0.2.1 > rc.2 的 0.2.0）', compareVersionStrings('0.2.1-alpha.1', '0.2.0-rc.2') > 0, true)

  // ---- 「等上游」登记的叫号器（stable 线）----
  // 当前真实状态（2026-10-09 实测）：25 条 Release 全是 prerelease ⇒ 不该叫号。
  check('叫号器：全 prerelease ⇒ 不叫（当前真实状态）', noteStableLineRelease(upstreamLike), null)
  check('叫号器：上游仍是 prerelease ⇒ 不叫', noteStableLineRelease([{ tag: 'dsh-v0.2.0-rc.2', prerelease: true }]), null)
  check('叫号器：空清单 ⇒ 不叫（空集不得冒充结论）', noteStableLineRelease([]), null)
  // 字段缺失时**从严**处理（按「可能不是预发布」算）并叫号：这是**提示**不是阻断，
  // 误报的代价远低于漏报（漏报会让 stable 线在没有任何准备的情况下突然可发）。
  check(
    '叫号器：prerelease 字段缺失 ⇒ 从严叫号（误报便宜、漏报贵）',
    typeof noteStableLineRelease([{ tag: 'dsh-vX' }]) === 'string',
    true
  )
  // 反证：一旦上游发了正式版，必须叫，且必须点名 §6 第 1 条（否则登记页没人会去看）
  const stableNote = noteStableLineRelease([
    { tag: 'dsh-v0.2.1-alpha.1', prerelease: true },
    { tag: 'dsh-v0.2.1', prerelease: false }
  ])
  check('叫号器：出现正式版 ⇒ 必须叫', typeof stableNote === 'string', true)
  check('叫号器：叫的时候必须点名登记页与条目号', [stableNote.includes('dsh-v0.2.1'), stableNote.includes('§6')], [true, true])
  check('叫号器：只点名正式版那一条（不把 prerelease 也列进去）', stableNote.includes('dsh-v0.2.1-alpha.1'), false)

  // 双通道：每个目标都要能被解析、且 channel 是一个真实存在的 npm dist-tag 名。
  // 注意**不能**要求版本后缀等于 channel：上游的 `next` 现在就指向一个 `rc` 版本
  // （dist-tag 是「哪条发布线」，预发布阶段是「这条线走到哪一步了」，两者独立）。
  // 真正要守的是 channel 别写成不存在的 tag——那样参考段会去查一个不存在的名字。
  //
  // 🔴 2026-09-24 解耦后这条更硬：目标的 `channel`（上游 tag）与 `publishChannel`
  //    （桌面 tag 后缀）**本来就不该相等**——`next` 目标的桌面后缀是 `rc` 而
  //    上游 tag 是 `next`。此处因此**删掉了**早先那条「channel 与键一致」的断言：
  //    它当时之所以能过，只是因为字段名恰好撞上，而不是因为存在真实约束。
  check('目标数 ≥ 2（双通道并存）', listTargetNames().length >= 2, true)
  for (const name of listTargetNames()) {
    const t = resolveTarget(name)
    check(`目标 ${name} 的 channel 是已知 dist-tag 名`, ['latest', 'next', 'alpha'].includes(t.channel), true)
    check(`目标 ${name} 的 status 合法`, ['active', 'dormant'].includes(t.status), true)
    // publishChannel 才是桌面后缀，它必须非空且能反查回同一个目标。
    check(`目标 ${name} 的 publishChannel 非空且可反查`, targetForVersion(`9.9.9-${t.publishChannel}.1`), name)
    check(`目标 ${name} 自身不落后于自己`, judgeDrift(t.dshVersion, t.dshVersion).ok, true)
  }
  // 目标状态：休眠/复役都是**有记录的裁定**（ADR-056 → ADR-057），本行把裁定钉在自测里——
  // 若有人改 status 却没走 ADR，这里会红。默认目标必须在役，否则本哨兵对
  // 「该规划升级了吗」永远无可核对的东西。
  check('目标状态：alpha 已复役（ADR-057 修订 ADR-056）', resolveTarget('alpha').status, 'active')
  check('默认目标必须在役', resolveTarget('next').status, 'active')
  // 可伪证性：把 publishChannel 改成上游不存在的值仍应能反查（它不过是本仓命名），
  // 但把 channel 改成不存在的 dist-tag 必须判红——这两条一起守住解耦的两侧。
  check('可伪证性：channel 写成不存在的 dist-tag 必须判红', ['latest', 'next', 'alpha'].includes('rc'), false)

  // 上游 slug 的唯一产地必须非空且是 owner/name（否则 `gh api` 会去查一个畸形路径）
  check('上游 slug 形态', /^[^/\s]+\/[^/\s]+$/.test(UPSTREAM_REPO), true)

  // 无网络 → 参考段必须落到 skip（既不判失败，也不冒充「已核对」）
  const offline = await fetchDistTags({ registry: 'http://127.0.0.1:9', timeoutMs: 1500 })
  check('参考段：无网络 → skip', offline.status, 'skip')

  if (failed > 0) {
    console.error(`verify-upstream-drift self-test: ${failed} 项失败`)
    exit(1)
  }
  console.log('verify-upstream-drift self-test: 全部通过（含无网络 → SKIP 分支）')
}

/** 主流程：各**在役**目标对照「上游最新 Release」检查一次；休眠目标（ADR-056）显式跳过。 */
async function main() {
  if (argv.includes('--self-test')) {
    await selfTest()
    return
  }

  const repo = env.DSH_UPSTREAM_REPO || UPSTREAM_REPO
  const targets = listTargetNames().map((name) => ({
    name,
    // 🔴 这里取的是 `channel`（**上游** npm dist-tag 名），只用于**参考段**与目标表完整性；
    //    基准已换成上游 Release（见文件头）。`next` 目标的桌面后缀是 `rc` 而上游 tag 是 `next`。
    channel: DSH_TARGETS[name].channel,
    status: resolveTarget(name).status,
    current: resolveTarget(name).dshVersion
  }))

  const result = fetchUpstreamReleases({ repo })

  if (result.status !== 'ok') {
    const fatal = result.status === 'error'
    console.log(`[verify:drift] ${fatal ? 'FAIL' : 'SKIP'} —— ${result.reason}`)
    for (const t of targets) console.log(`  ${t.name.padEnd(6)} pinned DSH ${t.current}`)
    if (fatal) {
      console.error('')
      console.error('  上游 slug 是本仓写死的常量（scripts/upstream-release.mjs 的 UPSTREAM_REPO）')
      console.error('  ⇒ 404 / 响应异常是**配置缺陷**，不是「外部状态没准备好」，故判红。')
      exit(1)
    }
    console.log('  ⚠️ SKIP 不等于「已核对」：只是这次没拿到上游 Release，漂移未知。')
    return
  }

  const newest = pickNewestRelease(result.releases, compareVersionStrings)
  console.log('[verify:drift] 上游 DSH 版本漂移检查')
  console.log(`  基准：上游 GitHub Release（${repo}）—— 计划 2f；npm dist-tag 仅作参考`)
  console.log(`  最新 Release：${newest.tag}（${newest.prerelease ? 'prerelease' : 'release'}，${newest.publishedAt ?? '发布时刻未知'}）`)
  console.log(`  参与比较 ${result.releases.length} 条；排除 ${result.ignored.length} 条${result.ignored.length > 0 ? `（例：${result.ignored[0].tag} — ${result.ignored[0].why}）` : ''}`)
  // 「等上游」登记的自动叫号：上游发了正式版 ⇒ 本仓在 stable 线上是**硬阻塞**的。
  const stableNote = noteStableLineRelease(result.releases)
  if (stableNote !== null) console.log(`\n  ⚠️ ${stableNote}`)
  console.log('')

  let blocked = 0
  let needsRework = 0
  // examined：实际被对照的**在役**目标数。休眠目标（ADR-056）显式跳过、不计入；
  // 全部休眠时哨兵无事可做，属配置矛盾（默认目标必须在役），必须报错而不是空转通过。
  let examined = 0
  for (const target of targets) {
    if (target.status === 'dormant') {
      console.log(`  [${target.name}] 🗄️ 已裁定休眠（ADR-056；复役见 ADR-057）——不对照上游漂移`)
      continue
    }
    examined += 1
    const drift = judgeDrift(target.current, newest.version)
    const prefix = `  [${target.name}]`
    if (drift.level === 'patch-behind') {
      console.log(`${prefix} ⚠️  ${drift.message}`)
    } else if (drift.ok) {
      console.log(`${prefix} ✅ ${drift.message}`)
    } else {
      blocked += 1
      if (drift.level === 'patch-line-behind') needsRework += 1
      console.error(`${prefix} ❌ ${drift.message}`)
    }
  }

  // 参考段：npm dist-tag。**不参与判定**，取不到也不影响结论（但必须说出来）。
  const registry = env.DSH_REGISTRY || DEFAULT_REGISTRY
  const timeoutMs = Number(env.DSH_DRIFT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  const tags = await fetchDistTags({ registry, timeoutMs })
  if (tags.status === 'ok') {
    const rendered = ['latest', 'next', 'alpha']
      .filter((name) => typeof tags.tags[name] === 'string')
      .map((name) => `${name}=${tags.tags[name]}`)
      .join('  ')
    console.log(`\n  参考（不参与判定）：npm dist-tags ${rendered}`)
    console.log(`  两个基准的差值就是「上游已宣布但 npm 还没跟上」的那一段——这正是换基准的理由。`)
  } else {
    console.log(`\n  参考（不参与判定）：npm dist-tags 取不到（${tags.reason}）——不影响上面的结论。`)
  }

  if (examined === 0) {
    console.error('  ❌ 没有在役目标可核对——全部休眠时哨兵无事可做，属配置矛盾（默认目标必须在役）。')
    exit(1)
  }

  if (needsRework > 0) {
    console.log('')
    console.log('  ℹ️ 出现 patch-line-behind：上游在**新补丁线**上重新起预发布（patch 前进 + 阶段回退）。')
    console.log('     旧分级阈值（「进入更晚的预发布阶段」才阻断）是按 dist-tag 基准写的；')
    console.log('     换 Release 基准后该形状的定级**待重算**（计划 §17 → P0-2）。本次沿用阻断。')
  }

  if (blocked > 0) {
    console.error('')
    console.error('  上游以破坏性变更迭代；落后越多，补丁冲突越会集中到一次升级里爆发。')
    console.error('  处理步骤见 docs/dsh-upgrade-checklist.md —— 本哨兵只负责「提前叫」。')
    exit(1)
  }
}

// ESM「主模块」判定：仅当被直接执行（而非 import）时跑 CLI。
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main()
}
