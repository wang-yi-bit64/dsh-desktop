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
const watchdogModulePath = join(projectRoot, 'build', 'parent-death-watchdog.mjs')
const mockHarnessPath = join(projectRoot, 'scripts', 'mock-harness.mjs')

/** 读文件，缺失返回空串（用于「模块不存在也算 E4 失败」的判定）。 */
function readFileSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 判定入口源码是否做了 `runCli` 兼容调用（纯函数，便于自检）。
 *
 * @param {string} text 入口源码
 * @param {{moduleSource?:string, mockSource?:string}} [sources] 覆盖磁盘读取
 *   （自检用；省略时读真实文件）
 * @returns {{e1:boolean, e2:boolean, e3:boolean, e4:boolean, missing:string[]}}
 */
export function auditEntry(text, sources = {}) {
  const src = String(text ?? '')
  // E1：动态 import 的返回值被接住（`const x = await import(...)`），而不是直接 `await import(...)`。
  const capturesImport = /(?:const|let|var)\s+\w+\s*=\s*await\s+import\s*\(/.test(src)
  // E2：既有「是函数」判断，又真的调用了 `.runCli()`。
  const checksRunCli = /typeof\s+\w+\??\.\s*runCli\s*===\s*['"]function['"]/.test(src)
  const callsRunCli = /\.\s*runCli\s*\(\s*\)/.test(src)
  // E3：仍用 pathToFileURL(dshEntryPath) 动态加载上游 CLI。
  const dynamicLoad = /import\s*\(\s*pathToFileURL\s*\(\s*dshEntryPath\s*\)/.test(src)
  // E4：macOS 父死看门狗（R-7）**存在且可用**。实现已抽到独立模块
  // （`build/parent-death-watchdog.mjs`），入口与 mock 共用；这里检查：
  //   ① 入口确实 import 并安装它；
  //   ② 模块自身有 darwin 开关 + 读 ppid + 轮询定时器；
  //   ③ 定时器**没有 unref**——unref 在事件循环闲置时不触发，而 Harness 大部分
  //      时间正是闲置的（真机 CI 上第一版失效的确切原因）；
  //   ④ mock-harness 也装了它——故障注入的 mock 模式**不经入口**
  //      （node_entry 被整体替换成 mock-harness.mjs），只装在入口上等于没装。
  const entryInstallsWatchdog = /installParentDeathWatchdog\s*\(/.test(src)
  const moduleSource = sources.moduleSource ?? readFileSafe(watchdogModulePath)
  // 模块判据：出现 darwin 平台门 + 读 ppid + 有轮询定时器 + 定时器未 unref。
  // 平台门不绑定写法（`process.platform === 'darwin'` 或 `platform !== 'darwin'`
  // 都算），只要求「出现 darwin 门」——具体写法由模块自身决定。
  const moduleGate = /darwin/.test(moduleSource) && /platform/.test(moduleSource)
  const modulePpid = /process\.ppid/.test(moduleSource)
  const moduleInterval = /setInterval\s*\(/.test(moduleSource)
  const moduleNoUnref = !/\.\s*unref\s*\(\s*\)/.test(moduleSource)
  const mockSource = sources.mockSource ?? readFileSafe(mockHarnessPath)
  const mockInstallsWatchdog = /installParentDeathWatchdog\s*\(/.test(mockSource)

  const missing = []
  if (!capturesImport) missing.push('E1 入口未接住 import 的返回值（无法访问导出的 runCli）')
  if (!(checksRunCli && callsRunCli)) {
    missing.push(
      'E2 缺少 `runCli` 兼容调用（上游 0.1.5-rc.1+ 用 `import.meta.main` 守卫自执行，' +
        'import 时不会运行 → 进程静默退出、日志无报错）'
    )
  }
  if (!dynamicLoad) missing.push('E3 未以 `import(pathToFileURL(dshEntryPath))` 加载上游 CLI')
  if (!entryInstallsWatchdog) {
    missing.push('E4a 入口未安装父死看门狗（`installParentDeathWatchdog()`）')
  }
  if (!(moduleGate && modulePpid && moduleInterval && moduleNoUnref)) {
    const why = !moduleGate
      ? '缺平台开关'
      : !modulePpid
        ? '未读取 process.ppid'
        : !moduleInterval
          ? '无轮询定时器'
          : '定时器被 unref()——闲置时不触发，真机上等于没有'
    missing.push(`E4b 看门狗模块不可用（${why}；见 build/parent-death-watchdog.mjs）`)
  }
  if (!mockInstallsWatchdog) {
    missing.push(
      'E4c mock-harness 未安装看门狗——故障注入的 mock 模式**不经入口**' +
        '（node_entry 被整体替换成 mock-harness.mjs），只装在入口上测不到任何东西'
    )
  }

  const e4 = entryInstallsWatchdog && moduleGate && modulePpid && moduleInterval && moduleNoUnref && mockInstallsWatchdog
  return { e1: capturesImport, e2: checksRunCli && callsRunCli, e3: dynamicLoad, e4, missing }
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

  // 好夹具：入口装看门狗 + 模块与 mock 都齐备
  const goodEntry = `
if (!dshEntryPath) { process.exitCode = 1 } else {
  process.argv = [process.execPath, dshEntryPath, ...dshArguments]
  try {
    const entry = await import(pathToFileURL(dshEntryPath).href)
    if (typeof entry?.runCli === 'function') { await entry.runCli() }
  } catch (error) { process.exitCode = 1 }
}
installParentDeathWatchdog({ label: 'harness-node' })`
  const goodModule = `
export function installParentDeathWatchdog(){
  if (process.platform !== 'darwin' && process.env.DSH_PARENT_DEATH_WATCHDOG !== '1') return false
  const parentPid = process.ppid
  setInterval(() => { process.kill(parentPid, 0) }, 250)
}`
  const goodMock = `installParentDeathWatchdog({ label: 'mock-harness' })`
  const fixedResult = auditEntry(goodEntry, { moduleSource: goodModule, mockSource: goodMock })
  check('好夹具 → 无缺失', fixedResult.missing.length === 0)
  check('好夹具 → e4=true', fixedResult.e4 === true)

  // 可证伪性（E4a）：入口不装看门狗 → 报 E4a
  const noInstall = goodEntry.replace(/installParentDeathWatchdog[\s\S]*$/, '')
  check(
    '入口未装看门狗 → E4a',
    auditEntry(noInstall, { moduleSource: goodModule, mockSource: goodMock }).missing.some((m) => m.startsWith('E4a'))
  )

  // 可证伪性（E4b）：模块给定时器加 unref（真机失效的确切原因）→ 报 E4b
  const unrefModule = goodModule.replace(
    'setInterval(() => { process.kill(parentPid, 0) }, 250)',
    'const wdRef = setInterval(() => { process.kill(parentPid, 0) }, 250); wdRef.unref()'
  )
  check(
    '看门狗被 unref → E4b',
    auditEntry(goodEntry, { moduleSource: unrefModule, mockSource: goodMock })
      .missing.some((m) => m.startsWith('E4b') && m.includes('unref'))
  )

  // 可证伪性（E4c）：mock 未装看门狗（故障注入不经入口，等于没防护）→ 报 E4c
  check(
    'mock 未装看门狗 → E4c',
    auditEntry(goodEntry, { moduleSource: goodModule, mockSource: '// nothing' })
      .missing.some((m) => m.startsWith('E4c'))
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
