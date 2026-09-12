#!/usr/bin/env node
/**
 * verify-claims.mjs — 宣称纪律的可执行守卫（README ↔ AGENTS）。
 *
 * ## 为什么存在
 *
 * `AGENTS.md` §7 把「宣称纪律」写成规矩：状态词只有五种、未接线不得说成可用、
 * 被明确禁止的表述不得出现。但**规矩靠人记就会漂移**——2026-09-12 的评估当场
 * 抓到一处：`README.md` 的插件守护一条写着「so one plugin cannot take down the
 * whole Harness」，而同一份 README 下方、以及 `AGENTS.md` §7.2 都明令**不得**这样
 * 表述（防护只在进程内，同进程崩溃仍可能带走 Harness）。
 *
 * 这类「文档内部自相矛盾」编译器看不见、跨语言（中英双 README + AGENTS）也 grep
 * 不全，只能靠专门的比对。本脚本把两件事变成会失败的检查：
 *
 * | 编号 | 检查 | 级别 |
 * |------|------|------|
 * | C1 | 被 §7 明令禁止的表述不得出现在任何 README | 错误 |
 * | C2 | 五种状态词必须在 AGENTS §7.3 与两份 README 的图例中**同时**出现（词表不允许单边漂移） | 错误 |
 * | C3 | AGENTS §7.2 对照表里每个 ⚠️ 未接线 / ❌ 未实现 行都必须登记（销账批次 / 缺口说明） | 错误 |
 * | C4 | 两份 README 不得出现「未接线」状态的宣称行（README 是面向用户的，不该陈列欠债） | 错误 |
 *
 * C3 是 K3 的落地：`AGENTS.md` §7.3 要求「`grep -rn "⚠️ 未接线\|未实现"` 应只命中确实
 * 未接线/未实现的条目」。纯 grep 分不清「规则文本引用词」与「真的有一条欠债」，本脚本
 * 改为**解析 §7.2 表本身**——那是欠债的唯一权威产地——从而把「有没有未登记的欠债」变成
 * 可判定的检查，而不是靠人读 grep 输出。
 *
 * ## 可证伪性
 *
 * `--self-test` 把**修复前的 README 原句**当夹具喂给判定函数，断言必须报错；
 * 再把修复后的句子喂进去，断言必须通过。若有人把判定弱化成永远通过，自检即红。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-claims.mjs
 * node scripts/verify-claims.mjs --self-test
 * ```
 *
 * 退出码：`0` 通过 · `1` 有禁止表述 / 词表漂移 / 自检失败。
 *
 * ⚠️ 本脚本只覆盖**可文本判定**的两类。§7.3 的 `grep` 自查（未接线/未实现命中）
 * 是另一件事，见 `verify:claims` 之外的 CI 步骤与 `AGENTS.md` §7.3。
 */

import { existsSync, readFileSync } from 'node:fs'
import { argv, exit } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 被 `AGENTS.md` §7 明令禁止的表述。
 *
 * 每条都必须给出「依据」（AGENTS 里的原话或章节），否则下一个读到的人无从判断
 * 这条为什么被禁——这正是本仓文档纪律的一贯要求。
 *
 * 匹配时**大小写不敏感**、并对空白做归一（换行/多空格折叠），以便跨 CRLF 检出
 * 与中英混排一致生效。
 */
export const FORBIDDEN_CLAIMS = [
  {
    id: 'plugin-isolation-claim',
    // 英文：把「进程内归因」说成「插件无法拖垮 Harness」。
    pattern: /cannot\s+take\s+down\s+the\s+whole\s+harness/i,
    because:
      'AGENTS §7.2「插件安全（当前实际生效的那一条）」行明令：同进程的插件崩溃仍可能带走 Harness——不得表述为「插件崩溃不拖垮主程序」。'
  },
  {
    id: 'plugin-isolation-claim-zh',
    // 中文：同样的过度宣称。
    pattern: /(单个|一个)插件[^。\n]{0,12}(拖垮|拖崩|不会拖垮)/,
    because:
      'AGENTS §7.2 同上：当前生效的插件防护只在进程内，不得宣称「插件崩溃不拖垮主程序」。'
  },
  {
    id: 'plugin-isolation-claim-zh2',
    pattern: /插件崩溃(不|不会|无法)拖垮/,
    because: 'AGENTS §7.2 同上：这是被逐字点名的禁止表述。'
  }
]

/**
 * C1 的受检文件。
 *
 * **刻意不含 `AGENTS.md`**：它是规则手册，必然**引用**被禁止的表述本身
 * （如「不得表述为『插件崩溃不拖垮主程序』」）。把规则文本当违规来报，正是
 * `AGENTS.md` §7.3 点名的「预期内命中」——守卫必须只扫**面向用户的宣称**，
 * 不扫**定义规则的文本**。AGENTS 的参与方式在 C2（词表一致性）。
 */
const CLAIM_FILES = ['README.md', 'README.zh-CN.md']

/** 五种状态词（§7.3 词表）。图例必须五项俱全，不允许单边漂移。 */
export const STATUS_MARKERS = [
  { emoji: '✅', key: 'wired' },
  { emoji: '⚠️', key: 'not-wired' },
  { emoji: '❌', key: 'not-implemented' },
  { emoji: '🕓', key: 'planned' },
  { emoji: '🗄️', key: 'archived' }
]

/** 归一化文本：统一换行、折叠空白，便于跨 CRLF / 中英一致匹配。 */
export function normalize(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ')
}

/**
 * 在文本里查找被禁止的表述。
 * @param {string} text 待检文本
 * @returns {{id:string, match:string, because:string}[]}
 */
export function findForbiddenClaims(text) {
  const normalized = normalize(text)
  const hits = []
  for (const rule of FORBIDDEN_CLAIMS) {
    const m = rule.pattern.exec(normalized)
    if (m) hits.push({ id: rule.id, match: m[0], because: rule.because })
  }
  return hits
}

/**
 * 检查一份「图例文本」是否包含全部五种状态词。
 * @param {string} text
 * @returns {string[]} 缺失的状态词 key 列表
 */
export function missingStatusMarkers(text) {
  const normalized = normalize(text)
  return STATUS_MARKERS.filter((marker) => !normalized.includes(marker.emoji)).map((m) => m.key)
}

// ---------------------------------------------------------------------------
// §7.2 对照表解析（C3 的输入）
// ---------------------------------------------------------------------------

/**
 * 已登记、允许保留在 §7.2 表里的「未接线」行。
 *
 * **空表是目标状态**（与 §7.2 的现状一致：能接的都接了）。每加一条都要写明
 * 「为什么它是欠债而不是删除候选」——否则应直接删除该行，而不是登记。
 *
 * 键为状态下方的**宣称名**（表格第 1 列，去掉 `↳` 前缀与 Markdown 强调符）。
 */
export const UNWIRED_ALLOW = {}

/**
 * 已登记的「未实现」缺口。**空表是目标状态**。
 * ❌ 未实现 ≠ 🕓 计划中：前者是「该有却没有」，后者是「刻意不做」。
 */
export const UNIMPLEMENTED_ALLOW = {}

/**
 * 从 `AGENTS.md` 抽出 §7.2 对照表的正文行。
 *
 * 表格形状为 `| 对外宣称 | 状态 | 代码证据 | 运行时调用方 |`。返回的每行都已按 `|`
 * 切分并 trim；表头与分隔行被排除。
 *
 * @param {string} text AGENTS.md 全文
 * @returns {{claim:string, status:string, evidence:string, caller:string}[]}
 */
export function parseClaimTable(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const rows = []
  let inSection = false
  for (const line of lines) {
    if (/^###\s*7\.2/.test(line.trim())) {
      inSection = true
      continue
    }
    if (inSection && /^###\s*7\.3/.test(line.trim())) break
    if (!inSection) continue
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
    if (cells.length < 4) continue
    // 跳过表头与 `|---|---|` 分隔行。
    if (cells[1].startsWith('---') || cells[0] === '对外宣称') continue
    rows.push({ claim: cells[0], status: cells[1], evidence: cells[2], caller: cells[3] })
  }
  return rows
}

/**
 * 归一化「宣称名」为允许清单的键：去掉 `↳` 前缀与 Markdown 强调符。
 * @param {string} claim
 * @returns {string}
 */
export function claimKey(claim) {
  return String(claim ?? '')
    .replace(/^↳\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()
}

/**
 * 从表格行里挑出「未登记」的欠债行。
 *
 * @param {{claim:string,status:string}[]} rows
 * @returns {{unwired:string[], unimplemented:string[]}}
 */
export function findUnregisteredDebt(rows) {
  const unwired = []
  const unimplemented = []
  for (const row of rows) {
    const key = claimKey(row.claim)
    if (row.status.includes('⚠️') && !(key in UNWIRED_ALLOW)) unwired.push(key)
    if (row.status.includes('❌') && !(key in UNIMPLEMENTED_ALLOW)) unimplemented.push(key)
  }
  return { unwired, unimplemented }
}

/** 读取文件（缺失返回空串）。 */
function readSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** 自检：可证伪性——修复前的坏句必须报错，修复后的好句必须通过。 */
function selfTest() {
  let failed = 0
  /**
   * 断言。两种调用形态都支持，且**按 arity 区分**——避免「传了第三个参数却被当成
   * 布尔值忽略」这类静默假通过（本文件第一版就踩过：3 参调用落到 2 参签名上，
   * 断言值被当真相值，只有恰好为假才暴露）。
   *
   * - `check(label, ok)`            → 断言 `ok` 为真
   * - `check(label, actual, expect)` → 断言 `JSON.stringify(actual) === JSON.stringify(expect)`
   *
   * @param {string} label 用例名
   * @param {*} actual 真相值（或布尔）
   * @param {*} [expect] 期望值（省略时按布尔断言处理）
   */
  const check = (...args) => {
    const [label, actual, expect] = args
    const compare = args.length >= 3
    const ok = compare ? JSON.stringify(actual) === JSON.stringify(expect) : Boolean(actual)
    if (ok) {
      console.log(`PASS ${label}`)
    } else {
      failed += 1
      console.error(compare ? `FAIL ${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expect)}` : `FAIL ${label}`)
    }
  }

  // 坏夹具：修复前的英文原句 / 中文原句 —— 必须被判定为禁止表述。
  const badEn = 'emitting `[dsh-plugin-fault]` attribution so one plugin cannot take down the whole Harness.'
  const badZh = '- **插件运行异常守护（进程内）** ✅ —— 避免单个插件把整个 Harness 拖崩。'
  const badZh2 = '插件崩溃不会拖垮主程序。'
  check('坏夹具(EN) 命中', findForbiddenClaims(badEn).length > 0)
  check('坏夹具(ZH-拖崩) 命中', findForbiddenClaims(badZh).length > 0)
  check('坏夹具(ZH-逐字) 命中', findForbiddenClaims(badZh2).length > 0)

  // 好夹具：修复后的句子 —— 必须通过（否则守卫会对正确文本误报）。
  const goodEn =
    'a plugin fault is attributable and diagnosable instead of silent. It runs inside the Harness process, so it does not isolate a crashing plugin: a hard crash in that process can still take Harness down.'
  const goodZh = '让插件故障可归因、可诊断而不是静默发生。它运行在 Harness 进程内，因此不隔离崩溃的插件。'
  check('好夹具(EN) 通过', findForbiddenClaims(goodEn).length === 0)
  check('好夹具(ZH) 通过', findForbiddenClaims(goodZh).length === 0)

  // 图例：五项齐全才通过，缺一即报（证明它不是「永远空数组」）。
  const fullLegend = STATUS_MARKERS.map((m) => m.emoji).join(' ')
  check('完整图例 → 无缺失', missingStatusMarkers(fullLegend).length === 0)
  check('缺 🕓 → 报缺失', missingStatusMarkers('✅ ⚠️ ❌ 🗄️').includes('planned'))

  // C3：§7.2 表解析 + 欠债识别（可证伪：有欠债行必须被挑出，无欠债必须空）
  const tableFixture = [
    '### 7.2 宣称能力 ↔ 代码证据对照表',
    '',
    '| 对外宣称 | 状态 | 代码证据（唯一产地） | 运行时调用方 |',
    '|---------|------|-------------------|------------|',
    '| 某已接线能力 | ✅ 已接线 | `a.rs` | `b.rs` |',
    '| **某欠债能力** | ⚠️ 未接线 | `c.rs` | 无 |',
    '| 某缺口 | ❌ 未实现 | 无 | 无 |',
    '| ↳ **某计划能力** | 🕓 计划中 | 无 | 无 |',
    '',
    '### 7.3 维护方式'
  ].join('\n')
  const rows = parseClaimTable(tableFixture)
  check('§7.2 解析行数', rows.length, 4)
  check('claimKey 去强调/去 ↳', claimKey('↳ **某计划能力**'), '某计划能力')
  const debt = findUnregisteredDebt(rows)
  check('C3 未接线欠债被挑出', debt.unwired, ['某欠债能力'])
  check('C3 未实现缺口被挑出', debt.unimplemented, ['某缺口'])
  // 全 ✅ 的表必须零欠债（否则守卫会误报正常表）
  const cleanTable = tableFixture.replace(/⚠️ 未接线/, '✅ 已接线').replace(/❌ 未实现/, '✅ 已接线')
  check('C3 全绿表 → 零欠债', findUnregisteredDebt(parseClaimTable(cleanTable)), { unwired: [], unimplemented: [] })

  // C4：状态短语才命中，「⚠️ 注意」这类普通警示不误报（可证伪性）。
  const notWired = [/⚠️\s*未接线/, /⚠️\s*not\s+wired/i]
  const isNotWired = (line) => notWired.some((re) => re.test(line))
  check('C4 命中真实欠债行', isNotWired('- **某能力** ⚠️ 未接线 — 没有调用方'), true)
  check('C4 命中英文欠债行', isNotWired('- **X** ⚠️ not wired — no caller'), true)
  check('C4 不误报普通警示', isNotWired('- **注意** ⚠️ 这一条是发布前的硬性要求'), false)

  if (failed > 0) {
    console.error(`verify-claims self-test: ${failed} 项失败`)
    exit(1)
  }
  console.log('verify-claims self-test: 全部通过（含修复前坏句的可证伪性）')
}

/** 主流程。 */
function run() {
  const errors = []
  const notes = []

  // C1：禁止表述
  for (const rel of CLAIM_FILES) {
    const path = join(projectRoot, rel)
    if (!existsSync(path)) {
      notes.push(`${rel} 不存在，跳过`)
      continue
    }
    for (const hit of findForbiddenClaims(readSafe(path))) {
      errors.push(`C1  ${rel} 出现被禁止的表述：「${hit.match}」\n      依据：${hit.because}`)
    }
  }

  // C2：状态词表必须三处一致（AGENTS §7.3 + 两份 README 图例）
  const legendSources = {
    'README.md': readSafe(join(projectRoot, 'README.md')),
    'README.zh-CN.md': readSafe(join(projectRoot, 'README.zh-CN.md')),
    'AGENTS.md': readSafe(join(projectRoot, 'AGENTS.md'))
  }
  const markerKeys = STATUS_MARKERS.map((m) => m.key).join(' / ')
  notes.push(`状态词表应有五项：${markerKeys}`)
  for (const [rel, text] of Object.entries(legendSources)) {
    const missing = missingStatusMarkers(text)
    if (missing.length > 0) {
      errors.push(
        `C2  ${rel} 的状态图例缺少：${missing.join(', ')}。` +
          `五种状态词必须在 AGENTS §7.3 与两份 README 中同时出现（词表不允许单边漂移）`
      )
    }
  }

  // C3：§7.2 表里的欠债必须逐条登记（K3 的落地）
  const rows = parseClaimTable(legendSources['AGENTS.md'])
  notes.push(`§7.2 对照表：${rows.length} 行`)
  const debt = findUnregisteredDebt(rows)
  for (const key of debt.unwired) {
    errors.push(
      `C3  §7.2 表中「${key}」是 ⚠️ 未接线且未登记。未接线是欠债——` +
        `要么接线、要么删除该能力，确需保留请在 UNWIRED_ALLOW 写明销账批次`
    )
  }
  for (const key of debt.unimplemented) {
    errors.push(
      `C3  §7.2 表中「${key}」是 ❌ 未实现且未登记。` +
        `「该有却没有」要么补上、要么改成 🕓 计划中（并写明后置理由），确需保留请在 UNIMPLEMENTED_ALLOW 登记`
    )
  }

  // C4：README 是面向用户的，不该把某项能力标为「未接线」欠债（欠债只应出现在 AGENTS/docs）。
  //
  // 匹配的是**状态短语本身**（`⚠️ 未接线` / `⚠️ not wired`），不是「行里出现 ⚠️」——
  // README 里 ⚠️ 也用作普通警示符（如「⚠️ 注意」），那类不是欠债宣称，不应误报。
  const NOT_WIRED_PHRASES = [/⚠️\s*未接线/, /⚠️\s*not\s+wired/i]
  for (const rel of CLAIM_FILES) {
    const text = legendSources[rel] ?? readSafe(join(projectRoot, rel))
    for (const line of normalize(text).split('\n')) {
      const trimmed = line.trim()
      // 跳过顶部状态词图例行本身（它按定义会列出「⚠️ 未接线」这个词）。
      if (/状态标记约定|Status legend/.test(trimmed)) continue
      if (NOT_WIRED_PHRASES.some((re) => re.test(trimmed))) {
        errors.push(
          `C4  ${rel} 出现「未接线」表述：「${trimmed.slice(0, 60)}…」。` +
            `README 是面向用户的宣称，不应陈列未接线的欠债——欠债只登记在 AGENTS.md §7.2`
        )
      }
    }
  }

  console.log('[verify-claims] 宣称纪律检查（README ↔ AGENTS）')
  for (const note of notes) console.log(`  · ${note}`)
  console.log('')
  for (const item of errors) console.log(`  ❌ ${item}`)
  if (errors.length === 0) {
    console.log('  ✅ 无禁止表述，状态词表三处一致')
    return
  }
  console.log(`\n  ${errors.length} 处问题。`)
  exit(1)
}

// ESM「主模块」判定：仅当被直接执行（而非 import）时跑 CLI。
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  if (argv.includes('--self-test')) {
    selfTest()
  } else {
    run()
  }
}
