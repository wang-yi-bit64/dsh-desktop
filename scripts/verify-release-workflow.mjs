#!/usr/bin/env node
/**
 * verify-release-workflow.mjs — 发布工作流的静态判据守卫。
 *
 * ## 为什么存在（2026-09-11，v0.1.0 首次发布的真实事故）
 *
 * 首次 `v0.1.0` 发布时，三个平台的 release job **全红**，且都是只有真跑工作流
 * 才会暴露、编译器与本地门禁一律看不见的两类缺陷：
 *
 *   1. **tauri-action 的命令拼装**。该 action 内部会在 `tauriScript` 之后**自己**
 *      插入 `build` 子命令和一个 `--` 分隔符（见其 `src/runner.ts` / `src/build.ts`）：
 *
 *          args = [...tauriScript] + ['build'] + (bin==='npm' && 有参数 ? ['--'] : []) + [...tauriArgs]
 *
 *      本仓当时写成 `tauriScript: npm run tauri --` + `args: build --bundles …`，
 *      实际展开成 `npm run tauri -- build -- build --bundles …`，tauri CLI 报
 *      `unexpected argument 'build' found`，三平台一起失败。
 *
 *   2. **macOS bash 3.2 的变量终止**。生成发布说明的脚本里写了 `**首次发布**（$TAG）`：
 *      macOS runner 的 bash 3.2 在没有 UTF-8 locale 时**不会**把紧跟其后的全角
 *      `）` 当作变量名终止符，于是把变量解析成 `TAG）`，报
 *      `TAG）: unbound variable`（Linux/Windows 的 bash 正确终止，所以只有 macOS 红）。
 *
 * 这两条都“只在真跑发布时炸”，本地 `npm run verify:*` 全都绿——正是本仓守卫体系
 * 要覆盖的那一类。本脚本用纯文本判据把它们钉死，并带**可伪证性检查**：把上述两份
 * 缺陷配置当作夹具，断言必须变红。
 *
 * 用法：
 * ```bash
 * node scripts/verify-release-workflow.mjs            # 校验真实工作流
 * node scripts/verify-release-workflow.mjs --self-test # 自测（含可伪证性检查）
 * ```
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_YML = join(projectRoot, '.github', 'workflows', 'release.yml')

/**
 * 从工作流文本里取出 tauri-action 步骤的 `tauriScript` 与 `args` 输入。
 *
 * 刻意只做**行级**解析（不引入 YAML 依赖）：定位 `uses: tauri-apps/tauri-action`
 * 之后，取到该步骤 `with:` 里的两个键即可，够用且不脆。
 *
 * @param {string} text release.yml 全文
 * @returns {{tauriScript: string|null, args: string|null}} 两个输入值（未找到为 null）
 */
export function extractTauriActionInputs(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /uses:\s*tauri-apps\/tauri-action/.test(line))
  if (start < 0) return { tauriScript: null, args: null }

  // 只在紧随其后的这一段里找，避免命中别的步骤。
  const window = lines.slice(start, start + 60)
  const readKey = (key) => {
    const re = new RegExp(`^\\s*${key}:\\s*(.*)$`)
    for (const line of window) {
      const m = re.exec(line)
      if (m) return m[1].trim()
    }
    return null
  }
  return { tauriScript: readKey('tauriScript'), args: readKey('args') }
}

/**
 * 复刻 tauri-action 内部把 tauriScript + args 拼成命令行的逻辑。
 *
 * 依据其 `dist/index.js`（`getRunner` 与 `Runner.execTauriCommand`）：
 *   - `tauriScript` 按空格切分，首 token 是 runner，其余是它的固定参数；
 *   - 若 runner 是 `npm` 且第一个固定参数不是 `run`，会补一个 `run`；
 *   - 之后 push 子命令 `build`；
 *   - 若 runner 是 `npm` 且本次带了参数，push 一个 `--`（这是 npm 的转发分隔符，
 *     **是预期行为**，不是缺陷）；
 *   - 最后 push 本次参数。
 *
 * `args` 里的 GitHub 表达式（`${{ … }}`，可能含空格）在 runner 上会先被展开成一个
 * 值，因此先折叠成占位 token 再切分，避免把 `${{` / `matrix.bundles` / `}}` 当成三个参数。
 *
 * @param {string} tauriScript 输入的 tauriScript（如 `npm run tauri`）
 * @param {string} argsInput 输入的 args（如 `--bundles ${{ matrix.bundles }} -v`）
 * @returns {string[]} 最终传给 runner 的 argv（不含 runner 本身）
 */
export function simulateTauriActionArgv(tauriScript, argsInput) {
  const script = String(tauriScript ?? '').trim()
  const [runner, ...runnerArgs] = script.split(/\s+/).filter(Boolean)

  const collapsedArgs = String(argsInput ?? '').replace(/\$\{\{[^}]*\}\}/g, 'EXPR')
  const tauriArgs = collapsedArgs.trim().split(/\s+/).filter(Boolean)

  const argv = []
  if (runner === 'npm' && runnerArgs[0] !== 'run') argv.push('run')
  argv.push(...runnerArgs)
  argv.push('build')
  if (runner === 'npm' && tauriArgs.length) argv.push('--')
  argv.push(...tauriArgs)
  return argv
}

/**
 * 判定 tauri-action 的配置是否是「tauri CLI 能接受」的形状。
 *
 * 事故的直接成因有两条，判据就钉这两条：
 *   1. `tauriScript` 自己带了 `build` 或 `--` —— action 会再补一份，导致重复；
 *   2. 展开后的 argv 里 `build` 必须**恰好一次**。
 *
 * 合法的 `--`（npm 在 `build` 之后自己插的转发分隔符）**不**判为问题——它是预期行为，
 * 只在 tauriScript 里出现才是缺陷。
 *
 * @param {string[]} argv `simulateTauriActionArgv()` 的产物
 * @param {string[]} tauriScriptTokens tauriScript 按空格切分后的 token
 * @returns {{ok: boolean, problems: string[]}} 判定与问题清单
 */
export function checkTauriArgv(argv, tauriScriptTokens = []) {
  const problems = []
  const builds = argv.filter((token) => token === 'build').length
  if (builds !== 1) problems.push(`tauri 子命令 build 出现了 ${builds} 次（必须恰好 1 次）`)
  if (tauriScriptTokens.includes('--')) {
    problems.push("tauriScript 里带了 '--'——action 会再补一个，导致 `build -- build` 之类的重复参数")
  }
  if (tauriScriptTokens.includes('build')) {
    problems.push("tauriScript 里带了 'build'——args 里不应再写它，否则 tauri 报 unexpected argument")
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 扫出**可执行行**里「shell 变量紧邻非 ASCII 字符」的写法。
 *
 * `$TAG）` 这类写法在 macOS 的 bash 3.2（无 UTF-8 locale）下会把全角字符并入变量名，
 * 报 `TAG）: unbound variable`。只认未加花括号的 `$NAME`（`${NAME}` 安全），
 * 跳过 GitHub 表达式 `${{ … }}` 与注释行。
 *
 * @param {string} text 待检查文本
 * @returns {Array<{line: number, snippet: string}>} 命中清单
 */
export function findUnbracedVarBeforeNonAscii(text) {
  const hits = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('#')) return // 注释不是可执行行
    const stripped = line.replace(/\$\{\{[^}]*\}\}/g, '')
    const re = /\$([A-Za-z_][A-Za-z0-9_]*)([^\x00-\x7F])/g
    let m
    while ((m = re.exec(stripped)) !== null) {
      hits.push({ line: index + 1, snippet: `${m[1]}${m[2]}` })
    }
  })
  return hits
}

/**
 * 自测：对真实文件跑一遍判据，并用两份**已知缺陷夹具**做可伪证性检查。
 *
 * @returns {{passed: number}} 通过项数
 * @throws {Error} 任一断言失败时抛出，并汇总全部失败项
 */
export function selfTest() {
  const failures = []
  let passed = 0
  const check = (condition, message) => {
    passed += 1
    if (!condition) failures.push(message)
  }

  const text = readFileSync(RELEASE_YML, 'utf8')

  // 1) 真实工作流：tauri-action 的参数必须能展开成合法 argv。
  const { tauriScript, args } = extractTauriActionInputs(text)
  check(tauriScript !== null, 'release.yml：未找到 tauri-action 的 tauriScript 输入')
  check(args !== null, 'release.yml：未找到 tauri-action 的 args 输入')
  if (tauriScript !== null && args !== null) {
    const argv = simulateTauriActionArgv(tauriScript, args)
    const tokens = tauriScript.trim().split(/\s+/).filter(Boolean)
    const verdict = checkTauriArgv(argv, tokens)
    check(verdict.ok, `release.yml：tauri-action 命令行不合法 → ${verdict.problems.join('；')}（argv=${JSON.stringify(argv)}）`)
    check(argv.includes('--bundles'), 'release.yml：tauri-action 的 argv 未包含 --bundles')
  }

  // 2) 真实工作流：不得有「未加花括号的变量紧邻非 ASCII 字符」的写法。
  const hits = findUnbracedVarBeforeNonAscii(text)
  check(hits.length === 0, `release.yml：存在变量紧邻非 ASCII 字符的写法（macOS bash 3.2 会并入变量名）→ ${hits.map((h) => `L${h.line}: $${h.snippet}`).join('；')}`)

  // 3) 可伪证性：缺陷夹具必须被同一批判据判红，否则判据是装饰。
  const buggyScript = 'npm run tauri --'
  const buggyArgs = 'build --bundles nsis -v'
  const buggyArgv = simulateTauriActionArgv(buggyScript, buggyArgs)
  const buggyTokens = buggyScript.split(/\s+/).filter(Boolean)
  check(!checkTauriArgv(buggyArgv, buggyTokens).ok, '可伪证性：旧版 tauri-action 配置（tauriScript 带 -- + args 带 build）必须被判为不合法')
  check(buggyArgv.filter((t) => t === 'build').length === 2, '可伪证性：旧版配置应当展开出两个 build 才能复现事故')

  // 合法写法（本次修复后的形状）必须判绿，否则守卫会误报。
  const goodArgv = simulateTauriActionArgv('npm run tauri', '--bundles ${{ matrix.bundles }} -v')
  check(checkTauriArgv(goodArgv, ['npm', 'run', 'tauri']).ok, `可伪证性：修复后的写法必须判绿（argv=${JSON.stringify(goodArgv)}）`)

  const buggyNotes = 'echo "**首次发布**（$TAG）"'
  check(findUnbracedVarBeforeNonAscii(buggyNotes).length === 1, '可伪证性：`（$TAG）` 这种写法必须被命中')
  check(findUnbracedVarBeforeNonAscii('echo "v${TAG}x"').length === 0, '可伪证性：`${TAG}` 花括号写法不应被命中')
  check(findUnbracedVarBeforeNonAscii('# 注释里的 $TAG）不算').length === 0, '可伪证性：注释行不应被命中')

  if (failures.length > 0) {
    throw new Error(`发布工作流守卫失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`)
  }
  return { passed }
}

function run() {
  const text = readFileSync(RELEASE_YML, 'utf8')
  const { tauriScript, args } = extractTauriActionInputs(text)
  const argv = simulateTauriActionArgv(tauriScript ?? '', args ?? '')
  const tokens = String(tauriScript ?? '').trim().split(/\s+/).filter(Boolean)
  const { ok, problems } = checkTauriArgv(argv, tokens)
  const hits = findUnbracedVarBeforeNonAscii(text)

  if (!ok) {
    for (const p of problems) console.error(`  ✗ tauri-action：${p}`)
  } else {
    console.log(`✅ tauri-action argv 合法：npm ${argv.join(' ')}`)
  }
  if (hits.length > 0) {
    for (const h of hits) console.error(`  ✗ release.yml L${h.line}：变量 $${h.snippet} 紧邻非 ASCII 字符`)
  } else {
    console.log('✅ release.yml 无「变量紧邻非 ASCII 字符」写法')
  }
  if (!ok || hits.length > 0) process.exit(1)
}

const isDirectRun = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1])
  } catch {
    return false
  }
})()

if (isDirectRun) {
  if (process.argv.includes('--self-test')) {
    try {
      const { passed } = selfTest()
      console.log(`✅ 发布工作流守卫自测通过（${passed} 项）`)
    } catch (error) {
      console.error(error.message)
      process.exit(1)
    }
  } else {
    run()
  }
}
