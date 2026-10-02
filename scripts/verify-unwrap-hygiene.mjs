#!/usr/bin/env node
/**
 * verify-unwrap-hygiene.mjs — 生产路径 `.unwrap()` 清零守卫（S4-4，治 D10）。
 *
 * ## 为什么需要这个脚本
 *
 * 缺陷治理计划 D10 的原始形态：`src-tauri/src/state.rs` 有 15 处生产
 * `lock().unwrap()`——`std::sync::Mutex` 的 poison 语义是「一个 panic 污染
 * 所有人」，一旦某个持锁期间 panic，此后**每一次**加锁都返回 `Err`，而每个
 * IPC 命令都要读状态机快照，于是「一次事故」升级成「整个壳每个命令都 panic」。
 *
 * 2026-10-02 已收敛为 0（`crate::poison` 中毒恢复 + 其余改错误传播 /
 * 带归因的 expect）。S4-4 的判据要求**守卫断言计数不回升**——否则下一个人
 * 图省事再写一个 `.unwrap()`，D10 会静默复活。本脚本就是那道网。
 *
 * ## 检查项
 *
 * | 编号 | 检查 | 级别 |
 * |------|------|------|
 * | U1 | 生产段 `.unwrap()` 计数为 0（`src-tauri/src` 与 crates 下每个 crate 的 `src`） | 错误 |
 * | U2 | 扫到的 `.rs` 文件数与生产段行数都 > 0（扫出数为 0 时先怀疑扫描器） | 错误 |
 *
 * 判定细节：
 *   · 「生产段」= 文件中首个顶格 `#[cfg(test)]` 之前的部分（本仓测试一律放在
 *     文件末尾的 `#[cfg(test)] mod tests`，无中段测试）；测试代码照常用 unwrap。
 *   · 行注释 / 块注释 / 单行字符串字面量里的 `.unwrap()` 不计入——文档示例
 *     （`/// let parsed = parse_env_overrides(&pairs).unwrap();`）是 Rust 文档
 *     的惯用写法，不是生产代码。
 *   · `.expect("原因")` **不算违规**：它自带归因，正是 S4-4 允许的形态
 *     （「确不可恢复的用带归因的 expect」）。
 *   · `.unwrap_or(...)` / `.unwrap_or_default()` 等以 `.unwrap` 开头的**其他**
 *     方法不算违规——判据精确匹配 `.unwrap()` 八个字符。
 *   · 已知盲区是**误报方向**（安全）：多行普通字符串 / 原样字符串里若出现
 *     `.unwrap()`，会被当成生产代码而报红。宁可误报也不漏报。
 *   · **没有允许清单**：这里每加一行「例外」，就等于替一处未审计的生产 unwrap
 *     背书。真需要例外，先改代码。
 *
 * ## 可证伪性
 *
 * `--self-test` 用临时目录夹具（不读仓库文件），期望值全部硬编码：
 * 修复前的真实形态（`state.rs` 的 `self.inner.lock().unwrap()`）必须报红；
 * 同一处改成 `.lock().expect("归因")` 必须转绿（证明判据真的在比对文本）；
 * 文档注释 / 块注释 / 字符串 / 测试段里的 `.unwrap()` 必须不误报；空扫描根
 * 必须判「扫描器失效」。
 *
 * ## 用法
 *
 *   node scripts/verify-unwrap-hygiene.mjs
 *   node scripts/verify-unwrap-hygiene.mjs --self-test
 *   node scripts/verify-unwrap-hygiene.mjs --json
 *
 * 退出码：`0` 通过 · `1` 有生产 unwrap / 扫描器失效 / 自检失败。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

/**
 * 扫描根：`src-tauri/src` + crates 下每个 crate 的 `src`（集成测试目录 tests/
 * 全部是测试代码，不是生产路径）。
 *
 * @param {string} root
 * @returns {string[]}
 */
export function scanRoots(root = projectRoot) {
  const roots = []
  const tauriSrc = join(root, 'src-tauri', 'src')
  if (existsSync(tauriSrc)) roots.push(tauriSrc)
  const cratesDir = join(root, 'crates')
  if (existsSync(cratesDir)) {
    for (const entry of readdirSync(cratesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const src = join(cratesDir, entry.name, 'src')
      if (existsSync(src)) roots.push(src)
    }
  }
  return roots
}

/**
 * 递归收集目录下全部 `.rs` 文件。
 *
 * @param {string} dir
 * @returns {string[]}
 */
function collectRsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectRsFiles(full))
    else if (entry.name.endsWith('.rs')) out.push(full)
  }
  return out
}

/**
 * 去掉一行的注释与字符串字面量（跨行块注释状态由 `state.block` 承载）。
 *
 * 逐字符而不是正则：正则处理不了「`//` 在字符串里」（`let s = "http://x"`）
 * 与「`/*` 在行注释里」这两种互为倒置的嵌套。
 *
 * @param {string} line
 * @param {{ block: boolean }} state
 * @returns {string} 只含代码字符的行
 */
export function stripNoise(line, state) {
  let out = ''
  let i = 0
  while (i < line.length) {
    if (state.block) {
      const end = line.indexOf('*/', i)
      if (end === -1) return out
      state.block = false
      i = end + 2
      continue
    }
    const two = line.slice(i, i + 2)
    // 行注释（//、///、//!）——本行余下整段不计
    if (two === '//') break
    // 块注释开始
    if (two === '/*') {
      state.block = true
      i += 2
      continue
    }
    // 单行双引号字符串（支持 \" 转义）；未闭合时到行尾为止
    if (line[i] === '"') {
      i += 1
      while (i < line.length) {
        if (line[i] === '\\') {
          i += 2
          continue
        }
        if (line[i] === '"') {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    out += line[i]
    i += 1
  }
  return out
}

/**
 * 数一个源文件**生产段**里的 `.unwrap()`。
 *
 * @param {string} text 文件全文
 * @returns {{ scanned: number, hits: { line: number, text: string }[] }}
 */
export function scanSource(text) {
  const lines = text.split(/\r?\n/)
  const state = { block: false }
  const hits = []
  let scanned = 0
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    // 生产段结束：本仓测试一律在文件末尾的 `#[cfg(test)] mod tests`
    if (!state.block && trimmed.startsWith('#[cfg(test)]')) break
    scanned += 1
    const code = stripNoise(lines[i], state)
    if (code.includes('.unwrap()')) hits.push({ line: i + 1, text: trimmed })
  }
  return { scanned, hits }
}

/**
 * 扫整个仓库（或夹具根）。
 *
 * @param {string} [root]
 * @returns {{ files: number, scanned: number, problems: string[] }}
 */
export function scanRepo(root = projectRoot) {
  let files = 0
  let scanned = 0
  const problems = []
  for (const scanRoot of scanRoots(root)) {
    for (const file of collectRsFiles(scanRoot)) {
      const { hits, scanned: fileScanned } = scanSource(readFileSync(file, 'utf8'))
      files += 1
      scanned += fileScanned
      const relative = file.slice(root.length + 1).split(sep).join('/')
      for (const hit of hits) {
        problems.push(`${relative}:${hit.line}：生产路径 .unwrap() —— ${hit.text}`)
      }
    }
  }
  return { files, scanned, problems }
}

// ---------------------------------------------------------------------------
// 自测（临时目录夹具；期望值硬编码，不用被测函数现算）
// ---------------------------------------------------------------------------

function selfTest() {
  let passed = 0
  const failures = []
  const eq = (name, actual, expected) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1
    else failures.push(`${name}\n    实际: ${JSON.stringify(actual)}\n    期望: ${JSON.stringify(expected)}`)
  }

  /** 在临时目录里按 {相对路径: 内容} 落一批夹具文件，返回根目录。 */
  const tempRootWith = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'unwrap-hygiene-'))
    try {
      for (const [relative, content] of Object.entries(files)) {
        const full = join(root, relative)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, content)
      }
    } catch (error) {
      rmSync(root, { recursive: true, force: true })
      throw error
    }
    return root
  }

  /** 扫完一个夹具根后必须回收临时目录（自测不往仓库留垃圾）。 */
  const scanTemp = (files) => {
    const root = tempRootWith(files)
    try {
      return scanRepo(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  // --- 夹具 1：正向——干净文件（expect + 测试段 unwrap + 文档注释 unwrap）---
  const clean = [
    '//! 模块文档',
    '',
    'use std::sync::Mutex;',
    '',
    '/// 文档示例（Rust 文档惯用写法，不是生产代码）：',
    '/// ```',
    '/// let parsed = parse_env_overrides(&pairs).unwrap();',
    '/// ```',
    'pub fn snapshot(mutex: &Mutex<u32>) -> u32 {',
    '    let guard = mutex.lock().expect("poison must be recovered");',
    '    *guard',
    '}',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    #[test]',
    '    fn parses() {',
    '        assert_eq!(parse("x").unwrap(), 1);',
    '    }',
    '}'
  ].join('\n')
  const cleanResult = scanTemp({ 'src-tauri/src/clean.rs': clean })
  eq('夹具1：干净文件（expect + 测试段 + 文档注释）→ 0 处生产 unwrap', cleanResult.problems, [])
  eq('夹具1：生产段确实被扫到（扫出数 > 0）', cleanResult.scanned > 0, true)

  // --- 夹具 2：**修复前的真实形态**（D10：state.rs 15 处之一）必须报红 ---
  const dirty = [
    'pub struct Supervisor {',
    '    inner: std::sync::Mutex<u32>,',
    '}',
    '',
    'impl Supervisor {',
    '    fn snapshot(&self) -> u32 {',
    '        // 修复前：锁中毒后这里 panic，此后每个命令都 panic',
    '        let inner = self.inner.lock().unwrap();',
    '        *inner',
    '    }',
    '}'
  ].join('\n')
  const dirtyResult = scanTemp({ 'src-tauri/src/dirty.rs': dirty })
  eq('夹具2：修复前的 lock().unwrap() 必须判红', dirtyResult.problems.length, 1)
  eq('夹具2：报错点名文件与行号', dirtyResult.problems[0], 'src-tauri/src/dirty.rs:8：生产路径 .unwrap() —— let inner = self.inner.lock().unwrap();')

  // --- 夹具 3：灵敏度——同一处改成带归因的 expect，结论必须翻转 ---
  const fixed = dirty.replace('self.inner.lock().unwrap()', 'self.inner.lock().expect("poison recovered by crate::poison")')
  eq(
    '夹具3：同一处 expect("归因") → 转绿（证明判据真的在比对文本）',
    scanTemp({ 'src-tauri/src/dirty.rs': fixed }).problems,
    []
  )

  // --- 夹具 4：块注释 / 字符串字面量里的 .unwrap() 不得误报 ---
  const noise = [
    'pub fn f() {',
    '    /* 历史备注：这里曾经是 self.inner.lock().unwrap() */',
    '    let shown = "call .unwrap() and see";',
    '    let url = "http://127.0.0.1:4173/?token=x";',
    '}'
  ].join('\n')
  eq('夹具4：块注释与字符串里的 .unwrap() 不计', scanTemp({ 'src-tauri/src/noise.rs': noise }).problems, [])

  // --- 夹具 5：unwrap_or / unwrap_or_default 等以 unwrap 开头的方法不算违规 ---
  const unwrapOr = [
    'pub fn g(port: Option<u16>) -> u16 {',
    '    let p = port.unwrap_or(0);',
    '    p.unwrap_or_default().max(1)',
    '}'
  ].join('\n')
  eq('夹具5：unwrap_or/unwrap_or_default 不是 unwrap', scanTemp({ 'src-tauri/src/unwrap_or.rs': unwrapOr }).problems, [])

  // --- 夹具 6：CRLF 与 LF 必须表现一致（守卫不得依赖行尾，§7.3）---
  const crlfDirty = dirty.split('\n').join('\r\n')
  eq(
    '夹具6：CRLF 下同一处必须同样判红',
    scanTemp({ 'src-tauri/src/dirty.rs': crlfDirty }).problems.length,
    1
  )
  const crlfClean = clean.split('\n').join('\r\n')
  eq('夹具6：CRLF 下干净文件同样通过', scanTemp({ 'src-tauri/src/clean.rs': crlfClean }).problems, [])

  // --- 夹具 7：crates/*/src 与嵌套子目录都在扫描面内 ---
  const nested = scanTemp({
    'crates/dsh-host/src/safe_mode.rs': dirty.replace('dirty.rs', 'safe_mode.rs'),
    'src-tauri/src/nested/deep.rs': dirty.replace('dirty.rs', 'deep.rs')
  })
  eq('夹具7：crates/ 与 src 嵌套子目录都扫到', nested.problems.length, 2)
  eq('夹具7：扫到的文件数为 2', nested.files, 2)

  // --- 夹具 8：空扫描根 → 判「扫描器失效」（扫出数为 0 纪律）---
  const emptyRoot = tempRootWith({ 'src-tauri/src/.keep': '' })
  try {
    const empty = scanRepo(emptyRoot)
    eq('夹具8：一个 .rs 都没扫到 → files=0（主流程据此判扫描器失效）', empty.files, 0)
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true })
  }

  // --- 夹具 9：stripNoise 的边界——字符串里的 // 与 /* 开启块注释 ---
  eq('stripNoise：字符串里的 // 不当注释', stripNoise('let s = "http://x";', { block: false }), 'let s = ;')
  eq('stripNoise：/* 开启块注释态（行内未闭合则本行余下不计）', stripNoise('x /* still code', { block: false }), 'x ')
  eq('stripNoise：// 先出现 → 整行余下是注释（哪怕里面还有 /*）', stripNoise('x // /* y', { block: false }), 'x ')
  eq('stripNoise：块注释跨行状态由 state 承载', stripNoise('still inside', { block: true }), '')

  if (failures.length > 0) {
    console.error('❌ verify-unwrap-hygiene 自测失败：')
    for (const failure of failures) console.error(`  · ${failure}`)
    process.exit(1)
  }
  console.log(`✅ verify-unwrap-hygiene 自测通过（${passed} 项）`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) selfTest()

  const { files, scanned, problems } = scanRepo()

  // U2：扫出数为 0 时先怀疑扫描器（本仓已踩两次：表格解析 / import 形态）。
  if (files === 0 || scanned === 0) {
    console.error('❌ 一个 .rs 生产段都没扫到——先怀疑扫描器，再怀疑源码（「扫出数为 0」纪律）')
    process.exit(1)
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ files, scanned, problems }, null, 2))
    process.exit(problems.length === 0 ? 0 : 1)
  }

  if (problems.length > 0) {
    console.error(`❌ 生产路径 .unwrap() ${problems.length} 处（S4-4 判据：计数必须为 0）：`)
    for (const problem of problems) console.error(`  · ${problem}`)
    console.error('')
    console.error('  修法：可恢复的走错误传播或中毒恢复（src-tauri/src/poison.rs）；')
    console.error('  确不可恢复的改成带归因的 .expect("原因") 并就地注释说明为何不可能失败。')
    console.error('  本守卫没有允许清单——每加一行例外，就是替一处未审计的生产 unwrap 背书。')
    process.exit(1)
  }

  console.log(`✅ 生产路径零 .unwrap()：${files} 个 .rs · 生产段 ${scanned} 行（测试段 / 文档注释 / 字符串不计）`)
  process.exit(0)
}

main()
