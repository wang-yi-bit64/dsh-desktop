import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { enforceWindowsChildProcessHide } from './windows-child-process-hide.mjs'

// 在 Windows 下为子进程注入 windowsHide，避免控制台弹窗夺取焦点
if (process.platform === 'win32') {
  enforceWindowsChildProcessHide(childProcess, syncBuiltinESMExports)
  process.stdout.write('[dsh-sidecar] windowsHide enforcement active\n')
}

function report(label, value) {
  process.stderr.write(`[dsh-sidecar] ${label}: ${value}\n`)
}

process.on('uncaughtException', (error) => report('uncaught exception', error?.stack ?? error))
process.on('unhandledRejection', (error) => report('unhandled rejection', error?.stack ?? error))

process.stdout.write(
  `[dsh-sidecar] runtime node=${process.version} platform=${process.platform} arch=${process.arch}\n`
)

// 解析 DSH 内部入口路径（支持内置 bundle 优先或查找外部 node_modules）
const candidatePaths = [
  join(process.cwd(), 'harness/bin.js'),
  join(process.cwd(), 'node_modules/@deepseek-ai/dsh/bin.js'),
  join(process.cwd(), 'resources/harness/bin.js'),
]

let dshEntry = candidatePaths.find((p) => existsSync(p))

const cliArgs = process.argv.slice(2)

if (!dshEntry) {
  report('startup error', 'cannot resolve dsh internal entry, fallback to embedded harness')
} else {
  process.stdout.write(`[dsh-sidecar] loading=${dshEntry}\n`)
  process.argv = [process.execPath, dshEntry, ...cliArgs]
  try {
    await import(pathToFileURL(dshEntry).href)
    process.stdout.write('[dsh-sidecar] dsh entry loaded\n')
  } catch (error) {
    report('dsh entry failed', error?.stack ?? error)
    process.exitCode = 1
  }
}
