#!/usr/bin/env node
/**
 * merge-migrate-patches.mjs — 把一套补丁三路合并移植到新上游版本的辅助工具。
 *
 * ## 它解决什么
 *
 * `check:patch-applicability` 把冲突分成两类：**纯行号漂移**（内容仍匹配，≤20 行窗口内）
 * 与**真冲突**（上游重构了该段）。前者 `recount-patches.mjs` 自动修；后者的标准做法
 * （`docs/dsh-upgrade-checklist.md` §2、0.1.2-alpha.4 → 0.1.5-rc.1 的历史记录）是
 * **三路合并移植**：以「旧版纯净文件」为共同祖先（base），「旧版 + 旧补丁」为我们的
 * 意图状态（ours），「新版纯净文件」为上游现状（theirs），`git merge-file` 合并后
 * 逐条按语义裁定冲突。2026-09-30 前这一步全靠手工摆文件；本脚本把它变成命令。
 *
 * ## 两个模式
 *
 * ```bash
 * # 1) merge：为每个补丁包产出「合并后（可能带冲突标记）」的文件树 + report.json
 * node scripts/merge-migrate-patches.mjs merge \
 *   --dsh-target=next --to=0.2.0-rc.2 --out=<工作目录>
 *
 * # 2) regen：人工解完冲突标记后，从「新版纯净 ↔ 已解决」重新生成补丁文件
 * node scripts/merge-migrate-patches.mjs regen \
 *   --dsh-target=next --to=0.2.0-rc.2 --out=<工作目录> --write
 * ```
 *
 * 工作目录布局（merge 模式产出，regen 模式消费）：
 *   `<out>/<包名>/…`            合并后的包内文件（冲突处带 <<<<<<< 标记）
 *   `<out>/__pristine_new/…`    新版纯净文件（regen 的 diff 左侧；merge 时顺带落盘）
 *   `<out>/report.json`         逐包逐文件的冲突计数
 *
 * ## 边界（诚实声明）
 *
 * · merge 模式**不保证**语义正确：git merge-file 只管文本，重命名/搬家的函数会被
 *   判成「删了旧的、加了新的」而自动合并——**每一个冲突标记都必须人判**，
 *   裁定依据是 `patches/LAYERS.md` 里该补丁的 why/retireWhen。
 * · 本脚本是清单上「重生成补丁」工序的**辅助**，不替代 Step 2.3 的真实组装验证
 *   （`prepare:harness --force` 后 MANIFEST 必须逐条 applied）。
 * · 退役裁定（上游已实现等价能力 → 删补丁）在 merge 之前做更省——先跑
 *   `check:patch-applicability --target=<新版本>` 看哪些包整体干净，再决定谁不用合并。
 *
 * 退出码：`0` 完成（merge 模式允许带冲突退出——冲突是产出而非失败）·
 * `1` 输入错误或补丁在旧版上应用失败 · `2` 参数错误。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetchPackageFiles, parsePatch } from './check-patch-applicability.mjs'
import { packageNameFromPatchFile, versionFromPatchFile } from './patch-layers.mjs'
import { patchesDirFor, resolveDshTargetArg, resolveTarget } from './dsh-targets.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 把补丁 hunk 按内容应用到文件行上（与 recount-patches 的 applier 同一语义）。 */
function applyHunks(lines, hunks, label) {
  let out = [...lines]
  const ordered = [...hunks].sort((a, b) => b.oldStart - a.oldStart)
  for (const hunk of ordered) {
    const block = hunk.lines.filter((l) => l.type === ' ' || l.type === '-').map((l) => l.text)
    const replacement = hunk.lines.filter((l) => l.type === ' ' || l.type === '+').map((l) => l.text)
    let found = -1
    for (let i = 0; i + block.length <= out.length; i += 1) {
      if (block.every((want, k) => out[i + k] === want)) { found = i; break }
    }
    if (found === -1) throw new Error(`${label}：hunk@${hunk.oldStart} 在旧版纯净文件上按内容定位失败（补丁应对自己的基线成立）`)
    out.splice(found, block.length, ...replacement)
  }
  return out
}

/** 下载一个包的文件表（含极简内存缓存，一次进程内同版本只拉一次）。 */
const fetchCache = new Map()
async function pkgFiles(pkg, version) {
  const key = `${pkg}@${version}`
  if (!fetchCache.has(key)) {
    const res = await fetchPackageFiles(pkg, version)
    if (!res.ok) throw new Error(res.reason)
    fetchCache.set(key, res.files)
  }
  return fetchCache.get(key)
}

/**
 * 三路合并单个文件。base 恒等 or 上游恒等的捷径先走，其余交给 git merge-file。
 * @returns {{text: string, conflicts: number, shortcut: string|null}}
 */
function threeWayMerge(oursLines, baseLines, theirsLines, eol) {
  const eq = (a, b) => a.length === b.length && a.every((l, i) => l === b[i])
  if (eq(oursLines, baseLines)) return { text: theirsLines.join(eol), conflicts: 0, shortcut: 'untouched-by-patch' }
  if (eq(baseLines, theirsLines)) return { text: oursLines.join(eol), conflicts: 0, shortcut: 'upstream-unchanged' }

  const tmp = join(projectRoot, '.merge-migrate-tmp')
  mkdirSync(tmp, { recursive: true })
  const paths = { ours: join(tmp, 'ours'), base: join(tmp, 'base'), theirs: join(tmp, 'theirs') }
  for (const [name, lines] of [['ours', oursLines], ['base', baseLines], ['theirs', theirsLines]]) {
    writeFileSync(paths[name], lines.join(eol))
  }
  const result = spawnSync(
    'git',
    ['merge-file', '-p', '-L', 'ours', '-L', 'base', '-L', 'theirs', paths.ours, paths.base, paths.theirs],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  rmSync(tmp, { recursive: true, force: true })
  if (result.status < 0 || result.error) {
    throw new Error(`git merge-file 执行失败：${result.error?.message ?? result.status}（见 relocate-patch-hunks.mjs 头注的 EBUSY 先例，此时本工具不可用）`)
  }
  return { text: result.stdout ?? '', conflicts: result.status, shortcut: null }
}

async function modeMerge(args) {
  const target = resolveTarget(resolveDshTargetArg(args))
  const to = requiredValue(args, '--to=')
  const out = requiredValue(args, '--out=')
  const oldVersion = target.dshVersion

  const patchDir = patchesDirFor(target.name)
  const patchFiles = readdirSync(patchDir).filter((f) => f.endsWith('.patch'))
  const report = { target: target.name, from: target.dshVersion, to, packages: {} }

  for (const file of patchFiles) {
    const pkg = packageNameFromPatchFile(file)
    if (!pkg) throw new Error(`补丁文件名推不出包名：${file}`)
    // 版本取自补丁文件名的版本段：DSH 家族包跟随 dshVersion，而 cordis-plugin-loader
    // 这类独立版本号的包不跟（与 recount-patches / check-patch-applicability 同一约定）。
    const oldVersion = versionFromPatchFile(file)
    if (!oldVersion) throw new Error(`补丁文件名推不出版本段：${file}`)
    const newVersion = targetPackageVersion(file, target.dshVersion, to)
    const parsed = parsePatch(readFileSync(join(patchDir, file), 'utf8'))
    const [oldFiles, newFiles] = [await pkgFiles(pkg, oldVersion), await pkgFiles(pkg, newVersion)]

    const pkgOut = join(out, pkg)
    const pkgPristine = join(out, '__pristine_new', pkg)
    const stat = { patch: file, files: {} }

    for (const entry of parsed) {
      const rel = entry.file.replace(`node_modules/${pkg}/`, '')
      const baseText = oldFiles.get(rel)
      if (baseText === undefined) throw new Error(`${file}：旧版 ${pkg} 里没有 ${rel}`)
      const theirsText = newFiles.get(rel)
      if (theirsText === undefined) throw new Error(`${file}：新版 ${pkg} 里没有 ${rel}（上游删除了该文件？退役/重做裁定后再跑）`)
      const baseLines = baseText.split('\n')
      const oursLines = applyHunks(baseLines, entry.hunks, file)
      const theirsLines = theirsText.split('\n')
      // EOL 保真：以新版文件的行尾为准（regen 的 diff 左侧是它）。
      const eol = theirsText.includes('\r\n') ? '\r\n' : '\n'

      const merged = threeWayMerge(oursLines, baseLines, theirsLines, eol)
      if (merged.conflicts === 0) stat.files[rel] = merged.shortcut ?? 'merged-clean'
      else stat.files[rel] = `CONFLICT x${merged.conflicts}`
      const dest = join(pkgOut, rel)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, merged.text)
      // 新版纯净树同步落盘（regen 的 diff 基准；零冲突文件也需要它）。
      const pristineDest = join(pkgPristine, rel)
      mkdirSync(dirname(pristineDest), { recursive: true })
      writeFileSync(pristineDest, theirsText)
    }
    report.packages[pkg] = stat
    const conflicts = Object.values(stat.files).reduce((n, v) => n + (/CONFLICT x(\d+)/.exec(v)?.[1] ? Number(/CONFLICT x(\d+)/.exec(v)[1]) : 0), 0)
    console.log(`${conflicts === 0 ? '✅' : '⚠️'} ${pkg}：${Object.keys(stat.files).length} 文件，${conflicts} 处冲突`)
  }

  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n工作目录：${out}\n下一步：逐个解决 conflict 标记（裁定依据 patches/LAYERS.md），然后跑 regen --write。`)
}

async function modeRegen(args) {
  const target = resolveTarget(resolveDshTargetArg(args))
  const to = requiredValue(args, '--to=')
  const out = requiredValue(args, '--out=')
  const write = args.includes('--write')
  const patchDir = patchesDirFor(target.name)

  // 工作目录布局：<out>/<scope>/<pkg>（scoped 包，如 @deepseek-ai/dsh）。
  // merge 模式只落盘被补丁触及的文件，多数包根没有 package.json——因此
  // 「包」的判据是：out 与 __pristine_new 在同位路径上都存在该目录（两棵树
  // 由 merge 模式对称写入），外加排除 __pristine_new / report.json 自身。
  const pkgDirs = []
  const outRoot = readdirSync(out)
  for (const scope of outRoot) {
    const scopeAbs = join(out, scope)
    if (scope.startsWith('__') || scope.startsWith('.') || !statSync(scopeAbs).isDirectory()) continue
    for (const pkg of readdirSync(scopeAbs)) {
      const rel = `${scope}/${pkg}`
      if (!statSync(join(out, rel)).isDirectory()) continue
      if (existsSync(join(out, '__pristine_new', rel))) pkgDirs.push(rel)
    }
  }

  // merge 模式的 report.json 记录每个包的**旧补丁文件名**与合并时的 from 版本——
  // 「文件名版本段是否跟随 DSH」的判据只能来自那里：段 == report.from ⇒ 跟随
  // （新段取 --to）；否则是独立版本号的包（如 cordis-plugin-loader，段 1.0.3），
  // 新文件名沿用原段。用 --to 命名独立包会给同一包生成两份补丁，patch-package
  // 会两个都打，而 verify:patches 对独立包的版本段判据是循环的（期望值来自
  // 文件名自身），抓不到这种重复——2026-09-30 实测踩过。
  const reportPath = join(out, 'report.json')
  if (!existsSync(reportPath)) throw new Error(`${out}/report.json 不存在——先跑 merge 模式生成工作目录`)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const oldPatchOf = new Map(Object.entries(report.packages ?? {}).map(([pkg, stat]) => [pkg, stat.patch]))

  for (const pkg of pkgDirs) {
    const pristineNew = join(out, '__pristine_new', pkg)
    if (!existsSync(pristineNew)) throw new Error(`${out}/__pristine_new/${pkg} 不存在——merge 工作目录不完整`)
    const oldPatch = oldPatchOf.get(pkg)
    if (!oldPatch) throw new Error(`report.json 里没有 ${pkg} 的旧补丁记录——工作目录与报告不匹配`)
    const oldSegment = versionFromPatchFile(oldPatch)
    if (!oldSegment) throw new Error(`旧补丁文件名推不出版本段：${oldPatch}`)
    const newVersion = oldSegment === report.from ? to : oldSegment

    const stage = join(projectRoot, '.merge-migrate-tmp', 'diff')
    rmSync(stage, { recursive: true, force: true })
    const left = join(stage, 'left', 'node_modules', pkg)
    const right = join(stage, 'right', 'node_modules', pkg)
    mkdirSync(dirname(left), { recursive: true })
    mkdirSync(dirname(right), { recursive: true })
    // 左侧：新版纯净；右侧：解决后的文件（只拷 merge 模式产出过的文件）。
    copyTree(pristineNew, left)
    copyTree(join(out, pkg), right)

    const result = spawnSync('git', ['diff', '--no-index', '--no-color', '--ignore-space-at-eol', 'left', 'right'], {
      cwd: stage, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
    rmSync(stage, { recursive: true, force: true })
    const raw = result.stdout ?? ''
    if (raw.trim() === '') {
      console.log(`ⓘ ${pkg}：解决后与新版纯净完全一致 → 该补丁在新版上退役（无差异）`)
      continue
    }
    const patchText = normalizePatchText(raw)
    // 文件名版本段：DSH 家族包跟随 --to；独立版本号的包（cordis-plugin-loader）
    // 保留自己的版本段（check-patch-applicability 的 targetPackageVersion 同一约定）。
    // 误用 --to 会给同一包生成**两个**补丁文件（一个旧版本段 + 一个新版本段），
    // patch-package 会两个都打——而 verify:patches 对独立包的版本段判据是循环的
    // （期望值来自文件名自身），抓不到这种重复。
    const destFile = join(patchDir, `${pkg.replaceAll('/', '+')}+${newVersion}.patch`)
    if (write) {
      writeFileSync(destFile, patchText)
      console.log(`✅ ${destFile}（${patchText.split('\n').length} 行）`)
    } else {
      console.log(`ⓘ ${destFile}（dry-run，共 ${patchText.split('\n').length} 行；加 --write 落盘）`)
    }
  }
  if (write) {
    console.log('\n下一步：删除旧版本段补丁文件、跑 npm run verify:patches、再跑 check:patch-applicability --target=' + to + ' 复核。')
  }
}

function copyTree(src, dest) {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) copyTree(s, d)
    else { mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, readFileSync(s)) }
  }
}

/** 与 recount-patches.mjs 同一套输出归一：去 index/mode 行，路径归一成 node_modules 布局。 */
function normalizePatchText(raw) {
  const normalize = (value) => {
    const cleaned = String(value).trim()
    const marker = cleaned.indexOf('node_modules/')
    return marker >= 0 ? cleaned.slice(marker) : cleaned.replace(/^[ab]\//, '')
  }
  const withPrefix = (prefix, value) => {
    const normalized = normalize(value)
    return normalized === '/dev/null' ? normalized : `${prefix}/${normalized}`
  }
  const lines = []
  for (const line of raw.split('\n')) {
    if (/^index [0-9a-f]+\.\.[0-9a-f]+/.test(line)) continue
    if (/^similarity index /.test(line)) continue
    if (/^(deleted|new) file mode /.test(line)) continue
    if (/^old mode |^new mode /.test(line)) continue
    if (line.startsWith('diff --git ')) {
      const [, l = '', r = ''] = /^(\S+)\s+(\S+)/.exec(line.slice('diff --git '.length)) ?? []
      lines.push(`diff --git a/${normalize(l)} b/${normalize(r)}`)
      continue
    }
    if (line.startsWith('--- ')) { lines.push(`--- ${withPrefix('a', line.slice(4))}`); continue }
    if (line.startsWith('+++ ')) { lines.push(`+++ ${withPrefix('b', line.slice(4))}`); continue }
    lines.push(line)
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

function requiredValue(args, prefix) {
  const value = args.find((a) => a.startsWith(prefix))?.slice(prefix.length)
  if (!value) {
    console.error(`缺少 ${prefix}<值> 参数`)
    process.exit(2)
  }
  return value
}

async function main() {
  const args = process.argv.slice(2)
  const mode = args[0]
  const rest = args.slice(1)
  if (mode === 'merge') await modeMerge(rest)
  else if (mode === 'regen') await modeRegen(rest)
  else {
    console.error('用法：merge-migrate-patches.mjs <merge|regen> --dsh-target=<目标> --to=<新版本> --out=<工作目录> [--write]')
    process.exit(2)
  }
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exit(1)
})
