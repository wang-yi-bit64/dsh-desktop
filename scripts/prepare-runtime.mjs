#!/usr/bin/env node
/**
 * prepare-runtime.mjs — 内置运行时的一站式准备（默认**带** primary runtime 载荷）。
 *
 * # 为什么需要这一层
 *
 * `npm run dev` / `npm run build` 以前只调 `prepare:harness`（Harness 依赖树）。
 * primary runtime 载荷（office skills / workspace-dependencies 的门控）是另一条链：
 *
 *   fetch-primary-runtime.mjs   拉输入：CPython 解释器 + office-skills + pnpm
 *   prepare-primary-runtime.mjs 组装 + 完整性判定 → src-tauri/resources/runtime/
 *
 * 本脚本把两步串起来，让"构建产物里到底有没有 office skills"变成**默认值**而不是
 * 构建者记不记得手动跑。默认带上，理由：载荷不进安装包时，office skills 那两行在
 * Harness 里保持 disabled——用户拿到的是一个静默少功能的版本，而没有任何地方
 * 提示过他（§7.1 规则 3：降级必须写进产物，不能靠使用者猜）。
 *
 * # 开关
 *
 * `DSH_SKIP_PRIMARY_RUNTIME=1` 跳过整套载荷准备（离线构建 / 只想快速起壳时用）。
 * 跳过时 `prepare-harness` 依旧会写 `.payload-root` 标记，因此 Tauri 的资源 glob
 * 依然成立、编译不会红——只是最终产物里没有 office skills。
 *
 * 2026-10-07 起只有一种载荷形态（解释器 + skills + node + pnpm）；曾经可选追加
 * 8 个 python 库的 `DSH_PRIMARY_RUNTIME_TIER=full` 已拆除，理由见 fetch 脚本头注。
 *
 * # 用法
 *
 * ```bash
 * npm run prepare:runtime                  # 默认：拉输入 + 组装 + 自检
 * DSH_SKIP_PRIMARY_RUNTIME=1 npm run dev   # 不带载荷
 * ```
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const projectRoot = process.cwd()

function log(line) { console.log(`[prepare-runtime] ${line}`) }

function run(script, args) {
  log(`node scripts/${script} ${args.join(' ')}`)
  execFileSync(process.execPath, [join('scripts', script), ...args], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  })
}

/** 目标三元组（与 fetch-primary-runtime.mjs 的 TARGETS 同一套命名）。 */
function hostTarget() {
  const table = {
    'win32/x64': 'win32-x64',
    'darwin/arm64': 'darwin-arm64',
    'darwin/x64': 'darwin-x64',
    'linux/x64': 'linux-x64',
    'linux/arm64': 'linux-arm64',
  }
  return table[`${process.platform}/${process.arch}`] ?? null
}

if (process.env.DSH_SKIP_PRIMARY_RUNTIME === '1') {
  log('DSH_SKIP_PRIMARY_RUNTIME=1：跳过 primary runtime 载荷（office skills 将保持禁用）')
  process.exit(0)
}

// 1) 先准备 Harness 依赖树（载荷判定依赖它写出的 .payload-root 标记与 resources 布局）。
run('prepare-harness.mjs', process.argv.slice(2))

// 2) 拉取载荷输入（幂等：缓存命中就不下载）。
const target = hostTarget()
if (target === null) {
  console.error(`[prepare-runtime] 宿主 ${process.platform}/${process.arch} 没有对应目标三元组，无法拉取载荷`)
  process.exit(1)
}
const outDir = join('.desktop-build', 'primary-runtime', target)
run('fetch-primary-runtime.mjs', ['--target', target, '--out', outDir])

// 3) 组装进 resources 并做完整性判定（缺任一项 → 整体不落盘）。
const version = JSON.parse(
  (await import('node:fs')).readFileSync('package.json', 'utf8'),
).version
const nodeVersion = (await import('node:fs'))
  .readFileSync('.nvmrc', 'utf8')
  .trim()
  .replace(/^v/, '')
run('prepare-primary-runtime.mjs', [
  '--source', outDir,
  '--office-skills', join(outDir, 'office-skills'),
  '--node-source', join('src-tauri', 'resources', 'node'),
  '--desktop-version', version,
  '--python-version', '3.10.22',
  '--node-version', nodeVersion,
  '--pnpm-version', '11.7.0',
])

// 4) 落盘后自检：确认真写进去了（而不是某一步静默没做）。红=构建失败——
//    静默少功能的包是最坏结果（§7.1 规则 3）。
const check = execFileSync(process.execPath, [
  join('scripts', 'prepare-primary-runtime.mjs'), '--check',
], { cwd: projectRoot, encoding: 'utf8' })
if (!check.includes('载荷达标')) {
  console.error(`[prepare-runtime] 载荷未达标：\n${check}`)
  process.exit(1)
}
log('primary runtime 载荷就绪')
