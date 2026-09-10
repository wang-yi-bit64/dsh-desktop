#!/usr/bin/env node
/**
 * report-bundle-size.mjs — 产物体积采集（B3）。
 *
 * 解决的问题：README 里的体积数字会随时间失真，且「一个 MB 数」无法回答
 * 「该优化哪里」。本脚本把体积拆成三个**互不可比**的口径，并给出资源树的
 * 子目录构成——因为资源树才是体积主项（内置 Node 运行时 + 完整 Harness 依赖
 * 树），而壳二进制与 Tauri 配置对总量的影响在个位数 MB 量级。
 *
 * 三个口径：
 *   1. 壳二进制   target/release/<binary>            未打包，反映 Rust 侧
 *   2. 安装包     target/release/bundle/**            终端用户实际下载/安装的
 *   3. 资源树     src-tauri/resources/                未压缩；体积主项，附子目录构成
 *
 * 用法：
 *   node scripts/report-bundle-size.mjs                # 终端表格
 *   node scripts/report-bundle-size.mjs --markdown     # Markdown（或写入 $GITHUB_STEP_SUMMARY）
 *   node scripts/report-bundle-size.mjs --json         # 机器可读
 *   node scripts/report-bundle-size.mjs --baseline=.workbuddy/size-baseline.json
 *
 * 退出码：0 采集完成（含部分产物缺失）；1 参数错误。
 * 注意：本脚本**不失败于产物缺失**——PR 分支不构建产物，缺失是预期状态。
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const argv = process.argv.slice(2)

const binaryName = isWindows ? 'dsh-desktop.exe' : 'dsh-desktop'
const releaseDir = join(projectRoot, 'src-tauri', 'target', 'release')
const bundleDir = join(releaseDir, 'bundle')
const resourcesDir = join(projectRoot, 'src-tauri', 'resources')

/**
 * 读取 `--name=value` 形式的参数。
 * @param {string} name 参数名
 * @param {string} fallback 缺省值
 * @returns {string} 参数值
 */
function argValue(name, fallback) {
  const match = argv.find((item) => item.startsWith(`--${name}=`))
  return match ? match.slice(name.length + 3) : fallback
}

/**
 * 格式化字节数为人类可读字符串。
 * @param {number} bytes 字节数
 * @returns {string} 形如 `312.4 MB`
 */
function human(bytes) {
  if (bytes === null || bytes === undefined) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/**
 * 计算文件或目录的递归总字节数。
 * @param {string} target 路径
 * @returns {number|null} 字节数；路径不存在时返回 `null`
 */
function sizeOf(target) {
  if (!existsSync(target)) return null
  let stat
  try {
    stat = statSync(target)
  } catch {
    return null
  }
  if (stat.isFile()) return stat.size
  if (!stat.isDirectory()) return null
  let total = 0
  const stack = [target]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      // 符号链接（junction / symlink）不跟随：Harness 依赖树里 pnpm 风格的
      // 链接会让同一份内容被重复计入，体积数字会虚高且不可复现。
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          total += statSync(full).size
        } catch {
          // 单个文件读取失败不影响整体统计
        }
      }
    }
  }
  return total
}

/**
 * 列出目录直接子项的体积构成（按体积降序）。
 * @param {string} dir 目录
 * @returns {{name: string, bytes: number}[]} 子项及其体积
 */
function childrenSizes(dir) {
  if (!existsSync(dir)) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .map((entry) => ({
      name: entry.isDirectory() ? `${entry.name}/` : entry.name,
      bytes: entry.isSymbolicLink() ? 0 : (sizeOf(join(dir, entry.name)) ?? 0)
    }))
    .filter((item) => !(item.name === 'node/' && item.bytes === 0))
    .sort((a, b) => b.bytes - a.bytes)
}

/**
 * 收集安装包产物（NSIS / dmg / deb / AppImage / msi / rpm）。
 * @returns {{name: string, path: string, bytes: number}[]} 安装包列表
 */
function installers() {
  if (!existsSync(bundleDir)) return []
  const found = []
  const stack = [bundleDir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      if (/\.(exe|msi|dmg|deb|rpm|AppImage)$/i.test(entry.name)) {
        const bytes = sizeOf(full) ?? 0
        found.push({ name: entry.name, path: full, bytes })
      }
    }
  }
  return found.sort((a, b) => b.bytes - a.bytes)
}

/**
 * 读取组装清单中的关键信息（版本 / 补丁应用数），用于体积报告的可追溯性。
 * @returns {{dsh?: string, node?: string, applied: number, total: number}|null} 清单摘要
 */
function manifestSummary() {
  const manifestPath = join(resourcesDir, 'MANIFEST.json')
  if (!existsSync(manifestPath)) return null
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const patches = Array.isArray(manifest.patches) ? manifest.patches : []
    return {
      dsh: manifest.versions?.dsh,
      node: manifest.versions?.node,
      applied: patches.filter((item) => item.status === 'applied').length,
      total: patches.length
    }
  } catch {
    return null
  }
}

/**
 * 采集全部体积数据。
 * @returns {object} 体积报告对象
 */
function collect() {
  const shellBinary = join(releaseDir, binaryName)
  const resourceTotal = sizeOf(resourcesDir)
  const harnessDir = join(resourcesDir, 'harness')
  const nodeDir = join(resourcesDir, 'node')

  return {
    platform: process.platform,
    generatedAt: new Date().toISOString(),
    shell: {
      path: existsSync(shellBinary) ? shellBinary : null,
      bytes: sizeOf(shellBinary)
    },
    installers: installers(),
    resources: {
      path: existsSync(resourcesDir) ? resourcesDir : null,
      bytes: resourceTotal,
      children: childrenSizes(resourcesDir),
      harnessBytes: sizeOf(harnessDir),
      nodeBytes: sizeOf(nodeDir),
      harnessPackages: existsSync(join(harnessDir, 'node_modules'))
        ? (() => {
            try {
              return readdirSync(join(harnessDir, 'node_modules')).length
            } catch {
              return null
            }
          })()
        : null
    },
    manifest: manifestSummary()
  }
}

/**
 * 渲染终端表格。
 * @param {object} report 体积报告
 * @returns {string} 文本
 */
function renderText(report) {
  const lines = []
  lines.push(`体积报告（${report.platform}，${report.generatedAt}）`)
  const manifest = report.manifest
  if (manifest) {
    lines.push(
      `组装清单：dsh=${manifest.dsh ?? '?'} node=${manifest.node ?? '?'} ` +
        `patches=${manifest.applied}/${manifest.total}`
    )
  }
  lines.push('')
  lines.push('口径一 · 壳二进制（未打包，反映 Rust 侧）')
  lines.push(`  ${human(report.shell.bytes)}`)
  lines.push('')
  lines.push('口径二 · 安装包（终端用户实际下载的）')
  if (report.installers.length === 0) {
    lines.push('  （无安装包产物；PR 分支不构建，属预期）')
  } else {
    for (const item of report.installers) {
      lines.push(`  ${human(item.bytes).padStart(10)}  ${item.name}`)
    }
  }
  lines.push('')
  lines.push('口径三 · 资源树（未压缩，体积主项）')
  lines.push(`  合计 ${human(report.resources.bytes)}`)
  if (report.resources.nodeBytes !== null) {
    lines.push(`    其中 node/    ${human(report.resources.nodeBytes)}`)
  }
  if (report.resources.harnessBytes !== null) {
    lines.push(
      `    其中 harness/ ${human(report.resources.harnessBytes)}` +
        (report.resources.harnessPackages !== null
          ? `（${report.resources.harnessPackages} 个顶层包）`
          : '')
    )
  }
  if (report.resources.children.length > 0) {
    lines.push('  子项构成（Top 10）：')
    for (const child of report.resources.children.slice(0, 10)) {
      lines.push(`    ${human(child.bytes).padStart(10)}  ${child.name}`)
    }
  }
  return lines.join('\n')
}

/**
 * 渲染 Markdown（供 `$GITHUB_STEP_SUMMARY` 使用）。
 * @param {object} report 体积报告
 * @returns {string} Markdown 文本
 */
function renderMarkdown(report) {
  const lines = []
  lines.push('### 产物体积')
  lines.push('')
  const manifest = report.manifest
  if (manifest) {
    lines.push(
      `组装清单：\`dsh=${manifest.dsh ?? '?'}\` · \`node=${manifest.node ?? '?'}\` · ` +
        `补丁 \`${manifest.applied}/${manifest.total}\``
    )
    lines.push('')
  }
  lines.push('| 口径 | 体积 | 说明 |')
  lines.push('|------|------|------|')
  lines.push(`| 壳二进制 | ${human(report.shell.bytes)} | 未打包，反映 Rust 侧 |`)
  if (report.installers.length === 0) {
    lines.push('| 安装包 | — | 无产物（PR 分支不构建） |')
  } else {
    for (const item of report.installers) {
      lines.push(`| 安装包 \`${item.name}\` | ${human(item.bytes)} | 终端用户实际下载的 |`)
    }
  }
  lines.push(
    `| 资源树 | ${human(report.resources.bytes)} | 未压缩，**体积主项**（内置 Node + Harness 依赖树） |`
  )
  if (report.resources.children.length > 0) {
    lines.push('')
    lines.push('<details><summary>资源树子项构成</summary>')
    lines.push('')
    lines.push('| 子项 | 体积 |')
    lines.push('|------|------|')
    for (const child of report.resources.children.slice(0, 15)) {
      lines.push(`| \`${child.name}\` | ${human(child.bytes)} |`)
    }
    lines.push('')
    lines.push('</details>')
  }
  return lines.join('\n')
}

/**
 * 与基线对比，输出体积漂移。
 * @param {object} report 当前报告
 * @param {string} baselinePath 基线 JSON 路径
 * @returns {string} 对比文本
 */
function renderDiff(report, baselinePath) {
  if (!existsSync(baselinePath)) {
    return `基线文件不存在（${baselinePath}），跳过对比。首次运行可用 --write-baseline 生成。`
  }
  try {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
    const pairs = [
      ['壳二进制', baseline.shell?.bytes, report.shell.bytes],
      ['资源树', baseline.resources?.bytes, report.resources.bytes],
      ['安装包', baseline.installers?.[0]?.bytes, report.installers[0]?.bytes]
    ]
    const lines = ['与基线的体积漂移：']
    for (const [label, before, after] of pairs) {
      if (before == null || after == null) {
        lines.push(`  ${label}：— （一侧缺失）`)
        continue
      }
      const delta = after - before
      const percent = before === 0 ? '—' : `${((delta / before) * 100).toFixed(1)}%`
      const sign = delta >= 0 ? '+' : ''
      lines.push(`  ${label}：${sign}${human(Math.abs(delta))}（${sign}${percent}）`)
    }
    return lines.join('\n')
  } catch (error) {
    return `基线解析失败：${error?.message ?? error}`
  }
}

function main() {
  const report = collect()

  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else if (argv.includes('--markdown')) {
    const markdown = [
      renderMarkdown(report),
      '',
      '```',
      renderDiff(report, resolve(projectRoot, argValue('baseline', '.workbuddy/size-baseline.json'))),
      '```'
    ].join('\n')
    const summaryPath = process.env.GITHUB_STEP_SUMMARY
    if (summaryPath) {
      // CI 里追加到 job summary，同时仍打印到日志，本地调试与 CI 行为一致。
      writeFileSync(summaryPath, `${markdown}\n`, { flag: 'a' })
      console.log(markdown)
    } else {
      console.log(markdown)
    }
  } else {
    console.log(renderText(report))
    console.log('')
    console.log(renderDiff(report, resolve(projectRoot, argValue('baseline', '.workbuddy/size-baseline.json'))))
  }

  if (argv.includes('--write-baseline')) {
    const target = resolve(projectRoot, argValue('baseline', '.workbuddy/size-baseline.json'))
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`\n已写入基线：${target}`)
  }
}

main()
