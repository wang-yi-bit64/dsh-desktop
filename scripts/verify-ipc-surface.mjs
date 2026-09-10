#!/usr/bin/env node
/**
 * verify-ipc-surface.mjs — 壳「命令面 / 事件面 / 页面面」一致性检查。
 *
 * ## 为什么需要这个脚本
 *
 * `src-tauri` 是一个 **rlib**，Rust 里 `pub` 的项在 clippy 看来都是「可达」的，
 * 因此 **`dead_code` 永远不会报出「写了但没人调用」的公开函数**。这个盲区已经
 * 造成过真实事故：
 *
 *   - `frontend/error.html` 调用 `invoke('harness_start_safe_mode')`，而注册名是
 *     `safe_mode_action`。命令根本不存在，异常又被 `.catch(console.error)` 吞掉，
 *     用户点「进入安全模式」毫无反应，也没有任何报错。
 *   - `window::show_recovery_page` / `show_safe_mode_page` 带着
 *     `#[allow(dead_code)]` 躺着，零调用方 → `plugin-recovery.html` /
 *     `safe-mode.html` 根本不可达，配套命令自然也没有调用方。
 *
 * 这类断线跨语言（Rust ↔ HTML ↔ CI），编译器看不见，只能靠跨文件比对。
 *
 * ## 检查项
 *
 * | 编号 | 检查 | 级别 |
 * |------|------|------|
 * | E1 | 每个 `#[tauri::command]` 定义都出现在 `generate_handler!` 中 | 错误 |
 * | E2 | 每个注册项都有对应定义（防拼写漂移） | 错误 |
 * | E3 | 每个 `invoke('x')` 的 x 都已被注册 | **错误（捕获 D6）** |
 * | E4 | 每个 Rust 侧 `emit` 的事件都有 ≥1 个前端 `listen` | 错误 |
 * | E5 | 每个 `local_page("x.html")` 目标都真实存在于 `frontend/` | 错误 |
 * | E6 | 每处 `#[allow(dead_code)]` 都在登记表里写明理由与销账批次 | 错误 |
 * | W1 | 已注册但前端从未调用的命令（死 IPC 面） | 警告 |
 * | W2 | `frontend/` 下从未被任何 `local_page` 指向的页面（不可达页） | 警告 |
 *
 * 错误一律退出码 1；警告默认只提示，加 `--strict` 后同样失败。
 * 允许清单在下方 `ALLOW_*`，**每一条都必须写明理由**——留空等于掩盖问题。
 *
 * 用法：
 *   node scripts/verify-ipc-surface.mjs
 *   node scripts/verify-ipc-surface.mjs --strict
 *   node scripts/verify-ipc-surface.mjs --json
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const commandsPath = join(projectRoot, 'src-tauri', 'src', 'commands.rs')
const libPath = join(projectRoot, 'src-tauri', 'src', 'lib.rs')
const srcDir = join(projectRoot, 'src-tauri', 'src')
const frontendDir = join(projectRoot, 'src-tauri', 'frontend')

const argv = process.argv.slice(2)
const strict = argv.includes('--strict')

// ---------------------------------------------------------------------------
// 允许清单：每条都必须有理由
// ---------------------------------------------------------------------------

/**
 * 已注册但前端从未调用的命令。
 *
 * 注意：把命令加到这里**不是**修复，只是承认它当前没有 UI。任何新增条目都
 * 必须写清「为什么暂时留着」，否则应直接删除命令——死代码要么接上，要么删掉。
 *
 * **现在是空的，这是目标状态**。历史销账记录（保留以防有人想把它们加回来）：
 *
 * - `updates_*` / `safe_mode_action` —— 批次 B2 接线（updates.html、error.html）。
 * - `recovery_action` / `recovery_status` / `recovery_open` —— 批次 C1 接线
 *   （plugin-recovery.html）。
 * - `open_external` —— 批次 G **删除**，不是接线。它的职责（把外部链接交给系统
 *   浏览器）已由导航白名单在 Rust 侧完成：`lib.rs` 的 `on_navigation` /
 *   `on_new_window` 命中 `NavigationDecision::External` 时直接 `opener.open_url`。
 *   命令面再留一个入口等于同一能力开两条路，且这两条路的放行规则还要各自维护
 *   （`is_openable_external` vs `decide_navigation`）——留下它是负债不是资产。
 */
const ALLOW_UNUSED_COMMANDS = {}

/**
 * 未被任何 `local_page(...)` 指向的页面。
 */
const ALLOW_UNREACHABLE_PAGES = {
  // index.html 由窗口初始 WebviewUrl::App("index.html") 加载，不经 local_page。
  'index.html': '作为窗口初始 WebviewUrl::App 加载，非 local_page 导航'
}

/**
 * 允许「无监听方」的事件。留空即为不允许。
 */
const ALLOW_UNLISTENED_EVENTS = {
  // 批次 B2（2026-09-10）已接线：`frontend/updates.html` 监听 `updates://status`。
  // 此清单的依据是「有没有监听方」，接线后必须销账，否则它会变成一句过期的
  // 谎话——下一个读到这里的人会以为事件仍然没人听。
}

/**
 * `#[allow(dead_code)]` 的登记表。
 *
 * 这个属性在本仓库里几乎等价于一句自白：「我写了它，但没接线」。它同时**屏蔽
 * 了编译器唯一可能提醒我们的信号**，所以每一处都必须在这里登记理由与销账批次。
 * 键的格式为 `<文件名>:<项名>`。
 *
 * 判据：能接线就接线，**不能接线就删除**。「留给后续阶段」不是保留理由——
 * 那正是这些代码躺到今天的原因。
 *
 * 批次 C（2026-09-10）销账了四处：`window.rs` 的两个页面函数与 `urlencoding`
 * 已接线/删除，`recovery.rs` 的模块级抑制随恢复页接入 `dsh_host::diagnostics`
 * 的真实消费而移除。**这张表现在为空是目标状态**——每加一条都是欠债。
 */
const ALLOW_DEAD_CODE_ALLOW = {}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 读取文件，缺失时返回空串（调用方负责判空）。
 * @param {string} file 路径
 * @returns {string} 内容
 */
function read(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/**
 * 列出 `src-tauri/src` 与各 `crates/<name>/src` 下的全部 `.rs` 文件。
 *
 * 必须覆盖 `crates/`：`dsh-host-cli` 里也有「留给未来」的死代码，而它是
 * 无头门禁的一部分，断在这里同样不会被任何测试发现。
 * @returns {string[]} 绝对路径列表
 */
function rustSources() {
  const roots = [srcDir]
  const cratesDir = join(projectRoot, 'crates')
  if (existsSync(cratesDir)) {
    for (const entry of readdirSync(cratesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(cratesDir, entry.name, 'src')
      if (existsSync(candidate)) roots.push(candidate)
    }
  }

  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.rs')) out.push(full)
    }
  }
  for (const root of roots) walk(root)
  return out
}

/**
 * 列出 `frontend/` 下全部页面与脚本（不含二进制资源）。
 * @returns {string[]} 绝对路径列表
 */
function frontendFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (/\.(html|js|mjs)$/i.test(entry.name)) {
        out.push(full)
      }
    }
  }
  if (existsSync(frontendDir)) walk(frontendDir)
  return out
}

/**
 * 收集命中的捕获组。
 * @param {string} text 文本
 * @param {RegExp} pattern 必须带 g 标志
 * @param {number} [group] 捕获组序号
 * @returns {string[]} 去重排序后的结果
 */
function collect(text, pattern, group = 1) {
  const found = new Set()
  for (const match of text.matchAll(pattern)) {
    found.add(match[group])
  }
  return [...found].sort()
}

/** 从 commands.rs 解析命令定义名。 */
function parseDefined(text) {
  return collect(text, /#\[tauri::command\]\s*\n\s*pub\s+(?:async\s+)?fn\s+([a-z_][a-z0-9_]*)/g)
}

/** 从 lib.rs 的 generate_handler! 解析注册名。 */
function parseRegistered(text) {
  const block = text.match(/generate_handler!\[([\s\S]*?)\]/)
  if (!block) return []
  return collect(block[1], /commands::([a-z_][a-z0-9_]*)/g)
}

/**
 * 解析前端的「按名字引用命令」的调用点。
 *
 * 不能只认 `invoke('x')`：页面往往把调用包一层（例如 `run(command, label, ...)`
 * 这种统一处理失败提示的包装），此时命令名只以字符串字面量的形式出现在包装
 * 函数的**调用**处，而 `invoke(` 只出现在包装函数的**定义**里。
 *
 * 因此这里识别包装函数：**函数体里含 `invoke(` 的函数名**即视为包装器，
 * 其调用处的首个字符串参数就是命令名。这样新增一层包装不需要改本脚本。
 *
 * # 为什么用花括号配对而不是正则截取函数体
 *
 * 初版用 `/\{([\s\S]*?)\n\s*\}/` 抓函数体，**会在第一个内层 `}` 处截断**：
 * 页面里 `function run(...) { if (!invoke) { return } ... invoke(command, args) ... }`
 * 这种以带花括号的 `if` 开头的包装器，截出来的「函数体」根本不含 `invoke(`，
 * 于是包装器识别失败 → 它调用的所有命令都被判成「无调用方」。这不是假想：
 * 它真实地把 `logs_read` / `recovery_action` / `recovery_status` 三个**已接线**
 * 的命令报成了断线。守卫的假阳性会让人不再看它的输出，和假阴性一样有害。
 * @param {string[]} files 前端文件列表
 * @returns {Map<string, string[]>} 命令名 → 出现位置
 */
function parseInvoked(files) {
  const map = new Map()
  const add = (name, where) => {
    const list = map.get(name) ?? []
    list.push(where)
    map.set(name, list)
  }

  for (const file of files) {
    const text = read(file)
    const where = file.slice(projectRoot.length + 1)

    // 1) 包装函数名：函数声明或箭头函数赋值，其**完整函数体**含 invoke(
    const wrappers = new Set()
    const pattern =
      /(?:function\s+(\w+)\s*\([^)]*\)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)\s*\{/g
    for (const match of text.matchAll(pattern)) {
      const name = match[1] ?? match[2]
      if (!name) continue
      const bodyStart = match.index + match[0].length
      const body = extractBracedBody(text, bodyStart)
      if (body && /\binvoke\s*\(/.test(body)) wrappers.add(name)
    }

    // 2) 直接调用
    for (const match of text.matchAll(/invoke\(\s*['"]([a-z_][a-z0-9_]*)['"]/g)) {
      add(match[1], where)
    }
    // 3) 经包装函数调用
    for (const wrapper of wrappers) {
      const called = new RegExp(`\\b${wrapper}\\(\\s*['"]([a-z_][a-z0-9_]*)['"]`, 'g')
      for (const match of text.matchAll(called)) {
        add(match[1], `${where}（经 ${wrapper}()）`)
      }
    }
  }
  return map
}

/**
 * 从 `{` 之后的位置起，按花括号配对取出完整函数体。
 *
 * 不认识字符串与正则字面量（本仓库的前端是手写内联脚本，没有需要转义的花括号
 * 出现在字符串里的情况）；这是刻意的简化——精确的 JS 词法分析属于「为了一个
 * 静态检查脚本而引入解析器」，收益不抵成本。
 * @param {string} text 全文
 * @param {number} start 函数体第一个字符的下标（`{` 之后）
 * @returns {string|null} 函数体文本；括号不配对时返回 null
 */
function extractBracedBody(text, start) {
  let depth = 1
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index)
    }
  }
  return null
}

/**
 * 解析 dead-code 抑制属性的出现处。
 *
 * 两种形式都要抓：
 * - `#[allow(dead_code)]` —— 作用于下一个项
 * - `#![allow(dead_code)]` —— **模块级**，作用于整个模块（`recovery.rs` 用了一整条），
 *   危害更大：它能让一个有问题的模块在编译器眼里彻底隐形。
 *
 * 判据：能接线就接线，**不能接线就删除**。「留给后续阶段」不是保留理由——
 * 那正是这些代码躺到今天的原因。
 *
 * 两处刻意的设计：
 * - **只取文件名做键**（`state.rs:is_ready`），避免不同平台的路径分隔符导致
 *   同一处问题在两个平台上被判定为不同项。
 * - **跳过 `#[cfg(test)]` 之后的区域**：测试模块里的抑制属性是正常做法
 *   （测试辅助构造器在非测试构建下确实无人使用），算作断线会制造误报，
 *   反而让人不再看这个检查。约定测试模块位于文件末尾。
 *
 * @returns {{key: string, file: string, line: number, module: boolean}[]} 出现处
 */
function parseDeadCodeAllows() {
  const found = []
  for (const file of rustSources()) {
    const lines = read(file).split(/\r?\n/)
    const shortName = file.slice(projectRoot.length + 1).split(/[\\/]/).pop()
    const testModuleAt = lines.findIndex((line) => /#\[cfg\(test\)\]/.test(line))
    lines.forEach((line, index) => {
      // 注释里的 `#[allow(dead_code)]` 是**说明文字**，不是抑制属性。
      // 不排除注释会产生假阳性：本仓 `commands.rs` 的文档注释里正好引用了这个
      // 属性名（解释恢复页的旧实现为何带着它躺了半年），于是守卫把一个已销账的
      // 文件报成未登记断线。误报会消耗读者对这个检查的信任，必须过滤。
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//')) return
      const isModule = /#!\[allow\(dead_code[^)]*\)\]/.test(line)
      const isItem = /#\[allow\(dead_code[^)]*\)\]/.test(line)
      if (!isModule && !isItem) return
      if (testModuleAt >= 0 && index > testModuleAt) return
      if (isModule) {
        found.push({ key: `${shortName}:!module`, file: shortName, line: index + 1, module: true })
        return
      }
      // 属性下面的第一个 fn / const / struct / enum / 字段声明
      let item = '(unknown)'
      for (let cursor = index + 1; cursor < Math.min(index + 8, lines.length); cursor += 1) {
        const match =
          lines[cursor].match(/\b(?:fn|const|static|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/) ??
          lines[cursor].match(/^\s*(?:pub\s+)?([a-z_][a-z0-9_]*)\s*:/)
        if (match) {
          item = match[1]
          break
        }
      }
      found.push({ key: `${shortName}:${item}`, file: shortName, line: index + 1, module: false })
    })
  }
  return found
}

/** 从 Rust 源码解析「会被 emit 的事件名」。 */
function parseEmittedEvents() {
  const names = new Set()
  for (const file of rustSources()) {
    const text = read(file)
    // 事件名以字符串常量的形式出现：`pub const X: &str = "harness://status";`
    for (const match of text.matchAll(/"([a-z][a-z0-9-]*:\/\/[a-z0-9-]+)"/g)) {
      names.add(match[1])
    }
  }
  return [...names].sort()
}

/** 从 frontend 解析 listen 的事件名。 */
function parseListenedEvents(files) {
  const names = new Set()
  for (const file of files) {
    for (const match of read(file).matchAll(/listen\(\s*['"]([^'"]+)['"]/g)) {
      names.add(match[1])
    }
  }
  return [...names].sort()
}

/** 从 Rust 源码解析 `local_page("x.html")` 的字面量目标。 */
function parseLocalPageTargets() {
  const targets = new Set()
  for (const file of rustSources()) {
    const text = read(file)
    for (const match of text.matchAll(/local_page\(\s*"([^"]+)"/g)) {
      // 形如 `plugin-recovery.html?plugins=…` 也要还原成文件名。
      targets.add(match[1].split('?')[0])
    }
  }
  return [...targets].sort()
}

/** 列出 frontend 下的页面文件名。 */
function parseFrontendPages() {
  if (!existsSync(frontendDir)) return []
  return readdirSync(frontendDir)
    .filter((name) => name.endsWith('.html'))
    .sort()
}

// ---------------------------------------------------------------------------
// 执行检查
// ---------------------------------------------------------------------------

const errors = []
const warnings = []
const notes = []

function error(id, message) {
  errors.push({ id, message })
}

function warn(id, message) {
  warnings.push({ id, message })
}

function run() {
  const commandsText = read(commandsPath)
  const libText = read(libPath)
  const files = frontendFiles()

  if (!commandsText) {
    error('E0', `找不到 ${commandsPath.slice(projectRoot.length + 1)}`)
    return
  }
  if (!libText) {
    error('E0', `找不到 ${libPath.slice(projectRoot.length + 1)}`)
    return
  }

  const defined = parseDefined(commandsText)
  const registered = parseRegistered(libText)
  const invoked = parseInvoked(files)
  const emitted = parseEmittedEvents()
  const listened = parseListenedEvents(files)
  const pageTargets = parseLocalPageTargets()
  const pages = parseFrontendPages()

  notes.push(`命令：定义 ${defined.length} · 注册 ${registered.length} · 被前端调用 ${invoked.size}`)
  notes.push(`事件：Rust 发出 ${emitted.length} · 前端监听 ${listened.length}`)
  notes.push(`页面：frontend 下 ${pages.length} · 被 local_page 指向 ${pageTargets.length}`)

  // E1 / E2：定义 ↔ 注册 双向一致
  for (const name of defined) {
    if (!registered.includes(name)) {
      error('E1', `命令 \`${name}\` 已定义但未注册进 generate_handler!（前端调用会报 command not found）`)
    }
  }
  for (const name of registered) {
    if (!defined.includes(name)) {
      error('E2', `generate_handler! 注册了 \`${name}\`，但 commands.rs 中没有对应定义`)
    }
  }

  // E3：调用面 ⊆ 注册面 —— 这一条正是用来捕获 D6 那类静默失效的
  for (const [name, sites] of invoked) {
    if (!registered.includes(name)) {
      error(
        'E3',
        `前端调用了未注册的命令 \`${name}\`（${sites.join(', ')}）——运行时会静默失败`
      )
    }
  }

  // E4：事件发出面 ⊆ 监听面
  for (const name of emitted) {
    if (!listened.includes(name) && !(name in ALLOW_UNLISTENED_EVENTS)) {
      error('E4', `Rust 发出事件 \`${name}\`，但没有任何前端页面 listen 它（状态变更对用户不可见）`)
    }
  }

  // E5：local_page 目标必须存在
  for (const target of pageTargets) {
    if (!pages.includes(target)) {
      error('E5', `local_page("${target}") 指向的页面不在 src-tauri/frontend/ 下（导航将失败）`)
    }
  }

  // W1：注册但无人调用
  for (const name of registered) {
    if (invoked.has(name)) continue
    if (name in ALLOW_UNUSED_COMMANDS) {
      warn('W1', `命令 \`${name}\` 无前端调用方（已登记：${ALLOW_UNUSED_COMMANDS[name]}）`)
    } else {
      error(
        'W1',
        `命令 \`${name}\` 无任何调用方且未登记。死代码要么接上、要么删除；` +
          `若确需保留，请在 ALLOW_UNUSED_COMMANDS 中写明理由`
      )
    }
  }

  // W2：不可达页面
  for (const page of pages) {
    if (pageTargets.includes(page)) continue
    if (page in ALLOW_UNREACHABLE_PAGES) {
      warn('W2', `页面 \`${page}\` 不走 local_page（已登记：${ALLOW_UNREACHABLE_PAGES[page]}）`)
    } else {
      error(
        'W2',
        `页面 \`${page}\` 从未被任何 local_page 指向——它被打进应用却不可达。` +
          `要么接线，要么在 ALLOW_UNREACHABLE_PAGES 中写明理由`
      )
    }
  }

  // E6：#[allow(dead_code)] 是「写了但没接线」的自我申报，必须逐条登记
  const deadCode = parseDeadCodeAllows()
  for (const site of deadCode) {
    if (site.key in ALLOW_DEAD_CODE_ALLOW) {
      warn('E6', `\`${site.key}\`（${site.file}:${site.line}）带 #[allow(dead_code)]（已登记：${ALLOW_DEAD_CODE_ALLOW[site.key]}）`)
    } else {
      error(
        'E6',
        `\`${site.key}\`（${site.file}:${site.line}）带 #[allow(dead_code)] 且未登记。` +
          `该属性屏蔽了编译器对未接线代码的唯一提醒，请在 ALLOW_DEAD_CODE_ALLOW 中写明销账批次`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

run()

if (argv.includes('--json')) {
  console.log(JSON.stringify({ notes, errors, warnings, strict }, null, 2))
} else {
  console.log('[verify-ipc-surface] 壳接口面一致性检查')
  for (const note of notes) console.log(`  · ${note}`)
  console.log('')
  for (const item of warnings) console.log(`  ⚠️  ${item.id}  ${item.message}`)
  for (const item of errors) console.log(`  ❌ ${item.id}  ${item.message}`)
  if (errors.length === 0 && warnings.length === 0) {
    console.log('  ✅ 命令面、事件面、页面面三向一致')
  } else if (errors.length === 0) {
    console.log(`\n  ${warnings.length} 条已知缺口（均为已登记项）。加 --strict 可将其视为失败。`)
  } else {
    console.log(`\n  ${errors.length} 处断线、${warnings.length} 条已知缺口。`)
  }
}

const failed = errors.length > 0 || (strict && warnings.length > 0)
process.exit(failed ? 1 : 0)
