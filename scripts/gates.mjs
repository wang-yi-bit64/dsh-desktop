#!/usr/bin/env node
/**
 * gates.mjs — 门禁编排器（2026-10-03 治理 G1；取代 verify-fast.mjs）。
 *
 * ## 为什么不再手抄清单
 *
 * 改版前，门禁清单被**手抄三份**：verify-fast.mjs 的 QUICK_STATIC、ci.yml 的逐行
 * npm run、release.yml preflight 的逐行 npm run。三份互相漂移且漂移不报错，于是
 * 出现了「守卫写了、文档说它在盯、但没有任何流程会跑它」——verify:unwrap-hygiene
 * 与 verify:doc-facts 就是这种形态（详见 scripts/gate-manifest.mjs 的头注释）。
 *
 * 现在清单只有一份：scripts/gate-manifest.mjs。本脚本只做编排，不实现判据。
 *
 * ## 用法
 *
 *   npm run gate -- --tier=fast        # 本地快档（离线、秒级；末尾跑 cargo test --tests）
 *   npm run verify:fast                # 同上（package.json 的便捷入口）
 *   npm run gate -- --tier=full        # fast 的档位 + doc-test
 *   npm run gate -- --tier=ci          # ci.yml 三平台静态门禁档
 *   npm run gate -- --tier=release     # 发布 preflight 档
 *   npm run gate -- --tier=sentinel    # 联网哨兵（drift / update-channel）
 *   npm run gate -- claims             # 单个门禁（真检查）
 *   npm run gate -- claims --self-test # 单个门禁的自检
 *   npm run gate -- --list             # 列出全部门禁与分档
 *   npm run gate -- verify:claims:self-test   # 旧名仍然可解析（兼容层）
 *
 * 退出码：0 全绿 · 1 有失败 · 2 用法错误。
 *
 * ## 编排纪律
 *
 *   · **扫出数必须 > 0**（§7.3 / E5-空）：某个档位解析出 0 步即报错退出，不打印绿色。
 *   · **跳过的项必须打印**（§7.1 规则 3）：平台不匹配的步骤打印 skip 与理由，
 *     不得静默略过。
 *   · 逐项打印 ✅/❌ 与耗时；失败只取尾部几行（编排器的职责是告诉你哪一步红了，
 *     不是复述它的完整输出）。
 *   · 直接 spawn node（不经 npm run）：省掉每步 ~0.5s 的 npm 启动开销，
 *     30+ 步的档位因此快十几秒。
 */

import { spawnSync } from 'node:child_process'
import { argv, exit, platform } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  TIERS,
  describeGates,
  gateByName,
  normalizeGateName,
  resolveTier
} from './gate-manifest.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * fast / full 档在门禁之后追加的 cargo 步骤。
 *
 * 为什么 cargo **不**进总表：它的分档与平台条件由 ci.yml 自己持有（三平台矩阵、
 * schedule-only 的 doc-test、windows/linux 差异），而本仓的门禁总表只登记
 * 仓库内 *.mjs 判定脚本。把它塞进来会造出第二个 cargo 编排者。
 */
const CARGO_STEPS = {
  fast: {
    label: 'cargo test --tests（无 doc-test，快档）',
    args: ['test', '--tests', '-p', 'dsh-contracts', '-p', 'dsh-host', '-p', 'dsh-host-cli']
  },
  full: {
    label: 'cargo test（含 doc-test，full 档）',
    args: ['test', '-p', 'dsh-contracts', '-p', 'dsh-host', '-p', 'dsh-host-cli']
  }
}

function usage() {
  console.log(
    [
      '用法：node scripts/gates.mjs [--tier=<' + TIERS.join('|') + '>] [--only=<name,...>] [<name>...] [--self-test] [--list] [--dry-run] [--no-cargo]',
      '',
      '档位：fast（本地快档）· full（fast + doc-test）· ci · release · sentinel（联网）',
      '门禁名：见 npm run gate -- --list（旧名 verify:<name> / <name>:self-test 同样可解析）'
    ].join('\n')
  )
}

function parseArgs(raw) {
  const opts = { tier: null, only: [], names: [], selfTest: false, list: false, dryRun: false, json: false, noCargo: false, help: false }
  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i]
    if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--list') opts.list = true
    else if (arg === '--json') opts.json = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--self-test') opts.selfTest = true
    else if (arg === '--no-cargo') opts.noCargo = true
    else if (arg.startsWith('--tier=')) opts.tier = arg.slice('--tier='.length)
    else if (arg === '--tier') { i += 1; opts.tier = raw[i] ?? '' }
    else if (arg.startsWith('--only=')) opts.only.push(...arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean))
    else if (arg.startsWith('--')) { console.error('❌ 未知参数：' + arg); usage(); exit(2) }
    else opts.names.push(arg)
  }
  return opts
}

/** 把 `npm run gate -- <名字>` 的每个名字解析成待执行步骤。 */
function stepsFromNames(names, forceSelfTest) {
  const steps = []
  const errors = []
  for (const raw of names) {
    const resolved = normalizeGateName(raw, forceSelfTest)
    if (resolved.error) { errors.push(resolved.error); continue }
    const gate = gateByName(resolved.name)
    const wantsSelfTest = resolved.selfTest
    // 「只有自检模式」的门禁（如 prune / cli-package）：指名它就跑它的自检——
    // 那**就是**这条门禁的全部内容，报「没有实检查」只会让调用方多记一条规则。
    if (!wantsSelfTest && gate.real === null && gate.selfTest !== null) {
      steps.push({ gate, mode: 'self-test', args: gate.selfTest.args ?? [], label: gate.name + '（该门禁只有自检模式）', selfTestOnly: true })
      continue
    }
    const spec = wantsSelfTest ? gate.selfTest : gate.real
    if (spec === null || spec === undefined) {
      errors.push(
        wantsSelfTest
          ? '门禁 ' + gate.name + ' 没有自检模式（--self-test）'
          : '门禁 ' + gate.name + ' 没有真检查模式；它的判定内容就是自检，加 --self-test 或直接指名即可'
      )
      continue
    }
    steps.push({ gate, mode: wantsSelfTest ? 'self-test' : 'real', args: spec.args ?? [], label: wantsSelfTest ? gate.name + ':self-test' : gate.name })
  }
  return { steps, errors }
}

function runStep(step) {
  const scriptPath = join(projectRoot, step.gate.script)
  const t0 = Date.now()
  // ⚠️ `stdio` 必须显式给，**不是**风格偏好（2026-10-08 实测）：
  //   默认的 `['pipe','pipe','pipe']` 下，Windows 本机 spawn 任何子进程都直接
  //   以 `EBUSY` 失败（`result.status === null`）——连 `process.execPath` 自己都同理，
  //   于是整档 43 步全红、看起来像「门禁全挂了」，实际一行都没跑。
  //   触发条件是 **`stdin` 是管道**，与执行什么命令无关。实测（两个命令 × 三种 stdio，
  //   双向对照）：`default` → EBUSY；`['ignore','pipe','pipe']` → status 0；
  //   `['pipe','pipe','pipe']` → EBUSY；`git --version` 亦然。
  //   这些被编排的脚本都不读 stdin，因此 `ignore` 与 `pipe` **语义等价**。
  //   同一条缺口此前已在 `conventional-commits.mjs` / `changelog.mjs` / `version.mjs`
  //   各修一处（2026-09-25）；本文件是 2026-10-03 新增的编排器，当时没被那条纪律覆盖。
  const result = spawnSync(process.execPath, [scriptPath, ...step.args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const seconds = ((Date.now() - t0) / 1000).toFixed(1)
  const ok = result.status === 0
  console.log((ok ? '✅ ' : '❌ ') + step.label + '（' + seconds + 's）')
  if (!ok) {
    const text = (result.stdout ?? '') + (result.stderr ?? '')
    const tail = text.trim().split(/\r?\n/).slice(-6).join('\n  ')
    if (tail.length > 0) console.error('  ' + tail)
    if (result.error) console.error('  ' + String(result.error.message ?? result.error))
  }
  return ok
}

function main() {
  const opts = parseArgs(argv.slice(2))

  if (opts.help) { usage(); exit(0) }

  if (opts.list) {
    const rows = describeGates()
    if (opts.json) { console.log(JSON.stringify(rows, null, 2)); exit(0) }
    const width = Math.max(...rows.map((r) => r.name.length))
    console.log('门禁总表（scripts/gate-manifest.mjs，' + rows.length + ' 条）')
    for (const row of rows) {
      const real = row.real.length > 0 ? row.real.join(',') : '—'
      const st = row.selfTest.length > 0 ? row.selfTest.join(',') : '—'
      const manualOnly = (row.real.length === 0 && row.selfTest.length === 0) || row.manual !== null
      const extra = [row.platforms ? '仅 ' + row.platforms.join('/') : '', row.needsAssembly ? '需组装树' : '', manualOnly ? '需人工点名（见总表 manual 理由）' : ''].filter(Boolean).join(' · ')
      console.log('  ' + row.name.padEnd(width) + '  real:' + real.padEnd(24) + ' self-test:' + st.padEnd(24) + (extra ? ' [' + extra + ']' : ''))
    }
    exit(0)
  }

  let steps = []
  let tierLabel = null

  if (opts.tier) {
    if (!TIERS.includes(opts.tier) && opts.tier !== 'full') {
      console.error('❌ 未知档位：' + opts.tier + '（合法值：' + [...TIERS, 'full'].join(' / ') + '）')
      exit(2)
    }
    const tier = opts.tier === 'full' ? 'fast' : opts.tier
    steps = resolveTier(tier)
    tierLabel = opts.tier
  }

  if (opts.only.length > 0 || opts.names.length > 0) {
    const named = stepsFromNames([...opts.only, ...opts.names], opts.selfTest)
    for (const error of named.errors) console.error('❌ ' + error)
    if (named.errors.length > 0) exit(2)
    steps = named.steps
    tierLabel = tierLabel ?? 'only'
  }

  if (opts.tier === null && opts.only.length === 0 && opts.names.length === 0) {
    console.error('❌ 必须给一个档位（--tier）或至少一个门禁名')
    usage()
    exit(2)
  }

  // E5-空：解析出 0 步时必须报错——「一个都没扫到」不得打印绿色（§7.3 纪律）。
  if (steps.length === 0) {
    console.error('❌ 解析出 0 步：清单形态或分档名可能变了，先怀疑编排器，再怀疑清单')
    exit(1)
  }

  const skipped = []
  const runnable = []
  for (const step of steps) {
    const platforms = step.gate.platforms
    if (Array.isArray(platforms) && !platforms.includes(platform)) {
      skipped.push({ step, reason: '平台限制：仅 ' + platforms.join('/') + '（当前 ' + platform + '）' })
      continue
    }
    runnable.push(step)
  }

  const cargo = !opts.noCargo && (opts.tier === 'fast' || opts.tier === 'full') ? CARGO_STEPS[opts.tier] : null

  if (opts.dryRun) {
    for (const step of runnable) console.log('  将执行：' + step.label + ' → node ' + step.gate.script + ' ' + step.args.join(' '))
    for (const s of skipped) console.log('  将跳过：' + s.step.label + '（' + s.reason + '）')
    if (cargo) console.log('  将执行：' + cargo.label + ' → cargo ' + cargo.args.join(' '))
    exit(0)
  }

  const total = runnable.length + (cargo ? 1 : 0)
  console.log('gate:' + (tierLabel ?? 'only') + ' — 共 ' + total + ' 步' + (skipped.length > 0 ? '（另跳过 ' + skipped.length + ' 步，理由逐条打印）' : ''))
  const t0 = Date.now()
  let failed = 0
  for (const step of runnable) {
    if (!runStep(step)) failed += 1
  }
  for (const s of skipped) {
    console.log('⏭️  ' + s.step.label + '（' + s.reason + '）')
  }
  if (cargo) {
    const t = Date.now()
    const r = spawnSync('cargo', cargo.args, {
      cwd: projectRoot,
      encoding: 'utf8',
      env: process.env,
      shell: platform === 'win32',
      // 同 runStep 的理由：默认 `stdio` 在本机直接 EBUSY，cargo 步骤会「红得莫名其妙」。
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const seconds = ((Date.now() - t) / 1000).toFixed(1)
    const ok = r.status === 0
    console.log((ok ? '✅ ' : '❌ ') + cargo.label + '（' + seconds + 's）')
    if (!ok) {
      failed += 1
      const tail = ((r.stdout ?? '') + (r.stderr ?? '')).trim().split(/\r?\n/).slice(-6).join('\n  ')
      if (tail.length > 0) console.error('  ' + tail)
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  if (failed === 0) {
    console.log('✅ gate:' + (tierLabel ?? 'only') + ' 全绿（' + total + ' 步，' + elapsed + 's）')
    exit(0)
  }
  console.error('❌ gate:' + (tierLabel ?? 'only') + '：' + failed + ' 步失败（' + elapsed + 's）')
  exit(1)
}

main()
