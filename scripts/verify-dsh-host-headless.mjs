#!/usr/bin/env node
/**
 * verify-dsh-host-headless.mjs — 断言 **`dsh-host` 的传递依赖闭包不含任何窗口层 crate**
 * （S6-1 / 兑现 `docs/roadmap.md` §H1-a 与 `AGENTS.md` §3 不变量 1）。
 *
 * ## 为什么有这条门禁（守的是哪一类缺陷）
 *
 * `AGENTS.md` §3.1 把「无头核心库隔离」写成硬不变量：`dsh-contracts` / `dsh-host`
 * **严禁**依赖 Tauri、UI 框架或窗口系统，判据是「它能不能在没有窗口系统的机器上被测试」。
 * `docs/roadmap.md` §H1-a 把它列为资产化第一步：「保证零 Tauri 依赖，**把它变成对外承诺并加 gate**」。
 *
 * 在 2026-10-11 之前，这条不变量**只有人工遵守，没有任何守卫**。它当时的形状确实是
 * headless（`dsh-host` 的依赖只有 serde / tokio / regex / url / zip / windows-sys 等），
 * 于是「看起来没问题」——而这正是本仓反复出问题的那一类：**注释里的现状声明零守卫**。
 *
 * 为什么它值得一条门禁：**接线之后这条不变量会立刻承压**。`Supervisor` 接入桌面壳
 * （L1 调 L2）时，最省事的「修法」就是把壳需要的东西塞进 `dsh-host`——而 Tauri 类型
 * （`AppHandle` / `Emitter`）一旦渗进 L2，`dsh-host` 就再也不能在没有窗口系统的机器上
 * 独立测试，INV-6 当场失效，且**编译不会报错**。这条守卫把那次渗漏变成会报红的事实。
 *
 * ## 判什么（可证伪）
 *
 *   1. `dsh-host` 的**传递**闭包（不是只看直接依赖）中不得出现窗口层 crate。
 *      ⚠️ 只看直接依赖会漏掉 `dsh-host → a → tauri` 这类两跳渗透——本脚本的
 *      自检里专门有一条针对它的夹具。
 *   2. 闭包必须**非空**且根节点必须被解析到 —— 解析失败/空集**不得冒充通过**
 *      （AGENTS.md §7.3 硬要求③：「先扫后验」型守卫必须同时断言扫出数 > 0）。
 *   3. 依赖名带版本后缀（`thiserror 1.0.69`）时必须精确解析；不带后缀时该名字
 *      必须唯一，否则判红——**不猜测**。
 *
 * ## 刻意不做的事
 *
 *   · **不调用 cargo、不联网**：直接读根 `Cargo.lock` 建图，进 fast 档零成本。
 *     代价是只覆盖 Cargo.lock 记录的内容——feature 级的条件依赖不在判定范围。
 *   · **不试图修**：它只报告。修法是去掉那条把窗口层带进来的依赖。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-dsh-host-headless.mjs              # 真检查
 * node scripts/verify-dsh-host-headless.mjs --self-test  # 自检（含两跳渗透等负向夹具）
 * ```
 *
 * 退出码：`0` 通过 · `1` 违规 · `2` 参数错误。
 */

import { argv, exit } from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 根 lock 相对路径（唯一产地）。 */
export const ROOT_LOCK_REL = 'Cargo.lock'

/** 被检查的无头 crate（唯一产地）。 */
export const HEADLESS_CRATE = 'dsh-host'

/**
 * 窗口层 crate 的判定（唯一产地）。
 *
 * 覆盖三类：① Tauri 本体与其全部 `tauri-*` 生态；② 底层窗口/托盘实现
 * （`wry` / `tao` / `muda` / `tray-icon`）；③ Windows WebView2 绑定。
 *
 * `gtk*` 一并列入：在 Linux 上它**只可能由窗口层带进来**——若 `dsh-host` 的闭包里
 * 出现 gtk，说明某个窗口层 crate 已经渗入，判定应当报红而不是放过。
 *
 * @param {string} name 包名
 * @returns {boolean} 是否属于窗口层
 */
export function isWindowLayer(name) {
  const n = String(name)
  if (n === 'tauri' || n.startsWith('tauri-')) return true
  if (n === 'wry' || n === 'tao' || n === 'muda' || n === 'tray-icon') return true
  if (n === 'webview2-com' || n.startsWith('webview2-')) return true
  if (n.startsWith('gtk')) return true
  return false
}

/**
 * 解析 `Cargo.lock`（v4）文本，抽出全部 `[[package]]` 条目。
 *
 * 只认 `name` / `version` / 数组形态的 `dependencies`。依赖条目可能是
 * `"serde"`（该名字唯一时 cargo 省略版本）或 `"thiserror 1.0.69"`（歧义时带版本）。
 *
 * @param {string} text Cargo.lock 全文
 * @returns {{ packages: {name:string, version:string, deps:string[]}[], problem: string|null }}
 *          `problem` 非空表示**无法可信解析**，调用方必须判红
 */
export function parseCargoLock(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n')
  if (normalized.trim() === '') return { packages: [], problem: 'Cargo.lock 为空' }

  const lines = normalized.split('\n')
  const packages = []
  let current = null
  let inDeps = false

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (line === '[[package]]') {
      if (current) packages.push(current)
      current = { name: '', version: '', deps: [] }
      inDeps = false
      continue
    }
    if (!current) continue

    if (inDeps) {
      if (line.startsWith(']')) {
        inDeps = false
        continue
      }
      const item = line.replace(/,$/, '').trim()
      if (item !== '') {
        const m = /^"(.*)"$/.exec(item)
        if (!m) return { packages: [], problem: `dependencies 条目不是字符串：${item}` }
        current.deps.push(m[1])
      }
      continue
    }

    const nameMatch = /^name\s*=\s*"(.*)"$/.exec(line)
    if (nameMatch) {
      current.name = nameMatch[1]
      continue
    }
    const versionMatch = /^version\s*=\s*"(.*)"$/.exec(line)
    if (versionMatch && current.name !== '' && current.version === '') {
      current.version = versionMatch[1]
      continue
    }
    if (line === 'dependencies = [') {
      inDeps = true
      continue
    }
  }
  if (current) packages.push(current)

  const valid = packages.filter((p) => p.name !== '')
  if (valid.length === 0) return { packages: [], problem: '未解析到任何 package 条目' }
  return { packages: valid, problem: null }
}

/**
 * 解析依赖引用为 `{name, version|null}`。
 *
 * @param {string} ref lock 里的依赖条目，如 `"serde"` 或 `"thiserror 1.0.69"`
 * @returns {{ name: string, version: string|null }}
 */
export function parseDependencyRef(ref) {
  const parts = String(ref).trim().split(/\s+/)
  return { name: parts[0], version: parts.length > 1 ? parts[1] : null }
}

/**
 * 从指定根包出发，走**传递**闭包。
 *
 * 解析规则（不猜）：带版本后缀则精确匹配；不带后缀则该名字必须在 lock 里唯一，
 * 否则记 `problem` 并判红——歧义时静默取第一个会造出「看起来查过了」的假绿。
 *
 * @param {{name:string, version:string, deps:string[]}[]} packages 解析结果
 * @param {string} rootName 根包名
 * @returns {{ names: string[], problems: string[] }} 闭包内的**去重包名**与问题清单
 */
export function transitiveClosure(packages, rootName) {
  const byName = new Map()
  for (const pkg of packages) {
    const list = byName.get(pkg.name) ?? []
    list.push(pkg)
    byName.set(pkg.name, list)
  }

  const problems = []
  if (!byName.has(rootName)) {
    problems.push(`根 crate「${rootName}」不在 Cargo.lock 里——解析失败不得冒充通过`)
    return { names: [], problems }
  }

  const seen = new Set()
  const queue = [rootName]
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)

    const candidates = byName.get(name) ?? []
    for (const pkg of candidates) {
      for (const ref of pkg.deps) {
        const { name: depName, version } = parseDependencyRef(ref)
        const matches = byName.get(depName) ?? []
        if (matches.length === 0) {
          problems.push(`「${name}」声明的依赖「${depName}」在 lock 里找不到`)
          continue
        }
        if (version !== null) {
          if (!matches.some((m) => m.version === version)) {
            problems.push(`「${name}」依赖「${depName} ${version}」，lock 里无该版本`)
            continue
          }
        } else if (matches.length > 1) {
          problems.push(
            `「${name}」依赖「${depName}」未带版本后缀，但 lock 里有 ${matches.length} 个版本——歧义，拒绝猜测`
          )
          continue
        }
        if (!seen.has(depName)) queue.push(depName)
      }
    }
  }

  return { names: [...seen].sort(), problems }
}

/**
 * 审计一份 `Cargo.lock` 文本。
 *
 * @param {string} lockText Cargo.lock 全文
 * @returns {{ violations: string[], closureSize: number, problems: string[] }}
 */
export function auditLockText(lockText) {
  const { packages, problem } = parseCargoLock(lockText)
  if (problem) return { violations: [], closureSize: 0, problems: [problem] }

  const { names, problems } = transitiveClosure(packages, HEADLESS_CRATE)
  const violations = names.filter(isWindowLayer).map((n) => `${HEADLESS_CRATE} 的闭包含窗口层 crate「${n}」`)
  // 硬要求③：先扫后验型守卫必须断言扫出数 > 0。
  //
  // 阈值取 2（根 + 至少一个依赖）而不是 0：闭包**恒含根节点**，故 `length === 0`
  // 永远不成立——那是个红不出来的假判据（本脚本自检就是靠它自己发现的）。
  // 真正要防的失败模式是「lock 解析失败、只拿到根节点、于是零违规给绿」。
  if (names.length < 2) {
    problems.push(
      `「${HEADLESS_CRATE}」闭包只解析出 ${names.length} 个包（应为根 + 至少一个依赖）——解析失败不得冒充通过`
    )
  }
  return { violations, closureSize: names.length, problems }
}

/**
 * 审计仓库。
 *
 * @param {string} [root] 仓库根
 * @returns {{ violations: string[], closureSize: number, problems: string[] }}
 */
export function auditRepo(root = projectRoot) {
  const lockPath = resolve(root, ROOT_LOCK_REL)
  if (!existsSync(lockPath)) {
    return { violations: [], closureSize: 0, problems: [`找不到 ${ROOT_LOCK_REL}`] }
  }
  let text
  try {
    text = readFileSync(lockPath, 'utf8')
  } catch (error) {
    return { violations: [], closureSize: 0, problems: [`读取 ${ROOT_LOCK_REL} 失败：${error.message}`] }
  }
  return auditLockText(text)
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/** 造一份最小 Cargo.lock 文本。 */
function lockOf(entries) {
  const blocks = entries.map((e) => {
    const deps = e.deps && e.deps.length > 0
      ? `\ndependencies = [\n${e.deps.map((d) => ` "${d}",`).join('\n')}\n]`
      : ''
    return `[[package]]\nname = "${e.name}"\nversion = "${e.version}"${deps}`
  })
  return `version = 4\n\n${blocks.join('\n\n')}\n`
}

function runSelfTest() {
  const checks = []
  const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    checks.push({ label, ok, actual, expected })
    console.log(`  ${ok ? '✅' : '❌'} ${label}`)
    if (!ok) console.log(`     期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }

  // --- 解析层 ---
  const parsed = parseCargoLock(
    lockOf([
      { name: 'dsh-host', version: '0.1.0', deps: ['serde', 'thiserror 1.0.69'] },
      { name: 'serde', version: '1.0.0' },
      { name: 'thiserror', version: '1.0.69' },
      { name: 'thiserror', version: '2.0.0' },
    ])
  )
  check('解析出 4 个 package', parsed.packages.length, 4)
  check('无解析问题', parsed.problem, null)
  check('依赖引用带版本后缀被保留', parseDependencyRef('thiserror 1.0.69'), {
    name: 'thiserror',
    version: '1.0.69',
  })
  check('依赖引用不带后缀', parseDependencyRef('serde'), { name: 'serde', version: null })
  check('空文本判为问题', parseCargoLock('').problem !== null, true)
  check('无 package 判为问题', parseCargoLock('version = 4\n').problem !== null, true)

  // --- 正向：干净的 headless 闭包必须放行 ---
  const clean = lockOf([
    { name: 'dsh-host', version: '0.1.0', deps: ['serde', 'tokio'] },
    { name: 'serde', version: '1.0.0' },
    { name: 'tokio', version: '1.0.0', deps: ['mio'] },
    { name: 'mio', version: '1.0.0' },
    // 仓库里**确实存在** tauri，但只要不在 dsh-host 闭包里就不该报红。
    { name: 'tauri', version: '2.0.0' },
  ])
  const cleanAudit = auditLockText(clean)
  check('干净闭包无违规', cleanAudit.violations, [])
  check('干净闭包无问题', cleanAudit.problems, [])
  check('闭包含 4 个包（含 mio 两跳）', cleanAudit.closureSize, 4)

  // --- 负向①：直接依赖 tauri 必须报红 ---
  const direct = lockOf([
    { name: 'dsh-host', version: '0.1.0', deps: ['tauri'] },
    { name: 'tauri', version: '2.0.0' },
  ])
  check('直接依赖 tauri → 报红', auditLockText(direct).violations.length, 1)

  // --- 负向②：两跳渗透必须报红（只看直接依赖会漏掉这一类）---
  const transitive = lockOf([
    { name: 'dsh-host', version: '0.1.0', deps: ['some-helper'] },
    { name: 'some-helper', version: '1.0.0', deps: ['tauri-runtime'] },
    { name: 'tauri-runtime', version: '2.0.0', deps: ['wry'] },
    { name: 'wry', version: '0.1.0' },
  ])
  const transitiveAudit = auditLockText(transitive)
  // 闭包里同时有 tauri-runtime 与 wry（后者由前者带出），两条都该被点名。
  check('两跳渗透 → 报红且命中 2 个窗口层 crate', transitiveAudit.violations.length, 2)
  check('两跳渗透命中 tauri-runtime', transitiveAudit.violations.some((v) => v.includes('tauri-runtime')), true)
  check('两跳渗透命中最底层 wry', transitiveAudit.violations.some((v) => v.includes('wry')), true)

  // --- 负向③：根缺失 / 闭包退化不得冒充通过 ---
  check('根 crate 缺失 → 有问题', auditLockText(lockOf([{ name: 'serde', version: '1.0.0' }])).problems.length > 0, true)
  const rootOnly = lockOf([{ name: 'dsh-host', version: '0.1.0' }])
  const rootOnlyAudit = auditLockText(rootOnly)
  check('闭包只有根节点 → 有问题（不得给绿）', rootOnlyAudit.problems.length > 0, true)
  check('闭包只有根节点时 closureSize = 1', rootOnlyAudit.closureSize, 1)

  // --- 负向④：依赖名歧义且无版本后缀 → 拒绝猜测 ---
  const ambiguous = lockOf([
    { name: 'dsh-host', version: '0.1.0', deps: ['dup'] },
    { name: 'dup', version: '1.0.0' },
    { name: 'dup', version: '2.0.0' },
  ])
  check('歧义依赖 → 有问题', auditLockText(ambiguous).problems.length > 0, true)

  // --- 判定函数本身 ---
  check('isWindowLayer: tauri', isWindowLayer('tauri'), true)
  check('isWindowLayer: tauri-plugin-updater', isWindowLayer('tauri-plugin-updater'), true)
  check('isWindowLayer: webview2-com', isWindowLayer('webview2-com'), true)
  check('isWindowLayer: gtk4-sys', isWindowLayer('gtk4-sys'), true)
  check('isWindowLayer: serde 不算', isWindowLayer('serde'), false)
  check('isWindowLayer: tokio 不算', isWindowLayer('tokio'), false)
  check('isWindowLayer: tauri-ish 前缀但不同名不算', isWindowLayer('tauri_not_really'), false)

  const failed = checks.filter((c) => !c.ok)
  if (failed.length > 0) {
    console.error(`❌ [verify-dsh-host-headless] self-test 失败 ${failed.length}/${checks.length} 项`)
    exit(1)
  }
  console.log(`✅ [verify-dsh-host-headless] self-test 全部通过（${checks.length} 项）`)
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function main() {
  const args = argv.slice(2)
  const unknown = args.filter((arg) => arg !== '--self-test')
  if (unknown.length > 0) {
    console.error(`[verify-dsh-host-headless] 未知参数：${unknown.join(' ')}`)
    exit(2)
  }
  if (args.includes('--self-test')) {
    runSelfTest()
    return
  }

  const { violations, closureSize, problems } = auditRepo(projectRoot)
  if (problems.length > 0) {
    console.error('❌ [verify-dsh-host-headless] 无法可信判定：')
    for (const p of problems) console.error(`   - ${p}`)
    exit(1)
  }
  if (violations.length > 0) {
    console.error(`❌ [verify-dsh-host-headless] ${HEADLESS_CRATE} 违反了 INV-6（严格 headless）：`)
    for (const v of violations) console.error(`   - ${v}`)
    console.error('   修法：把窗口层依赖移出 dsh-host；壳层需要的能力经 IPC / 回调注入。')
    exit(1)
  }
  console.log(
    `✅ [verify-dsh-host-headless] ${HEADLESS_CRATE} 闭包 ${closureSize} 个包，零窗口层依赖（INV-6 成立）`
  )
}

main()
