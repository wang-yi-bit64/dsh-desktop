#!/usr/bin/env node
/**
 * verify-harness-entry.mjs — 壳入口与上游 `dsh` CLI 的**调用约定兼容**守卫。
 *
 * ## 为什么存在（2026-09-12，0.1.5-rc.1 升级实测）
 *
 * 本仓的 `build/harness-node-entry.mjs` 是 **import** 上游 `@deepseek-ai/dsh/lib/bin.js`
 * 的包装器——它必须先进程内装好 windowsHide 补丁、plugin safety guard 与 cold-start
 * 投影，再去加载 CLI。这个模式在 alpha.4 上成立，因为当时 `bin.js` 是**顶层自执行**。
 *
 * 0.1.5-rc.1 把 CLI 重构成：
 *
 * ```js
 * async function runCli() { … }
 * if (import.meta.main) await runCli();   // ← 只有「作为直接入口」才执行
 * export { runCli };
 * ```
 *
 * 于是 `import` 它时 `import.meta.main` 恒为 false，**CLI 从不运行**，进程静默以
 * 退出码 0 结束。表现极具误导性：资源组装 14/14 成功、入口 import 无异常、
 * 日志只到 `DSH entry loaded` 就断，而 smoke 报的是「就绪超时」——完全指不到真因。
 *
 * 修法是入口在 import 之后显式调用导出的 `runCli()`（对旧版无副作用，因为旧版
 * 没有该导出）。**本脚本把这条兼容处理钉住**，防止它被误删或被「简化」回去。
 *
 * ## 检查项
 *
 * | 编号 | 检查 | 级别 |
 * |------|------|------|
 * | E1 | 入口持有 import 结果并使用（不再丢弃返回值） | 错误 |
 * | E2 | 入口含 `runCli` 兼容调用（`typeof … runCli === 'function'` + 调用） | 错误 |
 * | E3 | 入口仍以动态 `import(pathToFileURL(dshEntryPath))` 加载 CLI | 错误 |
 * | E4 | macOS 父死看门狗仍在（R-7 的 PDEATHSIG 等价物，见 build/harness-node-entry.mjs） | 错误 |
 *
 * ## 可证伪性
 *
 * `--self-test` 把**修复前**的入口片段（`await import(...)` 后直接结束）当夹具，
 * 断言 E2 必须报红；把修复后的片段当夹具，断言必须通过。若有人弱化判定，
 * 自检即失败。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-harness-entry.mjs
 * node scripts/verify-harness-entry.mjs --self-test
 * ```
 *
 * 退出码：`0` 通过 · `1` 检查失败或自检失败。
 */

import { readFileSync } from 'node:fs'
import { argv, exit } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entryPath = join(projectRoot, 'build', 'harness-node-entry.mjs')

/**
 * 判定入口源码是否做了 `runCli` 兼容调用（纯函数，便于自检）。
 *
 * @param {string} text 入口源码
 * @returns {{e1:boolean, e2:boolean, e3:boolean, missing:string[]}}
 */
export function auditEntry(text) {
  const src = String(text ?? '')
  // E1：动态 import 的返回值被接住（`const x = await import(...)`），而不是直接 `await import(...)`。
  const capturesImport = /(?:const|let|var)\s+\w+\s*=\s*await\s+import\s*\(/.test(src)
  // E2：既有「是函数」判断，又真的调用了 `.runCli()`。
  const checksRunCli = /typeof\s+\w+\??\.\s*runCli\s*===\s*['"]function['"]/.test(src)
  const callsRunCli = /\.\s*runCli\s*\(\s*\)/.test(src)
  // E3：仍用 pathToFileURL(dshEntryPath) 动态加载上游 CLI。
  const dynamicLoad = /import\s*\(\s*pathToFileURL\s*\(\s*dshEntryPath\s*\)/.test(src)
  // E4：macOS 父死看门狗（R-7 的可移植补法）。三条特征同时具备才算通过：
  //   ① 平台判断（darwin / 强制开关）；② 用 `process.ppid` 拿到被监视的父 pid；
  //   ③ 轮询定时器**没有 unref**——unref 的定时器在事件循环闲置时不会触发，
  //      而 Harness 大部分时间正是闲置的。这是真机 CI 上第一版失效的原因，
  //      必须钉住（否则又是一个「本地看着有、真机不生效」的静默缺陷）。
  const hasPlatformGate =
    /process\.platform\s*===\s*['"]darwin['"]/.test(src) ||
    /DSH_PARENT_DEATH_WATCHDOG/.test(src)
  const readsPpid = /process\.ppid/.test(src)
  const usesSetInterval = /setInterval\s*\(/.test(src)
  // 取看门狗那一行的 unref 使用：若整份文件里 `watchdog.unref()` 存在则视为误用。
  const wrongUnref = /\bwatchdog\.unref\s*\(\s*\)/.test(src)
  const watchdog = hasPlatformGate && readsPpid && usesSetInterval && !wrongUnref

  const missing = []
  if (!capturesImport) missing.push('E1 入口未接住 import 的返回值（无法访问导出的 runCli）')
  if (!(checksRunCli && callsRunCli)) {
    missing.push(
      'E2 缺少 `runCli` 兼容调用（上游 0.1.5-rc.1+ 用 `import.meta.main` 守卫自执行，' +
        'import 时不会运行 → 进程静默退出、日志无报错）'
    )
  }
  if (!dynamicLoad) missing.push('E3 未以 `import(pathToFileURL(dshEntryPath))` 加载上游 CLI')
  if (!watchdog) {
    const why = !hasPlatformGate
      ? '缺平台判断'
      : !readsPpid
        ? '未读取 process.ppid'
        : !usesSetInterval
          ? '无轮询定时器'
          : '看门狗被 unref()——闲置时不会触发，真机上等于没有'
    missing.push(`E4 macOS 父死看门狗不可用（${why}；R-7：macOS 无 PR_SET_PDEATHSIG 等价物）`)
  }

  return { e1: capturesImport, e2: checksRunCli && callsRunCli, e3: dynamicLoad, e4: watchdog, missing }
}

/** 自检：可证伪性——修复前的入口片段必须报 E2。 */
function selfTest() {
  let failed = 0
  const check = (label, ok) => {
    if (ok) console.log(`PASS ${label}`)
    else {
      failed += 1
      console.error(`FAIL ${label}`)
    }
  }

  // 坏夹具：修复前的写法（import 后直接结束，无 runCli 调用）
  const broken = `
if (!dshEntryPath) { process.exitCode = 1 } else {
  process.argv = [process.execPath, dshEntryPath, ...dshArguments]
  try {
    await import(pathToFileURL(dshEntryPath).href)
    process.stdout.write('[harness-node] DSH entry loaded\\n')
  } catch (error) { process.exitCode = 1 }
}`
  const brokenResult = auditEntry(broken)
  check('坏夹具 → E2 报缺失', brokenResult.missing.some((m) => m.startsWith('E2')))
  check('坏夹具 → e2=false', brokenResult.e2 === false)
  // 好夹具：修复后的写法（含 macOS 父死看门狗）
  const fixed = `
if (!dshEntryPath) { process.exitCode = 1 } else {
  process.argv = [process.execPath, dshEntryPath, ...dshArguments]
  try {
    const entry = await import(pathToFileURL(dshEntryPath).href)
    if (typeof entry?.runCli === 'function') { await entry.runCli() }
    process.stdout.write('[harness-node] DSH entry loaded\\n')
  } catch (error) { process.exitCode = 1 }
}
if (process.platform === 'darwin') {
  const parentPid = process.ppid
  const parentAlive = () => { try { process.kill(parentPid, 0); return true } catch (e) { return e && e.code === 'EPERM' } }
  if (parentAlive()) {
    const watchdog = setInterval(() => { if (!parentAlive()) process.kill(process.pid, 'SIGTERM') }, 250)
  }
}`
  const fixedResult = auditEntry(fixed)
  check('好夹具 → 无缺失', fixedResult.missing.length === 0)
  check('好夹具 → e4=true', fixedResult.e4 === true)

  // 可证伪性（E4-a）：去掉看门狗，必须报 E4。
  const noWatchdog = fixed.replace(/if \(process\.platform === 'darwin'[\s\S]*$/, '')
  check('无看门狗夹具 → E4 报缺失', auditEntry(noWatchdog).missing.some((m) => m.startsWith('E4')))

  // 可证伪性（E4-b）：看门狗被 unref（真机上失效的确切原因，必须报 E4）。
  const unrefWatchdog = fixed.replace('}, 250)\n  }\n}', '}, 250)\n    watchdog.unref()\n  }\n}')
  check(
    '看门狗被 unref → E4 报缺失',
    auditEntry(unrefWatchdog).missing.some((m) => m.startsWith('E4') && m.includes('unref'))
  )

  if (failed > 0) {
    console.error(`verify-harness-entry self-test: ${failed} 项失败`)
    exit(1)
  }
  console.log('verify-harness-entry self-test: 全部通过（含修复前写法的可证伪性）')
}

/** 主流程。 */
function run() {
  let text = ''
  try {
    text = readFileSync(entryPath, 'utf8')
  } catch {
    console.error(`[verify-harness-entry] 读不到 ${entryPath}`)
    exit(1)
  }
  const result = auditEntry(text)
  console.log('[verify-harness-entry] 壳入口 ↔ 上游 CLI 调用约定')
  console.log(`  · build/harness-node-entry.mjs`)
  console.log(`  · E1 接住 import 返回值 : ${result.e1 ? 'ok' : '✗'}`)
  console.log(`  · E2 runCli 兼容调用    : ${result.e2 ? 'ok' : '✗'}`)
  console.log(`  · E3 动态加载上游 CLI   : ${result.e3 ? 'ok' : '✗'}`)
  console.log(`  · E4 macOS 父死看门狗   : ${result.e4 ? 'ok' : '✗'}`)
  console.log('')
  if (result.missing.length === 0) {
    console.log('  ✅ 入口与上游 CLI 的调用约定兼容')
    return
  }
  for (const m of result.missing) console.error(`  ❌ ${m}`)
  console.error('\n  见 scripts/verify-harness-entry.mjs 头部的「为什么存在」。')
  exit(1)
}

// ESM「主模块」判定：仅当被直接执行（而非 import）时跑 CLI。
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  if (argv.includes('--self-test')) {
    selfTest()
  } else {
    run()
  }
}
