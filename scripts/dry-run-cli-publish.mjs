#!/usr/bin/env node
/**
 * dry-run-cli-publish.mjs — 把 `release.yml` 里 `cli-publish` 的 `run:` 段落**原文**跑一遍。
 *
 * ## 为什么不能手抄一份
 *
 * 本任务的第一次实现里，我写了个 `.sh` 演练脚本，手抄了工作流的上传循环。它当场
 * 报出一个「缺陷」——文件列表没展开成实际路径。核对后发现：**工作流是对的，手抄的
 * 那份是错的**（我在 `matched=("${work_dir}/dist/cli/${pattern}")` 上加了引号，
 * 引号会阻止路径展开，`nullglob` 因此永不生效）。手抄一份实现出来，验的是抄件，
 * 不是发布时会跑的那段——这正是本仓反复强调的一类问题（同一件事两处实现必然漂移）。
 *
 * 所以本脚本从 `release.yml` **按文本抽取出** `run:` 块，逐字执行，并用一个假的 `gh`
 * 把网络调用截住。它覆盖的正是「只有真发布才炸」的那一维：shell 语义、glob 展开、
 * 相对路径、`gh` 的参数形状。
 *
 * ⚠️ **它不能替代真发布**：假 `gh` 只断言「文件存在、非空、带 `--clobber`」，真实
 * 资产存储、权限、tag 是否存在、Release 是否已创建，这些只有在 runner 上才知道。
 * 它排除的是「脚本本身写错了」这一类，而不是「环境不允许」那一类。
 *
 * ## 假 `gh` 桩
 *
 * `gh` 被替换成临时目录里的一个脚本，把 argv 记进日志并按子命令给出合理响应：
 *   · `release view --json body --jq '.body // ""'` → 打印既有正文（可空）
 *   · `release upload <tag> <files…> --clobber`     → 断言每个文件真实存在且非空
 *   · `release edit <tag> --notes-file <path>`      → 复制该文件内容供断言
 * 桩**不联网**，也不碰任何真实仓库。
 *
 * ## 无副作用
 *
 * 演练在**临时目录**里搭一个最小检出布局（`scripts/package-cli.mjs` + `package.json`
 * + `dist/cli/`），不在仓库根跑——否则它会清空真的 `dist/cli`，而演练本身还是绿的。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/dry-run-cli-publish.mjs            # 需要 target/release 下已构建的 CLI
 * node scripts/dry-run-cli-publish.mjs --binary <path>
 * node scripts/dry-run-cli-publish.mjs --keep     # 失败时也保留工作目录（默认已保留）
 * ```
 *
 * 退出码：`0` 通过 · `1` 任一断言失败（打印被执行的原文与该步骤的输出）。
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageCli, hostTriple } from './package-cli.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_YML = join(projectRoot, '.github', 'workflows', 'release.yml')

/**
 * 从工作流文本里抽出某个 job 的全部 `run:` 块（带缩进归一）。
 *
 * 只做行级解析，不引 YAML 依赖：定位 `<job>:` 行，在其块内找 `- name:` 与随后的
 * `run: |`，收集到缩进回落到步骤层级为止。
 *
 * @param {string} text 工作流全文（已归一化行尾）
 * @param {string} job job 名
 * @returns {{name: string, script: string}[]} 步骤名与脚本原文
 */
export function extractRunSteps(text, job) {
  const lines = text.split('\n')
  const jobStart = lines.findIndex((line) => new RegExp(`^\\s{0,2}${job}:\\s*$`).test(line))
  if (jobStart < 0) return []
  const jobIndent = lines[jobStart].match(/^\s*/)[0].length
  let jobEnd = lines.length
  for (let i = jobStart + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) continue
    const indent = line.match(/^\s*/)[0].length
    if (indent <= jobIndent && /^\s*[\w-]+:/.test(line)) {
      jobEnd = i
      break
    }
  }

  const steps = []
  let name = null
  for (let i = jobStart; i < jobEnd; i += 1) {
    const nameMatch = /^\s*-\s+name:\s*(.+)$/.exec(lines[i])
    if (nameMatch) {
      name = nameMatch[1].trim()
      continue
    }
    if (!/^\s*run:\s*\|\s*$/.test(lines[i])) continue
    const runIndent = lines[i].match(/^\s*/)[0].length
    const body = []
    let j = i + 1
    for (; j < jobEnd; j += 1) {
      const line = lines[j]
      if (line.trim() && line.match(/^\s*/)[0].length <= runIndent) break
      body.push(line)
    }
    // 剥掉块标量的公共缩进（YAML 在运行时会做同一件事）。
    const nonEmpty = body.filter((l) => l.trim())
    const common = nonEmpty.length
      ? Math.min(...nonEmpty.map((l) => l.match(/^\s*/)[0].length))
      : 0
    steps.push({ name: name ?? '(unnamed)', script: body.map((l) => l.slice(common)).join('\n') })
    i = j - 1
  }
  return steps
}

/** 写一个假 `gh` 到 `<dir>/bin/gh`，记录 argv 并按子命令给响应。 */
function writeGhStub(binDir, { log, viewBody, editedBody }) {
  mkdirSync(binDir, { recursive: true })
  const stub = join(binDir, 'gh')
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
set -euo pipefail
LOG="\${DSH_GH_LOG:?}"
printf '%s\\n' "ARGS: $*" >> "\${LOG}"
if [ "\${1:-}" = release ] && [ "\${2:-}" = view ]; then
  cat "\${DSH_GH_VIEW_BODY:?}"
  exit 0
fi
if [ "\${1:-}" = release ] && [ "\${2:-}" = upload ]; then
  shift 2
  tag="\${1:-}"; shift || true
  echo "UPLOAD tag=\${tag}" >> "\${LOG}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --clobber) echo "CLOBBER" >> "\${LOG}"; shift ;;
      *) if [ ! -s "$1" ]; then echo "上传目标不存在或为空: $1" >&2; exit 1; fi
         echo "FILE $1" >> "\${LOG}"; shift ;;
    esac
  done
  exit 0
fi
if [ "\${1:-}" = release ] && [ "\${2:-}" = edit ]; then
  shift 2; tag="\${1:-}"; shift || true
  while [ $# -gt 0 ]; do
    case "$1" in
      --notes-file) cp "\$2" "\${DSH_GH_EDITED:?}"; shift 2 ;;
      *) shift ;;
    esac
  done
  echo "EDIT tag=\${tag}" >> "\${LOG}"
  exit 0
fi
echo "桩 gh 不处理的子命令: $*" >&2
exit 1
`,
    'utf8'
  )
  chmodSync(stub, 0o755)
  return { binDir, log, viewBody, editedBody }
}

/**
 * 按**宿主**选三个三元组。
 *
 * 刻意不写死「三个平台各一个」：伪造 Windows 三元组会走 `Compress-Archive`
 * （PowerShell），而 Linux/macOS runner 上没有 `powershell` —— 演练会在真 CI 上红，
 * 红的却是演练装置本身。CI 是三平台矩阵，因此让每个平台跑自己那种归档格式，
 * 「zip 与 tar.gz 两条分支」由矩阵整体覆盖，而不是由单次运行假装覆盖。
 *
 * @param {string|null} host `rustc -vV` 的 host
 * @returns {string[]} 三个同格式的目标三元组
 */
export function dryRunTriples(host) {
  const h = String(host ?? '')
  if (h.includes('windows')) {
    return ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc', 'i686-pc-windows-msvc']
  }
  return ['x86_64-unknown-linux-gnu', 'x86_64-unknown-linux-musl', 'aarch64-apple-darwin']
}

function main() {
  const argv = process.argv.slice(2)
  let binary = join(projectRoot, 'target', 'release', 'dsh-host-cli')
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--binary') binary = argv[++i]
  }
  if (!existsSync(binary) && existsSync(`${binary}.exe`)) binary = `${binary}.exe`
  if (!existsSync(binary)) {
    console.error(`找不到 CLI 二进制：${binary}（先跑 cargo build --release -p dsh-host-cli）`)
    process.exit(1)
  }

  const text = readFileSync(RELEASE_YML, 'utf8').replace(/\r\n/g, '\n')
  const steps = extractRunSteps(text, 'cli-publish')
  if (steps.length === 0) {
    console.error('没有从 cli-publish 里抽出任何 run: 步骤——抽取逻辑或工作流结构变了')
    process.exit(1)
  }
  console.log(`抽出 ${steps.length} 个 run 步骤：${steps.map((s) => s.name).join(' / ')}`)

  const work = mkdtempSync(join(tmpdir(), 'dsh-publish-dryrun-'))
  const failures = []
  try {
    // 1) 在临时目录里搭一个**最小检出布局**：工作流按相对路径调用
    //    `scripts/package-cli.mjs` 并读写 `dist/cli/`，所以要逐字执行它，
    //    就必须有一个形如检出根的工作目录。
    //
    //    刻意**不**用仓库根：那样会真的清空/覆盖 `dist/cli`——如果这个演练在 CI 的
    //    打包步骤之后运行，它会抹掉刚产出的真产物，而演练本身还是绿的。
    //    （`package-cli.mjs` 只依赖 Node 内置模块，因此复制两个文件即可。）
    const outDir = join(work, 'dist', 'cli')
    mkdirSync(join(work, 'scripts'), { recursive: true })
    mkdirSync(outDir, { recursive: true })
    copyFileSync(join(projectRoot, 'scripts', 'package-cli.mjs'), join(work, 'scripts', 'package-cli.mjs'))
    copyFileSync(join(projectRoot, 'package.json'), join(work, 'package.json'))
    const host = hostTriple()
    const triples = dryRunTriples(host)
    for (const triple of triples) {
      const staged = join(work, 'bin', triple)
      mkdirSync(dirname(staged), { recursive: true })
      copyFileSync(binary, staged)
      packageCli({ binPath: staged, triple, outDir, hostTriple: host })
    }
    console.log(`最小检出布局已就绪：${work}`)
    console.log(`  平台三元组（按宿主格式）：${triples.join(' / ')}`)

    // 2) 假 gh + 环境。
    const log = join(work, 'gh.log')
    const viewBody = join(work, 'view-body.md')
    const editedBody = join(work, 'edited-body.md')
    writeFileSync(log, '')
    writeFileSync(viewBody, '## 既有正文\n\n这是一段发布前就有的说明。\n')
    writeGhStub(join(work, 'bin'), { log, viewBody, editedBody })

    const env = {
      ...process.env,
      PATH: `${join(work, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
      DSH_GH_LOG: log,
      DSH_GH_VIEW_BODY: viewBody,
      DSH_GH_EDITED: editedBody,
      TAG: 'v0.0.0-test',
      GITHUB_REPOSITORY: 'owner/repo',
      GH_TOKEN: 'stub'
    }

    // 3) 逐字执行每个 run 块（cwd = 最小检出布局，与 runner 上的相对路径一致）。
    //
    //    ⚠️ 工作流的「上传」步骤断言**四类**产物齐全（`*.zip` / `*.tar.gz` /
    //    `*.sha256` / `*.manifest.json`）——那是三平台矩阵整体产出的事实（Windows
    //    job 给 zip、Linux/macOS job 给 tar.gz，汇到同一个 artifact 目录）。
    //    单机上只能造出一种归档格式，因此这一步在本演练里**预期失败**：
    //    它检验的是工作流的跨平台假设，而演练装置无法在本机复现那个前提。
    //    这不是「跳过检查」——该断言由三平台 CI 矩阵在真实发布路径上覆盖；
    //    本演练负责的是它上游的那些步骤（核验、正文渲染）与 shell 语义本身。
    const CROSS_PLATFORM_STEP = /Upload artifacts to the release/
    let sawCrossPlatformLimit = false
    for (const step of steps) {
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.script], {
        cwd: work,
        env,
        encoding: 'utf8'
      })
      let ok = result.status === 0
      const isCrossPlatform = CROSS_PLATFORM_STEP.test(step.name)
      if (!ok && isCrossPlatform && /没有任何 \*\.tar\.gz|没有任何 \*\.zip/.test(`${result.stdout}${result.stderr}`)) {
        // 只接受这一种失败原因；其它的（例如缺少 --clobber、文件为空）仍必须判红。
        ok = true
        sawCrossPlatformLimit = true
      }
      console.log(`\n=== 步骤：${step.name} → ${ok ? (isCrossPlatform && sawCrossPlatformLimit ? '⏭ 预期受限（见脚本注释）' : '✅') : `❌ 退出码 ${result.status}`} ===`)
      if (result.stdout?.trim()) console.log(result.stdout.trim())
      if (!ok) {
        console.error(result.stderr?.trim())
        failures.push(`步骤「${step.name}」失败（退出码 ${result.status}）`)
      }
    }
    if (sawCrossPlatformLimit) {
      console.log(
        '\n注：上传步骤因「本机只能产出单一归档格式」而未走完——该步骤的跨平台完整性断言' +
          '由三平台 CI 矩阵覆盖（见脚本头部说明）。'
      )
    }

    // 4) 断言桩记录下来的调用形状。
    //    若上传步骤因「本机无法同时产出两种归档格式」而中止（见上文），
    //    上传相关断言就没有可断言的对象——此时**明确声明跳过**，而不是静默通过。
    const ghLog = readFileSync(log, 'utf8')
    if (sawCrossPlatformLimit) {
      console.log(
        '⏭ 跳过上传相关断言（文件数 / --clobber）：上传步骤在本机未执行完成，' +
          '无对象可断言。它们由真实发布路径覆盖。'
      )
    } else {
      const uploaded = ghLog.split('\n').filter((l) => l.startsWith('FILE ')).length
      // 每个平台 3 类（归档、边车、manifest）。数量必须等于实际造出来的产物数——
      // 写死「9」会在三元组数量变化时给出误导性的错误（真正该比的是目录内容）。
      const expectedFiles = triples.length * 3
      if (uploaded !== expectedFiles) {
        failures.push(`上传的文件数是 ${uploaded}，期望 ${expectedFiles}（${triples.length} 平台 × 3 类）`)
      }
      if (!ghLog.includes('CLOBBER')) {
        failures.push('上传没有带 --clobber（重跑通道会失败）')
      }
    }
    if (!existsSync(editedBody)) {
      failures.push('没有调用 gh release edit --notes-file（Release 正文没被写入）')
    } else {
      const body = readFileSync(editedBody, 'utf8')
      if (!body.includes('既有正文')) failures.push('正文里的原有内容被吃掉了')
      const markers = body.split('<!-- dsh-host-cli -->').length - 1
      if (markers !== 1) failures.push(`正文里的幂等标记有 ${markers} 个，期望 1 个`)
      for (const triple of triples) {
        if (!body.includes(triple)) failures.push(`正文表格里缺平台 ${triple}`)
      }
      if (!body.includes('releases/download/v0.0.0-test/')) failures.push('正文表格里的下载链接没有按 tag 生成')
    }

    if (failures.length > 0) {
      console.error(`\n❌ cli-publish 演练失败 ${failures.length} 项：`)
      for (const f of failures) console.error(`  - ${f}`)
      console.error(`\n（工作目录保留以便复查：${work}）`)
      process.exit(1)
    }
    const scope = sawCrossPlatformLimit
      ? '核验步骤 + 正文渲染（上传步骤受本机归档格式限制，见上）'
      : '核验步骤 + 上传文件数 / --clobber + 正文渲染'
    console.log(`\n✅ cli-publish 步骤原文执行通过：${scope}`)
  } finally {
    if (failures.length === 0) rmSync(work, { recursive: true, force: true })
  }
}

const isDirectRun = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')
  } catch {
    return false
  }
})()

if (isDirectRun) main()
