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
 *
 * ## 可证伪性（自检夹具）
 *   · 以 2026-09-30 的真实漂移为夹具：文档写 1.85 / 产地 1.90 必须报红；
 *     ADR 宣称 36 / 实际 41 必须报红。
 *   · 以「宣称槽位消失」为夹具：喂入不含该宣称的文档必须报红——宣称被悄悄删掉
 *     同样是漂移（E5-空 的教训：扫出 0 时先怀疑被测对象，再怀疑扫描器）。
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

  // ── 收尾：守卫自身的「扫出数 > 0」断言 ─────────────────────────
  if (mentions === 0) {
    console.error('❌ 一条事实都没对账（mentions=0）——守卫自身失效，先怀疑本脚本再怀疑源文件')
    return 1
  }

  if (problems.length > 0) {
    for (const p of problems) console.error(`❌ ${p}`)
    return 1
  }
  console.log(`✅ doc-facts 对账一致：rust-version / node 大版本 / license 三处 / ADR 计数（${mentions} 个对账点）`)
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
