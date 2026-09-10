/**
 * 注入到 Harness 页面的壳层 UI（**「preload 等价物」**）。
 *
 * # 为什么这个文件存在
 *
 * 上游（Electron）靠 `preload` 往 Harness 页里注入 UI：`ipcRenderer.on(...)` 收
 * 状态、`contextBridge` 暴露能力、直接往侧边栏塞节点。本仓早期据此记过一句
 * 「Tauri webview 没有 preload 通道，因此无法复刻」——**那句话是错的**。
 * Tauri 2.11.5 的 `WebviewWindowBuilder::initialization_script` 会在**每一次
 * 顶层文档导航**之前执行脚本（WebView2 的 `addDocumentStartJavaScript` 语义），
 * 这正是 preload 的等价物。相关的错误宣称已在 `AGENTS.md` 更正。
 *
 * 于是分工变成：
 *
 * | 环节 | 上游（Electron） | 本仓（Tauri） |
 * |------|------------------|----------------|
 * | 注入时机 | `preload` 脚本 | `initialization_script`（本文件） |
 * | 状态下发 | `webContents.send` + `ipcRenderer.on` | 壳层 `webview.eval()` 调 [`setStatus`] |
 * | 反向调用 | `ipcRenderer.invoke` | **无**——本指示器不需要回连（见下） |
 *
 * # 为什么是「指示器」而不是「按钮」
 *
 * 上游把它做成按钮，点击经 `ipcRenderer.invoke('mobile:open-pairing')` 打开配对
 * 流程。本仓刻意**不做点击**：那个回连需要在 Harness 页（一个**远程 origin**）上
 * 开一个 IPC 入口，而本仓对命令面是收紧的（见 `AGENTS.md` §7）。配对与停止仍由
 * 原生 `Phone` 菜单承担，它是**唯一**入口。
 *
 * 由此引出一条硬约束：**它就不能长得像按钮**。一个看起来可点、点了却没反应的
 * 控件，和一句谎话没有区别。所以这里渲染的是 `role="status"` 的状态圆点加提示
 * 文案，`title` 里写清「去 Phone 菜单操作」。
 *
 * # 修掉的两处上游缺陷
 *
 * 1. **首次绘制无状态保护**。上游 `mountMobileButton()` 先把按钮 append 进
 *    `[data-dsh-sidebar-settings]`，再调 `renderMobileButton()`；而后者在
 *    `[data-dsh-sidebar-root]` 缺失时直接 `return`。结果：按钮会带着**未应用的
 *    默认态**（`hidden === false`）显示出来——在窄侧边栏里本该隐藏却漏出。
 *    本文件的做法：元素创建时即 `hidden = true`，且 [`render`] **永不早退**。
 *
 * 2. **两个探针元素不同源**。挂载需要 `[data-dsh-sidebar-settings]`，算可见性
 *    需要 `[data-dsh-sidebar-root]`，二者出现顺序没有保证，中间存在「已插入但
 *    未渲染」的窗口。本文件把**挂载**与**状态**解耦：[`render`] 幂等重算，
 *    sidebar root 未知时按「窄」处理（保守策略：未连接即隐藏，已连接仍可见，
 *    避免「手机连着却看不见」）。
 *
 * # 与页面生命周期有关的两个事实
 *
 * - 本脚本在**文档解析之前**执行，因此 `document.documentElement` 可能还不存在，
 *   观察器必须等 DOM 就绪再挂。
 * - 状态是**壳层推**下来的：页面每次导航后由 `on_page_load` 补推一次当前状态，
 *   连接状态翻转时由 `on_connected_change` 推送。页面自己**不轮询**（上游把
 *   每秒轮询改成事件推送的理由同样适用于本仓）。
 *
 * @see src-tauri/src/harness_ui.rs — 注入与推送的 Rust 侧
 */

;(function () {
  'use strict'

  /** 指示器元素 id。同时用作样式表 id 前缀。 */
  var ELEMENT_ID = 'dsh-desktop-phone-indicator'
  var STYLE_ID = ELEMENT_ID + '-style'
  /** 壳层经 `eval` 调用的全局入口名。 */
  var GLOBAL_KEY = '__dshDesktopPhone'
  /** 侧边栏「设置」区——指示器的宿主。 */
  var SETTINGS_SELECTOR = '[data-dsh-sidebar-settings]'
  /** 侧边栏根——`data-dsh-sidebar-wide` 的产地，决定宽/窄两套排布。 */
  var ROOT_SELECTOR = '[data-dsh-sidebar-root]'

  /**
   * 是否运行在本机 Harness 页上。
   *
   * 注入脚本会**在每一次顶层导航**执行，其中包括壳层自己的本地页
   * （`index.html` / `error.html` / `updates.html` …）。那些页面 origin 是
   * `http://tauri.localhost` 或 `tauri://localhost`，不是 Harness。
   *
   * 刻意只认 `127.0.0.1`：壳层的导航白名单只放行「本地静态页」与
   * `http://127.0.0.1:<当前实例端口>`（见 `navigation.rs`），因此 `localhost`
   * 或其它回环写法都不会成为我们的页面。
   *
   * 主框架判定同样必要：Windows 上初始化脚本**也会进入子框架**。
   *
   * @returns {boolean} 是 Harness 主框架时为 `true`。
   */
  function isHarnessPage() {
    if (window.top !== window) return false
    if (window.location.protocol !== 'http:') return false
    return window.location.hostname === '127.0.0.1'
  }

  if (!isHarnessPage()) return

  /** 手机桥是否已连接。初始未知，按「未连接」渲染，等壳层推送纠正。 */
  var connected = false
  /** 指示器元素（缓存；被 Harness 重渲染摘掉后重新查询）。 */
  var element = null
  /** 宿主区缓存。 */
  var settingsArea = null
  /** 侧边栏根缓存。 */
  var sidebarRoot = null
  /** 是否已排入一次 rAF 批处理。 */
  var scheduled = false
  /** MutationObserver 是否已挂上（DOM 就绪前无法挂）。 */
  var observing = false

  var ZH = {
    connected: '手机已连接',
    disconnected: '手机未连接',
    hint: '在应用的「Phone」菜单里配对或停止'
  }
  var EN = {
    connected: 'Phone connected',
    disconnected: 'Phone not connected',
    hint: 'Pair or stop from the application\'s Phone menu'
  }

  /** 手机图标（与上游同一枚，保持品牌一致）。 */
  var PHONE_ICON =
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">' +
    '<rect x="7" y="2.75" width="10" height="18.5" rx="2.25" stroke="currentColor" stroke-width="1.7"/>' +
    '<path d="M10.2 5.5h3.6M10.5 18.35h3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
    '</svg>'

  /**
   * 与上游同一套变量（`--dsw-*`），因此主题、暗色模式、侧边栏配色都由 Harness
   * 自己决定，本指示器只跟随；变量缺失时有兜底色。
   *
   * 与上游样式的差异只有一处：**没有 `:hover` / `:focus-visible` / `cursor`**
   * ——它不是可交互元素（见文件头「为什么是指示器」）。
   */
  var STYLES =
    '[data-dsh-sidebar-settings] { position: relative; box-sizing: border-box; }' +
    '[data-dsh-sidebar-root][data-dsh-sidebar-wide="true"] [data-dsh-sidebar-settings] { padding-right: 38px; }' +
    '#' + ELEMENT_ID + ' { position: relative; width: 32px; height: 32px;' +
    ' color: var(--dsw-alias-label-secondary, #73777f); background: transparent;' +
    ' display: inline-flex; align-items: center; justify-content: center; border-radius: 9px; }' +
    '[data-dsh-sidebar-root][data-dsh-sidebar-wide="true"] #' + ELEMENT_ID +
    ' { position: absolute; right: 0; top: 50%; transform: translateY(-50%); }' +
    '[data-dsh-sidebar-root][data-dsh-sidebar-wide="false"] [data-dsh-sidebar-settings]' +
    ' { flex-direction: column; align-items: center; }' +
    '[data-dsh-sidebar-root][data-dsh-sidebar-wide="false"] #' + ELEMENT_ID +
    ' { flex: none; margin-top: 5px; }' +
    '#' + ELEMENT_ID + '[hidden] { display: none; }' +
    '#' + ELEMENT_ID + ' > span { position: absolute; top: 4px; right: 4px; width: 7px; height: 7px;' +
    ' border: 1.5px solid var(--dsw-specific-sidebar-fill, #fff); border-radius: 50%;' +
    ' background: #4da66d; opacity: 0; }' +
    '#' + ELEMENT_ID + '.is-connected > span { opacity: 1; }'

  /**
   * 取一个仍然在文档里的元素：命中缓存就复用，否则重新查询。
   *
   * `[data-dsh-*]` 是属性选择器、没有索引，未命中要整树遍历；Harness 每次重渲染
   * 都会摘掉我们的节点并重新查询，因此缓存 + `isConnected` 判断能把稳态开销压成
   * 一次标志位读取（上游同款优化）。
   *
   * @param {Element|null} cached 上次取到的元素
   * @param {string} selector 选择器
   * @returns {Element|null} 仍在文档中的元素，未命中为 `null`
   */
  function liveElement(cached, selector) {
    if (cached && cached.isConnected) return cached
    return document.querySelector(selector) || null
  }

  /** 当前应使用的文案表。 */
  function text() {
    var language = (navigator.language || '').toLowerCase()
    return language.indexOf('zh') === 0 ? ZH : EN
  }

  /** 注入样式表（只注入一次）。 */
  function ensureStyle() {
    // 解析开始前 `document.head` 还不存在——此时无法插入，等下一轮同步。
    if (!document.head) return
    if (document.getElementById(STYLE_ID)) return
    var style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLES
    document.head.appendChild(style)
  }

  /**
   * 创建指示器元素。
   *
   * **缺陷修复 1**：创建时即 `hidden = true`。上游创建后依赖 `render()` 收尾，
   * 而 `render()` 可能因 sidebar root 缺失而早退，导致这个「未定态」的元素直接
   * 画出来。
   *
   * @returns {HTMLElement} 新建的指示器
   */
  function createElement() {
    var created = document.createElement('span')
    created.id = ELEMENT_ID
    created.hidden = true
    // 状态区域：屏幕阅读器在状态变化时会播报，视觉上是一枚圆点。
    created.setAttribute('role', 'status')
    created.setAttribute('aria-live', 'polite')
    created.innerHTML = PHONE_ICON + '<span aria-hidden="true"></span>'
    return created
  }

  /**
   * 按当前状态渲染。
   *
   * **幂等**，且**永不早退**（缺陷修复 2）：只要元素在，可见性、类名、文案都从
   * `connected` 重新算一遍。`sidebarRoot` 取不到时按「窄」处理——未知不等于
   * 「保持原样」，否则就会出现「已插入但未渲染」的中间态。
   */
  function render() {
    if (!element) return
    sidebarRoot = liveElement(sidebarRoot, ROOT_SELECTOR)
    // 未知按窄处理：未连接即隐藏（不打扰），已连接仍可见（不漏报）。
    var wide = sidebarRoot ? sidebarRoot.getAttribute('data-dsh-sidebar-wide') === 'true' : false
    var hidden = !wide && !connected
    var copy = text()
    var label = connected ? copy.connected : copy.disconnected

    if (element.hidden !== hidden) element.hidden = hidden
    if (element.classList.contains('is-connected') !== connected) {
      element.classList.toggle('is-connected', connected)
    }
    if (element.getAttribute('aria-label') !== label) {
      element.setAttribute('aria-label', label)
      element.title = label + ' — ' + copy.hint
    }
  }

  /**
   * 同步一轮：补样式、必要时挂载、然后渲染。
   *
   * 挂载与状态解耦——宿主区存在就挂上，可见性交给 [`render`]。
   */
  function sync() {
    ensureStyle()
    settingsArea = liveElement(settingsArea, SETTINGS_SELECTOR)
    if (settingsArea) {
      element = liveElement(element, '#' + ELEMENT_ID)
      if (!element) element = createElement()
      if (element.parentElement !== settingsArea) settingsArea.appendChild(element)
    } else if (element && !element.isConnected) {
      // 宿主区整体消失（侧边栏收起 / 重渲染）：丢引用，等它回来再挂。
      element = null
    }
    render()
  }

  /**
   * 请求一次异步同步（rAF 合并）。
   *
   * Harness 的会话树可以有上万个节点，逐条 mutation 同步会在帧内反复整树查找；
   * 合并到一帧一次，把开销限定在 60Hz 以内。
   */
  function schedule() {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(function () {
      scheduled = false
      sync()
    })
  }

  /** 挂上观察器。注入发生在文档解析前，因此要等 `documentElement` 出现。 */
  function observe() {
    if (observing || !document.documentElement) return
    observing = true
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true
    })
    schedule()
  }

  /**
   * 壳层推送入口：更新连接状态。
   *
   * 由 `webview.eval()` 调用，例如
   * `window.__dshDesktopPhone.setStatus(true)`。
   *
   * 状态**没有变化时也会重绘**：DOM 可能刚被 Harness 重建，此时「值没变」不等于
   * 「界面是对的」。重绘是幂等的，代价只是一次属性比较。
   *
   * @param {boolean} next 手机桥是否已连接
   */
  function setStatus(next) {
    connected = next === true
    sync()
  }

  window[GLOBAL_KEY] = { setStatus: setStatus, sync: sync }

  if (document.documentElement) observe()
  else document.addEventListener('DOMContentLoaded', observe, { once: true })
})()
