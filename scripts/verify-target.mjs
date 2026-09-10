#!/usr/bin/env node
/**
 * verify-target.mjs — 打包主机 / 目标平台一致性守卫。
 *
 * ## 为什么存在
 *
 * `scripts/prepare-harness.mjs` 会把**当前主机架构**的 Node 运行时二进制
 * 组装进 `src-tauri/resources/node/`（见 `tauri.conf.json` → `bundle.resources`）。
 * 因此「构建主机」与「目标平台」一旦不一致，产出的安装包会内嵌**错误架构的
 * Node**——这种包在目标机上表现为「Harness 起不来」，而根因在构建期，事后
 * 极难归因。本脚本把这类事故前移到构建前一刻失败。
 *
 * ## 目标平台的三个来源（按优先级）
 *
 * | 优先级 | 来源 | 场景 |
 * |--------|------|------|
 * | 1 | 命令行 `<platform> <arch>` | 显式钉住，例：`win32 x64` |
 * | 2 | 环境变量 `TAURI_ENV_TARGET_TRIPLE` | `tauri build` 期间由 Tauri 注入（**跨编译在此暴露**） |
 * | 3 | `rustc -vV` 的 host triple | 无 Tauri 环境时回退到 Rust 宿主三元组 |
 *
 * 三者都拿不到时以退出码 2 报错并要求显式传参——**不猜**。
 *
 * 注意：本脚本**不是**「校验当前平台」的同义反复。它比较的是「目标」与
 * 「实际运行 host」两个独立来源：
 *
 * * `tauri build --target aarch64-apple-darwin` 跑在 x64 mac 上 → 捕获；
 * * 构建容器里 x64 node + aarch64 rustc（或反之）→ 捕获；
 * * 钉死 target 而 runner 换架构（`macos-13` 换 `macos-14`）→ 捕获。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-target.mjs                # 自动推断（env / rustc host）
 * node scripts/verify-target.mjs win32 x64      # 显式钉住
 * node scripts/prepare-harness.mjs --target=win32/x64   # 组装前置校验
 * ```
 *
 * 退出码：`0` 一致 · `1` 不一致 · `2` 无法判定（缺参数 / 缺 rustc）。
 */

import { spawnSync } from 'node:child_process'
import { argv, env, exit, platform as hostPlatform, arch as hostArch } from 'node:process'
import { pathToFileURL } from 'node:url'

/**
 * Rust target triple 的三段式 → Node 的 `platform` / `arch` 命名。
 *
 * 只需覆盖本仓库实际可能出现的宿主：Windows / macOS / Linux × x64 / arm64。
 * 未知组合返回 `null`（调用方以「无法判定」处理，而不是猜一个）。
 */
const TRIPLE_TABLE = [
  { match: /^x86_64-pc-windows/, platform: 'win32', arch: 'x64' },
  { match: /^i686-pc-windows/, platform: 'win32', arch: 'ia32' },
  { match: /^aarch64-pc-windows/, platform: 'win32', arch: 'arm64' },
  { match: /^x86_64-apple-darwin/, platform: 'darwin', arch: 'x64' },
  { match: /^aarch64-apple-darwin/, platform: 'darwin', arch: 'arm64' },
  { match: /^x86_64-unknown-linux/, platform: 'linux', arch: 'x64' },
  { match: /^aarch64-unknown-linux/, platform: 'linux', arch: 'arm64' }
]

/**
 * 把 Rust target triple 转成 Node 平台 / 架构标识。
 *
 * @param {string} triple 形如 `x86_64-pc-windows-msvc` 的三元组
 * @returns {{platform: string, arch: string} | null} 无法识别时返回 `null`
 */
export function tripleToNodeTarget(triple) {
  if (!triple) return null
  const normalized = String(triple).trim()
  const hit = TRIPLE_TABLE.find((entry) => entry.match.test(normalized))
  return hit ? { platform: hit.platform, arch: hit.arch } : null
}

/**
 * 纯比较逻辑：目标与宿主是否一致。抽成纯函数便于单测。
 *
 * @param {{platform: string, arch: string}} expected 目标平台 / 架构
 * @param {{platform: string, arch: string}} actual 实际宿主平台 / 架构
 * @returns {{ok: boolean, message: string}} 判定结果与人类可读说明
 */
export function checkTarget(expected, actual = { platform: hostPlatform, arch: hostArch }) {
  if (expected.platform === actual.platform && expected.arch === actual.arch) {
    return {
      ok: true,
      message: `Packaging target verified: ${actual.platform}/${actual.arch}`
    }
  }
  return {
    ok: false,
    message:
      `This package must be built on ${expected.platform}/${expected.arch}; ` +
      `current runtime is ${actual.platform}/${actual.arch}.\n` +
      'Install dependencies and run the build on the matching machine or CI runner.'
  }
}

/**
 * 解析目标平台：显式参数 > `TAURI_ENV_TARGET_TRIPLE` > `rustc -vV` host。
 *
 * @param {string[]} args 命令行参数（前两位为 platform / arch）
 * @returns {{expected: {platform: string, arch: string} | null, source: string}} 目标与来源说明
 */
export function resolveExpectedTarget(args = []) {
  const [expectedPlatform, expectedArch] = args
  if (expectedPlatform && expectedArch) {
    return {
      expected: { platform: expectedPlatform, arch: expectedArch },
      source: 'argv'
    }
  }

  const fromEnv = tripleToNodeTarget(env.TAURI_ENV_TARGET_TRIPLE)
  if (fromEnv) {
    return { expected: fromEnv, source: `TAURI_ENV_TARGET_TRIPLE=${env.TAURI_ENV_TARGET_TRIPLE}` }
  }

  const host = rustHostTriple()
  const fromRustc = tripleToNodeTarget(host)
  if (fromRustc) {
    return { expected: fromRustc, source: `rustc host ${host}` }
  }

  return { expected: null, source: '' }
}

/**
 * 读取当前 Rust 工具链的 host triple（`rustc -vV` 的 `host:` 行）。
 *
 * @returns {string} 三元组；rustc 不可用时返回空串
 */
function rustHostTriple() {
  const result = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })
  if (result.error || result.status !== 0 || !result.stdout) return ''
  const line = result.stdout.split('\n').find((row) => row.startsWith('host:'))
  return line ? line.slice('host:'.length).trim() : ''
}

const USAGE =
  'Usage: node scripts/verify-target.mjs [<platform> <arch>]\n' +
  '  例：node scripts/verify-target.mjs win32 x64\n' +
  '  省略参数时依次尝试 TAURI_ENV_TARGET_TRIPLE、rustc -vV 的 host triple。'

/**
 * 自检：覆盖三元组映射与比较逻辑的纯函数分支。
 *
 * 与 `patch-layers.mjs --self-test` 同一约定（CI 里先跑自检再跑真检查），
 * 避免「守卫脚本自己写错了却静默放行」。
 *
 * @returns {void}
 */
function selfTest() {
  const cases = [
    ['x86_64-pc-windows-msvc', { platform: 'win32', arch: 'x64' }],
    ['x86_64-pc-windows-gnu', { platform: 'win32', arch: 'x64' }],
    ['aarch64-pc-windows-msvc', { platform: 'win32', arch: 'arm64' }],
    ['x86_64-apple-darwin', { platform: 'darwin', arch: 'x64' }],
    ['aarch64-apple-darwin', { platform: 'darwin', arch: 'arm64' }],
    ['x86_64-unknown-linux-gnu', { platform: 'linux', arch: 'x64' }],
    ['aarch64-unknown-linux-musl', { platform: 'linux', arch: 'arm64' }]
  ]

  let failed = 0
  const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) {
      failed += 1
      console.error(`FAIL ${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
    } else {
      console.log(`PASS ${label}`)
    }
  }

  for (const [triple, expected] of cases) {
    check(`tripleToNodeTarget(${triple})`, tripleToNodeTarget(triple), expected)
  }
  // 未收录的三元组必须返回 null，而不是猜一个平台。
  check('tripleToNodeTarget(unknown)', tripleToNodeTarget('mips-unknown-linux-gnu'), null)
  check('tripleToNodeTarget(empty)', tripleToNodeTarget(''), null)

  check(
    'checkTarget(same)',
    checkTarget({ platform: 'win32', arch: 'x64' }, { platform: 'win32', arch: 'x64' }).ok,
    true
  )
  check(
    'checkTarget(arch mismatch)',
    checkTarget({ platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' }).ok,
    false
  )
  check(
    'checkTarget(platform mismatch)',
    checkTarget({ platform: 'linux', arch: 'x64' }, { platform: 'win32', arch: 'x64' }).ok,
    false
  )

  if (failed > 0) {
    console.error(`verify-target self-test: ${failed} 项失败`)
    exit(1)
  }
  console.log(`verify-target self-test: ${cases.length + 5} 项全部通过`)
}

/** CLI 入口（被 import 时不执行）。 */
function main() {
  if (argv.includes('--self-test')) {
    selfTest()
    return
  }

  const positional = argv.slice(2).filter((arg) => !arg.startsWith('-'))
  const { expected, source } = resolveExpectedTarget(positional)

  if (!expected) {
    console.error('Cannot determine the packaging target.')
    console.error(USAGE)
    console.error('可用来源均不可用：未传参、TAURI_ENV_TARGET_TRIPLE 未设置、rustc 不可用或三元组未收录。')
    exit(2)
  }

  const { ok, message } = checkTarget(expected)
  if (ok) {
    console.log(message)
    console.log(`target source: ${source}`)
    return
  }
  console.error(message)
  console.error(`target source: ${source}`)
  exit(1)
}

// ESM「主模块」判定：仅当被直接执行（而非 import）时跑 CLI。
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main()
}
