/**
 * 插件注册防护与故障归因
 *
 * # 状态（2026-09-10，批次 F 裁定后）
 *
 * ✅ `formatFaultDetails` —— 已接线：由 `harness-node-entry.mjs` 的
 *    `uncaughtException` / `unhandledRejection` 处理器消费，产出
 *    `[dsh-plugin-fault]` 结构化标识。**这是当前唯一生效的插件防护**（进程内），
 *    同进程的插件崩溃仍可能带走 Harness——这一点在 `AGENTS.md` §7.2 有明确记载。
 *
 * # 已移除：`PluginWorkerClient` 与 `plugin-worker-host.mjs`
 *
 * 这两个文件实现了「把插件跑在进程外、用 JSON-RPC 通信」的完整方案，但**从未
 * 接线**，批次 F 据此裁定为「冻结并归档」（决策记录见
 * `docs/dev-plan-disconnected-points.md` §4 决策点 3）。删掉而不是留着的原因：
 *
 * 1. **它不在插件挂载路径上**。真实挂载发生在 Harness 进程内的官方 Cordis
 *    体系里（`dsh.profile.bundles` 投影 + dshmarket shim），本文件够不着那个
 *    加载器。启用它得到的不是「隔离」，而是一个与官方体系并行的影子进程。
 * 2. **需求从未定义**。要拦什么、失败语义是什么都还没有答案；先写代码再找
 *    问题，只会得到一个看起来能跑、实际不解决任何问题的组件。
 * 3. **留着就是会腐烂的重量**：进程外 RPC 必须与 `dsh-contracts` 的 JSON-RPC
 *    契约同步演进，没有消费者时无人会发现它已经漂移。
 *
 * 因此本文件不会输出 `[dsh-worker-fault]`——那个标识随上述实现一起消失。
 * 若将来官方提供了插件停用 / 隔离的接口，接线点是**官方接口**，不是这里。
 *
 * # 匹配模式的第 4 类来源（2026-09-22，实战日志回填）
 *
 * 前三类模式（duplicate tool / duplicate route / failed to apply loader entry）
 * 覆盖的是**插件主动抛错**的场景。实际装机日志里最常见的却是另一类——
 * **Cordis 已经判定该插件没起来，但没有任何一方抛异常**：
 *
 * ```text
 * web boot: 13 entries did not activate
 * @deepseek-ai/dsh-client-ui-sidebar: pending (waiting for service: uiWorkspace)
 * dsh-git-worktree: failed
 * ```
 *
 * 这类信号此前**一条都不匹配**，于是 `offending_plugins` 恒为空，恢复页只能显示
 * 「未能从日志中定位到具体插件」——用户看到的不是「隔离没生效」，而是**归因压根
 * 没跑出来**。下面补上 `failed` / `pending (waiting for service: …)` /
 * `did not activate` 三类模式。
 *
 * ⚠️ 归因的**输入**在 `harness-node-entry.mjs` 里只有 `uncaughtException` /
 * `unhandledRejection` 两个回调。而上面这类文本是 Cordis 写在 **stdout** 上的
 * 启动摘要，**不经过异常路径**——因此本文件的模式扩展解决了「拿到了这类文本却
 * 识别不出」的问题，但它进入归因链还需要入口把启动日志也喂进来。两者是独立的
 * 两件事，不要因为补了模式就认为恢复页的插件列表会自动填满。
 */

/**
 * 从一行启动摘要里抽出「未激活条目」的数量。
 *
 * 只认 `<label> boot: N entries did not activate` 这一种形态：`boot:` 前缀由
 * Cordis 输出，`entries` 与 `did not activate` 的搭配足够特异，不会误吞普通日志。
 * @param {string} line 单行文本
 * @returns {{label: string, count: number}|null} 命中返回拆解结果，否则 null
 */
function matchBootSummary(line) {
  const match = line.match(/(\S+)\s+boot:\s*(\d+)\s+entr(?:y|ies)\s+did\s+not\s+activate/i)
  if (!match) return null
  return { label: match[1], count: Number(match[2]) }
}

/**
 * 从一行条目状态里抽出插件名。
 *
 * 覆盖三种形态（均来自真实日志）：
 *   · `<name>: pending (waiting for service: <svc>)` —— 服务依赖未满足
 *   · `<name>: failed`                                —— 条目加载失败
 *   · `<name>: pending`                               —— 无原因的 pending
 *
 * 插件名允许带 `@scope/` 前缀与 `.` `-` `_`，因此字符类比 `\w` 宽。
 * @param {string} line 单行文本
 * @returns {{name: string, state: string, service?: string}|null} 命中返回拆解结果
 */
function matchEntryState(line) {
  const match = line.match(/^\s*([@\w][\w./@-]*)\s*:\s*(failed|pending)\b([^\n]*)$/i)
  if (!match) return null
  const name = match[1]
  const state = match[2].toLowerCase()
  const serviceMatch = match[3].match(/waiting\s+for\s+service\s*:\s*([^\s)]+)/i)
  return serviceMatch
    ? { name, state, service: serviceMatch[1] }
    : { name, state }
}

/**
 * 把一条插件故障归因成一句可定位的文本（纯函数，便于自检）。
 *
 * 返回 `null` 表示「这条错误不属于本模块负责的插件故障」——调用方据此决定是否
 * 打 `[dsh-plugin-fault]`。**宁可返回 null 也不要猜**：一个编出来的归因会把
 * 排查引向错误方向，比没有归因更糟。
 *
 * @param {unknown} error 异常对象、字符串或多行文本（Cordis 启动摘要）
 * @returns {string|null} 归因文本；不属于插件故障时为 null
 */
export function formatFaultDetails(error) {
  const message = error?.message || String(error)

  // ---- 精确归因优先：能点名到具体插件的一定先说 -------------------------
  // 顺序刻意如此。`did not activate` 是**一句总结**，它说的信息量最小；
  // 若先返回它，下面那行「哪个插件、因为缺什么服务」就被吞掉了——而后者才是
  // 用户能拿去动手的依据。

  const bootFailures = []
  const pendingEntries = []
  let bootSummary = null

  for (const line of message.split(/\r?\n/u)) {
    const summary = matchBootSummary(line)
    if (summary) {
      bootSummary = summary
      continue
    }
    const entry = matchEntryState(line)
    if (!entry) continue
    if (entry.state === 'failed') bootFailures.push(entry.name)
    else pendingEntries.push(entry)
  }

  // ① 明确的条目加载失败：单条就足以点名。
  if (bootFailures.length > 0) {
    const unique = [...new Set(bootFailures)]
    return unique.length === 1
      ? `plugin did not activate: ${unique[0]}`
      : `plugins did not activate: ${unique.join(', ')}`
  }

  // ② 服务依赖未满足：插件名 + 缺的服务名都给出，这是可操作的信息。
  if (pendingEntries.length > 0) {
    const first = pendingEntries[0]
    const suffix = first.service ? ` (waiting for service: ${first.service})` : ''
    return pendingEntries.length === 1
      ? `plugin stuck pending: ${first.name}${suffix}`
      : `plugin stuck pending: ${first.name}${suffix} +${pendingEntries.length - 1} more`
  }

  // ③ 兜底：只有总结、点不出名字。仍比没有归因有用——它把用户推向「去市场逐个
  //    排查」而不是「怀疑隔离没生效」。数字来自真实日志，不是估算。
  //
  //    这里不再加第二个「是不是启动摘要」的守卫：`matchBootSummary` 已经要求
  //    `N entries did not activate` 整段形态，再过一道只会是冗余。
  //    （2026-09-22 自检当场抓到过一版多余的 `BOOT_SUMMARY_MARKER`——它拿 `label`
  //    去比 `entry|entries`，而 `label` 是 `web`，于是永远为假、这条兜底永不生效。）
  if (bootSummary) {
    return `${bootSummary.label} boot: ${bootSummary.count} entries did not activate (no specific plugin identified in the log)`
  }

  // ---- 以下为插件主动抛错的形态（本文件自 2026-09-10 起就有的三类）--------

  const toolMatch =
    message.match(/tool\s+["']?([^"'\s]+)["']?\s+already\s+registered/i) ||
    message.match(/duplicate\s+tool\s+["']?([^"'\s]+)["']?/i)
  if (toolMatch) {
    return `duplicate tool registration: ${toolMatch[1]}`
  }

  const routeMatch =
    message.match(/route\s+["']?([^"'\s]+)["']?\s+already\s+registered/i) ||
    message.match(/route\s+["']?([^"'\s]+)["']?\s+already\s+exists/i)
  if (routeMatch) {
    return `duplicate route registration: ${routeMatch[1]}`
  }

  const loaderMatch = message.match(/failed to apply loader entry [^(]*\(([^)]+)\)/i)
  if (loaderMatch) {
    return `loader failure in plugin: ${loaderMatch[1]}`
  }

  return null
}

/** `formatFaultDetails` 的具名导出（与 `installPluginSafetyGuards()` 等价）。 */
export function installPluginSafetyGuards() {
  // 结构化错误诊断提取：把常见插件注册冲突 / 加载失败模式归一成一句可归因的
  // 文本。输出经 Harness 侧日志进入 `[dsh-plugin-fault]` 归因链。
  return {
    formatFaultDetails,
  }
}
