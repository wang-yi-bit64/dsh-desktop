#!/usr/bin/env node
/**
 * smoke-launch.mjs — CI 分层烟雾测试（B2）。
 *
 * 无头门禁（`cargo test` / clippy / fmt）测的是**壳自己的逻辑**，它把 Harness
 * 当成黑盒派生，因此**覆盖不到 Harness 侧的行为变更或资源组装缺陷**。本脚本
 * 补上这一段：真正把运行时拉起来，看它是否就绪、是否真的在服务页面、退出后
 * 是否留下孤儿进程。
 *
 * 两层门禁：
 *
 *   L1（硬门禁，无显示器即可跑）
 *     用 `dsh-host-cli` 派生 Harness（真实组装产物，缺失时退化为 mock 资源树），
 *     断言：就绪 → HTTP 真的能取到页面 → stop 退出码 0 → 无孤儿 node。
 *
 *   L2（软门禁，需要 GUI；Linux 下自动套 xvfb-run）
 *     启动已构建的壳二进制，断言：存活满观察窗 → 被终止后无孤儿 node。
 *     二进制不存在时记为 SKIP 而非失败——PR 分支不构建产物，跳过是预期行为。
 *
 * 用法：
 *   node scripts/smoke-launch.mjs                    # L1 + L2（L2 可能 SKIP）
 *   node scripts/smoke-launch.mjs --level=1          # 只跑 L1
 *   node scripts/smoke-launch.mjs --level=2 --require-level2   # L2 缺失二进制即失败
 *   node scripts/smoke-launch.mjs --resource-mode=assembled    # 强制真实资源树
 *
 * 前置：
 *   L1 → `cargo build -p dsh-host-cli`（脚本直接用 target/debug 下的二进制）
 *   L2 → `npm run tauri build`（脚本查找 src-tauri/target/release 下的二进制）
 *
 * 退出码：0 全通过（含预期 SKIP）；1 有断言失败；2 前置缺失（CLI 二进制未构建）。
 */

import { execFileSync, spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const nodeBinName = isWindows ? 'node.exe' : 'node'

const cliBinary = join(
  projectRoot,
  'target',
  'debug',
  isWindows ? 'dsh-host-cli.exe' : 'dsh-host-cli'
)
const shellBinary = join(
  projectRoot,
  'src-tauri',
  'target',
  'release',
  isWindows ? 'dsh-desktop.exe' : 'dsh-desktop'
)
const assembledResources = join(projectRoot, 'src-tauri', 'resources')

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

/**
 * 读取 `--name=value` / `--name value` 形式的参数。
 * @param {string} name 参数名（不含 `--`）
 * @param {string} fallback 缺省值
 * @returns {string} 参数值
 */
function argValue(name, fallback) {
  const eq = argv.find((item) => item.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const index = argv.indexOf(`--${name}`)
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) {
    return argv[index + 1]
  }
  return fallback
}

const levels = (argValue('level', '1,2'))
  .split(',')
  .map((item) => Number(item.trim()))
  .filter((item) => item === 1 || item === 2)
/** `auto`：有完整组装产物就用真实的，否则退化 mock 并显式标注。 */
const resourceMode = argValue('resource-mode', 'auto')
const requireLevel2 = argv.includes('--require-level2')
const l1TimeoutSec = Number(argValue('timeout', '90'))
const l2ObserveSec = Number(argValue('observe', '15'))

// ---------------------------------------------------------------------------
// 结果收集
// ---------------------------------------------------------------------------
const results = []
let failures = 0
let skips = 0
/** 全量输出留档。这一层的失败通常只体现在日志里（就绪超时 / 取不到页面 /
 *  退出码不对），不留档就得本地复现一遍，所以整份报告落盘到 target/smoke/。 */
const transcript = []

function log(message) {
  const line = `[smoke] ${message}`
  transcript.push(line)
  console.log(line)
}

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
  const line = `  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`
  transcript.push(line)
  console.log(line)
}

function skip(name, detail) {
  skips += 1
  results.push({ name, ok: true, skipped: true, detail })
  const line = `  ⏭️  ${name}${detail ? ` — ${detail}` : ''}`
  transcript.push(line)
  console.log(line)
}

/**
 * 把完整报告写到 `target/smoke/smoke-<levels>-<platform>.log`。
 * best-effort：写日志失败不得改变门禁结论。
 * @returns {string|null} 日志路径
 */
function persistTranscript() {
  try {
    const dir = join(projectRoot, 'target', 'smoke')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `smoke-l${levels.join('')}-${process.platform}.log`)
    writeFileSync(
      target,
      `${transcript.join('\n')}\n\n${JSON.stringify({ results, failures, skips }, null, 2)}\n`
    )
    return target
  } catch {
    return null
  }
}

function tail(text, lines = 8) {
  return text.trim().split(/\r?\n/).slice(-lines).join(' | ')
}

/**
 * 轮询等待条件成立。
 * @param {() => boolean} predicate 条件
 * @param {number} timeoutMs 超时毫秒
 * @returns {Promise<boolean>} 是否在超时前成立
 */
async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
  return predicate()
}

// ---------------------------------------------------------------------------
// 进程工具
// ---------------------------------------------------------------------------

/**
 * 查找命令行匹配给定模式的存活 node 进程（孤儿判定）。
 * @param {string} pattern 命令行子串
 * @returns {number[]} 匹配到的 pid 列表
 */
function findNodeProcesses(pattern) {
  if (isWindows) {
    try {
      const escaped = pattern.replace(/'/g, "''")
      const output = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${escaped}*' } | Select-Object -ExpandProperty ProcessId`
        ],
        { encoding: 'utf8' }
      )
      return output.split(/\r?\n/).map(Number).filter((pid) => pid > 0)
    } catch {
      return []
    }
  }
  try {
    const output = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
    return output.split(/\s+/).map(Number).filter((pid) => pid > 0)
  } catch {
    return []
  }
}

/** 进程是否存活。 */
function isProcessAlive(pid) {
  if (isWindows) {
    try {
      const output = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      )
      return output.split(/\r?\n/).map(Number).some((candidate) => candidate === pid)
    } catch {
      return false
    }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 终止进程（`forceTree` 时连子进程一起）。 */
function killProcess(pid, forceTree) {
  if (!pid) return false
  if (isWindows) {
    try {
      if (forceTree) {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        execFileSync(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${pid}`],
          { stdio: 'ignore' }
        )
      }
      return true
    } catch {
      return false
    }
  }
  try {
    process.kill(pid, forceTree ? 'SIGKILL' : 'SIGTERM')
    return true
  } catch {
    return false
  }
}

/** 等待进程消失。 */
async function waitProcessGone(pid, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
  return !isProcessAlive(pid)
}

/** 派生一个进程并累积其输出。 */
function spawnCaptured(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  })
  let output = ''
  child.stdout?.on('data', (data) => {
    output += data.toString()
  })
  child.stderr?.on('data', (data) => {
    output += data.toString()
  })
  const exited = new Promise((resolvePromise) => {
    child.on('exit', (code) => resolvePromise({ code, output: () => output }))
    child.on('error', (error) =>
      resolvePromise({ code: 'spawn-error', output: () => `${output}\n${error.message}` })
    )
  })
  return { child, exited, output: () => output }
}

// ---------------------------------------------------------------------------
// 资源树准备
// ---------------------------------------------------------------------------

/**
 * 判断 `src-tauri/resources/` 是否是**可用的真实组装产物**。
 *
 * 判据刻意保守：MANIFEST.json + 内置 node + harness-node-entry.mjs 都在，才算
 * 组装完成。缺任一项时 L1 会退化到 mock 资源树，并在报告里显式标注 mode。
 * @returns {boolean} 是否可用于真实 Harness 启动
 */
function assembledResourcesReady() {
  return (
    existsSync(join(assembledResources, 'MANIFEST.json')) &&
    existsSync(join(assembledResources, 'node', nodeBinName)) &&
    existsSync(join(assembledResources, 'harness-node-entry.mjs')) &&
    existsSync(join(assembledResources, 'harness', 'node_modules'))
  )
}

/**
 * 组装一个最小 mock 资源目录，供 L1 在无真实产物时仍能验证「宿主 → 子进程 →
 * 就绪 → 关闭」这条链路（用运行本脚本的 node 顶替内置运行时）。
 * @returns {string} 资源目录路径
 */
function buildMockResourceDir() {
  const dir = mkdtempSync(join(projectRoot, 'target', 'smoke-res-'))
  mkdirSync(join(dir, 'node'), { recursive: true })
  cpSync(process.execPath, join(dir, 'node', nodeBinName))
  // mock 模式下 CLI 会把入口整体替换为 <resource_dir>/mock-harness.mjs
  // （见 dsh-host-cli 的 apply_mock_if_requested），因此它必须落在资源目录根部。
  cpSync(join(projectRoot, 'scripts', 'mock-harness.mjs'), join(dir, 'mock-harness.mjs'))
  for (const file of [
    'harness-node-entry.mjs',
    'plugin-safety-guard.mjs',
    'plugin-worker-host.mjs',
    'windows-child-process-hide.mjs',
    'dsh-desktop.patch.yml',
    'dsh-desktop-safe.patch.yml'
  ]) {
    const source = join(projectRoot, 'build', file)
    if (existsSync(source)) cpSync(source, join(dir, file))
  }
  return dir
}

// ---------------------------------------------------------------------------
// L1：无头启动链路
// ---------------------------------------------------------------------------

/**
 * 执行 L1 门禁。
 * @returns {Promise<void>}
 */
async function runLevel1() {
  log('—— L1：无头启动链路 ——')

  let resourceDir = assembledResources
  let mode = 'assembled'
  if (resourceMode === 'stub') {
    mode = 'stub'
  } else if (!assembledResourcesReady()) {
    if (resourceMode === 'assembled') {
      record(
        'L1.0 真实资源树就绪',
        false,
        'src-tauri/resources/ 不完整（MANIFEST.json / node / harness-node-entry.mjs / harness/node_modules）'
      )
      return
    }
    mode = 'stub'
  }
  if (mode === 'stub') {
    resourceDir = buildMockResourceDir()
    log('未发现完整组装产物，L1 退化到 mock 资源树（DSH_MOCK=1）')
  }
  log(`资源树 mode=${mode} dir=${resourceDir}`)

  const dataDir = mkdtempSync(join(projectRoot, 'target', 'smoke-data-'))
  const env = {
    ...process.env,
    ...(mode === 'stub' ? { DSH_MOCK: '1' } : {})
  }

  const cli = spawnCaptured(
    cliBinary,
    ['start', '--resource', resourceDir, '--data', dataDir, '--timeout', String(l1TimeoutSec)],
    { env }
  )

  try {
    const becameReady = await waitFor(() => /\[cli\] ready/.test(cli.output()), l1TimeoutSec * 1000)
    if (!becameReady) {
      record('L1.1 Harness 就绪', false, tail(cli.output()))
      killProcess(cli.child.pid, true)
      await cli.exited
      return
    }
    record('L1.1 Harness 就绪', true, mode)

    // 就绪 ≠ 真的在服务页面。这里做两级验证：
    //   a) 复用项目自己的健康判据（`dsh-host-cli probe`），而不是在 JS 里
    //      重新实现一遍——契约 C4 规定未带 token 的 `GET /` 返回 401 属正常，
    //      健康区间是 200≤status<500，自己写就容易把 401 误判成故障。
    //   b) 走完整链路取一次页面：从 CLI 转发的 harness stdout 里取契约 C3 的
    //      `dsh web: http://…/?token=…`，用该 URL 换 cookie 并断言拿到 200。
    const readyLine = cli
      .output()
      .split(/\r?\n/)
      .find((line) => /\[cli\] ready/.test(line))
    const port = Number((readyLine ?? '').match(/127\.0\.0\.1:(\d+)/)?.[1] ?? 0)

    if (!port) {
      record('L1.2 健康探测（契约 C4）', false, `无法从 ready 行解析端口：${readyLine ?? '(none)'}`)
      record('L1.3 token 兑换取页（契约 C3/C5）', false, '端口未知，无法继续')
    } else {
      const probe = spawnCaptured(
        cliBinary,
        ['probe', '--port', String(port), '--timeout', '5'],
        { env }
      )
      const probeExit = await probe.exited
      record('L1.2 健康探测（契约 C4）', probeExit.code === 0, `exit=${probeExit.code} ${tail(probeExit.output(), 2)}`)

      // 契约 C3：harness 必须把带 token 的 web URL 打到 stdout，CLI 原样转发。
      // 这条是最强的端到端断言——它同时验证了「URL 可解析」「token 可兑换
      // cookie」「页面真的能返回」三件事。
      const tokenUrl = cli
        .output()
        .match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s'"]+/)?.[0]

      if (!tokenUrl) {
        record(
          'L1.3 token 兑换取页（契约 C3/C5）',
          false,
          '未在输出中找到契约 C3 的 `dsh web: http://…/?token=…` 行'
        )
      } else {
        try {
          const response = await fetch(tokenUrl, { redirect: 'follow' })
          const body = await response.text()
          const hasCookie = /dsh-auth-/.test(response.headers.get('set-cookie') ?? '')
          record(
            'L1.3 token 兑换取页（契约 C3/C5）',
            response.ok && body.length > 0,
            `HTTP ${response.status}, ${body.length} bytes, cookie=${hasCookie ? 'dsh-auth-*' : 'none'}`
          )
        } catch (error) {
          record('L1.3 token 兑换取页（契约 C3/C5）', false, `${error?.message ?? error}`)
        }
      }
    }

    // 正常关闭路径：走 CLI 自己的 stop（等价于 GUI 退出时走的那条链路）。
    const stop = spawnCaptured(cliBinary, ['stop', '--data', dataDir], { env })
    const stopExit = await stop.exited
    record('L1.4 stop 退出码 0', stopExit.code === 0, `exit=${stopExit.code} ${tail(stopExit.output(), 3)}`)

    // CLI 的 start 在 stop 之后应自行退出；给宽限窗口避免误判。
    await waitProcessGone(cli.child.pid, 8000)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200))

    const orphanPattern = mode === 'stub' ? 'mock-harness.mjs' : 'harness-node-entry.mjs'
    const orphans = findNodeProcesses(orphanPattern)
    record('L1.5 关闭后无孤儿 node', orphans.length === 0, orphans.join(','))
  } finally {
    // 收尾只杀本次 smoke 真正可能遗留的那类进程（mock 或真实入口），
    // 不按数据目录名匹配——数据目录不出现在 node 的命令行里。
    for (const pid of findNodeProcesses(mode === 'stub' ? 'mock-harness.mjs' : 'harness-node-entry.mjs')) {
      killProcess(pid, true)
    }
    killProcess(cli.child.pid, true)
    // 失败时先把 Harness 日志搬出来再删数据目录：删除是彻底的，
    // 而「哪一条 loader entry 没起来」这类信息只存在于日志里。
    if (failures > 0) {
      const preserved = preserveHarnessLogs(dataDir)
      if (preserved) log(`已保留 Harness 日志：${preserved}`)
    }
    cleanupDirs([dataDir, ...(mode === 'stub' ? [resourceDir] : [])])
  }
}

// ---------------------------------------------------------------------------
// L2：GUI 启动链路
// ---------------------------------------------------------------------------

/**
 * 执行 L2 门禁。
 * @returns {Promise<void>}
 */
async function runLevel2() {
  log('—— L2：GUI 启动链路 ——')

  if (!existsSync(shellBinary)) {
    if (requireLevel2) {
      record('L2.0 壳二进制存在', false, `缺少 ${shellBinary}（先跑 npm run tauri build）`)
    } else {
      skip('L2.0 壳二进制存在', 'release 二进制不存在（PR 分支不构建产物，属预期 SKIP）')
    }
    return
  }
  record('L2.0 壳二进制存在', true, shellBinary)

  if (!existsSync(join(projectRoot, 'src-tauri', 'target', 'release', 'resources'))) {
    skip(
      'L2.1 GUI 启动',
      'target/release/resources 不存在；tauri build 正常时会由 bundle 步骤铺好，此处不猜测布局'
    )
    return
  }

  // Linux 无显示环境自动套 xvfb-run；依赖 runner 已安装 xvfb（见 CI workflow）。
  const needsXvfb = process.platform === 'linux' && !process.env.DISPLAY
  const command = needsXvfb ? 'xvfb-run' : shellBinary
  const args = needsXvfb ? ['-a', shellBinary] : []
  if (needsXvfb) log('未检测到 DISPLAY，使用 xvfb-run 启动')

  const before = new Set(findNodeProcesses('harness-node-entry.mjs'))
  const app = spawnCaptured(command, args, { env: process.env })

  try {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, l2ObserveSec * 1000))
    const alive = isProcessAlive(app.child.pid) && app.child.exitCode === null
    record(
      'L2.1 GUI 存活满观察窗',
      alive,
      alive ? `${l2ObserveSec}s` : `提前退出 code=${app.child.exitCode}\n${tail(app.output())}`
    )
  } finally {
    killProcess(app.child.pid, true)
    await waitProcessGone(app.child.pid, 8000)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500))

    const after = findNodeProcesses('harness-node-entry.mjs').filter((pid) => !before.has(pid))
    record('L2.2 关闭后无新增孤儿 node', after.length === 0, after.join(','))
  }
}

// ---------------------------------------------------------------------------
// 清理（best-effort）
// ---------------------------------------------------------------------------

/**
 * 删除临时目录。某些环境（如 WorkBuddy 的 safe-delete shim）会拦截批量删除，
 * 抛错不应吞掉已收集的验证结果。
 * @param {string[]} dirs 待删除目录
 * @returns {void}
 */
function cleanupDirs(dirs) {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      log(`清理 ${dir} 被拦截（可忽略）：${error?.message ?? error}`)
    }
  }
}

/**
 * 失败时把 Harness 侧日志复制到 `target/smoke/` 下落档。
 *
 * **为什么必须做**：`cleanupDirs()` 会删掉整个数据目录，而 Harness 崩溃的**唯一**
 * 细节只在 `<data>/logs/harness.log` 里。CLI 转发到 stdout 的只有一句概括，例如
 *
 *     Harness 入口加载失败（多为插件不兼容）：Error: dsh: plugin tree failed to
 *     load: failed to apply loader entry include (cordis:include): loader entries failed to apply
 *
 * ——「哪个 entry 失败了、为什么」全在 harness.log 里。失败路径销毁自己的证据，
 * 等于每次都要本地复现一遍才能定位。复制到 `target/smoke/` 后即可被 CI 的
 * `target/smoke/**` artifact 一并带走。
 *
 * @param {string} dataDir 本次 smoke 的数据目录。
 * @returns {string|null} 落档目录；无日志可复制或复制失败时为 `null`。
 */
function preserveHarnessLogs(dataDir) {
  const from = join(dataDir, 'logs')
  if (!existsSync(from)) return null
  const to = join(projectRoot, 'target', 'smoke', 'harness-logs')
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    return to
  } catch (error) {
    // 留档失败不能改变门禁结论——它只是诊断辅助。
    log(`保留 Harness 日志失败（不阻断结论）：${error?.message ?? error}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  log(`levels=${levels.join(',')} resource-mode=${resourceMode}`)

  if (levels.includes(1)) {
    if (!existsSync(cliBinary)) {
      console.error(`[smoke] 缺少 CLI 二进制：${cliBinary}`)
      console.error('[smoke] 先执行：cargo build -p dsh-host-cli')
      process.exit(2)
    }
    // 顺带记录组装产物体积，便于在 CI 日志里对照体积漂移（正常采集见
    // report-bundle-size.mjs / build job summary）。
    if (existsSync(join(assembledResources, 'MANIFEST.json'))) {
      try {
        const manifest = JSON.parse(readFileSync(join(assembledResources, 'MANIFEST.json'), 'utf8'))
        const applied = (manifest.patches ?? []).filter((item) => item.status === 'applied').length
        const total = (manifest.patches ?? []).length
        log(
          `MANIFEST: dsh=${manifest.versions?.dsh} node=${manifest.versions?.node} ` +
            `patches=${applied}/${total}${manifest.patchesStrict ? ' (strict)' : ''}`
        )
      } catch (error) {
        log(`MANIFEST 解析失败（不阻断 L1）：${error?.message ?? error}`)
      }
    }
  }

  try {
    if (levels.includes(1)) await runLevel1()
    if (levels.includes(2)) await runLevel2()
  } catch (error) {
    console.error('[smoke] 意外失败：', error)
    process.exit(1)
  }

  log('—— 结果汇总 ——')
  for (const item of results) {
    const mark = item.skipped ? 'SKIP' : item.ok ? 'PASS' : 'FAIL'
    log(`${mark}  ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
  }
  log(`共 ${results.length} 项，失败 ${failures} 项，跳过 ${skips} 项`)
  const logPath = persistTranscript()
  if (logPath) log(`报告已留档：${logPath}`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
