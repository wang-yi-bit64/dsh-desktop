#!/usr/bin/env node
/**
 * package-portable.mjs — 把 Tauri build 产出的原始 app 目录（`target/release/`）
 * 打包成**便携版分发格式**（归档 + `.sha256` 边车 + manifest + 回读校验）。
 *
 * ## 为什么存在
 *
 * `tauri build --bundles zip` 在当前安装的 Tauri CLI 上不受 Windows 支持
 *（`--bundles` 只认 `nsis` / `msi`）。但 Tauri build 始终产出可运行的原始
 * app 目录（`target/release/<app>.exe` + `resources/`），本脚本把它重新打包
 * 成统一命名的便携 zip，复用 `package-cli.mjs` 确立的归档 / 边车 / manifest /
 * 自测模式。
 *
 * ## 用法
 *
 * ```bash
 * # 打包（先跑 `npm run tauri build` 或 `npm run tauri build -- --bundles nsis`）
 * node scripts/package-portable.mjs --bundle-dir target/release
 * # 自测
 * node scripts/package-portable.mjs --self-test
 * ```
 *
 * `--version` 省略时读 `package.json`（唯一真源）。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// 纯逻辑判据
// ---------------------------------------------------------------------------

/**
 * 便携包基名：`DSH-Desktop-<version>-portable`。
 * @param {string} version
 * @returns {string}
 */
export function portableBaseName(version) {
  return `DSH-Desktop-${version}-portable`
}

/**
 * 归档扩展名。Windows 目标给 `.zip`，其余给 `.tar.gz`。
 * 发布链路里 triple 是真实的目标三元组（`x86_64-pc-windows-msvc` 等），
 * 按其中是否含 `windows` / `win32` 判定。
 *
 * @param {string} triple
 * @returns {'.zip'|'.tar.gz'}
 */
export function archiveExtension(triple) {
  const isWindows = /windows|win32/.test(triple)
  return isWindows ? '.zip' : '.tar.gz'
}

/**
 * `.sha256` 边车内容：`<hex>  <文件名>`（两个空格）。
 */
export function sidecarText(hash, fileName) {
  return `${hash}  ${fileName}\n`
}

/**
 * 解析 `.sha256` 边车。形状不认识时返回 `null`。
 */
export function parseSidecar(text) {
  const first = String(text ?? '').replace(/\r\n/g, '\n').split('\n')[0] ?? ''
  const m = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(first)
  return m ? { hash: m[1], fileName: m[2] } : null
}

/**
 * 文件 sha256。
 */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 在目录里找应用主程序 `.exe` 文件。
 *
 * Tauri 产物里，应用 exe 位于目标目录顶层；递归会先命中 `.fingerprint/`
 * 与 `build/` 下的构建辅助 exe（`build-script-build.exe` 等），因此必须
 * 先扫顶层，再回退到子目录。
 *
 * @param {string} dir
 * @returns {{path: string, name: string}|null}
 */
export function findAppExe(dir) {
  const root = resolve(dir)

  // 1) 先看顶层：应用 exe 就在这里。
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (entry.toLowerCase().endsWith('.exe')) {
      return { path: full, name: entry }
    }
  }

  // 2) 顶层没有时再递归，但跳过已知构建产物目录。
  const SKIP = new Set(['.fingerprint', 'build', 'deps'])
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      if (entry.toLowerCase().endsWith('.exe')) {
        return { path: full, name: entry }
      }
      if (statSync(full).isDirectory() && !SKIP.has(entry)) {
        const found = walk(full)
        if (found) return found
      }
    }
    return null
  }
  return walk(root)
}

/**
 * 回读校验：解包后的目录里能找到非空的 exe。
 *
 * 归档本身的完整性由 sidecar 的 sha256 守护；这里关心的是「解包流程本身
 * 没坏」——exe 能被提取出来且非空。
 *
 * @param {{destDir: string}} opts
 * @returns {string[]} 问题清单
 */
export function inspectExtracted({ destDir }) {
  const problems = []
  let exeName = null
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (entry.toLowerCase().endsWith('.exe')) {
        exeName = entry
        return
      }
      if (statSync(full).isDirectory()) walk(full)
    }
  }
  walk(destDir)
  if (!exeName) {
    problems.push('解包目录里没有找到 .exe 文件')
    return problems
  }
  if (statSync(join(destDir, exeName)).size === 0) {
    problems.push(`${exeName} 是空文件（解包流程异常）`)
  }
  return problems
}

/**
 * 核验**已经发布出去**的那份便携版产物。
 *
 * @param {{dir: string, manifestPath: string}} opts
 * @returns {{problems: string[], manifest: object}}
 */
export function verifyDownloaded({ dir, manifestPath }) {
  const problems = []
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const archive = join(resolve(dir), manifest.archive)
  const sidecar = join(resolve(dir), manifest.sidecar)

  if (!existsSync(archive)) {
    problems.push(`下载目录里没有 ${manifest.archive}`)
    return { problems, manifest }
  }
  const bytes = statSync(archive).size
  if (bytes !== manifest.archiveBytes) {
    problems.push(`${manifest.archive} 大小 ${bytes} 与 manifest 记录的 ${manifest.archiveBytes} 不一致`)
  }
  const hash = sha256File(archive)
  if (hash !== manifest.sha256) {
    problems.push(`${manifest.archive} 的 sha256 与 manifest 不一致：下载 ${hash} vs manifest ${manifest.sha256}`)
  }
  if (!existsSync(sidecar)) {
    problems.push(`下载目录里没有 ${manifest.sidecar}`)
  } else {
    const parsed = parseSidecar(readFileSync(sidecar, 'utf8'))
    if (!parsed) {
      problems.push(`${manifest.sidecar} 的形状无法解析`)
    } else {
      if (parsed.hash !== manifest.sha256) {
        problems.push(`边车里的哈希与 manifest 不一致：边车 ${parsed.hash} vs manifest ${manifest.sha256}`)
      }
      if (parsed.fileName !== manifest.archive) {
        problems.push(`边车指向的文件名是 ${parsed.fileName}，manifest 记的是 ${manifest.archive}`)
      }
    }
  }
  return { problems, manifest }
}

// ---------------------------------------------------------------------------
// 打包主流程
// ---------------------------------------------------------------------------

/**
 * 打包便携版 zip。
 *
 * 输入是 Tauri build 产出的原始 app 目录（通常是 `target/release/`），内含
 * `<app>.exe` 与 `resources/` 目录。本函数把这两部分打包成标准便携 zip。
 *
 * @param {{bundleDir: string, outDir: string, triple: string, version: string}} opts
 * @returns {{base: string, archive: string, sidecar: string, manifestPath: string, manifest: object, verify: string[]}}
 */
export function packagePortable({ bundleDir, outDir, triple, version }) {
  const appDir = resolve(bundleDir)
  if (!existsSync(appDir)) {
    throw new Error(`输入目录不存在：${bundleDir}`)
  }

  const exeInfo = findAppExe(appDir)
  if (!exeInfo) {
    throw new Error(`在 ${bundleDir} 下找不到 .exe 文件（先跑 \`npm run tauri build\`）`)
  }

  const ext = archiveExtension(triple)
  const base = portableBaseName(version)
  const archive = join(resolve(outDir), `${base}${ext}`)
  const sidecar = `${archive}.sha256`
  mkdirSync(resolve(outDir), { recursive: true })

  // 1) 用 PowerShell Compress-Archive 把 exe + resources/ 打包成 zip。
  //    源目录与目标文件不能同址，否则 Compress-Archive 会把目标 itself 也
  //    塞进归档（自引用），在 Windows 上表现为静默失败。
  const stageDir = mkdtempSync(join(tmpdir(), 'dsh-portable-stage-'))
  try {
    // 把 exe 复制到 staging 目录。
    const stagedExe = join(stageDir, exeInfo.name)
    writeFileSync(stagedExe, readFileSync(exeInfo.path))

    // 把 resources/ 复制到 staging 目录（如果存在）。
    const srcResources = join(appDir, 'resources')
    if (existsSync(srcResources)) {
      const dstResources = join(stageDir, 'resources')
      spawnSync(
        'powershell',
        [
          '-NoProfile', '-NonInteractive', '-Command',
          `Copy-Item -Path (Join-Path '${srcResources.replace(/'/g, "''")}' '*') -Destination '${dstResources.replace(/'/g, "''")}' -Recurse -Force`
        ],
        { stdio: 'ignore' }
      )
    }

    const psSrc = stageDir.replace(/'/g, "''")
    const psDst = archive.replace(/'/g, "''")
    spawnSync(
      'powershell',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path (Join-Path '${psSrc}' '*') -DestinationPath '${psDst}' -Force`
      ],
      { stdio: 'ignore' }
    )
  } finally {
    rmSync(stageDir, { recursive: true, force: true })
  }

  // 2) 边车 + manifest。
  const hash = sha256File(archive)
  writeFileSync(sidecar, sidecarText(hash, basename(archive)), 'utf8')

  const manifest = {
    kind: 'dsh-desktop-portable',
    version,
    triple,
    archive: basename(archive),
    sidecar: basename(sidecar),
    sha256: hash,
    archiveBytes: statSync(archive).size,
    source: exeInfo.name
  }
  const manifestPath = join(resolve(outDir), `${base}.manifest.json`)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // 3) 回读校验：解包后 exe 存在且非空。
  const verifyDir = mkdtempSync(join(tmpdir(), 'dsh-portable-verify-'))
  const verify = (() => {
    try {
      const isZip = ext === '.zip'
      if (isZip) {
        spawnSync(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Expand-Archive -Path $env:DSH_PORTABLE_ARCHIVE -DestinationPath $env:DSH_PORTABLE_DEST -Force'
          ],
          {
            env: {
              ...process.env,
              DSH_PORTABLE_ARCHIVE: archive,
              DSH_PORTABLE_DEST: verifyDir
            },
            stdio: 'ignore'
          }
        )
      } else {
        spawnSync('tar', ['-xzf', basename(archive), '-C', verifyDir], {
          cwd: dirname(archive),
          stdio: 'ignore'
        })
      }
      return inspectExtracted({ destDir: verifyDir })
    } finally {
      rmSync(verifyDir, { recursive: true, force: true })
    }
  })()

  return { base, archive, sidecar, manifestPath, manifest, verify }
}

// ---------------------------------------------------------------------------
// 自测
// ---------------------------------------------------------------------------

export function selfTest() {
  const failures = []
  let passed = 0
  const check = (condition, message) => {
    passed += 1
    if (!condition) failures.push(message)
  }

  // 1) 命名判据。
  check(portableBaseName('0.3.0') === 'DSH-Desktop-0.3.0-portable', '产物基名必须包含版本与 -portable 后缀')
  check(archiveExtension('x86_64-pc-windows-msvc') === '.zip', 'Windows 目标必须给 .zip')
  check(archiveExtension('aarch64-apple-darwin') === '.tar.gz', 'macOS 目标必须给 .tar.gz')
  check(archiveExtension('x86_64-unknown-linux-gnu') === '.tar.gz', 'Linux 目标必须给 .tar.gz')

  // 2) 边车形状。
  const hash = 'a'.repeat(64)
  const parsed = parseSidecar(sidecarText(hash, 'x.zip'))
  check(parsed?.hash === hash && parsed?.fileName === 'x.zip', '边车必须能往返解析')
  check(parseSidecar(`${hash} x.zip`) === null, '可伪证性：单空格分隔的边车必须被判为无效')
  check(parseSidecar('') === null, '可伪证性：空边车必须被判为无效')

  // 3) 真打包回读（当前平台）。
  const hostTripleValue = (() => {
    const out = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })
    if (out.status !== 0) return null
    const m = /^host:\s*(\S+)$/m.exec(out.stdout ?? '')
    return m ? m[1] : null
  })()
  const triple = hostTripleValue ?? `${process.platform}-${process.arch}`
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-portable-selftest-'))
  try {
    // 合成一个「假 target/release/」目录：内含一个 exe 与一个 resources/ 子目录。
    const fakeReleaseDir = join(tmp, 'tauri-release')
    mkdirSync(fakeReleaseDir, { recursive: true })
    const fakeExeName = 'DSH Desktop.exe'
    writeFileSync(join(fakeReleaseDir, fakeExeName), Buffer.alloc(32 * 1024, 9))
    mkdirSync(join(fakeReleaseDir, 'resources'), { recursive: true })
    writeFileSync(join(fakeReleaseDir, 'resources', 'test.txt'), 'hello')

    const result = packagePortable({
      bundleDir: fakeReleaseDir,
      outDir: join(tmp, 'out'),
      triple,
      version: '0.3.0'
    })
    check(existsSync(result.archive), '自测：归档必须真的落盘')
    check(result.verify.length === 0, `自测：回读校验必须通过（实际问题：${result.verify.join('；')}）`)
    check(result.manifest.archive === basename(result.archive), 'manifest.archive 必须与真实归档同名')
    check(result.manifest.sha256 === sha256File(result.archive), 'manifest.sha256 必须等于归档真实哈希')
    check(result.manifest.archiveBytes === statSync(result.archive).size, 'manifest.archiveBytes 必须等于归档真实大小')
    check(existsSync(result.manifestPath), 'manifest 文件必须存在')

    // 篡改归档 → 回读校验必须变红（把解出的 exe 截断为 0 字节）。
    const tamperedDir = join(tmp, 'tampered')
    mkdirSync(tamperedDir, { recursive: true })
    const tamperedArchive = join(tamperedDir, basename(result.archive))
    writeFileSync(tamperedArchive, readFileSync(result.archive))
    const tamperedBytes = readFileSync(tamperedArchive)
    tamperedBytes[0] ^= 0xff
    writeFileSync(tamperedArchive, tamperedBytes)
    const verifyDir2 = mkdtempSync(join(tmpdir(), 'dsh-portable-tamper-'))
    try {
      spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Expand-Archive -Path $env:DSH_PORTABLE_ARCHIVE -DestinationPath $env:DSH_PORTABLE_DEST -Force'
        ],
        {
          env: { ...process.env, DSH_PORTABLE_ARCHIVE: tamperedArchive, DSH_PORTABLE_DEST: verifyDir2 },
          stdio: 'ignore'
        }
      )
      const exeInTampered = readdirSync(verifyDir2).find((f) => f.toLowerCase().endsWith('.exe'))
      if (exeInTampered) {
        writeFileSync(join(verifyDir2, exeInTampered), Buffer.alloc(0))
        const emptyResult = inspectExtracted({ destDir: verifyDir2 })
        check(
          emptyResult.length > 0 && emptyResult.some((p) => p.includes('空文件')),
          '可伪证性：空 exe 必须被回读校验判红'
        )
      } else {
        check(false, '可伪证性：篡改后的归档必须仍能解出 exe 文件名')
      }
    } finally {
      rmSync(verifyDir2, { recursive: true, force: true })
    }

    // 4) 输入目录不存在时必须抛错。
    let threw = false
    try {
      packagePortable({ bundleDir: join(tmp, 'nope'), outDir: join(tmp, 'out2'), triple, version: '0.3.0' })
    } catch {
      threw = true
    }
    check(threw, '可伪证性：输入目录不存在时必须抛错')

    // 5) 输入目录没有 exe 时必须抛错。
    let threwNoExe = false
    try {
      packagePortable({ bundleDir: join(tmp, 'tauri-release', 'resources'), outDir: join(tmp, 'out3'), triple, version: '0.3.0' })
    } catch {
      threwNoExe = true
    }
    check(threwNoExe, '可伪证性：输入目录没有 exe 时必须抛错')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    throw new Error(`package-portable 自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`)
  }
  return { passed }
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    out: join(projectRoot, 'dist', 'portable')
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--bundle-dir') opts.bundleDir = argv[++i]
    else if (arg === '--out') opts.out = argv[++i]
    else if (arg === '--triple') opts.triple = argv[++i]
    else if (arg === '--version') opts.version = argv[++i]
    else if (arg === '--verify-download') opts.verifyDownload = argv[++i]
    else if (arg === '--manifest') opts.manifest = argv[++i]
    else if (arg === '--self-test') opts.selfTest = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return opts
}

function usage() {
  console.log(`用法：
  node scripts/package-portable.mjs --bundle-dir <tauri build 输出目录> [--out <目录>] [--version <版本>]
  node scripts/package-portable.mjs --verify-download <已下载产物所在目录> --manifest <manifest.json>
  node scripts/package-portable.mjs --self-test

  --bundle-dir   tauri build 的输出目录（通常为 target/release），内含 .exe 与 resources/
  --out          产物目录，默认 dist/portable
  --version      版本号，省略时读 package.json
  --verify-download  核验下载回来的归档 / 边车与 manifest 是否一致`)
}

function hostTriple() {
  const out = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })
  if (out.status !== 0) return null
  const m = /^host:\s*(\S+)$/m.exec(out.stdout ?? '')
  return m ? m[1] : null
}

function runCli() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    usage()
    return
  }
  if (opts.selfTest) {
    const { passed } = selfTest()
    console.log(`✅ package-portable 自测通过（${passed} 项）`)
    return
  }
  if (opts.verifyDownload) {
    if (!opts.manifest) throw new Error('--verify-download 需要同时给 --manifest')
    const { problems, manifest } = verifyDownloaded({ dir: opts.verifyDownload, manifestPath: opts.manifest })
    if (problems.length > 0) {
      throw new Error(`已发布产物核验失败：\n  - ${problems.join('\n  - ')}`)
    }
    console.log(`✅ 已发布产物核验通过：${manifest.archive}  sha256=${manifest.sha256}`)
    return
  }
  if (!opts.bundleDir) {
    usage()
    throw new Error('缺少 --bundle-dir（或用 --self-test / --verify-download）')
  }
  const version =
    opts.version ??
    JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version
  const triple = opts.triple ?? hostTriple() ?? `${process.platform}-${process.arch}`
  const result = packagePortable({
    bundleDir: opts.bundleDir,
    outDir: opts.out,
    triple,
    version
  })
  console.log(`📦 ${result.base}`)
  console.log(`   ${basename(result.archive)}  (${(statSync(result.archive).size / 1024 / 1024).toFixed(2)} MiB)`)
  console.log(`   ${basename(result.sidecar)}`)
  console.log(`   ${basename(result.manifestPath)}`)
  if (result.verify.length > 0) {
    console.log(`   ⚠️ 回读校验问题：${result.verify.join('；')}`)
  } else {
    console.log(`   ✅ 回读校验通过`)
  }
}

const isDirectRun = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')
  } catch {
    return false
  }
})()

if (isDirectRun) {
  try {
    runCli()
  } catch (error) {
    console.error(`package-portable 失败：${error.message}`)
    process.exit(1)
  }
}
