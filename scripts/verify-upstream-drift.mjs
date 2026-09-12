#!/usr/bin/env node
/**
 * verify-upstream-drift.mjs — 上游 DSH 版本漂移哨兵。
 *
 * ## 为什么存在
 *
 * 本仓库把 `@deepseek-ai/dsh` 的版本钉在 `scripts/prepare-harness.mjs` 的
 * `DSH_VERSION`，并在其上叠加 18 个 `patch-package` 行级补丁（见
 * [`docs/dsh-upgrade-checklist.md`](../docs/dsh-upgrade-checklist.md)）。
 * 上游 DSH 处于灰度迭代期，**明确声明会有破坏性变更**——落后越多，
 * 补丁冲突就越会集中到某一次升级里一起爆发。
 *
 * 这个风险过去是**被动发现**的：等到真的动手升级时才知道有多少补丁冲突。
 * 本脚本把它变成**主动预警**：每次跑（或由 `schedule` 定时跑）就与 npm 上的
 * dist-tag 比一次，落后到阈值就非零退出。
 *
 * ## 判定（只有两种情形算「落后到必须处理」）
 *
 * | 情形 | 判据 | 结果 |
 * |------|------|------|
 * | `minor-behind` | major 或 minor 位落后 | **失败**（exit 1） |
 * | `stage-behind` | 同 major.minor，但上游预发布阶段更晚（如 alpha → rc） | **失败**（exit 1） |
 * | `patch-behind` | 同 major.minor **且**同阶段，只落后补丁位 | 仅提示（exit 0） |
 * | `ok` | 持平或领先 | 通过 |
 *
 * ## 网络不可用时：SKIP，而不是「通过」
 *
 * 取不到 dist-tag（离线 / registry 故障）时打印 `SKIP` 并 **exit 0**——与集成测试
 * 找不到 Node 时自行跳过的策略一致。但它**明确不等于「已核对」**：输出里会说清楚
 * 这一点，避免「没连上」被读成「没有漂移」。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-upstream-drift.mjs              # 真查 npm
 * node scripts/verify-upstream-drift.mjs --self-test  # 纯逻辑 + 无网络分支自检
 * DSH_REGISTRY=https://registry.npmmirror.com node scripts/verify-upstream-drift.mjs
 * ```
 *
 * 退出码：`0` 通过 / 仅提示 / SKIP · `1` 落后到阈值 或 读不到 `DSH_VERSION`。
 */

import { readFileSync } from 'node:fs'
import { argv, env, exit } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const prepareScript = join(projectRoot, 'scripts', 'prepare-harness.mjs')

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
 * 判定漂移。纯函数，便于自检。
 *
 * @param {string} currentRaw 仓库钉住的版本
 * @param {string} latestRaw npm `latest` dist-tag
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
  // 落后。先看版本位（major/minor），再看预发布阶段，最后才是纯补丁位。
  if (current.major !== latest.major || current.minor !== latest.minor) {
    return {
      ok: false,
      level: 'minor-behind',
      message: `版本位落后上游（${currentRaw} < ${latestRaw}）——major/minor 已不同`
    }
  }
  if (current.stage !== latest.stage) {
    return {
      ok: false,
      level: 'stage-behind',
      message: `上游已进入更晚的预发布阶段（${currentRaw} < ${latestRaw}）`
    }
  }
  // 同一 major.minor 且同一阶段：只落后补丁位——提示，不阻断。
  return {
    ok: true,
    level: 'patch-behind',
    message: `同一预发布阶段内落后补丁位（${currentRaw} < ${latestRaw}）——提示，不阻断`
  }
}

/**
 * 从 `prepare-harness.mjs` 源码里读 `DSH_VERSION`（版本锚点的唯一产地）。
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
 * 拉取 dist-tags。任何取不到的情形都返回 `status: 'skip'`，**不抛异常**。
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
 * 自检：覆盖 落后 / 持平 / 领先 / 无网络 四态，外加解析边界。
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

  // 本仓库真实场景：0.1.2-alpha.4 vs 0.1.5-rc.1（版本位与阶段同时落后）→ 必须失败
  check('真实基线 → level', judgeDrift('0.1.2-alpha.4', '0.1.5-rc.1').level, 'stage-behind')
  check('真实基线 → ok=false', judgeDrift('0.1.2-alpha.4', '0.1.5-rc.1').ok, false)

  // 持平 / 领先 → 通过
  check('持平', judgeDrift('0.1.5-rc.1', '0.1.5-rc.1').level, 'ok')
  check('领先', judgeDrift('0.1.6', '0.1.5-rc.1').level, 'ok')

  // 同阶段补丁位落后 → 仅提示（不阻断）
  check('补丁位落后 → level', judgeDrift('0.1.5-rc.1', '0.1.5-rc.2').level, 'patch-behind')
  check('补丁位落后 → ok=true', judgeDrift('0.1.5-rc.1', '0.1.5-rc.2').ok, true)

  // 解析边界
  check('无法解析', judgeDrift('not-a-version', '0.1.5').level, 'unparsable')
  check('readDshVersion', readDshVersion("const DSH_VERSION = '0.1.2-alpha.4'"), '0.1.2-alpha.4')
  check('readDshVersion(缺失)', readDshVersion('const OTHER = 1'), null)
  check('distTagsUrl', distTagsUrl('https://registry.npmjs.org/'), `https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags`)

  // 无网络 → 必须落到 skip（既不判失败，也不冒充「已核对」）
  const offline = await fetchDistTags({ registry: 'http://127.0.0.1:9', timeoutMs: 1500 })
  check('无网络 → skip', offline.status, 'skip')

  if (failed > 0) {
    console.error(`verify-upstream-drift self-test: ${failed} 项失败`)
    exit(1)
  }
  console.log('verify-upstream-drift self-test: 全部通过（含无网络 → SKIP 分支）')
}

/** 主流程。 */
async function main() {
  if (argv.includes('--self-test')) {
    await selfTest()
    return
  }

  let text = ''
  try {
    text = readFileSync(prepareScript, 'utf8')
  } catch {
    text = ''
  }
  const current = readDshVersion(text)
  if (!current) {
    console.error('[verify:drift] 无法从 scripts/prepare-harness.mjs 读到 DSH_VERSION')
    exit(1)
  }

  const registry = env.DSH_REGISTRY || DEFAULT_REGISTRY
  const timeoutMs = Number(env.DSH_DRIFT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  const result = await fetchDistTags({ registry, timeoutMs })

  if (result.status !== 'ok') {
    console.log(`[verify:drift] SKIP —— ${result.reason}`)
    console.log(`  pinned DSH_VERSION = ${current}`)
    console.log('  ⚠️ SKIP 不等于「已核对」：只是这次没连上 registry，漂移未知。')
    return
  }

  const { latest, next, alpha } = result.tags
  const drift = judgeDrift(current, latest)

  console.log('[verify:drift] 上游 DSH 版本漂移检查')
  console.log(`  pinned (scripts/prepare-harness.mjs) : ${current}`)
  console.log(`  npm latest                          : ${latest}`)
  if (next) console.log(`  npm next                            : ${next}`)
  if (alpha) console.log(`  npm alpha                           : ${alpha}`)
  console.log('')

  if (drift.level === 'patch-behind') {
    console.log(`  ⚠️  ${drift.message}`)
    return
  }
  if (drift.ok) {
    console.log(`  ✅ ${drift.message}`)
    return
  }

  console.error(`  ❌ ${drift.message}`)
  console.error('  上游以破坏性变更迭代；落后越多，补丁冲突越会集中到一次升级里爆发。')
  console.error('  处理步骤见 docs/dsh-upgrade-checklist.md —— 本哨兵只负责「提前叫」。')
  exit(1)
}

// ESM「主模块」判定：仅当被直接执行（而非 import）时跑 CLI。
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main()
}
