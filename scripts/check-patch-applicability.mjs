#!/usr/bin/env node
/**
 * check-patch-applicability.mjs — 升级前预检：这 18 个补丁在新版本上还打得上吗？
 *
 * ## 为什么存在
 *
 * `docs/dsh-upgrade-checklist.md` Step 2 把「试打补丁并解决冲突」列为**最耗时、最易出错**
 * 的一步，而它的实现方式是 `npm run prepare:harness -- --force`——也就是说，为了知道
 * **哪些补丁冲突**，你要先组装 300MB+ 的完整依赖树、跑一遍 npm install。
 *
 * 本脚本把这一步拆出来独立跑：只下载**被补丁触及的那十几个包**（约 4MB）到临时目录，
 * 逐个做**干跑（dry-run）应用判定**，几秒内给出「干净 / 冲突（第几段 hunk）」的清单。
 * 它回答的问题很窄——**补丁的上下文还对不对得上**——但正是升级时最花时间的那一问。
 *
 * 它**不**回答的问题（说清楚，免得被当成「升级已验证」）：
 *   · 补丁的**语义**是否仍成立（上游可能重构了函数，上下文对得上但意图已变）；
 *   · 组装后的应用能否**启动**（那是 L1/L2 烟雾的事）；
 *   · 依赖树里**其它**未打补丁的包有没有变。
 * 因此它只做「预检」：把冲突清单提前几秒给你，**不替代**完整升级流程。
 *
 * ## 判定逻辑（纯 JS，无 `patch` 二进制依赖）
 *
 * **全流程零外部二进制**：下载用 Node 内置 `fetch`，解包用 `zlib` + 自带的极简
 * tar 读取器，全部在内存里完成。刻意**不**调 `curl` / `tar` / `patch`——Windows
 * 是主力平台，而 MSYS 工具对 `/tmp` 的解析与 Node 不一致（实测：Node 写
 * `/tmp/x.tgz` 落到 `D:\tmp`，MSYS `tar` 去 `C:\...\Temp` 找，直接 `Cannot open`）。
 * 走子进程就会踩这类路径翻译坑，还会在无 `tar` 的环境上失效。
 *
 * diff 匹配同样自带：把每个 hunk 的「上下文 + 删除行」拼成期望块，在目标文件里找连续匹配。
 *
 * **默认严格匹配（fuzz = 0），与 `patch-package` 的行为一致**：`patch-package`
 * 不做上下文模糊，上下文对不上就是冲突。（`patch(1)` 默认允许 2 行 fuzz，比
 * `patch-package` 宽松；这里刻意不跟着放宽——放宽会漏报真实冲突。）
 * 判定为**保守**：匹配不到即报冲突，宁可多报也不漏报（漏报会让升级在打包时才炸）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-patch-applicability.mjs --target=0.1.2-rc.1
 * node scripts/check-patch-applicability.mjs --target=0.1.5-rc.2 --keep
 * node scripts/check-patch-applicability.mjs --self-test        # 纯逻辑自检（不联网）
 * DSH_REGISTRY=https://registry.npmmirror.com node scripts/check-patch-applicability.mjs --target=…
 * ```
 *
 * 退出码：`0` 全部干净（或仅有非 functional 冲突被记录）/ `1` 有 `functional` 层冲突 /
 *         `2` 参数错误 / 无法联网。
 */

import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { argv, env, exit } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PATCHES_DIR, listPatchFiles, layerOf, packageNameFromPatchFile } from './patch-layers.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const prepareScript = join(projectRoot, 'scripts', 'prepare-harness.mjs')
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/**
 * 默认上下文模糊行数：**0**，与 `patch-package` 的严格匹配一致。
 * （`patch(1)` 默认是 2，比 patch-package 宽松；跟随它会漏报真实冲突。）
 */
export const DEFAULT_FUZZ = 0

// ---------------------------------------------------------------------------
// 统一 diff 解析
// ---------------------------------------------------------------------------

/**
 * 解析统一 diff 文本为「按文件分组的多段 hunk」。
 *
 * 只解析本仓库 `patch-package` 会产出的形状：`diff --git` / `---` / `+++` /
 * `@@ -a,b +c,d @@` / 行首 ` ` `-` `+` `\`。不认识的元数据行忽略。
 *
 * @param {string} text diff 文本
 * @returns {{file:string, hunks:{oldStart:number, lines:{type:string,text:string}[]}[]}[]}
 */
export function parsePatch(text) {
  const files = []
  let current = null
  let hunk = null

  // 补丁文件在本仓库是 **CRLF** 检出（`patch(1)` 会打印 "Stripping trailing CRs"）。
  // 目标包内容是 LF。若不剥离行尾 `\r`，每个 hunk 都会因尾字符不匹配而假冲突
  // ——这正是本脚本第一版全判 18 冲突的原因。统一按 LF 解析。
  for (const raw of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = null
      hunk = null
      continue
    }
    if (raw.startsWith('+++ ')) {
      // `+++ b/node_modules/...` —— 取 b/ 侧路径，去掉前导 b/。
      const path = raw.slice(4).trim().replace(/^[ab]\//, '')
      current = { file: path, hunks: [] }
      files.push(current)
      hunk = null
      continue
    }
    if (raw.startsWith('--- ')) continue

    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
    if (header) {
      hunk = { oldStart: Number(header[1]), lines: [] }
      if (current) current.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (raw.startsWith('\\')) continue // `\ No newline at end of file`
    const marker = raw[0]
    if (marker === ' ') hunk.lines.push({ type: ' ', text: raw.slice(1) })
    else if (marker === '-') hunk.lines.push({ type: '-', text: raw.slice(1) })
    else if (marker === '+') hunk.lines.push({ type: '+', text: raw.slice(1) })
  }
  return files
}

/**
 * 把 hunk 的「上下文 + 删除行」拼成需要在目标文件里出现的期望块。
 * @param {{type:string,text:string}[]} lines
 * @returns {{text:string, types:string[]}}
 */
function expectedBlock(lines) {
  const kept = lines.filter((line) => line.type === ' ' || line.type === '-')
  return { text: kept.map((line) => line.text), types: kept.map((line) => line.type) }
}

/**
 * 从期望块两端各裁掉至多 `lead` / `trail` 行**上下文**（非上下文行不可裁）。
 * @returns {string[]|null} 裁不动时返回 null
 */
function trimContext(block, types, lead, trail) {
  let start = 0
  let end = block.length
  for (let i = 0; i < lead; i += 1) {
    if (types[start] !== ' ') return null
    start += 1
  }
  for (let i = 0; i < trail; i += 1) {
    if (types[end - 1] !== ' ') return null
    end -= 1
  }
  return block.slice(start, end)
}

/**
 * 在文件行数组里找 `block` 的连续出现，返回最靠近 `around`（0 基）的下标。
 * @returns {number} 未找到返回 -1
 */
function findNearest(lines, block, around) {
  if (block.length === 0) return -1
  let best = -1
  for (let i = 0; i + block.length <= lines.length; i += 1) {
    let ok = true
    for (let j = 0; j < block.length; j += 1) {
      if (lines[i + j] !== block[j]) {
        ok = false
        break
      }
    }
    if (ok) {
      if (best === -1) best = i
      // 先找到的若已足够接近即可停；这里取与 around 最近的一个。
      if (Math.abs(i - around) < Math.abs(best - around)) best = i
    }
  }
  return best
}

/**
 * 判定单个 hunk 能否应用到一个文件（含 fuzz）。
 * @param {string[]} fileLines 目标文件按行切分
 * @param {{oldStart:number, lines:{type:string,text:string}[]}} hunk
 * @param {number} maxFuzz
 * @returns {{ok:boolean, fuzz:number, index:number}}
 */
export function hunkApplies(fileLines, hunk, maxFuzz = DEFAULT_FUZZ) {
  const { text: block, types } = expectedBlock(hunk.lines)
  if (block.length === 0) return { ok: true, fuzz: 0, index: -1 } // 纯新增块，恒可应用
  for (let fuzz = 0; fuzz <= maxFuzz; fuzz += 1) {
    for (let lead = 0; lead <= fuzz; lead += 1) {
      const trail = fuzz - lead
      const trimmed = trimContext(block, types, lead, trail)
      if (!trimmed) continue
      const idx = findNearest(fileLines, trimmed, Math.max(0, hunk.oldStart - 1))
      if (idx >= 0) return { ok: true, fuzz, index: idx }
    }
  }
  return { ok: false, fuzz: -1, index: -1 }
}

/**
 * 判定一份补丁（多文件多 hunk）能否整体应用到一棵源码树。
 *
 * @param {{file:string, hunks:any[]}[]} parsed 解析结果
 * @param {(relPath:string)=>string[]|null} readLines 按补丁里的相对路径取目标文件的行
 * @param {number} [maxFuzz] 允许的上下文模糊行数（默认 `DEFAULT_FUZZ`，即严格）
 * @returns {{ok:boolean, files:{file:string, missing:boolean, failedHunks:{index:number, oldStart:number}[], total:number}[]}}
 */
export function patchApplies(parsed, readLines, maxFuzz = DEFAULT_FUZZ) {
  const files = []
  let ok = true
  for (const entry of parsed) {
    const lines = readLines(entry.file)
    if (!lines) {
      ok = false
      files.push({ file: entry.file, missing: true, failedHunks: [], total: entry.hunks.length })
      continue
    }
    const failedHunks = []
    entry.hunks.forEach((hunk, index) => {
      if (!hunkApplies(lines, hunk, maxFuzz).ok) failedHunks.push({ index: index + 1, oldStart: hunk.oldStart })
    })
    if (failedHunks.length > 0) ok = false
    files.push({ file: entry.file, missing: false, failedHunks, total: entry.hunks.length })
  }
  return { ok, files }
}

/**
 * 把补丁文件名里的版本段替换成目标版本（仅替换「DSH 家族」版本）。
 *
 * 独立版本号的包（如 `@deepseek-ai+cordis-plugin-loader+1.0.3.patch`）不能跟着
 * DSH 版本走——它们的版本段就是它自己的版本。判据：只有当文件名里的版本段
 * **等于当前 `DSH_VERSION`** 时才替换。
 *
 * @param {string} fileName 补丁文件名
 * @param {string} currentDshVersion 当前 `DSH_VERSION`
 * @param {string} targetVersion 目标版本
 * @returns {string} 目标包版本
 */
export function targetPackageVersion(fileName, currentDshVersion, targetVersion) {
  const base = fileName.replace(/\.patch$/, '')
  const parts = base.split('+')
  const version = parts[parts.length - 1]
  return version === currentDshVersion ? targetVersion : version
}

/**
 * 从 `prepare-harness.mjs` 读 `DSH_VERSION`。
 * @param {string} text
 * @returns {string|null}
 */
export function readDshVersion(text) {
  const m = /const\s+DSH_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(text ?? '')
  return m ? m[1] : null
}

/**
 * 极简 tar 读取器：把 gzip 后的 tarball 解成 `{ 路径 → 文件内容 }`。
 *
 * 只处理 npm 包会用到的 ustar 形状（普通文件 + pax/GNU 长名扩展）。目的不是实现
 * 一个完整 tar，而是**免掉对 `tar` 二进制的依赖**（见文件头「零外部二进制」）。
 *
 * @param {Buffer} gz gzip 压缩的 tar 字节
 * @returns {Map<string, string>} 路径 → UTF-8 文本
 */
export function readTarGz(gz) {
  const buf = gunzipSync(gz)
  const files = new Map()
  let offset = 0
  let longName = null
  let paxPath = null

  const readString = (start, length) => {
    const slice = buf.subarray(start, start + length)
    const end = slice.indexOf(0)
    return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
  }
  const readOctal = (start, length) => {
    const raw = readString(start, length).trim()
    return raw ? parseInt(raw, 8) : 0
  }

  while (offset + 512 <= buf.length) {
    // 全零块（或其后续）表示归档结束。
    const header = buf.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break

    let name = readString(offset, 100)
    const prefix = readString(offset + 345, 155)
    if (prefix) name = `${prefix}/${name}`
    const size = readOctal(offset + 124, 12)
    const typeflag = String.fromCharCode(buf[offset + 156] || 0x30)
    offset += 512

    const content = buf.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512

    if (typeflag === 'L') {
      longName = content.toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (typeflag === 'x' || typeflag === 'g') {
      // pax 扩展头：从 `N path=...` 记录里取路径。
      const m = /(?:^|\n)\d+ path=([^\n]+)/.exec(content.toString('utf8'))
      if (m) paxPath = m[1]
      continue
    }
    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      const resolved = longName ?? paxPath ?? name
      longName = null
      paxPath = null
      // 去掉 npm 打包时的顶层 `package/`。
      const rel = resolved.replace(/^package\//, '')
      if (!resolved.endsWith('/')) files.set(rel, content.toString('utf8'))
    }
  }
  return files
}

/**
 * 下载一个 npm 包并解成内存文件表（不落盘）。
 *
 * @returns {Promise<{ok:true, files:Map<string,string>}|{ok:false, reason:string}>}
 */
export async function fetchPackageFiles(pkg, version, registry = DEFAULT_REGISTRY, timeoutMs = 60000) {
  const url = `${String(registry).replace(/\/+$/, '')}/${pkg.replace('/', '%2F')}/-/${pkg.split('/').pop()}-${version}.tgz`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}（${pkg}@${version}）` }
    const gz = Buffer.from(await res.arrayBuffer())
    return { ok: true, files: readTarGz(gz) }
  } catch (error) {
    return { ok: false, reason: `下载/解包失败 ${pkg}@${version}：${error?.message ?? error}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从内存文件表里按补丁相对路径取文件行。
 *
 * 补丁路径形如 `node_modules/@deepseek-ai/<pkg>/lib/client.js`，而 tarball 内的
 * 条目是**包相对**的（`lib/client.js`）。因此要把 `node_modules/<pkg>/` 整段剥掉
 * ——只剥 `node_modules/` 是不够的，包里不含自己的包名。
 *
 * @param {Map<string,string>} files 内存文件表（键为包相对路径）
 * @param {string} pkg 该补丁所属的包名
 * @returns {(relPath:string)=>string[]|null}
 */
function makeReader(files, pkg) {
  const cache = new Map()
  const prefixes = [`node_modules/${pkg}/`, 'node_modules/', '/']
  return (relPath) => {
    let key = relPath
    for (const prefix of prefixes) {
      if (key.startsWith(prefix)) {
        key = key.slice(prefix.length)
        break
      }
    }
    if (cache.has(key)) return cache.get(key)
    const text = files.get(key)
    const lines = text === undefined ? null : text.split('\n')
    cache.set(key, lines)
    return lines
  }
}

/** 自检：纯逻辑，不联网。 */
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

  // 夹具说明：diff 里上下文行带**一个**前导空格（` ` 标记），删除/新增行带 `-` `+`。
  // 目标文件的行**不带**标记。两侧必须按这个约定对齐，否则是在测夹具自己写错。
  const sample = [
    'diff --git a/node_modules/x/lib/index.js b/node_modules/x/lib/index.js',
    '--- a/node_modules/x/lib/index.js',
    '+++ b/node_modules/x/lib/index.js',
    '@@ -2,3 +2,4 @@',
    ' const keep = 1;',
    '-const old = 2;',
    '+const neu = 2;',
    '+const extra = 3;',
    ' const tail = 4;'
  ].join('\n')

  const parsed = parsePatch(sample)
  check('parsePatch 文件数', parsed.length, 1)
  check('parsePatch 路径', parsed[0].file, 'node_modules/x/lib/index.js')
  check('parsePatch hunk 数', parsed[0].hunks.length, 1)

  // 期望块 = 上下文 + 删除行 = ['const keep = 1;', 'const old = 2;', 'const tail = 4;']
  const target = ['const header = 0;', 'const keep = 1;', 'const old = 2;', 'const tail = 4;']
  check('可应用 → ok', patchApplies(parsed, () => target).ok, true)

  // 可证伪性：改掉一行上下文，必须判为冲突
  const broken = ['const header = 0;', 'const CHANGED = 1;', 'const old = 2;', 'const tail = 4;']
  const brokenResult = patchApplies(parsed, () => broken)
  check('上下文漂移 → ok=false', brokenResult.ok, false)
  check('上下文漂移 → 命中 hunk 1', brokenResult.files[0].failedHunks[0].index, 1)

  // 文件缺失也必须算失败（不能因为读不到就当通过）
  check('目标文件缺失 → ok=false', patchApplies(parsed, () => null).ok, false)

  // 严格匹配（与 patch-package 一致）：行号位移不影响（按内容找），但被改的上下文行必须报冲突。
  const shifted = ['const prepad = -1;', 'const keep = 1;', 'const old = 2;', 'const tail = 4;']
  check('行号位移（内容不变）→ ok', patchApplies(parsed, () => shifted).ok, true)
  // 可证伪性：显式放宽 fuzz 时，被改的**边缘**上下文行才会被容忍——证明严格/宽松确有区别。
  const brokenOne = ['const header = 0;', 'const keep = 1;', 'const old = 2;', 'const CHANGED = 4;']
  check('边缘行改动 + fuzz=0 → 冲突', patchApplies(parsed, () => brokenOne).ok, false)
  check('边缘行改动 + fuzz=1 → 容忍', patchApplies(parsed, () => brokenOne, 1).ok, true)

  // targetPackageVersion：DSH 家族跟随目标，独立版本号保持
  check('DSH 家族版本跟随', targetPackageVersion('@deepseek-ai+dsh+0.1.2-alpha.4.patch', '0.1.2-alpha.4', '0.1.2-rc.1'), '0.1.2-rc.1')
  check('独立版本号保持', targetPackageVersion('@deepseek-ai+cordis-plugin-loader+1.0.3.patch', '0.1.2-alpha.4', '0.1.2-rc.1'), '1.0.3')

  if (failed > 0) {
    console.error(`check-patch-applicability self-test: ${failed} 项失败`)
    exit(1)
  }
  console.log('check-patch-applicability self-test: 全部通过（含上下文漂移可证伪性）')
}

/** 主流程。 */
async function main() {
  if (argv.includes('--self-test')) {
    selfTest()
    return
  }

  const targetArg = argv.find((arg) => arg.startsWith('--target='))
  const targetVersion = targetArg ? targetArg.slice('--target='.length) : ''
  if (!targetVersion) {
    console.error('用法：node scripts/check-patch-applicability.mjs --target=<版本>')
    console.error('  例：node scripts/check-patch-applicability.mjs --target=0.1.2-rc.1')
    exit(2)
  }

  const current = readDshVersion(readFileSync(prepareScript, 'utf8'))
  if (!current) {
    console.error('无法从 scripts/prepare-harness.mjs 读到 DSH_VERSION')
    exit(2)
  }

  const registry = env.DSH_REGISTRY || DEFAULT_REGISTRY
  const files = listPatchFiles()

  console.log('[check-patch-applicability] 补丁适用性预检')
  console.log(`  当前 DSH_VERSION : ${current}`)
  console.log(`  目标版本         : ${targetVersion}`)
  console.log(`  补丁数           : ${files.length}`)
  console.log(`  registry         : ${registry}`)
  console.log('')

  const results = []
  const fetched = new Map()
  for (const file of files) {
    const pkg = packageNameFromPatchFile(file)
    const version = targetPackageVersion(file, current, targetVersion)
    const key = `${pkg}@${version}`
    if (!fetched.has(key)) {
      fetched.set(key, await fetchPackageFiles(pkg, version, registry))
    }
    const fetchResult = fetched.get(key)
    if (!fetchResult.ok) {
      results.push({ file, layer: layerOf(file).layer, status: 'skip', detail: fetchResult.reason })
      continue
    }
    const parsed = parsePatch(readFileSync(join(PATCHES_DIR, file), 'utf8'))
    const applied = patchApplies(parsed, makeReader(fetchResult.files, pkg))
    results.push({
      file,
      layer: layerOf(file).layer,
      status: applied.ok ? 'clean' : 'conflict',
      files: applied.files
    })
  }

  const clean = results.filter((r) => r.status === 'clean')
  const conflicts = results.filter((r) => r.status === 'conflict')
  const skipped = results.filter((r) => r.status === 'skip')

  for (const r of results) {
    if (r.status === 'clean') {
      console.log(`  ✅ clean    [${r.layer.padEnd(11)}] ${r.file}`)
    } else if (r.status === 'skip') {
      console.log(`  ⏭  skip     [${r.layer.padEnd(11)}] ${r.file} —— ${r.detail}`)
    } else {
      const total = r.files.reduce((n, f) => n + f.total, 0)
      const bad = r.files.reduce((n, f) => n + f.failedHunks.length, 0)
      const missing = r.files.filter((f) => f.missing).map((f) => f.file)
      const hunks = r.files
        .flatMap((f) => f.failedHunks.map((h) => `hunk#${h.index}@${h.oldStart}`))
        .join(', ')
      console.log(`  ❌ conflict [${r.layer.padEnd(11)}] ${r.file}`)
      if (missing.length > 0) console.log(`        目标文件缺失：${missing.join(', ')}`)
      if (hunks) console.log(`        ${bad}/${total} 段 hunk 未匹配：${hunks}`)
    }
  }

  console.log('')
  console.log(`  小结：clean ${clean.length} · conflict ${conflicts.length} · skip ${skipped.length}`)

  const blocking = conflicts.filter((r) => r.layer === 'functional')
  if (skipped.length > 0) {
    console.log('  ⚠️ 存在 skip —— 未能下载/解包，结论不完整；请检查网络或 registry 后重跑。')
  }
  if (blocking.length > 0) {
    console.error(`  ❌ ${blocking.length} 个 functional 层补丁冲突——缺失会阻断启动，必须先解决：`)
    for (const r of blocking) console.error(`     ${r.file}`)
    exit(1)
  }
  if (conflicts.length > 0) {
    console.log(`  ⚠️ ${conflicts.length} 个非 functional 补丁冲突：按分级策略可降级，但按升级清单 Step 2.3 仍应逐个裁定（退役 / 重生成 / 重做）。`)
  }
  if (skipped.length === 0 && conflicts.length === 0) {
    console.log(`  ✅ 全部 ${clean.length} 个补丁在 ${targetVersion} 上干净可用。`)
  }
  console.log('  提醒：本预检只判「上下文能否对上」，不判语义是否仍成立，也不等于升级已验证。')
}

// ESM「主模块」判定：仅当被直接执行（而非 import）时跑 CLI。
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main()
}
