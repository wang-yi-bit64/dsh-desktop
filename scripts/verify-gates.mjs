#!/usr/bin/env node
/**
 * verify-gates.mjs — 门禁总表自身的守卫（2026-10-03 治理 G1）。
 *
 * ## 守什么
 *
 * | 编号 | 检查 | 级别 |
 * |------|------|------|
 * | M1 | 总表里每个门禁的 script 都必须真实存在 | 错误 |
 * | M2 | 每个分档解析出的步数必须 > 0；每个门禁要么进至少一个分档、要么带理由声明为人工 | 错误 |
 * | M3 | scripts/ 下**每个支持 --self-test 的脚本**都必须在总表里登记，或在豁免表里带理由（且扫出数必须 > 0） | 错误 |
 * | M4 | 旧名兼容：每个门禁都能被 verify:<name> / <name>:self-test 解析到 | 错误 |
 * | M5 | 门禁名不得重复 | 错误 |
 * | M6 | 门禁条目的字段必须来自白名单（可选字段拼错会静默失效） | 错误 |
 *
 * ## 为什么需要它（真实事故形态）
 *
 * 「写了守卫但没人跑」在 2026-10-03 被逐条核实：verify:unwrap-hygiene 的**真检查**
 * 不在任何流程里（缺陷治理台账却写着「逐行由它盯着」）、verify:doc-facts 与
 * verify:github-config 与 verify:fault-patterns 只在本地跑、CI 完全不跑——
 * 而三份手抄清单谁也不会因为漏抄一项而报错。
 *
 * M3 就是「扫出数必须 > 0」纪律在**编排层**的落地（AGENTS §7.3 / E5-空）：
 * 只断言「扫到的都合规」会容忍「一个都没扫到」，那等于门禁替一段不存在的检查背书。
 *
 * ⚠️ M3 的扫描式**必须是 CLI 形态**而不是「文件里出现该字符串」——后者会把
 * prepare-harness.mjs 里那句注释（「CI 的 --self-test 才是硬门禁」）当成一个
 * 自检模式。自测里的夹具 3 专门钉住这一点。
 *
 * ## 用法
 *
 *   node scripts/verify-gates.mjs              # 校验真实总表
 *   node scripts/verify-gates.mjs --self-test  # 自测（含可伪证夹具）
 *
 * 退出码：0 通过 · 1 有漂移 / 自测失败。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { argv, exit } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ALLOWED_GATE_FIELDS,
  EXEMPT_SELF_TEST_SCRIPTS,
  GATES,
  SELF_TEST_CLI_PATTERN,
  TIERS,
  autoRunTiers,
  gateByName,
  normalizeGateName,
  resolveTier
} from './gate-manifest.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// 纯逻辑层（自测只吃这些；不碰文件系统）
// ---------------------------------------------------------------------------

/** M1：每个门禁的 script 必须存在。 */
export function checkScriptsExist(gates, exists) {
  const problems = []
  for (const gate of gates) {
    if (!exists(gate.script)) problems.push('门禁 ' + gate.name + ' 指向 ' + gate.script + '，但该文件不存在')
  }
  if (gates.length === 0) problems.push('总表里一条门禁都没有——先怀疑读取端，再怀疑源文件')
  return problems
}

/**
 * M2：分档覆盖。tiersOf 返回某分档的步骤数（真实调用传 resolveTier(...).length）。
 * 另：每条门禁必须「进过至少一个分档」或「声明为人工（manual 字段非空）」。
 */
export function checkTierCoverage(gates, tiers, stepsOfTier) {
  const problems = []
  for (const tier of tiers) {
    const n = stepsOfTier(tier)
    if (n === 0) problems.push('分档 ' + tier + ' 解析出 0 步——清单空了或分档名写错了（扫出数为 0 时先怀疑扫描端）')
  }
  for (const gate of gates) {
    if (gate.real === null && gate.selfTest === null) {
      problems.push('门禁 ' + gate.name + ' 既没有真检查也没有自检——登记了一条不检查任何东西的门禁')
      continue
    }
    for (const [mode, spec] of [
      ['真检查', gate.real],
      ['自检', gate.selfTest]
    ]) {
      if (spec === null || spec === undefined) continue
      if ((spec.tiers ?? []).length > 0) continue
      if (gate.manual) continue
      problems.push(
        '门禁 ' + gate.name + ' 的' + mode + '不在任何分档里，也没有 manual 理由——' +
          '这正是「守卫写了却没人跑」的入口（要不进分档，要不写清为什么只人工跑）'
      )
    }
  }
  return problems
}

/**
 * M3 第一步：从 { 相对路径: 内容 } 里扫出**支持 --self-test 的脚本**。
 * 判定式是 CLI 形态（SELF_TEST_CLI_PATTERN），不是字符串包含。
 */
export function scanSelfTestScripts(entries) {
  const out = []
  for (const [path, text] of Object.entries(entries)) {
    if (SELF_TEST_CLI_PATTERN.test(text)) out.push(path)
  }
  return out.sort()
}

/** M3 第二步：扫出的脚本必须「登记（该脚本的某个门禁有 selfTest）」或「带理由豁免」。 */
export function checkSelfTestRegistration(scanned, gates, exempt) {
  const problems = []
  if (scanned.length === 0) {
    problems.push('scripts/ 下一个支持 --self-test 的脚本都没扫到——先怀疑扫描端（判定式变了），再怀疑仓库')
    return problems
  }
  const registered = new Set()
  for (const gate of gates) {
    if (gate.selfTest !== null && gate.selfTest !== undefined) registered.add(gate.script)
  }
  const exempted = new Map(exempt.map((e) => [e.script, e.reason]))
  for (const script of scanned) {
    if (registered.has(script)) continue
    const reason = exempted.get(script)
    if (reason === undefined) {
      problems.push(
        script + ' 支持 --self-test，但既不在 gate-manifest.mjs 的 GATES 里登记，也不在 EXEMPT_SELF_TEST_SCRIPTS 里带理由豁免' +
          '——这正是「守卫写了却没人跑」的入口'
      )
      continue
    }
    if (String(reason).trim().length < 8) problems.push(script + ' 的豁免理由太短，等于没写')
  }
  for (const entry of exempt) {
    if (!scanned.includes(entry.script)) {
      problems.push('豁免表里的 ' + entry.script + ' 并不支持 --self-test（或已删除）——豁免条目必须随事实收敛')
    }
  }
  return problems
}

/** M4：旧名兼容。每个门禁的 verify:<name> / <name>:self-test 都必须解析回它自己。 */
export function checkLegacyAliases(gates, normalize) {
  const problems = []
  for (const gate of gates) {
    const plain = normalize('verify:' + gate.name)
    if (plain.error || plain.name !== gate.name || plain.selfTest) {
      problems.push('旧名 verify:' + gate.name + ' 解析异常：' + JSON.stringify(plain))
    }
    const self = normalize(gate.name + ':self-test')
    if (self.error || self.name !== gate.name || !self.selfTest) {
      problems.push('旧名 ' + gate.name + ':self-test 解析异常：' + JSON.stringify(self))
    }
  }
  return problems
}

/** M5：门禁名唯一。 */
export function checkUniqueNames(gates) {
  const seen = new Set()
  const problems = []
  for (const gate of gates) {
    if (seen.has(gate.name)) problems.push('门禁名重复：' + gate.name + '——同名门禁会让旧名解析到错的那一条')
    seen.add(gate.name)
  }
  return problems
}

/**
 * M6：门禁条目的字段必须来自白名单（2026-10-09 新增，治 D13 的衍生缺口）。
 *
 * 为什么需要：总表里的可选字段（`echoOutput` / `manual` / `platforms` / `needsAssembly`）
 * 都是**布尔或存在性开关**，读的是 `gate.foo === true` 这类判定。于是拼错一个字母
 * （`echoOutpt`）不会报任何错——那一条**静默失效**，而它的语义（「成功也要回显」）
 * 恰恰是用来消除「静默」的。这属于本仓反复出现的「配置看着在、实际不生效」一类。
 *
 * ⚠️ 只判**未知字段名**，不判字段取值：取值语义由各自的消费者负责。
 * 新字段要进白名单，必须同时更新 gate-manifest 的文件头字段表——那是有意的摩擦。
 *
 * @param {{name: string}[]} gates
 * @param {string[]} [allowed] 允许的字段名；默认 {@link ALLOWED_GATE_FIELDS}
 * @returns {string[]}
 */
export function checkUnknownFields(gates, allowed = ALLOWED_GATE_FIELDS) {
  const problems = []
  for (const gate of gates) {
    for (const key of Object.keys(gate)) {
      if (allowed.includes(key)) continue
      problems.push(
        '门禁 ' + gate.name + ' 有未知字段 `' + key + '`——可选字段多为布尔开关，拼错即**静默失效**' +
          '（读的是 `=== true`）。允许的字段：' + allowed.join(' / ') + '。',
      )
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// 自测（纯内存夹具；不读仓库文件）
// ---------------------------------------------------------------------------

function selfTest() {
  let passed = 0
  const failures = []
  const ok = (name, condition) => {
    if (condition) passed += 1
    else failures.push(name)
  }
  const gate = (name, extra = {}) => ({
    name,
    script: 'scripts/' + name + '.mjs',
    real: { tiers: ['fast'], args: [] },
    selfTest: { tiers: ['fast'], args: ['--self-test'] },
    ...extra
  })

  // --- 夹具 1：M1 文件存在性 ---
  const gates1 = [gate('a'), gate('b')]
  ok('M1：都存在 → 无问题', checkScriptsExist(gates1, () => true).length === 0)
  const missing = checkScriptsExist(gates1, (p) => p !== 'scripts/b.mjs')
  ok('M1：缺文件必须判红', missing.length === 1 && missing[0].includes('scripts/b.mjs'))
  ok('M1：空表必须判红（扫出数为 0 不得全绿）', checkScriptsExist([], () => true).length === 1)

  // --- 夹具 2：M2 分档覆盖 ---
  const stepsOf = (n) => () => n
  ok('M2：每档都有步 → 无问题', checkTierCoverage(gates1, ['fast'], stepsOf(2)).length === 0)
  ok('M2：某档 0 步必须判红', checkTierCoverage(gates1, ['fast', 'ci'], (t) => (t === 'ci' ? 0 : 2)).some((p) => p.includes('ci')))
  const orphan = gate('orphan', { real: null, selfTest: null })
  ok('M2：门禁不在任何分档且无 manual 理由 → 判红', checkTierCoverage([orphan], ['fast'], stepsOf(0)).some((p) => p.includes('orphan')))
  const manualGate = gate('manual-one', { real: null, selfTest: { tiers: [], args: ['--self-test'] }, manual: '只能人工跑，需真机窗口' })
  ok('M2：带 manual 理由的人工门禁 → 放行', checkTierCoverage([manualGate], ['fast'], stepsOf(1)).length === 0)
  // 加强（2026-10-03）：**某一种模式**不在任何分档里同样必须解释。真检查悄悄从
  // 分档里掉出去、只剩自检在跑，正是「守卫写了却没人跑」的形态（unwrap-hygiene 的
  // 真检查就是这么丢了很久）。
  const realOrphan = gate('real-orphan', { real: { tiers: [], args: [] } })
  ok('M2：真检查不在任何分档且无 manual → 判红', checkTierCoverage([realOrphan], ['fast'], stepsOf(1)).some((p) => p.includes('真检查')))
  const realManual = gate('real-manual', { real: { tiers: [], args: [] }, manual: '需组装树，由 release.yml 按名点名' })
  ok('M2：真检查不在分档但有 manual 理由 → 放行', checkTierCoverage([realManual], ['fast'], stepsOf(1)).length === 0)

  // --- 夹具 3：M3 扫描式必须认 CLI 形态，不认注释里的字符串 ---
  const commentOnly = '#!/usr/bin/env node\n// 分级表漂移不阻断组装（CI 的 \u0060--self-test\u0060 才是硬门禁）\n'
  ok('M3：注释里提到 --self-test **不算**自检模式', scanSelfTestScripts({ 'scripts/prepare-harness.mjs': commentOnly }).length === 0)
  const realCli = 'if (process.argv.includes(\'--self-test\')) selfTest()\n'
  ok('M3：process.argv.includes 形态被扫到', scanSelfTestScripts({ 'scripts/x.mjs': realCli }).length === 1)
  ok('M3：arg === 形态被扫到', scanSelfTestScripts({ 'scripts/y.mjs': "else if (arg === '--self-test') opts.selfTest = true\n" }).length === 1)
  ok('M3：args.includes 形态被扫到', scanSelfTestScripts({ 'scripts/z.mjs': "if (args.includes('--self-test')) return selfTest()\n" }).length === 1)

  // --- 夹具 4：M3 登记检查（真实事故形态：写了守卫没人跑） ---
  const gates4 = [gate('a')] // 登记了 scripts/a.mjs 的自检
  const scanned = ['scripts/a.mjs', 'scripts/unregistered.mjs']
  const problems4 = checkSelfTestRegistration(scanned, gates4, [])
  ok('M3：未登记的自我检查脚本必须判红', problems4.length === 1 && problems4[0].includes('unregistered.mjs'))
  ok('M3：带理由豁免 → 放行', checkSelfTestRegistration(scanned, gates4, [{ script: 'scripts/unregistered.mjs', reason: '编排器：开关是转发给门禁的，不是自身自检' }]).length === 0)
  ok('M3：豁免理由太短 → 判红', checkSelfTestRegistration(['scripts/unregistered.mjs'], [], [{ script: 'scripts/unregistered.mjs', reason: '没事' }]).length === 1)
  ok('M3：豁免条目已过时（脚本不再支持）→ 判红', checkSelfTestRegistration(['scripts/a.mjs'], gates4, [{ script: 'scripts/gone.mjs', reason: '已经删掉的脚本仍在豁免表里' }]).length === 1)
  ok('M3：扫出数为 0 → 判红（E5-空）', checkSelfTestRegistration([], gates4, []).length === 1)

  // --- 夹具 5：M4 旧名兼容（用真实 normalizeGateName，夹具门禁走真实总表） ---
  ok('M4：真实总表全部旧名可解析', checkLegacyAliases(GATES, normalizeGateName).length === 0)
  const brokenNormalize = (raw) => ({ error: '未知门禁：' + raw })
  ok('M4：解析器坏掉必须判红', checkLegacyAliases([gate('a')], brokenNormalize).length === 2)

  // --- 夹具 6：M5 重名 ---
  ok('M5：重名必须判红', checkUniqueNames([gate('a'), gate('a')]).length === 1)
  ok('M5：不重名 → 无问题', checkUniqueNames([gate('a'), gate('b')]).length === 0)
  ok('M5：真实总表无重名', checkUniqueNames(GATES).length === 0)

  // --- 夹具 6b：M6 字段白名单（2026-10-09） ---
  // 🔴 形态就是真实的：可选字段读的是 `=== true`，拼错一个字母**不报错**、静默失效——
  //    而 echoOutput 的存在意义正是「消除静默」，它自己被拼错就成了同一类缺陷。
  ok('M6：白名单内的字段 → 无问题', checkUnknownFields([gate('a'), gate('b', { echoOutput: true })], ['name', 'script', 'real', 'selfTest', 'echoOutput']).length === 0)
  const typo = checkUnknownFields([gate('a', { echoOutpt: true })], ['name', 'script', 'real', 'selfTest', 'echoOutput'])
  ok('M6：拼错的可选字段必须判红（echoOutpt）', typo.length === 1 && typo[0].includes('echoOutpt'))
  ok('M6：报错必须点名允许的字段集', typo.some((p) => p.includes('echoOutput')))
  ok('M6：空字段集不判红（只判未知，不判取值）', checkUnknownFields([gate('a', { manual: '' })], ['name', 'script', 'real', 'selfTest', 'manual']).length === 0)
  // 真实总表自证（与 M1/M4 的真实自洽块同形）。
  ok('真实总表：M6 无未知字段', checkUnknownFields(GATES).length === 0)

  // --- 夹具 7：真实总表的自洽性（读的是本文件导出，不是另抄一份） ---
  ok('真实总表：M1 文件存在', checkScriptsExist(GATES, () => true).length === 0)
  ok('真实总表：M4 旧名可解析', checkLegacyAliases(GATES, normalizeGateName).length === 0)
  ok('真实总表：分档名合法', TIERS.every((t) => Array.isArray(resolveTier(t))))
  ok('真实总表：gates 门禁自身在表内', gateByName('gates') !== undefined)

  if (failures.length > 0) {
    console.error('❌ verify-gates 自测失败：')
    for (const failure of failures) console.error('  · ' + failure)
    exit(1)
  }
  console.log('✅ verify-gates 自测通过（' + passed + ' 项）')
  exit(0)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const scriptsDir = join(projectRoot, 'scripts')
  const entries = {}
  for (const name of readdirSync(scriptsDir)) {
    if (!name.endsWith('.mjs')) continue
    entries['scripts/' + name] = readFileSync(join(scriptsDir, name), 'utf8')
  }

  const scanned = scanSelfTestScripts(entries)
  const problems = [
    ...checkScriptsExist(GATES, (rel) => existsSync(join(projectRoot, rel))),
    ...checkTierCoverage(GATES, TIERS, (tier) => resolveTier(tier).length),
    ...checkSelfTestRegistration(scanned, GATES, EXEMPT_SELF_TEST_SCRIPTS),
    ...checkLegacyAliases(GATES, normalizeGateName),
    ...checkUniqueNames(GATES),
    ...checkUnknownFields(GATES)
  ]

  if (problems.length > 0) {
    console.error('❌ 门禁总表漂移 ' + problems.length + ' 处：')
    for (const problem of problems) console.error('  · ' + problem)
    console.error('')
    console.error('  修法：把门禁登记进 scripts/gate-manifest.mjs（顺带写 why），')
    console.error('  而不是在 CI / 快档 / 文档里另抄一份清单——清单只有那一个产地。')
    exit(1)
  }

  console.log(
    '✅ 门禁总表自洽：' + GATES.length + ' 条门禁 · ' + scanned.length + ' 个自检脚本全部登记 · ' +
      TIERS.map((t) => t + '=' + resolveTier(t).length + ' 步').join(' / ')
  )
  exit(0)
}

if (argv.includes('--self-test')) selfTest()
main()
