#!/usr/bin/env node
/**
 * verify-plugin-fault-patterns.mjs — `formatFaultDetails` 匹配模式守卫。
 *
 * ## 为什么存在（2026-09-22，装机日志回填）
 *
 * `build/plugin-safety-guard.mjs` 的 `formatFaultDetails` 是当前**唯一生效的插件
 * 故障归因**（进程内）。它只有三类模式，全部针对「插件主动抛错」；而真实装机日志
 * 里最常见的形态是 Cordis 写在 stdout 上的**启动摘要**：
 *
 * ```text
 * web boot: 13 entries did not activate
 * @deepseek-ai/dsh-client-ui-sidebar: pending (waiting for service: uiWorkspace)
 * dsh-git-worktree: failed
 * ```
 *
 * 这类文本此前一条都不匹配 → `offending_plugins` 恒为空 → 恢复页显示「未能从日志
 * 中定位到具体插件」。**用户看到的不是「隔离没生效」，而是归因压根没跑出来。**
 *
 * ## 检查项
 *
 * | 编号 | 检查 | 级别 |
 * |------|------|------|
 * | F1 | `failed` 条目被点名归因 | 错误 |
 * | F2 | `pending (waiting for service: X)` 同时给出插件名与服务名 | 错误 |
 * | F3 | 只有总结、点不出名字时给兜底归因（而非 null） | 错误 |
 * | F4 | 归因顺序：能点名的一定压过只有总结的 | 错误 |
 * | F5 | 既有三类模式（duplicate tool / route / loader）未被破坏 | 错误 |
 * | F6 | 非插件故障返回 null（不得乱猜） | 错误 |
 *
 * ## 可证伪性
 *
 * F1/F2/F3 的夹具全部是**从 2026-09-22 装机日志逐字抄下来的真实片段**，不是
 * 手写近似。若有人把模式改窄到不匹配真实日志，本脚本立刻转红。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-plugin-fault-patterns.mjs
 * ```
 *
 * 退出码：`0` 通过 · `1` 有检查失败。
 */

import { exit } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const guardPath = join(projectRoot, 'build', 'plugin-safety-guard.mjs')

const { formatFaultDetails } = await import(pathToFileURL(guardPath).href)

let failed = 0
const check = (label, ok, detail) => {
  if (ok) {
    console.log(`PASS ${label}`)
  } else {
    failed += 1
    console.error(`FAIL ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

// ---- 夹具：2026-09-22 装机日志逐字片段 -------------------------------------
// 拼接为一次「启动摘要 + 逐条状态」的多行文本，与 Cordis 实际输出的形态一致。
const realBootLog = [
  'web boot: 13 entries did not activate',
  '@deepseek-ai/dsh-client-ui-sidebar: pending (waiting for service: uiWorkspace)',
  'dsh-git-worktree: failed',
].join('\n')

// ---- F1：failed 条目被点名 -------------------------------------------------
const f1 = formatFaultDetails(realBootLog)
check(
  'F1 真实启动日志 → 点名 failed 的插件',
  typeof f1 === 'string' && f1.includes('dsh-git-worktree'),
  `实际得到：${JSON.stringify(f1)}`
)

// ---- F2：pending 同时给出插件名与服务名 ------------------------------------
const onlyPending = [
  'web boot: 13 entries did not activate',
  '@deepseek-ai/dsh-client-ui-sidebar: pending (waiting for service: uiWorkspace)',
].join('\n')
const f2 = formatFaultDetails(onlyPending)
check(
  'F2 pending 条目 → 插件名与服务名都在',
  typeof f2 === 'string' && f2.includes('dsh-client-ui-sidebar') && f2.includes('uiWorkspace'),
  `实际得到：${JSON.stringify(f2)}`
)

// ---- F3：只有总结时给兜底归因 ----------------------------------------------
const summaryOnly = 'web boot: 13 entries did not activate'
const f3 = formatFaultDetails(summaryOnly)
check(
  'F3 只有启动摘要 → 兜底归因（不为 null）',
  typeof f3 === 'string' && f3.includes('13'),
  `实际得到：${JSON.stringify(f3)}`
)
// 反证：这句总结若不匹配（如换成普通文案），不得被误判为插件故障。
check(
  'F3b 近义但非启动摘要的文本 → 不误判',
  formatFaultDetails('web boot: everything is fine') === null
)

// ---- F4：归因顺序 —— 能点名的压过只有总结的 --------------------------------
// 判据是「结果里带上了具体插件名」，而不是「结果里不出现 did not activate」——
// 点名形态的文案本身就是 `plugin did not activate: <name>`，后者会把正确结果误判
// 成失败（2026-09-22 自检当场抓到过这版写错的断言）。
check(
  'F4 多行含总结与具体条目 → 优先点名（不返回纯总结）',
  typeof f1 === 'string' && f1.includes('dsh-git-worktree') && f1.startsWith('plugin did not activate:'),
  `实际得到：${JSON.stringify(f1)}`
)

// ---- F5：既有三类模式未被破坏 ----------------------------------------------
// F5c 的期望值是 `bad export`（**括号内**的内容），这是本仓自 2026-09-10 起就有的
// 既有语义：`failed to apply loader entry <entry> (<reason>)` 取的是 `<reason>`。
// 守卫只做「未被破坏」，因此照实断言现状，不顺手改语义——那属于独立裁定。
const f5Cases = [
  ['F5a duplicate tool', 'tool "recall" already registered', 'recall'],
  ['F5b duplicate route', 'route "/api/x" already exists', '/api/x'],
  [
    'F5c loader failure',
    'failed to apply loader entry @scope/pkg (bad export)',
    'bad export',
  ],
]
for (const [label, input, expected] of f5Cases) {
  const got = formatFaultDetails(input)
  check(
    `${label} → 仍可归因`,
    typeof got === 'string' && got.includes(expected),
    `实际得到：${JSON.stringify(got)}`
  )
}
// 错误对象形态（`error.message`）与字符串形态必须等价。
check(
  'F5d Error 对象 → 读 message',
  (() => {
    const got = formatFaultDetails(new Error('dsh-git-worktree: failed'))
    return typeof got === 'string' && got.includes('dsh-git-worktree')
  })()
)

// ---- F6：非插件故障返回 null -----------------------------------------------
const f6Cases = [
  ['F6a 无关错误', 'Cannot find module "foo"'],
  ['F6b 空输入', ''],
  ['F6c null', null],
  ['F6d 普通冒号文本（非 failed/pending）', 'stdout: everything ok'],
]
for (const [label, input] of f6Cases) {
  const got = formatFaultDetails(input)
  check(`${label} → null`, got === null, `实际得到：${JSON.stringify(got)}`)
}

// CRLF 无关（ADR-031）：Windows 上日志常以 CRLF 落盘，`split(/\r?\n/)` 必须
// 与 LF 表现一致——正则被 `\r` 破坏时结果不是报错而是**静默通过**。
const crlfLog = realBootLog.replace(/\r?\n/gu, '\r\n')
check(
  'CRLF 日志 → 与 LF 结论一致',
  formatFaultDetails(crlfLog) === f1,
  `LF=${JSON.stringify(f1)} CRLF=${JSON.stringify(formatFaultDetails(crlfLog))}`
)

if (failed > 0) {
  console.error(`\nverify-plugin-fault-patterns: ${failed} 项失败`)
  exit(1)
}
console.log('\nverify-plugin-fault-patterns: 全部通过（含 2026-09-22 真实日志夹具）')
