#!/usr/bin/env node
/**
 * report-patches.mjs — 补丁健康度报告（层 / 实际应用结果 / 退役条件）。
 *
 * ## 为什么存在
 *
 * 补丁维护税是本项目最大的长期成本：`上游变更数 × 补丁数 × 运行时变体数`。
 * 降低它的第一步是**让它可见**——现在要知道「这些补丁里哪些真的打上了、
 * 哪些是可退役的老补丁」，得同时翻 `patches/LAYERS.md`、`scripts/patch-layers.mjs`
 * 和 `resources/MANIFEST.json` 三处。
 *
 * 本脚本把三者合成一张表：
 *   · **层**与**退役条件**来自 `patch-layers.mjs`（单一事实源）；
 *   · **实际应用结果**（`applied` / `skipped` / `failed`）来自 `MANIFEST.json`
 *     ——那是组装期写下的**证据**，不是承诺。
 *
 * 它同时输出「补丁数 / 可退役候选数」两个计数，供 `docs/roadmap.md` §5.3 的
 * 「补丁数趋势」目标跟踪。
 *
 * ## 数据缺失时的行为
 *
 * `MANIFEST.json` 只存在于**组装之后**；在全新 checkout 或 CI 的纯静态作业里
 * 它不存在。此时报告**仍然有效**——它列出层与退役条件，只是「实际结果」一列
 * 标为 `—`（未组装）。**不会**因为缺文件就伪造 `applied`。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/report-patches.mjs                 # 人类可读表
 * node scripts/report-patches.mjs --markdown      # 进 CI job summary
 * node scripts/report-patches.mjs --manifest <path>
 * ```
 *
 * 退出码：恒为 `0`——这是**报告**，不是门禁。要断言补丁健康请用 `verify:patches`
 * 与 `prepare:harness` 的分级失败策略。
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { argv } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { listPatchFiles, layerOf, packageNameFromPatchFile, PATCHES_DIR, LAYERS } from './patch-layers.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_MANIFEST = join(projectRoot, 'src-tauri', 'resources', 'MANIFEST.json')

/**
 * 读取 `MANIFEST.json` 里的 `patches[]`。
 *
 * @param {string} path manifest 路径
 * @returns {{present:boolean, assembledAt:string|null, rows:Map<string,{status:string,layer:string,detail:string|null}>}}
 */
export function loadPatchResults(path = DEFAULT_MANIFEST) {
  if (!existsSync(path)) return { present: false, hasPatchRecords: false, assembledAt: null, rows: new Map() }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { present: false, hasPatchRecords: false, assembledAt: null, rows: new Map() }
  }
  const rows = new Map()
  for (const entry of Array.isArray(parsed.patches) ? parsed.patches : []) {
    if (!entry || typeof entry.file !== 'string') continue
    rows.set(entry.file, {
      status: typeof entry.status === 'string' ? entry.status : 'unknown',
      layer: typeof entry.layer === 'string' ? entry.layer : '?',
      detail: entry.detail ?? null
    })
  }
  // `hasPatchRecords` 区分「MANIFEST 存在但只有桩数据（无 patches 数组）」与
  // 「真跑过组装」。桩 MANIFEST（`stub-tauri-resources.mjs` 写的）属于前者，
  // 若当成后者会显示「applied 0」——那读起来像「组装跑了但一个补丁都没打上」，
  // 与事实（根本没组装）相反。
  return { present: true, hasPatchRecords: rows.size > 0, assembledAt: parsed.assembledAt ?? null, rows }
}

/**
 * 汇总补丁健康度。纯函数，便于自检。
 *
 * @param {string[]} files 补丁文件名
 * @param {{present:boolean, rows:Map<string,any>}} manifest
 * @returns {{rows:object[], total:number, counts:Record<string,number>, retireCandidates:number, functional:number}}
 */
export function summarize(files, manifest) {
  const rows = files.map((file) => {
    const info = layerOf(file)
    const recorded = manifest.present ? manifest.rows.get(file) : undefined
    return {
      file,
      package: packageNameFromPatchFile(file),
      layer: info.layer,
      classified: info.classified,
      retireWhen: info.retireWhen,
      status: recorded?.status ?? null,
      detail: recorded?.detail ?? null
    }
  })
  const counts = { applied: 0, skipped: 0, failed: 0, unknown: 0, absent: 0 }
  for (const row of rows) {
    if (row.status === null) counts.absent += 1
    else if (counts[row.status] !== undefined && row.status !== 'unknown') counts[row.status] += 1
    else counts.unknown += 1
  }
  return {
    rows,
    total: rows.length,
    counts,
    // 可退役候选：有明确 retireWhen 判据的补丁——推进上游时要逐个对照。
    retireCandidates: rows.filter((row) => typeof row.retireWhen === 'string' && row.retireWhen.length > 0).length,
    functional: rows.filter((row) => row.layer === 'functional').length
  }
}

/** 自检：纯逻辑，不读真实 MANIFEST。 */
function selfTest() {
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

  const files = ['@deepseek-ai+dsh+0.1.2-alpha.4.patch', '@deepseek-ai+dsh-client-ui-chat+0.1.2-alpha.4.patch']

  // manifest 缺失：全部记为 absent，绝不当成 applied
  const missing = summarize(files, { present: false, rows: new Map() })
  check('缺 manifest → absent 计数', missing.counts.absent, 2)
  check('缺 manifest → applied 仍为 0', missing.counts.applied, 0)

  // manifest 存在：按真实状态归集，并把层取自分级表
  const present = summarize(files, {
    present: true,
    rows: new Map([
      [files[0], { status: 'applied', layer: 'functional', detail: null }],
      [files[1], { status: 'failed', layer: 'ui-behavior', detail: 'conflict' }]
    ])
  })
  check('有 manifest → applied', present.counts.applied, 1)
  check('有 manifest → failed', present.counts.failed, 1)
  check('层来自分级表（functional）', present.rows[0].layer, 'functional')
  check('可退役候选数', present.retireCandidates, 2)

  if (failed > 0) {
    console.error(`report-patches self-test: ${failed} 项失败`)
    process.exitCode = 1
    return
  }
  console.log('report-patches self-test: 全部通过')
}

/** 主流程。 */
function main() {
  if (argv.includes('--self-test')) {
    selfTest()
    return
  }

  const manifestArgIndex = argv.findIndex((arg) => arg === '--manifest')
  const manifestPath =
    manifestArgIndex >= 0 && argv[manifestArgIndex + 1] ? resolve(argv[manifestArgIndex + 1]) : DEFAULT_MANIFEST
  const markdown = argv.includes('--markdown')

  const files = listPatchFiles()
  const manifest = loadPatchResults(manifestPath)
  const summary = summarize(files, manifest)
  const rel = (p) => p.replace(projectRoot, '').replace(/^[\\/]/, '').replace(/\\/g, '/')
  const statusCell = (row) => (row.status === null ? '—' : row.status)

  if (markdown) {
    const lines = []
    lines.push('## 补丁健康度')
    lines.push('')
    lines.push(
      `补丁总数 **${summary.total}** · functional **${summary.functional}** · 可退役候选 **${summary.retireCandidates}**`
    )
    if (manifest.hasPatchRecords) {
      lines.push(
        `\n本次组装（${manifest.assembledAt ?? '未知时间'}）：applied ${summary.counts.applied} · ` +
          `skipped ${summary.counts.skipped} · failed ${summary.counts.failed}`
      )
    } else if (manifest.present) {
      lines.push(`\n${rel(manifestPath)} 无补丁记录（桩数据 / 未组装）——「结果」列不可用。`)
    } else {
      lines.push(`\n未找到 ${rel(manifestPath)}（未组装或纯静态作业）——「结果」列不可用。`)
    }
    lines.push('')
    lines.push('| 层 | 结果 | 补丁 | 退役条件 |')
    lines.push('|---|---|---|---|')
    for (const row of summary.rows) {
      lines.push(`| ${row.layer} | ${statusCell(row)} | \`${row.file}\` | ${row.retireWhen ?? '—'} |`)
    }
    const rendered = lines.join('\n')
    // 与 `report-bundle-size.mjs` 同一约定：`--markdown` 在设置 `$GITHUB_STEP_SUMMARY`
    // 时写入 job summary，否则打印到 stdout。
    const summaryPath = process.env.GITHUB_STEP_SUMMARY
    if (summaryPath) {
      appendFileSync(summaryPath, `${rendered}\n`)
    } else {
      console.log(rendered)
    }
    return
  }

  console.log('[report-patches] 补丁健康度报告')
  console.log(`  源目录 : ${rel(PATCHES_DIR)}`)
  const manifestNote = manifest.hasPatchRecords
    ? '（已读取）'
    : manifest.present
      ? '（存在但无补丁记录——桩数据 / 未组装）'
      : '（不存在——未组装）'
  console.log(`  manifest: ${rel(manifestPath)} ${manifestNote}`)
  console.log(`  层定义 : ${LAYERS.join(' / ')}`)
  console.log('')
  for (const row of summary.rows) {
    const tag = row.classified ? ' ' : '*'
    console.log(`  ${tag} [${row.layer.padEnd(11)}] ${statusCell(row).padEnd(8)} ${row.file}`)
  }
  console.log('')
  console.log(`  合计：${summary.total} 个补丁（functional ${summary.functional}）· 可退役候选 ${summary.retireCandidates}`)
  if (manifest.hasPatchRecords) {
    console.log(
      `  本次组装：applied ${summary.counts.applied} · skipped ${summary.counts.skipped} · failed ${summary.counts.failed}`
    )
  } else if (manifest.present) {
    console.log('  本次组装：MANIFEST 存在但无补丁记录（桩数据 / 未组装），结果列不可用')
  } else {
    console.log('  本次组装：未找到 MANIFEST.json（未组装），结果列不可用')
  }
  console.log('')
  console.log('  注：本报告只陈述事实，不作门禁。补丁健康断言见 `npm run verify:patches`。')
}

// ESM「主模块」判定：仅当被直接执行（而非 import）时跑 CLI。
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main()
}
