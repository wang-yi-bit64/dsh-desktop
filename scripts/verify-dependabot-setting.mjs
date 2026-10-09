#!/usr/bin/env node
/**
 * verify-dependabot-setting.mjs — 仓库级 Dependabot 安全更新开关的**联网**守卫（sentinel 档）
 *
 * ## 它守什么
 *
 * 断言 `security_and_analysis.dependabot_security_updates.status` **不是 `enabled`**。
 *
 * ## 为什么这是一个不变量，而不是个人偏好
 *
 * 依赖图会把 `harness-locks/<target>/package-lock.json` 当成 npm 清单（官方未提供按路径
 * 排除的能力；那目录里只有组装输入快照，旁边**故意没有** package.json）。安全更新一旦
 * 打开，Dependabot 就会为**每一条**落在该目录的告警派生一个更新 job，而它们在**取文件
 * 阶段**就死掉，实测 2026-10-09（job 1618552559）：
 *
 *     Error during file fetching; aborting: /harness-locks/alpha/package.json not found
 *
 * 2026-10-09 裁定：仓库级**关闭**安全更新；告警本身保持可见，按
 * `docs/dsh-upgrade-checklist.md` 跟随上游版本处置。理由与证据链见 `.github/dependabot.yml`
 * 头注释（那里也记录了被实测证伪的旧结论：「只列根目录 ⇒ 排除 harness-locks」）。
 *
 * ## 为什么必须是联网判据
 *
 * 这个开关在**仓库设置**里，与仓库内任何文件无关。打开与关闭都不影响发布链路、不改变
 * 任何产物，因此本地再全的静态扫描也发现不了它被重新打开——只有读远端设置才知道。
 * 这正是 sentinel 档存在的理由（同 drift / update-channel）。
 *
 * ## 三个出口（沿用「矛盾 ⇒ 抛错」与「如实缺失 ⇒ 照常产出」同一条纪律）
 *
 * | 出口 | 触发 | 退出码 | 允许被当成"通过"吗 |
 * |---|---|---|---|
 * | ok | status === 'disabled' | 0 | 是 |
 * | fail | status === 'enabled' | 1 | 否 |
 * | skip | 取不到 / 字段不可见 / 取值不认识 | 0 | **不算"已核对"**（日志必须写明） |
 *
 * ⚠️ skip 为什么**不判红**：`security_and_analysis` 只对有 push 权限的调用者返回，
 * GITHUB_TOKEN 是否可见取决于令牌与仓库设置。把「看不见」判红会造出一台永久红灯，
 * 而本仓对哨兵噪声有明确裁定（ADR-030：长期无法通过的红灯最后只会被人无视）。
 * 但它**绝不判绿**——「未核对」与「已核对且没问题」在日志里必须可区分，否则就是本仓
 * 反复踩过的**假绿**。
 *
 * ⚠️ 唯一的例外：**slug 404 判红**，不 skip。slug 是本仓写死的常量（`repoSlug()`），
 * 它 404 意味着配置或权限出错——那是缺陷，不是「上游没动静」（与 drift 同款裁定）。
 *
 * ## 🔴 诚实边界：**这台检查在 CI 里核不了**（2026-10-09 两次实测）
 *
 * `security_and_analysis` 只对有 push 权限的调用者返回，而 Actions 的 `GITHUB_TOKEN`
 * 没有 push 身份。实测（run 37894060540 / 37894189469）：只给 `contents: read` ⇒ 字段缺席；
 * 再加 `security-events: read` ⇒ **仍然缺席**。
 *
 * 因此本判据的真检查**刻意不进任何分档**（`real.tiers = []` + 总表 `manual` 写明理由），
 * 需要**人工用带 push 权限的令牌**运行。不把它接进 drift.yml 是有意的：那会得到一台
 * 「每周全绿、日志里只写未核对」的 job，而绿色的日志没人看 —— 那等于替一段并不存在的
 * 检查背书（ADR-030 的形态）。恢复条件：仓库配上带 push / administration 读权限的
 * PAT secret 之后，可以把它接回 drift.yml 的**独立 job**（并保留 `echoOutput: true`）。
 *
 * ⚠️ 因此本文件的价值集中在两处：**自检**（进 fast/ci/release，守判定函数本身）
 * 与**人工核验**（开关是否被人重新打开）。别把它当成一台自动哨兵——它不是。
 *
 * ## 可证伪性
 *
 * `--self-test` 的夹具覆盖全部出口，且**成对**：`disabled` 必须 ok、`enabled` 必须 fail；
 * 并且专门有一条断言「字段不可见时**不得**被判成 ok」——防的正是「判据静默退化成永远通过」。
 */
import { execFileSync } from 'node:child_process'
import { argv, exit } from 'node:process'
import { repoSlug } from './updater-manifest.mjs'

/**
 * 纯逻辑判定：由 `GET /repos/{owner}/{repo}` 的响应得到结论。
 *
 * 抽成纯函数是为了可证伪——夹具不必联网、也不必伪造 `gh`。
 *
 * @param {unknown} payload `GET /repos/{owner}/{repo}` 的 JSON 响应（可以是任意值）
 * @returns {{ verdict: 'ok'|'fail'|'skip', reason: string }} 判定与理由
 */
export function evaluateSecurityUpdates(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { verdict: 'skip', reason: '响应不是对象 ⇒ 取不到仓库设置' }
  }
  const analysis = payload.security_and_analysis
  if (analysis === null || analysis === undefined || typeof analysis !== 'object') {
    return {
      verdict: 'skip',
      reason:
        '响应里没有 security_and_analysis —— 该字段只对有 push 权限的调用者返回；' +
        '令牌权限或仓库设置导致它不可见',
    }
  }
  const entry = analysis.dependabot_security_updates
  if (entry === null || entry === undefined || typeof entry !== 'object') {
    return { verdict: 'skip', reason: 'security_and_analysis 里没有 dependabot_security_updates 条目' }
  }
  if (typeof entry.status !== 'string') {
    return {
      verdict: 'skip',
      reason: 'dependabot_security_updates.status 不是字符串：' + JSON.stringify(entry.status),
    }
  }
  if (entry.status === 'disabled') {
    return { verdict: 'ok', reason: '安全更新处于关闭状态（2026-10-09 裁定的目标状态）' }
  }
  if (entry.status === 'enabled') {
    return {
      verdict: 'fail',
      reason:
        '安全更新被打开了 —— 依赖图会把 harness-locks/ 下的锁文件快照当 npm 清单，' +
        '于是每条落在该目录的告警都会派生一个**在取文件阶段必然失败**的更新 job' +
        '（实测报错：Error during file fetching; aborting: /harness-locks/alpha/package.json not found）',
    }
  }
  // 规格里的枚举只有 enabled / disabled；出现别的值说明形态变了，不得猜。
  return {
    verdict: 'skip',
    reason: 'status 取值不在规格枚举（enabled|disabled）内：' + JSON.stringify(entry.status),
  }
}

/** `gh api repos/<slug>` 的调用形状：本机宿主下 `stdin` 必须是 ignore（否则 EBUSY）。 */
function fetchRepoSettings(slug) {
  const raw = execFileSync('gh', ['api', 'repos/' + slug], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  return JSON.parse(raw)
}

function main() {
  const slug = repoSlug()
  let payload
  try {
    payload = fetchRepoSettings(slug)
  } catch (error) {
    const detail = String((error && (error.stderr || error.message)) || error)
    // slug 404 是配置缺陷（slug 写死在 repoSlug()），与 drift 同款裁定 ⇒ 判红，不 skip。
    if (/\b404\b|Not Found/i.test(detail)) {
      console.error('❌ 取 ' + slug + ' 的仓库设置返回 404 —— slug 是本仓写死的常量，这是**配置缺陷**。')
      console.error('   ' + detail.trim())
      return 1
    }
    console.log('⚠️  取不到 ' + slug + ' 的仓库设置 —— **未核对**（这**不等于**已核对）。')
    console.log('   ' + detail.trim())
    return 0
  }

  const { verdict, reason } = evaluateSecurityUpdates(payload)
  if (verdict === 'fail') {
    console.error('❌ ' + reason)
    console.error('   修法：Settings → Advanced Security → 关闭 "Dependabot security updates"。')
    console.error('   裁定与证据链见 .github/dependabot.yml 头注释与 docs/dev-plan-defect-remediation.md。')
    return 1
  }
  if (verdict === 'skip') {
    console.log('⚠️  ' + reason + ' —— **未核对**（不等于已核对）。')
    return 0
  }
  console.log('✅ Dependabot 安全更新：' + reason)
  return 0
}

export function selfTest() {
  let failed = 0
  let passed = 0
  const check = (name, cond) => {
    passed += 1
    if (!cond) {
      console.error('❌ ' + name)
      failed += 1
    }
  }

  // 出口 1/3：关闭 ⇒ ok。
  check(
    '可伪证：status=disabled 必须 ok',
    evaluateSecurityUpdates({ security_and_analysis: { dependabot_security_updates: { status: 'disabled' } } }).verdict === 'ok',
  )
  // 出口 2/3：打开 ⇒ fail（这条是本守卫存在的理由）。
  const enabled = evaluateSecurityUpdates({ security_and_analysis: { dependabot_security_updates: { status: 'enabled' } } })
  check('可伪证：status=enabled 必须 fail（本守卫存在的理由）', enabled.verdict === 'fail')
  check('fail 时必须点名后果（必失败的 job）与实测报错', /必然失败/.test(enabled.reason) && /package.json not found/.test(enabled.reason))
  // 成对：同一夹具不得既 ok 又 fail。
  check(
    '配对：enabled 不得被判成 ok',
    evaluateSecurityUpdates({ security_and_analysis: { dependabot_security_updates: { status: 'enabled' } } }).verdict !== 'ok',
  )
  // 出口 3/3：如实缺失 ⇒ skip（且**不得冒充当 ok**）。
  const cases = [
    ['字段整体缺席', { id: 1, name: 'x' }],
    ['security_and_analysis 为 null', { security_and_analysis: null }],
    ['条目缺席', { security_and_analysis: { secret_scanning: { status: 'enabled' } } }],
    ['status 不是字符串', { security_and_analysis: { dependabot_security_updates: { status: 1 } } }],
    ['status 取值不认识', { security_and_analysis: { dependabot_security_updates: { status: 'paused' } } }],
    ['响应不是对象', 'oops'],
    ['响应是数组', []],
    ['响应是 null', null],
  ]
  for (const [name, payload] of cases) {
    const r = evaluateSecurityUpdates(payload)
    check('可伪证：' + name + ' ⇒ skip（不得冒充已核对）', r.verdict === 'skip')
    check('🔴 ' + name + ' 绝不判 ok（防「判据静默退化成永远通过」）', r.verdict !== 'ok')
    check('skip 必须给出理由', typeof r.reason === 'string' && r.reason.length > 0)
  }
  // 三条出口必须互斥且穷尽。
  const verdicts = [
    evaluateSecurityUpdates({ security_and_analysis: { dependabot_security_updates: { status: 'disabled' } } }).verdict,
    evaluateSecurityUpdates({ security_and_analysis: { dependabot_security_updates: { status: 'enabled' } } }).verdict,
    evaluateSecurityUpdates({}).verdict,
  ]
  check('三条出口必须两两不同（ok/fail/skip 互斥）', new Set(verdicts).size === 3)
  check('出口集合恰为 ok/fail/skip', verdicts.sort().join(',') === 'fail,ok,skip')

  if (failed > 0) {
    console.error('verify-dependabot-setting self-test 失败 ' + failed + ' 项')
    return { passed, failed }
  }
  return { passed, failed }
}

const isDirectRun = await (async () => {
  try {
    const { fileURLToPath } = await import('node:url')
    const { resolve } = await import('node:path')
    return fileURLToPath(import.meta.url) === resolve(argv[1])
  } catch {
    return false
  }
})()

if (isDirectRun) {
  if (argv.includes('--self-test')) {
    const { passed, failed } = selfTest()
    if (failed > 0) exit(1)
    console.log('✅ Dependabot 开关守卫自测通过（' + passed + ' 项）')
    exit(0)
  } else {
    exit(main())
  }
}
