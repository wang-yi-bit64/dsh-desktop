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

// 临时目录清理是**辅助动作**：它失败绝不能否决主结论（2026-09-23 alpha.5 的真实事故——
// `finally` 里的 EACCES 冒泡，把一次通过的核验判成了发布失败）。见 remove-tree.mjs 模块文档。
import { removeTreeBestEffort } from './remove-tree.mjs'

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
 * 便携版在 `target/release/` 根目录**可能**随行分发的运行期依赖。
 *
 * 这些文件**不在 `resources/` 里**，因此不会被 `resources/*` 的拷贝覆盖——
 * 若目标工具链需要它，就必须显式 stage，否则打包静默产出一个启动即崩的空壳。
 *
 * ⚠️ 注意这里只是「**候选**清单」（staging 时按存在性拷贝、manifest 按存在性记录），
 * **不是「必需」清单**——是否**必需**由 `needsWebView2LoaderDll()` 依目标工具链判定。
 * 2026-09-23 之前这里被当作通用必需项用，导致 CI 的 MSVC 构建被误判为「产物不完整」。
 */
export const REQUIRED_SIDECAR_FILES = ['WebView2Loader.dll']

/**
 * 便携包是否**必须**随行 `WebView2Loader.dll`。
 *
 * 判据来自上游 `webview2-com-sys` 的**链接方式**（读的是它的源码，不是猜的）：
 *
 * ```rust
 * #[cfg_attr(target_env = "msvc",     link(name = "WebView2LoaderStatic", kind = "static"))]
 * #[cfg_attr(not(target_env = "msvc"), link(name = "WebView2Loader.dll"))]
 * ```
 *
 * - `-msvc`（GitHub `windows-latest` 的默认工具链）→ **静态**链接：loader 已在 exe 内部，
 *   因此**既不需要、也不会产出**这个 DLL。缺它是**正常**的。
 * - 非 msvc（如本机的 `x86_64-pc-windows-gnu`）→ **动态**链接：DLL 缺失即
 *   `0xC0000135 STATUS_DLL_NOT_FOUND`，启动即崩且不产生任何日志。
 *
 * ## 为什么必须按 `target_env` 判，不能只看「是不是 Windows」
 *
 * 原判据是 `if (isWindows) { 要求 DLL }`，即把「**GNU 才有的事实**」当成了通用前提。
 * 后果：2026-09-23 `v0.7.0-alpha.4` 发布时，CI（MSVC）上 `tauri build` 产出的
 * 是完全正确的产物，却被打包前置校验以「输入产物不完整」拒绝——
 * **一个只在本机（GNU）成立的判据，把 CI 的整条发布链路卡死了。**
 *
 * 判据必须与「谁需要它」同源，而不是与「哪个平台」同源。
 *
 * @param {string} triple 目标三元组，如 `x86_64-pc-windows-msvc`
 * @returns {boolean} 是否需要随行该 DLL
 */
export function needsWebView2LoaderDll(triple) {
  // 非 Windows 目标不涉及这个 DLL（loader 只在 Windows 上存在）。
  if (!/windows|win32/.test(String(triple))) return false
  // Windows 上：只有非 msvc（gnu / gnullvm）才是动态链接。
  return !/msvc/.test(String(triple))
}

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

  // 4) 根目录旁挂运行期依赖。**是否必需取决于目标工具链**，而不是「是 Windows 就必须有」：
  //    msvc 静态链接 loader（既不需要、也不会产出这个 DLL）；gnu / gnullvm 动态链接，缺了即崩。
  //    详见 needsWebView2LoaderDll() 的注释与 2026-09-23 的发布事故。
  if (needsWebView2LoaderDll(triple)) {
    for (const file of REQUIRED_SIDECAR_FILES) {
      if (!existsSync(join(appDir, file))) {
        problems.push(
          `${file} 不在 ${appDir} 根目录下——该目标（${triple}）动态链接 WebView2Loader，` +
            `它在载入期被导入，缺失会导致启动即崩（0xC0000135 STATUS_DLL_NOT_FOUND）且不产生任何日志`
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

  // 判据同 inspectBundleDir：只有动态链接 loader 的目标才要求这个 DLL。
  if (needsWebView2LoaderDll(triple)) {
    for (const file of REQUIRED_SIDECAR_FILES) {
      if (!existsSync(join(destDir, file))) {
        problems.push(`解包后缺少 ${file}（该目标动态链接 WebView2Loader，缺失则启动即崩）`)
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

// ---------------------------------------------------------------------------
// zip 条目名的分隔符：Windows PowerShell 5.1 的 `Compress-Archive` 写反斜杠
// ---------------------------------------------------------------------------

/**
 * CRC-32（IEEE 802.3）。刻意手写而不是用 `zlib.crc32`——后者要 Node ≥ 20.15，
 * 而这里只需要一个确定的行为。只服务于自测夹具。
 *
 * @param {Buffer} buf
 * @returns {number} 无符号 32 位 CRC
 */
function crc32Of(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i]
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 从尾部定位 EOCD（`0x06054b50`）。必须校验「记录 + 注释长度 == 文件长度」：
 * 否则数据区里偶然出现的同样 4 个字节会被误当成 EOCD。
 *
 * @param {Buffer} buf
 * @returns {number} EOCD 起始偏移；找不到返回 `-1`
 */
function findEndOfCentralDirectory(buf) {
  const minEocd = 22
  for (let pos = buf.length - minEocd; pos >= 0; pos -= 1) {
    if (buf.readUInt32LE(pos) !== 0x06054b50) continue
    const commentLen = buf.readUInt16LE(pos + 20)
    if (pos + minEocd + commentLen === buf.length) return pos
  }
  return -1
}

/**
 * 读 zip 的**中央目录**，返回每个条目的名字、名字字段偏移与局部头偏移。
 *
 * 为什么读中央目录而不是扫 `PK\x03\x04`：数据区里完全可能出现同样的字节序列，
 * 扫描法会把它们当成本地头，于是改坏归档。中央目录是权威索引。
 *
 * @param {Buffer} buf
 * @returns {Array<{name: string, nameOffset: number, nameLength: number, localHeaderOffset: number}>}
 */
export function readZipEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf)
  if (eocd === -1) return []
  const total = buf.readUInt16LE(eocd + 10)
  let pos = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < total; i += 1) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break
    const nameLength = buf.readUInt16LE(pos + 28)
    const extraLength = buf.readUInt16LE(pos + 30)
    const commentLength = buf.readUInt16LE(pos + 32)
    entries.push({
      name: buf.subarray(pos + 46, pos + 46 + nameLength).toString('utf8'),
      nameOffset: pos + 46,
      nameLength,
      localHeaderOffset: buf.readUInt32LE(pos + 42)
    })
    pos += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * 只取条目名（供断言使用）。
 *
 * @param {string} file
 * @returns {string[]}
 */
export function zipEntryNames(file) {
  return readZipEntries(readFileSync(file)).map((entry) => entry.name)
}

/**
 * 把 zip 里所有条目名的分隔符 `\` 规范成 `/`——**原地、定长**替换。
 *
 * ## 🔴 为什么必须在打包侧做（2026-09-23 alpha.6 实测根因）
 *
 * 归档是用 `Compress-Archive` 打的，而**同一个命令名在不同 PowerShell 上行为不同**：
 *
 * | 生产者 | 条目名 |
 * |---|---|
 * | Windows PowerShell **5.1**（runner 里的 `powershell`） | `resources\harness\a.json` ❌ |
 * | PowerShell **7.x**（`pwsh`） | `resources/harness/a.json` ✅ |
 *
 * 实测对照（本机同时有两者，同一份源目录）：5.1 产出 3/3 条含反斜杠，7.6.6 产出 0/3。
 *
 * 后果链条：Linux 的 Info-ZIP `unzip` 遇到反斜杠条目**判警并返回退出码 1**，而
 * `--verify-download` 把非 0 一律当失败 → 发布日期红在 `cli-publish`。
 * 即便它「成功」了，也只会解出字面名 `resources\harness\a.json`，随后
 * `dirStats(probeDir/resources)` 数到 0 个文件，内容校验照样红。
 *
 * 为什么潜伏这么久：**打包期的回读校验跑在 Windows 上**（`Expand-Archive` 把 `\`
 * 当分隔符，宽容），而**发布期的核验跑在 Linux 上**（`unzip` 严格）。两个平台各自
 * 看自己那一半，于是「本机/打包侧全绿、发布侧红」。这与本仓已记录过的
 * 「按宿主环境分支的断言 = 只验一半」是同一个病。
 *
 * 修在**产出侧**而不是核验侧：Release 上的归档因此变成任何标准工具都能读的形态，
 * 而不是要求每个消费方各自宽容。
 *
 * 判据做成纯函数（输入输出都是文件与字节）以便自测钉住：定长替换意味着
 * **只有名字字段里的 `0x5C` 会被改成 `0x2F`**，偏移、CRC、压缩流全部不动。
 *
 * @param {string} file zip 路径（**原地修改**）
 * @returns {{entries: number, patched: number, remaining: number}}
 *   `entries` 读到的条目数、`patched` 实际修补的条目数、`remaining` 修补后仍含
 *   反斜杠的条目数（调用方应据此硬失败）。
 */
export function normalizeZipSeparators(file) {
  const buf = readFileSync(file)
  const entries = readZipEntries(buf)
  let patched = 0
  for (const entry of entries) {
    let touched = false
    // 1) 中央目录里的名字。
    for (let i = 0; i < entry.nameLength; i += 1) {
      const at = entry.nameOffset + i
      if (buf[at] === 0x5c) {
        buf[at] = 0x2f
        touched = true
      }
    }
    // 2) 局部头里的同一个名字。长度必然相同（zip 要求两处一致），故按同一起点对齐。
    const local = entry.localHeaderOffset
    if (local + 30 <= buf.length && buf.readUInt32LE(local) === 0x04034b50) {
      const localNameLength = buf.readUInt16LE(local + 26)
      const count = Math.min(localNameLength, entry.nameLength)
      for (let i = 0; i < count; i += 1) {
        const at = local + 30 + i
        if (buf[at] === 0x5c) {
          buf[at] = 0x2f
          touched = true
        }
      }
    }
    if (touched) patched += 1
  }

  const remaining = readZipEntries(buf).filter((entry) => entry.name.includes('\\')).length
  // 没有任何改动就不写盘：避免无谓重写（幂等）。
  if (patched > 0) writeFileSync(file, buf)
  return { entries: entries.length, patched, remaining }
}

/**
 * 造一个最小但结构合法的 zip（仅用于自测夹具）。
 *
 * 刻意**不用 PowerShell 当夹具**：被怀疑的生产者不能同时充当判据的输入，
 * 否则它一变，测试就跟着变。这里用纯 Node 直写 zip 结构，任何平台都跑得出
 * 同一种字节。
 *
 * @param {Array<{name: string, data: Buffer}>} entries
 * @returns {Buffer}
 */
function buildFixtureZip(entries) {
  const parts = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const crc = crc32Of(data)

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method 0 = stored
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0x2821, 12) // mod date（任意合法值）
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    parts.push(local, data)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    // 8 flags / 10 method / 30 extraLen / 32 commentLen / 34 diskStart / 36 internalAttrs
    // 全部留 0，正是「stored、无附加字段」的合法形态。
    central.writeUInt16LE(0, 10) // mod time
    central.writeUInt16LE(0x2821, 12) // mod date（与局部头一致，避免工具抱怨非法日期）
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(0, 38) // external attrs：留 0，避免解包端纠结权限位
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)

    offset += local.length + data.length
  }

  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, eocd])
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
 * @param {object} opts
 * @param {string} opts.dir 已下载产物所在目录
 * @param {string} opts.manifestPath manifest 文件路径
 * @param {(dir: string) => {ok: boolean, error?: string}} [opts.removeTree] 临时目录清理器，
 *   默认 `removeTreeBestEffort`（永不抛）。**可注入是为了能断言**「清理失败不影响核验结论」——
 *   2026-09-23 alpha.5 的事故正是 `finally` 里的 EACCES 冒泡，把一次通过的核验判成了发布失败，
 *   并且顺带吞掉了 `problems` 的真实内容。
 * @returns {{problems: string[], manifest: object}}
 */
export function verifyDownloaded({ dir, manifestPath, removeTree = removeTreeBestEffort }) {
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
        // 🔴 曾用 `stdio: 'ignore'`：那会把**唯一能解释失败的信息**丢掉，剩下
        //    「退出码 1」这种指向不明的结论。2026-09-23 的反斜杠条目事故里，真正
        //    的原因（unzip 的告警原文）本来一句话就能说清。
        //
        //    刻意写成 `['ignore','ignore','pipe']` 而不是 `encoding: 'utf8'`（等价于
        //    pipe 三个流）：**本机 sandbox 下「stdout 被管道接管」的外部 spawn 一律
        //    报 EBUSY**（实测 `encoding:'utf8'` 与默认都失败、`['ignore','ignore','pipe']`
        //    成功），而这条核验的默认清理器断言要在本机跑得通。诊断信息在 stderr，
        //    所以只接管 stderr 就够。
        stdio: ['ignore', 'ignore', 'pipe']
      })
      if (extract.error || extract.status !== 0) {
        const stderrText = Buffer.isBuffer(extract.stderr)
          ? extract.stderr.toString('utf8')
          : String(extract.stderr ?? '')
        const detail = [
          extract.error ? `spawn ${extract.error.code ?? extract.error.message}` : null,
          stderrText.trim().split('\n').slice(0, 5).join(' / ') || null
        ]
          .filter(Boolean)
          .join('；')
        problems.push(
          `${manifest.archive} 无法解包（命令 ${spec.command}，退出码 ${extract.status ?? 'n/a'}${
            detail ? `，${detail}` : ''
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
      // 🔴 清理必须 best-effort：`finally` 里抛出的异常会**覆盖** try 块的返回值，
      // 于是「临时目录删不掉」这种与核验无关的失败，会把一次通过的核验判成发布失败，
      // 还会连带吞掉 problems 的真实内容（2026-09-23 alpha.5 的真实事故）。
      const cleanup = removeTree(probeDir)
      if (!cleanup.ok) {
        console.warn(`⚠️ 便携版核验的临时目录未能清理（不影响核验结论）：${cleanup.error}`)
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
 * `<app>.exe`、`resources/` 目录，以及 tauri-bundler 可能落在**根目录**的运行期
 * 依赖（Windows 上即 `WebView2Loader.dll`——但**只有非 msvc 目标才必需**，
 * 见 `needsWebView2LoaderDll()`）。
 *
 * 三者都进包。缺 exe 或 `resources/` 时产物在用户机器上要么启动即崩，要么
 * Harness 起不来，且都不会产生可归因的日志；而 DLL 是否可缺取决于目标 ABI，
 * **不能一概而论**。因此本函数对输入做**前置硬校验**（`inspectBundleDir`）
 * 并在打包后做**内容级回读校验**（`inspectExtractedContents`），两者的判据
 * 都必须与 `needsWebView2LoaderDll()` 同源。
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

    // 2b) 条目名分隔符规范化——**必须在打包侧做**，否则 Linux 上的核验必然红。
    //     Windows PowerShell 5.1 的 `Compress-Archive` 写的是 `\`（见
    //     `normalizeZipSeparators` 的实测对照），而 `--verify-download` 跑在 ubuntu、
    //     用的 Info-ZIP `unzip` 遇到反斜杠条目会判警并返回退出码 1。
    const normalized = normalizeZipSeparators(archive)
    if (normalized.entries === 0) {
      throw new Error(`归档里读不出任何条目（中央目录损坏或归档为空）：${archive}`)
    }
    if (normalized.remaining > 0) {
      throw new Error(
        `归档里仍有 ${normalized.remaining} 个条目名含反斜杠，规范化未完成：${archive}\n` +
          `  继续下去 Linux 的 unzip 会判警退回 1，发布会在核验阶段失败——这是硬失败，不是警告。`
      )
    }
    if (normalized.patched > 0) {
      console.log(
        `[package-portable] 已规范化 ${normalized.patched}/${normalized.entries} 个条目名的分隔符（\\ → /）` +
          `——PowerShell 5.1 的 Compress-Archive 会写成反斜杠`
      )
    }
  } finally {
    // 同上：清理失败不得否决打包结论。
    removeTreeBestEffort(stageDir)
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
      // 同上：清理失败不得否决结论。
      removeTreeBestEffort(verifyDir)
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

    // 3b) 旁挂依赖**存在时**必须真的进包（Windows）。这是 0xC0000135 缺陷的正面守卫。
    //
    //   ⚠️ 本断言用 `isWindows` 是对的，与 3c 的 `needsWebView2LoaderDll` 不冲突：
    //     它守的是「**输入里有**这个文件 ⇒ 必须被 stage 进包并记进 manifest」，
    //     这一条与「目标是否**要求**它」无关（staging 一律按存在性拷贝）。
    //     夹具由 `makeBundleFixture` 的默认 `withSidecar: true` 写入 DLL，
    //     因此在 msvc 上照样有东西可验。
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

    // 3c) 🔴 双 ABI 交叉覆盖：`WebView2Loader.dll` 的**必需性由目标工具链决定**，
    //     两个分支必须在**同一台机器上都被执行到**。
    //
    //   🔴 根因（2026-09-23，发布 `v0.7.0-alpha.4` / run 35811365755 失败）：
    //     `webview2-com-sys` 在编译期决定链接方式——
    //       `#[cfg_attr(target_env = "msvc", link(name = "WebView2LoaderStatic", kind = "static"))]`
    //       `#[cfg_attr(not(target_env = "msvc"), link(name = "WebView2Loader.dll"))]`
    //     MSVC（GitHub `windows-latest` 默认，`x86_64-pc-windows-msvc`）**静态**链接，
    //     产物根目录里**合法地没有**这个 DLL；GNU（本机 `x86_64-pc-windows-gnu`）
    //     **动态**链接，DLL 是硬需求。旧判据是 `if (isWindows) { 要求 DLL }`，把
    //     「GNU 才有的事实」当成了通用前提：它在 CI 上把一份完全正确的 MSVC 产物
    //     判成「输入产物不完整」，发布链被自家守卫卡死。
    //
    //   🔴 更关键的教训——**为什么这段必须用矩阵，而不是按宿主 triple 分支**：
    //     宿主 triple 是**环境属性**，而 CI（msvc）与本机（gnu）恰好处在两侧。
    //     若只按宿主 triple 分支，则**每个环境只验到一半**：本机永远走「要求 DLL」
    //     那一支、CI 永远走另一支，两边各自全绿——缺陷正是这样躲过了全部自测。
    //     **一条只在半数环境里被执行的断言，等于没有断言。**
    //
    //   `packagePortable` 的平台前提只看**宿主**（`process.platform !== 'win32'`），
    //     `triple` 是纯入参，因此在任意 Windows 宿主上都可以显式喂两个 triple、
    //     把两个分支都跑一遍。这样 runner 是 msvc 还是 gnu，覆盖都一样完整。
    //
    //   ⚠️ 表里的 `requiresDll` 是**硬编码的独立事实**，禁止由
    //     `needsWebView2LoaderDll()` 现算：那样判据一旦被改错，期望值会跟着一起错，
    //     两边同时变绿——又变回「测试与实现同错」的对称失效。
    const abiMatrix = [
      { label: 'msvc', triple: 'x86_64-pc-windows-msvc', requiresDll: false },
      { label: 'gnu', triple: 'x86_64-pc-windows-gnu', requiresDll: true }
    ]
    for (const { label, triple: abiTriple, requiresDll } of abiMatrix) {
      check(
        needsWebView2LoaderDll(abiTriple) === requiresDll,
        `交叉 ABI：${abiTriple} 的 DLL 必需性应为 ${requiresDll}` +
          `（上游 webview2-com-sys 按 target_env 选静态/动态链接）`
      )

      // 夹具统一是「**除 DLL 之外一切都合规**」：`withSidecar: false`。
      // 这样断言才**只**证伪「旁挂依赖该有却没有」这一支——若连体积/子树都不达标，
      // 守卫会先因别的原因判红，断言虽绿但证伪的是错误的理由。
      // 不要 filler：这条断言压根不关心归档体积，塞不可压缩数据只是白烧时间。
      const noDllDir = join(tmp, `xabi-nodll-${label}`)
      makeBundleFixture({ dir: noDllDir, triple: abiTriple, withSidecar: false, fillerBlocks: 0 })
      let accepted = null
      let rejection = ''
      try {
        accepted = packagePortable({
          bundleDir: noDllDir,
          outDir: join(tmp, `xabi-out-${label}`),
          triple: abiTriple,
          version: '0.3.0'
        })
      } catch (error) {
        rejection = error.message
      }

      if (requiresDll) {
        // ── 正向：动态链接的目标缺 DLL ⇒ 必须**拒绝打包**（而不是静默出崩包）。
        // 3c-1) 回归守卫：必须**真的**抛错，而不是只留下一条警告。
        //   这段夹具直接复刻 2026-09-22 的事故：前置守卫写了 `x.length > 0` 而
        //   `inspectBundleDir` 返回封装对象，导致抛错分支永远走不到。
        //   `rejection.includes('拒绝打包')` 进一步要求报错**来自前置校验**，
        //   否则「抛错」这个观测可能由无关环节碰巧满足。
        check(
          accepted === null,
          `${abiTriple} 动态链接 WebView2Loader，缺 DLL 时必须拒绝打包（实际未拒绝）`
        )
        check(
          rejection.includes('WebView2Loader.dll'),
          `可伪证性：拒绝理由必须点名缺失的 WebView2Loader.dll（实际：${rejection.split('\n')[0]}）`
        )
        check(
          rejection.includes('拒绝打包'),
          `回归守卫：缺 DLL 必须由**前置校验**拒绝，而非下游偶发报错（实际：${rejection.split('\n')[0]}）`
        )
      } else {
        // ── 反向：静态链接的目标**不要求** DLL ⇒ 缺 DLL 的输入必须被**接受**。
        // 3c-2) 这条断言的存在理由就是上面那次失败：判据过宽时，「拒绝」这个观测
        //   照样会被满足，光靠正向分支证明不了判据不过宽。只有把反向也钉住，
        //   判据才是**双向可证伪**的。
        //   ⚠️ 必须**真跑一次完整打包**来验证「接受」，而不是只调 `inspectBundleDir`
        //   看 problems 是否为空——唯有走完全程才能证明后续的 staging / manifest /
        //   回读校验也不会因为缺 DLL 而失败。
        check(
          accepted !== null,
          `${abiTriple} 静态链接 WebView2Loader，缺 DLL 的输入必须被接受，` +
            `不得判为「产物不完整」（实际报错：${rejection.split('\n')[0]}）`
        )
        if (accepted) {
          // 反向对照：DLL 压根不存在，就不该被记进 manifest——
          // 否则 manifest 会声称一个包里没有的文件，下游校验会自相矛盾。
          check(
            !accepted.manifest.sidecarFiles.includes('WebView2Loader.dll'),
            '反向守卫：DLL 不存在时不得写进 manifest.sidecarFiles（不得凭清单断言存在性）'
          )
          check(
            accepted.verify.length === 0,
            `反向守卫：缺 DLL 的 MSVC 包回读校验必须通过（实际：${accepted.verify.join('；')}）`
          )
        }
      }
    }

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
    //
    //   ⚠️ 本断言与 WebView2 无关，**不得**放在任何平台判据内部：它原先被嵌在
    //   `if (isWindows)` 里，纯属历史偶然（它从不依赖 Windows 语义）。
    //   平台判据包住与平台无关的断言，会让「这条断言到底在守什么」变得不可推断。
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
    // DLL 是**无条件**写进去的（不受目标 ABI 影响）：本夹具要证伪的是「运行时树
    // 不完整」，因此必须先把「旁挂依赖」这一支中和掉，否则在 gnu 目标上守卫会
    // 先因缺 DLL 判红，断言虽绿但证伪的是错误的理由。
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
    // ⚠️ 同理（见 3c 的根因说明）：这里也必须**两个 ABI 都跑**，不能按宿主
    //    triple 只走一支——宿主 triple 是环境属性，按它分支等于「每个环境只验一半」。
    //    `inspectExtractedContents` 是纯函数（`triple` 纯入参、不碰宿主），
    //    因此两个 ABI 都跑一遍的代价几乎为零，没有理由省。
    for (const { triple: abiTriple, requiresDll } of abiMatrix) {
      const namesDll = inspectExtractedContents({
        destDir: brokenExtract,
        exeName: fakeExeName,
        triple: abiTriple
      }).some((p) => p.includes('WebView2Loader.dll'))
      check(
        namesDll === requiresDll,
        requiresDll
          ? `可伪证性：解包结果缺 WebView2Loader.dll 时必须判红（${abiTriple} 动态链接）`
          : // 反向对照：不需要 DLL 的目标，缺 DLL **不得**成为判红理由，
            // 否则 MSVC 发布链会被自家守卫拦死（正是 35811365755 的失败形态）。
            `反向守卫：${abiTriple} 不要求 WebView2Loader.dll，解包结果缺它不得判红`
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

      // 🔴 2026-09-23 alpha.5 事故的回归守卫：**清理临时目录失败不得否决核验结论**。
      // 那次 `finally` 里的 `rmSync` 报 `EACCES … unlink '…/resources/harness/node_modules'`
      // 冒泡出去，把一次**通过**的核验判成了发布失败，还顺带吞掉了 problems 的真实内容。
      // 这里注入一个「永远失败」的清理器，结论必须与正常路径**逐字一致**。
      // 可伪证性：若实现让清理异常冒泡，这一行会**直接抛错**——自测当场判红。
      const noisyGate = verifyDownloaded({
        dir: gateDir,
        manifestPath: fullManifestPath,
        removeTree: () => ({ ok: false, error: 'simulated EACCES: permission denied' })
      })
      check(
        JSON.stringify(noisyGate.problems) === JSON.stringify(fullGate.problems),
        '门禁守卫：清理临时目录失败时核验结论必须逐字不变（2026-09-23 alpha.5 事故会在这里判红）'
      )
      // 反向：默认清理器下必须仍然通过——否则上面那条「一致」可能只是两条路径都失败而已。
      const cleanGate = verifyDownloaded({ dir: gateDir, manifestPath: fullManifestPath })
      check(
        cleanGate.problems.length === 0,
        `门禁守卫：默认清理器下核验必须通过（实际问题：${cleanGate.problems.join('；')}）`
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

  // 6) zip 条目名分隔符：PowerShell 5.1 的 `Compress-Archive` 写 `\`，必须被规范成 `/`。
  //
  //    这条是 2026-09-23 alpha.6 发布失败（`cli-publish` 里 `unzip` 退出码 1）的回归钉。
  //    夹具用**纯 Node** 直写 zip 结构，不拿 PowerShell 当输入——被怀疑的生产者不能
  //    同时充当判据的输入，否则它一变测试就跟着变（对称失效）。
  {
    const zipTmp = mkdtempSync(join(tmpdir(), 'dsh-zip-sep-'))
    try {
      const target = join(zipTmp, 'bs.zip')
      writeFileSync(
        target,
        buildFixtureZip([
          { name: 'resources\\harness\\a.json', data: Buffer.from('{}') },
          { name: 'resources\\node_modules\\pkg\\index.js', data: Buffer.from('x') },
          { name: 'app.exe', data: Buffer.from('BIN') }
        ])
      )
      const before = readFileSync(target)
      check(
        zipEntryNames(target).includes('resources\\harness\\a.json'),
        '分隔符夹具：自造 zip 必须真的含反斜杠条目（否则后面几条断言会白过）'
      )

      const result = normalizeZipSeparators(target)
      check(result.entries === 3, `分隔符规范化：应读到 3 个条目，实际 ${result.entries}`)
      check(result.patched === 2, `分隔符规范化：应修补 2 个含反斜杠的条目，实际 ${result.patched}`)
      check(result.remaining === 0, '分隔符规范化：完成后不得残留反斜杠条目')

      const names = zipEntryNames(target)
      check(names.includes('resources/harness/a.json'), '分隔符规范化：名字必须变成正斜杠形态')
      check(
        names.includes('resources/node_modules/pkg/index.js'),
        '分隔符规范化：多级名字必须整体规范化（不能只改第一处）'
      )
      check(names.includes('app.exe'), '分隔符规范化：本来就没有反斜杠的名字必须原样保留')

      // 定长替换：长度不变，且改动字节**恰好**是名字里的 `\`——局部头与中央目录各一份。
      //   `resources\harness\a.json` 有 2 个 + `resources\node_modules\pkg\index.js` 有 3 个
      //   = 每个名字副本 5 个；两处副本共 10 个。
      const after = readFileSync(target)
      check(after.length === before.length, '分隔符规范化：必须定长替换（文件长度不得变化）')
      const changed = []
      for (let i = 0; i < after.length; i += 1) {
        if (after[i] !== before[i]) changed.push(i)
      }
      check(changed.length === 10, `分隔符规范化：应只改 10 个字节，实际 ${changed.length}`)
      check(
        changed.every((i) => before[i] === 0x5c && after[i] === 0x2f),
        '分隔符规范化：改动的字节必须全部是 0x5C → 0x2F（不得碰数据区与 CRC）'
      )

      // 幂等：再跑一次不得改动任何东西。
      const second = normalizeZipSeparators(target)
      check(second.patched === 0, '分隔符规范化：幂等——第二次不得再修补')
      check(second.entries === 3, '分隔符规范化：第二次仍应读到 3 个条目')
      check(readFileSync(target).equals(after), '分隔符规范化：第二次运行不得改动文件')

      // 干净输入（已经是正斜杠）必须**逐字节不变**：不该有任何无谓重写。
      const cleanZip = join(zipTmp, 'clean.zip')
      writeFileSync(
        cleanZip,
        buildFixtureZip([
          { name: 'resources/harness/a.json', data: Buffer.from('{}') },
          { name: 'app.exe', data: Buffer.from('BIN') }
        ])
      )
      const cleanBefore = readFileSync(cleanZip)
      const cleanResult = normalizeZipSeparators(cleanZip)
      check(cleanResult.patched === 0, '分隔符规范化：正斜杠归档不应被判为需修补')
      check(readFileSync(cleanZip).equals(cleanBefore), '分隔符规范化：正斜杠归档必须逐字节不变')

      // 可伪证性：中央目录被破坏时必须**读不到条目**（0）并原样保留文件，
      // 交由调用方的 `entries === 0` 硬失败——而不是拿着坏索引去改归档。
      const brokenZip = join(zipTmp, 'broken.zip')
      const brokenBuf = buildFixtureZip([{ name: 'a\\b.txt', data: Buffer.from('z') }])
      brokenBuf.writeUInt32LE(0xdeadbeef, brokenBuf.length - 22)
      writeFileSync(brokenZip, brokenBuf)
      const broken = normalizeZipSeparators(brokenZip)
      check(broken.entries === 0, '可伪证性：EOCD 被破坏时必须读不到条目（0），交给调用方硬失败')
      check(readFileSync(brokenZip).equals(brokenBuf), '可伪证性：读不到条目时不得改动文件')
    } finally {
      rmSync(zipTmp, { recursive: true, force: true })
    }
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
