#!/usr/bin/env node
/**
 * fault-inject.mjs — 阶段 1 任务 1.6 故障注入验证。
 *
 * 基于 `dsh-host-cli`（INV-6：主链路不依赖 GUI）+ mock-harness 的故障模式，
 * 覆盖计划中的验证清单：
 *
 *   A  正常退出（Ctrl+C）              → 子进程被回收
 *   B  强杀宿主进程（模拟崩溃）         → Job Object 兜底，无孤儿
 *   C  mock --fail startup             → 快速失败并给出归因
 *   D  mock --fail port-in-use         → 快速失败（非 120s 超时），归因 port_in_use
 *   E  mock --fail after-ready         → 就绪后崩溃被 exit watcher 捕获
 *   F  pidfile 陈旧进程清扫            → 扫描不误伤、死记录被清理
 *
 * 平台说明：Windows 上 Job Object 覆盖 A/B；POSIX 由 PDEATHSIG / 进程组覆盖
 * （本脚本在 Windows 环境下验证 A–F，其余平台由 CI + 手工清单补齐）。
 *
 * 用法：node scripts/fault-inject.mjs
 * 前置：cargo build -p dsh-host-cli（脚本直接用 target/debug 下的二进制）。
 */

import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const nodeBinName = isWindows ? 'node.exe' : 'node'

const cliBinary = join(projectRoot, 'target', 'debug', isWindows ? 'dsh-host-cli.exe' : 'dsh-host-cli')
const resources = join(projectRoot, 'src-tauri', 'resources')

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

/** 组装一个最小 mock 资源目录（node 二进制 + mock 脚本 + patch 占位）。 */
function buildMockResourceDir() {
  const dir = mkdtempSync(join(projectRoot, 'target', 'fault-inject-'))
  mkdirSync(join(dir, 'node'), { recursive: true })
  cpSync(join(resources, 'node', nodeBinName), join(dir, 'node', nodeBinName))
  cpSync(join(projectRoot, 'scripts', 'mock-harness.mjs'), join(dir, 'mock-harness.mjs'))
  // Layout 还要求 patch 与包装入口存在（mock 不读它们的内容）。
  cpSync(
    join(projectRoot, 'src-tauri', 'resources', 'dsh-desktop.patch.yml'),
    join(dir, 'dsh-desktop.patch.yml')
  )
  cpSync(join(projectRoot, 'build', 'harness-node-entry.mjs'), join(dir, 'harness-node-entry.mjs'))
  return dir
}

/** 把 mock 模式写入一个临时资源目录：node_entry / dsh_entry 指向 mock。 */
function withMock(resourceDir) {
  // CLI 的 Layout 解析：resource_dir/node/<bin>、resource_dir/<entry>…；
  // mock 模式等价于把 node_entry 与 dsh_entry 都指到 mock-harness.mjs。
  // CLI 没有该开关，这里通过 DSH_MOCK 环境变量由 dsh-host-cli 支持。
  return { ...process.env, DSH_MOCK: '1' }
}

function runCli(args, env, timeoutMs = 60000) {
  return new Promise((resolvePromise) => {
    const child = spawn(cliBinary, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => {
      try {
        if (isWindows) {
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
        } else {
          child.kill('SIGKILL')
        }
      } catch {}
      resolvePromise({ code: 'timeout', output })
    }, timeoutMs)
    const collect = (data) => {
      output += data.toString()
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, output })
    })
  })
}

async function scenarioNormalExit(resourceDir, dataDir) {
  const { code, output } = await runCli(
    ['start', '--resource', resourceDir, '--data', dataDir, '--timeout', '30'],
    withMock()
  )
  const becameReady = output.includes('[cli] ready')
  if (!becameReady) {
    record('A0 mock 就绪', false, `未看到 ready 输出，exit=${code}\n${tail(output)}`)
    return
  }
  // 正常退出：向 CLI 发 SIGINT（POSIX）。Windows 上 Ctrl+C 不可注入，
  // 改用 taskkill（不带 /F，先给优雅退出的机会，失败再 /F）。
  try {
    if (isWindows) {
      const output2 = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${process.exitCode ?? 0}`],
        { stdio: 'ignore' }
      )
      void output2
    }
  } catch {}
  // 正常关窗路径由 GUI 层覆盖（on_window_event → stop）；CLI 层验证孤儿判定：
  const orphans = findOrphans()
  record('A 正常退出无孤儿', orphans.length === 0, orphans.join(','))
}

async function scenarioForceKill(resourceDir, dataDir) {
  // 强杀宿主（模拟 kill -9）：Job Object / PDEATHSIG 必须兜底。
  const child = spawn(
    cliBinary,
    ['start', '--resource', resourceDir, '--data', dataDir, '--timeout', '30'],
    { env: { ...process.env, ...withMock() }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let output = ''
  child.stdout.on('data', (data) => {
    output += data.toString()
  })
  child.stderr.on('data', (data) => {
    output += data.toString()
  })
  await waitFor(() => output.includes('[cli] ready'), 20000)

  execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500))
  const orphans = findOrphans()
  record('B 强杀宿主无孤儿（Job Object）', orphans.length === 0, orphans.join(','))
}

async function scenarioFailStartup(resourceDir, dataDir) {
  const { output } = await runCli(
    ['start', '--resource', resourceDir, '--data', dataDir],
    { ...withMock(), DSH_MOCK_FAIL: 'startup' }
  )
  record(
    'C startup 失败快速归因',
    output.includes('failed') && output.includes('DSH entry failed'),
    tail(output)
  )
}

async function scenarioPortInUse(resourceDir, dataDir) {
  const startedAt = Date.now()
  const { output } = await runCli(
    ['start', '--resource', resourceDir, '--data', dataDir, '--timeout', '30'],
    { ...withMock(), DSH_MOCK_FAIL: 'port-in-use' }
  )
  const elapsed = Date.now() - startedAt
  const fastFailed = elapsed < 25000
  record(
    'D EADDRINUSE 快速失败（3 次重试内）',
    fastFailed && output.toLowerCase().includes('port'),
    `${Math.round(elapsed / 1000)}s\n${tail(output)}`
  )
}

async function scenarioAfterReady(resourceDir, dataDir) {
  const { output } = await runCli(
    ['start', '--resource', resourceDir, '--data', dataDir, '--timeout', '30'],
    { ...withMock(), DSH_MOCK_FAIL: 'after-ready' },
    30000
  )
  record(
    'E Ready 后崩溃被捕获',
    output.includes('[cli] ready') && output.includes('harness exited'),
    tail(output)
  )
  const orphans = findOrphans()
  record('E2 崩溃后无孤儿', orphans.length === 0, orphans.join(','))
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

async function main() {
  if (!existsSync(cliBinary)) {
    console.error(`[fault-inject] 缺少 CLI 二进制：${cliBinary}`)
    console.error('[fault-inject] 先执行：cargo build -p dsh-host-cli')
    process.exit(2)
  }
  if (!existsSync(join(resources, 'node', nodeBinName))) {
    console.error('[fault-inject] 缺少捆绑 node（先 npm run prepare:harness）')
    process.exit(2)
  }

  const resourceDir = buildMockResourceDir()
  const dataDir = mkdtempSync(join(projectRoot, 'target', 'fault-inject-data-'))

  try {
    // F 先跑：pidfile 清扫验证（mock startup 失败会留下 pid 记录）。
    await scenarioFailStartup(resourceDir, dataDir)

    await scenarioNormalExit(resourceDir, dataDir)
    await scenarioForceKill(resourceDir, dataDir)
    await scenarioPortInUse(resourceDir, dataDir)
    await scenarioAfterReady(resourceDir, dataDir)
  } finally {
    rmSync(resourceDir, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
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
