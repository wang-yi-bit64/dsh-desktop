#!/usr/bin/env node
/**
 * verify-dependabot-setting.mjs — 仓库级 Dependabot 安全更新开关的**联网**守卫（sentinel 档）
 *
 * ## 它守什么
 *
 * 断言仓库级 Dependabot security updates **处于关闭状态**。
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
 *
 * ## 两个来源，取「危险优先」的并集
 *
 * | 来源 | 接口 | 权限要求（官方规格原文） |
 * |---|---|---|
 * | 专用端点 | `GET /repos/{owner}/{repo}/automated-security-fixes` | *The authenticated user must have **admin read access** to the repository.* |
 * | 仓库对象字段 | `GET /repos/{owner}/{repo}` 的 `security_and_analysis.dependabot_security_updates.status` | 只对**有 push 权限**的调用者返回 |
 *
 * 两个都读，**不因为其中一个看不见就放弃**：细粒度 PAT 给 `Administration: Read` 时只有
 * 前一个可用，给 `Contents: Write` 时通常两个都可用，而两者要求并不相同。判定规则：
 *
 *   · 任一来源说 `enabled` ⇒ **fail**（两来源互相矛盾时**以危险为准**并明写「矛盾」）；
 *   · 任一来源给出**枚举外**的取值 ⇒ **skip**（形态变了，不得判绿）；
 *   · 至少一个来源说 `disabled` ⇒ **ok**；
 *   · 全部来源都看不见 ⇒ **skip** 并明写「未核对」。
 *
 * ⚠️ skip 为什么**不判红**：看不见是**环境**问题（未配令牌 / 公开仓库的字段可见性），
 * 把「看不见」判红会造出一台永久红灯，而本仓对哨兵噪声有明确裁定（ADR-030：长期无法
 * 通过的红灯最后只会被人无视）。但它**绝不判绿**——「未核对」与「已核对且没问题」在
 * 日志里必须可区分，否则就是本仓反复踩过的**假绿**（因此本门禁带 `echoOutput: true`）。
 *
 * ⚠️ 唯一的例外：**slug 404 判红**，不 skip。slug 是本仓写死的常量（`repoSlug()`），
 * 它 404 意味着配置或权限出错——那是缺陷，不是「上游没动静」（与 drift 同款裁定）。
 *
 * ## 令牌是「配了就不得失效」的：认证类失败判红（2026-10-09 新增）
 *
 * 本判据在 CI 里靠一个 PAT secret 运行。**令牌没配**与**令牌失效**完全是两件事：
 *   · 没配（`GH_TOKEN` 为空）⇒ 环境问题 ⇒ skip（本仓用工作流里的前置步显式拦住它）；
 *   · **配了却认证失败**（401 / `Bad credentials` / 403 / `Resource not accessible`）⇒
 *     **判红**。那种情况下这条检查实际上**一行都没查**，而它此前会静默退化成「未核对」
 *     并全绿——正是本仓最怕的「检查悄悄停摆」。限流（429 / rate limit）不算，
 *     那是暂时的外部状况，走 skip。
 *
 * ## 可证伪性
 *
 * `--self-test` 的夹具覆盖全部出口，且**成对**：`disabled` 必须 ok、`enabled` 必须 fail；
 * 且专门有一条断言「字段不可见时**不得**被判成 ok」——防的正是「判据静默退化成永远通过」。
 * 另有一条断言「两个来源矛盾时必须判红、且理由里要出现『矛盾』字样」。
 */
import { argv, env as processEnv, exit } from 'node:process'

import { repoSlug } from './updater-manifest.mjs'
import { spawnRunner } from './upstream-release.mjs'

/** 判定用的三种证据形态。`invisible` = 这一路看不见；`unrecognized` = 看见了但看不懂。 */
const KIND = { enabled: 'enabled', disabled: 'disabled', invisible: 'invisible', unrecognized: 'unrecognized' }

/**
 * 认证类失败。**只在这一类上**把「提供了令牌却失败」判红——限流是暂时的外部状况。
 *
 * @param {unknown} detail 子进程的 stderr/stdout
 * @returns {boolean}
 */
export function isAuthFailure(detail) {
  return /401|403|Bad credentials|Not authenticated|Resource not accessible|Must have admin|requires authentication/i.test(
    String(detail ?? ''),
  )
}

/** `automated-security-fixes` 端点 → 证据。 */
function evidenceFromAutomatedFixes(payload) {
  if (payload === undefined) return { kind: KIND.invisible, note: '接口未取到（请求失败）' }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { kind: KIND.unrecognized, note: '响应不是对象：' + JSON.stringify(payload).slice(0, 80) }
  }
  if (typeof payload.enabled !== 'boolean') {
    return {
      kind: KIND.unrecognized,
      note: '`enabled` 不是布尔：' + JSON.stringify(payload.enabled) + '（规格里它是 boolean）',
    }
  }
  return {
    kind: payload.enabled ? KIND.enabled : KIND.disabled,
    note: 'enabled=' + String(payload.enabled) + (payload.paused === true ? ' paused=true' : ''),
  }
}

/** `GET /repos/{owner}/{repo}` 的 `security_and_analysis` → 证据。 */
function evidenceFromRepoSettings(payload) {
  if (payload === undefined) return { kind: KIND.invisible, note: '响应未取到（请求失败）' }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { kind: KIND.unrecognized, note: '响应不是对象：' + JSON.stringify(payload).slice(0, 80) }
  }
  const analysis = payload.security_and_analysis
  if (analysis === null || analysis === undefined) {
    return {
      kind: KIND.invisible,
      note: '`security_and_analysis` 缺席 —— 该字段只对**有 push 身份**的调用者返回；令牌权限或仓库设置导致它不可见',
    }
  }
  if (typeof analysis !== 'object' || Array.isArray(analysis)) {
    return { kind: KIND.unrecognized, note: '`security_and_analysis` 不是对象' }
  }
  const entry = analysis.dependabot_security_updates
  if (entry === null || entry === undefined || typeof entry !== 'object') {
    return { kind: KIND.invisible, note: '`security_and_analysis` 里没有 `dependabot_security_updates` 条目' }
  }
  if (typeof entry.status !== 'string') {
    return { kind: KIND.unrecognized, note: '`status` 不是字符串：' + JSON.stringify(entry.status) }
  }
  if (entry.status === 'enabled') return { kind: KIND.enabled, note: 'status=enabled' }
  if (entry.status === 'disabled') return { kind: KIND.disabled, note: 'status=disabled' }
  // 规格里的枚举只有 enabled / disabled；出现别的值说明形态变了，不得猜。
  return { kind: KIND.unrecognized, note: '`status` 取值不在规格枚举（enabled|disabled）内：' + JSON.stringify(entry.status) }
}

/**
 * 纯逻辑判定：由两个来源的响应得到结论。
 *
 * 抽成纯函数是为了可证伪——夹具不必联网、也不必伪造 `gh`。
 *
 * @param {{ automatedSecurityFixes?: unknown, repoSettings?: unknown }} input
 *        未知的响应（请求失败）传 `undefined`，与「响应是 null」区分开。
 * @returns {{ verdict: 'ok'|'fail'|'skip', reason: string,
 *   sources: { name: string, kind: string, note: string }[] }}
 */
export function evaluateSecurityUpdates({ automatedSecurityFixes, repoSettings } = {}) {
  const sources = [
    { name: 'automated-security-fixes', ...evidenceFromAutomatedFixes(automatedSecurityFixes) },
    { name: 'repo.security_and_analysis', ...evidenceFromRepoSettings(repoSettings) },
  ]
  const pick = (k) => sources.filter((s) => s.kind === k)
  const enabled = pick(KIND.enabled)
  const disabled = pick(KIND.disabled)
  const unrecognized = pick(KIND.unrecognized)

  const negation =
    '依赖图会把 harness-locks/ 下的锁文件快照当 npm 清单，于是每条落在该目录的告警都会派生一个' +
    '**在取文件阶段必然失败**的更新 job（实测报错：Error during file fetching; aborting: ' +
    '/harness-locks/alpha/package.json not found）。'

  if (enabled.length > 0) {
    const names = enabled.map((s) => '`' + s.name + '`（' + s.note + '）').join('、')
    const contradiction =
      disabled.length > 0
        ? '⚠️ 两个来源**互相矛盾**：另有 ' +
          disabled.map((s) => '`' + s.name + '`').join('、') +
          ' 报告已关闭。以危险的一侧为准判红，请人工确认后再依据事实修正判据。'
        : ''
    return {
      verdict: 'fail',
      reason: '安全更新被打开了（来源：' + names + '）。' + negation + contradiction,
      sources,
    }
  }
  if (unrecognized.length > 0) {
    return {
      verdict: 'skip',
      reason:
        '有来源给出了本判据**不认识**的形态（' +
        unrecognized.map((s) => '`' + s.name + '`：' + s.note).join('、') +
        '）—— 形态变了就可能漏报开着的情况，故**不得判绿**；请先修本判据。',
      sources,
    }
  }
  if (disabled.length > 0) {
    return {
      verdict: 'ok',
      reason:
        '安全更新处于关闭状态（2026-10-09 裁定的目标状态）。来源：' +
        disabled.map((s) => '`' + s.name + '`').join('、') +
        '；本次看不见的来源 ' +
        String(sources.length - disabled.length) +
        ' 个（见下方逐来源明细）。',
      sources,
    }
  }
  return {
    verdict: 'skip',
    reason:
      '两个来源**都**没给出可用证据 —— **未核对**（这**不等于**已核对）。' +
      '`automated-security-fixes` 需要 admin 读权限（规格原文），`security_and_analysis` 只对有 push 身份的调用者返回。',
    sources,
  }
}

/**
 * 跑一次 `gh api`。**不抛异常**——失败由返回值承载。
 *
 * `stdio` 由 {@link spawnRunner} 统一给（`stdin: 'ignore'`）：本机 Windows 下默认的
 * `stdin: 'pipe'` 会让 spawn 直接 `EBUSY`，而失败外表是「取不到远端设置」。
 *
 * @param {string} path
 * @returns {{ ok: true, json: unknown }
 *   | { ok: false, status: number|string, detail: string, notFound: boolean, authFailure: boolean }}
 */
function ghApiJson(path) {
  const r = spawnRunner('gh', ['api', path])
  const stderr = String(r.stderr ?? '').trim()
  const stdout = String(r.stdout ?? '').trim()
  if (r.status !== 0) {
    const detail = stderr || stdout || String((r.error && r.error.message) || r.error || '未知错误')
    return {
      ok: false,
      status: r.status,
      detail,
      notFound: /\b404\b|Not Found/i.test(detail),
      authFailure: isAuthFailure(detail),
    }
  }
  try {
    return { ok: true, json: JSON.parse(stdout) }
  } catch {
    return { ok: false, status: r.status, detail: '返回的不是 JSON：' + stdout.slice(0, 200), notFound: false, authFailure: false }
  }
}

function main() {
  const slug = repoSlug()
  const tokenProvided = String(processEnv.GH_TOKEN ?? '').trim().length > 0

  const fixes = ghApiJson('repos/' + slug + '/automated-security-fixes')
  const repo = ghApiJson('repos/' + slug)

  // slug 404 是配置缺陷（slug 写死在 repoSlug()），与 drift 同款裁定 ⇒ 判红，不 skip。
  // 只对**仓库本体**接口这么判：专用端点 404 可能有别的含义（该端点对本仓不适用），
  // 那时另一路仍可提供证据。
  if (!repo.ok && repo.notFound) {
    console.error('❌ 取 ' + slug + ' 的仓库设置返回 404 —— slug 是本仓写死的常量，这是**配置缺陷**。')
    console.error('   ' + repo.detail)
    return 1
  }

  // 🔴 配了令牌却认证失败 ⇒ 判红：那条检查实际上**一行都没查**，不许静默退化（文件头）。
  const authProblem = [fixes, repo].find((x) => !x.ok && x.authFailure)
  if (authProblem && tokenProvided) {
    console.error('❌ 提供了令牌（GH_TOKEN 非空）却认证/授权失败 —— 这条检查**实际上没跑**，不得判绿。')
    console.error('   ' + authProblem.detail)
    console.error('   修法：确认 secret（细粒度 PAT 需 Administration: Read）未过期、未被撤销；')
    console.error('   或按 .github/workflows/drift.yml 里的说明改回人工运行并撤掉该 job。')
    return 1
  }

  const { verdict, reason, sources } = evaluateSecurityUpdates({
    automatedSecurityFixes: fixes.ok ? fixes.json : undefined,
    repoSettings: repo.ok ? repo.json : undefined,
  })

  // 逐来源明细：**成功时也要看得见**（echoOutput）。「哪一路看得见、哪一路看不见」
  // 是这个判据最容易悄悄退化的一环——它决定了 ok 到底是几条证据支持出来的。
  console.log('· 令牌：' + (tokenProvided ? '已提供（GH_TOKEN 非空）' : '未提供（本次按匿名/本机登录态执行）'))
  for (const source of sources) {
    const mark =
      source.kind === KIND.disabled
        ? '关闭'
        : source.kind === KIND.enabled
          ? '❗打开'
          : source.kind === KIND.invisible
            ? '看不见'
            : '形态不认识'
    console.log('· ' + source.name + '：' + mark + ' —— ' + source.note)
  }
  if (!fixes.ok) console.log('  （automated-security-fixes 请求失败：' + fixes.detail + '）')
  if (!repo.ok) console.log('  （仓库设置请求失败：' + repo.detail + '）')

  if (verdict === 'fail') {
    console.error('❌ ' + reason)
    console.error('   修法：Settings → Advanced Security → 关闭 "Dependabot security updates"。')
    console.error('   裁定与证据链见 .github/dependabot.yml 头注释与 docs/dev-plan-defect-remediation.md（D13）。')
    return 1
  }
  if (verdict === 'skip') {
    console.log('⚠️  ' + reason)
    return 0
  }
  console.log('✅ Dependabot 安全更新：' + reason)
  return 0
}

export function selfTest() {
  let passed = 0
  let failed = 0
  const check = (name, cond) => {
    passed += 1
    if (!cond) {
      failed += 1
      console.error('❌ ' + name)
    }
  }

  const fixesDisabled = { enabled: false, paused: false }
  const fixesEnabled = { enabled: true, paused: false }
  const repoDisabled = { security_and_analysis: { dependabot_security_updates: { status: 'disabled' } } }
  const repoEnabled = { security_and_analysis: { dependabot_security_updates: { status: 'enabled' } } }

  // ── 出口 1/3：关闭 ⇒ ok。**两路各自的可用性都要能独立撑起 ok** ──
  check('只有 automated-security-fixes 可见 ⇒ 必须 ok', evaluateSecurityUpdates({ automatedSecurityFixes: fixesDisabled }).verdict === 'ok')
  check('只有 security_and_analysis 可见 ⇒ 必须 ok', evaluateSecurityUpdates({ repoSettings: repoDisabled }).verdict === 'ok')
  const bothOff = evaluateSecurityUpdates({ automatedSecurityFixes: fixesDisabled, repoSettings: repoDisabled })
  check('两个来源都可见且都关闭 ⇒ ok，且 reason 必须点名用了几个来源', bothOff.verdict === 'ok' && /来源/.test(bothOff.reason))
  check('ok 时必须逐来源给出明细（几路看得见）', bothOff.sources.length === 2)

  // ── 出口 2/3：打开 ⇒ fail（这条是本守卫存在的理由）。任一路看到都算 ──
  const onlyFixesOn = evaluateSecurityUpdates({ automatedSecurityFixes: fixesEnabled })
  check('只有 automated-security-fixes 说打开 ⇒ fail', onlyFixesOn.verdict === 'fail')
  check('automated-security-fixes 说打开时必须点名该来源', /automated-security-fixes/.test(onlyFixesOn.reason))
  const onlyRepoOn = evaluateSecurityUpdates({ repoSettings: repoEnabled })
  check('只有 security_and_analysis 说打开 ⇒ fail', onlyRepoOn.verdict === 'fail')
  check('fail 时必须点名后果（必失败的 job）与实测报错', /必然失败/.test(onlyRepoOn.reason) && /package.json not found/.test(onlyRepoOn.reason))
  check(
    '配对：enabled 不得被判成 ok',
    evaluateSecurityUpdates({ automatedSecurityFixes: fixesEnabled, repoSettings: repoEnabled }).verdict !== 'ok',
  )
  // 矛盾：以危险的一侧为准，且必须明写「矛盾」——否则读者会以为是单来源结论。
  const contradiction = evaluateSecurityUpdates({ automatedSecurityFixes: fixesEnabled, repoSettings: repoDisabled })
  check('🔴 两来源矛盾 ⇒ 必须判红（危险优先）', contradiction.verdict === 'fail')
  check('🔴 矛盾时理由必须明写「矛盾」，不得伪装成一致结论', /矛盾/.test(contradiction.reason))

  // ── 出口 3/3：如实缺失 ⇒ skip（且**不得冒充当 ok**） ──
  const invisibleCases = [
    ['两路都缺席', {}],
    ['security_and_analysis 缺席', { repoSettings: { id: 1, name: 'x' } }],
    ['security_and_analysis 为 null', { repoSettings: { security_and_analysis: null } }],
    ['条目缺席', { repoSettings: { security_and_analysis: { secret_scanning: { status: 'enabled' } } } }],
  ]
  for (const [name, input] of invisibleCases) {
    const r = evaluateSecurityUpdates(input)
    check('可伪证：' + name + ' ⇒ skip（不得冒充已核对）', r.verdict === 'skip')
    check('🔴 ' + name + ' 绝不判 ok（防「判据静默退化成永远通过」）', r.verdict !== 'ok')
    check('skip 必须给出理由', typeof r.reason === 'string' && r.reason.length > 0)
  }

  // ── 形态变了（看得见但看不懂）⇒ skip，且与「看不见」可区分 ──
  const unrecognizedCases = [
    ['automated-security-fixes 的 enabled 不是布尔', { automatedSecurityFixes: { enabled: 'false' } }],
    ['status 取值不认识', { repoSettings: { security_and_analysis: { dependabot_security_updates: { status: 'paused' } } } }],
    ['status 不是字符串', { repoSettings: { security_and_analysis: { dependabot_security_updates: { status: 1 } } } }],
    ['响应变成数组', { automatedSecurityFixes: [] }],
  ]
  for (const [name, input] of unrecognizedCases) {
    const r = evaluateSecurityUpdates(input)
    check('可伪证：' + name + ' ⇒ skip（不得判绿）', r.verdict === 'skip')
    check('🔴 ' + name + ' 绝不判 ok', r.verdict !== 'ok')
    check('形态不明的 skip 必须说「不认识」而不是「看不见」', /不认识/.test(r.reason))
  }
  // 一路看不懂、另一路说关闭 ⇒ 仍然不得判绿（看不懂那一路可能正藏着 enabled）。
  const oneBlind = evaluateSecurityUpdates({ automatedSecurityFixes: { enabled: 'false' }, repoSettings: repoDisabled })
  check('🔴 一路形态不认识、另一路说关闭 ⇒ 仍不得判 ok（不许让瞎掉的一路被忽略）', oneBlind.verdict !== 'ok')

  // ── 三条出口必须互斥且穷尽 ──
  const verdicts = [
    evaluateSecurityUpdates({ automatedSecurityFixes: fixesDisabled }).verdict,
    evaluateSecurityUpdates({ automatedSecurityFixes: fixesEnabled }).verdict,
    evaluateSecurityUpdates({}).verdict,
  ]
  check('三条出口必须两两不同（ok/fail/skip 互斥）', new Set(verdicts).size === 3)
  check('出口集合恰为 ok/fail/skip', [...verdicts].sort().join(',') === 'fail,ok,skip')

  // ── 认证类失败 vs 限流：前者判红，后者只是暂时状况 ──
  check('401 / Bad credentials 必须算认证失败', isAuthFailure('gh: Bad credentials (HTTP 401)'))
  check('403 / Resource not accessible 必须算认证失败（PAT 权限不足是缺陷）', isAuthFailure('HTTP 403: Resource not accessible by personal access token'))
  check('404 Not Found 不算认证失败（由 slug 404 那条路单独判红）', !isAuthFailure('gh: Not Found (HTTP 404)'))
  check('限流不算认证失败（暂时状况 ⇒ skip，不造永久红灯）', !isAuthFailure('API rate limit exceeded for 1.2.3.4 (HTTP 429)'))

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
