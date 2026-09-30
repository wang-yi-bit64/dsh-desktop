#!/usr/bin/env node
/**
 * verify-fast.mjs — 门禁分档编排（缺陷治理计划 S4-1/S4-2，治 D8）
 *
 * ## 分档
 *   fast（默认）   = 全部 `*:self-test` 纯逻辑自检 + 快速静态门禁 + 无头三 crate 的
 *                   `cargo test --tests`（**不含 doc-test**——44 项 doc-test 单轮
 *                   ≥258s，是本地反馈慢的最大单项）。
 *   full（--full）  = fast 的全部内容 + doc-test（`cargo test` 不带 `--tests`）。
 *
 * ## 编排规则
 *   · `*:self-test` 从 package.json **自动发现**（不手抄清单），并断言发现数 > 0
 *     ——扫描器认不出新写法时会静默清空（本仓已踩两次：verify-claims 的表格解析、
 *     verify-harness-entry 的 E5），这里必须报错而不是空转变绿。
 *   · 顺序执行、逐项打印 ✅/❌ 与耗时；任何一项非零退出 → 整体退出 1（失败摘要只取
 *     尾部几行——编排器的职责是告诉你哪一步红了，不是复述它的完整输出）。
 *   · 本脚本只编排、不实现判据；上面每一项都有自己的可证伪自检，红在哪一步就去修那一步。
 *
 * ## 与 CI 的分工
 *   · ci.yml 的 PR / dispatch 路径 = 本脚本的 fast 档（`cargo test --workspace --tests`）；
 *   · doc-test（full 档）只挂在 ci.yml 的每日 schedule 上——它是 ADR-055 语义下的
 *     「最后一道网」，不是快反馈；
 *   · 发布前手动跑 `npm run verify:full`（或依赖 CI 已在 schedule 里跑过 doc-test）。
 *
 * ## 用法
 *   npm run verify:fast        # ≤60s（温编译；冷编译另计——首次 checkout 先 cargo build）
 *   npm run verify:full        # fast + doc-test
 *
 * 退出码：`0` 全绿 · `1` 有失败或编排器自身失效。
 */

import { argv, exit } from 'node:process'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const full = argv.includes('--full')

// 快速静态门禁（check 模式，秒级；它们的自检变体已由 :self-test 自动发现覆盖）。
// 刻意**不含**需要联网或真实外部状态的检查（verify:drift / verify:update-channel
// 的真检查）——它们会因外部状态红，属哨兵而非快反馈（ADR-030 / S1-3 的理由）。
const QUICK_STATIC = [
  'verify:claims',
  'verify:plan-facts',
  'verify:doc-facts',
  'verify:version',
  'verify:github-config',
  'verify:ipc-surface',
  'verify:shell-pages',
  'verify:harness-entry',
  'verify:harness-inject',
  'verify:fault-patterns',
  'verify:patches',
  'verify:release-workflow',
  'verify:release-assets',
  'verify:profile-names',
  'verify:target -- --self-test',
]

function discoverSelfTests() {
  const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  const names = Object.keys(pkg.scripts ?? {})
  const selfTests = names.filter((n) => n.endsWith(':self-test'))
  if (selfTests.length === 0) {
    throw new Error('package.json 里一个 :self-test 都没扫到——脚本命名形态变了，先怀疑本扫描器（「扫出数>0」纪律）')
  }
  return selfTests
}

function run(label, args) {
  const t0 = Date.now()
  const r = spawnSync(args[0], args.slice(1), {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  const ok = r.status === 0
  console.log(`${ok ? '✅' : '❌'} ${label}（${dt}s）`)
  if (!ok) {
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-6).join('\n  ')
    if (tail.length > 0) console.error('  ' + tail)
  }
  return ok
}

const steps = []
for (const s of discoverSelfTests()) {
  steps.push([`npm run ${s}`, ['npm', 'run', '--silent', s]])
}
for (const s of QUICK_STATIC) {
  steps.push([`npm run ${s}`, ['npm', 'run', '--silent', ...s.split(' ')]])
}
steps.push([
  full ? 'cargo test（含 doc-test，full 档）' : 'cargo test --tests（无 doc-test，fast 档）',
  full
    ? ['cargo', 'test', '-p', 'dsh-contracts', '-p', 'dsh-host', '-p', 'dsh-host-cli']
    : ['cargo', 'test', '--tests', '-p', 'dsh-contracts', '-p', 'dsh-host', '-p', 'dsh-host-cli'],
])

const tier = full ? 'full' : 'fast'
console.log(`verify:${tier} — 共 ${steps.length} 步`)
let failed = 0
for (const [label, args] of steps) {
  if (!run(label, args)) failed += 1
}
if (failed === 0) {
  console.log(`✅ verify:${tier} 全绿（${steps.length} 步）`)
  exit(0)
}
console.error(`❌ verify:${tier}：${failed} 步失败`)
exit(1)
