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
 * | E5 | 入口（及其相对 import 的兄弟模块）都在四份打包清单里 | 错误 |
 * | E5d | Rust 从资源目录读的每个路径都在 `bundle.resources` 里（从两端推导） | 错误 |
 * | E6 | 看门狗清理预算（轮询+兜底）小于门禁的孤儿检查窗口 | 错误 |
 *
 * ## 为什么有 E5（2026-09-21，v0.7.0-alpha.1 安装包实测）
 *
 * 入口改成静态 import 父死看门狗之后，`build/parent-death-watchdog.mjs` **进了三份清单、
 * 漏了第四份**：`prepare-harness.mjs` 的 `copyBuildFiles()` 与 `REQUIRED_FILES` 有它、
 * `stub-tauri-resources.mjs` 有它，`tauri.conf.json` → `bundle.resources` 没有。
 * 后果是**只有安装包坏了**——本地 `resources/` 目录齐全，`npm run dev`、L1/L2 烟雾、
 * 全部静态门禁都是绿的，而装出来的应用一启动就：
 *
 * ```text
 * Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…\resources\parent-death-watchdog.mjs'
 * imported from …\resources\harness-node-entry.mjs
 * ```
 *
 * `tauri-build` 的 build.rs 只校验「每个 glob 至少匹配一个文件」，**缺条目不是错误**——
 * 它只是那一个文件不进安装包。这与 `docs/adr/024` 的依赖树瘦身事故同一形态：
 * **打包、签名、安装全部成功，只有真跑起来才发现**。
 *
 * E5 因此不看那份手抄的四次清单，而是**从入口源码自己推**：把入口的所有相对 import
 * （含被 import 模块的 import，递归）收齐，逐个要求在四份清单里出现。多一个模块、
 * 漏一处登记，这里就红——而这类漏登记**永远不会有编译错误**。
 *
 * ## 可证伪性
 *
 * `--self-test` 把**修复前**的入口片段（`await import(...)` 后直接结束）当夹具，
 * 断言 E2 必须报红；把修复后的片段当夹具，断言必须通过。若有人弱化判定，
 * 自检即失败。
 *
 * E5 同样带可证伪夹具：拿**真实发生过的那份 tauri.conf.json**（`bundle.resources`
 * 缺 `parent-death-watchdog.mjs`）当输入，断言必须报 E5；补上该条目则必须通过。
 * 少了这条，E5 就只是一段「总是为真」的装饰。
 *
 * ## 为什么还有 E6：看门狗的清理预算必须小于门禁的等待窗口
 *
 * 修好安装包缺文件之后，macOS 的 `L2.2 关闭后无新增孤儿 node` 反而转红——因为那条
 * 断言在缺文件时是**空洞通过**的（Harness 在 macOS 上根本没起来，没有进程可成孤儿）。
 * 真跑起来之后暴露的是另一件事：看门狗的清理是异步的（轮询 → SIGTERM → 兜底强退），
 * 它的最坏耗时 `POLL_INTERVAL_MS + FORCE_EXIT_MS` 当时是 1750ms，而 `fault-inject`
 * 的 B 场景杀宿主后 1500ms 就查孤儿——**常数之间对不上账，且没有任何东西会因此报错**：
 * 看门狗"有测试"、门禁"有断言"，只有真跑到 macOS 上才可能偶发一条红色。
 *
 * E6 把三处常数拉进同一次比对：看门狗模块里的两个常量、门禁脚本里的等待窗口。
 * 这条检查是纯静态的——正因为这类错配在本地任何一次运行里都不一定显形。
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
const tauriConfPath = join(projectRoot, 'src-tauri', 'tauri.conf.json')
const prepareHarnessPath = join(projectRoot, 'scripts', 'prepare-harness.mjs')
const stubResourcesPath = join(projectRoot, 'scripts', 'stub-tauri-resources.mjs')
const pathsSourcePath = join(projectRoot, 'crates', 'dsh-host', 'src', 'paths.rs')
const constantsSourcePath = join(projectRoot, 'crates', 'dsh-contracts', 'src', 'constants.rs')
const faultInjectPath = join(projectRoot, 'scripts', 'fault-inject.mjs')
const smokePath = join(projectRoot, 'scripts', 'smoke-launch.mjs')

/** 读文件，缺失返回空串（用于「模块不存在也算 E4 失败」的判定）。 */
function readFileSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 把 `bundle.resources` 里的一条 glob 转成正则（只支持 `*` 单段与 `**` 跨段，
 * 这两种是本仓出现的全部形态）。
 *
 * 支持 glob 是**故意**的：清单将来若改成 `resources/*.mjs` 这类写法，E5 要跟着
 * 继续成立，而不是因为「写法变了」就误报——一条会误报的守卫很快会被绕过。
 * @param {string} pattern 清单里的条目（如 `resources/*.mjs`）
 * @returns {RegExp} 用于匹配 `resources/<文件名>` 的正则
 */
function resourcesGlobToRegExp(pattern) {
  const body = String(pattern)
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*\*/gu, '\u0000')
    .replace(/\*/gu, '[^/]*')
    .replace(/\u0000/gu, '.*')
  return new RegExp(`^${body}$`, 'u')
}

/**
 * 收集入口源码里**相对本目录**的 import 说明符（`./x.mjs`）。
 *
 * 静态 `import … from './x.mjs'` 与动态 `await import('./x.mjs')` 都算：动态那条
 * 一旦真的执行，缺文件同样抛 `ERR_MODULE_NOT_FOUND`，没有理由区别对待。
 * 只认 `./` 开头且以 `.mjs` 结尾——`./harness/node_modules/…` 那类发布后由
 * `resources/harness/**` 覆盖，不在本检查的范围。
 * @param {string} source 模块源码
 * @returns {string[]} 去重后的兄弟模块文件名
 */
function siblingModuleImports(source) {
  const found = new Set()
  const patterns = [
    /\bfrom\s*['"]\.\/([^'"]+\.mjs)['"]/gu, // 静态 import
    /\bimport\s*\(\s*['"]\.\/([^'"]+\.mjs)['"]/gu, // 动态 import
  ]
  for (const pattern of patterns) {
    for (const match of String(source ?? '').matchAll(pattern)) {
      if (!match[1].includes('/')) found.add(match[1])
    }
  }
  return [...found]
}

/**
 * E5d 的推导：**Rust 从资源目录读什么，安装包里就必须有什么**（纯函数）。
 *
 * 判据不另立清单，而是从两侧各自的唯一产地推：
 *   1. `crates/dsh-host/src/paths.rs` 的 `Layout::resolve` 里所有
 *      `resource_dir.join(常量)` —— 这就是「运行时要读的资源」；
 *   2. `crates/dsh-contracts/src/constants.rs` 里这些常量的字面值；
 *   3. `tauri.conf.json` → `bundle.resources` 是否覆盖得到的相对路径。
 *
 * 为什么不硬编码那五六个文件名：硬编码只能守住**今天**这几个。真正会出事的是
 * 「有人加了一次 `resource_dir.join(NEW_FILE)`，却没加进打包清单」——那种改动
 * 没有编译错误，只有装出来的应用起不来（或某个功能硬失败，如安全模式缺 patch 层，
 * 而 C10 明确不做静默降级）。从两头推导才能覆盖将来新增的那一个。
 *
 * @param {object} input
 * @param {string} input.pathsSource `crates/dsh-host/src/paths.rs` 源码
 * @param {string} input.constantsSource `crates/dsh-contracts/src/constants.rs` 源码
 * @param {string[]|null} input.tauriResources `bundle.resources`
 * @returns {{needed:Array<{name:string, value:string}>, missing:string[], errors:string[]}}
 */
export function auditResourceConstants({ pathsSource, constantsSource, tauriResources }) {
  const errors = []
  if (typeof pathsSource !== 'string' || pathsSource.length === 0) {
    errors.push('E5d 读不到 crates/dsh-host/src/paths.rs')
  }
  if (typeof constantsSource !== 'string' || constantsSource.length === 0) {
    errors.push('E5d 读不到 crates/dsh-contracts/src/constants.rs')
  }
  if (!Array.isArray(tauriResources)) {
    errors.push('E5d 读不到 tauri.conf.json → bundle.resources')
  }
  if (errors.length > 0) return { needed: [], missing: [], errors }

  // ① paths.rs 里由 resource_dir 派生的常量名。
  const names = new Set()
  for (const match of pathsSource.matchAll(/resource_dir\s*\.\s*join\s*\(\s*([A-Z][A-Z0-9_]*)\s*\)/gu)) {
    names.add(match[1])
  }
  if (names.size === 0) {
    // 一条都没解析到 = 判据本身失效（改名、换成变量、正则不匹配）。
    // 静默通过比没有守卫更糟：它会让下一次漏包看起来「验过了」。
    return {
      needed: [],
      missing: [],
      errors: [
        'E5d 在 paths.rs 里没有找到任何 `resource_dir.join(常量)` —— 推导失效，' +
          '请核对 Layout::resolve 是否改了写法（此时本检查必须跟着改，不能当通过）',
      ],
    }
  }

  // ② 常量的字面值。
  const values = new Map()
  for (const match of constantsSource.matchAll(
    /pub\s+const\s+([A-Z][A-Z0-9_]*)\s*:\s*&(?:'static\s+)?str\s*=\s*"([^"]*)"\s*;/gu
  )) {
    values.set(match[1], match[2])
  }

  const needed = []
  const missing = []
  for (const name of [...names].sort()) {
    const value = values.get(name)
    if (value === undefined) {
      // 常量名在 paths.rs 用了却在 constants.rs 找不到字面值——要么它由函数生成
      // （如 node_binary_name()），要么常量搬了家。都不该静默跳过。
      errors.push(`E5d 常量 ${name} 在 paths.rs 被用于 resource_dir，但在 constants.rs 找不到其字面值`)
      continue
    }
    needed.push({ name, value })
    // 两种覆盖方式都算：
    //   · 文件常量 —— 清单里有一条命中 `resources/<value>` 本身；
    //   · 目录常量（`node` / `bin` / `harness/node_modules`）—— 清单里有一条命中
    //     它**底下**的路径（`resources/node/*`、`resources/harness/**/*`）。
    //     不能只做 `startsWith('resources/<value>/')`：`resources/harness/**/*`
    //     是以 `resources/harness/` 开头的，但覆盖的是更深一层（实测踩到过——
    //     那条字面比对会把 `harness/node_modules` 误报成「没打包」）。
    const asFile = tauriResources.some(
      (entry) => entry === `resources/${value}` || resourcesGlobToRegExp(entry).test(`resources/${value}`)
    )
    const asDirectoryPrefix = tauriResources.some((entry) => entry.startsWith(`resources/${value}/`))
    const asDirectoryGlob = tauriResources.some((entry) =>
      resourcesGlobToRegExp(entry).test(`resources/${value}/placeholder`)
    )
    if (!asFile && !asDirectoryPrefix && !asDirectoryGlob) {
      missing.push(
        `E5d Rust 侧从资源目录读 \`${value}\`（constants.rs: ${name}），` +
          '但 tauri.conf.json → bundle.resources 里没有任何条目覆盖它——' +
          '运行时读不到：入口/补丁层缺失会让应用起不来，安全模式 patch 层缺失则让' +
          '「进入安全模式」硬失败（C10：不做静默降级）'
      )
    }
  }
  return { needed, missing, errors }
}

/**
 * E6：看门狗的清理预算必须落在各个门禁的孤儿检查窗口内（纯函数）。
 *
 * 「孤儿清理是异步的」这件事在两处代码里各有一套数字：看门狗模块的
 * `POLL_INTERVAL_MS` / `FORCE_EXIT_MS`（决定多晚才真正退出），与门禁脚本里
 * 「杀完宿主等多久再查孤儿」（`fault-inject` 的 1200/1500ms、`smoke` 的轮询上限）。
 * 两套数字分处两个文件、各自看都合理，**对不上账时没有任何东西会报错**：
 * 看门狗有单测、门禁有断言，只有当真实 Harness 恰好慢于窗口时才偶发一条红色，
 * 而那条红看起来像是平台问题（2026-09-21 macOS L2.2 的实况）。
 *
 * @param {object} input
 * @param {string} input.watchdogSource `build/parent-death-watchdog.mjs` 源码
 * @param {string} input.faultInjectSource `scripts/fault-inject.mjs` 源码
 * @param {string} input.smokeSource `scripts/smoke-launch.mjs` 源码
 * @returns {{budgetMs:number|null, windows:Array<{name:string, ms:number}>, errors:string[]}}
 */
export function auditWatchdogBudget({ watchdogSource, faultInjectSource, smokeSource }) {
  const errors = []
  const readConst = (source, name) => {
    // 行尾分号可选：本仓的 .mjs 一律不写分号，而 Rust 侧/其它风格可能写。
    const match = new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)\\s*;?\\s*(?://[^\\n]*)?$`, 'mu').exec(
      String(source ?? '')
    )
    return match ? Number(match[1]) : null
  }
  const poll = readConst(watchdogSource, 'POLL_INTERVAL_MS')
  const force = readConst(watchdogSource, 'FORCE_EXIT_MS')
  if (poll === null || force === null) {
    errors.push(
      'E6 读不到看门狗的 POLL_INTERVAL_MS / FORCE_EXIT_MS —— 常数改名或不再是纯数字字面量时，' +
        '本检查必须跟着改，不能当通过（否则预算永远算不出来却看起来验过了）'
    )
    return { budgetMs: null, windows: [], errors }
  }
  const budgetMs = poll + force

  // 门禁侧的窗口：fault-inject 的两处 `await new Promise(… setTimeout(…, N))` 紧跟
  // `const orphans = findOrphans()`；smoke 的 L2.2 用 `cleanupMs >= N` 作为轮询上限。
  // 都按「杀完宿主等多久」取，不比固定写法更严（`))` 与 `)` 两种闭合都接受）。
  const windows = []
  const faultWaits = [
    ...String(faultInjectSource ?? '').matchAll(
      /setTimeout\([^,]+,\s*(\d+)\s*\)\s*\)?\s*\n\s*const orphans = findOrphans\(\)/gu
    ),
  ]
  for (const [index, m] of faultWaits.entries()) {
    windows.push({ name: `fault-inject 第 ${index + 1} 处孤儿检查`, ms: Number(m[1]) })
  }
  const smokeWait = /cleanupMs\s*>=\s*(\d+)/u.exec(String(smokeSource ?? ''))
  if (smokeWait) windows.push({ name: 'smoke L2.2 轮询上限', ms: Number(smokeWait[1]) })

  if (windows.length === 0) {
    errors.push(
      'E6 没能在门禁脚本里定位到任何孤儿检查窗口 —— 判定失效（写法变了），' +
        '请同步更新本检查而不是让它静默通过'
    )
    return { budgetMs, windows: [], errors }
  }

  for (const w of windows) {
    if (budgetMs >= w.ms) {
      errors.push(
        `E6 看门狗最坏清理预算 ${budgetMs}ms（POLL ${poll} + FORCE ${force}）≥ ${w.name} 的等待窗口 ` +
          `${w.ms}ms —— 真实 Harness 收到 SIGTERM 后不一定立刻退出，此时由兜底计时器决定退出时刻，` +
          '门禁会在清理尚未完成时判定「有孤儿」。要么调小看门狗常数，要么放宽窗口（两者都要' +
          '同步 build/parent-death-watchdog.mjs 文件头的「预算」表）'
      )
    }
  }
  return { budgetMs, windows, errors }
}

/**
 * E5：入口及其（递归的）相对 import 必须都出现在**四份**打包清单里（纯函数）。
 *
 * 这份清单是手工维护的、分布在四个文件里，因此**任何一处漏登记都不会有编译错误**：
 * `tauri-build` 的 build.rs 只要求每个 glob 至少匹配到一个文件，少一条目它不管。
 * 2026-09-21 的 v0.7.0-alpha.1 正是这样发出的——只有安装包缺文件，本地全绿。
 *
 * @param {object} input 审计输入（全部由调用方从磁盘读好，便于自检注入夹具）
 * @param {string} input.entrySource 入口源码
 * @param {(name:string)=>string} input.readModule 读 `build/<name>`（缺失返回空串）
 * @param {string[]} input.tauriResources `tauri.conf.json` → `bundle.resources`
 * @param {string} input.prepareSource `scripts/prepare-harness.mjs` 源码
 * @param {string} input.stubSource `scripts/stub-tauri-resources.mjs` 源码
 * @returns {{modules:string[], missing:string[]}}
 */
export function auditPackaging({ entrySource, readModule, tauriResources, prepareSource, stubSource }) {
  const modules = []
  const seen = new Set()
  const queue = ['harness-node-entry.mjs', ...siblingModuleImports(entrySource)]
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    modules.push(name)
    // 递归之前先确认模块真的存在：缺失由 E4/打包构建发现，不在这里重复报。
    const source = readModule(name)
    if (source) queue.push(...siblingModuleImports(source))
  }

  const missing = []
  // 四份清单的判定方式：tauri.conf.json 是 JSON（精确比对条目或 glob 命中），
  // 另三份是 JavaScript，只要求文件名作为带引号的字符串出现——它们在各自文件里
  // 的写法（copyBuildFiles 的数组、REQUIRED_FILES、assets）会随重构变动，
  // 绑定具体写法等于给将来埋一个假警报。
  if (!Array.isArray(tauriResources)) {
    // 清单读不出来是「配置被改坏」，不是「文件没登记」——分开报，免得下一个人
    // 按「补一条目」的思路去修一个 JSON 语法错误。
    missing.push('E5a 读不到 tauri.conf.json → bundle.resources（缺字段或 JSON 非法）')
    return { modules, missing }
  }
  for (const name of modules) {
    const relative = `resources/${name}`
    const covered = tauriResources.some(
      (entry) => entry === relative || resourcesGlobToRegExp(entry).test(relative)
    )
    if (!covered) {
      missing.push(
        `E5a ${relative} 不在 tauri.conf.json → bundle.resources 里——` +
          'tauri-build 只校验「glob 至少匹配一个文件」，缺条目不是错误，' +
          '它只是**不进安装包**：本地 resources/ 齐全、门禁全绿，装出来一启动就 ' +
          `ERR_MODULE_NOT_FOUND（v0.7.0-alpha.1 的真实事故）`
      )
    }
    if (prepareSource && !prepareSource.includes(`'${name}'`) && !prepareSource.includes(`"${name}"`)) {
      missing.push(
        `E5b ${name} 未登记在 scripts/prepare-harness.mjs（copyBuildFiles / REQUIRED_FILES）——` +
          '它不会被拷进 resources/，打包因此拿不到这个文件'
      )
    }
    if (stubSource && !stubSource.includes(`'${name}'`) && !stubSource.includes(`"${name}"`)) {
      missing.push(
        `E5c ${name} 未登记在 scripts/stub-tauri-resources.mjs 的 assets 里——` +
          'CI 的编译桩会少这一份，build.rs 的 glob 随之失配'
      )
    }
  }
  return { modules, missing }
}

/**
 * 判定入口源码是否做了 `runCli` 兼容调用（纯函数，便于自检）。
 *
 * @param {string} text 入口源码
 * @param {{moduleSource?:string, mockSource?:string, tauriResources?:string[],
 *   prepareSource?:string, stubSource?:string, readModule?:(name:string)=>string}} [sources]
 *   覆盖磁盘读取（自检用；省略时读真实文件）
 * @returns {{e1:boolean, e2:boolean, e3:boolean, e4:boolean, e5:boolean, missing:string[]}}
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

  // E5：入口自己的相对 import 是否都在四份打包清单里。默认读真实清单与真实
  // build/ 目录；自检通过 `tauriResources` / `prepareSource` / `stubSource` /
  // `readModule` 注入夹具。
  const tauriResources = sources.tauriResources ?? readTauriResources()
  const packaging = auditPackaging({
    entrySource: src,
    readModule: sources.readModule ?? ((name) => readFileSafe(join(projectRoot, 'build', name))),
    tauriResources,
    prepareSource: sources.prepareSource ?? readFileSafe(prepareHarnessPath),
    stubSource: sources.stubSource ?? readFileSafe(stubResourcesPath),
  })
  missing.push(...packaging.missing)

  // E5d：Rust 侧从资源目录读的每个路径也必须在打包清单里（推导，非硬编码清单）。
  const resourceConstants = auditResourceConstants({
    pathsSource: sources.pathsSource ?? readFileSafe(pathsSourcePath),
    constantsSource: sources.constantsSource ?? readFileSafe(constantsSourcePath),
    tauriResources,
  })
  missing.push(...resourceConstants.missing, ...resourceConstants.errors)

  // E6：看门狗的清理预算 vs 各门禁的孤儿检查窗口。
  const budget = auditWatchdogBudget({
    watchdogSource: moduleSource,
    faultInjectSource: sources.faultInjectSource ?? readFileSafe(faultInjectPath),
    smokeSource: sources.smokeSource ?? readFileSafe(smokePath),
  })
  missing.push(...budget.errors)

  return {
    e1: capturesImport,
    e2: checksRunCli && callsRunCli,
    e3: dynamicLoad,
    e4,
    e5: packaging.missing.length === 0,
    e5d: resourceConstants.errors.length === 0 && resourceConstants.missing.length === 0,
    e6: budget.errors.length === 0,
    modules: packaging.modules,
    missing,
  }
}

/**
 * 读 `tauri.conf.json` → `bundle.resources`。
 *
 * 读不到时返回 `null`（而不是空数组）：E5a 的判定要区分「清单里没有这一条」与
 * 「清单本身读不出来」——后者是配置被改坏，不该伪装成「文件没登记」。
 * @returns {string[]|null} glob 列表，或 null
 */
function readTauriResources() {
  try {
    const conf = JSON.parse(readFileSync(tauriConfPath, 'utf8'))
    const resources = conf?.bundle?.resources
    return Array.isArray(resources) ? resources : null
  } catch {
    return null
  }
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
import { installParentDeathWatchdog } from './parent-death-watchdog.mjs'
if (!dshEntryPath) { process.exitCode = 1 } else {
  process.argv = [process.execPath, dshEntryPath, ...dshArguments]
  try {
    const entry = await import(pathToFileURL(dshEntryPath).href)
    if (typeof entry?.runCli === 'function') { await entry.runCli() }
  } catch (error) { process.exitCode = 1 }
}
installParentDeathWatchdog({ label: 'harness-node' })`
  const goodModule = `
const POLL_INTERVAL_MS = 250
const FORCE_EXIT_MS = 250
export function installParentDeathWatchdog(){
  if (process.platform !== 'darwin' && process.env.DSH_PARENT_DEATH_WATCHDOG !== '1') return false
  const parentPid = process.ppid
  setInterval(() => { process.kill(parentPid, 0) }, POLL_INTERVAL_MS)
}`
  const goodMock = `installParentDeathWatchdog({ label: 'mock-harness' })`
  // E6 夹具：预算 250+250=500ms，小于窗口。窗口夹具写成与真实脚本同形（bug 就是
  // 「两套数字分处两个文件、各自看都合理」），因此这里两处都要给。
  const goodFaultInject = `
async function scenario() {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500))
  const orphans = findOrphans()
}`
  const goodSmoke = `if (after.length === 0 || cleanupMs >= 5000) break`
  // E5 的四份清单夹具。`preparedFileNames` 故意写成「整份文件里出现这个名字」，
  // 与判定的实际口径一致（不绑定 copyBuildFiles / REQUIRED_FILES 的具体写法）。
  const readModule = (name) => (name === 'parent-death-watchdog.mjs' ? goodModule : '')
  const goodPrepare = `const files = ['harness-node-entry.mjs', 'parent-death-watchdog.mjs']`
  const goodStub = `const assets = ['harness-node-entry.mjs', 'parent-death-watchdog.mjs']`
  const goodResources = ['resources/harness-node-entry.mjs', 'resources/parent-death-watchdog.mjs']
  // E5d 也给了夹具：真实的 paths.rs / constants.rs 描述的是**真实**资源清单，
  // 与上面这份两文件夹具对不上，因此这里换成「一个常量、一个被覆盖的文件」。
  const goodPaths = 'let entry = resource_dir.join(FIXTURE_RESOURCE_FILE);'
  const goodConstants = 'pub const FIXTURE_RESOURCE_FILE: &str = "parent-death-watchdog.mjs";'
  // 事故现场：这是 v0.7.0-alpha.1 真实发出的那份 bundle.resources——
  // 除 parent-death-watchdog.mjs 外全都在。
  const shippedResources = [
    'resources/bin/*',
    'resources/node/*',
    'resources/harness/**/*',
    'resources/MANIFEST.json',
    'resources/harness-node-entry.mjs',
    'resources/windows-child-process-hide.mjs',
    'resources/plugin-safety-guard.mjs',
    'resources/dsh-desktop.patch.yml',
    'resources/dsh-desktop-safe.patch.yml',
  ]
  const goodSources = {
    moduleSource: goodModule,
    mockSource: goodMock,
    tauriResources: goodResources,
    prepareSource: goodPrepare,
    stubSource: goodStub,
    readModule,
    pathsSource: goodPaths,
    constantsSource: goodConstants,
    faultInjectSource: goodFaultInject,
    smokeSource: goodSmoke,
  }
  const fixedResult = auditEntry(goodEntry, goodSources)
  check('好夹具 → 无缺失', fixedResult.missing.length === 0)
  check('好夹具 → e4=true', fixedResult.e4 === true)
  check('好夹具 → e5=true', fixedResult.e5 === true)
  check('好夹具 → 模块清单含看门狗', fixedResult.modules.includes('parent-death-watchdog.mjs'))

  // 可证伪性（E5a）：真实事故的那份 bundle.resources → 必须报 E5a。
  // 这是本组断言存在的全部理由：漏登记在本地、冒烟、全部静态门禁里都是绿的，
  // 只有「把清单当输入算一遍」才看得见。
  check(
    'bundle.resources 缺看门狗（v0.7.0-alpha.1 真实清单）→ E5a',
    auditEntry(goodEntry, { ...goodSources, tauriResources: shippedResources })
      .missing.some((m) => m.startsWith('E5a') && m.includes('parent-death-watchdog.mjs'))
  )
  // glob 写法必须被认作覆盖：清单改成 `resources/*.mjs` 时不该误报。
  check(
    'bundle.resources 用 glob 覆盖 → 不报 E5a',
    !auditEntry(goodEntry, { ...goodSources, tauriResources: ['resources/*.mjs'] })
      .missing.some((m) => m.startsWith('E5a'))
  )
  // 可证伪性（E5b）：prepare-harness 未登记 → 文件不会进 resources/。
  check(
    'prepare-harness 未登记 → E5b',
    auditEntry(goodEntry, { ...goodSources, prepareSource: "const files = ['harness-node-entry.mjs']" })
      .missing.some((m) => m.startsWith('E5b') && m.includes('parent-death-watchdog.mjs'))
  )
  // 可证伪性（E5c）：CI 编译桩未登记 → build.rs 的 glob 失配。
  check(
    'stub-tauri-resources 未登记 → E5c',
    auditEntry(goodEntry, { ...goodSources, stubSource: "const assets = ['harness-node-entry.mjs']" })
      .missing.some((m) => m.startsWith('E5c') && m.includes('parent-death-watchdog.mjs'))
  )
  // 递归：被 import 的模块自己再 import 第三个文件时，也要进清单。
  check(
    '二级依赖（模块 import 模块）也进清单',
    auditEntry(goodEntry, {
      ...goodSources,
      readModule: (name) =>
        name === 'parent-death-watchdog.mjs'
          ? `${goodModule}\nimport { noop } from './nested-helper.mjs'`
          : `export function noop() {}`,
    }).missing.some((m) => m.startsWith('E5a') && m.includes('nested-helper.mjs'))
  )

  // ---- E5d：Rust 资源常量 ↔ 打包清单 -------------------------------------
  // 这一组用的是**真实文件**（paths.rs / constants.rs / tauri.conf.json），
  // 不是手抄的夹具：判据的价值恰恰在于它读的是那两个唯一产地。
  const realPaths = readFileSafe(pathsSourcePath)
  const realConstants = readFileSafe(constantsSourcePath)
  const realResources = readTauriResources()
  const e5dReal = auditResourceConstants({
    pathsSource: realPaths,
    constantsSource: realConstants,
    tauriResources: realResources,
  })
  check('E5d 真实源码 → 无缺失', e5dReal.missing.length === 0 && e5dReal.errors.length === 0)
  check(
    'E5d 真实源码 → 推导出了资源文件（不是空集）',
    e5dReal.needed.some((n) => n.value === 'harness-node-entry.mjs') &&
      e5dReal.needed.some((n) => n.value === 'dsh-desktop-safe.patch.yml')
  )
  // 可证伪性：把真实 constants.rs 里 NODE_ENTRY_FILE 的值改掉，清单必然覆盖不到。
  const mutatedConstants = realConstants.replace(
    'pub const NODE_ENTRY_FILE: &str = "harness-node-entry.mjs";',
    'pub const NODE_ENTRY_FILE: &str = "brand-new-entry.mjs";'
  )
  check(
    'E5d 常量指向清单外的新文件 → 报缺失',
    auditResourceConstants({
      pathsSource: realPaths,
      constantsSource: mutatedConstants,
      tauriResources: realResources,
    }).missing.some((m) => m.includes('brand-new-entry.mjs'))
  )
  // 可证伪性：paths.rs 里新增一次 resource_dir.join(新常量) 且清单没跟上 → 报缺失。
  // 这正是「将来新增资源文件」的形态，也是本检查唯一想提前拦住的东西。
  const mutatedPaths = realPaths.replace(
    'let modules = resource_dir.join(HARNESS_MODULES_DIR);',
    'let modules = resource_dir.join(HARNESS_MODULES_DIR);\n        let extra = resource_dir.join(BRAND_NEW_ASSET_FILE);'
  )
  const constantsWithNewFile = realConstants.replace(
    'pub const MANIFEST_FILE: &str = "MANIFEST.json";',
    'pub const MANIFEST_FILE: &str = "MANIFEST.json";\npub const BRAND_NEW_ASSET_FILE: &str = "brand-new-asset.bin";'
  )
  check(
    'E5d paths.rs 新增资源常量 → 报缺失',
    auditResourceConstants({
      pathsSource: mutatedPaths,
      constantsSource: constantsWithNewFile,
      tauriResources: realResources,
    }).missing.some((m) => m.includes('brand-new-asset.bin'))
  )
  // 反证：清单补上那一条之后必须通过（否则判定是「见到新常量就报错」，不是「没覆盖才报错」）。
  check(
    'E5d 清单补上该条目 → 通过',
    auditResourceConstants({
      pathsSource: mutatedPaths,
      constantsSource: constantsWithNewFile,
      tauriResources: [...realResources, 'resources/brand-new-asset.bin'],
    }).missing.length === 0
  )
  // 判据失效必须自曝：paths.rs 改成别的写法时不能静默通过。
  check(
    'E5d 推导失效（paths.rs 无 resource_dir.join）→ 报错而非静默通过',
    auditResourceConstants({
      pathsSource: '// 改写了',
      constantsSource: realConstants,
      tauriResources: realResources,
    }).errors.length > 0
  )
  // EOL 无关（ADR-031）：CRLF 检出下必须与 LF 表现一致。仓库在 Windows 上
  // 常以 CRLF 落盘，而这两条判据全是正则匹配源码——正则一旦被 `\r` 破坏，
  // 结果不是「报错」而是**静默通过**（匹配不到任何东西），最危险的一种失效。
  const toCrlf = (text) => text.replace(/\r?\n/gu, '\r\n')
  const crlfResult = auditResourceConstants({
    pathsSource: toCrlf(realPaths),
    constantsSource: toCrlf(realConstants),
    tauriResources: realResources,
  })
  check(
    'E5d CRLF 检出 → 与 LF 结论一致',
    crlfResult.missing.length === 0 && crlfResult.errors.length === 0 && crlfResult.needed.length === e5dReal.needed.length
  )
  check(
    'E5 CRLF 入口 → 兄弟模块仍被识别',
    auditEntry(toCrlf(readFileSafe(entryPath)), {
      pathsSource: toCrlf(realPaths),
      constantsSource: toCrlf(realConstants),
      tauriResources: realResources,
    }).modules.includes('parent-death-watchdog.mjs')
  )

  // ---- E6：看门狗预算 vs 门禁窗口 ----------------------------------------
  const realWatchdog = readFileSafe(watchdogModulePath)
  const realFaultInject = readFileSafe(faultInjectPath)
  const realSmoke = readFileSafe(smokePath)
  const e6Real = auditWatchdogBudget({
    watchdogSource: realWatchdog,
    faultInjectSource: realFaultInject,
    smokeSource: realSmoke,
  })
  check('E6 真实常数 → 无错且预算算得出', e6Real.errors.length === 0 && e6Real.budgetMs !== null)
  check(
    'E6 真实常数 → 定位到了门禁窗口',
    e6Real.windows.length >= 2 && e6Real.windows.some((w) => w.name.includes('fault-inject'))
  )
  // 可证伪性：把看门狗打回修复前的 250 + 1500 = 1750ms —— 必须报 E6（对着
  // fault-inject 的 1500ms 窗口）。这是 2026-09-21 macOS L2.2 转红的真实常数。
  const preFixWatchdog = realWatchdog.replace(
    'const FORCE_EXIT_MS = 750',
    'const FORCE_EXIT_MS = 1500'
  )
  const e6PreFix = auditWatchdogBudget({
    watchdogSource: preFixWatchdog,
    faultInjectSource: realFaultInject,
    smokeSource: realSmoke,
  })
  check(
    'E6 修复前的 250+1500 → 报超窗',
    e6PreFix.errors.some((e) => e.startsWith('E6') && e.includes('1750'))
  )
  // 反证：常数小到一定在窗口内时不得报错（否则判定是「见常数就报」，不是「超窗才报」）。
  const tightWatchdog = realWatchdog
    .replace('const POLL_INTERVAL_MS = 250', 'const POLL_INTERVAL_MS = 100')
    .replace('const FORCE_EXIT_MS = 750', 'const FORCE_EXIT_MS = 300')
  check(
    'E6 400ms 预算 → 通过',
    auditWatchdogBudget({
      watchdogSource: tightWatchdog,
      faultInjectSource: realFaultInject,
      smokeSource: realSmoke,
    }).errors.length === 0
  )
  // 判据失效必须自曝：常数改名（读不到）时不能静默通过。
  // 用正则替换**第一个**出现的 `POLL_INTERVAL_MS`（注释里也可能提到）。
  check(
    'E6 常数改名 → 报错而非静默通过',
    auditWatchdogBudget({
      watchdogSource: realWatchdog.replace(/POLL_INTERVAL_MS/u, 'POLL_MS_RENAMED').replace(/POLL_INTERVAL_MS/u, 'POLL_MS_RENAMED'),
      faultInjectSource: realFaultInject,
      smokeSource: realSmoke,
    }).errors.length > 0
  )

  // 可证伪性（E4a）：入口不装看门狗 → 报 E4a
  const noInstall = goodEntry.replace(/installParentDeathWatchdog[\s\S]*$/, '')
  check(
    '入口未装看门狗 → E4a',
    auditEntry(noInstall, { moduleSource: goodModule, mockSource: goodMock }).missing.some((m) => m.startsWith('E4a'))
  )

  // 可证伪性（E4b）：模块给定时器加 unref（真机失效的确切原因）→ 报 E4b
  const unrefModule = goodModule.replace(
    'setInterval(() => { process.kill(parentPid, 0) }, POLL_INTERVAL_MS)',
    'const wdRef = setInterval(() => { process.kill(parentPid, 0) }, POLL_INTERVAL_MS); wdRef.unref()'
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
  console.log(`  · E5 兄弟模块已登记入包 : ${result.e5 ? 'ok' : '✗'}`)
  console.log(`      受检模块：${result.modules.join('、')}`)
  console.log(`  · E5d Rust 资源常量入包 : ${result.e5d ? 'ok' : '✗'}`)
  console.log(`  · E6 看门狗清理预算     : ${result.e6 ? 'ok' : '✗'}`)
  console.log('')
  if (result.missing.length === 0) {
    console.log('  ✅ 入口与上游 CLI 的调用约定兼容，且入口依赖的模块都在打包清单里')
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
