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
  truncateSync,
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

// ---------------------------------------------------------------------------
// 分发完整性判据（2026-09-22 补）
//
// ## 为什么存在
//
// 实测（0.7.0-alpha.3）：`dsh-desktop.exe` 对 `WebView2Loader.dll` 是**载入期静态
// 导入**（`objdump -p` 确认）。缺它时进程在 `main()` 之前就被 OS 掐死，表现为
// 退出码 `0xC0000135`（STATUS_DLL_NOT_FOUND）、无窗口、stderr 为空、日志一行不写
// ——即「应用毫无征兆地起不来」，靠看日志根本无从归因。
//
// 该 DLL 由 tauri-bundler 在打包后写进 `target/release/` 的**根目录**（不在
// `resources/` 里）。而本脚本原先只 stage 两样东西：exe 与 `resources/*`，
// 于是它被**静默丢弃**——打出来的包看着有 exe、回读校验还报「通过」。
//
// ⚠️ **同一个根因也影响 NSIS 安装包**：`installer.nsi` 里 `WebView2Loader`
// 出现次数为 0，tauri-bundler 只把 exe 一个二进制列进清单。`AGENTS.md` §2
// 记录的「GNU 构建下安装包缺 WebView2Loader.dll」与本案是同一件事的两个表现。
//
// ## 为什么判据不写死文件清单
//
// `resources/` 的完整性判据必须与上游 `prepare-harness.mjs` 的 `REQUIRED_FILES`
// / `REQUIRED_DIRS` 保持同源，否则两处会各自漂移。但那两个常量未导出，而给
// `prepare-harness.mjs` 加 export 会**在它被直接执行时触发副作用**（它是带顶层
// `await` 的 CLI 脚本，`import` 会真的跑一遍组装）。
//
// 因此这里改用**结构判据**，并与 `tauri.conf.json` 的 `bundle.resources` 清单
// 逐条对齐（含 `resources/node/*`、`resources/bin/*`、`resources/harness/**\/*`
// 三条 glob —— 它们正是运行时主体）。
// （历史上这里并列引用过一个 `tauri.portable.conf.json`：其 `bundle.resources`
//  与 `tauri.conf.json` 逐条相同，已于 2026-09-22 作为孤置配置删除，判据不受影响。）
// 判据只描述「打包前输入必须自洽」，因此对两条通道都成立，不重复声明资源清单。
// ---------------------------------------------------------------------------

/**
 * 便携版必须在 `target/release/` 根目录随行分发的运行期依赖。
 *
 * 这些文件**不在 `resources/` 里**，因此不会被 `resources/*` 的拷贝覆盖——
 * 必须显式 stage，否则打包静默产出一个启动即崩的空壳。
 */
export const REQUIRED_SIDECAR_FILES = ['WebView2Loader.dll']

/**
 * `resources/` 下必须存在的运行时子树（对应 `bundle.resources` 的三条 glob）。
 */
export const REQUIRED_RUNTIME_DIRS = [join('node'), join('bin'), join('harness', 'node_modules')]

/**
 * 运行时树的最小体积护栏（字节）。
 *
 * 内置 Node 单文件约 90 MB，加上 Harness 依赖树后整体在数百 MB 量级，
 * 因此 100 MB 是个宽松但足够有效的地板：它能把「tree 被当成空目录拷贝」
 * 这类静默失败直接变红，又不会在压缩率波动时误报。
 */
export const MIN_RUNTIME_BYTES = 100 * 1024 * 1024

/**
 * 统计目录下的文件数与总字节数。
 * @param {string} dir
 * @returns {{files: number, bytes: number}}
 */
export function dirStats(dir) {
  let files = 0
  let bytes = 0
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        files += 1
        try {
          bytes += statSync(full).size
        } catch {
          /* 读不到的条目不计入体积，但不因此中断统计 */
        }
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

/**
 * 打包**前**校验输入产物自洽：exe + resources 运行时树 + 根目录旁挂依赖。
 *
 * 这是本次缺陷的核心守卫。原先的流程只做「解包后能找到非空 exe」，于是
 * 「对着 576 MB 的完好 resources/ 打出一个丢掉 99.2% 内容的 4.36 MiB 空壳」
 * 也能报 `✅ 回读校验通过`、exit 0 —— 残缺包由此一路通过发布门禁。
 *
 * @param {{appDir: string, exeName: string, triple: string}} opts
 * @returns {{problems: string[], runtime: {files: number, bytes: number}}} 问题清单与实测体积
 */
export function inspectBundleDir({ appDir, exeName, triple }) {
  const problems = []
  const isWindows = /windows|win32/.test(triple)

  // 1) resources/ 必须存在。
  const resourcesDir = join(appDir, 'resources')
  if (!existsSync(resourcesDir)) {
    problems.push(`输入目录里没有 resources/ 子目录：${resourcesDir}`)
    return { problems, runtime: { files: 0, bytes: 0 } }
  }

  // 2) 运行时子树必须齐全（对应 bundle.resources 的三条 glob）。
  for (const sub of REQUIRED_RUNTIME_DIRS) {
    if (!existsSync(join(resourcesDir, sub))) {
      problems.push(
        `resources/ 缺少运行时子树 resources/${sub}——` +
          `这会被静默打成空壳包（bundle.resources 明确要求它）`
      )
    }
  }

  // 2b) 内置 Node 二进制（`resources/node/*` 的唯一实体）。
  const nodeBinName = isWindows ? 'node.exe' : 'node'
  if (!existsSync(join(resourcesDir, 'node', nodeBinName))) {
    problems.push(`resources/node/${nodeBinName} 不存在——内置 Node 运行时缺失，Harness 无法启动`)
  }

  // 3) 体积护栏：防「目录存在但内容是空的」。
  const runtime = dirStats(resourcesDir)
  if (runtime.bytes < MIN_RUNTIME_BYTES) {
    problems.push(
      `resources/ 只有 ${(runtime.bytes / 1024 / 1024).toFixed(1)} MiB（${runtime.files} 个文件），` +
        `低于 ${MIN_RUNTIME_BYTES / 1024 / 1024} MiB 护栏——运行时树明显不完整`
    )
  }

  // 4) 根目录旁挂运行期依赖（Windows 上即 WebView2Loader.dll）。
  if (isWindows) {
    for (const file of REQUIRED_SIDECAR_FILES) {
      if (!existsSync(join(appDir, file))) {
        problems.push(
          `${file} 不在 ${appDir} 根目录下——它是 exe 的载入期静态导入，` +
            `缺失会导致启动即崩（0xC0000135 STATUS_DLL_NOT_FOUND）且不产生任何日志`
        )
      }
    }
  }

  return { problems, runtime }
}

/**
 * 检查解包结果是否包含应有的分发内容。
 *
 * 与原先「只看 exe」的校验相比，这里补上了**运行时与旁挂依赖的存在性**——
 * 正是原先的缺口让一个丢掉 99.2% 内容的包被判为「通过」。
 *
 * @param {{destDir: string, exeName: string, triple: string}} opts
 * @returns {string[]} 问题清单
 */
export function inspectExtractedContents({ destDir, exeName, triple }) {
  const problems = []
  const isWindows = /windows|win32/.test(triple)

  const exePath = join(destDir, exeName)
  if (!existsSync(exePath)) {
    problems.push(`解包目录里没有 ${exeName}`)
    return problems
  }
  if (statSync(exePath).size === 0) {
    problems.push(`${exeName} 是空文件（解包流程异常）`)
  }

  const resourcesDir = join(destDir, 'resources')
  if (!existsSync(resourcesDir)) {
    problems.push('解包目录里没有 resources/')
  } else {
    for (const sub of REQUIRED_RUNTIME_DIRS) {
      if (!existsSync(join(resourcesDir, sub))) {
        problems.push(`解包后缺少 resources/${sub}（打包时被丢弃了）`)
      }
    }
    const nodeBinName = isWindows ? 'node.exe' : 'node'
    if (!existsSync(join(resourcesDir, 'node', nodeBinName))) {
      problems.push(`解包后缺少 resources/node/${nodeBinName}`)
    }
  }

  if (isWindows) {
    for (const file of REQUIRED_SIDECAR_FILES) {
      if (!existsSync(join(destDir, file))) {
        problems.push(`解包后缺少 ${file}（载入期静态导入，缺失则启动即崩）`)
      }
    }
  }

  return problems
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
 * 解包 zip 归档所用的命令。
 *
 * ## 🔴 为什么必须是纯函数、且必须跨平台（2026-09-22 修正）
 *
 * 调用它的 `--verify-download` 跑在 **`cli-publish` job（`ubuntu-latest`）** 上，
 * 而要核验的便携包是 Windows 产出的 `.zip`（`portable` job 是 windows-only，
 * 产物经 artifact 存储汇到发布 job 的 `dist/portable/`）。
 *
 * 原实现无条件 spawn `powershell … Expand-Archive`：ubuntu runner 上没有
 * `powershell`，`spawnSync` 返回 `ENOENT`（`status` 为 `null`），于是核验必然
 * 报「无法解包」→ 整个发布在**下载完产物之后**判红。它一直没被暴露，是因为
 * 之前每一次 Release 都更早地死在 portable job（签名密钥缺失）上，
 * `cli-publish` 根本没执行过——典型的「被上游失败掩盖的下游缺陷」。
 *
 * 选择：Windows 用系统自带的 PowerShell（不依赖 PATH 里有 `unzip`）；
 * 其余平台用 `unzip`（ubuntu / macOS 基础镜像都自带）。
 * **不能**用 `tar`：GNU tar 读不了 zip，而 `cli-publish` 的 runner 正是 GNU tar。
 *
 * 判据做成**纯函数**（平台是入参）是为了能被自测钉住：两个分支都必须逐字对得上，
 * 否则下一次「换个平台跑就红」还是只能等真发布才发现。
 *
 * @param {{archive: string, destDir: string, platform?: string}} opts
 * @returns {{command: string, args: string[], env?: Record<string, string>}}
 */
export function zipExtractCommand({ archive, destDir, platform = process.platform }) {
  if (platform === 'win32') {
    return {
      command: 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -Path $env:DSH_PORTABLE_ARCHIVE -DestinationPath $env:DSH_PORTABLE_DEST -Force'
      ],
      // 值走 env 而不是拼进命令行：路径里出现引号/空格时拼串会静默改语义。
      env: { DSH_PORTABLE_ARCHIVE: archive, DSH_PORTABLE_DEST: destDir }
    }
  }
  return { command: 'unzip', args: ['-o', '-q', archive, '-d', destDir] }
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
 * ## 🔴 为什么必须排除 `resources/` 下的 exe（2026-09-22 修正）
 *
 * 回退分支是**递归**的，而 `resources/node/node.exe`（内置 Node 运行时）也
 * 叫 `.exe`。原实现因此会把**内置 Node 当成应用主程序**并把它 stage 成包里的
 * 顶层可执行文件——打出来的包里根本没有 `dsh-desktop.exe`。
 *
 * 实测：输入 `target/release/`（含 `DSH Desktop.exe` + `resources/`）时
 * `findAppExe` 返回的是 `resources\node\node.exe`。
 *
 * 注意这与「先扫顶层」并不矛盾：真实产物里顶层**同时**有应用 exe 与
 * `resources/`，先扫顶层能挡住多数情况；但只要有任何一个顶层 exe 的判定
 * 落空（文件名变化、目录被裁、CI 上产物形状不同），回退分支就会静默选中
 * 内置 Node，产出一个「有 exe、但 exe 是 Node」的包——而回读校验原先只查
 * 「有没有非空 exe」，照样报通过。
 *
 * 修正方式：递归分支**永不进入 `resources/`**——那里放的是运行时素材，
 * 不是应用主程序。判据是「路径段」而非「字符串包含」，避免误伤名字里恰好
 * 含 `resources` 的目录。
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

  // 2) 顶层没有时再递归，但跳过已知构建产物目录与 resources/。
  const SKIP = new Set(['.fingerprint', 'build', 'deps', 'resources'])
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

  // 内容级核验：上面几条只能证明「下载没坏」，证明不了「包里东西齐全」。
  // 一个丢掉 99% 内容的残缺包，sha256 与 manifest 完全可以自洽。
  // manifest 记录了打包时的运行时文件数，因此这里能查出「包被削过」。
  //
  // 🔴 **2026-09-22 修正：缺 `runtimeFiles` 必须是硬失败，不是「跳过校验」。**
  //
  // 原先写成 `if (typeof manifest.runtimeFiles === 'number') { …内容校验… }`，
  // 于是**没有这个字段的 manifest 会静默跳过全部内容校验**，只剩 sha256 + 大小
  // 两项——而这两项对残缺包毫无约束力（一个丢 99.2% 内容的空壳，其哈希与体积
  // 完全可以自洽）。
  //
  // 实测后果：`dist/portable/` 下的 alpha.2 / alpha.3 就是旧版脚本产出的空壳
  // （15 个文件 / 8.9 MiB，运行时树全丢），manifest 里恰好没有 `runtimeFiles`，
  // 因此 `--verify-download` 对它们一路放行。**判据的缺失被当成了「无需校验」。**
  //
  // 判据必须写成「按名字取字段并检验其存在」：旧形状的 manifest 无法支撑核验，
  // 因此它本身就是一个必须判红的问题，而不是一个可以静默绕过的分支。
  if (typeof manifest.runtimeFiles !== 'number') {
    problems.push(
      `${manifestPath} 里没有 runtimeFiles 字段（打包时的运行时文件数）——` +
        `没有它就无法核验归档内容是否被削过，核验不成立。` +
        `这通常是旧版 package-portable 产出的 manifest，请用当前脚本重新打包后核验`
    )
  } else {
    const probeDir = mkdtempSync(join(tmpdir(), 'dsh-portable-probe-'))
    try {
      const isZip = manifest.archive.endsWith('.zip')
      // 解包命令按平台选（见 `zipExtractCommand` 的说明）：这一步跑在
      // `cli-publish`（ubuntu）上，无条件 spawn `powershell` 会让核验必然失败。
      const spec = isZip
        ? zipExtractCommand({ archive, destDir: probeDir })
        : { command: 'tar', args: ['-xzf', basename(archive), '-C', probeDir] }
      const extract = spawnSync(spec.command, spec.args, {
        ...(spec.env ? { env: { ...process.env, ...spec.env } } : {}),
        ...(isZip ? {} : { cwd: dirname(archive) }),
        stdio: 'ignore'
      })
      if (extract.error || extract.status !== 0) {
        problems.push(
          `${manifest.archive} 无法解包（命令 ${spec.command}，退出码 ${extract.status ?? 'n/a'}${
            extract.error ? `，${extract.error.code ?? extract.error.message}` : ''
          }）`
        )
      } else {
        const exeName = manifest.source ?? findAppExe(probeDir)?.name
        if (!exeName) {
          problems.push(`${manifest.archive} 解包后找不到 exe（manifest.source 缺失）`)
        } else {
          problems.push(
            ...inspectExtractedContents({ destDir: probeDir, exeName, triple: manifest.triple ?? '' }).map(
              (p) => `${manifest.archive}：${p}`
            )
          )
        }
        const actual = dirStats(join(probeDir, 'resources')).files
        if (actual !== manifest.runtimeFiles) {
          problems.push(
            `${manifest.archive} 解包后 resources/ 有 ${actual} 个文件，` +
              `而 manifest 记录打包时是 ${manifest.runtimeFiles} 个——归档内容被削过`
          )
        }
      }
    } finally {
      rmSync(probeDir, { recursive: true, force: true })
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
 * `<app>.exe`、`resources/` 目录，以及 tauri-bundler 落在**根目录**的运行期
 * 依赖（Windows 上即 `WebView2Loader.dll`）。
 *
 * 三者都进包。任缺其一，产物在用户机器上要么启动即崩，要么 Harness 起不来，
 * 且都不会产生可归因的日志——因此本函数对输入做**前置硬校验**（`inspectBundleDir`）
 * 并在打包后做**内容级回读校验**（`inspectExtractedContents`）。
 *
 * @param {{bundleDir: string, outDir: string, triple: string, version: string}} opts
 * @returns {{base: string, archive: string, sidecar: string, manifestPath: string, manifest: object, verify: string[], runtime: object}}
 */
export function packagePortable({ bundleDir, outDir, triple, version }) {
  // 便携版是 **Windows 独占**产物：stage 运行时树走 PowerShell `Copy-Item`，
  // 出归档走 PowerShell `Compress-Archive`，而且包里必须带 `.exe` 与
  // `WebView2Loader.dll`。这里显式拦住，把「换平台跑会得到一句语焉不详的
  // Compress-Archive 失败（退出码 n/a）」变成一句读得懂的前置条件；
  // 发布演练也据此声明「本机造不出便携版」这一类产物（见
  // `scripts/dry-run-cli-publish.mjs` 的产物类契约）。
  if (process.platform !== 'win32') {
    throw new Error(
      `便携版打包依赖 PowerShell，是 Windows 独占产物；当前平台 ${process.platform} 无法打包：${bundleDir}`
    )
  }

  const appDir = resolve(bundleDir)
  if (!existsSync(appDir)) {
    throw new Error(`输入目录不存在：${bundleDir}`)
  }

  const exeInfo = findAppExe(appDir)
  if (!exeInfo) {
    throw new Error(`在 ${bundleDir} 下找不到 .exe 文件（先跑 \`npm run tauri build\`）`)
  }

  // 0) 前置硬校验：输入自洽才谈得上产出可用的包。
  //    这一步是本次缺陷（0xC0000135 静默空壳）的正面守卫——原先完全没有。
  //
  //    🔴 **2026-09-22 致命缺陷修正**：这里原先写的是
  //
  //        const inputProblems = inspectBundleDir({ ... })   // → { problems, runtime }
  //        if (inputProblems.length > 0) { throw ... }       // → undefined > 0 === false
  //
  //    `inspectBundleDir` 返回的是**封装对象** `{ problems, runtime }`，不是数组。
  //    因此 `inputProblems.length` 恒为 `undefined`、条件恒为 `false`，
  //    **这个前置守卫从落地那一刻起就从未触发过一次**——缺 DLL 的输入会被
  //    照常打包出成品。这正是它要防的那个缺陷，守卫自己成了摆设。
  //
  //    实测证据（自测的可伪证性夹具当场抓到）：对缺 `WebView2Loader.dll` 的输入，
  //    `inspectBundleDir` 返回 `problems.length === 1`，但 `packagePortable`
  //    不抛错、正常出包，只在事后回读校验里留下一条 `verify` 警告。
  //    根因是**取错了字段层级**，因此这里的判据必须显式读 `.problems`。
  //
  //    ⚠️ 教训：`x.length > 0` 对「返回封装对象的函数」是个静默失效的写法——
  //    没有类型检查时它不报错、不 throw、看起来完全正常。判据应当写成
  //    「按名字取字段」，而不是依赖返回值恰好是数组。
  const { problems: inputProblems } = inspectBundleDir({
    appDir,
    exeName: exeInfo.name,
    triple
  })
  if (inputProblems.length > 0) {
    throw new Error(
      `输入产物不完整，拒绝打包（继续打包只会产出一个启动即崩的残缺包）：\n  - ${inputProblems.join('\n  - ')}\n` +
        `  提示：先跑 \`npm run tauri build\`，并确认 resources/ 已按目标通道组装。`
    )
  }

  const ext = archiveExtension(triple)
  const base = portableBaseName(version)
  const archive = join(resolve(outDir), `${base}${ext}`)
  const sidecar = `${archive}.sha256`
  mkdirSync(resolve(outDir), { recursive: true })

  // 1) 用 PowerShell Compress-Archive 把 exe + 根目录旁挂依赖 + resources/
  //    打包成 zip。源目录与目标文件不能同址，否则 Compress-Archive 会把目标
  //    itself 也塞进归档（自引用），在 Windows 上表现为静默失败。
  const stageDir = mkdtempSync(join(tmpdir(), 'dsh-portable-stage-'))
  try {
    // exe 复制到 staging 目录。
    const stagedExe = join(stageDir, exeInfo.name)
    writeFileSync(stagedExe, readFileSync(exeInfo.path))

    // 根目录旁的运行期依赖（WebView2Loader.dll 等）。
    // 这些文件不在 resources/ 里，必须显式 stage —— 漏掉就是 0xC0000135。
    for (const file of REQUIRED_SIDECAR_FILES) {
      const src = join(appDir, file)
      if (existsSync(src)) {
        writeFileSync(join(stageDir, file), readFileSync(src))
      }
    }

    // resources/ 复制到 staging 目录。
    // ⚠️ 这里必须**检查子进程退出码**：原先用 `stdio: 'ignore'` 且不看 status，
    //    结果 Compress-Archive / Copy-Item 静默失败时脚本照常往下走，产出一个
    //    丢内容的包并报「校验通过」。这是「报成功但内容缺失」的机制成因。
    //
    // ⚠️ 目标目录必须**先建出来**：`Copy-Item -Destination <不存在的目录>` 会
    //    直接把源当成要改名成的文件而报错退出 1（实测）。
    const srcResources = join(appDir, 'resources')
    if (existsSync(srcResources)) {
      const dstResources = join(stageDir, 'resources')
      mkdirSync(dstResources, { recursive: true })
      const copy = spawnSync(
        'powershell',
        [
          '-NoProfile', '-NonInteractive', '-Command',
          `Copy-Item -Path (Join-Path '${srcResources.replace(/'/g, "''")}' '*') -Destination '${dstResources.replace(/'/g, "''")}' -Recurse -Force`
        ],
        { stdio: 'ignore' }
      )
      if (copy.error || copy.status !== 0) {
        throw new Error(
          `复制 resources/ 到 staging 失败（退出码 ${copy.status ?? 'n/a'}${
            copy.error ? `，${copy.error.message}` : ''
          }）：${srcResources}`
        )
      }
    }
    // 复制结果必须非空——目录建出来但内容没进去，同样会打出空壳。
    // （`Copy-Item 'src\*'` 在源为空时不会报错，只会安静地什么都不做。）
    const stagedResources = join(stageDir, 'resources')
    if (existsSync(srcResources)) {
      const staged = dirStats(stagedResources)
      if (staged.files === 0) {
        throw new Error(
          `复制 resources/ 到 staging 后是空的：${stagedResources}\n` +
            `  源目录：${srcResources}（${dirStats(srcResources).files} 个文件）\n` +
            `  这是「Copy-Item 通配在批量文件上静默失效」的典型表现，继续打包会产出空壳包。`
        )
      }
    }

    const psSrc = stageDir.replace(/'/g, "''")
    const psDst = archive.replace(/'/g, "''")
    const compress = spawnSync(
      'powershell',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path (Join-Path '${psSrc}' '*') -DestinationPath '${psDst}' -Force`
      ],
      { stdio: 'ignore' }
    )
    if (compress.error || compress.status !== 0) {
      throw new Error(
        `Compress-Archive 失败（退出码 ${compress.status ?? 'n/a'}${
          compress.error ? `，${compress.error.message}` : ''
        }）——归档可能未产出或被截断：${archive}`
      )
    }
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
    source: exeInfo.name,
    // 记录随包分发的旁挂依赖与运行时规模，便于事后比对「包是不是被削过」。
    sidecarFiles: REQUIRED_SIDECAR_FILES.filter((f) => existsSync(join(appDir, f))),
    runtimeFiles: dirStats(join(appDir, 'resources')).files
  }
  const manifestPath = join(resolve(outDir), `${base}.manifest.json`)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // 3) 回读校验：解包后 exe 存在且非空，**且运行时与旁挂依赖都在**。
  const verifyDir = mkdtempSync(join(tmpdir(), 'dsh-portable-verify-'))
  const verify = (() => {
    try {
      const isZip = ext === '.zip'
      if (isZip) {
        const expand = spawnSync(
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
        if (expand.error || expand.status !== 0) {
          throw new Error(
            `Expand-Archive 回读失败（退出码 ${expand.status ?? 'n/a'}${
              expand.error ? `，${expand.error.message}` : ''
            }）`
          )
        }
      } else {
        spawnSync('tar', ['-xzf', basename(archive), '-C', verifyDir], {
          cwd: dirname(archive),
          stdio: 'ignore'
        })
      }
      return inspectExtractedContents({ destDir: verifyDir, exeName: exeInfo.name, triple })
    } finally {
      rmSync(verifyDir, { recursive: true, force: true })
    }
  })()

  return {
    base,
    archive,
    sidecar,
    manifestPath,
    manifest,
    verify,
    runtime: dirStats(join(appDir, 'resources'))
  }
}

// ---------------------------------------------------------------------------
// 夹具构造
// ---------------------------------------------------------------------------

/**
 * 造一个「够格」的 bundleDir 夹具：应用 exe + 根目录旁挂依赖 + 一棵体积过
 * `MIN_RUNTIME_BYTES` 护栏的 `resources/` 运行时树。
 *
 * ## 为什么导出（2026-09-22）
 *
 * `packagePortable` 的前置硬校验（`inspectBundleDir`）对输入有 5 条要求
 * （exe / 三棵运行时子树 / 内置 Node / 体积护栏 / 旁挂依赖），夹具必须逐条满足。
 * 发布演练 `scripts/dry-run-cli-publish.mjs` 也要造一份同样的输入去调**真的**
 * `packagePortable`（而不是手抄一份打包逻辑）。两处各写一份夹具必然漂移——
 * 于是把夹具构造收在这里，自测与演练共用同一个实现；判据（`inspectBundleDir`）
 * 仍是唯一真源，夹具一旦漏项，两条调用方都会当场报错。
 *
 * ## 体积为什么用 `truncateSync`
 *
 * `dirStats` 只对 `statSync().size` 求和，因此「逻辑大小」就够——不必真写 100 MB。
 * 原自测走 Windows `fsutil file createnew`，那要额外依赖一个系统命令；`truncateSync`
 * 是纯 Node、无需权限、各平台语义一致。
 *
 * @param {{dir: string, triple: string, runtimeBytes?: number, fillerBlocks?: number,
 *   fillerBytes?: number, withSidecar?: boolean}} opts
 *   `fillerBlocks` 是给「归档体积」那类断言备的**不可压缩**数据（Deflate 压不动）；
 *   只需要「过前置校验」的调用方传 0 即可，不必付这份时间与磁盘代价。
 * @returns {{exeName: string, resourcesDir: string, runtime: {files: number, bytes: number}}}
 */
export function makeBundleFixture({
  dir,
  triple,
  runtimeBytes = MIN_RUNTIME_BYTES + 8 * 1024 * 1024,
  fillerBlocks = 0,
  fillerBytes = 32 * 1024 * 1024,
  withSidecar = true
}) {
  const isWindows = /windows|win32/.test(triple)
  mkdirSync(dir, { recursive: true })

  // ⚠️ exe 名带空格是**刻意的**：真实产物就叫 `DSH Desktop.exe`，而归档 / 解包两步
  //    都要把路径穿过 PowerShell 命令行。用一个不含空格的假名会把这条风险盖掉。
  const exeName = 'DSH Desktop.exe'
  writeFileSync(join(dir, exeName), Buffer.alloc(32 * 1024, 9))
  if (withSidecar && isWindows) writeFileSync(join(dir, 'WebView2Loader.dll'), Buffer.alloc(1024, 7))

  const resourcesDir = join(dir, 'resources')
  for (const sub of REQUIRED_RUNTIME_DIRS) mkdirSync(join(resourcesDir, sub), { recursive: true })

  // 不可压缩填充：**每块独立分配 + 独立填充**。
  // `Buffer.alloc` 会拿 Node 的共享零填充池（未改写过的小 Buffer 常返回同一个
  // ArrayBuffer），复用同一个对象会让「多块」实际只有一块的体积与熵。
  for (let i = 0; i < fillerBlocks; i += 1) {
    const buf = Buffer.alloc(fillerBytes)
    let x = (i + 1) * 0x9e3779b1
    for (let j = 0; j < buf.length; j += 1) {
      x = (Math.imul(x, 1103515245) + 12345) | 0
      buf[j] = (x >>> 24) & 0xff
    }
    writeFileSync(join(resourcesDir, 'harness', 'node_modules', `filler-${i}.bin`), buf)
  }

  // 体积护栏：只置「逻辑大小」，不真写（见上）。零内容还能让 Deflate 秒过。
  const bulk = join(resourcesDir, 'harness', 'node_modules', 'bulk.bin')
  writeFileSync(bulk, '')
  truncateSync(bulk, runtimeBytes)

  writeFileSync(
    join(resourcesDir, 'node', isWindows ? 'node.exe' : 'node'),
    Buffer.alloc(64 * 1024, 3)
  )
  writeFileSync(join(resourcesDir, 'MANIFEST.json'), '{}')

  return { exeName, resourcesDir, runtime: dirStats(resourcesDir) }
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

  // 2b) 解包命令必须**按平台**选：`--verify-download` 跑在 ubuntu 的发布 job 上，
  //     无条件 spawn `powershell` 会让核验必然失败（见 zipExtractCommand 说明）。
  //     判据是纯函数，因此这里能钉住两个分支，而不必等真发布换平台才暴露。
  const zipOnWindows = zipExtractCommand({ archive: 'a.zip', destDir: 'd', platform: 'win32' })
  check(zipOnWindows.command === 'powershell', 'Windows 上解 zip 必须用系统自带 PowerShell')
  check(
    zipOnWindows.args.some((a) => a.includes('Expand-Archive')),
    'Windows 上的解包动作必须是 Expand-Archive'
  )
  check(
    zipOnWindows.env?.DSH_PORTABLE_ARCHIVE === 'a.zip' && zipOnWindows.env?.DSH_PORTABLE_DEST === 'd',
    'Windows 分支必须用 env 传路径（拼进命令行会在路径含引号时静默改语义）'
  )
  for (const platform of ['linux', 'darwin']) {
    const spec = zipExtractCommand({ archive: 'a.zip', destDir: 'd', platform })
    check(spec.command === 'unzip', `${platform} 上解 zip 必须用 unzip（那里没有 powershell）`)
    check(
      spec.args.includes('-o') && spec.args.includes('a.zip') && spec.args.includes('d'),
      `${platform} 的 unzip 参数必须包含 -o 与归档 / 目标目录`
    )
    check(
      !`${spec.command} ${spec.args.join(' ')}`.includes('powershell'),
      `可伪证性：${platform} 分支不得再依赖 powershell`
    )
  }

  // 3) 真打包回读（当前平台）。
  const hostTripleValue = (() => {
    const out = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })
    if (out.status !== 0) return null
    const m = /^host:\s*(\S+)$/m.exec(out.stdout ?? '')
    return m ? m[1] : null
  })()
  const triple = hostTripleValue ?? `${process.platform}-${process.arch}`
  const isWindows = /windows|win32/.test(triple)
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-portable-selftest-'))
  try {
    // 合成一个「假 target/release/」目录：内含一个 exe、根目录旁挂依赖（Windows
    // 上是 WebView2Loader.dll），以及一棵体积达标的 resources/ 运行时树。
    //
    // 夹具构造收在 `makeBundleFixture` 里（发布演练 `dry-run-cli-publish.mjs`
    // 共用同一份实现，避免两处各写一份而漂移）。这里额外要 2 块**不可压缩**
    // filler：「归档体积」那条断言靠它，而不是靠 `resources/` 的逻辑大小——
    // 零内容 Deflate 之后只剩几十 KiB，用它会把「空壳」那条断言测成假绿。
    //
    // ⚠️ 打包本体是 Windows 独占（`packagePortable` 有前置条件硬拦），因此本脚本的
    //    **打包类**判据只在本机为 Windows 时有意义；命名 / 边车 / 解包命令那几条是
    //    纯逻辑（平台是入参），在任何宿主上都照样跑、照样有效。
    //
    // （原先这段是内联的：4 块 32 MiB 全零块 + `fsutil` 稀疏文件 + 两个局部
    //   辅助函数；块数从 4 降到 2 只是省自测时间，断言强度不变——1 MiB 的门槛
    //   远在 2×32 MiB 之下，而「丢掉 99% 内容」照样会掉到门槛以下。）
    const fakeReleaseDir = join(tmp, 'tauri-release')
    const fixture = makeBundleFixture({ dir: fakeReleaseDir, triple, fillerBlocks: 2 })
    const fakeExeName = fixture.exeName
    const fakeResources = fixture.resourcesDir

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

    // 3a) 归档体积必须与输入量级相符——这是本次「4.36 MiB 空壳」缺陷的正面守卫。
    //
    //     ⚠️ 这条断言的**有效下限**取决于夹具里有多少不可压缩数据，而不是
    //     `resources/` 有多大。上面的 filler 是伪随机字节（Deflate 无可用结构），
    //     压完仍是同量级，因此 1 MiB 是个既宽松又真正有效的门槛：空壳回归
    //     （丢 99% 内容 → 几百 KiB）会立刻变红。
    const archiveBytes = statSync(result.archive).size
    check(
      archiveBytes > 1024 * 1024,
      `自测：归档体积 ${archiveBytes} B 与含 128 MiB 运行时的输入明显不符（空壳回归）`
    )
    check(
      result.runtime.bytes >= MIN_RUNTIME_BYTES,
      '自测：runtime.bytes 必须反映真实运行时体量'
    )

    // 3b) 旁挂依赖必须真的进包（Windows）。这是 0xC0000135 缺陷的正面守卫。
    if (isWindows) {
      const entries = new Set(readdirSync(fakeReleaseDir))
      check(entries.has('WebView2Loader.dll'), '自测夹具：旁挂依赖应存在于输入目录')
      check(
        result.manifest.sidecarFiles.includes('WebView2Loader.dll'),
        '自测：manifest.sidecarFiles 必须记录随包分发的旁挂依赖'
      )
      // 解包后必须能看到它。
      const probeDir = mkdtempSync(join(tmpdir(), 'dsh-portable-sidecar-'))
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
            env: { ...process.env, DSH_PORTABLE_ARCHIVE: result.archive, DSH_PORTABLE_DEST: probeDir },
            stdio: 'ignore'
          }
        )
        check(
          existsSync(join(probeDir, 'WebView2Loader.dll')),
          '自测：WebView2Loader.dll 必须真的出现在解包结果里（漏掉即静默打出崩包）'
        )
        check(
          existsSync(join(probeDir, 'resources', 'node', 'node.exe')),
          '自测：解包后 resources/node/node.exe 必须存在'
        )
      } finally {
        rmSync(probeDir, { recursive: true, force: true })
      }
    }

    // 3c) 可伪证性：输入缺 WebView2Loader.dll 时必须**拒绝打包**，而不是静默出包。
    if (isWindows) {
      const noDllDir = join(tmp, 'release-no-dll')
      // 顶层放**真 exe**（与真实产物形状一致），缺的只是根目录旁的 DLL。
      // 走共享夹具构造：`withSidecar: false` 就是「除 DLL 之外一切都合规」，
      // 这样断言才**只**证伪「旁挂依赖缺失」这一支——若连体积/子树都不达标，
      // 守卫会先因别的原因判红，断言虽绿但证伪的是错误的理由。
      // 不要 filler：这个夹具注定在**打包之前**被拒，归档根本不会产出，
      // 塞不可压缩数据只是白烧时间。
      makeBundleFixture({ dir: noDllDir, triple, withSidecar: false, fillerBlocks: 0 })
      let threw = false
      let message = ''
      try {
        packagePortable({ bundleDir: noDllDir, outDir: join(tmp, 'out-nodll'), triple, version: '0.3.0' })
      } catch (error) {
        threw = true
        message = error.message
      }
      check(threw, '可伪证性：输入缺 WebView2Loader.dll 时必须拒绝打包')
      check(message.includes('WebView2Loader.dll'), '可伪证性：拒绝理由必须点名缺失的 WebView2Loader.dll')

      // 3c-1) 🔴 回归守卫：缺 DLL 的输入必须**真的**抛错，而不是只留下一条警告。
      //
      //   这段夹具直接复刻 2026-09-22 的事故：前置守卫写了 `x.length > 0` 而
      //   `inspectBundleDir` 返回封装对象，导致抛错分支永远走不到。上面那条
      //   `check(threw, …)` 正是当场抓到这个缺陷的断言——它现在会守住这条路径。
      //   额外加一条：报错必须**来自前置校验**（点名"拒绝打包"），而不是来自
      //   别的环节碰巧抛了错。否则「抛错」这个观测可能由无关原因满足。
      check(
        message.includes('拒绝打包'),
        `回归守卫：缺 DLL 必须由**前置校验**拒绝（实际报错：${message.split('\n')[0]}）`
      )

      // 3c-2) 回归守卫：`findAppExe` 不得把 `resources/node/node.exe` 当应用主程序。
      //
      //   事故形态：真实产物顶层若没扫到 exe，递归分支会静默选中内置 Node，
      //   于是包里 stage 的是 `node.exe` 而不是 `dsh-desktop.exe`，且回读校验
      //   （原先只查「有非空 exe」）照样报通过。
      //
      //   ⚠️ 夹具必须**从外层目录**调用：`SKIP` 只作用于递归过程中遇到的目录名，
      //   把 `resources/` 本身当 root 传进来时它不算「被跳过的子目录」，自然仍会
      //   扫到里面的 `node.exe`（这正是本断言第一版判红的原因——断言写错了位置，
      //   不是代码错了）。因此这里造一个**只有 resources/、没有顶层 exe** 的目录，
      //   断言 findAppExe 返回 null。
      const resourcesOnlyDir = join(tmp, 'release-resources-only')
      mkdirSync(join(resourcesOnlyDir, 'resources', 'node'), { recursive: true })
      writeFileSync(join(resourcesOnlyDir, 'resources', 'node', 'node.exe'), Buffer.alloc(4096, 3))
      const resourcesOnlyExe = findAppExe(resourcesOnlyDir)
      check(
        resourcesOnlyExe === null,
        `回归守卫：findAppExe 不得把 resources/node/node.exe 当应用主程序（实际选中了 ${resourcesOnlyExe?.name ?? 'null'}）`
      )

      // 3d) 可伪证性：resources/ 体量不达标时必须拒绝打包（空壳回归守卫）。
      const thinDir = join(tmp, 'release-thin')
      mkdirSync(join(thinDir, 'resources', 'node'), { recursive: true })
      // 顶层放真 exe：这个夹具要证伪的是「体积护栏」这一支，
      // 前提是「能找到应用 exe」成立（否则会先撞上「找不到 .exe」）。
      writeFileSync(join(thinDir, fakeExeName), Buffer.alloc(32 * 1024, 9))
      writeFileSync(join(thinDir, 'WebView2Loader.dll'), Buffer.alloc(1024, 7))
      writeFileSync(join(thinDir, 'resources', 'node', 'node.exe'), Buffer.alloc(64 * 1024, 3))
      let thinThrew = false
      let thinMessage = ''
      try {
        packagePortable({ bundleDir: thinDir, outDir: join(tmp, 'out-thin'), triple, version: '0.3.0' })
      } catch (error) {
        thinThrew = true
        thinMessage = error.message
      }
      check(thinThrew, '可伪证性：只有 64 KiB resources/ 时必须拒绝打包')
      // 这个夹具**故意**只建 `resources/node`，不建 `bin` 与 `harness/node_modules`，
      // 因此 `inspectBundleDir` 会命中「缺少运行时子树」这一支（体积护栏是同批
      // problems 里的另一条）。断言必须接受它实际命中的那一支，否则会假红。
      check(
        /resources[\\/](node|bin|harness)/.test(thinMessage) || thinMessage.includes('护栏'),
        `可伪证性：拒绝理由必须指向运行时树不完整（实际：${thinMessage.split('\n')[1] ?? thinMessage.split('\n')[0]}）`
      )
    }

    // 3e) inspectExtractedContents 必须能抓出「解包后缺运行时」这类残缺。
    const brokenExtract = join(tmp, 'broken-extract')
    mkdirSync(brokenExtract, { recursive: true })
    writeFileSync(join(brokenExtract, fakeExeName), Buffer.alloc(1024, 1))
    const brokenProblems = inspectExtractedContents({ destDir: brokenExtract, exeName: fakeExeName, triple })
    check(brokenProblems.length > 0, '可伪证性：解包结果缺 resources/ 时必须判红')
    check(
      brokenProblems.some((p) => p.includes('resources/')),
      '可伪证性：判红理由必须点名 resources/'
    )
    if (isWindows) {
      check(
        brokenProblems.some((p) => p.includes('WebView2Loader.dll')),
        '可伪证性：解包结果缺 WebView2Loader.dll 时必须判红'
      )
    }

    // 3f) 🔴 发布门禁守卫：manifest 缺 `runtimeFiles` 必须**判红**，而不是静默
    //     跳过内容校验。
    //
    //   这段夹具直接复刻 2026-09-22 的事故：alpha.2 / alpha.3 的 manifest 由旧版
    //   脚本产出、不带 `runtimeFiles`，于是 `verifyDownloaded` 只比了 sha256 与
    //   大小就放行——而空壳包这两项完全自洽。
    //
    //   ⚠️ 夹具刻意用**小归档**：这条断言与体积无关，没必要付 128 MiB 的解包代价。
    //      同时必须带**正向对照**（补上 runtimeFiles 后同一份归档要通过），否则
    //      「判红」这个观测可能由无关原因满足（例如归档本身就缺文件）。
    {
      const gateSrc = join(tmp, 'gate-src')
      mkdirSync(join(gateSrc, 'resources', 'node'), { recursive: true })
      mkdirSync(join(gateSrc, 'resources', 'bin'), { recursive: true })
      mkdirSync(join(gateSrc, 'resources', 'harness', 'node_modules'), { recursive: true })
      writeFileSync(join(gateSrc, fakeExeName), Buffer.alloc(4096, 9))
      if (isWindows) writeFileSync(join(gateSrc, 'WebView2Loader.dll'), Buffer.alloc(512, 7))
      writeFileSync(join(gateSrc, 'resources', 'node', isWindows ? 'node.exe' : 'node'), Buffer.alloc(2048, 3))
      writeFileSync(join(gateSrc, 'resources', 'harness', 'node_modules', 'stub.js'), '// stub\n')

      const gateDir = join(tmp, 'gate-out')
      mkdirSync(gateDir, { recursive: true })
      const gateArchiveName = `DSH-Desktop-0.3.0-portable${archiveExtension(triple)}`
      const gateArchive = join(gateDir, gateArchiveName)
      const gateZip = spawnSync(
        'powershell',
        [
          '-NoProfile', '-NonInteractive', '-Command',
          'Compress-Archive -Path $env:DSH_GATE_SRC -DestinationPath $env:DSH_GATE_DST -Force'
        ],
        {
          env: { ...process.env, DSH_GATE_SRC: join(gateSrc, '*'), DSH_GATE_DST: gateArchive },
          stdio: 'ignore'
        }
      )
      check(
        !gateZip.error && gateZip.status === 0 && existsSync(gateArchive),
        `门禁守卫夹具：小归档必须能打出来（退出码 ${gateZip.status ?? 'n/a'}）`
      )

      // 归档自身的完整性与 manifest 必须自洽——否则下面两条断言会被无关问题污染。
      const gateHash = sha256File(gateArchive)
      const gateBytes = statSync(gateArchive).size
      writeFileSync(join(gateDir, `${gateArchiveName}.sha256`), sidecarText(gateHash, gateArchiveName), 'utf8')
      const gateBase = {
        kind: 'dsh-desktop-portable',
        version: '0.3.0',
        triple,
        archive: gateArchiveName,
        sidecar: `${gateArchiveName}.sha256`,
        sha256: gateHash,
        archiveBytes: gateBytes,
        source: fakeExeName
      }

      // 反向：旧形状（无 runtimeFiles）必须判红，且理由必须点名该字段。
      const legacyManifestPath = join(gateDir, 'legacy.manifest.json')
      writeFileSync(legacyManifestPath, `${JSON.stringify(gateBase, null, 2)}\n`, 'utf8')
      const legacyGate = verifyDownloaded({ dir: gateDir, manifestPath: legacyManifestPath })
      check(
        legacyGate.problems.some((p) => p.includes('runtimeFiles')),
        '门禁守卫：manifest 缺 runtimeFiles 时必须判红并点名该字段（否则空壳包会静默通过）'
      )

      // 正向：同一份归档补上 runtimeFiles 后必须通过——证明上一条的判红来自
      // 「字段缺失」本身，而不是归档别的毛病。
      const fullManifestPath = join(gateDir, 'full.manifest.json')
      writeFileSync(
        fullManifestPath,
        `${JSON.stringify({ ...gateBase, runtimeFiles: dirStats(join(gateSrc, 'resources')).files }, null, 2)}\n`,
        'utf8'
      )
      const fullGate = verifyDownloaded({ dir: gateDir, manifestPath: fullManifestPath })
      check(
        fullGate.problems.length === 0,
        `门禁守卫：补上 runtimeFiles 的同一归档必须通过（实际问题：${fullGate.problems.join('；')}）`
      )
    }

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
    //
    // ⚠️ 夹具不能拿 `tauri-release/resources`：`findAppExe` 曾会**递归**命中
    //    `resources/node/node.exe` 并把它当成应用主程序，于是「没有 exe」
    //    这一前提根本不成立。`findAppExe` 现已跳过 `resources/`，这里同时
    //    钉住「不该把内置 Node 当应用主程序」这条不变量。
    const noExeDir = join(tmp, 'release-no-exe')
    mkdirSync(join(noExeDir, 'resources', 'harness'), { recursive: true })
    writeFileSync(join(noExeDir, 'resources', 'MANIFEST.json'), '{}')
    writeFileSync(join(noExeDir, 'resources', 'harness', 'harness-node-entry.mjs'), '// stub\n')
    let threwNoExe = false
    let noExeMessage = ''
    try {
      packagePortable({ bundleDir: noExeDir, outDir: join(tmp, 'out3'), triple, version: '0.3.0' })
    } catch (error) {
      threwNoExe = true
      noExeMessage = error.message
    }
    check(threwNoExe, '可伪证性：输入目录没有 exe 时必须抛错')
    check(
      noExeMessage.includes('找不到 .exe'),
      `可伪证性：没有 exe 时的报错必须点名这一点（实际：${noExeMessage.split('\n')[0]}）`
    )

    // 5b) 🔴 结构性守卫：`inspectBundleDir` 返回**封装对象**而非数组。
    //
    //     这条断言的存在理由是一次真实事故：前置守卫曾写成
    //     `if (inspectBundleDir(...).length > 0) throw`，而该函数返回
    //     `{ problems, runtime }`，于是 `undefined > 0` 恒为 false —— 守卫
    //     **从未触发过一次**，而代码看起来完全正常、没有任何报错。
    //
    //     这里把「返回形状」本身钉死：万一以后有人把它改成返回裸数组，
    //     或把调用方又改回读 `.length`，这条断言会立刻变红。
    const shapeProbe = inspectBundleDir({
      appDir: join(tmp, 'release-shape-probe'),
      exeName: fakeExeName,
      triple
    })
    check(
      !Array.isArray(shapeProbe) && Array.isArray(shapeProbe.problems),
      '结构性守卫：inspectBundleDir 必须返回 { problems, runtime } 封装对象（读 .length 会静默失效）'
    )
    check(
      shapeProbe.length === undefined,
      '结构性守卫：封装对象本身不得带 length——存在的话说明形状被改动，调用方的判据需要同步复核'
    )
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

  --bundle-dir   tauri build 的输出目录（通常为 target/release），内含 .exe、
                 resources/ 与根目录旁的运行期依赖（WebView2Loader.dll）
  --out          产物目录，默认 dist/portable
  --version      版本号，省略时读 package.json
  --verify-download  核验下载回来的归档 / 边车与 manifest 是否一致，并解包
                 复检运行时树与旁挂依赖是否齐全`)
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
  console.log(
    `   运行时：${result.runtime.files} 个文件 / ${(result.runtime.bytes / 1024 / 1024).toFixed(1)} MiB`
  )
  if (result.manifest.sidecarFiles.length > 0) {
    console.log(`   旁挂依赖：${result.manifest.sidecarFiles.join('、')}`)
  }
  if (result.verify.length > 0) {
    // 回读校验失败必须是**硬失败**：原先只打印一行 ⚠️ 就 exit 0，残缺包据此
    // 一路通过发布门禁。现在直接抛错，让 CI 与本地一视同仁地变红。
    throw new Error(`回读校验失败（产物不可分发）：\n  - ${result.verify.join('\n  - ')}`)
  }
  console.log(`   ✅ 回读校验通过（exe + 运行时树 + 旁挂依赖齐全）`)
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
