import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'
import { enforceWindowsChildProcessHide } from './windows-child-process-hide.mjs'
import { installPluginSafetyGuards } from './plugin-safety-guard.mjs'

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

// Parent-death watchdog — macOS only.
//
// 各平台的「父死子亡」手段（见 crates/dsh-host/src/process.rs）：
//   · Windows：Job Object（kernel 级）
//   · Linux：prctl(PR_SET_PDEATHSIG)
//   · macOS：**没有等价物**（风险 R-7）——此前只剩「进程组 + 下次启动清扫」
//
// 后果：宿主被 SIGTERM（场景 A）或被强杀（场景 B）后，Harness 仍会成为孤儿，
// 直到**下一次**冷启动才被陈旧 pidfile 清扫掉。2026-09-12 把故障注入转为
// 三平台硬门禁后，macOS 的 A/B 两项当场变红，暴露了这个长期缺口。
//
// 可移植的补法：父进程一旦死亡，本进程会被 reparent 到 launchd，`process.ppid`
// 变为 1。轮询它能以极小代价拿到 PDEATHSIG 的等价效果，而这是**我们自己的**
// 入口包装器，不必等上游。
//
// 保守约束（避免误杀正常运行的 Harness）：
//   · 只在 macOS 启用（其余平台已有内核级机制，不需要也不应加这层）；
//   · 只在「启动时父进程不是 1」（即确实是被宿主派生）时启用——否则在
//     launchd 直接拉起等场景下会立刻自杀；
//   · 间隔 500ms 且 `unref()`，不阻止事件循环退出。
if (process.platform === 'darwin' && process.ppid !== 1) {
  const initialPpid = process.ppid
  const watchdog = setInterval(() => {
    if (process.ppid !== initialPpid || process.ppid === 1) {
      process.stderr.write(
        '[harness-node] parent process exited; shutting down (macOS parent-death watchdog)\n'
      )
      clearInterval(watchdog)
      // 用 SIGTERM 走正常关闭路径，让 Harness 有机会落地状态。
      process.kill(process.pid, 'SIGTERM')
      // 兜底：若 Harness 忽略 SIGTERM，2 秒后强制退出。
      setTimeout(() => process.exit(0), 2000).unref()
    }
  }, 500)
  watchdog.unref()
}

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
