#!/usr/bin/env node
/**
 * verify-install-mode.mjs — 守住「安装形态判定不许再靠路径字符串猜」。
 *
 * ## 为什么需要这个守卫
 *
 * 2026-10-17 的缺陷不是写错了一个 `if`，而是**选错了一个 API 的语义**：
 * `PathResolver::executable_dir()` 返回的是「用户的可执行文件目录」（类 Unix 的
 * `~/.local/bin`），`tauri` 转调 `dirs`，而 `dirs` 在 Windows / macOS 上**硬编码**
 * 返回 `None`（`dirs-7.0.0/src/win.rs`、`src/mac.rs`）。于是链式 `map` 全部跳过、
 * `.unwrap_or(true)` 兜底生效：**任何**安装形态（含装在 `Program Files` 的 NSIS
 * 安装版）都被判成便携版，自动更新轮询从不启动。
 *
 * 这个错误**编译得过、clippy 不报、单测也能绿**（当时的判据函数是纯路径比较，
 * 只是拿到的输入永远是 `None`）。跨语言与跨 crate 的语义误用编译器看不见，只能靠
 * 静态守卫。
 *
 * ## 检查项
 *
 * | 编号 | 检查 | 级别 |
 * |------|------|------|
 * | A1 | 全仓 Rust 源码零命中 `executable_dir(` | 错误 |
 * | A2 | 扫描到的 Rust 文件数 > 0（E5-空 教训：扫出 0 不得冒充通过） | 错误 |
 * | A3 | 判据本体仍在 `crates/dsh-host/src/install.rs`（`classify` + `UNINSTALLER_NAME`） | 错误 |
 *
 * A3 守的是另一头：把判据删掉/改名同样会让 A1 静默变绿——「没有被禁止的写法」
 * 不等于「判据还在」。`AGENTS.md` §7.3 要求的「先扫后验」型守卫必须同时断言
 * **扫出数 > 0**，A2 就是那一条。
 *
 * ## 可证伪性（`--self-test` 的夹具）
 *
 * · **修复前形态**：`app.path().executable_dir()` ⇒ 必须报红；
 * · 修复后形态：`std::env::current_exe()` ⇒ 必须放行；
 * · 扫描集合为空 ⇒ 必须报红；
 * · 判据本体缺失 ⇒ 必须报红。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-install-mode.mjs              # 真检查
 * node scripts/verify-install-mode.mjs --self-test  # 纯逻辑自检
 * ```
 *
 * 退出码：`0` 通过 · `1` 有违规或自检失败 · `2` 参数错误。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 被禁止的写法：拿「用户的 bin 目录」当「当前 exe 所在目录」用。 */
const FORBIDDEN = 'executable_dir('

/** 判据本体的唯一产地。 */
const CLASSIFIER_PATH = join('crates', 'dsh-host', 'src', 'install.rs')

/** 判据必须同时具备的两个符号：判定函数与卸载器文件名常量。 */
const CLASSIFIER_MARKERS = ['pub fn classify(', 'UNINSTALLER_NAME']

/**
 * 扫一个文件集合，返回问题清单（纯函数：不碰文件系统，自检直接喂夹具）。
 *
 * @param {{path: string, text: string}[]} files 相对仓库根的 Rust 源文件
 * @param {{path: string, text: string} | null} classifier 判据本体（缺失传 null）
 * @returns {string[]} 人类可读的问题清单；空数组表示通过
 */
export function checkSources(files, classifier) {
  const problems = []

  // A2：扫描集合为空时必须报红——「没扫到东西」不得冒充「扫过且干净」。
  if (files.length === 0) {
    problems.push('扫描到 0 个 Rust 源文件：扫描器或根目录写坏了，这不等于「没有违规」')
  }

  // A1：语义误用的唯一写法。
  //
  // ⚠️ 只判**代码行**：判据本体的模块文档必须能写出「`dirs::executable_dir()` 在
  // Windows 上返回 None」这样的解释，否则守卫会逼着人把事故原因从文档里删掉。
  // 代价是写在字符串字面量里的同名字样不判——这里刻意接受：那条路径没有任何
  // 运行期消费者，真有人这么写，A3 与代码评审都还兜得住。
  for (const file of files) {
    const lines = file.text.split('\n')
    lines.forEach((line, index) => {
      if (line.trimStart().startsWith('//')) return
      if (line.includes(FORBIDDEN)) {
        problems.push(
          `${file.path}:${index + 1} 使用了 \`${FORBIDDEN}\`——它返回的是「用户的可执行文件目录」` +
            '（Windows / macOS 上恒为 None），不是当前 exe 所在目录。' +
            '安装形态请走 `dsh_host::install::classify_current()`。'
        )
      }
    })
  }

  // A3：判据本体必须还在，否则 A1 会因为「没人用」而假绿。
  if (!classifier) {
    problems.push(`判据本体缺失：${CLASSIFIER_PATH} 不存在（改名/移动后必须同步本守卫）`)
  } else {
    const missing = CLASSIFIER_MARKERS.filter((marker) => !classifier.text.includes(marker))
    if (missing.length > 0) {
      problems.push(`${classifier.path} 缺少判据符号：${missing.join('、')}（判据被删改了？）`)
    }
  }

  return problems
}

/** 递归收集 `.rs` 文件（跳过 `target` 与 `node_modules`）。 */
function collectRustFiles(roots) {
  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'target' || entry.name === 'node_modules' || entry.name.startsWith('.')) {
          continue
        }
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith('.rs')) {
        files.push({ path: relative(projectRoot, full).replaceAll('\\', '/'), text: readFileSync(full, 'utf8') })
      }
    }
  }
  for (const root of roots) {
    try {
      if (statSync(root).isDirectory()) walk(root)
    } catch {
      // 目录不存在：不做断言（crate 增删由 Cargo.toml 决定，不归本守卫管）
    }
  }
  return files
}

/** 真检查：扫仓库的工作区 crate 与壳层源码。 */
function realCheck() {
  const files = collectRustFiles([
    join(projectRoot, 'src-tauri', 'src'),
    join(projectRoot, 'crates'),
  ])

  let classifier = null
  try {
    const full = join(projectRoot, CLASSIFIER_PATH)
    classifier = { path: CLASSIFIER_PATH.replaceAll('\\', '/'), text: readFileSync(full, 'utf8') }
  } catch {
    classifier = null
  }

  const problems = checkSources(files, classifier)
  if (problems.length === 0) {
    console.log(`✅ 安装形态判定：扫描 ${files.length} 个 Rust 文件，零命中 \`${FORBIDDEN}\`，判据本体在位`)
    return 0
  }
  console.error(`❌ 安装形态判定：${problems.length} 个问题`)
  for (const problem of problems) console.error(`   - ${problem}`)
  return 1
}

/** 自检：夹具全部可证伪（每条都必须能让判定函数给出预期结论）。 */
function selfTest() {
  const failures = []
  const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) failures.push(`${label}\n     期望：${JSON.stringify(expected)}\n     实际：${JSON.stringify(actual)}`)
    console.log(`${ok ? '✅' : '❌'} ${label}`)
  }

  const classifierOk = { path: CLASSIFIER_PATH, text: 'pub fn classify(x: &Path) -> InstallMode {}\nconst UNINSTALLER_NAME: &str = "uninstall.exe";' }

  // 夹具 1：修复前形态必须报红（2026-10-17 的真实写法）。
  check(
    '修复前形态（executable_dir）必须报红',
    checkSources(
      [{ path: 'src-tauri/src/update.rs', text: 'app.path().executable_dir().ok()' }],
      classifierOk
    ).length > 0,
    true
  )

  // 夹具 2：修复后形态必须放行。
  check(
    '修复后形态（current_exe）必须放行',
    checkSources(
      [{ path: 'src-tauri/src/update.rs', text: 'dsh_host::install::classify_current()' }],
      classifierOk
    ),
    []
  )

  // 夹具 3：扫出 0 个文件必须报红（E5-空 教训）。
  check('扫描集合为空必须报红', checkSources([], classifierOk).length > 0, true)

  // 夹具 4：判据本体缺失必须报红（否则 A1 两头都能静默变绿）。
  check('判据本体缺失必须报红', checkSources([{ path: 'a.rs', text: 'fn main() {}' }], null).length > 0, true)

  // 夹具 5：判据被删一半（只剩常量）同样必须报红。
  check(
    '判据符号缺失必须报红',
    checkSources([{ path: 'a.rs', text: 'fn main() {}' }], {
      path: CLASSIFIER_PATH,
      text: 'const UNINSTALLER_NAME: &str = "uninstall.exe";'
    }).length > 0,
    true
  )

  if (failures.length > 0) {
    console.error(`\n自检失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`)
    return 1
  }
  console.log('\n✅ 安装形态判定守卫自检通过（5 项）')
  return 0
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) return selfTest()
  if (args.some((arg) => arg.startsWith('-'))) {
    console.error(`未知参数：${args.join(' ')}\n用法：node scripts/verify-install-mode.mjs [--self-test]`)
    return 2
  }
  return realCheck()
}

process.exit(main())
