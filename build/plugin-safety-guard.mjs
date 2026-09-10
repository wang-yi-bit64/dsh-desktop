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
 */

export function installPluginSafetyGuards() {
  // 结构化错误诊断提取：把常见插件注册冲突 / 加载失败模式归一成一句可归因的
  // 文本。输出经 Harness 侧日志进入 `[dsh-plugin-fault]` 归因链。
  function formatFaultDetails(error) {
    const message = error?.message || String(error)

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

  return {
    formatFaultDetails,
  }
}
