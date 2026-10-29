#!/usr/bin/env node
/**
 * verify-patch-layers.mjs — 对**每一个** DSH 构建目标跑补丁分级自检 + 退役复核。
 *
 * ## 为什么不是直接调 `patch-layers.mjs --self-test`
 *
 * 双通道（`next` / `alpha`）各有自己的一套 `patches/<target>/`。只验默认目标
 * 意味着另一条线的补丁可以整目录漏登记、或版本串停在旧值而无人发现——
 * 而那条线**同样会发布给用户**。分级表的唯一性是按目标成立的，检查就必须
 * 逐目标跑一遍。
 *
 * ## 检查项
 *
 * 每个目标的检查项见 `patch-layers.mjs::auditPatchLayers`：包名可推导、
 * 在分级表里登记过、层名合法、`retireWhen` 非空、`regressionTest` 可解、
 * DSH 家族的文件名版本段与目标版本一致。
 *
 * 本文件另加两条**只在编排层成立**的判据：
 *
 * | 编号 | 检查 | 级别 |
 * |------|------|------|
 * | R1 | 退役复核扫描出的行数必须等于**该目标的补丁文件数**（AGENTS §7.3 E5-空：扫描端被过滤时不得全绿） | 错误 |
 * | R2 | **`@deepseek-ai/dsh` 补丁 ↔ `build/dsh-desktop.patch.yml` ↔ `vendor/` 三面一致**（见 {@link checkDesktopDependencyDeclaration}） | 错误 |
 *
 * ### R2 是「移除补丁即红」回归指向的真实载荷（V6）
 *
 * `@deepseek-ai/dsh` 那条 `functional` 补丁的唯一意图是：把三个 `dsh-desktop-*`
 * 插件包声明成 dsh 的依赖，好让 `build/dsh-desktop.patch.yml` 的 `insert: name`
 * 解析得到包。三面**缺任一面**，profile 启动即失败（`patches/LAYERS.md` 的判据行）。
 * 在这条守卫之前，三面各由不同的人手改、**没有任何检查把它们对起来**：
 * 删掉补丁、少写一行依赖、或 patch.yml 里新增一个 insert 行而补丁没跟上，
 * 组装仍然「成功」，代价只在用户那里表现为「装好了起不来」。
 *
 * 这个判据**不需要上游代码、不联网、不需组装树**（纯静态三面比对），
 * 所以它在 fast/ci/release 三档都能真跑——这正是 `patch-layers.mjs` 里那条
 * `regressionTest: 'scripts/verify-patch-layers.mjs::checkDesktopDependencyDeclaration'`
 * 指向它的理由。其余四个 functional 补丁的行为只能靠真实上游模块验，
 * 按纪律登记为 `none: <理由>`（见 `patches/LAYERS.md` §5 的 V6-0 盘点表）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-patch-layers.mjs              # 全部目标
 * node scripts/verify-patch-layers.mjs --dsh-target=alpha
 * ```
 *
 * 退出码：`0` 全部通过 · `1` 任一目标不一致 · `2` 参数错误。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { argv, exit } from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CRITICAL_LAYER,
  auditPatchLayers,
  listPatchFiles,
  packageNameFromPatchFile,
  parseRegressionTest,
  retirementRows
} from './patch-layers.mjs'
import { listTargetNames, resolveDshTargetArg, resolveTarget } from './dsh-targets.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 桌面插件依赖声明的承载包：三面契约里「补丁」那一面。 */
const DECLARATION_PACKAGE = '@deepseek-ai/dsh'

/** 三面契约的另外两面。 */
const PROFILE_PATCH_FILE = 'build/dsh-desktop.patch.yml'
const VENDOR_DIR = 'vendor'

/** 默认读文本：仓库相对路径 → 文本；读不到返回 null（调用方判红）。 */
function readRepoText(relPath) {
  try {
    return readFileSync(resolve(projectRoot, relPath), 'utf8')
  } catch {
    return null
  }
}

/** 默认列 vendor 子目录；目录不存在返回空数组。 */
function listVendorDirs() {
  try {
    return readdirSync(resolve(projectRoot, VENDOR_DIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * 从 `build/dsh-desktop.patch.yml` 文本里取 `insert:` 块的 `name:` 值。
 *
 * 只认**顶层 `- insert:` 之后**的 `name:` 行：注释行先剔除（退役插件的说明里
 * 仍提到名字），块在下一个顶层 `- ` 列表项处结束——否则注释/其它块的 `name:`
 * 会被当成插入项，三面比对就变成「跟一段不存在的声明对账」。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseInsertNames(text) {
  const names = []
  let inInsert = false
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    // 行尾注释剔掉（退役插件的说明里仍会提到包名）；整行注释直接跳过。
    const line = raw.replace(/\s+#.*$/, '')
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    // **缩进即层级**：顶层列表项都在第 0 列。insert 块内的 `- id:` 是缩进过的，
    // 不能当成「块结束」——否则 name 行永远扫不到（本函数首版就这么错过一次）。
    if (/^-\s*insert:\s*$/.test(line)) {
      inInsert = true
      continue
    }
    if (/^-\s/.test(line)) {
      inInsert = false
      continue
    }
    if (!inInsert) continue
    const match = /^\s+name:\s*(\S+)\s*$/.exec(line)
    if (match !== null) names.push(match[1])
  }
  return names
}

/**
 * 从 `patch-package` 补丁文本里取**新增**的依赖声明包名（`+    "pkg": "ver",`）。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseAddedDependencyNames(text) {
  const names = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.startsWith('+')) continue
    const match = /^\+\s*"([^"]+)"\s*:\s*"[^"]*"\s*,?\s*$/.exec(raw)
    if (match !== null) names.push(match[1])
  }
  return names
}

/**
 * R2：`@deepseek-ai/dsh` 补丁的依赖声明 ↔ `patch.yml` 的 insert 项 ↔ `vendor/` 目录，三面必须一致。
 *
 * 纯函数（输入全部可注入），因此能脱离文件系统自检。
 *
 * @param {object} input
 * @param {string[]} input.patchFiles 该目标的补丁文件名
 * @param {(relPath: string) => string | null} input.readText 读文本（null = 不存在）
 * @param {() => string[]} input.vendorDirs 列 vendor 子目录
 * @returns {string[]} 问题清单
 */
export function checkDesktopDependencyDeclaration({ patchFiles, readText, vendorDirs }) {
  const problems = []
  const patchFile = patchFiles.find((file) => packageNameFromPatchFile(file) === DECLARATION_PACKAGE)
  if (patchFile === undefined) {
    problems.push(
      `${DECLARATION_PACKAGE} 的补丁不在本目标里：桌面插件依赖声明没有承载者 ` +
        `（${PROFILE_PATCH_FILE} 的 insert 行会解析不到包，profile 启动即失败）`
    )
    return problems
  }

  const profileText = readText(PROFILE_PATCH_FILE)
  if (profileText === null) {
    problems.push(`${PROFILE_PATCH_FILE} 不存在：三面契约的「profile 声明」一面缺失，判据无法核对`)
    return problems
  }
  const insertNames = parseInsertNames(profileText)

  const patchText = readText(patchFile)
  if (patchText === null) {
    problems.push(`${patchFile} 读不到：三面契约的「补丁」一面缺失`)
    return problems
  }
  const declaredNames = parseAddedDependencyNames(patchText)

  // E5-空：任何一面扫出 0 都先怀疑扫描器，而不是「本来就没有」。
  if (insertNames.length === 0) {
    problems.push(`${PROFILE_PATCH_FILE} 里扫出 0 个 insert name——扫描器或文件形态变了（这不等于「本来就没有」）`)
  }
  if (declaredNames.length === 0) {
    problems.push(`${patchFile} 里扫出 0 个新增依赖行——补丁语义被改回上游写法了？（applicable ≠ 语义还在）`)
  }

  const dirs = new Set(vendorDirs())
  const declared = new Set(declaredNames)
  const inserted = new Set(insertNames)

  for (const name of declared) {
    if (!inserted.has(name)) {
      problems.push(
        `补丁声明了依赖 ${name}，但 ${PROFILE_PATCH_FILE} 没有对应的 insert 行——多装一个用不上的插件`
      )
    }
    if (!dirs.has(name)) {
      problems.push(`补丁声明了依赖 ${name}，但 ${VENDOR_DIR}/${name} 不存在——组装时解析不到，alias 指向空气`)
    }
  }
  for (const name of inserted) {
    if (!declared.has(name)) {
      problems.push(
        `${PROFILE_PATCH_FILE} 的 insert 行 ${name} 没有对应的依赖声明（${patchFile}）——` +
          'profile 启动时 `insert: name` 解析不到包，这正是本补丁要防的那一类启动失败'
      )
    }
  }
  return problems
}

/**
 * 按目标跑全部检查。
 *
 * @param {string} target 目标名
 * @returns {{problems: string[], files: number, pointers: number, carriers: number, functional: number}}
 */
function auditTarget(target) {
  const files = listPatchFiles(target)
  const rows = retirementRows(target)
  const problems = [...auditPatchLayers(target)]

  // R1：扫描行数 == 补丁文件数（扫描端不得被过滤）。
  if (rows.length !== files.length) {
    problems.push(
      `退役复核扫描出 ${rows.length} 行，但 ${target} 有 ${files.length} 个补丁文件——扫描端被过滤了（E5-空）`
    )
  }

  // R2：「移除补丁即红」的那条真实回归指向。
  problems.push(
    ...checkDesktopDependencyDeclaration({
      patchFiles: files,
      // 补丁文件在目标目录下，其余路径相对仓库根：先按仓库根读，再回落到目标目录。
      readText: (relPath) => readRepoText(relPath) ?? readRepoText(`patches/${target}/${relPath}`),
      vendorDirs: listVendorDirs
    })
  )

  return {
    problems,
    files: files.length,
    pointers: rows.filter((row) => parseRegressionTest(row.regressionTest).kind === 'pointer').length,
    carriers: rows.filter((row) => parseRegressionTest(row.regressionTest).kind === 'none').length,
    functional: rows.filter((row) => row.layer === CRITICAL_LAYER).length
  }
}

function main() {
  const args = argv.slice(2)
  let targets
  if (args.some((arg) => arg.startsWith('--dsh-target='))) {
    try {
      targets = [resolveDshTargetArg(args)]
    } catch (error) {
      console.error(`[verify:patches] ${error.message}`)
      exit(2)
    }
  } else {
    targets = listTargetNames()
  }

  let failed = 0
  for (const target of targets) {
    const result = auditTarget(target)
    const summary =
      `${result.files} 个补丁全部分级且包名/版本一致 · retireWhen 非空 · ` +
      `functional ${result.functional} 个（回归指向 ${result.pointers} / 显式无载体 ${result.carriers}）`
    if (result.problems.length === 0) {
      console.log(`✅ 目标 ${target}（DSH ${resolveTarget(target).dshVersion}）：${summary}`)
      continue
    }
    failed += 1
    console.error(`❌ 目标 ${target}（DSH ${resolveTarget(target).dshVersion}）：`)
    for (const problem of result.problems) console.error(`   - ${problem}`)
  }

  if (failed > 0) {
    console.error(`\n${failed}/${targets.length} 个目标的补丁分级表不一致`)
    exit(1)
  }
  console.log(`\n全部 ${targets.length} 个目标通过`)
}

main()
