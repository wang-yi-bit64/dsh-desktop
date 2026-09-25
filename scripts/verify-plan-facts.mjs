#!/usr/bin/env node
/**
 * verify-plan-facts.mjs — 计划文档与发布计划的事实守卫。
 *
 * ## 为什么存在
 *
 * `docs/dev-plan-release-channels.md` 已**四次**在同一形态上失败：**不重读仓库就写现状**。
 *
 * | 次 | 出错处 | 形态 |
 * |----|--------|------|
 * | 1 | `harness-locks/` 的存在性 | 依据记忆写事实，被提交 `3f3c46c` 推翻 |
 * | 2 | CLI 发布通道退役（HEAD = `64cdd7b`） | 把**已完成**的事写成待施工项 |
 * | 3 | 批次 1a 被标「✅ 已完成」 | 把「计划里描述过」当成「仓库里已完成」 |
 * | 4 | F1 / F4 过期、§3.2 的字段命名与实现**反向** | 上游一天前进一格；落地命名与初稿相反 |
 *
 * 前三次的补救是「写成纪律」，**已被证伪**——所以第四次改为**把判据钉住**。
 *
 * 另一半根因在**文档里的版本号零守卫**：全仓所有读 `dshVersion` 的代码都走
 * `resolveTarget().dshVersion`（**动态解析**），**没有任何守卫读文档**。于是改锚点时
 * 文档里的现状声明只能靠人手工同步——2026-09-25 把 `next` 从 `rc.2` 改到 `rc.3` 时
 * 就漏了三处，全靠人肉发现（`verify:patches` / `verify:harness-lockfile` 都**看不见**它们，
 * 因为它们的输入是动态解析出来的值，不是文档）。
 *
 * ## 检查表
 *
 * | 编号 | 检查 | 级别 |
 * |------|------|------|
 * | C1 | 各文档里「钉住的 DSH 版本」（表格 3 列 与 散文两种写法）必须等于 `DSH_TARGETS[<target>].dshVersion`；**声明点缺失也判红**（不然删掉整张表就能让检查静默变绿） | 错误 |
 * | C2 | `harness-locks/<target>/inputs.json` 的 `dshVersion` 必须等于同一值 | 错误 |
 * | C3 | 计划文档的批次状态词必须与脚本内的**状态账本**一致（§5 小节标题 与 §10.1 表行**两处**都要含该状态词），且账本必须覆盖 §10.1 的全部批次；开头的「状态」段必须点名所有非「待办」的状态词 | 错误 |
 *
 * C3 的做法说明：批次的**期望**状态写在脚本里（`PLAN_BATCH_STATUS`），文档是**被测方**。
 * 这不是「把真相搬进脚本」，而是**让「头部说已完成、正文说待办」这种内部矛盾无法提交**——
 * 矛盾的两侧都只能对齐到同一个值。第 3 次事故正是这个形态。
 *
 * ## 可证伪性
 *
 * `--self-test` 全部使用**内存夹具**（不读仓库文件），且每个判据都配一对正反例：
 * 正向必须通过、**负向必须报红**。其中三条直接复刻真实事故形态：
 * 「旧锚点没同步」（`next` 表里还写 `0.1.5-rc.2`）、「整张表被删掉」、「头部与表行状态词打架」。
 * 期望值一律**硬编码**，不用被测函数现算——否则判据改错时期望值跟着错，自测与被测双向失效。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-plan-facts.mjs
 * node scripts/verify-plan-facts.mjs --self-test
 * ```
 *
 * 退出码：`0` 通过 · `1` 有事实漂移 / 自检失败 · `2` 文件缺失（环境不完整）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DSH_TARGETS, listTargetNames } from './dsh-targets.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// 声明点清单
// ---------------------------------------------------------------------------

/**
 * 表格型声明点：表格行的**第 3 格**就是「钉住的 DSH 版本」。
 *
 * 探针实测（2026-09-25）在三个文件里各命中 2 行、**零误命中**——所以这套抽取器
 * 必须保持「`<目标键>` 在第 1 格 + 第 3 格是版本号形状」两个条件同时成立。
 * 放宽任一条都会开始命中别的表（例如把 `channel` 列当成版本）。
 */
const PIN_TABLE_FILES = ['README.md', 'README.zh-CN.md', 'AGENTS.md']

/**
 * 散文型声明点：同一事实写在句子里，形状不由表格保证，只能逐条给正则。
 *
 * ⚠️ 每条正则**必须**只指向「本仓钉住的版本」。反例：`docs/dsh-upgrade-checklist.md`
 * 里同时有「本仓钉的是 `0.1.5-rc.3`」与「上游 `next` 已前进到 `0.1.7-rc.1`」两句，
 * 后者是**上游事实**，写成宽泛的 `/`([0-9][^`]*)`/` 会把它当成本仓声明而误判。
 */
const PROSE_DECLARATIONS = [
  {
    file: 'patches/LAYERS.md',
    target: 'next',
    label: '通道表 next 行的「当前锚」',
    res: [/当前锚在上游[^\n]*?`([0-9][^`]*)`/g]
  },
  {
    file: 'patches/LAYERS.md',
    target: 'alpha',
    label: '通道表 alpha 行的「当前」',
    res: [/dist-tag（当前 `([0-9][^`]*)`）/g]
  },
  {
    file: 'docs/dsh-upgrade-checklist.md',
    target: 'next',
    label: '§0 锚点说明（两种写法）',
    res: [/当前钉的是 `([0-9][^`]*)`/g, /next 线 `([0-9][^`]*)`/g]
  },
  {
    file: 'docs/dsh-upgrade-checklist.md',
    target: 'alpha',
    // 只认「alpha 线 `…`」这一种：另一句里的 `0.1.7-rc.1` 是**上游**值，不是本仓锚点。
    label: '§0 锚点说明',
    res: [/alpha 线 `([0-9][^`]*)`/g]
  }
]

/**
 * 计划文档的批次状态账本（**单一真源**）。
 *
 * 值 = 该批次状态里**必须出现**的关键词，§5 的小节标题与 §10.1 的表行**都要**含它。
 * 改批次状态时必须同时改这里与文档——这是刻意的：`verify:plan-facts` 的作用就是
 * 让「只改了文档一处」在 CI 上红掉。
 */
export const PLAN_BATCH_STATUS = {
  P0: '已完成',
  '1a': '撤销',
  '1b': '半完成',
  2: '待办',
  3: '待办',
  4: '待办',
  5: '待办',
  6: '待办',
  R1: '撤销',
  R2: '待办',
  R3: '待办'
}

/** 计划文档里「状态」段必须在场（否则开头的摘要就与下方批次表脱节）。 */
const PLAN_STATUS_WORD_REQUIRED = '撤销'

/**
 * 默认状态：**§5 小节标题不写状态词即表示它**。
 *
 * 为什么允许这个例外：若要求每个标题都写「待办」，就是让多数批次去附和账本，
 * 噪声大而信息量为零。真正要堵的是反面——**非默认状态必须显式写在标题里**，
 * 否则就会出现「头部说已撤销、§5 一个字不提」这种摘要与正文脱节（第 3 次事故的形态）。
 * 表行不受此例外影响：每一行都必须写出状态词。
 */
const DEFAULT_BATCH_STATUS = '待办'

const PLAN_DOC = 'docs/dev-plan-release-channels.md'

// ---------------------------------------------------------------------------
// 纯逻辑层（可自测；只吃字符串，不碰文件系统）
// ---------------------------------------------------------------------------

/**
 * 把一行 Markdown 表格切成单元格（去掉首尾竖线）。
 *
 * @param {string} line
 * @returns {string[]}
 */
export function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/**
 * 抽出某文件里「`<target>` 开头的表格行 + 第 3 格是版本号」的声明。
 *
 * 第 3 格允许带或不带反引号（README 与 AGENTS 的写法不同），但**必须**是
 * `\d+.\d+.\d+` 开头的形状——这是避免误命中「第 3 格是目录名/布尔值」的别的表。
 *
 * @param {string} text
 * @param {string} target
 * @returns {{line: number, version: string}[]}
 */
export function pinTableSites(text, target) {
  const out = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!/^\|\s*`/.test(line)) continue
    const cells = splitTableRow(line)
    if (cells.length < 4) continue
    const key = /^`([^`]+)`/.exec(cells[0])?.[1]
    if (key !== target) continue
    const version = /^`?(\d+\.\d+\.\d+[^`]*?)`?$/.exec(cells[2])?.[1]
    if (version === undefined) continue
    out.push({ line: i + 1, version })
  }
  return out
}

/**
 * 抽出散文型声明的全部匹配值。
 *
 * @param {string} text
 * @param {RegExp[]} res 必须带 `g` 标志
 * @returns {string[]}
 */
export function proseSites(text, res) {
  const out = []
  for (const re of res) {
    const pattern = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
    for (const match of text.matchAll(pattern)) out.push(match[1])
  }
  return out
}

/**
 * C1：所有声明点都必须等于该目标的 `dshVersion`。
 *
 * **声明点缺失同样判红**——这是刻意的：否则「把整张 Pinned DSH 表删掉」会让检查
 * 在 0 个声明点上「全部通过」，比写错还危险（写错至少值还在）。
 *
 * @param {Record<string, string>} docs 文件路径 → 内容
 * @param {Record<string, {dshVersion: string}>} targets 目标 → 条目
 * @returns {string[]} 问题列表
 */
export function checkVersionDeclarations(docs, targets) {
  const problems = []
  const targetNames = Object.keys(targets)

  for (const file of PIN_TABLE_FILES) {
    const text = docs[file]
    if (text === undefined) {
      problems.push(`${file}：读不到（声明点的载体缺失）`)
      continue
    }
    for (const target of targetNames) {
      const sites = pinTableSites(text, target)
      const expected = targets[target].dshVersion
      if (sites.length === 0) {
        problems.push(`${file}：找不到 \`${target}\` 的 Pinned 版本行（第 1 格是 \`${target}\`、第 3 格是版本号）——这一处声明被删了或改了形状`)
        continue
      }
      for (const site of sites) {
        if (site.version !== expected) {
          problems.push(`${file}:${site.line}：\`${target}\` 钉的是 ${site.version}，而 dsh-targets.mjs 里是 ${expected}`)
        }
      }
    }
  }

  for (const entry of PROSE_DECLARATIONS) {
    const text = docs[entry.file]
    if (text === undefined) {
      problems.push(`${entry.file}：读不到（声明点的载体缺失）`)
      continue
    }
    const values = proseSites(text, entry.res)
    const expected = targets[entry.target]?.dshVersion
    if (expected === undefined) continue
    if (values.length === 0) {
      problems.push(`${entry.file}：找不到 ${entry.target} 的${entry.label}——这一处声明被删了或改了措辞`)
      continue
    }
    for (const value of values) {
      if (value !== expected) {
        problems.push(`${entry.file}：${entry.label} 写的是 ${value}，而 dsh-targets.mjs 里 ${entry.target} 是 ${expected}`)
      }
    }
  }

  return problems
}

/**
 * C2：`harness-locks/<target>/inputs.json` 自证的 `dshVersion` 必须等于目标锚点。
 *
 * 与 `verify:harness-lockfile` 的规则 4 **互补而非重复**：那条在**组装时**比输入快照
 * 与本次组装输入；这条在**静态门禁**下就提前发现「改了锚点但没重新生成锁」，
 * 不必等到组装（本仓 `next` 线组装代价是分钟级）。
 *
 * @param {Record<string, string>} docs 路径 → 内容（JSON 文本）
 * @param {Record<string, {dshVersion: string}>} targets
 * @returns {string[]}
 */
export function checkLockInputs(docs, targets) {
  const problems = []
  for (const target of Object.keys(targets)) {
    const path = `harness-locks/${target}/inputs.json`
    const text = docs[path]
    if (text === undefined) {
      problems.push(`${path}：不存在——每个目标都必须有一份随锚点走的输入快照`)
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      problems.push(`${path}：不是合法 JSON（${error.message}）`)
      continue
    }
    const expected = targets[target].dshVersion
    if (parsed.dshVersion !== expected) {
      problems.push(
        `${path}：自证 dshVersion 是 ${JSON.stringify(parsed.dshVersion)}，而 dsh-targets.mjs 里是 ${expected}` +
          '——锚点改了却没重新生成锁'
      )
    }
    if (parsed.target !== target) {
      problems.push(`${path}：自证 target 是 ${JSON.stringify(parsed.target)}，与目录键 ${target} 不符`)
    }
  }
  return problems
}

/**
 * 从计划文档里抽出 §10.1 的批次状态表：`批次 → 该行原文`。
 *
 * 定位方式是**先找表头行**再往下读到第一个非表格行——不去全文找 `| <id> |`，
 * 因为文档里还有别的表（例如「优化修订」表）同样以 `| 批次 N |` 开头。
 *
 * @param {string} plan
 * @returns {Map<string, string>}
 */
export function extractBatchTable(plan) {
  const rows = new Map()
  const lines = plan.split(/\r?\n/)
  let inTable = false
  for (const line of lines) {
    if (!inTable) {
      if (/^\|\s*批次\s*\|\s*状态\s*\|/.test(line)) inTable = true
      continue
    }
    if (!/^\s*\|/.test(line)) break
    const cells = splitTableRow(line)
    const id = /^\*{0,2}([A-Za-z0-9]+)\*{0,2}$/.exec(cells[0])?.[1]
    if (id === undefined) continue
    if (/^-+$/.test(cells[1] ?? '')) continue
    rows.set(id, line)
  }
  return rows
}

/**
 * 从计划文档里抽出 §5 的批次小节标题：`批次 → 标题原文`。
 *
 * @param {string} plan
 * @returns {Map<string, string>}
 */
export function extractBatchSections(plan) {
  const sections = new Map()
  for (const line of plan.split(/\r?\n/)) {
    const id = /^###\s*批次\s+([A-Za-z0-9]+)\s/.exec(line)?.[1]
    if (id !== undefined) sections.set(id, line)
  }
  return sections
}

/**
 * 抽出计划文档开头的「状态」引用块全文。
 *
 * ⚠️ **必须整块取，不能只取首行**：该摘要跨 3 行以上（`> 状态：…` / `> …` / `> …`），
 * 只取首行会让「撤销 / 半完成」这些词恰好落在第二行时判红（假失败），
 * 而那正是本仓最常见的「判据没对准真实形状」缺陷。
 *
 * @param {string} plan
 * @returns {string|undefined}
 */
export function planStatusParagraph(plan) {
  const lines = plan.split(/\r?\n/)
  const start = lines.findIndex((line) => /^>\s*状态：/.test(line))
  if (start === -1) return undefined
  const collected = []
  for (let i = start; i < lines.length && /^>/.test(lines[i]); i += 1) collected.push(lines[i])
  return collected.join('\n')
}

/**
 * C3：批次状态账本 ↔ 文档的两处（§5 小节标题、§10.1 表行）必须一致，
 * 且账本覆盖表里的全部批次、开头的「状态」段要点名非「待办」状态词。
 *
 * @param {{plan: string, ledger: Record<string, string>, headerWord: string}} input
 * @param {string} [planPath] 仅用于报错信息
 * @returns {string[]}
 */
export function checkPlanLedger({ plan, ledger, headerWord }, planPath = PLAN_DOC) {
  const problems = []
  const table = extractBatchTable(plan)
  const sections = extractBatchSections(plan)

  if (table.size === 0) {
    problems.push(`${planPath}：找不到 §10.1 的批次状态表——检查的锚点消失了，判据无法落地`)
    return problems
  }

  for (const [id, statusWord] of Object.entries(ledger)) {
    const row = table.get(id)
    if (row === undefined) {
      problems.push(`${planPath}：账本里的批次 ${id} 在 §10.1 表里不存在`)
      continue
    }
    if (!row.includes(statusWord)) {
      problems.push(`${planPath}：批次 ${id} 的 §10.1 表行不含期望状态词「${statusWord}」——表行是：${row.trim()}`)
    }
    const section = sections.get(id)
    if (section === undefined) {
      // P0 等批次没有 §5 小节，只查表行。
      continue
    }
    if (statusWord === DEFAULT_BATCH_STATUS) continue // 默认态不必写进标题，见 DEFAULT_BATCH_STATUS
    if (!section.includes(statusWord)) {
      problems.push(`${planPath}：批次 ${id} 的 §5 小节标题不含期望状态词「${statusWord}」——标题是：${section.trim()}`)
    }
  }

  for (const id of table.keys()) {
    if (!(id in ledger)) {
      problems.push(`${planPath}：§10.1 表里有批次 ${id}，但状态账本没有它——新批次必须同时登记进 PLAN_BATCH_STATUS`)
    }
  }

  const header = planStatusParagraph(plan)
  if (header === undefined) {
    problems.push(`${planPath}：找不到开头的「> 状态：」段`)
  } else {
    // 开头的摘要必须点名所有非「待办」的状态词，否则摘要与表脱节（第 3 次事故正是这个形态）。
    for (const word of new Set(Object.values(ledger))) {
      if (word === '待办') continue
      if (!header.includes(word)) {
        problems.push(`${planPath}：开头「状态」段没有点名「${word}」——摘要与批次表脱节`)
      }
    }
    if (!header.includes(headerWord)) {
      problems.push(`${planPath}：开头「状态」段不含「${headerWord}」`)
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
  const eq = (name, actual, expected) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1
    else failures.push(`${name}\n    实际: ${JSON.stringify(actual)}\n    期望: ${JSON.stringify(expected)}`)
  }

  // 期望值**硬编码**：它必须是一条独立事实，不能由被测函数现算。
  const TARGETS = { next: { dshVersion: '0.1.5-rc.3' }, alpha: { dshVersion: '0.1.6-alpha.2' } }

  // --- 夹具 1：表格抽取器只认「第 1 格是目标键 + 第 3 格是版本号」 ---
  const readmeOk = [
    '# README',
    '',
    '| Target | Line | Pinned DSH | Desktop tag |',
    '|--------|------|------------|-------------|',
    '| `next` (default) | npm `next` dist-tag (rc stage) | `0.1.5-rc.3` | `rc` |',
    '| `alpha` | npm `alpha` dist-tag | `0.1.6-alpha.2` | `alpha` |'
  ].join('\n')
  eq('夹具1：next 抽出 1 处且带行号', pinTableSites(readmeOk, 'next'), [{ line: 5, version: '0.1.5-rc.3' }])
  eq('夹具1：alpha 抽出 1 处', pinTableSites(readmeOk, 'alpha'), [{ line: 6, version: '0.1.6-alpha.2' }])
  // 反证：第 3 格不是版本号形状的行**不得**被当成声明（否则会命中把 channel 当第 3 格的表）
  const notVersion = ['| `next` | x | `patches/next/`（14 个） | `rc` |'].join('\n')
  eq('夹具1：第 3 格不是版本号 → 不算声明', pinTableSites(notVersion, 'next'), [])
  // 反证：「目标键」必须是第 1 格的完整内容，`next-launcher` 这类前缀不得命中
  const prefix = ['| `next-launcher` | x | `0.1.5-rc.3` | `rc` |'].join('\n')
  eq('夹具1：目标键前缀不命中', pinTableSites(prefix, 'next'), [])

  // --- 夹具 2：正向全套通过（**必须把散文型声明的载体也放进夹具**，
  //     否则正向用例会因「读不到文件」而报红——正向夹具不完整本身就是缺陷） ---
  const layersOk = [
    '| `next` | x 但**当前锚在上游 `latest`（`0.1.5-rc.3`）**——上游 `next` 已前进到 `0.1.7-rc.1` |',
    '| `alpha` | npm `alpha` dist-tag（当前 `0.1.6-alpha.2`） |'
  ].join('\n')
  const checklistOk =
    '例如 `next` 目标当前钉的是 `0.1.5-rc.3`，而 npm 的 `next` dist-tag 已前进到 `0.1.7-rc.1`；' +
    '（当前：next 线 `0.1.5-rc.3`、alpha 线 `0.1.6-alpha.2`）'
  const docsOk = {
    'README.md': readmeOk,
    'README.zh-CN.md': readmeOk,
    'AGENTS.md': readmeOk,
    'patches/LAYERS.md': layersOk,
    'docs/dsh-upgrade-checklist.md': checklistOk
  }
  eq('夹具2：全部声明点一致 → 无问题', checkVersionDeclarations(docsOk, TARGETS), [])

  // --- 夹具 3：**真实事故形态**——锚点改了、文档没同步（旧值 0.1.5-rc.2） ---
  const staleReadme = readmeOk.replace('`0.1.5-rc.3`', '`0.1.5-rc.2`')
  const stale = checkVersionDeclarations({ ...docsOk, 'README.md': staleReadme }, TARGETS)
  eq('夹具3：旧锚点未同步 → 判红', stale.length, 1)
  eq('夹具3：报错点名文件与行号', stale[0].includes('README.md:5'), true)
  eq(
    '夹具3：报错同时给出两个值（人一眼能看出该改成什么）',
    stale[0].includes('0.1.5-rc.2') && stale[0].includes('0.1.5-rc.3'),
    true
  )
  // 灵敏度：同一夹具只改一个字符，结论必须翻转
  eq(
    '夹具3：只改一位版本 → 结论翻转（证明判据真的在比对）',
    [
      checkVersionDeclarations({ ...docsOk, 'README.md': readmeOk }, TARGETS).length,
      checkVersionDeclarations({ ...docsOk, 'README.md': staleReadme }, TARGETS).length
    ],
    [0, 1]
  )

  // --- 夹具 4：整张表被删掉 → 必须判红（不得因「0 个声明点」而静默通过） ---
  const noTable = '# README\n\n没有表格了。\n'
  const deleted = checkVersionDeclarations({ ...docsOk, 'README.md': noTable }, TARGETS)
  eq('夹具4：声明点整体消失 → 判红 2 条（每目标一条）', deleted.length, 2)
  eq('夹具4：报错说清是「找不到声明行」', deleted.every((p) => p.includes('找不到')), true)

  // --- 夹具 5：散文型声明（含「上游值不许被当成本仓声明」的反证） ---
  const layers = [
    '| `next` | ⚠️ 但**当前锚在上游 `latest`（`0.1.5-rc.3`）**——上游 `next` 已前进到 `0.1.7-rc.1` |',
    '| `alpha` | npm `alpha` dist-tag（当前 `0.1.6-alpha.2`） |'
  ].join('\n')
  eq(
    '夹具5：散文声明抽对值（`latest` 与上游 `0.1.7-rc.1` 都不得被误抽）',
    proseSites(layers, [/当前锚在上游[^\n]*?`([0-9][^`]*)`/g]),
    ['0.1.5-rc.3']
  )
  eq('夹具5：alpha 散文声明', proseSites(layers, [/dist-tag（当前 `([0-9][^`]*)`）/g]), ['0.1.6-alpha.2'])

  // --- 夹具 6：inputs.json 自证字段 ---
  const lockOk = {
    'harness-locks/next/inputs.json': JSON.stringify({ target: 'next', dshVersion: '0.1.5-rc.3' }),
    'harness-locks/alpha/inputs.json': JSON.stringify({ target: 'alpha', dshVersion: '0.1.6-alpha.2' })
  }
  eq('夹具6：锁输入自证一致 → 无问题', checkLockInputs(lockOk, TARGETS), [])
  const lockStale = {
    ...lockOk,
    'harness-locks/next/inputs.json': JSON.stringify({ target: 'next', dshVersion: '0.1.5-rc.2' })
  }
  const lockProblems = checkLockInputs(lockStale, TARGETS)
  eq('夹具6：锁自证过期 → 判红', lockProblems.length, 1)
  eq('夹具6：报错点名「改了锚点却没重新生成锁」', lockProblems[0].includes('锚点改了却没重新生成锁'), true)
  eq('夹具6：缺文件 → 判红', checkLockInputs({ ...lockOk, 'harness-locks/alpha/inputs.json': undefined }, TARGETS).length > 0, true)
  eq('夹具6：非法 JSON → 判红', checkLockInputs({ ...lockOk, 'harness-locks/next/inputs.json': '{' }, TARGETS).length > 0, true)

  // --- 夹具 7：批次表抽取只吃 §10.1 那张表 ---
  const planFixture = [
    '# 计划',
    '',
    '> 状态：**部分已落地**。**批次 1a / R1 已整条撤销**；批次 1b 半完成。',
    '',
    '## 10.1 规模',
    '',
    '| 批次 | 状态 | 说明 |',
    '|---|---|---|',
    '| **P0** | 待办（**前置**） | 事实校验脚本 |',
    '| 1a | ⚠️ **大部分撤销** | 目录键 |',
    '| 1b | ⚠️ **半完成** | 锚点 |',
    '| R1 | ❌ **整条撤销** | 并入 |',
    '',
    '> | 批次 2 | **删掉某项** | **减一项** |'
  ].join('\n')
  const table = extractBatchTable(planFixture)
  eq('夹具7：抽到 4 行', [...table.keys()], ['P0', '1a', '1b', 'R1'])
  eq('夹具7：表头行本身不算批次', table.has('批次'), false)
  const sections = extractBatchSections('### 批次 1a — x ❌ **整条撤销**\n### 批次 1b — y ⚠️ **半完成**')
  eq('夹具7：小节标题抽到两个批次', [...sections.keys()], ['1a', '1b'])

  // --- 夹具 8：**真实事故形态**——头部与表行状态词打架 ---
  const ledgerFixture = { P0: '待办', '1a': '撤销', '1b': '半完成', R1: '撤销' }
  eq(
    '夹具8：账本 ↔ 表行/小节/摘要 一致 → 无问题',
    checkPlanLedger({ plan: planFixture, ledger: ledgerFixture, headerWord: '撤销' }),
    []
  )
  // 8a：表行退回「待办」（第 3 次事故的形态：正文说待办、实际已撤销）
  const rowReverted = planFixture.replace('| 1a | ⚠️ **大部分撤销** |', '| 1a | 待办 |')
  const rowProblem = checkPlanLedger({ plan: rowReverted, ledger: ledgerFixture, headerWord: '撤销' })
  eq('夹具8a：表行状态词不符 → 判红', rowProblem.length, 1)
  eq('夹具8a：报错点名批次与期望词', rowProblem[0].includes('批次 1a') && rowProblem[0].includes('撤销'), true)
  // 8b：摘要段漏掉「半完成」
  const headerLost = planFixture.replace('批次 1b 半完成。', '批次 1b 也在推进。')
  const headerProblem = checkPlanLedger({ plan: headerLost, ledger: ledgerFixture, headerWord: '撤销' })
  eq('夹具8b：摘要漏点名状态词 → 判红', headerProblem.length, 1)
  eq('夹具8b：报错点名「半完成」', headerProblem[0].includes('半完成'), true)
  // 8c：表里多了一个账本没有的批次
  const extraRow = planFixture.replace('| R1 |', '| 9 | 待办 | 新批次 |\n| R1 |')
  const extraProblem = checkPlanLedger({ plan: extraRow, ledger: ledgerFixture, headerWord: '撤销' })
  eq('夹具8c：未登记的批次 → 判红', extraProblem.some((p) => p.includes('账本没有它')), true)
  // 8d：表整个消失
  const tableGone = checkPlanLedger({ plan: '# 计划\n没有表\n', ledger: ledgerFixture, headerWord: '撤销' })
  eq('夹具8d：状态表消失 → 判红', tableGone.length, 1)
  eq('夹具8d：报错说清锚点消失', tableGone[0].includes('锚点消失'), true)

  // --- 夹具 9：账本自身必须是「批次表覆盖我们的全部批次」这一关系的反向检查 ---
  eq(
    '夹具9：账本漏一个已在表里的批次 → 判红',
    checkPlanLedger({ plan: planFixture, ledger: { P0: '待办', '1a': '撤销', '1b': '半完成' }, headerWord: '撤销' })
      .some((p) => p.includes('账本没有它') && p.includes('R1')),
    true
  )

  if (failures.length > 0) {
    console.error('❌ verify-plan-facts 自测失败：')
    for (const failure of failures) console.error(`  · ${failure}`)
    process.exit(1)
  }
  console.log(`✅ verify-plan-facts 自测通过（${passed} 项）`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readOrNull(path) {
  try {
    return readFileSync(join(projectRoot, path), 'utf8')
  } catch {
    return undefined
  }
}

function main() {
  if (process.argv.includes('--self-test')) selfTest()

  const targets = {}
  for (const name of listTargetNames()) targets[name] = DSH_TARGETS[name]

  const paths = [
    ...PIN_TABLE_FILES,
    ...PROSE_DECLARATIONS.map((entry) => entry.file),
    ...listTargetNames().map((name) => `harness-locks/${name}/inputs.json`),
    PLAN_DOC
  ]
  const docs = {}
  for (const path of new Set(paths)) docs[path] = readOrNull(path)

  const problems = [
    ...checkVersionDeclarations(docs, targets),
    ...checkLockInputs(docs, targets),
    ...checkPlanLedger({ plan: docs[PLAN_DOC] ?? '', ledger: PLAN_BATCH_STATUS, headerWord: PLAN_STATUS_WORD_REQUIRED })
  ]

  if (problems.length > 0) {
    console.error(`❌ 计划文档/事实漂移 ${problems.length} 处：`)
    for (const problem of problems) console.error(`  · ${problem}`)
    console.error('')
    console.error('  修法：把文档里的版本号与状态词改成与 `scripts/dsh-targets.mjs` / 账本一致，')
    console.error('  而不是反过来改判据——判据读的是**动态解析**出来的值，它不会漂。')
    process.exit(1)
  }

  console.log(`✅ 计划事实一致：${new Set(paths).size} 个文件 · ${listTargetNames().length} 个目标的版本声明与锚点一致，批次状态账本自洽`)
  process.exit(0)
}

main()
