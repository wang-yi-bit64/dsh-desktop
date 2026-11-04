#!/usr/bin/env node
/**
 * fetch-primary-runtime.mjs — 把 primary runtime 载荷的输入拉成"源目录"。
 *
 * # 它解决什么问题
 *
 * `prepare-primary-runtime.mjs` 要求调用方提供三样本仓不自产的东西：python 解释器、
 * office-skills（三份 SKILL.md + check_office.py）、以及一个 schema 要求的 `pnpm.mjs`。
 * 本脚本把它们变成**可复现的构建期产物**：
 *
 *   * 解释器：python-build-standalone 的 CPython 发行版（按 URL + sha256 钉死）；
 *   * office skills / pnpm：从锁定版本的 npm 包里取文件。
 *
 * 产出是**源目录**（`dependencies/` + `office-skills/`），交给
 * `scripts/prepare-primary-runtime.mjs --source <dir>` 做组装与完整性判定。
 * 两步分开：拉错 vs 装错能在命令行上看出来，不用翻构建日志。
 *
 * 2026-10-07 起只拉这一份形态。曾经还带 8 个 python 库的 wheel 交叉安装
 * （numpy/pandas/python-docx/python-pptx/openpyxl/Pillow/lxml/XlsxWriter），
 * 但那 8 个库的唯一读者是上游**工具描述**与 skill 的 SKILL.md，本仓代码一个都不
 * 引用，整条 `--tier full` 路径因此拆除。
 *
 * # 供应链纪律
 *
 * 所有 URL / 版本 / 摘要都在 `runtime-locks/primary-runtime.json`，**不进 Rust 代码**
 * （AGENTS.md §3.2：业务逻辑里严禁硬编码外部 URL）。摘要不符即失败——宁可没有
 * 这个功能，也不放进一个来路不明的解释器。
 *
 * ## 两种摘要，别混填（锁里的 `_verification` 有同样一段）
 *
 * | 字段 | 格式 | 覆盖的输入 | 在哪一步生效 |
 * |------|------|------------|--------------|
 * | `sha256` | 十六进制 64 位 | **本地落盘的 tarball 字节** | 解释器：解压前；npm 包：`npm pack` 落盘后 → 进缓存前 → 每次命中缓存 |
 * | `integrity` | SRI，`sha512-<base64>` | **上游自称分发的那份 tarball**（registry 的 `dist.integrity`） | 只在「新建产物」那一次与 sha256 并列复核 |
 *
 * 两者是同一份字节的两种指纹，**不是二选一**：sha256 是本仓的锁定值，负责守本地缓存
 * 与离线复验；integrity 是上游自述，负责证明「我们锁的字节就是 registry 公布的那份」。
 * 缓存命中时只复算 sha256——integrity 是远端声明，本地无从再取。
 *
 * ## fail-closed 的完整链路
 *
 *   下载 → 体积/sha256/integrity 校验 → 进缓存 → 解压
 *
 * 校验不过的字节**绝不进缓存、绝不解压**；缓存里那份每次命中都重新校验，不符就删掉
 * 并让本次运行失败（不解压降级、不静默重下——篡改过的缓存是需要人看见的事件，
 * 不是可以悄悄绕过的抖动）。锁里缺 sha256 / bytes / integrity 时 `readLock()` 直接
 * 拒绝执行，**不会退化成「只比版本号」**。
 *
 * # 用法
 *
 * ```bash
 * node scripts/fetch-primary-runtime.mjs --self-test   # 离线自检（不联网）
 * node scripts/fetch-primary-runtime.mjs               # 拉当前主机对应目标
 * ```
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const LOCK_PATH = 'runtime-locks/primary-runtime.json'
const RELEASE_BASE = 'https://github.com/astral-sh/python-build-standalone/releases/download'
const NPM_REGISTRY = 'https://registry.npmjs.org'

/** 目标三元组 → pip 的 wheel 平台标签。 */
const TARGETS = Object.freeze({
  'win32-x64': { node: 'win32', arch: 'x64' },
  'darwin-arm64': { node: 'darwin', arch: 'arm64' },
  'darwin-x64': { node: 'darwin', arch: 'x64' },
  'linux-x64': { node: 'linux', arch: 'x64' },
  'linux-arm64': { node: 'linux', arch: 'arm64' },
})

/** 本仓的锁定值：tarball 的十六进制 sha256。 */
const SHA256_HEX = /^[a-f0-9]{64}$/u

/** 上游的自述值：npm registry `dist.integrity`（SRI，sha512 base64）。**不是** sha256 hex。 */
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/u

function log(line) { console.log(`[fetch-runtime] ${line}`) }

function fail(line) {
  console.error(`[fetch-runtime] ${line}`)
  process.exitCode = 1
}

function readLock() {
  if (!existsSync(LOCK_PATH)) {
    fail(`找不到锁定文件 ${LOCK_PATH}`)
    return null
  }
  let lock
  try {
    lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
  } catch (error) {
    fail(`${LOCK_PATH} 不是合法 JSON：${error.message}`)
    return null
  }
  const problems = []
  const interp = lock.interpreter
  if (interp === undefined || typeof interp.release !== 'string' || typeof interp.pythonVersion !== 'string') {
    problems.push('lock 缺少 interpreter.release / interpreter.pythonVersion')
  } else {
    for (const target of Object.keys(TARGETS)) {
      const entry = interp.targets?.[target]
      if (entry === undefined) {
        problems.push(`lock 缺少 targets.${target}`)
        continue
      }
      for (const key of ['artifact', 'sha256', 'bytes', 'layout']) {
        if (entry[key] === undefined) problems.push(`lock 的 ${target} 缺少 ${key}`)
      }
      if (entry.sha256 !== undefined && !SHA256_HEX.test(entry.sha256)) {
        problems.push(`lock 的 ${target}.sha256 不是 64 位十六进制`)
      }
    }
  }
  for (const key of ['pnpm', 'officeSkills']) {
    const entry = lock[key]
    if (entry === undefined) {
      problems.push(`lock 缺少 ${key}`)
      continue
    }
    // 缺摘要不是「跳过校验」，是锁不完整：拒绝执行，别让版本号冒充钉死。
    if (typeof entry.version !== 'string' || entry.version.length === 0) {
      problems.push(`lock 的 ${key}.version 缺失`)
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256)) {
      problems.push(`lock 的 ${key}.sha256 缺失或不是 64 位十六进制（缺哈希即拒绝下载）`)
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) {
      problems.push(`lock 的 ${key}.bytes 缺失或非正整数`)
    }
    if (typeof entry.integrity !== 'string' || !SRI_SHA512.test(entry.integrity)) {
      problems.push(`lock 的 ${key}.integrity 缺失或不是 sha512 SRI（不是 sha256 hex，别混填）`)
    }
  }
  if (problems.length > 0) {
    fail(`锁定文件不合法：\n  - ${problems.join('\n  - ')}`)
    return null
  }
  return lock
}

/** 宿主平台对应的目标三元组。 */
function hostTarget() {
  const found = Object.keys(TARGETS).find(
    (target) => TARGETS[target].node === process.platform && TARGETS[target].arch === process.arch,
  )
  return found ?? null
}

/**
 * 下载到 `destination`，带指数退避重试。
 *
 * 重试的理由：解释器是几十 MB 的单体下载，CI 上一次 TCP 抖动就会让整轮装配失败，
 * 而这种失败与"锁定错了"无关，重试即可。
 */
async function download(url, destination, attempts = 3) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      writeFileSync(destination, buffer)
      return buffer.byteLength
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
      }
    }
  }
  throw new Error(`下载 ${url} 失败（${attempts} 次尝试）：${lastError?.message ?? lastError}`)
}

function sha256of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 同一份字节的另一种指纹：SRI（sha512 base64），格式与 npm 的 `dist.integrity` 一致。 */
function sriOf(file) {
  return `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`
}

/**
 * 校验一个已落盘的 tarball，返回 `{ ok, bytes, reason }`。**只判定，不写盘、不解压**，
 * 这样「校验」与「使用」之间没有可乘之机。
 *
 * @param {string} file 待校验文件
 * @param {{sha256: string, bytes: number, integrity?: string}} entry 锁里那一条
 * @param {string} label 报错时的点名（「解释器下载」「pnpm 缓存」…）
 */
function verifyTarball(file, entry, label) {
  if (!existsSync(file)) return { ok: false, bytes: 0, reason: `${label} 不存在：${file}` }
  const bytes = statSync(file).size
  if (bytes !== entry.bytes) {
    return { ok: false, bytes, reason: `${label} 体积不符：期望 ${entry.bytes}，实得 ${bytes}` }
  }
  const digest = sha256of(file)
  if (digest !== entry.sha256) {
    return { ok: false, bytes, reason: `${label} sha256 不符：期望 ${entry.sha256}，实得 ${digest}` }
  }
  if (entry.integrity !== undefined) {
    const sri = sriOf(file)
    if (sri !== entry.integrity) {
      return { ok: false, bytes, reason: `${label} 上游 integrity 不符：期望 ${entry.integrity}，实得 ${sri}` }
    }
  }
  return { ok: true, bytes, reason: '' }
}

/** 解压 tar.gz / zip 到目标目录（用系统 tar/node 内置能力，避免引入依赖）。 */
function extract(archive, destination) {
  mkdirSync(destination, { recursive: true })
  if (archive.endsWith('.zip')) {
    execFileSync(process.execPath, [
      '-e',
      `
      const { execFileSync } = require('node:child_process')
      const ps = process.platform === 'win32'
        ? ['powershell', ['-NoProfile', '-Command', \`Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force\`]]
        : ['unzip', ['-q', '-o', '${archive}', '-d', '${destination}']]
      execFileSync(ps[0], ps[1], { stdio: 'inherit' })
      `,
    ], { stdio: 'inherit' })
    return
  }
  execFileSync('tar', ['-xzf', archive, '-C', destination, '--strip-components=1'], { stdio: 'inherit' })
}

/** 解析命令行参数（只支持 `--key value` 与 `--flag`），与其它脚本一致。 */
function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[token.slice(2)] = next
      index += 1
    } else {
      args[token.slice(2)] = true
    }
  }
  return args
}

/** 目录里最新的 `.tgz`（`npm pack` 每次只放一个进来）。 */
function newestTgz(dir) {
  const found = readdirSync(dir)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]
  if (found === undefined) throw new Error(`${dir} 里没有 .tgz`)
  return join(dir, found.name)
}

/**
 * 取得一个 npm 包的 tarball，**先校验再进缓存**，返回可直接解压的路径。
 *
 * 顺序被刻意写死成「缓存 → 校验 → 否则 npm pack → 校验 → 进缓存 → 解压」：
 * 校验不过的分支一律 `throw`，因此既不会写进缓存，也走不到解压——这是计划点名的
 * fail-closed 链路；缓存里那份每次命中都要重新算 sha256，篡改过的会被删除并让本次
 * 运行失败（不降级成「重新下一份」——那会把篡改事件掩盖成一次普通的慢构建）。
 *
 * @param {{sha256: string, bytes: number, integrity?: string}} lockEntry 锁里那一条
 * @param {string} label 缓存文件名与报错用的点名
 * @param {string} spec `npm pack` 的包规格（`<name>@<version>`）
 * @param {string} cacheDir 缓存目录（跨目标共享）
 * @param {string} stageDir `npm pack` 的落盘目录
 */
function obtainNpmTarball(lockEntry, label, spec, cacheDir, stageDir) {
  const cached = join(cacheDir, `npm-${lockEntry.sha256.slice(0, 16)}-${label}.tgz`)
  if (existsSync(cached)) {
    const verdict = verifyTarball(cached, lockEntry, `${label} 缓存`)
    if (verdict.ok) {
      log(`${label} 命中缓存并通过校验`)
      return cached
    }
    rmSync(cached, { force: true })
    throw new Error(`${verdict.reason}（缓存文件已删除，未解压；重跑会重新拉取）`)
  }
  execFileSync('npm', ['pack', spec, '--pack-destination', stageDir], { stdio: 'pipe' })
  const packed = newestTgz(stageDir)
  const verdict = verifyTarball(packed, lockEntry, `${label} 下载产物`)
  if (!verdict.ok) throw new Error(`${verdict.reason}（未进缓存、未解压）`)
  mkdirSync(cacheDir, { recursive: true })
  copyFileSync(packed, cached)
  log(`${label} 校验通过并已进缓存（${(verdict.bytes / 1e6).toFixed(2)} MB）`)
  // 返回**刚被校验的那份**而不是缓存副本：解压的字节与算摘要的字节是同一份，中间没有 copy 这道缝。
  return packed
}

/**
 * 拉取一个目标，产出源目录。
 * @returns {boolean} 是否成功
 */
async function fetchTarget(lock, target, outRoot) {
  const entry = lock.interpreter.targets[target]
  const out = join(outRoot, target)
  rmSync(out, { recursive: true, force: true })
  const work = mkdtempSync(join(tmpdir(), 'fetch-runtime-'))
  try {
    // 1) 解释器：优先用缓存里的（**每次命中都重新校验**），否则下载。
    const url = `${RELEASE_BASE}/${encodeURIComponent(lock.interpreter.release)}/${encodeURIComponent(entry.artifact)}`
    const archive = join(work, entry.artifact.endsWith('.zip') ? 'py.zip' : 'py.tar.gz')
    const cacheDir = join(outRoot, '.cache')
    const cached = join(cacheDir, `${entry.sha256.slice(0, 16)}-${entry.artifact}`)
    // 解压只认这个变量：它要么是刚校验过的缓存，要么是刚校验过的下载产物。
    let verifiedArchive = null
    let bytes = 0
    if (existsSync(cached)) {
      const verdict = verifyTarball(cached, entry, `解释器缓存 ${entry.artifact}`)
      if (verdict.ok) {
        verifiedArchive = cached
        bytes = verdict.bytes
        log(`解释器命中缓存并通过校验：${entry.artifact}`)
      } else {
        // 缓存里那份不可信：删掉并让本次运行失败。静默重下会把篡改掩盖成一次慢构建。
        rmSync(cached, { force: true })
        fail(`${verdict.reason}（缓存文件已删除，未解压；重跑会重新下载）`)
        return false
      }
    }
    if (verifiedArchive === null) {
      await download(url, archive)
      // 先校验再进缓存：不能把来路不明的产物留在盘上供下次直接使用。
      const verdict = verifyTarball(archive, entry, `解释器下载 ${entry.artifact}`)
      if (!verdict.ok) {
        fail(`${verdict.reason}（未进缓存、未解压）`)
        return false
      }
      mkdirSync(cacheDir, { recursive: true })
      copyFileSync(archive, cached)
      // 同上：解压用刚被校验的那份，不用缓存副本。
      verifiedArchive = archive
      bytes = verdict.bytes
    }
    log(`解释器校验通过：${entry.artifact}（${(bytes / 1e6).toFixed(1)} MB）`)
    const python = join(out, 'dependencies', 'python')
    extract(verifiedArchive, python)

    // 2) office skills 与 pnpm：来自锁定版本的 npm 包，两份 tarball 各自先校验再进缓存。
    const npmStage = mkdtempSync(join(tmpdir(), 'fetch-npm-'))
    try {
      // skills：`npm pack` 的产物名是 `<scope>-<name>-<version>.tgz`，不能写死。
      const skillTarball = obtainNpmTarball(
        lock.officeSkills,
        'dsh-skill-office',
        `${lock.officeSkills.package}@${lock.officeSkills.version}`,
        cacheDir,
        npmStage,
      )
      const skillsOut = join(out, 'office-skills')
      mkdirSync(skillsOut, { recursive: true })
      // `stdio: 'pipe'`：tar 逐文件打印会把几百 MB 的解释器解压日志淹掉，这里只需要
      // 成功与否；产物树由调用方自己 `ls` 核对。
      execFileSync('tar', [
        '-xzf', skillTarball, '-C', skillsOut, '--strip-components=2',
        'package/assets/office-docx', 'package/assets/office-pptx',
        'package/assets/office-xlsx', 'package/assets/scripts/check_office.py',
      ], { stdio: 'pipe' })
      log(`office skills 就位：${skillsOut}`)

      // pnpm
      const pnpmTarball = obtainNpmTarball(lock.pnpm, 'pnpm', `pnpm@${lock.pnpm.version}`, cacheDir, npmStage)
      const pnpmOut = join(out, 'dependencies', 'pnpm', 'bin')
      mkdirSync(pnpmOut, { recursive: true })
      // 剥两层后 `package/bin/pnpm.mjs` 只剩 `pnpm.mjs`，因此解到 bin/ 本身。
      execFileSync('tar', ['-xzf', pnpmTarball, '-C', pnpmOut, '--strip-components=2', 'package/bin/pnpm.mjs'], { stdio: 'pipe' })
      log(`pnpm ${lock.pnpm.version} 就位`)
    } finally {
      rmSync(npmStage, { recursive: true, force: true })
    }

    // 3) node：载荷 schema 要求 `dependencies/node/bin/node[.exe]`（本仓自己就在打包它）。
    //    用 `copyFileSync` 而不是 `cp`：后者在 Windows 上不存在。
    const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node'
    const bundled = join('src-tauri', 'resources', 'node', nodeBin)
    const nodeOut = join(out, 'dependencies', 'node', 'bin')
    mkdirSync(nodeOut, { recursive: true })
    if (existsSync(bundled)) {
      copyFileSync(bundled, join(nodeOut, nodeBin))
      log(`node 就位（来自 ${bundled}）`)
    } else {
      // 没有组装资源时退到当前进程的可执行文件；协同构建里两者都存在。
      copyFileSync(process.execPath, join(nodeOut, nodeBin))
      log('未找到 src-tauri/resources/node，node 取自当前进程可执行文件')
    }
    mkdirSync(join(out, 'dependencies', 'node', 'node_modules'), { recursive: true })

    log(`源目录就绪：${out}`)
    return true
  } catch (error) {
    fail(`拉取 ${target} 失败：${error.message}`)
    return false
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** `--self-test`：不联网，验证锁定文件形状、两种摘要判据与路径推导。 */
function selfTest() {
  const lock = readLock()
  if (lock === null) {
    fail('self-test：锁定文件读取失败')
    return false
  }
  const problems = []

  // 1) 五个目标都必须有锁定项，且 sha256 形如 64 hex、bytes 为正、layout 合法。
  for (const target of Object.keys(TARGETS)) {
    const entry = lock.interpreter.targets[target]
    if (!SHA256_HEX.test(entry.sha256)) problems.push(`${target} 的 sha256 不是 64 hex`)
    if (entry.bytes <= 0) problems.push(`${target} 的 bytes 非正`)
    if (!['flat', 'posix'].includes(entry.layout)) problems.push(`${target} 的 layout 非法`)
  }

  // 2) office skills 与 pnpm 的锁定包必须钉到具体版本**且**钉死字节：缺 sha256 就是
  //    「只钉了版本号」——那正是本项要消灭的缺陷形态，所以这里判红而不是放行。
  for (const [key, source] of [['officeSkills', lock.officeSkills], ['pnpm', lock.pnpm]]) {
    if (typeof source.version !== 'string' || source.version.length === 0) {
      problems.push(`lock 的 ${key} 缺 version`)
    }
    if (!SHA256_HEX.test(String(source.sha256))) {
      problems.push(`${key} 缺 sha256 或格式不对（缺哈希即允许来路不明的 tarball）`)
    }
    if (!Number.isInteger(source.bytes) || source.bytes <= 0) {
      problems.push(`${key} 的 bytes 缺失或非正整数`)
    }
    if (!SRI_SHA512.test(String(source.integrity))) {
      problems.push(`${key} 的 integrity 缺失或不是 sha512 SRI`)
    }
  }

  // 3) 判据可证伪：改动一个字节，sha256 与 integrity 两条都必须发现。
  const fixture = mkdtempSync(join(tmpdir(), 'fetch-selftest-'))
  try {
    const file = join(fixture, 'blob.bin')
    writeFileSync(file, Buffer.from([1, 2, 3, 4, 5]))
    const digest = sha256of(file)
    const sri = sriOf(file)
    const good = { sha256: digest, bytes: statSync(file).size, integrity: sri }
    if (!verifyTarball(file, good, 'fixture').ok) {
      problems.push('verifyTarball 判据失效：未改动的文件被判为不符')
    }
    writeFileSync(file, Buffer.from([1, 2, 3, 4, 6]))
    if (sha256of(file) === digest) {
      problems.push('sha256 判据失效：改动一个字节后摘要未变')
    }
    if (sriOf(file) === sri) {
      problems.push('integrity 判据失效：改动一个字节后 SRI 未变')
    }
    const tampered = verifyTarball(file, good, 'fixture')
    if (tampered.ok) {
      problems.push('verifyTarball 判据失效：改动一个字节后仍判为通过')
    }
    if (tampered.reason.length === 0) {
      problems.push('verifyTarball 判据失效：判红却没说原因')
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }

  // 4) 目标推导：宿主必须在受支持集合里（否则没法定默认 --target）。
  if (hostTarget() === null) {
    problems.push(`宿主 ${process.platform}/${process.arch} 没有对应目标三元组`)
  }

  if (problems.length > 0) {
    fail(`self-test 失败：\n  - ${problems.join('\n  - ')}`)
    return false
  }
  log(`self-test 通过（${Object.keys(TARGETS).length} 个目标锁定 / pnpm 与 officeSkills 的版本 + sha256 + bytes + integrity 齐全 / sha256 与 integrity 两条判据均可证伪）`)
  return true
}

const args = parseArgs(process.argv.slice(2))

if (args['self-test'] !== undefined) {
  selfTest()
} else {
  const lock = readLock()
  if (lock === null) process.exit(1)
  const target = String(args.target ?? hostTarget() ?? '')
  if (!Object.keys(TARGETS).includes(target)) {
    fail(`--target 非法：${target || '(宿主持有)'}（可选 ${Object.keys(TARGETS).join(' / ')}）`)
    process.exit(1)
  }
  const outRoot = String(args.out ?? join('.desktop-build', 'primary-runtime'))
  const ok = await fetchTarget(lock, target, outRoot)
  process.exit(ok ? 0 : 1)
}
