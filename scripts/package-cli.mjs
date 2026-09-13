#!/usr/bin/env node
/**
 * package-cli.mjs — 把 `dsh-host-cli` 打成**可引用产物**（归档 + `.sha256` 边车）。
 *
 * ## 为什么存在
 *
 * `dsh-host-cli`（`start` / `stop` / `status` / `tail` / `probe` / `doctor`）是
 * 「可靠层」在无 GUI 环境下的唯一手柄，但在此之前它**只作为源码存在**：第三方要用
 * 它，得先 clone 仓库、装 Rust 工具链、自己 `cargo build`。本脚本把它变成 Release
 * 资产——同一个 tag 下，除了桌面安装包，还有一份能直接下载、能核对哈希、能指名
 * 版本的命令行产物（开发计划与分期见 `docs/dev-plan-cli-distribution.md`）。
 *
 * ## 三条判据（都是「不写成代码就会漂移」的）
 *
 * 1. **名字由版本与目标三元组唯一决定**：`dsh-host-cli-v<version>-<triple>.<ext>`。
 *    版本读 `package.json`（唯一真源），**不接受**调用方手写——手写的那个版本号
 *    迟早与 tag 漂移，而产物名里的版本没有任何人会去核对。
 * 2. **产物必须可核对**：同目录生成 `.sha256` 边车，格式与 `sha256sum -c` /
 *    `shasum -a 256 -c` 兼容。
 * 3. **必须回读校验**：归档建好后**解包回读**，与源二进制逐字节比对哈希，并检查
 *    可执行位。`Compress-Archive` / `tar` 退出码为 0 不等于「解开来还能用」：
 *    归档里少了可执行位这种缺陷，只有下载它的人才会发现。
 *
 * ## 用法
 *
 * ```bash
 * # 打包（先 cargo build --release -p dsh-host-cli）
 * node scripts/package-cli.mjs --bin target/release/dsh-host-cli --out dist/cli
 * # 自测：纯逻辑判据 + 当前平台上的真归档回读 + 可伪证性夹具
 * node scripts/package-cli.mjs --self-test
 * ```
 *
 * `--triple` 省略时按 `rustc -vV` 的 host 推导（与 `verify-target.mjs` 同一口径：
 * 产物名必须与**实际编译它的工具链**一致，不接受手写猜测）。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
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

/** 产物内固定文件名。 */
export const README_NAME = 'README.txt'

// ---------------------------------------------------------------------------
// 纯逻辑判据（自测直接喂夹具）
// ---------------------------------------------------------------------------

/**
 * 产物基名：`dsh-host-cli-v<version>-<triple>`。
 * @param {string} version package.json 里的版本（单一真源）
 * @param {string} triple 目标三元组（如 x86_64-pc-windows-msvc）
 * @returns {string}
 */
export function artifactBaseName(version, triple) {
  return `dsh-host-cli-v${version}-${triple}`
}

/**
 * 归档扩展名。Windows 目标给 `.zip`（资源管理器可双击解压），其余给 `.tar.gz`。
 * 判据取自**目标三元组**而不是当前主机——交叉打包时以产物去向为准。
 * @param {string} triple
 * @returns {'.zip'|'.tar.gz'}
 */
export function archiveExtension(triple) {
  return /windows/.test(triple) ? '.zip' : '.tar.gz'
}

/**
 * 二进制在归档内的文件名（Windows 目标带 `.exe`）。
 * @param {string} triple
 * @returns {string}
 */
export function binaryFileName(triple) {
  return /windows/.test(triple) ? 'dsh-host-cli.exe' : 'dsh-host-cli'
}

/**
 * `.sha256` 边车内容：`<hex>  <文件名>`（两个空格）。
 * 这是 `sha256sum` / `shasum -a 256` 的 `-c` 都能直接读的格式；写成别的形状
 * 等于发布了一个没人能自动核对的哈希。
 * @param {string} hash 64 位十六进制
 * @param {string} fileName 被哈希的归档文件名
 * @returns {string}
 */
export function sidecarText(hash, fileName) {
  return `${hash}  ${fileName}\n`
}

/**
 * 解析 `.sha256` 边车。形状不认识时返回 `null`，由调用方报错——
 * 「猜一个哈希出来」会让校验变成装饰。
 * @param {string} text
 * @returns {{hash: string, fileName: string}|null}
 */
export function parseSidecar(text) {
  const first = String(text ?? '').replace(/\r\n/g, '\n').split('\n')[0] ?? ''
  const m = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(first)
  return m ? { hash: m[1], fileName: m[2] } : null
}

/**
 * 文件 sha256（分块读，避免把整棵资源树读进内存的写法被误用到别处）。
 * @param {string} path
 * @returns {string} 64 位小写十六进制
 */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 回读校验：解包出来的东西必须与打包前的输入一致。
 *
 * 三个判据各自对应一类**只有用户才会发现**的缺陷：
 *   · 少了同名文件 —— 归档压根没打进去；
 *   · 哈希不一致 —— 归档损坏或打错了文件；
 *   · 可执行位丢失 —— Unix 上 `./dsh-host-cli` 直接 `Permission denied`。
 *
 * @param {{destDir: string, binaryName: string, sourceHash: string, expectExecutable: boolean}} opts
 * @returns {string[]} 问题清单（空数组 = 通过）
 */
export function inspectExtracted({ destDir, binaryName, sourceHash, expectExecutable }) {
  const problems = []
  const bin = join(destDir, binaryName)
  if (!existsSync(bin)) {
    problems.push(`归档里没有 ${binaryName}`)
  } else {
    if (sha256File(bin) !== sourceHash) {
      problems.push(`${binaryName} 解包后哈希与源文件不一致（归档损坏或打错文件）`)
    }
    if (expectExecutable && (statSync(bin).mode & 0o111) === 0) {
      problems.push(`${binaryName} 解包后没有可执行位（归档未保留 mode）`)
    }
  }
  if (!existsSync(join(destDir, README_NAME))) {
    problems.push(`归档里没有 ${README_NAME}`)
  }
  return problems
}

/**
 * 随二进制一起发布的说明文本。
 *
 * 刻意写成「**需要一个已组装的 runtime**」而不是「下载即用」：本脚本只发布手柄，
 * 不发布 runtime（runtime 的独立发布是 Phase 2，见开发计划）。产物自述与实际
 * 能力不一致，是比缺失更糟的缺陷。
 *
 * @param {{version: string, triple: string}} opts
 * @returns {string}
 */
export function artifactReadme({ version, triple }) {
  return `dsh-host-cli ${version} — headless DeepSeek Harness host runner
Target: ${triple}

Subcommands: start | stop | status | tail | probe | doctor

This binary drives an ALREADY-ASSEMBLED Harness runtime tree. It does not
download, assemble or update runtimes. Point it at one with --resource:

  dsh-host-cli status --resource <RES> --data <DATA>
  dsh-host-cli doctor --resource <RES> --data <DATA>
  dsh-host-cli start  --resource <RES> --data <DATA> [--profile <P>] [-- <dsh args>]
  dsh-host-cli tail   --data <DATA> [--lines 30]
  dsh-host-cli probe  [--port 4173]
  dsh-host-cli stop   --data <DATA>

  <RES>   a directory containing harness-node-entry.mjs, harness/ and node/ —
          the resources directory of an installed DSH Desktop, or the
          src-tauri/resources directory produced by \`npm run prepare:harness\`
          in a source checkout.
  <DATA>  any writable directory (DSH_HOME, logs, and the pidfile land there).
  --      everything after it is forwarded to dsh unchanged.

Exit codes: 0 ok · 2 usage · 3 missing resource · 4 spawn failed · 5 token not
found · 6 readiness timeout · 7 port in use · 8 harness failed.

Verify this download against the value published in the same release:
  Windows      certutil -hashfile <archive> SHA256
  macOS/Linux  shasum -a 256 -c <archive>.sha256

macOS: this binary is NOT notarized. If Gatekeeper blocks it, allow it in
System Settings -> Privacy & Security, or clear the quarantine attribute:
  xattr -d com.apple.quarantine ./dsh-host-cli

MIT licensed · https://github.com/wang-yi-bit64/dsh-desktop
`
}

/**
 * 「产物真的能跑」的判据（纯函数部分，便于自测喂夹具）。
 *
 * 归档能解开、哈希对得上，**不等于**这个二进制在目标机上能启动：架构不匹配、
 * 动态库缺失、构建脚本把 wrapper 当产物打进去——这几类都表现为「哈希完全正确、
 * 一执行就报错」。所以在打包之后**真的执行一次**它。
 *
 * @param {string} stdout `--version` 的输出
 * @param {string} version 期望版本（来自 package.json）
 * @returns {string[]} 问题清单
 */
export function checkVersionOutput(stdout, version) {
  const text = String(stdout ?? '')
  return text.includes(`dsh-host-cli ${version}`)
    ? []
    : [`\`--version\` 未回显期望版本「dsh-host-cli ${version}」——产物可能不是本次构建（实际输出：${text.trim().slice(0, 120)}）`]
}

/**
 * 缺失资源树时的退出码判据。
 *
 * 期望 `3`（`EXIT_MISSING_RESOURCE`）。这条同时钉住两件事：二进制能执行，
 * 且「资源不全」是一条**可辨识的失败**而不是崩溃（退出码 101 / 0xc0000139 之类）。
 *
 * @param {number|null} status 退出码（spawnSync.status）
 * @returns {string[]} 问题清单
 */
export function checkMissingResourceExit(status) {
  return status === 3
    ? []
    : [`对缺失资源树执行 \`status\` 的退出码是 ${status}，期望 3（EXIT_MISSING_RESOURCE）——产物可能无法执行或契约已漂移`]
}

/**
 * 执行产物自检（只在「目标三元组 == 本机三元组」时才有意义）。
 * @param {{binaryPath: string, version: string}} opts
 * @returns {string[]} 问题清单
 */
export function smokeRun({ binaryPath, version }) {
  const problems = []
  const versionRun = spawnSync(binaryPath, ['--version'], { encoding: 'utf8' })
  if (versionRun.error) {
    return [`产物无法执行：${versionRun.error.message}`]
  }
  problems.push(...checkVersionOutput(versionRun.stdout, version))

  const missing = join(tmpdir(), `dsh-cli-smoke-missing-${Date.now()}`)
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-cli-smoke-data-'))
  try {
    const statusRun = spawnSync(binaryPath, ['status', '--resource', missing, '--data', dataDir], {
      encoding: 'utf8'
    })
    problems.push(...checkMissingResourceExit(statusRun.status))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
  return problems
}

/**
 * 核验**已经发布出去**的那份产物。
 *
 * 与 `inspectExtracted` 的区别是它验的是「别人下载到的东西」：上传链路（gh CLI、
 * GitHub 资产存储、再下载）会不会改坏文件，本地怎么验都验不出来。判据有三条，
 * 任何一条不成立都说明「下载到的东西不是我们构建的那个」：
 *   1. 归档存在且大小与 manifest 一致；
 *   2. 归档 sha256 与 manifest 一致；
 *   3. 边车文件里写的哈希与 manifest 一致（否则用户按边车核对会得出相反结论）。
 *
 * @param {{dir: string, manifestPath: string}} opts `dir` 是下载产物所在目录
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
    problems.push(`${manifest.archive} 大小 ${bytes} 与 manifest 记录的 ${manifest.archiveBytes} 不一致（上传/下载链路改动了文件）`)
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
      problems.push(`${manifest.sidecar} 的形状无法解析（用户拿不到可核对的哈希）`)
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

/** 发布正文里 CLI 段落的幂等标记。重跑时按它截断旧段落，避免出现两遍。 */
export const NOTES_MARKER = '<!-- dsh-host-cli -->'

/**
 * 把 CLI 段落**替换**进已有的 Release 正文。
 *
 * 幂等性由标记行保证：已有段落（标记行及其后全部内容）先被截断，再追加新段落。
 * `workflow_dispatch` 兜底重跑是发布失败后的正规补救通道，因此「重跑会得到两遍
 * 表格」不是外观问题——它会让读者以为发布了两组产物。
 *
 * @param {string} existing 现有正文（可为空）
 * @param {string} section 新段落（由 {@link renderCliNotes} 生成）
 * @returns {string} 替换后的正文
 */
export function replaceCliNotesSection(existing, section) {
  const text = String(existing ?? '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const marker = lines.findIndex((line) => line.trim() === NOTES_MARKER)
  const head = marker >= 0 ? lines.slice(0, marker).join('\n') : text
  const trimmedHead = head.replace(/\n+$/, '')
  return trimmedHead ? `${trimmedHead}\n\n${section}` : section
}

/**
 * 渲染 CLI 段落（从 manifest 读平台 / 文件名 / 哈希，不写死任何一项）。
 * @param {{manifests: object[], tag: string, repository: string}} opts
 * @returns {string}
 */
export function renderCliNotes({ manifests, tag, repository }) {
  const rows = [...manifests]
    .sort((a, b) => String(a.triple).localeCompare(String(b.triple)))
    .map((m) => {
      const url = `https://github.com/${repository}/releases/download/${tag}/${m.archive}`
      return `| \`${m.triple}\` | [\`${m.archive}\`](${url}) | \`${m.sha256}\` |`
    })
  return [
    NOTES_MARKER,
    '',
    '## Headless CLI (`dsh-host-cli`)',
    '',
    'Drives an already-assembled Harness runtime from a terminal or a script: ' +
      '`start` / `stop` / `status` / `tail` / `probe` / `doctor`, no GUI, no Tauri. ' +
      'It does **not** bundle or download a runtime — point it at one with `--resource`.',
    '',
    '| Target | Archive | sha256 |',
    '|---|---|---|',
    ...rows,
    '',
    'Verify a download with `sha256sum -c <archive>.sha256` (macOS/Linux) or ' +
      '`certutil -hashfile <archive> SHA256` (Windows); each archive also carries its own `README.txt`.',
    ''
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 环境探测与归档
// ---------------------------------------------------------------------------

/**
 * `rustc -vV` 的 host 三元组。拿不到时返回 null（调用方要么报错，要么显式传 `--triple`）。
 * @returns {string|null}
 */
export function hostTriple() {
  const out = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })
  if (out.status !== 0) return null
  const m = /^host:\s*(\S+)$/m.exec(out.stdout ?? '')
  return m ? m[1] : null
}

/** 跑一条外部命令，失败时抛错并带上 stderr（不让「静默失败」有机会传下去）。 */
function run(command, args, opts = {}) {
  const out = spawnSync(command, args, { encoding: 'utf8', ...opts })
  if (out.error) throw new Error(`${command} 无法执行：${out.error.message}`)
  if (out.status !== 0) {
    throw new Error(`${command} 退出码 ${out.status}\n${out.stderr || out.stdout || ''}`.trim())
  }
}

/**
 * 建归档：Windows 目标用 PowerShell `Compress-Archive`，其余用 `tar -czf`。
 *
 * tar 一律以「归档所在目录为 cwd、归档名为相对路径」调用。原因是实测过的一条：
 * Git Bash 的 GNU tar 把 `-f` 值里的 `host:path` 当作**远程主机**，于是
 * `-f C:\…\out.tar.gz` 会去连一个叫 `C` 的主机并报 `Cannot connect to C`。
 * Linux/macOS runner 的 tar 没这个歧义，但两边都用相对名就没有平台分叉。
 */
function createArchive({ stageDir, archivePath, triple }) {
  if (archiveExtension(triple) === '.zip') {
    // 用环境变量传路径：把 Windows 路径拼进 -Command 字符串会被转义规则咬到。
    run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Compress-Archive -Path (Join-Path $env:DSH_CLI_STAGE '*') -DestinationPath $env:DSH_CLI_ARCHIVE -Force"
      ],
      { env: { ...process.env, DSH_CLI_STAGE: stageDir, DSH_CLI_ARCHIVE: archivePath } }
    )
    return
  }
  run('tar', ['-czf', basename(archivePath), '-C', stageDir, '.'], { cwd: dirname(archivePath) })
}

/** 解归档（只用于回读校验，不对外提供「解包安装」的语义）。同上：`-f` 只给相对名。 */
function extractArchive({ archivePath, destDir, triple }) {
  if (archiveExtension(triple) === '.zip') {
    run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -Path $env:DSH_CLI_ARCHIVE -DestinationPath $env:DSH_CLI_DEST -Force'
      ],
      { env: { ...process.env, DSH_CLI_ARCHIVE: archivePath, DSH_CLI_DEST: destDir } }
    )
    return
  }
  run('tar', ['-xzf', basename(archivePath), '-C', destDir], { cwd: dirname(archivePath) })
}

// ---------------------------------------------------------------------------
// 打包主流程
// ---------------------------------------------------------------------------

/**
 * 打包一个 CLI 产物。
 *
 * @param {{binPath: string, triple: string, outDir: string, hostTriple?: string|null}} opts
 *   `binPath` 可省略扩展名（Windows 上自动补 `.exe`）。`hostTriple` 用于判断能否
 *   直接执行产物（仅同三元组时执行）。
 * @returns {{base: string, archive: string, sidecar: string, binary: string, bytes: number,
 *   manifestPath: string, manifest: object, smoke: string[]}}
 * @throws {Error} 任一环节失败（含回读校验与产物执行自检不通过）
 */
export function packageCli({ binPath, triple, outDir, hostTriple: host }) {
  const version = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version
  const binaryName = binaryFileName(triple)

  let source = resolve(binPath)
  if (!existsSync(source) && existsSync(`${source}.exe`)) source = `${source}.exe`
  if (!existsSync(source)) {
    throw new Error(`找不到二进制：${binPath}（先跑 \`cargo build --release -p dsh-host-cli\`）`)
  }

  const base = artifactBaseName(version, triple)
  const archive = join(resolve(outDir), `${base}${archiveExtension(triple)}`)
  const sidecar = `${archive}.sha256`
  mkdirSync(resolve(outDir), { recursive: true })

  const stageDir = mkdtempSync(join(tmpdir(), 'dsh-cli-package-'))
  const verifyDir = mkdtempSync(join(tmpdir(), 'dsh-cli-verify-'))
  try {
    // 1) staging：二进制 + 说明（+ LICENSE，存在于仓库根时自动带上）。
    const staged = join(stageDir, binaryName)
    copyFileSync(source, staged)
    if (process.platform !== 'win32') {
      // copyFileSync 不保证带上可执行位；归档后再补就晚了（tar 已按 mode 打包）。
      // 必须用 chmodSync：writeFileSync 的 mode 只在**创建**时生效，改不动已存在的文件。
      chmodSync(staged, 0o755)
    }
    writeFileSync(join(stageDir, README_NAME), artifactReadme({ version, triple }), 'utf8')
    const license = join(projectRoot, 'LICENSE')
    if (existsSync(license)) copyFileSync(license, join(stageDir, 'LICENSE'))

    // 2) 归档 + 边车。
    createArchive({ stageDir, archivePath: archive, triple })
    const hash = sha256File(archive)
    writeFileSync(sidecar, sidecarText(hash, basename(archive)), 'utf8')

    // 3) 回读校验：解包出来的必须与打包前逐字节一致。
    const sourceHash = sha256File(staged)
    extractArchive({ archivePath: archive, destDir: verifyDir, triple })
    const problems = inspectExtracted({
      destDir: verifyDir,
      binaryName,
      sourceHash,
      expectExecutable: process.platform !== 'win32'
    })
    if (problems.length > 0) {
      throw new Error(`归档回读校验失败：\n  - ${problems.join('\n  - ')}`)
    }

    // 4) 产物执行自检：解包出来那一份**真的跑一次**（同三元组时才可能）。
    const sameTriple = (host ?? null) === triple
    const smoke = sameTriple
      ? smokeRun({ binaryPath: join(verifyDir, binaryName), version })
      : [`跳过产物执行自检：目标 ${triple} 与本机 ${host ?? '未知'} 不同，无法在本机执行`]
    const smokeFailures = smoke.filter((p) => !p.startsWith('跳过'))
    if (smokeFailures.length > 0) {
      throw new Error(`产物执行自检失败：\n  - ${smokeFailures.join('\n  - ')}`)
    }
    if (sameTriple) {
      smoke.length = 0
      smoke.push(`产物执行自检通过：\`--version\` 回显 ${version}，缺失资源树时退出码 3`)
    }

    // 5) manifest：发布工作流据此取文件，不靠 glob（glob 会把无关文件一起传上去）。
    //    文件名带平台三元组：三个平台的 CLI job 会把 manifest 一起传进同一个
    //    Release，同名文件会互相覆盖。
    const manifest = {
      kind: 'dsh-host-cli',
      version,
      triple,
      binary: binaryName,
      archive: basename(archive),
      sidecar: basename(sidecar),
      sha256: hash,
      archiveBytes: statSync(archive).size,
      binaryBytes: statSync(staged).size
    }
    const manifestPath = join(resolve(outDir), `${base}.manifest.json`)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    return { base, archive, sidecar, binary: source, bytes: manifest.archiveBytes, manifestPath, manifest, smoke }
  } finally {
    rmSync(stageDir, { recursive: true, force: true })
    rmSync(verifyDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 自测
// ---------------------------------------------------------------------------

/**
 * 自测：纯逻辑判据 + 一次真归档回读 + 两类可伪证性夹具。
 *
 * 可伪证性检查的意义：断言「哈希必须一致」「可执行位必须存在」如果永远不会变红，
 * 那它只是装饰。这里把**篡改过的拷贝**与**去掉可执行位的拷贝**喂进同一批判据，
 * 要求它们必须被报出来。
 *
 * @returns {{passed: number}}
 */
export function selfTest() {
  const failures = []
  let passed = 0
  const check = (condition, message) => {
    passed += 1
    if (!condition) failures.push(message)
  }

  // 1) 命名判据。
  check(
    artifactBaseName('0.3.0', 'x86_64-pc-windows-msvc') === 'dsh-host-cli-v0.3.0-x86_64-pc-windows-msvc',
    '产物基名必须由版本与三元组唯一决定'
  )
  check(archiveExtension('x86_64-pc-windows-msvc') === '.zip', 'Windows 目标必须给 .zip')
  check(archiveExtension('aarch64-apple-darwin') === '.tar.gz', 'macOS 目标必须给 .tar.gz')
  check(archiveExtension('x86_64-unknown-linux-gnu') === '.tar.gz', 'Linux 目标必须给 .tar.gz')
  check(binaryFileName('aarch64-apple-darwin') === 'dsh-host-cli', '非 Windows 目标不带 .exe')
  check(binaryFileName('x86_64-pc-windows-msvc') === 'dsh-host-cli.exe', 'Windows 目标带 .exe')

  // 2) 边车形状：能被 sha256sum -c 读，且坏形状必须判 null 而不是猜。
  const hash = 'a'.repeat(64)
  const parsed = parseSidecar(sidecarText(hash, 'x.tar.gz'))
  check(parsed?.hash === hash && parsed?.fileName === 'x.tar.gz', '边车必须能往返解析')
  check(parseSidecar(`${hash} x.tar.gz`) === null, '可伪证性：单空格分隔的边车必须被判为无效（sha256sum -c 读不了）')
  check(parseSidecar('') === null, '可伪证性：空边车必须被判为无效')

  // 3) 真归档回读（当前平台）。合成一个「假二进制」，走完整条打包链路。
  const triple = hostTriple() ?? `${process.platform}-${process.arch}`
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-cli-selftest-'))
  try {
    const fakeBin = join(tmp, binaryFileName(triple))
    writeFileSync(fakeBin, Buffer.alloc(64 * 1024, 7), { mode: 0o755 })
    const result = packageCli({ binPath: fakeBin, triple, outDir: join(tmp, 'out') })
    check(existsSync(result.archive), '自测：归档必须真的落盘')
    check(result.bytes > 0, '自测：归档不能是空文件')
    const sidecarParsed = parseSidecar(readFileSync(result.sidecar, 'utf8'))
    check(sidecarParsed?.hash === sha256File(result.archive), '自测：边车哈希必须等于归档的 sha256')

    // 篡改一只读回去的拷贝 → 同一批判据必须变红（否则「哈希比对」是装饰）。
    const verifyDir = join(tmp, 'tamper')
    mkdirSync(verifyDir, { recursive: true })
    extractArchive({ archivePath: result.archive, destDir: verifyDir, triple })
    const tampered = join(verifyDir, binaryFileName(triple))
    const bytes = readFileSync(tampered)
    bytes[0] ^= 0xff
    writeFileSync(tampered, bytes)
    check(
      inspectExtracted({
        destDir: verifyDir,
        binaryName: binaryFileName(triple),
        sourceHash: sha256File(fakeBin),
        expectExecutable: process.platform !== 'win32'
      }).length > 0,
      '可伪证性：被篡改的解包内容必须被判红'
    )

    // 可执行位判据同样要能被证伪（限 Unix：Windows 没有这个位）。
    if (process.platform !== 'win32') {
      const plainDir = join(tmp, 'noexec')
      mkdirSync(plainDir, { recursive: true })
      extractArchive({ archivePath: result.archive, destDir: plainDir, triple })
      const plain = join(plainDir, binaryFileName(triple))
      chmodSync(plain, 0o644)
      check(
        inspectExtracted({
          destDir: plainDir,
          binaryName: binaryFileName(triple),
          sourceHash: sha256File(fakeBin),
          expectExecutable: true
        }).some((p) => p.includes('可执行位')),
        '可伪证性：丢掉可执行位的解包内容必须被判红'
      )
    }

    // 4) 缺失输入必须报错而不是产出空归档。
    let threw = false
    try {
      packageCli({ binPath: join(tmp, 'nope'), triple, outDir: join(tmp, 'out2') })
    } catch {
      threw = true
    }
    check(threw, '可伪证性：二进制不存在时必须抛错')

    // 5) 产物执行自检的判据本身要能变红（真执行由本地跑与 CI 覆盖，
    //    这里钉住「什么样的输出算失败」）。
    check(checkVersionOutput('dsh-host-cli 0.3.0\n', '0.3.0').length === 0, '版本回显正确时必须判绿')
    check(
      checkVersionOutput('dsh-host-cli 0.2.9\n', '0.3.0').length === 1,
      '可伪证性：版本回显不符必须判红（否则 `--version` 检查是装饰）'
    )
    check(checkVersionOutput('', '0.3.0').length === 1, '可伪证性：空输出必须判红')
    check(checkMissingResourceExit(3).length === 0, '退出码 3（缺失资源）必须判绿')
    check(
      checkMissingResourceExit(0).length === 1,
      '可伪证性：缺失资源却退出 0 必须判红（那意味着二进制什么都没做就成功了）'
    )
    check(
      checkMissingResourceExit(null).length === 1,
      '可伪证性：进程被信号杀死（status=null）必须判红'
    )

    // 6) manifest 必须与产出的文件对得上——它是上传步骤的唯一依据。
    check(result.manifest.archive === basename(result.archive), 'manifest.archive 必须与真实归档同名')
    check(result.manifest.sha256 === sha256File(result.archive), 'manifest.sha256 必须等于归档真实哈希')
    check(result.manifest.archiveBytes === result.bytes, 'manifest.archiveBytes 必须等于归档真实大小')
    check(
      existsSync(join(dirname(result.manifestPath), result.manifest.sidecar)),
      'manifest 指向的边车文件必须存在'
    )
    check(
      basename(result.manifestPath) === `${result.base}.manifest.json`,
      'manifest 文件名必须带平台三元组（三平台会传进同一个 Release，同名会互相覆盖）'
    )

    // 7) 「核验已发布产物」的判据：正常产物必须判绿，三类链路损坏必须判红。
    const asPublished = verifyDownloaded({ dir: dirname(result.archive), manifestPath: result.manifestPath })
    check(asPublished.problems.length === 0, `篡改前必须判绿（实际问题：${asPublished.problems.join('；')}）`)

    const dlDir = join(tmp, 'downloaded')
    mkdirSync(dlDir, { recursive: true })
    copyFileSync(result.archive, join(dlDir, result.manifest.archive))
    copyFileSync(result.sidecar, join(dlDir, result.manifest.sidecar))
    check(
      verifyDownloaded({ dir: dlDir, manifestPath: result.manifestPath }).problems.length === 0,
      '可伪证性：原样复制的产物必须判绿（否则核验会误报）'
    )

    // 7a) 上传链路截断了文件（大小与哈希都会变）。
    const truncated = join(dlDir, result.manifest.archive)
    const original = readFileSync(truncated)
    writeFileSync(truncated, original.subarray(0, Math.max(1, original.length - 64)))
    check(
      verifyDownloaded({ dir: dlDir, manifestPath: result.manifestPath }).problems.length > 0,
      '可伪证性：被截断的产物必须判红'
    )
    writeFileSync(truncated, original)

    // 7b) 边车与归档不匹配（用户按边车核对会得出与 manifest 相反的结论）。
    writeFileSync(join(dlDir, result.manifest.sidecar), sidecarText('b'.repeat(64), result.manifest.archive))
    const sidecarMismatch = verifyDownloaded({ dir: dlDir, manifestPath: result.manifestPath }).problems
    check(
      sidecarMismatch.some((p) => p.includes('边车里的哈希')),
      '可伪证性：边车与 manifest 不一致必须判红'
    )

    // 7c) 边车形状坏掉（不可解析）。
    writeFileSync(join(dlDir, result.manifest.sidecar), 'not a checksum\n')
    check(
      verifyDownloaded({ dir: dlDir, manifestPath: result.manifestPath }).problems.some((p) =>
        p.includes('无法解析')
      ),
      '可伪证性：边车形状不可解析必须判红'
    )

    // 7d) 归档根本没下载下来。
    rmSync(truncated)
    check(
      verifyDownloaded({ dir: dlDir, manifestPath: result.manifestPath }).problems.length > 0,
      '可伪证性：归档缺失必须判红'
    )

    // 8) Release 正文段落：内容来自 manifest，且**重跑不会出现两遍**。
    const section = renderCliNotes({
      manifests: [result.manifest, { ...result.manifest, triple: 'aarch64-apple-darwin', archive: 'a.tar.gz', sha256: 'f'.repeat(64) }],
      tag: 'v9.9.9',
      repository: 'owner/repo'
    })
    check(section.includes('aarch64-apple-darwin'), '段落必须列出每个平台的三元组')
    check(section.includes('f'.repeat(64)), '段落必须列出每个平台的 sha256')
    check(section.includes('releases/download/v9.9.9/a.tar.gz'), '段落必须按 tag 生成下载链接')

    const once = replaceCliNotesSection('## 原有正文\n\n之前的说明\n', section)
    const twice = replaceCliNotesSection(once, section)
    check(twice === once, '可伪证性：把同一段落再替换一次必须幂等（否则重跑会出两遍表格）')
    check(
      twice.split(NOTES_MARKER).length - 1 === 1,
      '可伪证性：最终正文里的标记行必须恰好一条'
    )
    check(twice.includes('原有正文'), '替换不得吃掉表格之前的原有正文')
    check(
      replaceCliNotesSection('', section).startsWith(NOTES_MARKER),
      '正文为空时段落必须原样落地（不得留下前导空行）'
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    throw new Error(`package-cli 自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`)
  }
  return { passed }
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { out: join(projectRoot, 'dist', 'cli') }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--bin') opts.bin = argv[++i]
    else if (arg === '--triple') opts.triple = argv[++i]
    else if (arg === '--out') opts.out = argv[++i]
    else if (arg === '--verify-download') opts.verifyDownload = argv[++i]
    else if (arg === '--manifest') opts.manifest = argv[++i]
    else if (arg === '--release-notes') opts.releaseNotes = argv[++i]
    else if (arg === '--existing-notes') opts.existingNotes = argv[++i]
    else if (arg === '--tag') opts.tag = argv[++i]
    else if (arg === '--self-test') opts.selfTest = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return opts
}

function usage() {
  console.log(`用法：
  node scripts/package-cli.mjs --bin <已编译的二进制> [--triple <目标三元组>] [--out <目录>]
  node scripts/package-cli.mjs --verify-download <已下载产物所在目录> --manifest <manifest.json>
  node scripts/package-cli.mjs --release-notes <manifest 所在目录> --tag <tag> [--existing-notes <文件>]
  node scripts/package-cli.mjs --self-test

  --bin        cargo build 产物路径（可省 .exe，Windows 上自动补）
  --triple     默认取 \`rustc -vV\` 的 host
  --out        产物目录，默认 dist/cli
  --verify-download  核验下载回来的归档 / 边车与 manifest 是否一致（发布链路自证）
  --release-notes    渲染 Release 正文里的 CLI 段落（读 manifest，写到 stdout）`)
}

/** 读取目录下全部 `<*.manifest.json>`。 */
function readManifests(dir) {
  return readdirSync(resolve(dir))
    .filter((f) => f.endsWith('.manifest.json'))
    .map((f) => JSON.parse(readFileSync(join(resolve(dir), f), 'utf8')))
}

function runCli() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    usage()
    return
  }
  if (opts.selfTest) {
    const { passed } = selfTest()
    console.log(`✅ package-cli 自测通过（${passed} 项）`)
    return
  }
  if (opts.releaseNotes) {
    if (!opts.tag) throw new Error('--release-notes 需要同时给 --tag')
    const manifests = readManifests(opts.releaseNotes)
    if (manifests.length === 0) {
      throw new Error(`${opts.releaseNotes} 下没有任何 *.manifest.json——产物段落会是空的`)
    }
    const existing = opts.existingNotes ? readFileSync(opts.existingNotes, 'utf8') : ''
    const section = renderCliNotes({
      manifests,
      tag: opts.tag,
      repository: process.env.GITHUB_REPOSITORY ?? 'wang-yi-bit64/dsh-desktop'
    })
    process.stdout.write(replaceCliNotesSection(existing, section))
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
  if (!opts.bin) {
    usage()
    throw new Error('缺少 --bin（或用 --self-test / --verify-download）')
  }
  const triple = opts.triple ?? hostTriple()
  if (!triple) {
    throw new Error('拿不到 rustc host 三元组——请显式传 --triple')
  }
  const result = packageCli({ binPath: opts.bin, triple, outDir: opts.out, hostTriple: hostTriple() })
  console.log(`📦 ${result.base}`)
  console.log(`   ${result.archive}  (${(result.bytes / 1024 / 1024).toFixed(2)} MiB)`)
  console.log(`   ${result.sidecar}`)
  console.log(`   ${result.manifestPath}`)
  for (const note of result.smoke) console.log(`   · ${note}`)
  const execNote =
    process.platform === 'win32' ? '哈希一致（Windows 无可执行位）' : '解包后哈希与可执行位一致'
  console.log(`   ✅ 回读校验通过：${execNote}`)
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
    console.error(`package-cli 失败：${error.message}`)
    process.exit(1)
  }
}
