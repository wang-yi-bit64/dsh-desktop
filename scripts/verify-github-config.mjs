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

/**
 * 基线外的浮动 ref 白名单。**空表是目标状态**——S3-3（2026-09-30）已把全部 7 个
 * 预先存在的浮动 ref 钉到 40 位 SHA，此后任何浮动 ref（不管新旧）一律报红；
 * 本表留作「将来确需豁免时在此登记 + 写理由」的机制，加条目必须附理由。
 */
export const PRE_EXISTING_FLOATING = []

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

/**
 * C. **未加引号的标量里不允许出现 `: `（冒号 + 空格）**。
 *
 * YAML 的纯标量（plain scalar）不包含 `冒号+空格`——出现即被解析成**嵌套映射的键**。
 * GitHub Actions 的加载器对这类文件不会明确报错，而是直接**不认这个 trigger**：
 * 2026-10-06 实测，`- name: Static gates (single source of truth: scripts/gate-manifest.mjs)`
 * 让 `POST /actions/workflows/ci.yml/dispatches` 返回
 * `422 Workflow does not have 'workflow_dispatch' trigger`——而文件里明明写着
 * `workflow_dispatch:`。后果是 CI **无法被手动触发**，且没有任何提示指向这一行。
 *
 * 修法：给整个值加双引号。注意这条**不能用 YAML 解析器兜住**：`yaml.safe_load`
 * 能通过被 `#` 截断的形态（见 authoring-github-workflows 技能），对 `: ` 也只是
 * 在严格模式下才报错；actionlint 能抓住它，但本仓 CI 不跑 actionlint。
 * 因此这里做定向静态检查：只查 `name:` / `run-name:` / `if:` 三种**步级键**，
 * 值未加引号且含 `: ` 即报红。
 */

/** 会被本条规则检查的键（步级，避免误伤 block scalar 内部）。 */
const SCALAR_KEYS = ['name', 'run-name', 'if']

/**
 * 扫描文本里所有 name / run-name / if 标量，并标记哪些是**未加引号且含 `: `**的。
 * @param {string} text
 * @returns {{ line: number, raw: string, unsafe: boolean }[]}
 */
export function scanScalars(text) {
  const found = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*(?:-\s*)?)(name|run-name|if):(\s+)(\S.*)$/.exec(lines[i])
    if (m === null) continue
    if (!SCALAR_KEYS.includes(m[2])) continue
    const value = m[4]
    // 已加引号 / 块标量 / 流式集合开头 → 不归本条管
    const exempt = /^["'|>&*?[\]{}]/.test(value)
    found.push({ line: i + 1, raw: lines[i], unsafe: !exempt && /: /.test(value) })
  }
  return found
}

/**
 * 只取其中「未加引号且含 `: `」的那些（即违例）。
 * @param {string} text
 * @returns {{ line: number, raw: string }[]}
 */
export function extractUnsafeScalars(text) {
  return scanScalars(text)
    .filter((s) => s.unsafe)
    .map(({ line, raw }) => ({ line, raw }))
}

/** 纯函数：给定 [{path, text}]，返回 problems。路径用 posix 风格以便跨平台判据一致。 */
export function checkFiles(files, allowedFloating = PRE_EXISTING_FLOATING) {
  const problems = []
  let workflowShaped = 0
  let useRefs = 0
  let misplaced = 0
  let scalarKeys = 0
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
      problems.push(...checkUsesRefs(p, refs, allowedFloating))
      const scalars = scanScalars(f.text)
      scalarKeys += scalars.length
      for (const u of scalars.filter((s) => s.unsafe)) {
        problems.push(
          `${p}:${u.line}：未加引号的标量里含「冒号 + 空格」——YAML 会把它解析成嵌套映射键，` +
            'GitHub Actions 会因此不认该文件的 trigger（实测表现：dispatch 报 ' +
            '`Workflow does not have \'workflow_dispatch\' trigger`）。修法：给整个值加双引号。',
        )
      }
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
  if (scalarKeys === 0 && workflowShaped > 0) {
    // 「扫出来再校验」纪律：扫出 0 个不是干净，多半是扫描器不认新写法。
    // 注意这里数的是**扫出的标量总数**，不是违例数——违例为 0 是健康状态。
    problems.push(
      '扫出 0 个 name / run-name / if 标量——工作流不可能没有步骤名，先怀疑扫描器，再怀疑源码。',
    )
  }
  return { problems, workflowShaped, useRefs, misplaced, scalarKeys }
}

function main() {
  const files = walk(join(ROOT, '.github')).map((full) => ({
    path: relative(ROOT, full),
    text: readFileSync(full, 'utf8'),
  }))
  const { problems, workflowShaped, useRefs, misplaced, scalarKeys } = checkFiles(files)
  console.log(
    '· 扫描 .github 下 ' + files.length + ' 个 YAML：工作流形态 ' + workflowShaped +
      ' 个 · uses 引用 ' + useRefs + ' 个 · 错放 ' + misplaced + ' 个' +
      ' · 未加引号标量 ' + scalarKeys + ' 个',
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
  const pinnedWorkflow = 'on: [push]\njobs:\n  a:\n    steps:\n      - name: checkout\n        uses: actions/checkout@' + 'a'.repeat(40) + '\n'
  // ⚠️ 夹具不能用 actions/checkout@v5 —— 它在基线表里（预先存在），拿它当夹具等于
  // 让断言恒真。可证伪夹具必须用**基线之外**的浮动 ref，这正是 S3-3 之后的世界。
  const floatingWorkflow = 'on: [push]\njobs:\n  a:\n    steps:\n      - uses: some/other-action@v5\n'
  const newFloating = 'on: [push]\njobs:\n  a:\n    steps:\n      - uses: some/new-action@main\n'
  const localAction = 'on: [push]\njobs:\n  a:\n    steps:\n      - name: local\n        uses: ./.github/actions/local\n'

  check('依赖形态判定：错放的 pr-agent 是工作流形态', isWorkflowShaped(misplacedSample))
  check('依赖形态判定：dependabot.yml 不是工作流形态', !isWorkflowShaped(dependabotSample))
  // 🔴 可伪证夹具 1：错放目录必须报红
  const r1 = checkFiles([{ path: join('.github', 'pr-agent.yml'), text: misplacedSample }])
  check('可伪证：错放目录的工作流必须报红', r1.problems.some((p) => /不在 .github\/workflows\//.test(p)))
  // 🔴 可伪证夹具 2：@v5 必须报红
  const r2 = checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: floatingWorkflow }])
  check('可伪证：@v5 必须报红（基线之外）', r2.problems.some((p) => /未钉 SHA/.test(p)))
  // 基线机制要**显式被断言**，否则「基线兜住本该报红的写法」这件事没人看得见。
  // S3-3（2026-09-30）后全局基线是**空表**，因此机制测试改为注入式：显式传一个
  // 带浮动 ref 的 allowedFloating，验证该机制本身仍工作；空基线下的真实仓库里
  // 同样的写法必须报红（与可伪证夹具 2 同一条断言）。
  check(
    '基线机制：显式注入的 allowedFloating 必须放行其条目',
    checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: 'on: [push]\njobs:\n  a:\n    steps:\n      - name: checkout\n        uses: actions/checkout@v5\n' }], ['actions/checkout@v5']).problems.length === 0
  )
  check('S3-3 后基线为空：checkout@v5 在真实仓库里必须报红', checkUsesRefs('x.yml', ['actions/checkout@v5'], PRE_EXISTING_FLOATING).length === 1)
  const r3 = checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: pinnedWorkflow }])
  check('钉了 SHA 必须通过', r3.problems.length === 0)
  const r4 = checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: localAction }])
  check('本地 action（./）豁免', r4.problems.length === 0)
  const r5 = checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: newFloating }])
  check('基线之外的新浮动 ref 必须报红', r5.problems.some((p) => /未钉 SHA/.test(p)))
  check('dependabot 不进工作流规则', checkFiles([{ path: join('.github', 'dependabot.yml'), text: dependabotSample }, { path: join('.github', 'workflows', 'x.yml'), text: pinnedWorkflow }]).problems.length === 0)
  // 🔴 可伪证夹具 4：真实事故行——`- name: Static gates (single source of truth: …)`
  //    它在 2026-10-06 之前让 ci.yml / release.yml 都无法被 workflow_dispatch 触发。
  const colonSpaceWorkflow = [
    'on:',
    '  workflow_dispatch:',
    '  schedule:',
    "    - cron: '41 2 * * *'",
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Static gates (single source of truth: scripts/gate-manifest.mjs)',
    '        run: npm run gate',
    '      - uses: actions/checkout@' + 'a'.repeat(40),
    '',
  ].join('\n')
  const r7 = checkFiles([{ path: join('.github', 'workflows', 'ci.yml'), text: colonSpaceWorkflow }])
  check(
    '可伪证：未加引号标量含「冒号+空格」必须报红（真实事故：dispatch 失效）',
    r7.problems.some((p) => /冒号 \+ 空格/.test(p)),
  )
  // 同一行加引号后必须放行——否则本条规则会把所有步骤名都毙掉。
  const quoted = colonSpaceWorkflow.replace(
    '- name: Static gates (single source of truth: scripts/gate-manifest.mjs)',
    '- name: "Static gates (single source of truth: scripts/gate-manifest.mjs)"',
  )
  check(
    '加引号后必须放行',
    checkFiles([{ path: join('.github', 'workflows', 'ci.yml'), text: quoted }]).problems.length === 0,
  )
  // run: / shell: 这类块标量与普通字符串值不归本条管（不含冒号空格也不该被误报）。
  check(
    '普通步骤名不受影响',
    extractUnsafeScalars('jobs:\n  a:\n    steps:\n      - name: build\n        run: make\n').length === 0,
  )
  // 已加引号 / 流式开头 / 块标量三种形态都不报。
  check(
    '引号、流式、块标量形态不误报',
    extractUnsafeScalars(
      '- name: "a: b"\n- run-name: ${{ inputs.x }}\n- if: |\n    a: b\n- name: [x, y]\n',
    ).length === 0,
  )
  // 「扫出 0 个标量」必须判失败（§7.3 纪律）：空夹具证明扫描器有输出能力。
  check(
    '扫出 0 个标量也必须报错而不是通过',
    checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: 'on: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@' + 'a'.repeat(40) + '\n' }]).problems.some((p) => /0 个 name/.test(p)),
  )
  // 🔴 可伪证夹具 3：扫出 0 个必须判失败（§7.3「扫出来再校验」纪律）
  const r6 = checkFiles([{ path: join('.github', 'dependabot.yml'), text: dependabotSample }])
  check('扫出 0 个工作流必须报错而不是通过', r6.problems.some((p) => /扫描器失效/.test(p)))
  check('uses 数量 0 也必须报错', checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: 'on: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n' }]).problems.some((p) => /0 个 uses/.test(p)))
  if (failed > 0) { console.error('verify-github-config self-test 失败 ' + failed + ' 项'); return 1 }
  console.log('✅ verify-github-config 自检通过（17 项）')
  return 0
}

if (import.meta.url === (await import('node:url')).pathToFileURL(argv[1] ?? '').href) {
  exit(argv.includes('--self-test') ? selfTest() : main())
}
