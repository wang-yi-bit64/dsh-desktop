#!/usr/bin/env node
/**
 * verify-shell-pages.mjs — 壳内静态页的**运行时**冒烟检查。
 *
 * ## 为什么需要它
 *
 * `verify-ipc-surface.mjs` 只比对**命令名**：它知道「页面调用的命令必须已注册」，
 * 但它不知道页面本身跑不跑得起来。两类真实缺陷正好落在它的盲区里：
 *
 * 1. **运行期引用错误**。`document.getElementById('x')` 取到不存在的 id 会返回
 *    `null`，随后 `.addEventListener` 直接抛 `TypeError`——而内联脚本是**从上往下**
 *    执行的，抛错之后**整页所有按钮都失去监听**。表现为「页面能显示，但点什么都没
 *    反应」，与「命令名拼错」是两种不同的病，症状却一样。
 * 2. **按钮渲染了但没接线**。改版页面时最典型的漏：HTML 里留了一个按钮，脚本里
 *    忘了给它 `addEventListener`。页面看着完整，那个按钮是死的。
 *
 * 本脚本把每个页面的内联脚本放进一个**最小 DOM 桩**里真跑一遍，并断言：
 *
 * | 编号 | 检查 | 级别 |
 * |------|------|------|
 * | P1 | 脚本读取的每个 id 都在该页 HTML 中声明 | 错误 |
 * | P2 | 脚本在 DOM 桩中执行不抛错（含逐个点按钮） | 错误 |
 * | P3 | 脚本调用的每个 `invoke('cmd')` 都已在 `lib.rs` 注册 | 错误 |
 * | P4 | HTML 里每个 `<button>` 都挂上了 click 监听 | 错误 |
 * | P5 | 以模板字面量拼出的 id（`` `tab-${x}` ``）前缀至少匹配一个已声明 id | 警告 |
 * | P6 | 调用命令的页面必须解包封套（脚本里出现 `success`） | 错误 |
 *
 * ## 这个桩**不**做什么
 *
 * 不渲染、不布局、不跑 CSS。它**不能**替代视觉验收（那由 `smoke-launch.mjs` 的
 * L2 GUI 烟雾与人工目视承担），也不检查命令的**参数形状**。它只回答一个问题：
 * **脚本加载完成后，是不是所有该挂的监听都挂上了。**
 *
 * ## 用法
 *
 *   node scripts/verify-shell-pages.mjs
 *   node scripts/verify-shell-pages.mjs --strict
 *   node scripts/verify-shell-pages.mjs --json
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const frontendDir = join(projectRoot, 'src-tauri', 'frontend')
const libPath = join(projectRoot, 'src-tauri', 'src', 'lib.rs')

const argv = process.argv.slice(2)
const strict = argv.includes('--strict')
const json = argv.includes('--json')

const errors = []
const warnings = []
const notes = []

const error = (id, message) => errors.push({ id, message })
const warn = (id, message) => warnings.push({ id, message })

// ---------------------------------------------------------------------------
// HTML 解析（只取本检查需要的东西）
// ---------------------------------------------------------------------------

/**
 * 收集页面里的元素声明：id → { classes, tag }。
 *
 * 逐标签解析而不是逐 `id="…"` 正则扫描：后者拿不到元素上还有哪些类，而
 * `document.querySelectorAll('.tab')` 这类绑定（`logs.html` 用它绑标签页）
 * 正需要类信息才不会误报成「没挂监听」。
 * @param {string} html 页面全文
 * @returns {Map<string, {classes: Set<string>, tag: string}>}
 */
function parseElements(html) {
  const elements = new Map()
  for (const match of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)\/?>/g)) {
    const tag = match[1].toLowerCase()
    const attrs = match[2] ?? ''
    const id = attrs.match(/\bid="([^"]+)"/)?.[1]
    if (!id) continue
    const classes = new Set(
      (attrs.match(/\bclass="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean)
    )
    elements.set(id, { tag, classes })
  }
  return elements
}

/**
 * 收集脚本引用的 id 名字。
 *
 * 三种写法都要覆盖，否则检查会漏掉整页：
 *
 * 1. 直接调用：`document.getElementById('title')`；
 * 2. **经包装函数**：`const el = (id) => document.getElementById(id)` 之后
 *    `el('title')`——`updates.html` 正是这么写的，只查第 1 种的话它一个 id 都查不到；
 * 3. 模板字面量：`` document.getElementById(`tab-${source}`) `` 无法静态求值，
 *    单独交给 P5 按前缀判断。
 * @param {string} html 页面全文
 * @returns {{literal: Set<string>, templates: string[]}}
 */
function scriptIdReferences(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .join('\n')

  const literal = new Set()
  for (const match of scripts.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    literal.add(match[1])
  }

  // 包装函数：函数体里含 getElementById 的函数名。
  for (const match of scripts.matchAll(
    /(?:function\s+(\w+)\s*\([^)]*\)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)\s*\{/g
  )) {
    const name = match[1] ?? match[2]
    if (!name) continue
    const body = extractBracedBody(scripts, match.index + match[0].length)
    if (!body || !/getElementById\s*\(/.test(body)) continue
    const called = new RegExp(`\\b${name}\\(\\s*['"]([^'"]+)['"]`, 'g')
    for (const call of scripts.matchAll(called)) literal.add(call[1])
  }

  const templates = []
  for (const match of scripts.matchAll(/getElementById\(\s*`([^`$]*) \$?\{/g)) {
    templates.push(match[1])
  }
  // 形如 `tab-${source}`：前缀是字面量、后缀运行时才知道。
  for (const match of scripts.matchAll(/getElementById\(\s*`([^`]*)`\s*\)/g)) {
    const body = match[1]
    const prefix = body.split('${')[0]
    if (prefix) templates.push(prefix)
  }

  return { literal, templates }
}

/** 按花括号配对取出完整函数体（与 `verify-ipc-surface.mjs` 同一手法）。 */
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

// ---------------------------------------------------------------------------
// DOM 桩
// ---------------------------------------------------------------------------

/**
 * 元素桩：属性 + 子节点 + 监听器登记。
 *
 * `textContent` / `innerHTML` / `hidden` / `disabled` 都是可写普通属性（页面会赋值），
 * 而 `classList` 必须有真实的增删查语义——页面用它在运行时切换可见性，桩若退化
 * 成 `undefined` 就会制造假失败。`_listenerCount` 是给 P4 用的观测口。
 */
function createElementStub(tag = 'div', classes = new Set()) {
  const listeners = new Map()
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: new Map(),
    style: {},
    dataset: {},
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    value: '',
    checked: false,
    type: '',
    className: [...classes].join(' '),
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const want = force === undefined ? !classes.has(name) : Boolean(force)
        if (want) classes.add(name)
        else classes.delete(name)
        return want
      },
    },
    addEventListener: (type, handler) => {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
    },
    removeEventListener: () => {},
    setAttribute: (name, value) => element.attributes.set(name, String(value)),
    getAttribute: (name) => element.attributes.get(name) ?? null,
    appendChild: (child) => {
      element.children.push(child)
      return child
    },
    append: (...nodes) => element.children.push(...nodes),
    remove: () => {},
    focus: () => {},
    select: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    _listenerCount: (type) => (listeners.get(type) ?? []).length,
    /** 触发一次事件。回调的返回值原样收上来，调用方负责 await 它们。 */
    _fire: (type, event = {}) => {
      const returned = []
      for (const handler of listeners.get(type) ?? []) returned.push(handler(event))
      return returned
    },
  }
  return element
}

/** 按 HTML 里的元素声明构造整页 DOM 桩。 */
function createDocumentStub(html) {
  const declarations = parseElements(html)
  const elements = new Map()
  for (const [id, meta] of declarations) elements.set(id, createElementStub(meta.tag, meta.classes))

  /** 类选择器 → 声明的元素列表（页面用它批量绑定，桩必须如实返回）。 */
  const byClass = (selector) => {
    const wanted = selector.replace(/^\./, '')
    return [...declarations.entries()]
      .filter(([, meta]) => meta.classes.has(wanted))
      .map(([id]) => elements.get(id))
  }

  return {
    _declarations: declarations,
    _elements: elements,
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => createElementStub(tag),
    querySelector: (selector) =>
      selector.startsWith('.') ? (byClass(selector)[0] ?? null) : null,
    querySelectorAll: (selector) => (selector.startsWith('.') ? byClass(selector) : []),
    addEventListener: () => {},
    documentElement: createElementStub('html'),
    head: createElementStub('head'),
    body: createElementStub('body'),
    title: '',
  }
}

// ---------------------------------------------------------------------------
// 已注册命令表（跨语言比对）
// ---------------------------------------------------------------------------

function registeredCommands() {
  const text = existsSync(libPath) ? readFileSync(libPath, 'utf8') : ''
  const block = text.match(/generate_handler!\[([\s\S]*?)\]/)
  if (!block) return new Set()
  const names = new Set()
  for (const match of block[1].matchAll(/commands::([a-z_][a-z0-9_]*)/g)) names.add(match[1])
  return names
}

/**
 * 合成封套：让页面的成功分支真的跑起来。
 *
 * 返回空对象会让大量分支静默跳过（页面普遍先判 `Array.isArray(...)`），
 * 那等于没测。按命令分派才走得到真实代码路径。
 */
function syntheticEnvelope(name) {
  switch (name) {
    case 'harness_status':
    case 'updates_status':
      return {
        success: true,
        data: { phase: 'failed', plugin_fault: true, message: 'synthetic failure' },
        timestamp_ms: 0,
      }
    case 'harness_logs_tail':
      return { success: true, data: ['[desktop] synthetic line'], timestamp_ms: 0 }
    case 'logs_read':
      return {
        success: true,
        data: {
          source: 'harness',
          file: 'harness.log',
          lines: ['[stdout] synthetic line'],
          total_bytes: 42,
          truncated: true,
          missing: false,
        },
        timestamp_ms: 0,
      }
    case 'recovery_status':
      return {
        success: true,
        data: {
          snapshot: { phase: 'failed', plugin_fault: true, message: 'synthetic failure' },
          report: 'DSH CRASH DIAGNOSTIC REPORT',
          plugins: ['example-plugin'],
          plugin_fault: true,
        },
        timestamp_ms: 0,
      }
    case 'diagnostics_export':
      return {
        success: true,
        data: { path: 'C:/tmp/exports/diagnostics-1.zip', bytes: 1, entries: [], redactions: [] },
        timestamp_ms: 0,
      }
    // 刻意返回一个**业务失败**封套：页面若不检查 `success` 就会被抓到。
    case 'harness_open':
      return {
        success: false,
        error: { code: 'E3003', message: 'not ready', category: 'process_lifecycle' },
        timestamp_ms: 0,
      }
    default:
      return { success: true, data: null, timestamp_ms: 0 }
  }
}

/** 用 DOM 桩执行页面的全部内联脚本。 */
function runScript(page, html) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
  const document = createDocumentStub(html)
  const invoked = []

  const window = {
    __TAURI__: {
      core: {
        invoke: (name) => {
          invoked.push(name)
          return Promise.resolve(syntheticEnvelope(name))
        },
      },
      event: { listen: () => Promise.resolve(() => {}) },
      app: { getVersion: () => Promise.resolve('0.1.0') },
    },
    confirm: () => true,
    addEventListener: () => {},
    location: { search: '' },
  }

  for (const block of blocks) {
    const factory = new Function(
      'window',
      'document',
      'navigator',
      'location',
      'URLSearchParams',
      'console',
      `${block}\n//# sourceURL=${page}`
    )
    factory(window, document, { language: 'en-US' }, window.location, URLSearchParams, {
      log: () => {},
      warn: () => {},
      error: () => {},
    })
  }
  return { document, invoked }
}

/**
 * 点一遍所有按钮，把**事件处理器里**的代码也跑起来。
 *
 * 不做这一步的话，页面命令面的实际调用点几乎全在监听器里（`run('recovery_action', …)`
 * 写在 `addEventListener` 的回调里），脚本顶层只是把监听挂上——于是 P3 一个命令名都
 * 看不到，等于没查。「命令写错名」正是本仓库出过真事故的那一类（D6），必须覆盖。
 *
 * 每个处理器返回的 Promise 都等到落定为止，否则处理器内的异步分支会被跳过。
 * @param {object} document DOM 桩
 * @param {Map<string, {tag: string}>} declarations 元素声明
 */
async function fireEveryButton(document, declarations) {
  for (const [id, meta] of declarations) {
    if (meta.tag !== 'button') continue
    const element = document._elements.get(id)
    const returned = element._fire('click', { currentTarget: element })
    await Promise.allSettled(returned.map((value) => Promise.resolve(value)))
    // 让处理器内部未返回的 promise 链（`.then` / `await` 后续）也推进一轮。
    await new Promise((done) => setImmediate(done))
  }
  // 页面顶部还可能挂了 tab 选择之类的非按钮监听，再放行一轮微任务。
  await new Promise((done) => setImmediate(done))
}

// ---------------------------------------------------------------------------
// 检查
// ---------------------------------------------------------------------------

const registered = registeredCommands()
const pages = existsSync(frontendDir)
  ? readdirSync(frontendDir)
      .filter((name) => name.endsWith('.html'))
      .sort()
  : []

if (pages.length === 0) {
  error('P0', `在 ${frontendDir.slice(projectRoot.length + 1)} 下找不到任何 .html 页面`)
}

for (const page of pages) {
  const html = readFileSync(join(frontendDir, page), 'utf8')
  const declarations = parseElements(html)
  const { literal, templates } = scriptIdReferences(html)

  // P1：脚本读取的每个 id 都必须真的存在。
  for (const id of literal) {
    if (!declarations.has(id)) {
      error(
        'P1',
        `${page}：脚本读取 \`#${id}\`，但页面里没有这个 id——getElementById 会返回 null，` +
          `紧随其后的监听绑定将抛 TypeError，该页所有按钮失效`
      )
    }
  }

  // P5：模板字面量拼出的 id 只检查前缀（后缀运行时才知道）。
  for (const prefix of templates) {
    const hit = [...declarations.keys()].some((id) => id.startsWith(prefix))
    if (!hit) {
      warn(
        'P5',
        `${page}：脚本用模板字面量拼出 id（前缀 \`${prefix}\`），但没有任何已声明 id 以它开头`
      )
    }
  }

  // P2：脚本必须能完整跑通。
  let invoked = []
  let document
  try {
    const result = runScript(page, html)
    invoked = result.invoked
    document = result.document
  } catch (cause) {
    error('P2', `${page}：内联脚本执行抛错，页面加载后监听可能未挂上——${cause}`)
    continue
  }

  // P2b：点一遍所有按钮。命令面的实际调用点几乎都在监听器里，不点就走不到。
  try {
    await fireEveryButton(document, declarations)
  } catch (cause) {
    error('P2', `${page}：点击按钮时抛出异常——该按钮点下去会让页面进错误状态：${cause}`)
  }

  // P3：调用的命令必须已注册（与 verify-ipc-surface 的 E3 交叉验证）。
  for (const name of new Set(invoked)) {
    if (registered.size > 0 && !registered.has(name)) {
      error('P3', `${page}：调用了未注册的命令 \`${name}\`——运行时会静默失败`)
    }
  }

  // P6：调用命令的页面必须解包封套。
  //
  // 命令面把业务失败表达成 **成功返回里的 `success: false`**，而不是 rejected
  // promise。因此页面若不读 `success`，有两类静默失效：
  //   ① 业务失败被当成成功（按钮亮着，什么都没发生）；
  //   ② 把**封套**当成载荷用（`envelope.phase` 恒为 undefined）——`updates.html`
  //      就曾经这样：`invoke('updates_status').then(apply)` 之后 `apply` 拿到封套，
  //      `if (!snapshot.phase) return` 直接早退，**整页永远不渲染**。
  // 这条检查很粗（只要求脚本里出现 `success`），但粗得恰到好处：它抓的是
  // 「压根不知道自己拿到的是封套」这个根因，而不是某种具体写法。
  if (invoked.length > 0 && !/\bsuccess\b/.test(html)) {
    error(
      'P6',
      `${page}：调用了命令（${[...new Set(invoked)].join(', ')}），但脚本里没有出现 \`success\`——` +
        `很可能没有解包 IpcEnvelope：业务失败会被当成成功，或把封套当成载荷用`
    )
  }

  // P4：按钮必须挂上 click 监听，且点下去不能抛错（P2b 已覆盖点击）。
  //
  // 这是本脚本最值钱的一条：改版页面时最容易漏的就是「HTML 留了按钮、脚本忘了绑」，
  // 而那种页面**看上去完全正常**，只有用户点下去才知道是死的。
  const unwired = []
  for (const [id, meta] of declarations) {
    if (meta.tag !== 'button') continue
    const element = document._elements.get(id)
    if (!element || element._listenerCount('click') === 0) unwired.push(id)
  }
  if (unwired.length > 0) {
    error('P4', `${page}：以下按钮没有挂 click 监听（点了不会有任何反应）：${unwired.join(', ')}`)
  }

  notes.push(
    `${page}：元素 ${declarations.size} 个 · 按钮 ${[...declarations.values()].filter((m) => m.tag === 'button').length} 个` +
      ` · 调用命令 ${new Set(invoked).size} 个（${[...new Set(invoked)].join(', ') || '无'}）`
  )
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

if (json) {
  console.log(JSON.stringify({ notes, errors, warnings, strict }, null, 2))
} else {
  console.log('[verify-shell-pages] 壳内页面运行时冒烟')
  for (const note of notes) console.log(`  · ${note}`)
  console.log('')
  for (const item of warnings) console.log(`  ⚠️  ${item.id}  ${item.message}`)
  for (const item of errors) console.log(`  ❌ ${item.id}  ${item.message}`)
  if (errors.length === 0 && warnings.length === 0) {
    console.log('  ✅ 每个页面的脚本都能完整加载，引用可解析、按钮均已接线')
  } else if (errors.length === 0) {
    console.log(`\n  ${warnings.length} 条提示。加 --strict 可将其视为失败。`)
  } else {
    console.log(`\n  ${errors.length} 处运行时缺陷、${warnings.length} 条提示。`)
  }
}

process.exit(errors.length > 0 || (strict && warnings.length > 0) ? 1 : 0)
