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
 * | C1 | 各文档里「钉住的 DSH 版本」（表格 3 文件 × 2 目标 + 12 处散文/注释写法）必须等于 `DSH_TARGETS[<target>].dshVersion`；**声明点缺失也判红**（不然删掉整张表就能让检查静默变绿） | 错误 |
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
import { readFileSync, readdirSync } from 'node:fs'
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
  },
  // ⚠️ 以下 4 条是 2026-10-08 补的。它们此前**没有守卫**，而 README 的两份「目标键告诉不了你
  // 钉的是哪个上游版本」说明段在 2026-10-07 alpha 线推进到 0.2.1-alpha.1 后**双双漏改**，
  // 却因为 Pinned 表是对的而让本守卫继续打印 ✅ —— 这正是「枚举不全 = 假绿」。
  // 教训：**表格对不等于事实对**；同一事实的散文写法必须逐处点名，否则等于没测。
  // 判据形状刻意收得很紧（必须同时出现反引号包裹的目标键 + ` pins ` / 全角 `、` 等字面词），
  // 以免命中 README 里其它提到 `next` / `alpha` 的句子（那些不声明版本号）。
  {
    file: 'README.md',
    target: 'next',
    label: '通道表下方 English 散文的「`next` pins …」',
    res: [/`next` pins `([0-9][^`]*)`/g]
  },
  {
    file: 'README.md',
    target: 'alpha',
    label: '通道表下方 English 散文的「`alpha` pins …」',
    res: [/`alpha` pins `([0-9][^`]*)`/g]
  },
  {
    file: 'README.zh-CN.md',
    target: 'next',
    label: '通道表下方中文散文的「（next `…`、」',
    res: [/（next `([0-9][^`]*)`、/g]
  },
  {
    file: 'README.zh-CN.md',
    target: 'alpha',
    label: '通道表下方中文散文的「alpha `…`，与上游」',
    res: [/alpha `([0-9][^`]*)`，与上游/g]
  },
  // 第三批（2026-10-08）：另外两处**无人守、且已实际漂移**的现状声明。
  //  1) `docs/dsh-upgrade-checklist.md` 的「`next` 锚 X / `alpha` 锚 Y」写法。该文件**已被**
  //     PROSE_DECLARATIONS 守着另外两种写法（「当前钉的是…」「next 线 `…`」），而这两句
  //     在同一文件里紧邻——于是旧判据照样打印 ✅。这是**假绿的第二种形态**：
  //     同一事实在同一文件里有多种写法，只守了其中一部分。
  //  2) `scripts/prepare-harness.mjs` 的构建目标注释。它此前被登记为「注释也算现状声明，
  //     但不纳入自动判据、只能人工同步」——而它确实漂移过（长期停在 `0.1.5-rc.3`）。
  //     「只能人工同步」等于「迟早漂」：判据读的是文件全文，注释当然读得到，故改为自动比对。
  {
    file: 'docs/dsh-upgrade-checklist.md',
    target: 'next',
    label: '首部「`next` 锚 …」写法',
    res: [/`next` 锚 `([0-9][^`]*)`/g]
  },
  {
    file: 'docs/dsh-upgrade-checklist.md',
    target: 'alpha',
    label: '首部「`alpha` 锚 …」写法',
    res: [/`alpha` 锚 `([0-9][^`]*)`/g]
  },
  {
    file: 'scripts/prepare-harness.mjs',
    target: 'next',
    label: '构建目标注释的「next → DSH …」',
    res: [/next\s+→ DSH ([0-9][0-9A-Za-z.-]*)/g]
  },
  {
    file: 'scripts/prepare-harness.mjs',
    target: 'alpha',
    label: '构建目标注释的「alpha → DSH …」',
    res: [/alpha\s+→ DSH ([0-9][0-9A-Za-z.-]*)/g]
  }
]

/**
 * 在役计划文档（批次/决策状态的**单一账本主体**）。
 *
 * 历史：本守卫最初测的是 `docs/dev-plan-release-channels.md` 的批次账本（它曾四次
 * 在同一形态上失败）。S2-4（2026-09-30）把 release-channels 主题三份文档归档后，
 * 账本主体改指向**在役**的缺陷治理计划——账本检查必须跟着在役计划走，
 * 检查一份已冻结的历史文档是空转。
 */
const PLAN_DOC = 'docs/dev-plan-defect-remediation.md'

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
 * C3：在役计划的**决策账本**必须自洽（缺陷治理计划 §7 的形状）：
 *   ① §7 决策表必须存在，且 C1~C8 每个决策都在；
 *   ② 每个决策的「落地」格**必须非空**，并引用一个真实存在的去向——
 *      ADR（`ADR-\d{3}`，文件须在 docs/adr/）或仓库内文档/脚本路径。
 *      这是「计划无权延期 ADR」（AGENTS §7.3 S2-2 条文）的静态面：
 *      一个没有落地去向的裁决 = 让执行者横跳，与没有裁决一样。
 *   ③ §11 执行记录必须存在——「做过的」与「未开工的」分开记账（§11.1 的反乐观纪律）。
 *
 * @param {{plan: string, adrFileNames: Set<string>}} input
 * @param {string} [planPath] 仅用于报错信息
 * @returns {string[]}
 */
export function checkDecisionLedger({ plan, adrFileNames }, planPath = PLAN_DOC) {
  const problems = []
  const rows = plan.split(/\r?\n/).filter((l) => /^\| C\d+\s*\|/.test(l))
  if (rows.length < 8) {
    problems.push(`${planPath}：§7 决策表只有 ${rows.length} 行（要求 ≥8，C1~C8）——决策表被删或被改写即判红`)
    return problems
  }
  for (const row of rows) {
    const id = /^\|\s*(C\d+)/.exec(row)?.[1] ?? '?'
    const cells = splitTableRow(row)
    // §7 表四列：| # | 问题 | 裁决 | 落地 | ——「落地」是第 4 格（cells[3]）。
    const landing = cells[3] ?? ''
    if (landing.trim().length === 0) {
      problems.push(`${planPath}：决策 ${id} 的「落地」格为空——没有去向的裁决等于没裁决`)
      continue
    }
    // ADR 存在性检查扫**整行**：裁决格与落地格都可能引用 ADR，引用了就必须真实存在。
    for (const adrId of row.matchAll(/ADR-(\d{3})/g)) {
      const fileName = [...adrFileNames].find((f) => f.startsWith(adrId[1] + '-'))
      if (fileName === undefined) {
        problems.push(`${planPath}：决策 ${id} 引用了 ADR-${adrId[1]}，但 docs/adr/ 下没有对应文件`)
      }
    }
    // 「去向」的三种合法形态：ADR / 仓库内路径（docs|scripts|patches|…/ 文件）/
    // 本计划内的小节引用（§N）。三者都没有 = 裁决悬空。
    const hasAdr = /ADR-\d{3}/.test(landing)
    const hasPath = /(?:docs|scripts|patches|packages|crates|src-tauri|build|harness-locks)\/[\w.-]+/.test(landing)
    const hasSection = /§\d/.test(landing)
    if (!hasAdr && !hasPath && !hasSection) {
      problems.push(`${planPath}：决策 ${id} 的「落地」格既不引用 ADR 也不引用仓库内路径或小节：${landing.trim()}`)
    }
  }
  if (!/^## 11\. 执行记录/m.test(plan)) {
    problems.push(`${planPath}：找不到「## 11. 执行记录」——台账与未开工清单的载体消失了`)
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
  // 表格与散文**分开建常量**：散文声明点是后加的（见 PROSE_DECLARATIONS 末尾），
  // 分成两个夹具才能分别证明「表格抽取器」与「散文抽取器」各自真的在比对——
  // 混成一份时，删掉其中一处而另一处仍在，用例会照样绿。
  const readmeTableEn = [
    '# README',
    '',
    '| Target | Line | Pinned DSH | Desktop tag |',
    '|--------|------|------------|-------------|',
    '| `next` (default) | npm `next` dist-tag (rc stage) | `0.1.5-rc.3` | `rc` |',
    '| `alpha` | npm `alpha` dist-tag | `0.1.6-alpha.2` | `alpha` |'
  ].join('\n')
  const readmeProseEn =
    '> ⚠️ … both lines are aligned: `next` pins `0.1.5-rc.3` and `alpha` pins `0.1.6-alpha.2`, matching upstream.'
  const readmeOk = [readmeTableEn, '', readmeProseEn].join('\n')
  const readmeTableZh = [
    '# README（中文）',
    '',
    '| 目标 | 上游线 | Pinned DSH | 桌面后缀 |',
    '|------|--------|------------|----------|',
    '| `next`（默认） | npm `next` dist-tag（rc 阶段） | `0.1.5-rc.3` | `rc` |',
    '| `alpha` | npm `alpha` dist-tag | `0.1.6-alpha.2` | `alpha` |'
  ].join('\n')
  const readmeProseZh =
    '> ⚠️ …（next `0.1.5-rc.3`、alpha `0.1.6-alpha.2`，与上游 dist-tag 于 2026-10-08 实测一致）。'
  const readmeZhOk = [readmeTableZh, '', readmeProseZh].join('\n')
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
    '（当前：next 线 `0.1.5-rc.3`、alpha 线 `0.1.6-alpha.2`）' +
    '推进后 `next` 锚 `0.1.5-rc.3`、`alpha` 锚 `0.1.6-alpha.2`。'
  const harnessCommentOk =
    '//   next  → DSH 0.1.5-rc.3    （默认；桌面后缀 rc。2026-09-30 从 0.1.5-rc.2 跨 minor 推进）\n' +
    '//   alpha → DSH 0.1.6-alpha.2 （桌面后缀 alpha；2026-10-07 从 0.1.6-alpha.1 推进）'
  const docsOk = {
    'README.md': readmeOk,
    'README.zh-CN.md': readmeZhOk,
    'AGENTS.md': readmeOk,
    'patches/LAYERS.md': layersOk,
    'docs/dsh-upgrade-checklist.md': checklistOk,
    'scripts/prepare-harness.mjs': harnessCommentOk
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

  // --- 夹具 3b：**表格仍对、只有散文过期**（2026-10-07 的真实形态，补守卫前这里是 0） ---
  const staleProse = readmeOk.replace('`next` pins `0.1.5-rc.3`', '`next` pins `0.1.5-rc.2`')
  const proseStale = checkVersionDeclarations({ ...docsOk, 'README.md': staleProse }, TARGETS)
  eq('夹具3b：表格对、散文过期 → 判红 1 条', proseStale.length, 1)
  eq('夹具3b：报错点名散文声明而不是表格', proseStale[0].includes('English 散文'), true)
  // 反证：只改表格那处时，散文声明**不得**跟着报红（否则说明两处抽的是同一个位置）
  eq(
    '夹具3b：两处声明互相独立（改表格只报表格那处）',
    checkVersionDeclarations({ ...docsOk, 'README.md': staleReadme }, TARGETS)[0].includes('README.md:5'),
    true
  )

  // --- 夹具 3c：中文 README 的散文声明同样在生效（新增点不是只测了英文） ---
  const staleZh = readmeZhOk.replace('alpha `0.1.6-alpha.2`', 'alpha `0.1.6-alpha.1`')
  const zhStale = checkVersionDeclarations({ ...docsOk, 'README.zh-CN.md': staleZh }, TARGETS)
  eq('夹具3c：中文散文过期 → 判红 1 条', zhStale.length, 1)
  eq('夹具3c：报错点名中文散文声明', zhStale[0].includes('中文散文'), true)

  // --- 夹具 4：整张表被删掉 → 必须判红（不得因「0 个声明点」而静默通过） ---
  // ⚠️ 本夹具**刻意保留散文**：它要证明的是「表格抽取器发现声明行消失」。
  //    若把散文一并删掉，会同时命中散文判据，那就分不清红在哪一侧了（那是夹具 4b 的事）。
  const noTable = ['# README', '', readmeProseEn].join('\n')
  const deleted = checkVersionDeclarations({ ...docsOk, 'README.md': noTable }, TARGETS)
  eq('夹具4：表格声明行整体消失 → 判红 2 条（每目标一条）', deleted.length, 2)
  eq('夹具4：报错说清是「找不到声明行」', deleted.every((p) => p.includes('找不到')), true)

  // --- 夹具 4b：**散文声明行被删掉**（表格仍在）→ 同样必须判红 ---
  // 这是新声明点的「锚点消失」用例：少了它，把 README 那段 ⚠️ 说明整段删掉就能让新判据
  // 静默变绿（0 个声明点 = 全通过），比写错还危险。
  const proseDeleted = checkVersionDeclarations({ ...docsOk, 'README.md': readmeTableEn }, TARGETS)
  eq('夹具4b：散文声明整体消失 → 判红 2 条', proseDeleted.length, 2)
  eq(
    '夹具4b：报错措辞是「找不到 … 散文」（与表格缺失可区分）',
    proseDeleted.every((p) => p.includes('找不到') && p.includes('散文')),
    true
  )

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

  // --- 夹具 5b：同一文件里的**第二种写法**（「`alpha` 锚 …」）也必须在判据内 ---
  // 真实形态：`docs/dsh-upgrade-checklist.md` 首部相邻两句声明同一事实，
  // 旧判据只守了「next 线 `…`」那种写法，于是另一句停在旧值也照样绿。
  const staleAnchor = checklistOk.replace('`alpha` 锚 `0.1.6-alpha.2`', '`alpha` 锚 `0.1.6-alpha.1`')
  const anchorProblems = checkVersionDeclarations(
    { ...docsOk, 'docs/dsh-upgrade-checklist.md': staleAnchor },
    TARGETS
  )
  eq('夹具5b：`alpha` 锚 写法过期 → 判红 1 条', anchorProblems.length, 1)
  eq('夹具5b：报错点名「`alpha` 锚」这种写法', anchorProblems[0].includes('`alpha` 锚'), true)
  // 反证：只改这一种写法时，同文件的另一种写法**不得**被连带报红
  eq(
    '夹具5b：两种写法互相独立（不重复计问题）',
    anchorProblems[0].includes('next 线'),
    false
  )

  // --- 夹具 5c：源码注释里的现状声明同样受判 ---
  // 2026-10-08 起由「只人工同步」改为自动比对；此前它确实漂移过（停在 0.1.5-rc.3）。
  const staleComment = harnessCommentOk.replace('alpha → DSH 0.1.6-alpha.2', 'alpha → DSH 0.1.6-alpha.1')
  const commentProblems = checkVersionDeclarations(
    { ...docsOk, 'scripts/prepare-harness.mjs': staleComment },
    TARGETS
  )
  eq('夹具5c：源码注释里的版本过期 → 判红 1 条', commentProblems.length, 1)
  eq('夹具5c：报错点名 prepare-harness.mjs', commentProblems[0].includes('prepare-harness.mjs'), true)
  // 反证：注释里的**历史**版本串（「从 X 推进」）不得被当成本仓声明——
  // 否则每次推进都会因为「历史提到了旧版本」而报红。判据只认「→ DSH <版本>」这一形状，
  // 而夹具里两条注释**都**带了历史串，正好把这条边界钉住。
  eq(
    '夹具5c：注释里的历史版本串（「从 X 推进」）不被误抽',
    proseSites(harnessCommentOk, [
      /next\s+→ DSH ([0-9][0-9A-Za-z.-]*)/g,
      /alpha\s+→ DSH ([0-9][0-9A-Za-z.-]*)/g
    ]),
    ['0.1.5-rc.3', '0.1.6-alpha.2']
  )

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

  // --- 夹具 7：决策账本——C1~C8 每行必须有去向（ADR / 仓库路径 / 小节引用） ---
  const adrFileNames = new Set(['052-dual-upstream-channels-restored.md', '053-channelized-updater-manifest.md', '055-keep-daily-ci-and-drift.md'])
  const landingRow = (id, landing) => `| ${id} | 问题 | ✅ 裁决 | ${landing} |`
  const planOk = [
    '# 缺陷治理计划',
    '| # | 问题 | 裁决 | 落地 |',
    '|---|------|------|------|',
    landingRow('C1', 'ADR-052；S0-3'),
    landingRow('C2', 'ADR-053；S1-2'),
    landingRow('C3', 'ADR-052；S5'),
    landingRow('C4', 'ADR-055 清单追加；S6-5 收尾'),
    landingRow('C5', 'ADR-052'),
    landingRow('C6', 'ADR-055；S0-4'),
    landingRow('C7', 'ADR-052'),
    landingRow('C8', 'patches/LAYERS.md「移植裁定」；§6'),
    '',
    '## 11. 执行记录',
    ''
  ].join('\n')
  eq('夹具7：决策表 8 行 + 落地格引用 ADR/路径 → 无问题', checkDecisionLedger({ plan: planOk, adrFileNames }), [])
  // 反证 1：落地格引用了不存在的 ADR-099 → 红
  const badAdr = checkDecisionLedger({
    plan: planOk.replace(landingRow('C2', 'ADR-053；S1-2'), landingRow('C2', 'ADR-099；S1-2')),
    adrFileNames,
  })
  eq('夹具7a：引用不存在的 ADR 必须判红', badAdr.length, 1)
  eq('夹具7a：报错点名 ADR-099', badAdr[0].includes('ADR-099'), true)
  // 反证 2：落地格为空 → 红（「没有去向的裁决等于没裁决」）
  eq(
    '夹具7b：落地格为空必须判红',
    checkDecisionLedger({ plan: planOk.replace(landingRow('C1', 'ADR-052；S0-3'), landingRow('C1', '  ')), adrFileNames }).length,
    1
  )
  // 反证 3：落地格只有一句不带去向的口号 → 红
  eq(
    '夹具7b2：落地格无 ADR/路径/小节引用必须判红',
    checkDecisionLedger({ plan: planOk.replace(landingRow('C3', 'ADR-052；S5'), landingRow('C3', '尽快做')), adrFileNames }).length,
    1
  )
  // 反证 4：决策表被删（只剩 1 行）→ 红（锚点消失不得静默通过——扫出数>0 纪律）
  eq(
    '夹具7c：决策表整体消失必须判红',
    checkDecisionLedger({ plan: '# 缺陷治理计划\n\n没有决策表了。\n\n## 11. 执行记录\n', adrFileNames }).length,
    1
  )
  // 反证 5：§11 执行记录被删 → 红
  eq(
    '夹具7d：执行记录消失必须判红',
    checkDecisionLedger({ plan: planOk.replace('## 11. 执行记录', '## 99. 其他'), adrFileNames }).length,
    1
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

  const adrFileNames = new Set(
    readdirSync(join(projectRoot, 'docs', 'adr')).filter((f) => /^\d{3}-/.test(f))
  )
  const problems = [
    ...checkVersionDeclarations(docs, targets),
    ...checkLockInputs(docs, targets),
    ...checkDecisionLedger({ plan: docs[PLAN_DOC] ?? '', adrFileNames })
  ]

  if (problems.length > 0) {
    console.error(`❌ 计划文档/事实漂移 ${problems.length} 处：`)
    for (const problem of problems) console.error(`  · ${problem}`)
    console.error('')
    console.error('  修法：把文档里的版本号与状态词改成与 `scripts/dsh-targets.mjs` / 账本一致，')
    console.error('  而不是反过来改判据——判据读的是**动态解析**出来的值，它不会漂。')
    process.exit(1)
  }

  console.log(`✅ 计划事实一致：${new Set(paths).size} 个文件 · ${listTargetNames().length} 个目标的版本声明与锚点一致，决策账本自洽`)
  process.exit(0)
}

main()
