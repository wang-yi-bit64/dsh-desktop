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
 * ## 豁免判据为什么锚在标记上（2026-09-22 修正）
 *
 * 工作流的两个步骤在「某一类产物根本没出现」时会判红——这是对的（不完整的产物集
 * 不该发布）。但**单台宿主造不出所有产物类**：`.zip` 一律走 PowerShell
 * `Compress-Archive`，Windows 之外没有 `powershell`；便携版更是 Windows 独占。
 * 于是演练必须放行「本机造不出」的那些类，其余任何缺失都判红。
 *
 * 原先这个放行靠**匹配报错里的散文**（`没有任何 *.zip`）。工作流一句措辞改动就让
 * 匹配失效 → 豁免消失 → 三个平台一起红，而根因只是一句话被改写（真实发生）。
 * 现在：
 *
 *   1. 工作流在报错里带机器可读标记 `missing-artifact-class: <类名>`；
 *   2. 演练按标记判定，并在静态守卫（`verify-release-workflow.mjs`）里钉住
 *      「标记必须在、且必须指向循环变量」——标记丢了会**当场判红**，
 *      而不是退化成静默放行；
 *   3. 放行集合由 {@link fixturePlan} 逐条声明（带原因），并受**产物类契约**约束：
 *      工作流的必需清单 == 夹具能造的类 ∪ 本机造不出的类。清单里出现任何无出处的
 *      新类都会在自检里判红——这正是 2026-09-22 那个「必需清单里写了一个永远
 *      不可能命中的模式、于是每次发布都判红」缺陷的正面守卫。
 *
 * ## 无副作用
 *
 * 演练在**临时目录**里搭一个最小检出布局（`package.json` + `dist/` + 两个入口脚本
 * **及其本地导入的传递闭包**），不在仓库根跑——否则它会清空真的 `dist/`，而演练本身
 * 还是绿的。
 *
 * > ⚠️ 复制哪些脚本由 {@link scriptMirrorClosure} **算**出来，不写死。写死的清单会随
 * > 「入口脚本新增一个本地 import」而静默失效，症状只出现在子进程里：
 * > `ERR_MODULE_NOT_FOUND: Cannot find module '…/scripts/remove-tree.mjs'`
 * > ——2026-09-23 就是这样红的（`package-cli.mjs` 开始导入它，而清单没跟上）。
 * > 算得对不对由 {@link mirrorSelfCheck} 钉住（硬编码 `remove-tree.mjs` 必须在闭包里）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/dry-run-cli-publish.mjs                 # 需要 target/release 下已构建的 CLI
 * node scripts/dry-run-cli-publish.mjs --binary <path>
 * node scripts/dry-run-cli-publish.mjs --self-test     # 只跑纯逻辑判据（不需要二进制）
 * ```
 *
 * 退出码：`0` 通过 · `1` 任一断言失败（打印被执行的原文与该步骤的输出）。
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archiveExtension, packageCli, hostTriple } from './package-cli.mjs'
import { MIN_RUNTIME_BYTES, makeBundleFixture, packagePortable } from './package-portable.mjs'

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
 * 本机夹具计划：这台宿主能造哪些产物类、造不出哪些。
 *
 * ## 为什么「能造什么」是宿主能力，而不是我们想造什么
 *
 * 产物类由两个 packager 决定，而它们对**工具**的依赖并不对称：
 *   · `.zip` 一律走 PowerShell `Compress-Archive` —— **Windows 之外没有 `powershell`**；
 *   · `.tar.gz` 走 `tar` —— 到处都有，**包括 Windows**（`bsdtar`）；
 *   · 便携版整体是 Windows 独占（`packagePortable` 有前置条件硬拦）。
 *
 * 因此 Windows 宿主能同时造出两种归档格式（喂给「两种格式都必需」的上传步骤就是
 * 完整覆盖），而 Linux / macOS 宿主造不出 `.zip`，也就造不出任何便携版产物。
 *
 * ## 这不是「跳过检查」
 *
 * 造不出的类被**逐条声明**（`unproducible`，每条带原因），演练据此把工作流的报错
 * 限定在这一组里：**任何超出声明的缺失都判红**。而声明本身又被产物类契约
 * （{@link selfCheck}）钉在工作流的必需清单上——声明的类必须真的在清单里、
 * 造得出来的类不许谎报造不出、清单里出现的任何新类都必须有出处。
 *
 * @param {string|null} host `rustc -vV` 的 host
 * @returns {{triples: string[], portable: boolean, unproducible: {pattern: string, why: string}[]}}
 */
export function fixturePlan(host) {
  if (/windows/.test(String(host ?? ''))) {
    return {
      // 三条三元组、三条 manifest——数量与真实发布一致。两个 Windows 目标出 `.zip`、
      // 一个 Linux 目标出 `.tar.gz`：**两种格式同时在场**，这正是真实发布在同一
      // artifact 目录里看到的样子，也是让上传步骤跑到底、把「文件数 / --clobber」
      // 两条断言从死断言变成活断言的前提。
      //
      // ⚠️ 为什么要塞一个 Linux 三元组：三平台矩阵（非 Windows 宿主）只能用同一种
      //    格式，上传步骤里「另一种格式」那一类必然缺席、注定被判红并放行，于是
      //    「上传是否真的执行过」在任何平台上都测不到。Windows 宿主没有这个限制
      //    （tar 到处都有），因此它成了**唯一**能把上传步骤完整跑完的平台。
      triples: [
        'x86_64-pc-windows-msvc',
        'i686-pc-windows-msvc',
        'x86_64-unknown-linux-gnu'
      ],
      portable: true,
      unproducible: []
    }
  }
  return {
    triples: ['x86_64-unknown-linux-gnu', 'x86_64-unknown-linux-musl', 'aarch64-apple-darwin'],
    portable: false,
    unproducible: [
      {
        pattern: 'dist/cli/*.zip',
        why: '造 .zip 要走 PowerShell Compress-Archive，非 Windows 宿主没有 powershell'
      },
      { pattern: 'dist/portable/*.zip', why: '同上；便携版本身就是 Windows 独占产物' },
      { pattern: 'dist/portable/*.sha256', why: '随便携版归档一起产出，归档造不出就没有边车' },
      {
        pattern: 'dist/portable/*.manifest.json',
        why: '随便携版归档一起产出，归档造不出就没有 manifest'
      }
    ]
  }
}

/** 「该类产物缺失」的机器可读标记。`release.yml` 里逐字写着它，判据锚在它上面。 */
export const MISSING_CLASS_MARKER = 'missing-artifact-class:'

const ERROR_LINE = /::error::([^\n]*)/g
// 产物类的**形状**逐字限定：`release.yml` 里它永远是 `dist/<子目录>/*.<扩展名>`。
// 这样限定不是为了好看——第一版写成 `(\S+)`，而核验步骤的报错里类名紧挨着破折号
// （`…json——没有下载到…`），于是它把一个连着说明的怪串当成了类名、豁免判定失败。
// 换成字符集白名单后，无论后面跟空格、破折号还是标点，类名都能被正确切出来。
const CLASS_IN_ERROR = /missing-artifact-class:\s*([A-Za-z0-9._*/-]+)/

/**
 * 从上传步骤的 `run:` 原文里抠出**必需产物类清单**。
 *
 * 抠不到（不足 4 条）说明工作流换了写法，判据失锚——调用方必须判红，而不是把
 * 「抠不到」当成「没有约束」（那正是豁免机制最危险的失效形态）。
 *
 * @param {string} uploadScript 上传步骤的脚本原文
 * @returns {string[]} 形如 `dist/cli/*.zip` 的模式列表
 */
export function requiredPatterns(uploadScript) {
  const list = /for pattern in[\s\S]*?;\s*do/.exec(String(uploadScript ?? ''))?.[0] ?? ''
  return [...list.matchAll(/'([^']*\*[^']*)'/g)].map((m) => m[1])
}

/**
 * 夹具**实际会造出来**的产物类。扩展名不写死，从 `archiveExtension` 推导——
 * 两个 packager 用同一个函数决定命名，这也让「改名但没改工作流 glob」当场暴露。
 *
 * @param {{triples: string[], portable: boolean}} plan
 * @returns {string[]}
 */
export function fixtureClasses(plan) {
  const classes = new Set()
  for (const triple of plan.triples) {
    classes.add(`dist/cli/*${archiveExtension(triple)}`)
    classes.add('dist/cli/*.sha256')
    classes.add('dist/cli/*.manifest.json')
  }
  if (plan.portable) {
    for (const pattern of [
      'dist/portable/*.zip',
      'dist/portable/*.sha256',
      'dist/portable/*.manifest.json'
    ]) {
      classes.add(pattern)
    }
  }
  return [...classes]
}

/**
 * 判定一个失败步骤是不是「本机造不出这一类」导致的预期受限。
 *
 * 规则刻意写得**窄**——放行等于少一次检查，宽一点就等于把演练变成静默通过：
 *   · 输出里每一条 `::error::` 都必须带标记：有一条不带，说明失败另有原因 → 判红；
 *   · 标记点名的类必须全部落在声明里：冒出未声明的类 → 判红；
 *   · 至少要有标记：空集合说明这不是「类缺失」，走普通失败路径。
 *
 * @param {{output: string, declared: string[]}} opts
 * @returns {{exempt: boolean, classes: string[], reason: string}}
 */
export function exemptionVerdict({ output, declared }) {
  const text = String(output ?? '')
  const errors = [...text.matchAll(ERROR_LINE)].map((m) => m[1].trim())
  if (errors.length === 0) {
    return { exempt: false, classes: [], reason: '输出里没有 ::error:: —— 不是「产物类缺失」这一类失败' }
  }
  const unmarked = errors.filter((line) => !line.includes(MISSING_CLASS_MARKER))
  if (unmarked.length > 0) {
    return {
      exempt: false,
      classes: [],
      reason: `有 ${unmarked.length} 条不带 ${MISSING_CLASS_MARKER} 标记的 ::error::：${unmarked.join(' | ')}`
    }
  }
  const classes = errors.map((line) => CLASS_IN_ERROR.exec(line)?.[1] ?? '').filter(Boolean)
  // 带标记但类名解析不出来 = 标记的形状坏了（例如类名与说明之间少了空格）。
  // 此时「放行」等于放行一切，必须判红而不是当作比对失败的分支。
  if (classes.length !== errors.length) {
    return {
      exempt: false,
      classes,
      reason: `${errors.length} 条标记里只有 ${classes.length} 条能解析出产物类——标记形状不合约定`
    }
  }
  const unexpected = classes.filter((c) => !declared.includes(c))
  if (unexpected.length > 0) {
    return {
      exempt: false,
      classes,
      reason: `缺失的产物类不在「本机造不出」的声明里：${unexpected.join('、')}`
    }
  }
  return { exempt: true, classes, reason: `缺失 ${classes.join('、')}（本机造不出这一类）` }
}

/**
 * 豁免判据的**可伪证性**自检：把每一种「不该放行」的形态喂进去，都必须不放行。
 *
 * 这套机制的唯一失败模式是「判据太宽 → 演练静默通过」，而那种失效没有任何外部
 * 症状。因此地基必须自己钉住自己，而不是等下一次真事故来发现。
 *
 * @param {string[]} declared 「本机造不出」的类
 * @returns {string[]} 失败项
 */
export function exemptionFalsifiability(declared) {
  const failures = []
  const marked = (cls) => `::error::${MISSING_CLASS_MARKER} ${cls} 下没有任何产物`
  const declaredClass = declared[0] ?? 'dist/cli/*.zip'
  const cases = [
    ['没有 ::error:: 的普通失败', 'bash: 某处炸了', false],
    ['不带标记的 ::error::', '::error::另有一个原因', false],
    ['标记 + 未声明的类', marked('dist/cli/*.zip'), declared.includes('dist/cli/*.zip')],
    ['标记 + 已声明的类', marked(declaredClass), declared.length > 0],
    ['已声明与未声明混在一起', `${marked(declaredClass)}\n::error::另一个原因`, false],
    // 标记后的类名与说明**粘在一起**（少一个空格）也必须能正确切出来——写成
    // 「宽松匹配」会让类名变成一个连着说明的怪串、豁免静默失效。
    ['类名与说明粘在一起', `::error::${MISSING_CLASS_MARKER} ${declaredClass}——说明`, declared.length > 0],
    ['标记后没有类名', `::error::${MISSING_CLASS_MARKER} ——说明`, false]
  ]
  for (const [label, output, want] of cases) {
    const { exempt } = exemptionVerdict({ output, declared })
    if (exempt !== want) {
      failures.push(`豁免判据可伪证性失败：${label} 期望 exempt=${want}，实际 ${exempt}`)
    }
  }
  return failures
}

/**
 * 纯逻辑自检：不需要 bash、不需要已构建的二进制。`--self-test` 只跑这些，
 * 因此本机 `target/` 不可写时它照样能跑（这正是把它单独拆出来的理由）。
 *
 * 核心是**产物类契约**：工作流要求的类 == 夹具能造的类 ∪ 本机造不出的类。
 * 它把 2026-09-22 那类缺陷（必需清单里写了一个永远不可能命中的模式，于是每次
 * 发布都判红）变成静态可拦：清单里出现任何无出处的新类，这里立刻报出来。
 *
 * @param {{text: string, plan: ReturnType<typeof fixturePlan>}} opts
 * @returns {string[]} 失败项（空数组即通过）
 */
export function selfCheck({ text, plan }) {
  const failures = []
  const steps = extractRunSteps(text, 'cli-publish')
  const upload = steps.find((step) => step.script.includes('gh release upload'))
  if (!upload) {
    return ['抽不出「上传到 Release」步骤——抽取逻辑或工作流结构变了（判据失锚）']
  }
  const required = requiredPatterns(upload.script)
  if (required.length < 4) {
    return [
      `从上传步骤只抠到 ${required.length} 条产物类（期望 ≥4）——抠取判据失锚，先修这里再谈别的`
    ]
  }
  const produced = fixtureClasses(plan)
  const declared = plan.unproducible.map((u) => u.pattern)

  const orphans = required.filter((p) => !produced.includes(p) && !declared.includes(p))
  if (orphans.length > 0) {
    failures.push(
      `上传清单里的 ${orphans.join('、')} 既不在夹具能造的类里，也不在「本机造不出」的声明里——` +
        '清单加了新类而演练没跟上（2026-09-22 的 dist/portable/*.tar.gz 就是这一类：' +
        '它永远造不出来，于是每一次发布都在这里红）'
    )
  }
  const stray = declared.filter((p) => !required.includes(p))
  if (stray.length > 0) {
    failures.push(`「本机造不出」的声明 ${stray.join('、')} 不在上传清单里——声明是废的`)
  }
  const overclaim = declared.filter((p) => produced.includes(p))
  if (overclaim.length > 0) {
    failures.push(
      `夹具能造 ${overclaim.join('、')}，却在「本机造不出」里声明——声明被滥用会放行真实缺失`
    )
  }
  failures.push(...exemptionFalsifiability(declared))
  return failures
}

/**
 * 本地（相对路径）导入说明符的四种写法。刻意宽松——**宁多勿漏**：漏一种写法
 * 会让镜像少拷一个文件，而症状要到子进程里才以 `ERR_MODULE_NOT_FOUND` 出现。
 *
 * 裸包名（`node:fs` / `some-pkg`）**不算**：它们不由镜像提供。
 *
 * @param {string} source - `.mjs` 源文本。
 * @returns {string[]} 去重后的相对说明符，如 `['./remove-tree.mjs']`。
 */
export function relativeImportSpecifiers(source) {
  const patterns = [
    /\bimport\s+[^'"]*?\bfrom\s*['"](\.[^'"]+)['"]/g, // import x from './y.mjs'
    /\bexport\s+[^'"]*?\bfrom\s*['"](\.[^'"]+)['"]/g, // export { x } from './y.mjs'
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g, // await import('./y.mjs')
    /^[ \t]*import\s+['"](\.[^'"]+)['"]/gm, // 副作用导入 import './y.mjs'
  ]
  const found = new Set()
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1])
  }
  return [...found]
}

/**
 * 算出镜像目录需要复制的脚本集合：入口脚本 **+ 其本地导入的传递闭包**。
 *
 * ## 为什么是「算」而不是「列」
 *
 * 原先这里写死 `['package-cli.mjs', 'package-portable.mjs']`，理由是「两个脚本都只依赖
 * Node 内置模块」。这个前提在 `package-cli.mjs` 开始导入 `./remove-tree.mjs` 之后就**不再成立**，
 * 而写死的清单没有任何机制会因此报错：演练在临时目录里搭好最小检出布局，子进程一启动就
 * `ERR_MODULE_NOT_FOUND: Cannot find module '/tmp/dsh-publish-dryrun-…/scripts/remove-tree.mjs'`。
 * 2026-09-23 的 CI 正是这样红的（`12e7e49` 加了这个导入；该提交从未跑过 CI，于是它是「下一个从未绿过的灯」）。
 *
 * 换成算闭包之后，新增本地模块**自动**被带上；而「算得对不对」由 `mirrorSelfCheck()` 钉住
 * （那里硬编码了 `remove-tree.mjs` 必须在闭包里，作为独立事实而非用闭包自己现算）。
 *
 * @param {object} options
 * @param {string} options.projectRoot - 仓库根。
 * @param {string[]} options.entries - 入口脚本文件名（相对 `scripts/`）。
 * @returns {string[]} 需要复制的文件名（已排序）。
 * @throws {Error} 闭包引用了不存在的脚本——宁可响亮失败，也不要少拷一个再让子进程去撞。
 */
export function scriptMirrorClosure({ projectRoot: root, entries }) {
  const seen = new Set()
  const queue = [...entries]
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    const full = join(root, 'scripts', name)
    if (!existsSync(full)) {
      throw new Error(`镜像闭包引用了不存在的脚本：scripts/${name}（它被某个入口或已被导入的模块 import）`)
    }
    seen.add(name)
    for (const specifier of relativeImportSpecifiers(readFileSync(full, 'utf8'))) {
      // 只关心同目录的本地模块；`../x.mjs` 之类不属于镜像要复制的范围。
      if (specifier.startsWith('./')) queue.push(specifier.slice(2))
    }
  }
  return [...seen].sort()
}

/**
 * 复核一组文件里引用的本地模块是否都在**同一集合**内。
 *
 * 与闭包推导的关系是「独立第二判据」：闭包靠正则抓说明符，正则会漏写法；这条直接从
 * 已被复制的文件出发再抓一遍，漏了就报出来。它把「子进程里的 ERR_MODULE_NOT_FOUND」
 * 提前成一句能直接读懂的话。
 *
 * @param {object} options
 * @param {string} options.dir - 存放这些文件的目录。
 * @param {string[]} options.files - 目录内的文件名集合。
 * @returns {string[]} 形如 `package-cli.mjs → remove-tree.mjs` 的缺失项。
 */
export function unresolvedMirroredImports({ dir, files }) {
  const present = new Set(files)
  const missing = []
  for (const file of files) {
    const source = readFileSync(join(dir, file), 'utf8')
    for (const specifier of relativeImportSpecifiers(source)) {
      if (!specifier.startsWith('./')) continue
      const target = specifier.slice(2)
      if (!present.has(target)) missing.push(`${file} → ${target}`)
    }
  }
  return missing
}

/** 演练的入口脚本；镜像闭包从它们出发。 */
const MIRROR_ENTRIES = ['package-cli.mjs', 'package-portable.mjs']

/**
 * 镜像闭包的纯逻辑自检（不需要二进制、不需要 git）。
 *
 * 三类断言：**独立事实**（真实仓库的闭包必须含 `remove-tree.mjs`）、**完整性**
 * （闭包内不得有指向镜像外的相对导入）、**可证伪性**（合成三层树，走查必须穿透传递边、
 * 且不得把裸包名当成本地文件）。
 *
 * @returns {string[]} 失败项描述；空数组表示通过。
 */
export function mirrorSelfCheck() {
  const failures = []
  const closure = scriptMirrorClosure({ projectRoot, entries: MIRROR_ENTRIES })

  // A) 独立事实：不用闭包现算，直接钉住它是回归的形状。
  //    写死成 `remove-tree.mjs` 而不是「非空」——「非空」在漏拷时照样过。
  if (!closure.includes('remove-tree.mjs')) {
    failures.push(
      '镜像闭包漏了 remove-tree.mjs（package-cli.mjs 导入它）——演练会在子进程里 ERR_MODULE_NOT_FOUND'
    )
  }
  for (const entry of MIRROR_ENTRIES) {
    if (!closure.includes(entry)) failures.push(`镜像闭包漏了入口脚本 ${entry}`)
  }

  // B) 完整性：闭包必须自洽，否则演练会死在子进程里而不是这里。
  const missing = unresolvedMirroredImports({ dir: join(projectRoot, 'scripts'), files: closure })
  if (missing.length > 0) {
    failures.push(`镜像闭包不自洽（引用了未纳入的文件）：${missing.join('、')}`)
  }

  // C) 可证伪性：合成一棵 a → b → c 的树，另加裸包名与副作用导入。
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-mirror-selftest-'))
  try {
    mkdirSync(join(tmp, 'scripts'), { recursive: true })
    writeFileSync(
      join(tmp, 'scripts', 'a.mjs'),
      "import { b } from './b.mjs'\nimport 'node:fs'\nimport z from 'some-bare-package'\nimport './side-effect.mjs'\n"
    )
    writeFileSync(join(tmp, 'scripts', 'b.mjs'), "export { c } from './c.mjs'\n")
    writeFileSync(join(tmp, 'scripts', 'c.mjs'), 'export const c = 1\n')
    writeFileSync(join(tmp, 'scripts', 'side-effect.mjs'), '\n')

    const walked = scriptMirrorClosure({ projectRoot: tmp, entries: ['a.mjs'] })
    for (const expected of ['a.mjs', 'b.mjs', 'c.mjs', 'side-effect.mjs']) {
      if (!walked.includes(expected)) failures.push(`走查未穿透传递边：漏了 ${expected}`)
    }
    if (walked.length !== 4) {
      failures.push(`走查把非本地模块也算进来了：期望 4 个，实际 ${walked.length} 个（${walked.join('、')}）`)
    }
    if (relativeImportSpecifiers("import fs from 'node:fs'\n").length !== 0) {
      failures.push('裸包名被判成了本地导入')
    }
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不影响断言结论，不掩盖真正的失败项。
    }
  }

  return failures
}

function main({ selfTestOnly = false } = {}) {
  const argv = process.argv.slice(2)
  let binary = join(projectRoot, 'target', 'release', 'dsh-host-cli')
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--binary') binary = argv[++i]
  }
  if (!existsSync(binary) && existsSync(`${binary}.exe`)) binary = `${binary}.exe`

  const text = readFileSync(RELEASE_YML, 'utf8').replace(/\r\n/g, '\n')
  const host = hostTriple()
  const plan = fixturePlan(host)
  const declared = plan.unproducible.map((u) => u.pattern)

  // 0) 纯逻辑自检**先于**一切外部依赖：它不需要 bash、不需要二进制，本机
  //    `target/` 不可写时仍然能跑通——这正是 `--self-test` 存在的理由。
  const selfFailures = [...selfCheck({ text, plan }), ...mirrorSelfCheck()]
  if (selfFailures.length > 0) {
    console.error(`❌ 演练自检失败 ${selfFailures.length} 项：`)
    for (const failure of selfFailures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log(
    `✅ 产物类契约自检通过：本机 ${host} —— 夹具能造 ${fixtureClasses(plan).length} 类、` +
      `本机造不出 ${declared.length} 类（工作流清单与两者逐条对齐）`
  )
  console.log(
    `✅ 镜像闭包自检通过：${scriptMirrorClosure({ projectRoot, entries: MIRROR_ENTRIES }).join('、')}`
  )
  if (selfTestOnly) return

  if (!existsSync(binary)) {
    console.error(`找不到 CLI 二进制：${binary}（先跑 cargo build --release -p dsh-host-cli）`)
    process.exit(1)
  }

  const steps = extractRunSteps(text, 'cli-publish')
  if (steps.length === 0) {
    console.error('没有从 cli-publish 里抽出任何 run: 步骤——抽取逻辑或工作流结构变了')
    process.exit(1)
  }
  console.log(`抽出 ${steps.length} 个 run 步骤：${steps.map((s) => s.name).join(' / ')}`)

  const work = mkdtempSync(join(tmpdir(), 'dsh-publish-dryrun-'))
  const failures = []
  try {
    // 1) 在临时目录里搭一个**最小检出布局**：工作流按相对路径调用 `scripts/` 下的
    //    脚本并读写 `dist/cli`、`dist/portable`，所以要逐字执行它，就必须有一个
    //    形如检出根的工作目录。
    //
    //    刻意**不**用仓库根：那样会真的清空/覆盖 `dist/`——如果这个演练在 CI 的
    //    打包步骤之后运行，它会抹掉刚产出的真产物，而演练本身还是绿的。
    //
    //    ⚠️ 要复制哪些脚本**不能写死**。曾经写死成两个入口，理由是「都只依赖 Node
    //       内置模块」；`package-cli.mjs` 后来导入了 `./remove-tree.mjs`，这个前提
    //       失效而清单无人更新 → 演练在子进程里 ERR_MODULE_NOT_FOUND（2026-09-23）。
    //       现在按**本地导入闭包**算（`scriptMirrorClosure`），新增模块自动被带上。
    const outDir = join(work, 'dist', 'cli')
    const portableOut = join(work, 'dist', 'portable')
    mkdirSync(join(work, 'scripts'), { recursive: true })
    mkdirSync(outDir, { recursive: true })
    const mirrorFiles = scriptMirrorClosure({ projectRoot, entries: MIRROR_ENTRIES })
    for (const file of mirrorFiles) {
      copyFileSync(join(projectRoot, 'scripts', file), join(work, 'scripts', file))
    }
    // 复制完之后复核一遍：把「子进程启动即 ERR_MODULE_NOT_FOUND」提前成这里的一句人话。
    const unresolved = unresolvedMirroredImports({ dir: join(work, 'scripts'), files: mirrorFiles })
    if (unresolved.length > 0) {
      throw new Error(`镜像目录不自洽，子进程必然 ERR_MODULE_NOT_FOUND：${unresolved.join('、')}`)
    }
    copyFileSync(join(projectRoot, 'package.json'), join(work, 'package.json'))

    // 1a) CLI 产物：真实 `packageCli`（不是手抄一份）。同宿主三元组的那个会
    //     顺带跑一次「产物真的能执行」的自检——这是本演练唯一能覆盖它的地方。
    for (const triple of plan.triples) {
      const staged = join(work, 'bin', triple)
      mkdirSync(dirname(staged), { recursive: true })
      copyFileSync(binary, staged)
      packageCli({ binPath: staged, triple, outDir, hostTriple: host })
    }

    // 1b) 便携版产物：同样调**真的** `packagePortable`，夹具走共享构造函数
    //     （`makeBundleFixture`，与 `package-portable.mjs --self-test` 同一份实现）。
    //     它必须真的过 `MIN_RUNTIME_BYTES` 护栏，否则前置校验会拒绝打包——
    //     而我们要测的正是「核验下载产物」那一步，不是在测一个残缺输入。
    //
    //     ⚠️ 只有 Windows 宿主能走这一步（`packagePortable` 的前置条件拦着），
    //        非 Windows 上便携版产物类被逐条声明为「本机造不出」（见 fixturePlan）。
    if (plan.portable) {
      const version = JSON.parse(readFileSync(join(work, 'package.json'), 'utf8')).version
      const bundleDir = join(work, 'portable-bundle')
      makeBundleFixture({
        dir: bundleDir,
        triple: host,
        runtimeBytes: MIN_RUNTIME_BYTES + 8 * 1024 * 1024
      })
      packagePortable({ bundleDir, outDir: portableOut, triple: host, version })
    }

    console.log(`最小检出布局已就绪：${work}`)
    console.log(`  CLI 三元组：${plan.triples.join(' / ')}`)
    console.log(`  便携版夹具：${plan.portable ? `已造（${host}）` : '本机造不出，跳过并声明'}`)

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
    //    失败时**不再**按散文判断豁免，而是问 {@link exemptionVerdict}：
    //    「导致失败的那些 ::error:: 是不是恰好都是本机造不出的产物类」。
    //    判据锚在 `missing-artifact-class:` 标记上，所以措辞改动不会再让豁免
    //    静默失效（那正是 2026-09-22 三个平台一起红的原因）。
    let uploadExempted = null
    for (const step of steps) {
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.script], {
        cwd: work,
        env,
        encoding: 'utf8'
      })
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      let ok = result.status === 0
      let note = ok ? '✅' : `❌ 退出码 ${result.status}`
      if (!ok) {
        const verdict = exemptionVerdict({ output, declared })
        if (verdict.exempt) {
          ok = true
          note = `⏭ 预期受限：${verdict.reason}`
          if (step.script.includes('gh release upload')) uploadExempted = verdict
        } else {
          note = `❌ 退出码 ${result.status}（不放行：${verdict.reason}）`
        }
      }
      console.log(`\n=== 步骤：${step.name} → ${note} ===`)
      if (result.stdout?.trim()) console.log(result.stdout.trim())
      if (!ok) {
        console.error(result.stderr?.trim())
        failures.push(`步骤「${step.name}」失败（退出码 ${result.status}）`)
      }
    }
    if (uploadExempted) {
      console.log(
        `\n注：上传步骤因「本机造不出 ${uploadExempted.classes.join('、')}」而未走完——` +
          '该部分的完整性由三平台发布矩阵在真实发布路径上覆盖（见脚本头部说明）。'
      )
    }

    // 4) 断言桩记录下来的调用形状。
    const ghLog = readFileSync(log, 'utf8')
    if (uploadExempted) {
      console.log(
        '⏭ 跳过上传相关断言（文件数 / --clobber）：上传步骤在本机未执行完成，' +
          '无对象可断言。它们由真实发布路径覆盖。'
      )
    } else {
      // 上传了哪些文件由**夹具内容**决定（而不是写死一个数字——写死会在夹具
      // 变化时给出误导性的错误）。
      const expected = requiredPatterns(steps.find((s) => s.script.includes('gh release upload')).script)
        .flatMap((pattern) => expandFixtureGlob(join(work, pattern)))
      const uploaded = ghLog.split('\n').filter((l) => l.startsWith('FILE ')).length
      if (uploaded !== expected.length) {
        failures.push(`上传的文件数是 ${uploaded}，夹具里有 ${expected.length} 个（${expected.join('、')}）`)
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
      for (const triple of plan.triples) {
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
    const scope = uploadExempted
      ? '核验步骤 + 正文渲染（上传步骤因本机造不出的产物类而未走完，见上）'
      : '核验步骤 + 上传文件数 / --clobber + 正文渲染'
    console.log(`\n✅ cli-publish 步骤原文执行通过：${scope}`)
  } finally {
    if (failures.length === 0) rmSync(work, { recursive: true, force: true })
  }
}

/**
 * 展开夹具目录里的一个 `dir/*.ext` 模式（只需支持这一种形状）。
 * 用来把「该上传几个文件」变成夹具内容的函数，而不是写死的数字。
 *
 * @param {string} pattern 形如 `<work>/dist/cli/*.zip`
 * @returns {string[]} 命中的绝对路径
 */
export function expandFixtureGlob(pattern) {
  const slash = Math.max(pattern.lastIndexOf('/'), pattern.lastIndexOf('\\'))
  const dir = pattern.slice(0, slash)
  const name = pattern.slice(slash + 1)
  const suffix = name.startsWith('*') ? name.slice(1) : null
  if (suffix === null || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(suffix))
    .map((entry) => join(dir, entry))
}

const isDirectRun = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')
  } catch {
    return false
  }
})()

if (isDirectRun) main({ selfTestOnly: process.argv.includes('--self-test') })
