#!/usr/bin/env node
/**
 * verify-profile-names.mjs — DSH profile 名保留字守卫。
 *
 * ## 为什么存在
 *
 * 官方 DSH 的桌面版（上游 `apps/desktop`，Electron）**独占** `$DSH_HOME/profiles/desktop`
 * ——它接管 `desktop` 及其**所有大小写变体**，并拒绝 CLI 对该 profile 执行 boot /
 * config-dump / 插件管理。任何第三方壳若自建一个叫 `desktop` 的 profile，都会与官方
 * 桌面版**正面撞车**，而且撞车的表现是「profile 被官方接管 / 起不来」，归因极难。
 *
 * 本仓库当前**没有**使用保留名（安全模式用的是 `desktop-safe-mode`，默认是裸子命令
 * `web`），所以这是一道**防回归守卫**而不是在修 bug——目的是让「哪天有人顺手把某个
 * profile 命名成 desktop」在 CI 就红，而不是等官方桌面版发布后才发现。
 *
 * ## 检查项
 *
 * | 编号 | 检查 | 级别 |
 * |------|------|------|
 * | P1 | 源码中不存在等于保留名（大小写不敏感）的 profile 字面量 | 错误 |
 * | P2 | `SAFE_MODE_PROFILE` 仍等于 `desktop-safe-mode`（改向保留名即 P1 命中） | 错误 |
 * | P3 | 默认 profile 仍是契约裸子命令 `HARNESS_CLI == "web"`（未被改成保留名） | 错误 |
 *
 * ## 可证伪性
 *
 * `--self-test` 把保留名判定函数喂给一组夹具（`desktop` / `Desktop` / `DESKTOP` /
 * `desktop-safe-mode` / `web`），断言**只有**保留名被标记。若有人把判定弱化成
 * 「精确小写比较」，`Desktop` 那一例立刻失败——这道守卫就不是装饰。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-profile-names.mjs
 * node scripts/verify-profile-names.mjs --self-test
 * ```
 *
 * 退出码：`0` 通过 · `1` 命中保留名或锚点漂移或自检失败。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { argv, exit } from 'node:process'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 官方保留的 profile 名（**大小写不敏感**：官方接管全部大小写变体）。
 * 新增保留名时只改这里，判定与自检都会跟着走。
 */
const RESERVED_PROFILE_NAMES = ['desktop']

/** 本仓库安全模式 profile 的期望值（锚点，见 crates/dsh-host/src/safe_mode.rs）。 */
const EXPECTED_SAFE_MODE_PROFILE = 'desktop-safe-mode'
/** 契约默认 profile（裸子命令，见 crates/dsh-contracts/src/constants.rs）。 */
const EXPECTED_HARNESS_CLI = 'web'

/** 只扫「可能定义启动 profile 名」的源码区，避免 vendor/ 里的无关 `profile:` 误报。 */
const SCAN_ROOTS = ['crates', join('src-tauri', 'src'), 'scripts', 'build']
const SCAN_EXTENSIONS = new Set(['.rs', '.mjs', '.cjs', '.yml', '.yaml', '.json'])
const SKIP_DIRS = new Set(['node_modules', 'target', 'resources', 'harness-deps', '.git', 'dist'])

/**
 * 该 profile 名是否被官方保留。
 * @param {string} name
 * @returns {boolean}
 */
export function isReservedProfile(name) {
  return RESERVED_PROFILE_NAMES.includes(String(name ?? '').trim().toLowerCase())
}

/** 某下标所在行号（1 基）。 */
function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

/**
 * 从单份源码里抽取「看起来是 profile 名」的字面量。纯函数，便于自检。
 *
 * 三种形态：
 *   A. Rust 常量 `const <名含 PROFILE>: &str = "..."`；
 *   B. YAML 键 `profile: <name>`；
 *   C. `--profile` 紧随的字符串字面量（`vec!["--profile", "work"]` 这类）。
 *
 * @param {string} file 文件路径（写进结果，供定位）
 * @param {string} text 文件内容
 * @returns {{name:string,kind:string,file:string,line:number}[]}
 */
export function extractProfileCandidates(file, text) {
  const out = []
  const push = (name, kind, index) => {
    if (name) out.push({ name, kind, file, line: lineOf(text, index) })
  }

  for (const m of (text ?? '').matchAll(
    /const\s+([A-Z0-9_]*PROFILE[A-Z0-9_]*)\s*:\s*&(?:'static\s+)?str\s*=\s*"([^"]*)"/g
  )) {
    push(m[2], `const ${m[1]}`, m.index)
  }

  for (const m of (text ?? '').matchAll(/^[ \t]*profile[ \t]*:[ \t]*["']?([A-Za-z0-9_-]+)["']?[ \t]*$/gm)) {
    push(m[1], 'yml profile:', m.index)
  }

  for (const m of (text ?? '').matchAll(/["']--profile["'][^\n]{0,60}?["']([A-Za-z0-9_-]+)["']/g)) {
    push(m[1], '--profile 字面量', m.index)
  }

  return out
}

/**
 * 从候选里挑出命中保留名的那些。
 * @param {{name:string}[]} candidates
 * @returns {{name:string}[]}
 */
export function auditProfileNames(candidates) {
  return (candidates ?? []).filter((c) => isReservedProfile(c.name))
}

/**
 * 递归收集待扫描文件。
 *
 * **排除本脚本自身**：它的 `--self-test` 里含有 `"Desktop"` / `"desktop"` 等
 * **有意为之的夹具字面量**，若把自己也扫进去，守卫会对自己的测试数据报警
 * （自指误报）。守卫脚本不是产品代码，不参与 profile 命名。
 *
 * @returns {string[]} 绝对路径列表
 */
function collectFiles() {
  const selfPath = resolve(fileURLToPath(import.meta.url))
  const files = []
  const walk = (dir) => {
    let entries = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue
      const full = join(dir, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
      } else if (SCAN_EXTENSIONS.has(extname(entry).toLowerCase()) && resolve(full) !== selfPath) {
        files.push(full)
      }
    }
  }
  for (const root of SCAN_ROOTS) walk(join(projectRoot, root))
  return files
}

/** 读取第一个匹配捕获组。 */
function capture(file, pattern) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const m = pattern.exec(text)
  return m ? m[1] : null
}

/** 自检：可证伪性——保留名判定必须对大小写变体一律命中。 */
function selfTest() {
  let failed = 0
  const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) {
      failed += 1
      console.error(`FAIL ${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
    } else {
      console.log(`PASS ${label}`)
    }
  }

  // 保留名：三种大小写都必须命中（弱化成精确小写比较时，后两例即红）
  check('isReservedProfile(desktop)', isReservedProfile('desktop'), true)
  check('isReservedProfile(Desktop)', isReservedProfile('Desktop'), true)
  check('isReservedProfile(DESKTOP)', isReservedProfile('DESKTOP'), true)
  check('isReservedProfile( desktop )', isReservedProfile('  desktop  '), true)
  // 非保留名：不得误伤
  check('isReservedProfile(desktop-safe-mode)', isReservedProfile('desktop-safe-mode'), false)
  check('isReservedProfile(web)', isReservedProfile('web'), false)
  check('isReservedProfile(default)', isReservedProfile('default'), false)
  check('isReservedProfile(empty)', isReservedProfile(''), false)

  // 抽取 + 审计：夹具里保留名恰好被挑出
  const fixture = [
    'const SAFE_MODE_PROFILE: &str = "desktop-safe-mode";',
    'const OTHER_PROFILE: &str = "Desktop";',
    '    profile: web',
    'args.extra = vec!["--profile".into(), "desktop".into()];'
  ].join('\n')
  const candidates = extractProfileCandidates('fixture.rs', fixture)
  const hits = auditProfileNames(candidates).map((c) => c.name).sort()
  check('audit(夹具) 命中集合', hits, ['Desktop', 'desktop'])
  // 可证伪性：干净夹具必须零命中（否则守卫会对正常代码误报）
  const clean = extractProfileCandidates(
    'clean.yml',
    'const SAFE_MODE_PROFILE: &str = "desktop-safe-mode";\n    profile: web\n'
  )
  check('audit(干净夹具) 零命中', auditProfileNames(clean), [])

  if (failed > 0) {
    console.error(`verify-profile-names self-test: ${failed} 项失败`)
    exit(1)
  }
  console.log('verify-profile-names self-test: 全部通过（保留名大小写变体均命中）')
}

/** 主流程。 */
function run() {
  const files = collectFiles()
  const candidates = []
  for (const file of files) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    candidates.push(...extractProfileCandidates(file, text))
  }

  const errors = []
  const rel = (f) => relative(projectRoot, f).replace(/\\/g, '/')
  const reservedJoined = RESERVED_PROFILE_NAMES.join(', ')

  // P1：不得出现保留名字面量
  for (const hit of auditProfileNames(candidates)) {
    errors.push(
      `P1  ${rel(hit.file)}:${hit.line} —— profile 字面量 "${hit.name}"（${hit.kind}）命中官方保留名 [${reservedJoined}]。` +
        `官方桌面版独占该 profile 及其大小写变体，改名是唯一修法`
    )
  }

  // P2：安全模式 profile 锚点
  const safeMode = capture(
    join(projectRoot, 'crates', 'dsh-host', 'src', 'safe_mode.rs'),
    /pub const SAFE_MODE_PROFILE\s*:\s*&str\s*=\s*"([^"]*)"/
  )
  if (safeMode !== EXPECTED_SAFE_MODE_PROFILE) {
    errors.push(
      `P2  SAFE_MODE_PROFILE 期望 "${EXPECTED_SAFE_MODE_PROFILE}"，实际 "${safeMode}"。` +
        `该常量是安全模式启动的契约锚点，改动必须同步 AGENTS.md §7.2 与启动链路`
    )
  }

  // P3：默认 profile 锚点
  const harnessCli = capture(
    join(projectRoot, 'crates', 'dsh-contracts', 'src', 'constants.rs'),
    /pub const HARNESS_CLI\s*:\s*&str\s*=\s*"([^"]*)"/
  )
  if (harnessCli !== EXPECTED_HARNESS_CLI) {
    errors.push(
      `P3  HARNESS_CLI 期望 "${EXPECTED_HARNESS_CLI}"（默认裸子命令），实际 "${harnessCli}"`
    )
  }

  console.log('[verify-profile-names] DSH profile 保留名检查')
  console.log(`  · 扫描 ${files.length} 个源文件 · 抽取 profile 候选 ${candidates.length} 个`)
  console.log(`  · 保留名：${reservedJoined}（大小写不敏感）`)
  console.log(`  · SAFE_MODE_PROFILE = ${safeMode} · HARNESS_CLI = ${harnessCli}`)
  console.log('')
  for (const item of errors) console.log(`  ❌ ${item}`)
  if (errors.length === 0) {
    console.log('  ✅ 未使用任何官方保留 profile 名')
    return
  }
  console.log(`\n  ${errors.length} 处问题。`)
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
