import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'
import { enforceWindowsChildProcessHide } from './windows-child-process-hide.mjs'
import { installPluginSafetyGuards } from './plugin-safety-guard.mjs'
import { installParentDeathWatchdog } from './parent-death-watchdog.mjs'

// 只取用故障归因格式化：本进程需要的是「把 uncaughtException / unhandledRejection
// 归类成 [dsh-plugin-fault] 并写日志」这一项能力。
//
// `installPluginSafetyGuards` 现在**只返回这一项**：进程外插件沙箱
// （`PluginWorkerClient` + `plugin-worker-host.mjs`）已于 2026-09-10 随批次 F
// 「冻结并归档」整体移除——它从未接线，也不在真实插件挂载路径上（真实挂载
// 发生在 Harness 进程内的官方 Cordis 体系）。理由与决策记录见
// `build/plugin-safety-guard.mjs` 的文件头说明。
const { formatFaultDetails } = installPluginSafetyGuards()

// On macOS Harness runs inside an Electron utility process (TCC responsibility
// isolation), so `process.execPath` and `argv0` point at the Electron helper
// instead of a Node binary. Plugins re-invoke the dsh CLI through the
// executable running them — dsh-market forwards `process.execArgv` with it —
// and without Node mode that child boots as an Electron app, where the leading
// `--expose-internals` shifts argv and the CLI answers "--profile <name> is
// required" instead of installing. Declaring it here, after this process has
// already parsed the Chromium switches it was launched with, marks only the
// children as Node processes. Bundled-Node hosts (Windows, Linux) skip it.
if (process.versions.electron !== undefined) {
  process.env.ELECTRON_RUN_AS_NODE = '1'
}

const [dshEntryPath, ...dshArguments] = process.argv.slice(2)

function report(label, value) {
  process.stderr.write(`[harness-node] ${label}: ${value}\n`)
}

process.on('uncaughtException', (error) => {
  const fault = formatFaultDetails(error)
  if (fault) {
    process.stderr.write(`[dsh-plugin-fault] ${fault}\n`)
  }
  report('uncaught exception', error?.stack ?? error)
})
process.on('unhandledRejection', (error) => {
  const fault = formatFaultDetails(error)
  if (fault) {
    process.stderr.write(`[dsh-plugin-fault] ${fault}\n`)
  }
  report('unhandled rejection', error?.stack ?? error)
})

process.stdout.write(
  `[harness-node] runtime node=${process.version} platform=${process.platform} arch=${process.arch}\n`
)
process.stdout.write(`[harness-node] execPath=${process.execPath}\n`)
process.stdout.write(`[harness-node] cwd=${process.cwd()}\n`)
process.stdout.write(`[harness-node] DSH_HOME=${process.env.DSH_HOME ?? ''}\n`)

// Harness and the plugins running inside it spawn their own child processes
// (pwsh, git, ripgrep, …) without windowsHide — that flag on the Harness
// process itself only hides Harness's own console, not what it goes on to
// launch. Each of those visible console windows steals foreground focus on
// Windows. Patching child_process here, before dshEntryPath loads, catches
// every spawn made anywhere in this process tree — Harness internals and
// third-party plugins alike — without needing an upstream fix in each of
// them. A caller that explicitly sets windowsHide keeps its own choice.
if (process.platform === 'win32') {
  enforceWindowsChildProcessHide(childProcess, syncBuiltinESMExports)

  process.stdout.write('[harness-node] windowsHide enforcement enabled for child processes\n')
}

// Parent-death watchdog — macOS only（风险 R-7）。
//
// macOS 没有 PR_SET_PDEATHSIG 等价物，宿主被杀后本进程会成为孤儿。看门狗补上
// 这一环；它与 mock 入口**共用同一实现**（`parent-death-watchdog.mjs`），
// 因此故障注入测到的就是真实行为。详见该模块文件头（含两个踩过的坑）。
installParentDeathWatchdog({ label: 'harness-node' })

// Materialize DSH Desktop's generation projection before any profile module
// loads. Market operations run inside a live Harness, so they deliberately
// publish only the manifest and defer both the node_modules links and
// `dsh.profile.bundles` to the next cold start (see generations/projection.mjs).
// This is that cold start: the previous Harness has exited, so nothing holds a
// handle in the profile tree, and the DSH entry below has not been imported
// yet, so no profile module is cached. Without this step a generation install
// stays "installed but never composed" across every restart.
//
// Only profiles that actually use generations are touched: with no
// `desired.json` the profile is left byte-for-byte alone. A projection failure
// is reported and stepped over — the profile as it stands is still the better
// thing to boot than nothing.
if (process.env.DSH_HOME) {
  try {
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const desired = join(process.env.DSH_HOME, 'profiles', '.generations', 'desired.json')
    if (existsSync(desired)) {
      const { projectGenerations } = await import(
        './harness/node_modules/dsh-desktop-market-installer/generations/projection.mjs'
      )
      const projected = await projectGenerations(process.env.DSH_HOME)
      process.stdout.write(
        `[harness-node] generation projection: linked=[${projected.linked.join(', ')}] ` +
          `unlinked=[${projected.unlinked.join(', ')}] bundles=[${projected.bundles.join(', ')}]\n`
      )
      // Sweep staging leftovers and generations no longer referenced by
      // desired.json. Documented as a cold-start job and safe only here, while
      // Harness is stopped; never called before, so orphan generations and
      // interrupted installs accumulated forever. Runs AFTER the projection so
      // the enabled set is already linked and cannot be swept.
      const { sweepRegistry } = await import(
        './harness/node_modules/dsh-desktop-market-installer/generations/registry.mjs'
      )
      const swept = await sweepRegistry(process.env.DSH_HOME)
      if (swept.removed.length > 0 || swept.failed.length > 0) {
        process.stdout.write(
          `[harness-node] generation sweep: removed=[${swept.removed.join(', ')}] ` +
            `failed=[${swept.failed.join(', ')}]\n`
        )
      }
    }
  } catch (error) {
    report('generation projection skipped', error?.stack ?? error)
  }
}

if (!dshEntryPath) {
  report('startup error', 'missing DSH entry path')
  process.exitCode = 1
} else {
  process.stdout.write(`[harness-node] loading=${dshEntryPath}\n`)
  process.argv = [process.execPath, dshEntryPath, ...dshArguments]
  try {
    const entry = await import(pathToFileURL(dshEntryPath).href)
    // 上游在 0.1.5-rc.1 把 `dsh` CLI 从「顶层自执行」重构成
    // `async function runCli()` + `if (import.meta.main) await runCli()`，并把它导出。
    // 本包装器是 **import** 该入口（需要在进程内先装好 windowsHide 补丁、
    // plugin safety guard 与 cold-start 投影），因此 `import.meta.main` 恒为 false
    // ——CLI 不会自执行，进程静默以退出码 0 结束（表现为「就绪超时」而日志无任何报错）。
    // 这里显式调用导出的 `runCli()`：
    //   · 0.1.5-rc.1+：导出存在 → 调用，修复上述静默退出；
    //   · 旧版（≤0.1.2-alpha.4）：入口顶层自执行、无 `runCli` 导出 → 不重复调用。
    if (typeof entry?.runCli === 'function') {
      await entry.runCli()
    }
    process.stdout.write('[harness-node] DSH entry loaded\n')
  } catch (error) {
    report('DSH entry failed', error?.stack ?? error)
    process.exitCode = 1
  }
}
