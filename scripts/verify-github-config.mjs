#!/usr/bin/env node
/**
 * verify-github-config.mjs — .github/ 下的配置准入守卫（ADR-054）
 *
 * ## 它守什么（两条规则，各自都能静默失效）
 *
 * A. **工作流必须住在 .github/workflows/ 下**。GitHub Actions 只从该目录加载文件；
 *    放在别处的工作流是「看得见、从不运行」的死配置——YAML 合法、编辑器有高亮、
 *    commit 标题也能把它记成已交付，而它一次都不会跑。
 *    真实案例：2026-09-29 的 e9f8dc5「Add Qodo AI PR Agent workflow」把文件放在了
 *    .github/pr-agent.yml。本规则就是为它写的。
 *
 * B. **第三方 action 必须钉到 40 位 commit SHA**。浮动 ref（@v5 / @main / @stable）
 *    会在上游被改动时静默换掉代码——本仓持有发布签名私钥，那是最不该有的组合。
 *
 * ## 为什么 B 有一张基线表
 * `PRE_EXISTING_FLOATING` 是**预先存在**的浮动 ref，属 docs/dev-plan-defect-remediation.md
 * 的 S3-3，尚未执行。本守卫对**新增**浮动 ref 一律报错（防回归），并在基线非空时打印
 * 提示。S3-3 执行后基线必须清空——空表是本守卫的目标状态（与 ALLOW_UNUSED_COMMANDS 同形）。
 *
 * ## 可证伪性
 * --self-test 以「修复前的真实形态」为夹具（错放目录的工作流、@v5 的 action）：
 * 喂进去必须报红。这些夹具用的就是本仓自己踩过的写法，不是构造出来的玩具。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { argv, exit } from 'node:process'

const ROOT = process.cwd()
const WORKFLOW_DIR = join('.github', 'workflows')

export const PRE_EXISTING_FLOATING = [
  // S3-3 未执行：这些是本批之前就存在的浮动 ref。它们不影响本次准入判定，
  // 但基线非空本身就是一条待办（守卫会打印提示）。
  'actions/checkout@v5',
  'actions/setup-node@v5',
  'dtolnay/rust-toolchain@stable',
  'Swatinem/rust-cache@v2',
  'actions/download-artifact@v5',
  'actions/upload-artifact@v6',
  'tauri-apps/tauri-action@v0',
]

/** 一个文件是否是「工作流形态」：同时出现顶层的 on: 与 jobs:。 */
export function isWorkflowShaped(text) {
  return /^on:/m.test(text) && /^jobs:/m.test(text)
}

/** 抽出所有 uses 的 ref（去注释、去引号）。 */
export function extractUses(text) {
  const refs = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/.exec(line)
    if (m) refs.push(m[1].replace(/["']/g, ''))
  }
  return refs
}

export function isShaPinned(ref) {
  const at = ref.lastIndexOf('@')
  if (at === -1) return false
  return /^[0-9a-f]{40}$/i.test(ref.slice(at + 1))
}

export function checkUsesRefs(file, refs, allowedFloating = PRE_EXISTING_FLOATING) {
  const problems = []
  for (const ref of refs) {
    if (ref.startsWith('./') || ref.startsWith('docker://')) continue
    if (isShaPinned(ref)) continue
    if (allowedFloating.includes(ref)) continue
    problems.push(
      file + '：uses 未钉 SHA → ' + ref +
        '（第三方 action 必须钉到 40 位 commit SHA；浮动 ref 会在上游被改动时静默换代码）',
    )
  }
  return problems
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.ya?ml$/.test(entry)) out.push(full)
  }
  return out
}

/** 纯函数：给定 [{path, text}]，返回 problems。路径用 posix 风格以便跨平台判据一致。 */
export function checkFiles(files) {
  const problems = []
  let workflowShaped = 0
  let useRefs = 0
  let misplaced = 0
  for (const f of files) {
    const p = f.path.split(sep).join('/')
    const inWorkflows = p.startsWith('.github/workflows/')
    const shaped = isWorkflowShaped(f.text)
    if (shaped) workflowShaped += 1
    if (shaped && !inWorkflows) {
      misplaced += 1
      problems.push(
        p + '：这是**工作流形态**的 YAML（含顶层 on: 与 jobs:），却不在 .github/workflows/ 下——' +
          'GitHub 从不加载它，它会静默地不运行。挪进 .github/workflows/ 或删掉（ADR-005）。',
      )
    }
    if (inWorkflows) {
      const refs = extractUses(f.text)
      useRefs += refs.length
      problems.push(...checkUsesRefs(p, refs))
    }
  }
  if (workflowShaped === 0) {
    problems.push(
      '扫出 0 个工作流形态的文件——这不是「干净」，是扫描器失效了。' +
        '先怀疑扫描器，再怀疑源码（AGENTS.md §7.3）。',
    )
  }
  if (useRefs === 0) {
    problems.push('扫出 0 个 uses 引用——同上，扫描器或工作流目录有问题，不得判通过。')
  }
  return { problems, workflowShaped, useRefs, misplaced }
}

function main() {
  const files = walk(join(ROOT, '.github')).map((full) => ({
    path: relative(ROOT, full),
    text: readFileSync(full, 'utf8'),
  }))
  const { problems, workflowShaped, useRefs, misplaced } = checkFiles(files)
  console.log(
    '· 扫描 .github 下 ' + files.length + ' 个 YAML：工作流形态 ' + workflowShaped +
      ' 个 · uses 引用 ' + useRefs + ' 个 · 错放 ' + misplaced + ' 个',
  )
  if (PRE_EXISTING_FLOATING.length > 0) {
    console.log(
      '· 提示：仍有 ' + PRE_EXISTING_FLOATING.length + ' 个预先存在的浮动 ref 在基线表里' +
        '（S3-3 未执行）。空表是目标状态。',
    )
  }
  if (problems.length > 0) {
    for (const p of problems) console.error('❌ ' + p)
    return 1
  }
  console.log('✅ .github 配置准入：工作流都在 workflows/ 下，且没有未钉 SHA 的新增 action')
  return 0
}

export function selfTest() {
  let failed = 0
  const check = (name, cond) => { if (!cond) { console.error('❌ ' + name); failed += 1 } }
  const misplacedSample = 'name: PR Agent\non:\n  pull_request:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: qodo-ai/pr-agent@main\n'
  const dependabotSample = 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: "/"\n'
  const pinnedWorkflow = 'on: [push]\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@' + 'a'.repeat(40) + '\n'
  // ⚠️ 夹具不能用 actions/checkout@v5 —— 它在基线表里（预先存在），拿它当夹具等于
  // 让断言恒真。可证伪夹具必须用**基线之外**的浮动 ref，这正是 S3-3 之后的世界。
  const floatingWorkflow = 'on: [push]\njobs:\n  a:\n    steps:\n      - uses: some/other-action@v5\n'
  const newFloating = 'on: [push]\njobs:\n  a:\n    steps:\n      - uses: some/new-action@main\n'
  const localAction = 'on: [push]\njobs:\n  a:\n    steps:\n      - uses: ./.github/actions/local\n'

  check('依赖形态判定：错放的 pr-agent 是工作流形态', isWorkflowShaped(misplacedSample))
  check('依赖形态判定：dependabot.yml 不是工作流形态', !isWorkflowShaped(dependabotSample))
  // 🔴 可伪证夹具 1：错放目录必须报红
  const r1 = checkFiles([{ path: join('.github', 'pr-agent.yml'), text: misplacedSample }])
  check('可伪证：错放目录的工作流必须报红', r1.problems.some((p) => /不在 .github\/workflows\//.test(p)))
  // 🔴 可伪证夹具 2：@v5 必须报红
  const r2 = checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: floatingWorkflow }])
  check('可伪证：@v5 必须报红（基线之外）', r2.problems.some((p) => /未钉 SHA/.test(p)))
  // 基线表要**显式被断言**，否则「基线兜住了本该报红的写法」这件事没人看得见。
  check('预先存在的浮动 ref 走基线（这是待办，不是通过）', checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: 'on: [push]\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v5\n' }]).problems.length === 0)
  const r3 = checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: pinnedWorkflow }])
  check('钉了 SHA 必须通过', r3.problems.length === 0)
  const r4 = checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: localAction }])
  check('本地 action（./）豁免', r4.problems.length === 0)
  const r5 = checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: newFloating }])
  check('基线之外的新浮动 ref 必须报红', r5.problems.some((p) => /未钉 SHA/.test(p)))
  check('dependabot 不进工作流规则', checkFiles([{ path: join('.github', 'dependabot.yml'), text: dependabotSample }, { path: join('.github', 'workflows', 'x.yml'), text: pinnedWorkflow }]).problems.length === 0)
  // 🔴 可伪证夹具 3：扫出 0 个必须判失败（§7.3「扫出来再校验」纪律）
  const r6 = checkFiles([{ path: join('.github', 'dependabot.yml'), text: dependabotSample }])
  check('扫出 0 个工作流必须报错而不是通过', r6.problems.some((p) => /扫描器失效/.test(p)))
  check('uses 数量 0 也必须报错', checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: 'on: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n' }]).problems.some((p) => /0 个 uses/.test(p)))
  if (failed > 0) { console.error('verify-github-config self-test 失败 ' + failed + ' 项'); return 1 }
  console.log('✅ verify-github-config 自检通过（12 项）')
  return 0
}

if (import.meta.url === (await import('node:url')).pathToFileURL(argv[1] ?? '').href) {
  exit(argv.includes('--self-test') ? selfTest() : main())
}
