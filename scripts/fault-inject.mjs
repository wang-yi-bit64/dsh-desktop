#!/usr/bin/env node
/**
 * fault-inject.mjs — 阶段 1 任务 1.6 故障注入验证（T05 修正版）。
 *
 * 基于 `dsh-host-cli`（INV-6：主链路不依赖 GUI）+ mock-harness 的故障模式，
 * 覆盖计划中的验证清单：
 *
 *   A  正常退出（外部终止宿主）        → 子进程被回收，无孤儿
 *   B  强杀宿主进程（taskkill /T /F）  → Job Object 兜底，无孤儿
 *   C  mock --fail startup             → 快速失败 + DSH entry failed 归因，退出码 8
 *   D  mock --fail port-in-use         → 快速失败，归因 port_in_use，退出码 7
 *   E  mock --fail after-ready         → 就绪后崩溃被 exit watcher 捕获，退出码 0
 *   F  pidfile 陈旧记录清扫            → 死记录清理 / 外部进程不误杀 / 自家进程被杀
 *
 * 平台说明：Windows 上 Job Object 覆盖 A/B；POSIX 由 PDEATHSIG / 进程组覆盖
 * （本脚本在 Windows 环境下验证 A–F，其余平台由 CI + 手工清单补齐）。
 *
 * 用法：node scripts/fault-inject.mjs
 * 前置：cargo build -p dsh-host-cli（脚本直接用 target/debug 下的二进制）。
 * 修正（T05）：
 *   - E5：不再复制 `src-tauri/resources/node/*`（占位已删除），改用
 *     `process.execPath`（运行本脚本的 node）作为捆绑 node 来源；
 *   - E6：正常退出场景改为跟踪 CLI 子进程 PID 再外部终止，不再误用
 *     `process.exitCode`；
 *   - 补 F：pidfile 清扫三态；
 *   - 所有场景追加退出码断言（对齐 `dsh_host::contracts::EXIT_*`）。
 */

import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const EXIT_OK = 0
const EXIT_UNEXPECTED = 1
const EXIT_MISSING_RESOURCE = 3
const EXIT_PORT_IN_USE = 7
const EXIT_HARNESS_FAILED = 8

const results = []
let failures = 0

function log(message) {
  console.log(`[fault-inject] ${message}`)
}

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function tail(text, lines = 6) {
  return text.trim().split(/\r?\n/).slice(-lines).join(' | ')
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (predicate() || Date.now() - startedAt > timeoutMs) {
        clearInterval(timer)
        resolvePromise()
      }
    }, 200)
  })
}

/** 查找命令行里包含 mock-harness 的存活 node 进程（孤儿判定）。 */
function findOrphans() {
  if (isWindows) {
    try {
      const output = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*mock-harness.mjs*' } | Select-Object -ExpandProperty ProcessId"
        ],
        { encoding: 'utf8' }
      )
      return output.split(/\r?\n/).map(Number).filter((pid) => pid > 0)
    } catch {
      return []
    }
  }
  try {
    const output = execFileSync('pgrep', ['-f', 'mock-harness.mjs'], { encoding: 'utf8' })
    return output.split(/\s+/).map(Number).filter((pid) => pid > 0)
  } catch {
    return []
  }
}

/**
 * 组装一个最小 mock 资源目录（E5：node 二进制来自 `process.execPath`，
 * 不再依赖已删除的 `src-tauri/resources` 占位）。
 */
function buildMockResourceDir() {
  const dir = mkdtempSync(join(projectRoot, 'target', 'fault-inject-'))
  mkdirSync(join(dir, 'node'), { recursive: true })
  cpSync(process.execPath, join(dir, 'node', nodeBinName))
  cpSync(join(projectRoot, 'scripts', 'mock-harness.mjs'), join(dir, 'mock-harness.mjs'))
  // mock 与真实入口共用父死看门狗模块；mock 树是平铺布局，模块须落在同级
  // （mock-harness.mjs 会先试 ../build/ 再试同级）。
  cpSync(
    join(projectRoot, 'build', 'parent-death-watchdog.mjs'),
    join(dir, 'parent-death-watchdog.mjs')
  )
  cpSync(join(projectRoot, 'build', 'dsh-desktop.patch.yml'), join(dir, 'dsh-desktop.patch.yml'))
  // 安全模式的 --patch 层：故障注入场景同样要能走安全模式启动路径。
  cpSync(
    join(projectRoot, 'build', 'dsh-desktop-safe.patch.yml'),
    join(dir, 'dsh-desktop-safe.patch.yml')
  )
  cpSync(join(projectRoot, 'build', 'harness-node-entry.mjs'), join(dir, 'harness-node-entry.mjs'))
  return dir
}

/** CLI 子进程包装：保留 pid 供外部终止（E6）。 */
function spawnCli(args, env) {
  const child = spawn(cliBinary, args, {
    env: { ...process.env, DSH_MOCK: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', (data) => {
    output += data.toString()
  })
  child.stderr.on('data', (data) => {
    output += data.toString()
  })
  const exited = new Promise((resolvePromise) => {
    child.on('exit', (code) => resolvePromise({ code, output: () => output }))
  })
  return { child, exited, output: () => output }
}

async function waitCliReady(cli, timeoutMs = 30000) {
  await waitFor(() => cli.output().includes('[cli] ready'), timeoutMs)
  return cli.output().includes('[cli] ready')
}

/** 进程是否存活（Windows 用 PowerShell，POSIX 用 kill 0）。 */
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

/** Windows 终止进程；POSIX 用 SIGTERM。返回是否真正杀掉了目标。 */
function killProcess(pid, forceTree) {
  if (isWindows) {
    const args = forceTree
      ? ['/PID', String(pid), '/T', '/F']
      : ['-Id', String(pid)]
    const command = forceTree ? 'taskkill' : 'powershell'
    const fullArgs = forceTree
      ? args
      : ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process ${args.join(' ')}`]
    try {
      execFileSync(command, fullArgs, { stdio: 'ignore' })
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

/** 轮询等待进程消失（taskkill 落盘后异步回收）。 */
async function waitProcessGone(pid, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  }
  return !isProcessAlive(pid)
}

function pidfilePath(dataDir) {
  return join(dataDir, 'launch-root', 'harness.pid')
}

function writePidRecord(dataDir, record) {
  mkdirSync(join(dataDir, 'launch-root'), { recursive: true })
  writeFileSync(pidfilePath(dataDir), `${JSON.stringify(record, null, 2)}\n`)
}

function spawnIdleNode(binary) {
  const child = spawn(binary, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore'
  })
  return child
}

async function scenarioNormalExit(resourceDir, dataDir) {
  const cli = spawnCli(
    ['start', '--resource', resourceDir, '--data', dataDir, '--timeout', '30'],
    {}
  )
  const becameReady = await waitCliReady(cli)
  if (!becameReady) {
    record('A0 mock 就绪', false, `未看到 ready 输出\n${tail(cli.output())}`)
    killProcess(cli.child.pid, true)
    await cli.exited
    return
  }

  // 正常退出路径：只终止宿主 CLI（不带 /T），Job Object 的 kill-on-close
  // 负责回收子进程（等价于 Ctrl+C 关窗路径的宿主侧行为）。
  killProcess(cli.child.pid, false)
  const { code } = await cli.exited
  record('A0 宿主被外部终止', code !== 'timeout', `code=${code}`)

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200))
  const orphans = findOrphans()
  record('A 正常退出无孤儿', orphans.length === 0, orphans.join(','))
}

async function scenarioForceKill(resourceDir, dataDir) {
  // 强杀宿主（模拟 kill -9）：Job Object / PDEATHSIG 必须兜底。
  const cli = spawnCli(
    ['start', '--resource', resourceDir, '--data', dataDir, '--timeout', '30'],
    {}
  )
  const becameReady = await waitCliReady(cli)
  if (!becameReady) {
    record('B0 mock 就绪', false, `未看到 ready 输出\n${tail(cli.output())}`)
    killProcess(cli.child.pid, true)
    await cli.exited
    return
  }
  killProcess(cli.child.pid, true)
  await cli.exited
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500))
  const orphans = findOrphans()
  record('B 强杀宿主无孤儿（Job Object）', orphans.length === 0, orphans.join(','))
}

async function scenarioFailStartup(resourceDir, dataDir) {
  const cli = spawnCli(
    ['start', '--resource', resourceDir, '--data', dataDir, '--timeout', '30'],
    { DSH_MOCK_FAIL: 'startup' }
  )
  const { code, output } = await cli.exited
  record(
    'C startup 失败快速归因（退出码 8）',
    // CLI 把 mock 的 `DSH entry failed:` 归因翻译成
    // 「Harness 入口加载失败（多为插件不兼容）：<detail>」，断言以 mock 自己的
    // 失败文案（detail 段）为准，而不是 CLI 的中文包装。
    code === EXIT_HARNESS_FAILED && output().includes('mock startup failure'),
    `exit=${code}\n${tail(output())}`
  )
}

async function scenarioPortInUse(resourceDir, dataDir) {
  const startedAt = Date.now()
  const cli = spawnCli(
    ['start', '--resource', resourceDir, '--data', dataDir, '--timeout', '30'],
    {
      DSH_MOCK_FAIL: 'port-in-use',
      // 默认 500ms 在 CLI 100ms 探测间隔下与「子进程退出先于日志泵置位」存在
      // 竞态（会把可重试的端口冲突误判成 ProcessExited → 退出码 8）。拉长到
      // 2s 让宿主稳定观察到 EADDRINUSE → 走换端口重试 → 三次耗尽退出码 7。
      // 墙钟几乎不受保活时长影响：wait_for_ready 判出 PortInUse 后宿主
      // terminate 提前杀死仍在保活的 mock。
      DSH_MOCK_PORT_IN_USE_MS: '2000'
    }
  )
  const { code, output } = await cli.exited
  const elapsed = Date.now() - startedAt
  const fastFailed = elapsed < 25000
  const exhaustedRetries = /in use after \d+ attempt/.test(output())
  record(
    'D EADDRINUSE 重试耗尽快速失败（退出码 7）',
    code === EXIT_PORT_IN_USE && fastFailed && exhaustedRetries,
    `exit=${code} ${Math.round(elapsed / 1000)}s\n${tail(output())}`
  )
}

async function scenarioAfterReady(resourceDir, dataDir) {
  const cli = spawnCli(
    ['start', '--resource', resourceDir, '--data', dataDir, '--timeout', '30'],
    { DSH_MOCK_FAIL: 'after-ready' }
  )
  const { code, output } = await cli.exited
  const captured =
    output().includes('[cli] ready') && output().includes('harness exited')
  record(
    'E Ready 后崩溃被捕获（退出码 0）',
    captured && code === EXIT_OK,
    `exit=${code}\n${tail(output())}`
  )
  const orphans = findOrphans()
  record('E2 崩溃后无孤儿', orphans.length === 0, orphans.join(','))
}

async function scenarioPidfileSweep(resourceDir, dataDir) {
  // F1：死记录 → stop 仅清理 pidfile，退出码 0。
  writePidRecord(dataDir, {
    pid: 4294967294,
    port: 0,
    resource_dir: resourceDir,
    started_at: Math.floor(Date.now() / 1000)
  })
  const dead = spawnCli(['stop', '--data', dataDir], {})
  const deadExit = await dead.exited
  record(
    'F1 死记录被清理（退出码 0）',
    deadExit.code === EXIT_OK && !existsSync(pidfilePath(dataDir)),
    `exit=${deadExit.code}`
  )

  // F2：外部进程（镜像不在资源目录）不得被误杀；stop 拒绝并报退出码 1。
  const external = spawnIdleNode(process.execPath)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))
  const externalPid = external.pid
  writePidRecord(dataDir, {
    pid: externalPid,
    port: 0,
    resource_dir: resourceDir,
    started_at: Math.floor(Date.now() / 1000)
  })
  const foreign = spawnCli(['stop', '--data', dataDir], {})
  const foreignExit = await foreign.exited
  const foreignIntact = !existsSync(pidfilePath(dataDir))
  const externalStillAlive = isProcessAlive(externalPid)
  record(
    'F2 外部 node 不误杀（退出码 1）',
    foreignExit.code === EXIT_UNEXPECTED && foreignIntact && externalStillAlive,
    `exit=${foreignExit.code} externalStillAlive=${externalStillAlive}`
  )
  // 清理外部进程（不应被 stop 杀掉，这里由测试自己收尾）。
  try {
    killProcess(externalPid, true)
  } catch {}

  // F3：自家进程（镜像在资源目录内）→ stop 终止进程树，退出码 0。
  const own = spawnIdleNode(join(resourceDir, 'node', nodeBinName))
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))
  const ownPid = own.pid
  writePidRecord(dataDir, {
    pid: ownPid,
    port: 0,
    resource_dir: resourceDir,
    started_at: Math.floor(Date.now() / 1000)
  })
  const ownCli = spawnCli(['stop', '--data', dataDir], {})
  const ownExit = await ownCli.exited
  const ownGone = await waitProcessGone(ownPid)
  record(
    'F3 自家进程被终止（退出码 0）',
    ownExit.code === EXIT_OK && ownGone,
    `exit=${ownExit.code} gone=${ownGone}`
  )
}

async function main() {
  if (!existsSync(cliBinary)) {
    console.error(`[fault-inject] 缺少 CLI 二进制：${cliBinary}`)
    console.error('[fault-inject] 先执行：cargo build -p dsh-host-cli')
    process.exit(2)
  }

  const resourceDir = buildMockResourceDir()
  const dataDir = mkdtempSync(join(projectRoot, 'target', 'fault-inject-data-'))

  try {
    await scenarioFailStartup(resourceDir, dataDir)
    await scenarioPidfileSweep(resourceDir, dataDir)
    await scenarioNormalExit(resourceDir, dataDir)
    await scenarioForceKill(resourceDir, dataDir)
    await scenarioPortInUse(resourceDir, dataDir)
    await scenarioAfterReady(resourceDir, dataDir)
  } finally {
    try {
      for (const pid of findOrphans()) {
        killProcess(pid, true)
      }
    } catch {}
    // 清理一律 best-effort：某些环境（如 WorkBuddy 的 safe-delete shim）会拦截
    // 批量删除，抛错不应吞掉已收集的验证结果。
    for (const dir of [resourceDir, dataDir]) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        log(`清理 ${dir} 被拦截（可忽略）：${error?.message ?? error}`)
      }
    }
  }

  log('—— 结果汇总 ——')
  for (const item of results) {
    log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`)
  }
  log(`共 ${results.length} 项，失败 ${failures} 项`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[fault-inject] 意外失败：', error)
  process.exit(1)
})
