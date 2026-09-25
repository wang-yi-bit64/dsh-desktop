#!/usr/bin/env node
/**
 * recount-patches.mjs — 把补丁的 hunk 行号重算到目标版本的真实位置。
 *
 * ## 为什么必须存在这一步（2026-09-15 的 alpha 线真实事故）
 *
 * `patch-package` 定位 hunk 的方式与 `patch(1)` 的「按内容搜索」不同：它从 `@@ -N`
 * 给的 `N` 开始试，偏移取 0、-1、+1、-2、+2 …，**绝对值超过 20 就放弃**
 * （`node_modules/patch-package/dist/patch/apply.js` 的 `fuzzingOffset`）。
 *
 * 于是「把补丁从一条上游线复制到另一条、只改文件名」会产生一个很隐蔽的失败：
 * 上下文仍能匹配（内容没变），但行号漂移到 20 行以上，`patch-package` 定位不到，
 * 真实组装时报 `cannot apply the patch file`。而 `patch-applicability` 的预检
 * （它按内容搜索，比 patch-package 宽松）会判 clean——两处结论相反，缺陷只在
 * 花几分钟下载 300MB 组装之后才暴露。
 *
 * 本脚本把行号重算成真实值。判据是「在纯净树上按内容应用成功」→ 用应用后的文件
 * 与纯净文件重生成补丁（`git diff --no-index` 给出的行号必然正确）。
 *
 * ## 为什么不用 `git apply --recount`
 *
 * 那是标准做法，但本机与 CI 的写入路径可能被钩子 / 权限拦截，`git apply` 会
 * **静默 no-op**（退出码 0、文件没动）——正是本仓反复强调的那类「看起来成功、
 * 其实什么都没做」。因此这里在 Node 内做内存级应用，再写临时树比对。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/recount-patches.mjs --dsh-target=<目标名> [--pristine=<纯净包根>]
 * ```
 *
 * `--pristine` 默认 `harness-deps/<target>-pristine`。⚠️ 这个默认路径**是目标键、不带版本**，
 * 同一目录在通道内被复用（`next/` 从 rc.2 一路用到 rc.3），所以**它证明不了里面是哪一版**。
 * 本脚本**不校验**纯净树的版本（`existsSync` 过了就用），因此换锚点后务必把纯净树
 * 连同版本一起命名（如 `harness-deps/next-pristine-0.1.7-rc.1`）并显式传 `--pristine=<dir>`，
 * 否则会照旧版本的上下文行号把补丁写回。需要版本判据的场合用
 * `relocate-patch-hunks.mjs`（它有 `pristineVersionProblem`）。
 * 正确的输入是**未打补丁的上游包**，通常来自 `npm pack` 或 registry tarball 的临时解包。
 *
 * 退出码：`0` 全部重算并写回 · `1` 有补丁无法重算 · `2` 参数错误。
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parsePatch } from './check-patch-applicability.mjs'
import { packageNameFromPatchFile, versionFromPatchFile } from './patch-layers.mjs'
import { patchesDirFor, resolveDshTargetArg } from './dsh-targets.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 在文件行数组里应用一组 hunk（按内容定位，找不到即抛错）。
 *
 * 刻意**不**用 patch-package 的 ±20 窗口：这里的目标正是修掉超窗的漂移，
 * 所以先做全文件搜索。
 *
 * @param {string[]} lines 目标文件行
 * @param {object[]} hunks 解析出的 hunk
 * @param {string} label 出错时用于报错
 * @returns {string[]} 应用后的行
 */
function applyHunks(lines, hunks, label) {
  let out = [...lines]
  // 从后往前应用：前面的 hunk 行号才不受已插入/删除的行影响。
  const ordered = [...hunks].sort((a, b) => b.oldStart - a.oldStart)
  for (const hunk of ordered) {
    const block = hunk.lines.filter((l) => l.type === ' ' || l.type === '-').map((l) => l.text)
    const replacement = hunk.lines.filter((l) => l.type === ' ' || l.type === '+').map((l) => l.text)
    let found = -1
    const near = Math.max(0, hunk.oldStart - 1)
    for (let i = 0; i + block.length <= out.length; i += 1) {
      if (block.every((want, k) => out[i + k] === want)) {
        found = i
        break
      }
    }
    if (found === -1) {
      throw new Error(`${label}：hunk @${hunk.oldStart} 的上下文在目标文件里找不到（补丁与目标版本不匹配）`)
    }
    out = [...out.slice(0, found), ...replacement, ...out.slice(found + block.length)]
  }
  return out
}

/**
 * 生成「node_modules 布局」的补丁文本。
 *
 * 与 `git diff --no-index` 的差异：只保留 patch-package 认识的形状，
 * 且把两棵树的路径归一成 `node_modules/<pkg>/...`。
 *
 * @param {string} leftDir 变换前的树（含 node_modules/）
 * @param {string} rightDir 变换后的树（含 node_modules/）
 * @returns {string} 补丁文本
 */
function makePatchText(leftDir, rightDir) {
  const stage = join(projectRoot, '.recount-tmp', 'diff')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  cpSync(leftDir, join(stage, 'left'), { recursive: true })
  cpSync(rightDir, join(stage, 'right'), { recursive: true })

  const result = spawnSync('git', ['diff', '--no-index', '--no-color', '--ignore-space-at-eol', 'left', 'right'], {
    cwd: stage,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  const raw = result.stdout ?? ''
  rmSync(stage, { recursive: true, force: true })

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
      const [, left = '', right = ''] = /^(\S+)\s+(\S+)/.exec(line.slice('diff --git '.length)) ?? []
      lines.push(`diff --git a/${normalize(left)} b/${normalize(right)}`)
      continue
    }
    if (line.startsWith('--- ')) {
      lines.push(`--- ${withPrefix('a', line.slice(4))}`)
      continue
    }
    if (line.startsWith('+++ ')) {
      lines.push(`+++ ${withPrefix('b', line.slice(4))}`)
      continue
    }
    lines.push(line)
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/** 主流程。 */
function main() {
  const args = process.argv.slice(2)
  // 拒绝任何不认识的参数：位置参数（`recount-patches.mjs alpha`）曾经**被静默忽略**，
  // 于是「重算 alpha 的行号」实际跑在默认目标 next 上——命令看起来成功，动的是另一套
  // 补丁。这正是本仓最忌讳的静默 no-op，所以这里对未知参数直接报错。
  const known = ['--dsh-target=', '--pristine=']
  const unknown = args.filter((arg) => !known.some((prefix) => arg.startsWith(prefix)))
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(', ')}`)
    console.error('用法：node scripts/recount-patches.mjs --dsh-target=<目标名> [--pristine=<未打补丁的包根>]')
    console.error('  注意：目标名必须写成 --dsh-target=<name>；位置参数形式不被接受。')
    process.exit(2)
  }

  let target
  try {
    target = resolveDshTargetArg(args)
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
  const pristineArg = args.find((a) => a.startsWith('--pristine='))?.slice('--pristine='.length)
  const pristineRoot = pristineArg ?? join(projectRoot, 'harness-deps', `${target}-pristine`)
  if (!existsSync(pristineRoot)) {
    console.error(
      `找不到未打补丁的上游包目录：${pristineRoot}\n` +
        `  这是本脚本的**必要输入**——组装后的 harness-deps/ 已经打过补丁，行号无法据此重算。\n` +
        `  用 --pristine=<dir> 指定，或用 npm pack 解出该目标的各包。`
    )
    process.exit(2)
  }

  const patchDir = patchesDirFor(target)
  const scratch = join(projectRoot, '.recount-tmp', 'work')
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })

  let failures = 0
  for (const file of readdirSync(patchDir).filter((f) => f.endsWith('.patch'))) {
    const pkgName = packageNameFromPatchFile(file)
    const version = versionFromPatchFile(file)
    const pristinePkg = join(pristineRoot, pkgName)
    if (!pkgName || !existsSync(pristinePkg)) {
      console.error(`✗ ${file}：${pristineRoot} 下找不到 ${pkgName ?? '(无法推导)'}`)
      failures += 1
      continue
    }

    const leftRoot = join(scratch, 'left', 'node_modules', pkgName)
    const rightRoot = join(scratch, 'right', 'node_modules', pkgName)
    mkdirSync(dirname(leftRoot), { recursive: true })
    mkdirSync(dirname(rightRoot), { recursive: true })
    cpSync(pristinePkg, leftRoot, { recursive: true })
    cpSync(pristinePkg, rightRoot, { recursive: true })

    try {
      const parsed = parsePatch(readFileSync(join(patchDir, file), 'utf8'))
      for (const entry of parsed) {
        const rel = entry.file.replace(`node_modules/${pkgName}/`, '')
        const targetFile = join(rightRoot, rel)
        const text = readFileSync(targetFile, 'utf8')
        const eol = text.includes('\r\n') ? '\r\n' : '\n'
        writeFileSync(targetFile, applyHunks(text.split(/\r?\n/), entry.hunks, file).join(eol))
      }
    } catch (error) {
      console.error(`✗ ${file}：${error.message}`)
      failures += 1
      continue
    }

    const patchText = makePatchText(join(scratch, 'left'), join(scratch, 'right'))
    copyFileSync(join(patchDir, file), join(scratch, `${file}.bak`))
    writeFileSync(join(patchDir, file), patchText)
    console.log(`✅ ${file}（${pkgName}@${version}）：行号已重算`)
  }

  rmSync(join(projectRoot, '.recount-tmp', 'left'), { recursive: true, force: true })
  rmSync(join(projectRoot, '.recount-tmp', 'right'), { recursive: true, force: true })

  if (failures > 0) {
    console.error(`\n${failures} 个补丁重算失败（其余已写回 patches/${target}/）`)
    process.exit(1)
  }
  console.log(`\n全部补丁行号已重算。请重跑 prepare:harness -- --dsh-target=${target} --force 复核。`)
}

main()
