/**
 * parent-death-watchdog.mjs — macOS 的「父死子亡」补丁（风险 R-7）。
 *
 * ## 为什么需要它
 *
 * 各平台的孤儿防护（见 `crates/dsh-host/src/process.rs`）：
 *
 * | 平台 | 机制 |
 * |---|---|
 * | Windows | Job Object（kernel 级，父死即关） |
 * | Linux | `prctl(PR_SET_PDEATHSIG, SIGTERM)` |
 * | macOS | **没有等价物** —— 只剩「进程组 + 下次启动清扫」 |
 *
 * 后果：宿主（CLI）被杀后，Harness/mock 进程会成为孤儿，直到**下一次**冷启动
 * 才被陈旧 pidfile 清扫掉。2026-09-12 把故障注入转为三平台硬门禁后，macOS 的
 * A/B 两项（SIGTERM 宿主 / 强杀宿主）当场变红，暴露了这个长期缺口。
 *
 * ## 判据：主动探测，而不是看 ppid 的值
 *
 * 父进程一旦消亡，子进程被 reparent，但**不要假设 ppid 变成某个固定值**（macOS
 * 上未必是 1）。改为轮询 `process.kill(parentPid, 0)`：抛 `ESRCH` 即父已不存在。
 *
 * ## 两个踩过的坑（勿回归）
 *
 * 1. **定时器不能 `unref()`**：unref 的定时器在事件循环闲置时不会被触发，而
 *    Harness/mock 大部分时间正是闲置的。第一版 unref 之后，看门狗在 macOS CI 上
 *    从未运行——日志里连一行痕迹都没有，极易误判成「探测逻辑写错」。
 * 2. **必须装在被替换后的那个入口上**：故障注入的 mock 模式会把
 *    `node_entry`/`dsh_entry` **双双替换成 `mock-harness.mjs`**（见
 *    `crates/dsh-host-cli/src/commands/mod.rs::apply_mock_if_requested`），
 *    `harness-node-entry.mjs` 根本不在该路径上。所以本模块被**两处**共同引用：
 *    真实入口与 mock。只加在真实入口上，故障注入测不到任何东西。
 *
 * ## 用法
 *
 * ```js
 * import { installParentDeathWatchdog } from './parent-death-watchdog.mjs'
 * installParentDeathWatchdog()   // darwin 自动启用；DSH_PARENT_DEATH_WATCHDOG=1 可强制
 * ```
 *
 * ## 预算：最坏 `POLL_INTERVAL_MS + FORCE_EXIT_MS`，必须落在两个门禁的窗口内
 *
 * 本模块的清理是**异步**的（轮询 → SIGTERM → 兜底强退），因此它的最坏耗时是一个
 * 必须与门禁对账的常数，而不是随手取的「宽限」。两个窗口：
 *
 * | 门禁 | 杀宿主后多久查孤儿 |
 * |---|---|
 * | `scripts/fault-inject.mjs` 的 B（强杀宿主） | 1500ms |
 * | `scripts/smoke-launch.mjs` 的 L2.2（GUI 关闭） | 关窗后轮询至 5000ms |
 *
 * 2026-09-21 实测：真实 Harness（非 mock）收到 SIGTERM 后**不是**立刻退出，
 * 于是由兜底计时器决定退出时刻——当时 `250 + 1500 = 1750ms` 已超出 fault-inject
 * 的 1500ms 窗口，macOS 的 L2.2 因此变红（该断言在安装包缺看门狗文件时是**空洞
 * 通过**的：Harness 根本没起来，没有进程可成孤儿）。现值 `250 + 750 = 1000ms`，
 * 两个窗口都留有余量。**改这两个常数前先回看这张表。**
 */

/** 轮询间隔（ms）。父进程消失后最多这么久被发现。 */
const POLL_INTERVAL_MS = 250

/**
 * SIGTERM 之后强制退出的宽限（ms）。
 *
 * 750 而不是「差不多就行」：最坏总耗时 `POLL_INTERVAL_MS + FORCE_EXIT_MS` 必须落在
 * fault-inject 的 1500ms 窗口内（见文件头「预算」表）。真实 Harness 收到 SIGTERM 后
 * 未必立刻退出，此时这个计时器就是实际退出时刻——留太大就晚于门禁，留太小则不给
 * 业务收尾机会。宿主已被杀，没有人等这份收尾，750ms 足够。
 */
const FORCE_EXIT_MS = 750

/**
 * 安装父死看门狗。
 *
 * 仅在 macOS 启用（其余平台已有内核级机制）；`DSH_PARENT_DEATH_WATCHDOG=1`
 * 可在任意平台强制启用——本机没有 macOS，这个开关让该行为能被**本地实测**
 * （见 `scripts/verify-harness-entry.mjs`），而不是每轮都靠三平台 CI 试错。
 *
 * @param {{ platform?: string, label?: string, log?: (msg: string) => void }} [options]
 * @returns {boolean} 是否安装了看门狗
 */
export function installParentDeathWatchdog(options = {}) {
  const platform = options.platform ?? process.platform
  const label = options.label ?? 'harness'
  const log = options.log ?? ((msg) => process.stderr.write(msg))

  const forced = process.env.DSH_PARENT_DEATH_WATCHDOG === '1'
  if (platform !== 'darwin' && !forced) return false

  const parentPid = process.ppid

  /** 父进程是否仍存活；EPERM 表示存在但无权限（仍算存活）。 */
  const parentAlive = () => {
    if (!Number.isInteger(parentPid) || parentPid <= 1) return false
    try {
      process.kill(parentPid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }

  // 父进程从一开始就不存在（例如 launchd 直拉）：不启用，避免误杀正常进程。
  if (!parentAlive()) return false

  // ⚠️ 刻意不 unref()：见文件头「踩过的坑」第 1 条。
  const watchdog = setInterval(() => {
    if (parentAlive()) return
    clearInterval(watchdog)
    log(`[${label}] parent process exited; shutting down (macOS parent-death watchdog)\n`)
    // 先让业务有机会正常关闭；若它忽略 SIGTERM，再强制退出。
    process.kill(process.pid, 'SIGTERM')
    setTimeout(() => process.exit(0), FORCE_EXIT_MS)
  }, POLL_INTERVAL_MS)

  return true
}
