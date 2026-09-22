import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// 兄弟模块的加载：逐个独立降级（2026-09-22）
// ---------------------------------------------------------------------------
//
// # 为什么这三条不能写成顶层静态 `import`（曾经就是，这是修掉的缺陷 1）
//
// ESM 的**静态导入是整图求值**：模块图里任何一个模块解析失败（文件缺失、语法
// 错误、依赖链断裂），整个图都不执行——不是「那个模块失效」，而是**本入口文件
// 一行都不跑**。本文件又是 Harness 的进程入口，于是后果是：
//
//   · 进程直接以模块解析错误退出；
//   · 下面两个 `uncaughtException` / `unhandledRejection` 处理器**从未注册**；
//   · 因此 `[dsh-plugin-fault]` 归因**恒不产出一行**——它恰恰在「插件把进程
//     搞坏」这类最需要它的现场里最先失效。
//
// 这不是假想：2026-09-22 的装机日志开头就是 2 次 `ERR_MODULE_NOT_FOUND`，而全
// 678 行日志里 `[dsh-plugin-fault]` 出现 0 次。
//
// 改动只做一件事：把「三个兄弟模块都必须在位」降级成「各自尽力而为」。每个模块
// 单独 `await import()` + 独立 `try/catch`，失败只损失那一项能力，并在 stderr 上
// 留下可归因的一行。注意这与 `scripts/verify-harness-entry.mjs` 的
// `siblingModuleImports()` 检查**不冲突**：门禁仍然要求产物里真的存在这三个文件，
// 这里防的是「产物缺文件时的行为」，不是「允许产物缺文件」。
//
// 用 `await import()` 也是必需的：静态 `import` 语句会被提升到文件最前面执行，
// 放在 `try` 块里也拦不住它的失败。

/**
 * 动态加载一个可选兄弟模块，失败时降级并**留下证据**。
 *
 * @param {object} options
 * @param {string} options.specifier 相对本文件的模块路径。
 * @param {string} options.label 面向日志的能力名（不是文件名——用户要看的是
 *   「丢了什么能力」，例如 `plugin safety guards`）。
 * @returns {Promise<object|null>} 模块命名空间；加载失败为 `null`。
 */
async function loadSiblingModule({ specifier, label }) {
  try {
    return await import(specifier)
  } catch (error) {
    // 写入 stderr 而非 stdout：这两个流在壳里分别进 `desktop.log` 的不同档位，
    // 归因信息跟其它 `[harness-node]` 报告走同一条流，便于一起看。
    report(
      `optional module unavailable (${label})`,
      `${specifier}: ${error?.message ?? error}`
    )
    return null
  }
}

function report(label, value) {
  process.stderr.write(`[harness-node] ${label}: ${value}\n`)
}

// 三项能力按「坏了之后后果多严重」排序加载，仅为了日志可读性：
//   1. windowsHide —— Windows 上每个子进程都会弹黑框抢焦点（用户可感知）；
//   2. 插件故障归因 —— 崩溃时的可观测性（本次修的缺陷 3）；
//   3. macOS 孤儿看门狗 —— 仅 darwin 生效。
const childProcessHideModule = await loadSiblingModule({
  specifier: './windows-child-process-hide.mjs',
  label: 'windowsHide enforcement',
})

// 只取用故障归因格式化：本进程需要的是「把 uncaughtException / unhandledRejection
// 归类成 [dsh-plugin-fault] 并写日志」这一项能力。
//
// `installPluginSafetyGuards` 现在**只返回这一项**：进程外插件沙箱
// （`PluginWorkerClient` + `plugin-worker-host.mjs`）已于 2026-09-10 随批次 F
// 「冻结并归档」整体移除——它从未接线，也不在真实插件挂载路径上（真实挂载
// 发生在 Harness 进程内的官方 Cordis 体系）。理由与决策记录见
// `build/plugin-safety-guard.mjs` 的文件头说明。
//
// 该模块缺失时 `formatFaultDetails` 为 `null`，下面的异常处理器退化成「只有原始
// 堆栈、没有归因」。可观测性降级，但**入口本身照常启动**——这正是本节的目的。
const pluginSafetyGuardModule = await loadSiblingModule({
  specifier: './plugin-safety-guard.mjs',
  label: 'plugin fault attribution',
})
const formatFaultDetails =
  typeof pluginSafetyGuardModule?.installPluginSafetyGuards === 'function'
    ? pluginSafetyGuardModule.installPluginSafetyGuards().formatFaultDetails
    : null

const parentDeathWatchdogModule = await loadSiblingModule({
  specifier: './parent-death-watchdog.mjs',
  label: 'macOS parent-death watchdog',
})

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

/**
 * 把异常归类成 `[dsh-plugin-fault]` 行；归因模块缺失时静默跳过。
 *
 * 归因是**锦上添花**：拿不到就只打原始堆栈，绝不能让「归因不可用」升级成
 * 「异常处理器也抛错」——那会把 uncaughtException 变成二次崩溃。
 *
 * @param {unknown} error 捕获到的异常或拒绝原因。
 * @returns {void}
 */
function reportFaultAttribution(error) {
  if (typeof formatFaultDetails !== 'function') {
    return
  }
  const fault = formatFaultDetails(error)
  if (fault) {
    process.stderr.write(`[dsh-plugin-fault] ${fault}\n`)
  }
}

process.on('uncaughtException', (error) => {
  reportFaultAttribution(error)
  report('uncaught exception', error?.stack ?? error)
})
process.on('unhandledRejection', (error) => {
  reportFaultAttribution(error)
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
  if (typeof childProcessHideModule?.enforceWindowsChildProcessHide === 'function') {
    childProcessHideModule.enforceWindowsChildProcessHide(childProcess, syncBuiltinESMExports)

    process.stdout.write('[harness-node] windowsHide enforcement enabled for child processes\n')
  } else {
    // 不静默：这项失效用户在 Windows 上会**看见**（子进程控制台窗口抢焦点），
    // 但几乎不可能自己联想到「壳里少了个模块」。日志里留一行，让它可归因。
    report(
      'degraded',
      'windowsHide enforcement unavailable; child processes will show console windows'
    )
  }
}

// Parent-death watchdog — macOS only（风险 R-7）。
//
// macOS 没有 PR_SET_PDEATHSIG 等价物，宿主被杀后本进程会成为孤儿。看门狗补上
// 这一环；它与 mock 入口**共用同一实现**（`parent-death-watchdog.mjs`），
// 因此故障注入测到的就是真实行为。详见该模块文件头（含两个踩过的坑）。
//
// 只在 darwin 上装：该模块在其它平台是 no-op，但**模块缺失**的降级日志不该在
// Windows/Linux 上制造噪音——那里的用户读到「看门狗不可用」会以为出了问题。
if (process.platform === 'darwin') {
  if (typeof parentDeathWatchdogModule?.installParentDeathWatchdog === 'function') {
    parentDeathWatchdogModule.installParentDeathWatchdog({ label: 'harness-node' })
  } else {
    report(
      'degraded',
      'parent-death watchdog unavailable; a killed host may leave an orphan Harness process'
    )
  }
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
