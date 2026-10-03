#!/usr/bin/env node
/**
 * verify-doc-facts.mjs — 文档↔常量派生事实对账（缺陷治理计划 S2-3，治 D4/D8）
 *
 * ## 为什么有它
 * 2026-09-30 实测到两次真实的文档漂移：AGENTS.md 写 `rust-version = 1.85` 而
 * Cargo.toml 已是 `1.90`；ADR 计数宣称 36 篇而实际 40 篇。两处都靠人工对账发现，
 * 没有任何守卫会拦——「文档是被测方，常量是产地」：产地只有一个，宣称必须逐字对上。
 *
 * ## 对账的事实类别（产地 → 被测宣称）
 *   1. rust-version (MSRV)   Cargo.toml `rust-version` → AGENTS.md「当前 `X`」槽位、
 *                            两份 README 前置条件节「`>= X`」。AGENTS 同行的
 *                            「旧值 1.85」是历史记录，模式锚定「当前」槽位、不会误伤。
 *   2. Node 运行时大版本     `.nvmrc` → 两份 README 的前置条件「vX」与
 *                            「内置运行时 (vX)」共 4 个宣称槽位。
 *   3. MIN_NODE_MAJOR        `crates/dsh-contracts/src/constants.rs` → 文档宣称。
 *                            ⚠️ 当前**所有文档都未宣称**它（实测 0 命中）——零宣称是
 *                            合法状态（没有宣称就没有漂移面），此时只提示不报错；
 *                            但**一旦出现宣称**，数值必须与常量一致。它与「扫出数
 *                            必须为 0 即失败」的区别：那条纪律管的是「守卫自己的
 *                            检查清单被写法变更清空」（如扫工作流、扫命令面），
 *                            这里被扫的是「文档里可存在可不存在的宣称」。
 *   4. license 三处一致      package.json `license` == Cargo.toml `license` ==
 *                            LICENSE 首个非空行（且含 MIT 授权正文；删 LICENSE 即红——S0-1）。
 *   5. ADR 计数              `docs/adr/NNN-*.md` 文件数 → AGENTS.md「（N 篇）」。
 *   6. 通道在役/休眠状态     `scripts/dsh-targets.mjs` 的 `status` 字段 → AGENTS.md §7.2
 *                            「双上游运行时通道」行与 runbook Drift 行里的槽位
 *                            「在役通道：`a` / `b`；休眠通道：无|`c`」。两份文档
 *                            都必须有槽位（缺失即红），集合必须与目标表逐一相等。
 *                            由来：2026-09-30 ADR-057 已让 alpha 复役，AGENTS §7.2 /
 *                            runbook / SECURITY 仍写「alpha 休眠」到 2026-10-03 才被发现。
 *                            ⚠️ 只对账槽位；槽位之外的散文（历史记录里大量合法的
 *                            「休眠」）不扫——那会误伤历史，换来的是一个没人敢碰的守卫。
 *   7. 命令速查表覆盖        `package.json` 的每个 npm script 名都必须在 `docs/commands.md`
 *                            里以 `npm run <name>` 出现（该文件自称「含全部 npm script 名」）。
 *                            由来：2026-10-03 实测漏了 `prepare:harness` / `verify:harness-tree` /
 *                            `verify:relocate-hunks` / `verify:ipc-surface:self-test` 四个。
 *   8. IPC 命令数            `src-tauri/src/commands.rs` 的 `#[tauri::command]` 条数 → AGENTS §7.2
 *                            「N 个命令」槽位与两份 README 的命令面宣称。由来：2026-10-03 实测
 *                            已增至 21（新增 `portable_mode`）而七份文档仍写 20。
 *
 * ## 可证伪性（自检夹具）
 *   · 以 2026-09-30 的真实漂移为夹具：文档写 1.85 / 产地 1.90 必须报红；
 *     ADR 宣称 36 / 实际 41 必须报红。
 *   · 以 2026-10-03 的真实漂移为夹具：目标表两线在役、文档槽位写「休眠通道：`alpha`」
 *     必须报红。
 *   · 以「宣称槽位消失」为夹具：喂入不含该宣称的文档必须报红——宣称被悄悄删掉
 *     同样是漂移（E5-空 的教训：扫出 0 时先怀疑被测对象，再怀疑扫描器）。
 *   · 以 2026-10-03 的真实漂移为夹具：commands.md 漏登一个 script 名必须报红；
 *     宣称句被删、package.json 零 script 同样必须报红（否则守卫两头都能静默变绿）。
 *   · 以 2026-10-03 的真实漂移为夹具：命令数宣称 20、实际 21 必须报红；槽位被删与
 *     实际扫出 0 条命令同样报红。
 *
 * ## 用法
 *   node scripts/verify-doc-facts.mjs              # 对账（CI + 本地）
 *   node scripts/verify-doc-facts.mjs --self-test  # 纯逻辑自检
 *
 * 退出码：`0` 一致 · `1` 有漂移或自检失败 · `2` 参数错误。
 */

import { argv, exit } from 'node:process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_TARGETS } from './dsh-targets.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function read(rel) {
  return readFileSync(join(projectRoot, rel), 'utf8')
}

/** 单条宣称对账：模式必须命中，且捕获组必须与产地相等。返回 null=通过，字符串=问题。 */
export function checkMention({ expected, doc, text, re }) {
  const m = re.exec(text)
  if (!m) {
    return `${doc}：未找到该事实的宣称槽位——宣称被改写或删除也是一种漂移（预期 ${expected}）`
  }
  if (m[1] !== String(expected)) {
    return `${doc}：宣称 ${m[1]} ≠ 产地 ${expected}`
  }
  return null
}

/** license 三处一致：package.json / Cargo.toml / LICENSE 文件本体。 */
export function checkLicense({ pkgLicense, cargoLicense, licenseExists, licenseHead }) {
  const problems = []
  if (!licenseExists) {
    problems.push('LICENSE：文件不存在——S0-1 的「删除 LICENSE 必须报红」夹具就是它')
    return problems
  }
  const firstNonEmpty = (licenseHead.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '').trim()
  if (firstNonEmpty !== 'MIT License') {
    problems.push(`LICENSE：首个非空行是「${firstNonEmpty}」，不是「MIT License」`)
  }
  if (!/Permission is hereby granted/.test(licenseHead)) {
    problems.push('LICENSE：缺少 MIT 授权正文（Permission is hereby granted）——像是一份空壳文件')
  }
  const trio = [
    ['package.json', pkgLicense],
    ['Cargo.toml', cargoLicense],
    ['LICENSE（首个非空行推断）', firstNonEmpty === 'MIT License' ? 'MIT' : '(非 MIT)'],
  ]
  const distinct = new Set(trio.map(([, v]) => v))
  if (distinct.size > 1) {
    problems.push(`license 三处字面量不一致：${trio.map(([d, v]) => `${d}=${v}`).join(' / ')}`)
  }
  return problems
}

/** ADR 计数：AGENTS.md 宣称的篇数必须等于 docs/adr/ 下 NNN-*.md 的实际数。 */
export function checkAdrCount({ claimed, actual }) {
  if (claimed === null) {
    return ['AGENTS.md：找不到「架构决策记录库（N 篇）」的宣称槽位']
  }
  if (Number(claimed) !== actual) {
    return [`AGENTS.md：ADR 计数宣称 ${claimed} 篇 ≠ 实际 ${actual} 篇（2026-09-30 真实漂移：宣称 36、实际 40）`]
  }
  return []
}

const CHANNEL_SLOT_RE = /在役通道：([^；|\n]*)；休眠通道：([^）|\n—；]*)/g

function parseChannelList(cell) {
  const names = [...cell.matchAll(/`([\w-]+)`/g)].map((m) => m[1])
  if (names.length === 0 && cell.trim() !== '无') return null
  return names.sort()
}

/**
 * 通道状态槽位对账：文档里每个「在役通道：…；休眠通道：…」槽位的两个集合
 * 必须与目标表的 status 逐一相等。没有槽位即红（宣称被删也是漂移）。
 *
 * @param {{doc: string, text: string, targets: Record<string, {status: string}>}} args
 * @returns {string[]}
 */
export function checkChannelStatus({ doc, text, targets }) {
  const want = { active: [], dormant: [] }
  for (const [name, t] of Object.entries(targets)) (t.status === 'dormant' ? want.dormant : want.active).push(name)
  want.active.sort()
  want.dormant.sort()
  const slots = [...text.matchAll(CHANNEL_SLOT_RE)]
  if (slots.length === 0) {
    return [`${doc}：未找到「在役通道：…；休眠通道：…」槽位——宣称被改写或删除也是一种漂移`]
  }
  const problems = []
  for (const m of slots) {
    const active = parseChannelList(m[1])
    const dormant = parseChannelList(m[2])
    if (active === null || dormant === null) {
      problems.push(`${doc}：槽位「${m[0]}」无法解析（通道名须用反引号，空集写「无」）`)
      continue
    }
    const fmt = (xs) => (xs.length ? xs.join(' / ') : '无')
    if (JSON.stringify(active) !== JSON.stringify(want.active) || JSON.stringify(dormant) !== JSON.stringify(want.dormant)) {
      problems.push(
        `${doc}：宣称 在役=${fmt(active)}、休眠=${fmt(dormant)} ≠ 目标表 在役=${fmt(want.active)}、休眠=${fmt(want.dormant)}（产地 scripts/dsh-targets.mjs 的 status）`
      )
    }
  }
  return problems
}

const SCRIPT_MAP_DOC = 'docs/commands.md'

/**
 * 命令速查表覆盖对账：`docs/commands.md` 自称「含全部 npm script 名」，
 * 因此 `package.json` 的每个 script 都必须以 `npm run <name>` 的形式出现在其中。
 *
 * 两头都要防静默变绿：宣称句被删（无可测对象）与 scripts 为空（读取端坏了）都判红——
 * 这正是文件头 E5-空 纪律要求的「扫出数 > 0」断言。
 *
 * @param {{doc: string, text: string, scripts: string[]}} args
 * @returns {string[]}
 */
export function checkScriptMap({ doc, text, scripts }) {
  if (!/全部 npm script 名/.test(text)) {
    return [`${doc}：找不到「全部 npm script 名」宣称——宣称被删除或改写也是一种漂移`]
  }
  if (scripts.length === 0) {
    return [`${doc}：package.json 里一个 npm script 都没读到——先怀疑读取端，再怀疑源文件`]
  }
  const mentioned = new Set([...text.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1]))
  return [...scripts]
    .sort()
    .filter((s) => !mentioned.has(s))
    .map((s) => `${doc}：npm script \`${s}\` 未登记——该文件头部声明「含全部 npm script 名」（package.json 共 ${scripts.length} 个）`)
}

const COMMAND_CLAIMS = [
  { doc: 'AGENTS.md', re: /的 \*\*(\d+) 个命令\*\*中/ },
  { doc: 'README.md', re: /20 of the (\d+) Tauri commands/ },
  { doc: 'README.zh-CN.md', re: /\*\*(\d+) 个命令中 20 个\*\*/ }
]

/**
 * IPC 命令数对账：`commands.rs` 的 `#[tauri::command]` 条数是产地，
 * 文档里的「N 个命令」是宣称。text 由调用方传入，自检不碰文件系统。
 * 空扫描同样判红（E5-空 纪律）。
 *
 * @param {{actual: number, claims: {doc: string, text: string, re: RegExp}[]}} args
 * @returns {string[]}
 */
export function checkCommandCount({ actual, claims }) {
  if (!Number.isInteger(actual) || actual <= 0) {
    return ['commands.rs：扫出 0 个 `#[tauri::command]`——先怀疑扫描器，再怀疑源文件']
  }
  const problems = []
  for (const { doc, text, re } of claims) {
    const m = re.exec(text)
    if (!m) {
      problems.push(`${doc}：未找到命令数宣称槽位——宣称被改写或删除也是一种漂移（实际 ${actual}）`)
      continue
    }
    if (m[1] !== String(actual)) problems.push(`${doc}：宣称 ${m[1]} 个命令 ≠ 实际 ${actual} 个`)
  }
  return problems
}

export function selfTest() {
  let failed = 0
  let passed = 0
  const eq = (label, got, want) => {
    passed += 1
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failed += 1
      console.error(`❌ ${label}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
    }
  }
  const hasProblem = (label, problems) => eq(label, Array.isArray(problems) && problems.length > 0, true)

  // 🔴 可伪证夹具 1：2026-09-30 的真实漂移——文档写 1.85、产地 1.90 必须报红。
  const agentsShape = (v) => `- **Rust 工具链**：**唯一产地是 \`Cargo.toml\` 的 \`rust-version\`**（当前 \`${v}\`；Tauri 2.12 起上调，旧值 1.85 源于 \`idna_adapter\` 的 edition 2024）。`
  eq('rust：当前值一致', checkMention({ expected: '1.90', doc: 'AGENTS.md', text: agentsShape('1.90'), re: /（当前 `(\d+\.\d+)`；/ }), null)
  hasProblem('rust：真实历史漂移（1.85 vs 1.90）必须报红', [checkMention({ expected: '1.90', doc: 'AGENTS.md', text: agentsShape('1.85'), re: /（当前 `(\d+\.\d+)`；/ })])
  hasProblem('rust：宣称槽位消失必须报红（E5-空 教训）', [checkMention({ expected: '1.90', doc: 'AGENTS.md', text: '- **Rust 工具链**：见 Cargo.toml。', re: /（当前 `(\d+\.\d+)`；/ })])
  // 模式不得误伤同行的「旧值 1.85」历史记录。
  eq('rust：模式不误伤「旧值 1.85」', checkMention({ expected: '1.90', doc: 'AGENTS.md', text: agentsShape('1.90'), re: /（当前 `(\d+\.\d+)`；/ }), null)

  // 🔴 可伪证夹具 2：Node 大版本漂移。
  const readmeNode = (v) => `- [Node.js](https://nodejs.org/) (v${v} — see [\`.nvmrc\`](.nvmrc))`
  eq('node：一致', checkMention({ expected: 24, doc: 'README.md', text: readmeNode(24), re: /\[Node\.js\]\([^)]*\) \(v(\d+)/ }), null)
  hasProblem('node：宣称 23、产地 24 必须报红', [checkMention({ expected: 24, doc: 'README.md', text: readmeNode(23), re: /\[Node\.js\]\([^)]*\) \(v(\d+)/ })])

  // 🔴 可伪证夹具 3：license 三处不一致 / LICENSE 缺失 / 非 MIT。
  hasProblem('license：三处不一致必须报红', checkLicense({ pkgLicense: 'MIT', cargoLicense: 'Apache-2.0', licenseExists: true, licenseHead: 'MIT License\n\nCopyright...' }))
  hasProblem('license：LICENSE 被删必须报红（S0-1 夹具）', checkLicense({ pkgLicense: 'MIT', cargoLicense: 'MIT', licenseExists: false, licenseHead: '' }))
  hasProblem('license：空壳 LICENSE 必须报红', checkLicense({ pkgLicense: 'MIT', cargoLicense: 'MIT', licenseExists: true, licenseHead: 'MIT License' }))
  eq('license：三处一致', checkLicense({ pkgLicense: 'MIT', cargoLicense: 'MIT', licenseExists: true, licenseHead: 'MIT License\n\nCopyright (c) 2026 wang-yi-bit64\n\nPermission is hereby granted, free of charge...' }), [])

  // 🔴 可伪证夹具 4：ADR 计数漂移（真实历史：宣称 36、实际 40）。
  hasProblem('adr：宣称 36、实际 41 必须报红', checkAdrCount({ claimed: '36', actual: 41 }))
  eq('adr：宣称与实际一致', checkAdrCount({ claimed: '41', actual: 41 }), [])
  hasProblem('adr：宣称槽位消失必须报红', checkAdrCount({ claimed: null, actual: 41 }))

  // MIN_NODE_MAJOR 对账逻辑：出现宣称时数值必须一致（零宣称合法——见文件头说明）。
  hasProblem('min-node：宣称 18、产地 20 必须报红', [checkMention({ expected: 20, doc: 'AGENTS.md', text: '宿主最低 Node：MIN_NODE_MAJOR = 18', re: /MIN_NODE_MAJOR[^\d]{0,20}(\d+)/ })]
    .filter(Boolean))
  eq('min-node：宣称 20 与产地一致', checkMention({ expected: 20, doc: 'AGENTS.md', text: '宿主最低 Node：MIN_NODE_MAJOR = 20', re: /MIN_NODE_MAJOR[^\d]{0,20}(\d+)/ }), null)

  // 🔴 可伪证夹具 5：2026-10-03 的真实漂移——目标表两线在役，文档仍写 alpha 休眠。
  const bothActive = { next: { status: 'active' }, alpha: { status: 'active' } }
  const slot = (a, d) => `| ✅ 已接线（2026-09-15；在役通道：${a}；休眠通道：${d}——见 ADR） |`
  eq('channel：槽位与目标表一致', checkChannelStatus({ doc: 'AGENTS.md', text: slot('`next` / `alpha`', '无'), targets: bothActive }), [])
  eq('channel：顺序无关', checkChannelStatus({ doc: 'AGENTS.md', text: slot('`alpha` / `next`', '无'), targets: bothActive }), [])
  hasProblem('channel：真实历史漂移（目标在役、文档写休眠）必须报红', checkChannelStatus({ doc: 'AGENTS.md', text: slot('`next`', '`alpha`'), targets: bothActive }))
  hasProblem('channel：反向漂移（目标休眠、文档写在役）必须报红', checkChannelStatus({ doc: 'AGENTS.md', text: slot('`next` / `alpha`', '无'), targets: { next: { status: 'active' }, alpha: { status: 'dormant' } } }))
  eq('channel：休眠集合非空且一致', checkChannelStatus({ doc: 'AGENTS.md', text: slot('`next`', '`alpha`'), targets: { next: { status: 'active' }, alpha: { status: 'dormant' } } }), [])
  hasProblem('channel：槽位消失必须报红（E5-空 教训）', checkChannelStatus({ doc: 'AGENTS.md', text: '| ✅ 已接线（alpha 线 2026-09-30 起休眠） |', targets: bothActive }))
  hasProblem('channel：漏写反引号的槽位必须报红而非静默为空', checkChannelStatus({ doc: 'AGENTS.md', text: slot('next / alpha', '无'), targets: bothActive }))
  eq('channel：CRLF 与 LF 一致', checkChannelStatus({ doc: 'AGENTS.md', text: `x\r\n${slot('`next` / `alpha`', '无')}\r\n`, targets: bothActive }), [])

  // 🔴 可伪证夹具 6：2026-10-03 的真实漂移——commands.md 漏登四个 script 名。
  const mapText = (names) => `> 含全部 npm script 名\n${names.map((n) => `npm run ${n}`).join('\n')}`
  eq('script-map：全覆盖', checkScriptMap({ doc: 'docs/commands.md', text: mapText(['dev', 'build', 'verify:fast']), scripts: ['dev', 'build', 'verify:fast'] }), [])
  eq('script-map：顺序无关', checkScriptMap({ doc: 'docs/commands.md', text: mapText(['verify:fast', 'dev']), scripts: ['dev', 'verify:fast'] }), [])
  hasProblem('script-map：真实历史漂移（漏登 prepare:harness）必须报红', checkScriptMap({ doc: 'docs/commands.md', text: mapText(['dev', 'build']), scripts: ['dev', 'build', 'prepare:harness'] }))
  hasProblem('script-map：宣称句被删必须报红（E5-空 教训）', checkScriptMap({ doc: 'docs/commands.md', text: 'npm run dev', scripts: ['dev'] }))
  hasProblem('script-map：scripts 为空必须报红（读取端静默归零）', checkScriptMap({ doc: 'docs/commands.md', text: mapText(['dev']), scripts: [] }))
  eq('script-map：CRLF 与 LF 一致', checkScriptMap({ doc: 'docs/commands.md', text: `含全部 npm script 名\r\nnpm run dev\r\n`, scripts: ['dev'] }), [])

  // 🔴 可伪证夹具 7：2026-10-03 的真实漂移——命令数已 21，文档仍写 20。
  const cmdClaim = (doc, text, re) => [{ doc, text, re }]
  eq('command-count：一致', checkCommandCount({ actual: 21, claims: cmdClaim('AGENTS.md', '的 **21 个命令**中 20 个', /的 \*\*(\d+) 个命令\*\*中/) }), [])
  hasProblem('command-count：真实历史漂移（宣称 20、实际 21）必须报红', checkCommandCount({ actual: 21, claims: cmdClaim('README.md', '20 of the 20 Tauri commands', /20 of the (\d+) Tauri commands/) }))
  hasProblem('command-count：槽位被删必须报红（E5-空 教训）', checkCommandCount({ actual: 21, claims: cmdClaim('AGENTS.md', '命令面见 commands.rs', /的 \*\*(\d+) 个命令\*\*中/) }))
  hasProblem('command-count：扫出 0 条命令必须报红', checkCommandCount({ actual: 0, claims: cmdClaim('AGENTS.md', '的 **21 个命令**中', /的 \*\*(\d+) 个命令\*\*中/) }))

  if (failed > 0) {
    console.error(`verify-doc-facts 自检失败 ${failed} 项`)
    return 1
  }
  console.log(`✅ verify-doc-facts 自检通过（${passed} 项）`)
  return 0
}

async function main() {
  if (argv.includes('--self-test')) return selfTest()

  const problems = []
  let mentions = 0

  // ── 1. rust-version ─────────────────────────────────────────────
  const cargo = read('Cargo.toml')
  const rustVersion = /rust-version\s*=\s*"(\d+\.\d+)"/.exec(cargo)?.[1] ?? null
  if (rustVersion === null) {
    problems.push('Cargo.toml：找不到 rust-version——产地丢了，其余对账无从谈起')
  } else {
    for (const [doc, rel, re] of [
      ['AGENTS.md', 'AGENTS.md', /（当前 `(\d+\.\d+)`；/],
      ['README.md', 'README.md', /\(stable, `>= (\d+\.\d+)`[^\n]*rust-version/],
      ['README.zh-CN.md', 'README.zh-CN.md', /（stable，`>= (\d+\.\d+)`[^\n]*rust-version/],
    ]) {
      mentions += 1
      const p = checkMention({ expected: rustVersion, doc, text: read(rel), re })
      if (p) problems.push(`rust-version：${p}`)
    }
  }

  // ── 2. Node 运行时大版本（.nvmrc） ──────────────────────────────
  const nvmrc = read('.nvmrc').trim()
  const nodeMajor = /^(\d+)\./.exec(nvmrc)?.[1] ?? null
  if (nodeMajor === null) {
    problems.push('.nvmrc：解析不到大版本号——产地丢了')
  } else {
    for (const [doc, rel, re] of [
      ['README.md（前置条件）', 'README.md', /\[Node\.js\]\([^)]*\) \(v(\d+)/],
      ['README.md（内置运行时）', 'README.md', /Ships its own Node\.js \(v(\d+)\)/],
      ['README.zh-CN.md（前置条件）', 'README.zh-CN.md', /\[Node\.js\]\([^)]*\)（v(\d+)/],
      ['README.zh-CN.md（内置运行时）', 'README.zh-CN.md', /自带 Node\.js \(v(\d+)\)/],
    ]) {
      mentions += 1
      const p = checkMention({ expected: nodeMajor, doc, text: read(rel), re })
      if (p) problems.push(`node 大版本：${p}`)
    }
  }

  // ── 3. MIN_NODE_MAJOR（零宣称合法——见文件头说明） ─────────────
  const minNode = /MIN_NODE_MAJOR:\s*u32\s*=\s*(\d+)/.exec(read('crates/dsh-contracts/src/constants.rs'))?.[1] ?? null
  if (minNode !== null) {
    const claimRe = /MIN_NODE_MAJOR[^\d]{0,20}(\d+)/
    let claimed = 0
    for (const rel of ['AGENTS.md', 'README.md', 'README.zh-CN.md', 'docs/commands.md']) {
      for (const m of read(rel).matchAll(new RegExp(claimRe.source, 'g'))) {
        claimed += 1
        if (m[1] !== minNode) problems.push(`MIN_NODE_MAJOR：${rel} 宣称 ${m[1]} ≠ 常量 ${minNode}`)
      }
    }
    if (claimed === 0) {
      console.log(`· MIN_NODE_MAJOR（=${minNode}）：当前无文档宣称——零宣称合法，命中时才断言`)
    }
  }

  // ── 4. license 三处一致 ─────────────────────────────────────────
  const pkgLicense = JSON.parse(read('package.json')).license ?? null
  const cargoLicense = /(^|\n)license\s*=\s*"([^"]+)"/.exec(cargo)?.[2] ?? null
  const licenseExists = existsSync(join(projectRoot, 'LICENSE'))
  const licenseHead = licenseExists ? read('LICENSE') : ''
  mentions += 1
  problems.push(...checkLicense({ pkgLicense, cargoLicense, licenseExists, licenseHead }).map((p) => `license：${p}`))

  // ── 5. ADR 计数 ─────────────────────────────────────────────────
  const adrFiles = readdirSync(join(projectRoot, 'docs', 'adr')).filter((f) => /^\d{3}-/.test(f)).length
  const agentsText = read('AGENTS.md')
  const adrClaim = /架构决策记录库（(\d+) 篇/.exec(agentsText)?.[1] ?? null
  mentions += 1
  problems.push(...checkAdrCount({ claimed: adrClaim, actual: adrFiles }).map((p) => `ADR 计数：${p}`))

  // ── 6. 通道在役/休眠状态 ────────────────────────────────────────
  for (const rel of ['AGENTS.md', 'docs/release-runbook.md']) {
    mentions += 1
    problems.push(...checkChannelStatus({ doc: rel, text: read(rel), targets: DSH_TARGETS }).map((p) => `通道状态：${p}`))
  }

  // ── 7. 命令速查表覆盖全部 npm script ────────────────────────────
  const pkgScripts = Object.keys(JSON.parse(read('package.json')).scripts ?? {})
  mentions += 1
  problems.push(...checkScriptMap({ doc: SCRIPT_MAP_DOC, text: read(SCRIPT_MAP_DOC), scripts: pkgScripts }).map((p) => `script map：${p}`))

  // ── 8. IPC 命令数 ───────────────────────────────────────────────
  const commandCount = read('src-tauri/src/commands.rs')
    .split(/\r?\n/)
    .filter((line) => /^\s*#\[tauri::command\]\s*$/.test(line)).length
  mentions += 1
  problems.push(...checkCommandCount({ actual: commandCount, claims: COMMAND_CLAIMS.map(({ doc, re }) => ({ doc, text: read(doc), re })) }).map((p) => `命令数：${p}`))

  // ── 收尾：守卫自身的「扫出数 > 0」断言 ─────────────────────────
  if (mentions === 0) {
    console.error('❌ 一条事实都没对账（mentions=0）——守卫自身失效，先怀疑本脚本再怀疑源文件')
    return 1
  }

  if (problems.length > 0) {
    for (const p of problems) console.error(`❌ ${p}`)
    return 1
  }
  console.log(`✅ doc-facts 对账一致：rust-version / node 大版本 / license 三处 / ADR 计数 / 通道状态 / script 覆盖 / 命令数（${mentions} 个对账点）`)
  return 0
}

const isDirectRun = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(argv[1] ?? '')
  } catch {
    return false
  }
})()

if (isDirectRun) {
  main().then((code) => exit(code ?? 0))
}
