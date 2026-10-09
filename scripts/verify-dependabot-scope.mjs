#!/usr/bin/env node
/**
 * verify-dependabot-scope.mjs — Dependabot 更新 job 的**目标目录范围**守卫（**联网**，sentinel 档）
 *
 * ## 它守什么
 *
 * 断言：**基线之后不存在目标目录未被 `.github/dependabot.yml` 声明的 Dependabot 更新 job**。
 *
 * ## 为什么这条判据等价于「安全更新开关没被重新打开」
 *
 * 这是 D13 的**症状面**。机制（证据链见 `.github/dependabot.yml` 头注释）：
 *
 *   · `dependabot.yml` 的 `updates[].directory` **只**约束*版本更新*（version updates）；
 *   · *安全更新*（security updates）按**告警的 `manifest_path`** 开 job，**完全不读**该文件
 *     —— 官方两处口径 + 2026-10-09 实测（job 1618552559）。
 *
 * 于是「job 的目标目录是否全在 `dependabot.yml` 声明范围内」就成了开关的**直接函数**：
 * 本仓 `dependabot.yml` 只声明了 `/`（npm 与 cargo），而历史**全部 11 个** job 的目标都是
 * `/harness-locks/alpha`（5）· `/harness-locks/next`（4）· `/src-tauri`（2），根目录一个都没有
 * ⇒ 这些 job **只可能由安全更新产生**。
 *
 * 与 `dependabot-setting`（直读开关）互补：
 *   · `dependabot-setting` 读**前提**（开关状态），但要 admin 读权限的令牌才读得到；
 *   · 本守卫读**后果**（已经派生出来的 job），CI 的 `GITHUB_TOKEN` 就能读
 *     （`actions: read`；公开仓库连匿名都可读，实测 http=200）。
 * 后果哨兵**滞后**（要有告警存在、且 Dependabot 跑过），但它是**自动**的；
 * 前提哨兵**即时**，但依赖一个需要人工保管的 secret。两条都留着。
 *
 * ## 为什么需要「基线」而不是「最近 N 天」
 *
 * 关掉开关**不会**让已经跑出来的 job 消失——它们在 Actions 历史里永远留着。
 * 用「最近 14 天」这类滚动窗口会出现两种坏形态：
 *   · 关闭当天起红灯常驻（历史噪声落在窗口内），而那时**恰恰是目标状态**；
 *   · 补救之后红灯仍要挂满整个窗口期 —— 长期无法通过的红灯最后只会被人无视（ADR-030）。
 *
 * 所以窗口左端取**固定基线**（{@link SCOPE_BASELINE_ISO}），右端取「现在」。代价是：
 * 补救（重新关闭开关）之后必须把基线**前移**到补救时刻，否则那条红灯会永久留驻。
 * 这不是缺陷，是**显式记账**：例外要么被记录，要么一直红着。
 *
 * ## 三个出口
 *
 * | 出口 | 触发 | 退出码 | 允许被当成「通过」吗 |
 * |---|---|---|---|
 * | ok | 窗口内 job 的目标目录全在声明范围内（含 0 个 job） | 0 | 是 |
 * | fail | 有 job 落在未声明目录 / job 名解不出目录 / 声明集合为空 / run 清单未扫完 | 1 | 否 |
 * | skip | 取不到 Actions 数据（网络、限流） | 0 | **不算「已核对」**（日志必须写明） |
 *
 * ⚠️ 「job 名解不出目录」**判红而不判 skip**：那意味着 GitHub 改了 job 命名形态、本判据
 * 已经瞎了。判据失效是**我们这边的缺陷**，与「网络取不到」（环境）不同——后者红起来没人
 * 能修，前者红起来有明确修法。本仓对这两类有明确区分（drift 的 slug 404 同理判红）。
 *
 * ⚠️ 「0 个 job」**是** ok，不算「空集冒充通过」：本仓那条纪律防的是「判据覆盖不到任何
 * 东西」，而这里覆盖到了——覆盖到的正是「没有任何 job」这个目标状态。因此日志必须把
 * 「扫到了 0 个」与「根本没去扫」写得**可区分**（后者走 skip，明写「未核对」）。
 *
 * ## 可证伪性
 *
 * `--self-test` 全部离线（不联网），夹具**成对**：同一条 harness-locks job 放在基线**前**
 * 必须被忽略、放在基线**后**必须判红。另有三条防退化断言：空窗不得被判 skip、
 * 名字解不出不得被判 ok、声明集合为空不得被判 ok。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { argv, exit } from 'node:process'

import { repoSlug } from './updater-manifest.mjs'
import { spawnRunner } from './upstream-release.mjs'
import { DEPENDABOT_MANIFESTS, parseDependabotUpdates } from './verify-github-config.mjs'

/** Dependabot 动态工作流的固定 path。**不硬编码数字 id**——id 由清单接口现查，path 自证。 */
export const DEPENDABOT_WORKFLOW_PATH = 'dynamic/dependabot/dependabot-updates'

/**
 * 基线：本仓**关闭**仓库级 Dependabot security updates 之后的时刻。
 *
 * 取 2026-10-09T04:00:00Z —— 严格晚于最后一条已知的 harness-locks job
 * （run 37877934027，`run_started_at` 2026-10-09T03:09:01Z；更早一条 37875039743 在 02:32:13Z），
 * 且实测该时刻之后该动态工作流的 run 数为 **0**。
 *
 * ⚠️ 补救动作的一部分：**重新关闭开关之后必须把它前移到补救时刻**，否则补救前的那些
 * job 仍落在窗口内、红灯永久留驻。
 */
export const SCOPE_BASELINE_ISO = '2026-10-09T04:00:00Z'

/** 最后一条已知的「未声明目录」job 的时刻。自检用它证明基线确实把历史噪声排除在外。 */
export const LAST_KNOWN_BAD_JOB_ISO = '2026-10-09T03:09:01Z'

/** 单次最多翻多少页（每页 100）。超标判红：那意味着开关已经开着很久了。 */
const MAX_PAGES = 5
const PER_PAGE = 100

/**
 * 目录归一：`/` ⇒ 空串（根），`./src-tauri` ⇒ `src-tauri`，`/x/` ⇒ `x`。
 *
 * 两边（`dependabot.yml` 的写法与 job 名里的写法）必须归一到同一个键再比，
 * 否则 `/x` 与 `x` 会被当成两个目录——那会造出假红。
 *
 * @param {string} dir
 * @returns {string}
 */
export function normalizeDir(dir) {
  return String(dir)
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

/** 归一后的目录 → 人读形态（空串是根）。 */
function displayDir(dir) {
  return dir === '' ? '/' : '/' + dir
}

/**
 * 从 Dependabot 更新 job 名里解出 (生态, 目标目录)。
 *
 * 命名形态（实测两个样本）：
 *   `npm_and_yarn in /harness-locks/alpha for @modelcontextprotocol/client - Update #1618552559`
 *   `cargo in /src-tauri for rustls - Update #1613104092`
 *
 * 刻意做成**宽松但可自证失败**：目录必须紧跟在 ` in ` 之后、以 `/` 开头、不含空白；
 * `for …` 段允许含空格（配了 `groups:` 时那里会是组名）。解不出就返回 null，
 * 由 {@link evaluateUpdateJobScope} **判红**（判据失效），不静默放行。
 *
 * @param {unknown} name
 * @returns {{ ecosystem: string, directory: string }|null}
 */
export function parseUpdateJobName(name) {
  if (typeof name !== 'string') return null
  const m = /^(.+?) in (\/\S*) for (.+) - Update #\d+$/.exec(name)
  if (m === null) return null
  return { ecosystem: m[1], directory: m[2] }
}

/**
 * 从 `dependabot.yml` 解出「声明过的目录集合」（归一后的形态）。
 *
 * 复用 {@link parseDependabotUpdates}——**不写第二份 YAML 解析**：那条路已经踩过
 * 「先剥整行注释再判」的坑（说明里逐字引用了被禁目录）。
 *
 * @param {string} text dependabot.yml 全文
 * @param {Record<string, string[]>} [manifests] 生态 → 清单名（用来点名未覆盖生态）
 * @returns {{ dirs: string[], ecosystems: string[], uncovered: string[], problems: string[] }}
 */
export function declaredDirectories(text, manifests = DEPENDABOT_MANIFESTS) {
  const updates = parseDependabotUpdates(text)
  const problems = []
  const dirs = []
  const ecosystems = []
  const uncovered = []
  for (const u of updates) {
    const key = normalizeDir(u.directory)
    if (!dirs.includes(key)) dirs.push(key)
    if (u.ecosystem !== null && !ecosystems.includes(u.ecosystem)) ecosystems.push(u.ecosystem)
    if (u.ecosystem !== null && manifests[u.ecosystem] === undefined && !uncovered.includes(u.ecosystem)) {
      uncovered.push(u.ecosystem)
    }
  }
  if (dirs.length === 0) {
    problems.push(
      'dependabot.yml 里扫出 0 个声明目录——本守卫的对照面是空的，不得判通过。' +
        '扫出数为 0 时先怀疑解析器，再怀疑源码（AGENTS.md §7.3）。',
    )
  }
  return { dirs, ecosystems, uncovered, problems }
}

/**
 * 在 workflow 清单里认出 Dependabot 动态工作流。**三态，且三态互斥**。
 *
 * 不按数字 id 找：id 是 GitHub 分配的不透明数字，而 `path` 是自证的。若动态工作流的
 * path 被改名（`dynamic/dependabot/…` 下出现一个我们不认识的成员），那是判据失效 ⇒
 * 报 `renamed` 让调用方判红，而不是静默返回「没找到 ⇒ 没有 job ⇒ 通过」。
 *
 * @param {unknown} workflows `GET /repos/{owner}/{repo}/actions/workflows` 的 `.workflows`
 * @returns {{ status: 'ok', id: number|string, path: string }
 *   | { status: 'renamed', paths: string[] }
 *   | { status: 'absent' }}
 */
export function pickDependabotWorkflow(workflows) {
  const list = Array.isArray(workflows) ? workflows : []
  const exact = list.find((w) => w && w.path === DEPENDABOT_WORKFLOW_PATH)
  if (exact !== undefined) return { status: 'ok', id: exact.id, path: exact.path }
  const nearMiss = list
    .map((w) => (w && typeof w.path === 'string' ? w.path : null))
    .filter((p) => p !== null && p.startsWith('dynamic/dependabot/'))
  if (nearMiss.length > 0) return { status: 'renamed', paths: nearMiss }
  return { status: 'absent' }
}

/**
 * 纯逻辑判定：由「声明集合 + 窗口内 run 清单」得到结论。
 *
 * **基线过滤在这里做**（而不是只靠 API 的 `created` 参数）：判据只有一份，调用方忘记
 * 加参数也不会得到错的结论；API 侧那个参数只是省流量。
 *
 * `created_at` 解析不出来时**按窗口内处理**（宁可多看一条，不可漏看一条）。
 *
 * @param {{ declared: string[], runs: unknown, baseline: string }} input
 * @returns {{ verdict: 'ok'|'fail'|'skip', reason: string,
 *   checked: number, skippedBeforeBaseline: number,
 *   violations: { name: string, directory: string, createdAt: string, id: unknown }[],
 *   unparsed: { name: string, createdAt: string, id: unknown }[] }}
 */
export function evaluateUpdateJobScope({ declared, runs, baseline }) {
  const empty = { checked: 0, skippedBeforeBaseline: 0, violations: [], unparsed: [] }
  if (!Array.isArray(runs)) {
    return { verdict: 'skip', reason: 'run 清单不是数组 ⇒ 取不到 Actions 数据', ...empty }
  }
  const declaredSet = new Set(Array.isArray(declared) ? declared : [])
  if (declaredSet.size === 0) {
    return { verdict: 'fail', reason: '声明目录集合为空 ⇒ 本判据没有对照面，不得判通过', ...empty }
  }
  const baseMs = Date.parse(baseline)
  if (Number.isNaN(baseMs)) {
    return { verdict: 'fail', reason: '基线不是可解析的时间：' + JSON.stringify(baseline), ...empty }
  }

  let checked = 0
  let skippedBeforeBaseline = 0
  const violations = []
  const unparsed = []
  for (const run of Array.isArray(runs) ? runs : []) {
    const createdAt = run && typeof run.created_at === 'string' ? run.created_at : null
    const at = createdAt === null ? Number.NaN : Date.parse(createdAt)
    if (!Number.isNaN(at) && at < baseMs) {
      skippedBeforeBaseline += 1
      continue
    }
    checked += 1
    const name = run && typeof run.name === 'string' ? run.name : ''
    const id = run ? run.id : undefined
    const parsed = parseUpdateJobName(name)
    if (parsed === null) {
      unparsed.push({ name, createdAt: createdAt ?? '(无创建时间)', id })
      continue
    }
    if (!declaredSet.has(normalizeDir(parsed.directory))) {
      violations.push({ name, directory: parsed.directory, createdAt: createdAt ?? '(无创建时间)', id })
    }
  }

  if (violations.length > 0) {
    return {
      verdict: 'fail',
      reason:
        '窗口内有 ' + violations.length + ' 个 Dependabot 更新 job 落在 dependabot.yml **未声明**的目录：' +
        violations
          .map((v) => '`' + v.directory + '`（' + v.createdAt + '，run ' + String(v.id) + '）')
          .join('、') +
        ' —— 版本更新的目标目录只来自 dependabot.yml，而安全更新按告警的 manifest_path 开 job、' +
        '**不读**该文件（D13）⇒ 这些 job 只可能由**已被重新打开**的 security updates 产生。',
      checked,
      skippedBeforeBaseline,
      violations,
      unparsed,
    }
  }
  if (unparsed.length > 0) {
    return {
      verdict: 'fail',
      reason:
        '窗口内有 ' + unparsed.length + ' 个 job 的名字**解不出目标目录**（判据失效，不得判绿）：' +
        unparsed.map((u) => JSON.stringify(u.name)).join('、') +
        ' —— GitHub 改了 job 命名形态，先修本判据（形状见 parseUpdateJobName 的文档）。',
      checked,
      skippedBeforeBaseline,
      violations,
      unparsed,
    }
  }
  return {
    verdict: 'ok',
    // ⚠️ 只在**真的看到**被滤掉的历史 job 时才提它们：调用方可能已经用 API 的 `created`
    //    参数滤过一遍（main 就是这么做的），此时 skippedBeforeBaseline 恒为 0——
    //    若无条件写「另有 0 个历史 job 不计入」，读起来像「历史上一个都没有」，
    //    而事实是**没去取**。这类「看起来说了话、其实说的是别的」正是本仓的静默形态。
    reason:
      '窗口内 ' + checked + ' 个 Dependabot 更新 job，目标目录全部落在已声明范围内' +
      (skippedBeforeBaseline > 0 ? '（另有 ' + skippedBeforeBaseline + ' 个基线之前的历史 job 未计入）' : ''),
    checked,
    skippedBeforeBaseline,
    violations,
    unparsed,
  }
}

/**
 * 跑一次 `gh api`。**不抛异常**——四态由返回值承载，调用方必须逐个处理。
 *
 * `stdio` 由 {@link spawnRunner} 统一给（`stdin: 'ignore'`）——本机 Windows 下默认的
 * `stdin: 'pipe'` 会让 spawn 直接 `EBUSY`，而失败外表是「取不到远端数据」，
 * 本仓据此误诊过两个月。**不在这里再内联一份 spawnSync**。
 *
 * @param {string[]} args
 * @returns {{ ok: true, json: unknown } | { ok: false, status: number, detail: string, notFound: boolean }}
 */
function ghApiJson(args) {
  const r = spawnRunner('gh', ['api', ...args])
  const stderr = String(r.stderr ?? '').trim()
  const stdout = String(r.stdout ?? '').trim()
  if (r.status !== 0 || (r.error !== null && r.error !== undefined)) {
    const detail = stderr || stdout || String((r.error && r.error.message) || r.error || '未知错误')
    return { ok: false, status: r.status, detail, notFound: /\b404\b|Not Found/i.test(detail) }
  }
  try {
    return { ok: true, json: JSON.parse(stdout) }
  } catch {
    return { ok: false, status: r.status, detail: '返回的不是 JSON：' + stdout.slice(0, 200), notFound: false }
  }
}

function main() {
  const slug = repoSlug()

  // ---- 1. 对照面：dependabot.yml 声明的目录（本地文件，不需联网） ----
  const cfgPath = join(process.cwd(), '.github', 'dependabot.yml')
  let cfgText
  try {
    cfgText = readFileSync(cfgPath, 'utf8')
  } catch {
    console.error('❌ 读不到 .github/dependabot.yml —— 本判据的对照面不存在（配置缺陷，判红）。')
    return 1
  }
  const declared = declaredDirectories(cfgText)
  if (declared.problems.length > 0) {
    for (const p of declared.problems) console.error('❌ ' + p)
    return 1
  }
  console.log(
    '· dependabot.yml 声明目录：' +
      declared.dirs.map(displayDir).join(' ') +
      '（' + declared.dirs.length + ' 个；生态 ' + declared.ecosystems.join(' / ') + '）',
  )
  if (declared.uncovered.length > 0) {
    console.log('· 未登记生态（不判，仅点名）：' + declared.uncovered.join(' / '))
  }
  console.log('· 基线：' + SCOPE_BASELINE_ISO + ' 之后（此前历史 job 不计入）')
  console.log('  ⚠️ 下面的接口调用会带上 created 过滤：历史 job **根本没被取回来**，')
  console.log('     所以判定数里出现 0 是「窗口内确实没有」，不是「历史上一个都没有」。')

  // ---- 2. 认出 Dependabot 动态工作流（path 自证，不硬编码 id） ----
  const wfList = ghApiJson(['repos/' + slug + '/actions/workflows?per_page=100'])
  if (!wfList.ok) {
    if (wfList.notFound) {
      console.error('❌ 取 ' + slug + ' 的 workflow 清单返回 404 —— slug 是本仓写死的常量，这是**配置缺陷**。')
      console.error('   ' + wfList.detail)
      return 1
    }
    console.log('⚠️  取不到 ' + slug + ' 的 workflow 清单 —— **未核对**（这**不等于**已核对）。')
    console.log('   ' + wfList.detail)
    return 0
  }
  const picked = pickDependabotWorkflow(wfList.json && wfList.json.workflows)
  if (picked.status === 'renamed') {
    console.error(
      '❌ `dynamic/dependabot/` 下有本判据不认识的动态工作流：' + picked.paths.join('、') +
        '（期望 ' + DEPENDABOT_WORKFLOW_PATH + '）—— 判据失效，不得判绿。请同步本文件的 DEPENDABOT_WORKFLOW_PATH。',
    )
    return 1
  }
  if (picked.status === 'absent') {
    console.log(
      '⚠️  清单里**没有** ' + DEPENDABOT_WORKFLOW_PATH +
        ' —— 本判据这次**没跑**（**未核对**，不等于已核对）。',
    )
    console.log('   两种可能必须区分：① Dependabot 在本仓完全没在跑（那比目标状态更安全）；')
    console.log('   ② GitHub 改了动态工作流的登记方式（那就是判据失效，需更新 DEPENDABOT_WORKFLOW_PATH）。')
    return 0
  }
  console.log('· 动态工作流：' + picked.path + '（id=' + String(picked.id) + '）')

  // ---- 3. 取该工作流在基线之后的 runs（created 由服务端过滤，省流量；判据不依赖它） ----
  const runs = []
  let pages = 0
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query =
      'per_page=' + PER_PAGE +
      '&created=' + encodeURIComponent('>=' + SCOPE_BASELINE_ISO) +
      '&page=' + page
    const res = ghApiJson(['repos/' + slug + '/actions/workflows/' + String(picked.id) + '/runs?' + query])
    if (!res.ok) {
      if (res.notFound) {
        console.error('❌ 取 runs 返回 404 —— 动态工作流在两次调用之间消失了，这是**形态缺陷**。')
        console.error('   ' + res.detail)
        return 1
      }
      console.log('⚠️  取 runs 失败 —— **未核对**（这**不等于**已核对）。')
      console.log('   ' + res.detail)
      return 0
    }
    const batch = (res.json && Array.isArray(res.json.workflow_runs) ? res.json.workflow_runs : [])
    runs.push(...batch)
    pages = page
    if (batch.length < PER_PAGE) break
  }
  if (runs.length >= MAX_PAGES * PER_PAGE) {
    console.error(
      '❌ 基线之后的 run 数达到上限 ' + String(MAX_PAGES * PER_PAGE) + ' 条仍未扫完 —— 判据失效，不得判绿。' +
        '（通常意味着开关已经开了很久；把 SCOPE_BASELINE_ISO 前移到补救时刻可同时收窄窗口。）',
    )
    return 1
  }
  console.log('· 该工作流基线之后的 run：' + runs.length + ' 条（翻了 ' + pages + ' 页）')

  // ---- 4. 判定 ----
  const result = evaluateUpdateJobScope({
    declared: declared.dirs,
    runs,
    baseline: SCOPE_BASELINE_ISO,
  })
  if (result.verdict === 'fail') {
    console.error('❌ ' + result.reason)
    console.error('   修法：Settings → Advanced Security → 关闭 "Dependabot security updates"。')
    console.error(
      '   补救后把本文件顶部的 SCOPE_BASELINE_ISO 前移到补救时刻，否则这条红灯会永久留驻' +
        '（基线之前的历史 job 不计入，见文件头「为什么需要基线」）。',
    )
    return 1
  }
  if (result.verdict === 'skip') {
    console.log('⚠️  ' + result.reason + ' —— **未核对**（不等于已核对）。')
    return 0
  }
  console.log('✅ ' + result.reason)
  if (result.checked === 0) {
    console.log('   （0 个 job 就是目标状态：开关关着时不会产生任何 Dependabot 更新 job。）')
  }
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

  const declaredRoot = [''] // dependabot.yml 只声明了 `/`
  const badRun = {
    id: 37877934027,
    name: 'npm_and_yarn in /harness-locks/alpha for @modelcontextprotocol/client - Update #1618552559',
    created_at: LAST_KNOWN_BAD_JOB_ISO,
  }
  const goodRun = {
    id: 1,
    name: 'npm_and_yarn in / for lodash - Update #1',
    created_at: '2026-10-09T05:00:00Z',
  }

  // ── 成对夹具 1：同一条 harness-locks job，基线前必须被忽略、基线后必须判红 ──
  const before = evaluateUpdateJobScope({ declared: declaredRoot, runs: [badRun], baseline: SCOPE_BASELINE_ISO })
  check('基线**前**的历史 job 必须被忽略（不得让关闭当天的历史噪声常驻红灯）', before.verdict === 'ok')
  check('被忽略的历史 job 必须计数上报（skippedBeforeBaseline）', before.skippedBeforeBaseline === 1 && before.checked === 0)
  const afterB = evaluateUpdateJobScope({
    declared: declaredRoot,
    runs: [{ ...badRun, created_at: '2026-10-09T05:00:00Z' }],
    baseline: SCOPE_BASELINE_ISO,
  })
  check('基线**后**的同一 job 必须判红（本守卫存在的理由）', afterB.verdict === 'fail')
  check('判红时必须点名目录与 run（可追到具体 job）', /harness-locks\/alpha/.test(afterB.reason) && /37877934027/.test(afterB.reason))
  check('判红时不得把历史计数算进 checked', afterB.checked === 1 && afterB.skippedBeforeBaseline === 0)

  // ── 声明范围内的 job ⇒ ok ──
  const inScope = evaluateUpdateJobScope({ declared: declaredRoot, runs: [goodRun], baseline: SCOPE_BASELINE_ISO })
  check('目标目录已声明的 job 必须 ok（根目录写法 `/` 与归一后的空串等价）', inScope.verdict === 'ok')

  // ── 空窗 ⇒ ok，且必须与 skip 可区分 ──
  const emptyWin = evaluateUpdateJobScope({ declared: declaredRoot, runs: [], baseline: SCOPE_BASELINE_ISO })
  check('空窗必须 ok（关着时的应有状态）', emptyWin.verdict === 'ok')
  check('🔴 空窗**不得**被判 skip（否则「扫到 0 个」会与「没去扫」同形）', emptyWin.verdict !== 'skip')
  check('空窗的 ok 必须明写「0 个」', /窗口内 0 个/.test(emptyWin.reason))
  // 🔴 静默失实专项：main 会用 API 的 `created` 参数先滤一遍，此时 skippedBeforeBaseline
  //    恒为 0。若 ok 文案无条件写「另有 0 个历史 job 不计入」，读起来像「历史上一个都没有」，
  //    而事实是**没去取**——两向都要断言。
  check('基线前的历史 job 被滤掉时，文案必须提它（否则读者以为历史为空）', /另有 1 个基线之前的历史 job 未计入/.test(before.reason))
  check('🔴 没看到历史 job 时，文案**不得**提历史（防「另有 0 个」式静默失实）', !/历史 job 未计入/.test(emptyWin.reason))
  const noRuns = evaluateUpdateJobScope({ declared: declaredRoot, runs: undefined, baseline: SCOPE_BASELINE_ISO })
  check('取不到 run 清单必须 skip（明写未核对）', noRuns.verdict === 'skip')
  check('🔴 取不到时**绝不**判 ok（防判据静默退化成永远通过）', noRuns.verdict !== 'ok')

  // ── 名字解不出 ⇒ 判红（判据失效），不得判 ok / skip ──
  const weird = evaluateUpdateJobScope({
    declared: declaredRoot,
    runs: [{ id: 9, name: 'some brand new job shape', created_at: '2026-10-09T05:00:00Z' }],
    baseline: SCOPE_BASELINE_ISO,
  })
  check('job 名解不出目录 ⇒ 判红（判据失效是可修的缺陷，不许静默）', weird.verdict === 'fail')
  check('判据失效的红必须点名那个名字', /some brand new job shape/.test(weird.reason))
  check('🔴 名字解不出时绝不判 ok', weird.verdict !== 'ok')
  check('非字符串的名字同样走「解不出」这条路', parseUpdateJobName(undefined) === null && parseUpdateJobName(123) === null)

  // ── 声明集合为空 ⇒ 判红（对照面没了） ──
  const noDecl = evaluateUpdateJobScope({ declared: [], runs: [goodRun], baseline: SCOPE_BASELINE_ISO })
  check('声明集合为空 ⇒ 判红（不得因为没有对照面就判通过）', noDecl.verdict === 'fail')
  const badBase = evaluateUpdateJobScope({ declared: declaredRoot, runs: [], baseline: 'not-a-date' })
  check('基线不可解析 ⇒ 判红（不得静默退化成「全部忽略」）', badBase.verdict === 'fail')

  // ── 三条出口互斥且穷尽 ──
  const verdicts = [before.verdict, afterB.verdict, noRuns.verdict]
  check('三条出口必须两两不同（ok/fail/skip 互斥）', new Set(verdicts).size === 3)
  check('出口集合恰为 ok/fail/skip', [...verdicts].sort().join(',') === 'fail,ok,skip')

  // ── 解析器自身的形状（两类实测样本都要认） ──
  check(
    '实测样本 1（npm_and_yarn + 作用域包名）必须解对',
    JSON.stringify(parseUpdateJobName(badRun.name)) ===
      JSON.stringify({ ecosystem: 'npm_and_yarn', directory: '/harness-locks/alpha' }),
  )
  check(
    '实测样本 2（cargo + 简单包名）必须解对',
    JSON.stringify(parseUpdateJobName('cargo in /src-tauri for rustls - Update #1613104092')) ===
      JSON.stringify({ ecosystem: 'cargo', directory: '/src-tauri' }),
  )
  check('根目录形态（`in / for`）必须解对', parseUpdateJobName(goodRun.name)?.directory === '/')
  check('归一：`/`、`./`、`x/`、`/x` 必须收敛到同一批键', normalizeDir('/') === '' && normalizeDir('./') === '' && normalizeDir('/x/') === 'x' && normalizeDir('/x') === 'x')
  check('归一：`./x` 与 `/x` 必须相等（否则会造出假红）', normalizeDir('./x') === normalizeDir('/x'))

  // ── 三个态的识别：ok / renamed / absent ──
  const wfOk = pickDependabotWorkflow([{ id: 349843131, path: DEPENDABOT_WORKFLOW_PATH }])
  check('清单里有目标 path ⇒ ok 并带回 id', wfOk.status === 'ok' && wfOk.id === 349843131)
  const wfRenamed = pickDependabotWorkflow([{ id: 1, path: 'dynamic/dependabot/dependabot-updates-v2' }])
  check('dynamic/dependabot/ 下有陌生成员 ⇒ renamed（判据失效，判红）', wfRenamed.status === 'renamed')
  check('renamed 必须点名那个陌生 path', wfRenamed.paths.includes('dynamic/dependabot/dependabot-updates-v2'))
  check('清单里完全没有 dependabot 动态工作流 ⇒ absent（明写未核对）', pickDependabotWorkflow([{ id: 2, path: '.github/workflows/ci.yml' }]).status === 'absent')
  check('清单不是数组 ⇒ absent（不得抛异常）', pickDependabotWorkflow(undefined).status === 'absent')

  // ── 基线常量自证：必须是合法时间，且严格晚于最后一条已知的坏 job ──
  check('基线必须是可解析的 ISO 时间', !Number.isNaN(Date.parse(SCOPE_BASELINE_ISO)))
  check(
    '🔴 基线必须**严格晚于**最后一条已知的坏 job（否则关闭当天的历史噪声会常驻红灯）',
    Date.parse(SCOPE_BASELINE_ISO) > Date.parse(LAST_KNOWN_BAD_JOB_ISO),
  )

  // ── 真文件自证：仓库内 dependabot.yml 必须能解出声明目录（含根目录） ──
  let realOk = true
  let realDetail = ''
  try {
    const text = readFileSync(join(process.cwd(), '.github', 'dependabot.yml'), 'utf8')
    const d = declaredDirectories(text)
    realOk = d.problems.length === 0 && d.dirs.includes('')
    realDetail = JSON.stringify(d.dirs)
  } catch (error) {
    realOk = false
    realDetail = String(error && error.message ? error.message : error)
  }
  check('真文件自证：仓库内 dependabot.yml 必须通过本解析（含根目录 `/`）—— ' + realDetail, realOk)

  if (failed > 0) {
    console.error('verify-dependabot-scope self-test 失败 ' + failed + ' 项')
    return { passed, failed }
  }
  return { passed, failed }
}

if (import.meta.url === (await import('node:url')).pathToFileURL(argv[1] ?? '').href) {
  if (argv.includes('--self-test')) {
    const { failed, passed } = selfTest()
    if (failed > 0) exit(1)
    console.log('✅ Dependabot 更新 job 范围守卫自测通过（' + passed + ' 项）')
    exit(0)
  } else {
    exit(main())
  }
}
