#!/usr/bin/env node
/**
 * verify-harness-inject.mjs — `frontend/harness-ui-inject.js` 的无头行为自测。
 *
 * ## 为什么需要它
 *
 * 注入脚本的工作对象是**真浏览器的 DOM**，而本仓的门禁全部跑在无头环境（INV-6：
 * 不依赖显示器、不组装 300MB 运行时）。如果只靠「装进应用里手点一遍」来验证，
 * 那么最容易被改坏的两处——**可见性规则**与**上游缺陷的回归**——就没有任何
 * 自动化防线，而它们恰恰是「看起来对了但其实是错的」那一类问题。
 *
 * 于是这里用**最小 DOM 桩**把脚本跑起来：脚本只用到 `querySelector` /
 * `createElement` / `appendChild` / `classList` / `hidden` / `requestAnimationFrame`
 * / `MutationObserver`，桩的规模因此可控。这不是在测「浏览器实现」，而是在测
 * **我们那段逻辑的判定**（谁在什么时候可见、文案取哪个、重复调用会不会长节点）。
 *
 * ## 覆盖的判定
 *
 * | 组 | 断言 |
 * |----|------|
 * | 早退 | 本地页（`tauri.localhost` / `tauri://`）、子框架都不注入 |
 * | 宿主缺失 | 无 `[data-dsh-sidebar-settings]` 时不抛错、不长节点 |
 * | 可见性 | `wide` × `connected` 四组合（窄+未连接隐藏，其余可见） |
 * | 文案 | zh / en 两套，随连接状态切换，并写入 `title` / `aria-label` |
 * | 幂等 | 反复同步不长出第二个节点、样式表只注入一次 |
 * | **缺陷修复 1** | 元素**创建即隐藏**：root 缺失时不会漏出未定态元素 |
 * | **缺陷修复 2** | root 缺失按「窄」处理：已连接仍可见，不漏报 |
 * | 重渲染 | 侧边栏被 Harness 换掉后能重新挂载 |
 * | 文档起点 | `documentElement` 尚未存在时不抛错，DOM 就绪后自动接管 |
 *
 * ## 用法
 *
 * ```bash
 * npm run verify:harness-inject
 * ```
 *
 * 退出码：`0` 全部通过 · `1` 有失败。
 *
 * ## 让断言「可证伪」
 *
 * 环境变量 `DSH_INJECT_PATH` 可把同一套断言指向另一份实现。它存在的唯一理由是
 * **证明这些断言真的能红**：把上游那两处缺陷（创建时不给 `hidden`、`render` 在
 * sidebar root 缺失时早退）分别打回一份副本，对应的断言必须失败——否则它们只是
 * 装饰，不是防线。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const INJECT_PATH =
  process.env.DSH_INJECT_PATH ?? join(projectRoot, 'src-tauri', 'frontend', 'harness-ui-inject.js')
const ELEMENT_ID = 'dsh-desktop-phone-indicator'

// ---------------------------------------------------------------------------
// 最小 DOM 桩
// ---------------------------------------------------------------------------

/** 极简元素模型：属性 + 子节点 + 连接状态。 */
function createElement(tagName) {
  const attributes = new Map()
  const classes = new Set()
  /** @type {any} */
  const node = {
    tagName: String(tagName).toUpperCase(),
    children: [],
    parentElement: null,
    hidden: false,
    title: '',
    id: '',
    innerHTML: '',
    get isConnected() {
      let cursor = node
      while (cursor.parentElement) cursor = cursor.parentElement
      return cursor === documentElement
    },
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const next = force === undefined ? !classes.has(name) : Boolean(force)
        if (next) classes.add(name)
        else classes.delete(name)
        syncClassAttribute()
    }
  },
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute: (name, value) => {
      attributes.set(name, String(value))
      if (name === 'id') node.id = String(value)
      if (name === 'class') {
        classes.clear()
        String(value)
          .split(/\s+/)
          .filter(Boolean)
          .forEach((entry) => classes.add(entry))
      }
    },
    appendChild: (child) => {
      if (child.parentElement && child.parentElement !== node) {
        child.parentElement.removeChild(child)
      }
      child.parentElement = node
      node.children.push(child)
      return child
    },
    /**
     * 摘除子节点。
     *
     * **必须同时清 `parentElement`**：真实 DOM 里脱离文档的节点，`isConnected`
     * 会变 `false`；桩若只把节点从 `children` 数组里删掉、却留着 `parentElement`
     * 指针，脱离的节点仍会被判定为「连着文档」，于是依赖 `isConnected` 的判断
     * （缓存复用、重挂载）会得出与现实相反的结论——那是桩在骗测试。
     */
    removeChild: (child) => {
      const index = node.children.indexOf(child)
      if (index >= 0) node.children.splice(index, 1)
      if (child.parentElement === node) child.parentElement = null
      return child
    }
  }

  function syncClassAttribute() {
    attributes.set('class', [...classes].join(' '))
  }

  return node
}

const documentElement = createElement('html')
const head = createElement('head')
const body = createElement('body')
documentElement.appendChild(head)
documentElement.appendChild(body)

/** 清空一个节点的子节点（走 `removeChild`，保证 `parentElement` 被清）。 */
function detachAll(parent) {
  for (const child of [...parent.children]) parent.removeChild(child)
}

/** 深度优先遍历（含根）。 */
function walk(root, visit) {
  if (!root) return
  visit(root)
  for (const child of root.children) walk(child, visit)
}

/** 匹配本脚本用到的三种选择器：属性选择器与 id 选择器。 */
function matches(node, selector) {
  if (selector.startsWith('#')) return node.id === selector.slice(1)
  const attribute = selector.match(/^\[([a-z0-9-]+)\]$/)
  if (attribute) return node.getAttribute(attribute[1]) !== null
  throw new Error(`DOM 桩未实现的选择器：${selector}`)
}

const document = {
  documentElement: null,
  head: null,
  readyState: 'loading',
  /** DOMContentLoaded 监听器（用于验证「文档起点」那条）。 */
  readyListeners: [],
  querySelector(selector) {
    let found = null
    walk(document.documentElement, (node) => {
      if (found) return
      if (matches(node, selector)) found = node
    })
    return found
  },
  getElementById(id) {
    let found = null
    walk(document.documentElement, (node) => {
      if (found) return
      if (node.id === id) found = node
    })
    return found
  },
  createElement: (tagName) => createElement(tagName),
  addEventListener: (type, listener) => {
    if (type === 'DOMContentLoaded') document.readyListeners.push(listener)
  },
  /** 测试辅助：把根节点接上，模拟解析开始。 */
  attachRoot() {
    document.documentElement = documentElement
    document.head = head
    document.readyState = 'interactive'
  }
}

const navigator = { language: 'en-US' }

/** MutationObserver 桩：只记录回调，由测试显式触发。 */
const observers = []
class MutationObserver {
  constructor(callback) {
    this.callback = callback
    this.target = null
    observers.push(this)
  }
  observe(target) {
    this.target = target
  }
}

/** 构造一个 window 桩。`options.top` 用于模拟子框架。 */
function createWindow(options = {}) {
  const window = {
    location: {
      protocol: options.protocol ?? 'http:',
      hostname: options.hostname ?? '127.0.0.1'
    },
    // 同步执行：让 rAF 合并的同步在测试里变成确定性调用。
    requestAnimationFrame: (callback) => {
      callback()
      return 1
    }
  }
  window.top = options.subframe ? { different: true } : window
  return window
}

/**
 * 装载注入脚本并返回环境。
 *
 * @param {{hostname?: string, protocol?: string, subframe?: boolean, language?: string, withRoot?: boolean, attachRoot?: boolean}} options
 * @returns {{window: any, document: any, observerCount: () => number, mount: (options?: any) => void}}
 */
function load(options = {}) {
  // 每个用例都要一份干净文档：重置根节点的子节点。
  // `head` / `body` 也要清空——只清 `documentElement` 会把上一轮的侧边栏与
  // 指示器留在 `body` 里，而 `body` 又被重新挂上，于是旧节点「复活」成
  // 连接态，后续断言会读到上一个用例的残留。
  detachAll(documentElement)
  detachAll(head)
  detachAll(body)
  documentElement.appendChild(head)
  documentElement.appendChild(body)
  observers.length = 0
  document.readyListeners.length = 0

  if (options.attachRoot === false) {
    document.documentElement = null
    document.head = null
  } else {
    document.attachRoot()
  }
  navigator.language = options.language ?? 'en-US'

  const window = createWindow(options)
  const source = activeSource ?? readFileSync(INJECT_PATH, 'utf8')
  const factory = new Function(
    'window',
    'document',
    'navigator',
    'MutationObserver',
    `${source}\n//# sourceURL=harness-ui-inject.js`
  )
  factory(window, document, navigator, MutationObserver)

  return {
    window,
    document,
    observerCount: () => observers.length,
    /**
     * 挂上侧边栏骨架：settings 区（宿主）与可选 root（宽度来源）。
     *
     * 挂完**主动触发一次观察器回调**：在真实浏览器里，Harness 渲染侧边栏本身就是
     * 一次 DOM 变动，`MutationObserver` 会自动回调；桩不会自动观察，所以由这里
     * 补上这一步，否则就测不到「侧边栏出现 → 自动挂载」这条真实路径。
     *
     * @param {{settings?: boolean, wide?: boolean|null}} [options]
     */
    mount({ settings = true, wide = true } = {}) {
      if (settings) {
        const settingsArea = createElement('div')
        settingsArea.setAttribute('data-dsh-sidebar-settings', '')
        body.appendChild(settingsArea)
      }
      if (wide !== null) {
        const root = createElement('aside')
        root.setAttribute('data-dsh-sidebar-root', '')
        root.setAttribute('data-dsh-sidebar-wide', String(wide))
        body.appendChild(root)
      }
      observers.forEach((observer) => observer.callback())
    }
  }
}

// ---------------------------------------------------------------------------
// 断言收集
// ---------------------------------------------------------------------------

const results = []
/** 当前这批断言要装载的脚本源码（正跑实现 / 上游变体）。 */
let activeSource = null

function resetResults() {
  results.length = 0
}

function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, message: error.message })
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
/** 取当前指示器元素（不存在时为 null）。 */
function indicator() {
  return document.getElementById(ELEMENT_ID)
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/**
 * 跑一遍全部断言。可换脚本源码重跑——「可证伪」那一节就靠这个。
 */
function runCases() {
check('本地页（tauri.localhost）不注入', () => {
  const env = load({ hostname: 'tauri.localhost' })
  env.mount()
  assert(!env.window.__dshDesktopPhone, '本地页不应定义注入入口')
  assert(!indicator(), '本地页不应挂载指示器')
})

check('非 http 协议（tauri://）不注入', () => {
  const env = load({ hostname: 'localhost', protocol: 'tauri:' })
  env.mount()
  assert(!env.window.__dshDesktopPhone, 'tauri:// 页不应定义注入入口')
})

check('子框架不注入', () => {
  const env = load({ subframe: true })
  env.mount()
  assert(!env.window.__dshDesktopPhone, '子框架不应定义注入入口')
})

check('Harness 页定义入口', () => {
  const env = load()
  env.mount()
  assert(env.window.__dshDesktopPhone, '应当定义 __dshDesktopPhone')
  assert(
    typeof env.window.__dshDesktopPhone.setStatus === 'function',
    'setStatus 必须是函数'
  )
})

check('宿主区缺失时不抛错、不长节点', () => {
  const env = load()
  env.mount({ settings: false })
  env.window.__dshDesktopPhone.setStatus(true)
  assert(!indicator(), '没有宿主区时不应挂载')
})

check('root 缺失 + 未连接 ⇒ 隐藏（上游在此漏出未定态元素）', () => {
  // 上游行为：先 append 再 render，render 因 root 缺失早退，元素带着
  // hidden === false 漏出来。本实现有两道互补防线（创建即 hidden、render 不早退），
  // 单拆掉任一道都还能兜住，因此这条断言的可证伪性由文末「上游变体」小节保证。
  const env = load()
  env.mount({ settings: true, wide: null })
  const element = indicator()
  assert(element, '宿主区存在时应当挂载')
  assert(element.hidden === true, '窄/未知布局 + 未连接必须隐藏，不得漏出未定态元素')
})

check('root 缺失 + 已连接 ⇒ 可见（不漏报）', () => {
  const env = load()
  env.mount({ settings: true, wide: null })
  env.window.__dshDesktopPhone.setStatus(true)
  assert(indicator().hidden === false, '已连接时不应被隐藏')
})

check('可见性：窄 + 未连接 → 隐藏', () => {
  const env = load()
  env.mount({ wide: false })
  assert(indicator().hidden === true, '窄侧边栏未连接时应隐藏')
})

check('可见性：窄 + 已连接 → 可见', () => {
  const env = load()
  env.mount({ wide: false })
  env.window.__dshDesktopPhone.setStatus(true)
  assert(indicator().hidden === false, '窄侧边栏已连接时应可见')
})

check('可见性：宽 + 未连接 → 可见', () => {
  const env = load()
  env.mount({ wide: true })
  assert(indicator().hidden === false, '宽侧边栏未连接时也应可见')
})

check('可见性：宽 + 已连接 → 可见', () => {
  const env = load()
  env.mount({ wide: true })
  env.window.__dshDesktopPhone.setStatus(true)
  assert(indicator().hidden === false, '宽侧边栏已连接时应可见')
})

check('文案：英文随状态切换', () => {
  const env = load({ language: 'en-US' })
  env.mount({ wide: true })
  assert(indicator().getAttribute('aria-label') === 'Phone not connected', '未连接文案')
  env.window.__dshDesktopPhone.setStatus(true)
  assert(indicator().getAttribute('aria-label') === 'Phone connected', '已连接文案')
  assert(indicator().title.includes('Phone menu'), 'title 必须指向真正的操作入口')
})

check('文案：中文随状态切换', () => {
  const env = load({ language: 'zh-CN' })
  env.mount({ wide: true })
  assert(indicator().getAttribute('aria-label') === '手机未连接', '未连接文案')
  env.window.__dshDesktopPhone.setStatus(true)
  assert(indicator().getAttribute('aria-label') === '手机已连接', '已连接文案')
  assert(indicator().title.includes('Phone'), 'title 必须指向真正的操作入口')
})

check('状态类名随连接状态切换', () => {
  const env = load()
  env.mount({ wide: true })
  assert(!indicator().classList.contains('is-connected'), '未连接不应带 is-connected')
  env.window.__dshDesktopPhone.setStatus(true)
  assert(indicator().classList.contains('is-connected'), '已连接应带 is-connected')
  env.window.__dshDesktopPhone.setStatus(false)
  assert(!indicator().classList.contains('is-connected'), '断开后应移除 is-connected')
})

check('幂等：反复同步不产生重复节点', () => {
  const env = load()
  env.mount({ wide: true })
  const api = env.window.__dshDesktopPhone
  for (let index = 0; index < 5; index += 1) api.setStatus(index % 2 === 0)
  const settingsArea = document.querySelector('[data-dsh-sidebar-settings]')
  const ours = settingsArea.children.filter((child) => child.id === ELEMENT_ID)
  assert(ours.length === 1, `指示器应只有一个，实际 ${ours.length}`)
})

check('幂等：样式表只注入一次', () => {
  const env = load()
  env.mount({ wide: true })
  for (let index = 0; index < 3; index += 1) env.window.__dshDesktopPhone.sync()
  const styles = head.children.filter((child) => child.id === `${ELEMENT_ID}-style`)
  assert(styles.length === 1, `样式表应只有一份，实际 ${styles.length}`)
})

check('纹身式重渲染：宿主区被换掉后能重新挂载', () => {
  const env = load()
  env.mount({ wide: true })
  const api = env.window.__dshDesktopPhone
  api.setStatus(true)

  // Harness 重渲染：整个 settings 区被替换成新节点。
  const stale = document.querySelector('[data-dsh-sidebar-settings]')
  body.removeChild(stale)
  const rebuilt = createElement('div')
  rebuilt.setAttribute('data-dsh-sidebar-settings', '')
  body.appendChild(rebuilt)
  assert(!indicator(), '旧宿主被摘除后指示器应随之脱离文档')

  api.sync()
  assert(indicator(), '宿主区回来后应重新挂载')
  assert(indicator().parentElement === rebuilt, '应挂到新的宿主区上')
  assert(indicator().hidden === false, '重挂后仍应按已连接状态可见')
})

check('文档起点：documentElement 未就绪时不抛错，就绪后接管', () => {
  const env = load({ attachRoot: false })
  assert(
    document.readyListeners.length === 1,
    'DOM 尚不可用时应改为等待 DOMContentLoaded'
  )
  assert(env.observerCount() === 0, '此时还不应挂观察器')

  document.attachRoot()
  document.readyListeners.forEach((listener) => listener())
  env.mount({ wide: true })
  assert(env.observerCount() === 1, 'DOM 就绪后应挂上观察器')
  env.window.__dshDesktopPhone.sync()
  assert(indicator(), 'DOM 就绪后应能挂载')
})

check('观察器：DOM 变动触发一次同步', () => {
  const env = load()
  env.mount({ wide: true })
  const api = env.window.__dshDesktopPhone
  // 模拟 Harness 重渲染摘掉元素后，观察器回调把界面拉回一致。
  const settingsArea = document.querySelector('[data-dsh-sidebar-settings]')
  settingsArea.removeChild(indicator())
  assert(!indicator(), '先制造「按钮被摘掉」的状态')
  observers.forEach((observer) => observer.callback())
  assert(indicator(), '观察器回调后应重新挂载')
  api.setStatus(true)
})
}

// ---------------------------------------------------------------------------
// 可证伪性：把上游行为打回去，断言必须变红
// ---------------------------------------------------------------------------

/**
 * 把本实现回退成**上游的行为**，用于证明断言不是装饰。
 *
 * 两处回退对应上游 `preload-index.ts` 的两段写法：
 *
 * 1. 元素创建时不设初值（上游靠 `renderMobileButton()` 收尾，而它会早退）；
 * 2. `render` 刷新完 `sidebarRoot` 后、若取不到就 `return`（上游
 *    `renderMobileButton` 的 `if (!button || !root) return`）。
 *
 * 回退 2 必须插在**刷新之后**才与上游等价：插在刷新之前会让 `sidebarRoot` 一旦为
 * `null` 就再也不重查，比上游更严格，于是把后续无关用例也一并带红——那样测出来的
 * 是「变体更坏」，不是「我们守的那条性质」。
 *
 * 二者**必须一起回退**才能复现上游的漏出：本实现的两道防线是互补的，只拆一道
 * 另一道仍兜得住。这正是「两个独立回归测试」这种说法会骗人的地方——本节用
 * 「整体回退必须判红」代替那个说法。
 *
 * @param {string} source 当前实现源码
 * @returns {string|null} 上游变体；两处回退有任何一处没命中就返回 `null`
 */
function upstreamVariant(source) {
  const withoutInitialHidden = source.replace('    created.hidden = true\n', '')
  if (withoutInitialHidden === source) return null

  const refreshLine = '    sidebarRoot = liveElement(sidebarRoot, ROOT_SELECTOR)\n'
  if (!withoutInitialHidden.includes(refreshLine)) return null
  const earlyReturning = withoutInitialHidden.replace(
    refreshLine,
    `${refreshLine}    if (!sidebarRoot) return\n`
  )
  if (earlyReturning === withoutInitialHidden) return null
  return earlyReturning
}

function report(label, rows) {
  const failed = rows.filter((row) => !row.ok)
  console.log(`[verify-harness-inject] ${label}`)
  for (const row of rows) {
    console.log(`  ${row.ok ? 'PASS' : 'FAIL'}  ${row.name}`)
    if (!row.ok) console.log(`        ${row.message}`)
  }
  console.log(`  共 ${rows.length} 项，失败 ${failed.length} 项`)
  return failed
}

const source = readFileSync(INJECT_PATH, 'utf8')
activeSource = source
resetResults()
runCases()
const failures = report('注入脚本行为自测', results)

let drillOk = true
const upstream = upstreamVariant(source)
if (!upstream) {
  console.error('')
  console.error('可证伪性检查失败：脚本文本已变，两处「上游变体」回退未能命中。')
  console.error('这意味着上面那份断言是否还能抓到回归是**未知**的，必须同步更新本节的回退规则。')
  drillOk = false
} else {
  activeSource = upstream
  resetResults()
  runCases()
  const upstreamFailures = results.filter((row) => !row.ok)
  console.log('')
  if (upstreamFailures.length === 0) {
    console.error('[verify-harness-inject] 可证伪性检查失败：上游变体竟然全部通过')
    console.error('  说明这些断言抓不到「元素带着未定态漏出」这个回归，是装饰而非防线。')
    console.error(`  变体实现中的漏出属性：root 缺失 + 未连接时元素可见（应为隐藏）。`)
    drillOk = false
  } else {
    const caught = upstreamFailures.map((row) => row.name).join('；')
    console.log('[verify-harness-inject] 可证伪性检查通过：上游变体被判红')
    console.log(`  被抓住的断言：${caught}`)
    console.log(`  上游变体失败 ${upstreamFailures.length} 项（应 ≥1）`)
  }
}

if (failures.length > 0 || !drillOk) {
  process.exit(1)
}
