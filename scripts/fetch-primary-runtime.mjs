#!/usr/bin/env node
/**
 * fetch-primary-runtime.mjs — 把 primary runtime 载荷的输入拉成"源目录"。
 *
 * # 它解决什么问题
 *
 * `prepare-primary-runtime.mjs` 要求调用方提供三样本仓不自产的东西：python 解释器、
 * 8 个库的 site-packages、以及 office-skills（三份 SKILL.md + check_office.py）。
 * 本脚本把它们变成**可复现的构建期产物**：
 *
 *   * 解释器：python-build-standalone 的 CPython 发行版（按 URL + sha256 钉死）；
 *   * 库：pip 交叉下载锁定版本的 wheel，解包进 site-packages
 *     （装 wheel 只是解压，因此不需要目标解释器，也不需要 payload 自带 pip）；
 *   * office skills / pnpm：从锁定版本的 npm 包里取文件。
 *
 * 产出是**源目录**（`dependencies/` + `office-skills/`），交给
 * `scripts/prepare-primary-runtime.mjs --source <dir>` 做组装与完整性判定。
 * 两步分开：拉错 vs 装错能在命令行上看出来，不用翻构建日志。
 *
 * # 供应链纪律
 *
 * 所有 URL / 版本 / sha256 都在 `runtime-locks/primary-runtime.json`，**不进 Rust 代码**
 * （AGENTS.md §3.2：业务逻辑里严禁硬编码外部 URL）。sha256 不符即失败——宁可没有
 * 这个功能，也不放进一个来路不明的解释器。
 *
 * # 用法
 *
 * ```bash
 * node scripts/fetch-primary-runtime.mjs --tier authoring      # 只拉解释器 + skills
 * node scripts/fetch-primary-runtime.mjs --tier full          # 再拉 8 个库
 * node scripts/fetch-primary-runtime.mjs --self-test          # 离线自检（不联网）
 * ```
 *
 * 之后：
 * ```bash
 * npm run prepare:primary-runtime -- --source .desktop-build/primary-runtime/<target> \
 *   --tier full --office-skills <out>/office-skills …
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
      if (entry.sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
        problems.push(`lock 的 ${target}.sha256 不是 64 位十六进制`)
      }
    }
  }
  for (const key of ['packages', 'wheelTags', 'pnpm', 'officeSkills']) {
    if (lock[key] === undefined) problems.push(`lock 缺少 ${key}`)
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
 * 用宿主 pip 交叉安装锁定 wheel 到 site-packages。
 *
 * 不需要目标解释器：`pip install` 对 wheel 就是解包 + 写 dist-info；`--platform`
 * 只是挑哪个 wheel。跨 Python 次版本同理（用 `--python-version` 声明 ABI）。
 */
function installWheels(lock, target, sitePackages) {
  const tag = lock.wheelTags[target]
  if (tag === undefined) {
    fail(`lock 没有 ${target} 的 wheelTags`)
    return false
  }
  mkdirSync(sitePackages, { recursive: true })
  const stage = mkdtempSync(join(tmpdir(), 'fetch-wheels-'))
  try {
    const args = [
      '-m', 'pip', 'download',
      '--dest', stage,
      '--platform', tag.platform,
      '--python-version', lock.interpreter.pythonVersion.split('.').slice(0, 2).join('.'),
      '--only-binary', ':all:',
      '--no-deps',
      ...lock.packages.map((pkg) => `${pkg.name}==${pkg.version}`),
    ]
    log(`pip download ${lock.packages.length} 个 wheel（${tag.platform}）`)
    execFileSync('python', args, { stdio: 'inherit' })
    const target_ = process.execPath
    execFileSync(target_, [
      '-m', 'pip', 'install',
      '--no-deps', '--no-compile', '--target', sitePackages,
      '--no-index', '--find-links', stage,
      ...lock.packages.map((pkg) => `${pkg.name}==${pkg.version}`),
    ], { stdio: 'inherit' })
    return true
  } catch (error) {
    fail(`wheel 安装失败：${error.message}`)
    return false
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/**
 * 拉取一个目标，产出源目录。
 * @returns {boolean} 是否成功
 */
async function fetchTarget(lock, target, tier, outRoot) {
  const entry = lock.interpreter.targets[target]
  const out = join(outRoot, target)
  rmSync(out, { recursive: true, force: true })
  const work = mkdtempSync(join(tmpdir(), 'fetch-runtime-'))
  try {
    // 1) 解释器：优先用缓存里的（按 sha256 校验），否则下载。
    const url = `${RELEASE_BASE}/${encodeURIComponent(lock.interpreter.release)}/${encodeURIComponent(entry.artifact)}`
    const archive = join(work, entry.artifact.endsWith('.zip') ? 'py.zip' : 'py.tar.gz')
    const cacheDir = join(outRoot, '.cache')
    const cached = join(cacheDir, `${entry.sha256.slice(0, 16)}-${entry.artifact}`)
    let bytes
    if (existsSync(cached) && sha256of(cached) === entry.sha256) {
      bytes = statSync(cached).size
      log(`解释器命中缓存：${entry.artifact}`)
    } else {
      bytes = await download(url, archive)
      // 先校验再进缓存：不能把来路不明的产物留在盘上供下次直接使用。
      const digest = sha256of(archive)
      if (digest !== entry.sha256) {
        fail(`解释器 sha256 不符：期望 ${entry.sha256}，实得 ${digest}`)
        return false
      }
      mkdirSync(cacheDir, { recursive: true })
      copyFileSync(archive, cached)
    }
    const digest = sha256of(archive)
    if (digest !== entry.sha256) {
      fail(`解释器 sha256 不符：期望 ${entry.sha256}，实得 ${digest}`)
      return false
    }
    if (bytes !== entry.bytes) {
      fail(`解释器体积不符：期望 ${entry.bytes}，实得 ${bytes}`)
      return false
    }
    log(`解释器校验通过：${entry.artifact}（${(bytes / 1e6).toFixed(1)} MB）`)
    const python = join(out, 'dependencies', 'python')
    extract(existsSync(cached) && sha256of(cached) === entry.sha256 ? cached : archive, python)

    // 2) office skills 与 pnpm：来自锁定版本的 npm 包。
    const npmStage = mkdtempSync(join(tmpdir(), 'fetch-npm-'))
    try {
      // skills：`npm pack` 的产物名是 `<scope>-<name>-<version>.tgz`，不能写死。
      execFileSync('npm', [
        'pack', `${lock.officeSkills.package}@${lock.officeSkills.version}`,
        '--pack-destination', npmStage,
      ], { stdio: 'pipe' })
      const skillTarball = newestTgz(npmStage)
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
      execFileSync('npm', ['pack', `pnpm@${lock.pnpm.version}`, '--pack-destination', npmStage], { stdio: 'pipe' })
      const pnpmTarball = newestTgz(npmStage)
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

    // 4) 档2：把 8 个库装进 site-packages。
    if (tier === 'full') {
      const site = entry.layout === 'flat'
        ? join(python, 'Lib', 'site-packages')
        : join(python, 'lib', `python${lock.interpreter.pythonVersion.split('.').slice(0, 2).join('.')}`, 'site-packages')
      if (!installWheels(lock, target, site)) return false
    }

    log(`源目录就绪：${out}`)
    return true
  } catch (error) {
    fail(`拉取 ${target} 失败：${error.message}`)
    return false
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** `--self-test`：不联网，验证锁定文件形状、sha256 判据与路径推导。 */
function selfTest() {
  const lock = readLock()
  if (lock === null) {
    fail('self-test：锁定文件读取失败')
    return false
  }
  const problems = []

  // 1) 五个目标都必须有锁定项，且 sha256 形如 64 hex。
  for (const target of Object.keys(TARGETS)) {
    const entry = lock.interpreter.targets[target]
    if (!/^[a-f0-9]{64}$/u.test(entry.sha256)) problems.push(`${target} 的 sha256 不是 64 hex`)
    if (entry.bytes <= 0) problems.push(`${target} 的 bytes 非正`)
    if (!['flat', 'posix'].includes(entry.layout)) problems.push(`${target} 的 layout 非法`)
    if (!lock.wheelTags[target]) problems.push(`${target} 缺 wheelTags`)
  }

  // 2) 8 个库必须齐，且声明了导入名（与 Rust 判据同一张表）。
  const expected = ['numpy', 'pandas', 'python-docx', 'python-pptx', 'openpyxl', 'Pillow', 'lxml', 'XlsxWriter']
  const got = lock.packages.map((pkg) => pkg.name)
  for (const name of expected) {
    if (!got.includes(name)) problems.push(`packages 缺少 ${name}`)
  }
  for (const pkg of lock.packages) {
    if (pkg.import === undefined || pkg.import.length === 0) problems.push(`${pkg.name} 缺 import 名`)
  }
  if (lock.packages.length !== expected.length) problems.push(`packages 应有 ${expected.length} 项，实为 ${lock.packages.length}`)

  // 3) sha256 判据可证伪：改动一个字节必须被发现。
  const fixture = mkdtempSync(join(tmpdir(), 'fetch-selftest-'))
  try {
    const file = join(fixture, 'blob.bin')
    writeFileSync(file, Buffer.from([1, 2, 3, 4, 5]))
    const digest = sha256of(file)
    writeFileSync(file, Buffer.from([1, 2, 3, 4, 6]))
    if (sha256of(file) === digest) {
      problems.push('sha256 判据失效：改动一个字节后摘要未变')
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
  log(`self-test 通过（${Object.keys(TARGETS).length} 个目标锁定 / 8 库齐备 / sha256 判据可证伪）`)
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
  const tier = String(args.tier ?? 'authoring')
  if (!['authoring', 'full'].includes(tier)) {
    fail(`--tier 非法：${tier}（authoring / full）`)
    process.exit(1)
  }
  const outRoot = String(args.out ?? join('.desktop-build', 'primary-runtime'))
  const ok = await fetchTarget(lock, target, tier, outRoot)
  process.exit(ok ? 0 : 1)
}
