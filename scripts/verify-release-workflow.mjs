#!/usr/bin/env node
/**
 * verify-release-workflow.mjs — 发布工作流的静态判据守卫。
 *
 * ## 为什么存在（2026-09-11，v0.1.0 首次发布的真实事故）
 *
 * 首次 `v0.1.0` 发布时，三个平台的 release job **全红**，且都是只有真跑工作流
 * 才会暴露、编译器与本地门禁一律看不见的两类缺陷：
 *
 *   1. **tauri-action 的命令拼装**。该 action 内部会在 `tauriScript` 之后**自己**
 *      插入 `build` 子命令和一个 `--` 分隔符（见其 `src/runner.ts` / `src/build.ts`）：
 *
 *          args = [...tauriScript] + ['build'] + (bin==='npm' && 有参数 ? ['--'] : []) + [...tauriArgs]
 *
 *      本仓当时写成 `tauriScript: npm run tauri --` + `args: build --bundles …`，
 *      实际展开成 `npm run tauri -- build -- build --bundles …`，tauri CLI 报
 *      `unexpected argument 'build' found`，三平台一起失败。
 *
 *   2. **macOS bash 3.2 的变量终止**。生成发布说明的脚本里写了 `**首次发布**（$TAG）`：
 *      macOS runner 的 bash 3.2 在没有 UTF-8 locale 时**不会**把紧跟其后的全角
 *      `）` 当作变量名终止符，于是把变量解析成 `TAG）`，报
 *      `TAG）: unbound variable`（Linux/Windows 的 bash 正确终止，所以只有 macOS 红）。
 *
 * 这两条都“只在真跑发布时炸”，本地 `npm run verify:*` 全都绿——正是本仓守卫体系
 * 要覆盖的那一类。本脚本用纯文本判据把它们钉死，并带**可伪证性检查**：把上述两份
 * 缺陷配置当作夹具，断言必须变红。
 *
 * 用法：
 * ```bash
 * node scripts/verify-release-workflow.mjs            # 校验真实工作流
 * node scripts/verify-release-workflow.mjs --self-test # 自测（含可伪证性检查）
 * ```
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_YML = join(projectRoot, '.github', 'workflows', 'release.yml')
const TAURI_CONF = join(projectRoot, 'src-tauri', 'tauri.conf.json')

/**
 * 读入工作流并**归一化行尾**。
 *
 * 判据里有多条按行切分/替换的断言（job 切片、可伪证夹具），它们必须与检出配置无关：
 * git 的 `core.autocrlf` 会让同一份文件在这里是 CRLF、在那台机器上是 LF。
 * `AGENTS.md` §7.3 明令守卫不得依赖检出配置——否则「本地绿、CI 红」会按平台随机出现。
 *
 * @returns {string} 归一化后的工作流文本
 */
function readWorkflow() {
  return readFileSync(RELEASE_YML, 'utf8').replace(/\r\n/g, '\n')
}

/**
 * 从工作流文本里取出 tauri-action 步骤的 `tauriScript` 与 `args` 输入。
 *
 * 刻意只做**行级**解析（不引入 YAML 依赖）：定位 `uses: tauri-apps/tauri-action`
 * 之后，取到该步骤 `with:` 里的两个键即可，够用且不脆。
 *
 * @param {string} text release.yml 全文
 * @returns {{tauriScript: string|null, args: string|null}} 两个输入值（未找到为 null）
 */
export function extractTauriActionInputs(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /uses:\s*tauri-apps\/tauri-action/.test(line))
  if (start < 0) return { tauriScript: null, args: null }

  // 只在紧随其后的这一段里找，避免命中别的步骤。
  const window = lines.slice(start, start + 60)
  const readKey = (key) => {
    const re = new RegExp(`^\\s*${key}:\\s*(.*)$`)
    for (const line of window) {
      const m = re.exec(line)
      if (m) return m[1].trim()
    }
    return null
  }
  return { tauriScript: readKey('tauriScript'), args: readKey('args') }
}

/**
 * 复刻 tauri-action 内部把 tauriScript + args 拼成命令行的逻辑。
 *
 * 依据其 `dist/index.js`（`getRunner` 与 `Runner.execTauriCommand`）：
 *   - `tauriScript` 按空格切分，首 token 是 runner，其余是它的固定参数；
 *   - 若 runner 是 `npm` 且第一个固定参数不是 `run`，会补一个 `run`；
 *   - 之后 push 子命令 `build`；
 *   - 若 runner 是 `npm` 且本次带了参数，push 一个 `--`（这是 npm 的转发分隔符，
 *     **是预期行为**，不是缺陷）；
 *   - 最后 push 本次参数。
 *
 * `args` 里的 GitHub 表达式（`${{ … }}`，可能含空格）在 runner 上会先被展开成一个
 * 值，因此先折叠成占位 token 再切分，避免把 `${{` / `matrix.bundles` / `}}` 当成三个参数。
 *
 * @param {string} tauriScript 输入的 tauriScript（如 `npm run tauri`）
 * @param {string} argsInput 输入的 args（如 `--bundles ${{ matrix.bundles }} -v`）
 * @returns {string[]} 最终传给 runner 的 argv（不含 runner 本身）
 */
export function simulateTauriActionArgv(tauriScript, argsInput) {
  const script = String(tauriScript ?? '').trim()
  const [runner, ...runnerArgs] = script.split(/\s+/).filter(Boolean)

  const collapsedArgs = String(argsInput ?? '').replace(/\$\{\{[^}]*\}\}/g, 'EXPR')
  const tauriArgs = collapsedArgs.trim().split(/\s+/).filter(Boolean)

  const argv = []
  if (runner === 'npm' && runnerArgs[0] !== 'run') argv.push('run')
  argv.push(...runnerArgs)
  argv.push('build')
  if (runner === 'npm' && tauriArgs.length) argv.push('--')
  argv.push(...tauriArgs)
  return argv
}

/**
 * 判定 tauri-action 的配置是否是「tauri CLI 能接受」的形状。
 *
 * 事故的直接成因有两条，判据就钉这两条：
 *   1. `tauriScript` 自己带了 `build` 或 `--` —— action 会再补一份，导致重复；
 *   2. 展开后的 argv 里 `build` 必须**恰好一次**。
 *
 * 合法的 `--`（npm 在 `build` 之后自己插的转发分隔符）**不**判为问题——它是预期行为，
 * 只在 tauriScript 里出现才是缺陷。
 *
 * @param {string[]} argv `simulateTauriActionArgv()` 的产物
 * @param {string[]} tauriScriptTokens tauriScript 按空格切分后的 token
 * @returns {{ok: boolean, problems: string[]}} 判定与问题清单
 */
export function checkTauriArgv(argv, tauriScriptTokens = []) {
  const problems = []
  const builds = argv.filter((token) => token === 'build').length
  if (builds !== 1) problems.push(`tauri 子命令 build 出现了 ${builds} 次（必须恰好 1 次）`)
  if (tauriScriptTokens.includes('--')) {
    problems.push("tauriScript 里带了 '--'——action 会再补一个，导致 `build -- build` 之类的重复参数")
  }
  if (tauriScriptTokens.includes('build')) {
    problems.push("tauriScript 里带了 'build'——args 里不应再写它，否则 tauri 报 unexpected argument")
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 扫出**可执行行**里「shell 变量紧邻非 ASCII 字符」的写法。
 *
 * `$TAG）` 这类写法在 macOS 的 bash 3.2（无 UTF-8 locale）下会把全角字符并入变量名，
 * 报 `TAG）: unbound variable`。只认未加花括号的 `$NAME`（`${NAME}` 安全），
 * 跳过 GitHub 表达式 `${{ … }}` 与注释行。
 *
 * @param {string} text 待检查文本
 * @returns {Array<{line: number, snippet: string}>} 命中清单
 */
export function findUnbracedVarBeforeNonAscii(text) {
  const hits = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('#')) return // 注释不是可执行行
    const stripped = line.replace(/\$\{\{[^}]*\}\}/g, '')
    const re = /\$([A-Za-z_][A-Za-z0-9_]*)([^\x00-\x7F])/g
    let m
    while ((m = re.exec(stripped)) !== null) {
      hits.push({ line: index + 1, snippet: `${m[1]}${m[2]}` })
    }
  })
  return hits
}

/**
 * 取出某个 job 的 YAML 块（从 `name:` 行到下一个同级或更高级的键为止）。
 *
 * 判据必须**按 job 切片**再断言，不能用全局正则：`needs: [..., build, ...]` 这样的
 * 形状只要文件里任何一处满足，全局匹配就会放行——而它要守的恰恰是**那一个** job。
 * 切片刻意只做行级缩进判断，不引入 YAML 依赖：够用，且在重新排版时不会悄悄失效
 * （找不到 job 会返回 null，调用方按「缺失」报红，而不是静默跳过）。
 *
 * @param {string} text 工作流全文
 * @param {string} name job 名（如 `cli-publish`）
 * @returns {string|null} job 块文本（未找到为 null）
 */
export function jobBlock(text, name) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^\\s{0,2}${name}:\\s*$`).test(line))
  if (start < 0) return null
  const indent = lines[start].match(/^\s*/)[0].length
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) continue
    const lineIndent = line.match(/^\s*/)[0].length
    if (lineIndent <= indent && /^\s*[\w-]+:/.test(line)) return lines.slice(start, i).join('\n')
  }
  return lines.slice(start).join('\n')
}

/**
 * 取出 Release 正文段落那一步是否**委托**给了有自测的脚本。
 *
 * 这里刻意**不再**去解析/执行 heredoc 内联脚本：那段逻辑已经搬进
 * `scripts/package-cli.mjs`（`--release-notes`），其渲染与幂等性由
 * `npm run verify:cli-package` 的自测覆盖。留在 YAML 里的内联脚本是**不可测**的
 * ——YAML 解析器不碰 `run: |` 的内容，语法错 / argv 下标错只有真发布才炸，
 * 而发布不可逆。因此本守卫改判「有没有委托出去」与「有没有内联脚本残留」。
 *
 * @param {string} text release.yml 全文
 * @returns {{delegated: boolean, inlineHeredoc: boolean}}
 */
export function inspectNotesStep(text) {
  const delegated = /--release-notes[\s\S]{0,400}--tag/.test(text)
  const inlineHeredoc = /<<'NODE'/.test(text)
  return { delegated, inlineHeredoc }
}

/**
 * CLI 可引用产物在发布工作流里的形状判据。
 *
 * 每一条都对应一类**只在真发布时暴露**的失败：
 *   · 构建/打包步骤缺席 —— 产物根本没产出来，而工作流是绿的；
 *   · 上传不用 `--clobber` —— workflow_dispatch 兜底重跑时因资产已存在而失败
 *     （而重跑正是发布失败后的补救通道）；
 *   · 发布 job 不 `needs: build` —— Release 对象由 build 的 tauri-action 创建，
 *     先于它上传会失败；
 *   · 不传 `.sha256` 边车 —— 用户拿到归档却无从核对，「可引用」少了最关键的一环；
 *   · 平台不齐 —— 发布一个缺平台的产物集，用户从资产列表上看不出来；
 *   · 必需清单里写了**不可能命中**的模式（`dist/portable/*.tar.gz`）—— 便携版只有
 *     `.zip`，这条永远缺席，等于每次发布都判红（2026-09-22 实际发生）；
 *   · 「该类产物缺失」的报错没有机器可读标记 —— 发布演练的豁免判据会静默失效
 *     （2026-09-22 实际发生：判据靠散文匹配，一句话改写法就让三个平台一起红）；
 *   · Release 正文段落靠内联脚本 —— 不可测（见 {@link inspectNotesStep}）。
 *
 * @param {string} text release.yml 全文
 * @returns {{ok: boolean, problems: string[]}} 判定与问题清单
 */
export function checkCliArtifactShape(text) {
  const problems = []
  const buildJob = jobBlock(text, 'cli')
  const publishJob = jobBlock(text, 'cli-publish')

  if (!buildJob) {
    problems.push('没有 `cli` job——CLI 产物根本没产出')
  } else {
    if (!/cargo build --release -p dsh-host-cli/.test(buildJob)) {
      problems.push('`cli` job 没有构建步骤（cargo build --release -p dsh-host-cli）')
    }
    if (!/npm run package:cli/.test(buildJob)) {
      problems.push('`cli` job 没有调用打包脚本（npm run package:cli）——命名 / sha256 / 回读校验都会缺失')
    }
    for (const os of ['windows-latest', 'macos-latest', 'ubuntu-latest']) {
      if (!buildJob.includes(os)) problems.push(`\`cli\` job 的平台矩阵缺 ${os}`)
    }
    if (!/upload-artifact/.test(buildJob)) {
      problems.push('`cli` job 没有把产物落成 workflow artifact——cli-publish 将无物可取')
    }
  }

  if (!publishJob) {
    problems.push('没有 `cli-publish` job——产物没有被上传到 Release')
  } else {
    if (!/needs:\s*\[[^\]]*\bbuild\b[^\]]*\]/.test(publishJob)) {
      problems.push('`cli-publish` 未声明 needs: build——Release 对象由 build 的 tauri-action 创建，先上传必失败')
    }
    if (!/\bcli\b/.test(publishJob.match(/needs:\s*\[([^\]]*)\]/)?.[1] ?? '')) {
      problems.push('`cli-publish` 的 needs 里没有 cli——会在产物还没构建完时就去取')
    }
    if (!/gh release upload[\s\S]{0,600}--clobber/.test(publishJob)) {
      problems.push('上传 CLI 产物时没有 --clobber——workflow_dispatch 兜底重跑会因「资产已存在」失败')
    }
    // 四类产物必须逐类点名（CLI 两种归档 + 边车 + manifest）。少了边车这一类，
    // 用户拿到归档却无从核对，「可引用」就少了最关键的一环。
    //
    // 2026-09-22 起 portable 产物与 CLI 产物共用同一个上传步骤（`gh release upload` 一次
    // 传全部 glob），因此判据改为「每类 CLI 产物必须出现」——portable 产物走同一组
    // glob，只要 CLI 那组齐了，portable 那组必然也在同一步骤里。
    for (const [label, pattern] of [
      ['zip 归档', /dist\/cli\/\*\.zip'/],
      ['tar.gz 归档', /dist\/cli\/\*\.tar\.gz'/],
      ['sha256 边车', /dist\/cli\/\*\.sha256'/],
      ['manifest', /dist\/cli\/\*\.manifest\.json'/]
    ]) {
      if (!pattern.test(publishJob)) {
        problems.push(`上传时没有包含 ${label}（${pattern.source}）——产物集不完整`)
      }
    }
    // `shopt -s nullglob`：不设它，某个 glob 没命中时 bash 会把字面量
    // `dist/cli/*.tar.gz` 当文件名传给 gh，报错指向一个不存在的路径，
    // 而不是「这类产物缺失」。
    if (!/shopt -s nullglob/.test(publishJob)) {
      problems.push('上传步骤没有 `shopt -s nullglob`——glob 未命中时会传出字面量路径，错误信息会误导')
    }
    // 反向判据：**不可能命中**的模式不得出现在必需清单里。
    //
    // 🔴 2026-09-22：清单里曾长期躺着一句 `'dist/portable/*.tar.gz'`，它永远不可能
    // 命中——`portable` job 是 `windows-latest` 独占，而 `archiveExtension` 只对含
    // `windows` 的三元组给 `.zip`。于是每一次发布都会在这个循环里红，报的还是
    // 「该类产物缺失」（听起来像打包链路断了，实际是这个条件从来没成立过）。
    // 这类「判据写了一个不可能成立的条件」静态上就该拦，不能等发布时才撞。
    //
    // ⚠️ 只在 `for pattern in …; do` 这段**语句**里扫，不扫整个 job 块：本仓的注释
    //    习惯是把坏写法引在注释里说明缺陷（上面这段就是），扫全文会让守卫自己误报
    //    ——实测过：这条判据第一次落地就被自己的注释命中。
    const patternList = /^[^\S\n]*for pattern in[\s\S]*?;\s*do[^\S\n]*$/m.exec(publishJob)?.[0] ?? ''
    if (!patternList) {
      problems.push('找不到上传步骤的 `for pattern in …; do` 清单——反向判据失锚（改了写法就要同步改这里）')
    } else {
      for (const impossible of ['dist/portable/*.tar.gz']) {
        if (patternList.includes(`'${impossible}'`)) {
          problems.push(
            `上传清单里有不可能命中的模式 ${impossible}——便携版只有 .zip` +
              '（portable job 是 windows-only），把它写进必需清单等于每次发布都在此判红'
          )
        }
      }
    }
    // 「该类产物缺失」的报错必须带**机器可读标记**，且必须指向循环变量。
    //
    // 演练（`scripts/dry-run-cli-publish.mjs`）要区分两件不同的事：本机造不出这一类
    // （预期受限，放行）与链路真的断了（判红）。原先它靠匹配报错里的散文
    // （`没有任何 *.zip`），措辞一改就**静默失效**——豁免没了，演练在三个平台一起红，
    // 而根因只是一句话被改写。因此判据改锚在标记上：
    //   · 标记丢了 → 这里判红（而不是等演练变红后去猜）；
    //   · 标记在但丢了 `${pattern}` → 演练无从知道缺的是哪一类，豁免会退化成
    //     「任何缺失都放行」，同样判红。
    if (!/::error::missing-artifact-class: \$\{pattern\} /.test(publishJob)) {
      problems.push(
        '上传步骤里「该类产物缺失」的报错必须写成 `::error::missing-artifact-class: ${pattern} …`' +
          '（标记 + 循环变量）——演练的豁免判据锚在它上面'
      )
    }
    // 核验步骤的两条同类报错也要带标记，且标记后必须是上传清单里的同一个类名、
    // **并与说明之间留一个空格**——否则演练那边会把「类名 + 说明」解析成一个怪串，
    // 豁免判定随之失败（第一版就是这样踩的坑，已由演练自检的可伪证性用例守着）。
    for (const missingClass of ['dist/cli/*.manifest.json', 'dist/portable/*.manifest.json']) {
      const literalPattern = new RegExp(
        `::error::missing-artifact-class: ${missingClass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `
      )
      if (!literalPattern.test(publishJob)) {
        problems.push(
          `核验步骤里「缺 ${missingClass}」的报错必须写成 ` +
            `\`::error::missing-artifact-class: ${missingClass} <说明>\`（标记 + 类名 + 空格）——` +
            `演练靠它区分「本机造不出这一类」与「链路断了」`
        )
      }
    }
    if (!/--verify-download/.test(publishJob)) {
      problems.push('没有核验「下载回来的」产物（--verify-download）——artifact 存储链路改坏文件本地验不出来')
    }
    // `gh ... --jq '.body'` 对空正文返回字面量 null，会把 "null" 写进新正文。
    if (/'\.body\b[^']*'/.test(publishJob) && !/\.body \/\/ ""/.test(publishJob)) {
      problems.push(`读取 Release 正文时未做 null 归一（应为 '.body // ""'）——空正文会变成字面量 null`)
    }
  }

  const notes = inspectNotesStep(text)
  if (!notes.delegated) {
    problems.push('Release 正文的 CLI 段落没有委托给 package-cli.mjs（--release-notes + --tag）')
  }
  if (notes.inlineHeredoc) {
    problems.push("release.yml 里残留内联脚本（<<'NODE'）——YAML 内的脚本不可测，应移入有自测的脚本")
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 双通道发布形状的判据（2026-09-15 起）。
 *
 * 每条都对应一类**只在真发布时暴露**的失败：
 *   · preflight 不产出 `dsh_target` —— build job 无从知道该组装哪条上游线，
 *     只能落回默认目标，于是 `0.6.0-alpha.1` 的包里装的是 next 线的运行时
 *     （版本号与运行时不一致，用户装上才发现）；
 *   · 不经过 `dsh-targets.mjs --channel-of` 而自己猜通道 —— tag 后缀与目标表的
 *     对应关系会有两份实现，早晚漂移；
 *   · 组装步骤**不用 env 传目标名** —— 真实事故：`--dsh-target="${DSH_TARGET}"`
 *     在 Windows runner（PowerShell）上把值丢掉了，参数退化成 `--dsh-target=`，
 *     只有 Windows 的 job 红、macOS/Linux 正常。用 env 传值把 shell 引用整个消掉；
 *   · prerelease 标记硬编码 —— 预发布会被标成正式版，进而进 `releases/latest`，
 *     stable 用户收到一个 rc 更新（这正是 `latest.json` 那条命门）。
 *
 * @param {string} text release.yml 全文
 * @returns {{ok: boolean, problems: string[]}} 判定与问题清单
 */
export function checkDualChannelShape(text) {
  const problems = []
  const preflight = jobBlock(text, 'preflight')
  const build = jobBlock(text, 'build')

  if (!preflight) {
    problems.push('没有 `preflight` job——目标解析无从发生')
  } else {
    if (!/dsh_target:.*steps\.resolve\.outputs\.dsh_target/.test(preflight)) {
      problems.push('`preflight` 没有把 dsh_target 作为 job output 暴露——下游只能落回默认目标')
    }
    if (!/dsh-targets\.mjs\s+--channel-of/.test(preflight)) {
      problems.push(
        '`preflight` 没有用 `scripts/dsh-targets.mjs --channel-of` 推导目标——' +
          '自己写一套 tag→目标的映射会与 dsh-targets.mjs 漂移'
      )
    }
  }

  if (!build) {
    problems.push('没有 `build` job')
  } else {
    // 目标名必须经 env 传；允许 job 级别或 step 级别。job 级别的 `env:` 更稳：
    // 它能被子进程（包括 `tauri build` 的 `beforeBuildCommand`）继承。
    const prepareStep = /- name: Prepare harness resources[\s\S]{0,400}?run:\s*\n?\s*npm run prepare:harness/
    if (!prepareStep.test(build)) {
      problems.push(
        '`build` 的组装步骤不是 `env: DSH_TARGET` + `npm run prepare:harness` 的形状——' +
          '用 shell 插值传目标名在 Windows（PowerShell）上会被丢掉'
      )
    }
    // 接受两种合法写法：job 级别 env（优先）或 step 级别 env。
    const hasJobEnv = /env:\s*\n\s*DSH_TARGET:[\s\S]{0,100}?strategy:|env:\s*\n\s*DSH_TARGET:[\s\S]{0,100}?steps:/.test(build)
    const hasStepEnv = /Prepare harness resources[\s\S]{0,200}DSH_TARGET:/.test(build)
    if (!hasJobEnv && !hasStepEnv) {
      problems.push('`build` 的组装步骤没有通过 env 传 DSH_TARGET')
    }
    if (!/prerelease:\s*\$\{\{\s*needs\.preflight\.outputs\.prerelease/.test(build)) {
      problems.push(
        '`build` 的 prerelease 标记没有从版本号派生——硬编码会让预发布被标成正式版，' +
          '进而进 releases/latest，stable 用户会收到 rc 更新'
      )
    }
    // 发布正文必须显式声明「本版内置哪个 DSH 运行时」：双通道下这是用户选版本时
    // 最先看的信息，而变更日志的提交区间不保证提到它（alpha 线的区间常常只有版本
    // 提交一条，正文会近乎空白）。判据按**内容**判（正文里出现运行时横幅），
    // 不按写法判——这样它守的是结果，而不是某一种实现方式。
    if (!/内置运行时[\s\S]{0,80}DSH_VERSION|DSH_VERSION[\s\S]{0,80}通道/.test(build)) {
      problems.push(
        '发布正文没有声明内置的 DSH 运行时基线——用户无从判断这一版捆的是哪条通道' +
          '（双通道下这是选版本时最关键的信息）'
      )
    }
    if (!/dsh_version:.*steps\.resolve\.outputs\.dsh_version/.test(preflight ?? '')) {
      problems.push('`preflight` 没有把 dsh_version 暴露给 build——正文的运行时横幅取不到值')
    }
  }

  return { ok: problems.length === 0, problems }
}

/**
 * 扫出「把 `${{ … }}` 插进 run 字符串来传构建目标」的写法。
 *
 * 这份判据独立成函数是为了能对 smoke.yml 复用：两份工作流各有自己的组装步骤，
 * 但踩的是同一个坑（shell 改写语义），因此判据也应是同一条。
 *
 * @param {string} text 工作流全文
 * @returns {Array<{line: number, snippet: string}>} 命中清单
 */
export function findInterpolatedTargetArg(text) {
  const hits = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('#')) return // 注释不是可执行行
    if (/--dsh-target=/.test(line) && /\$\{\{/.test(line)) {
      hits.push({ line: index + 1, snippet: line.trim() })
    }
  })
  return hits
}

/**
 * 扫出「把 tauri 的构建钩子写成会**重新组装**资源」的写法。
 *
 * `tauri.conf.json` 的 `beforeDevCommand` / `beforeBuildCommand` 会在 tauri 内部
 * 触发，那一步拿不到 workflow 显式选的目标。若它们跑的是**组装**（而非 `--check`
 * 校验），就会按默认目标重新组装 `resources/`，把上一步刚组好的另一条线整个覆盖
 * ——2026-09-15 实测：alpha 的 Smoke 日志里同一 job 出现第二次组装 next，于是
 * alpha 的安装包与 L2 冒烟实际装的是 next 线运行时，而所有步骤都是绿的。
 *
 * @param {string} text tauri.conf.json 全文
 * @returns {{ok: boolean, problems: string[]}} 判定与问题清单
 */
export function checkTauriHooksAreCheckOnly(text) {
  const problems = []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, problems: [`tauri.conf.json 不是合法 JSON：${error.message}`] }
  }
  const build = parsed?.build ?? {}
  for (const hook of ['beforeDevCommand', 'beforeBuildCommand']) {
    const value = build[hook]
    if (typeof value !== 'string') continue
    if (!/prepare:harness/.test(value)) continue
    if (!/--check\b/.test(value)) {
      problems.push(
        `${hook} 会**重新组装**资源（"${value}"）——tauri 内部触发时拿不到目标，` +
          '会按默认目标覆盖另一条通道的树。改成 `npm run prepare:harness -- --check`（只校验）'
      )
    }
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 自测：对真实文件跑一遍判据，并用两份**已知缺陷夹具**做可伪证性检查。
 *
 * @returns {{passed: number}} 通过项数
 * @throws {Error} 任一断言失败时抛出，并汇总全部失败项
 */
export function selfTest() {
  const failures = []
  let passed = 0
  const check = (condition, message) => {
    passed += 1
    if (!condition) failures.push(message)
  }

  const text = readWorkflow()

  // 1) 真实工作流：tauri-action 的参数必须能展开成合法 argv。
  const { tauriScript, args } = extractTauriActionInputs(text)
  check(tauriScript !== null, 'release.yml：未找到 tauri-action 的 tauriScript 输入')
  check(args !== null, 'release.yml：未找到 tauri-action 的 args 输入')
  if (tauriScript !== null && args !== null) {
    const argv = simulateTauriActionArgv(tauriScript, args)
    const tokens = tauriScript.trim().split(/\s+/).filter(Boolean)
    const verdict = checkTauriArgv(argv, tokens)
    check(verdict.ok, `release.yml：tauri-action 命令行不合法 → ${verdict.problems.join('；')}（argv=${JSON.stringify(argv)}）`)
    check(argv.includes('--bundles'), 'release.yml：tauri-action 的 argv 未包含 --bundles')
  }

  // 2) 真实工作流：不得有「未加花括号的变量紧邻非 ASCII 字符」的写法。
  const hits = findUnbracedVarBeforeNonAscii(text)
  check(hits.length === 0, `release.yml：存在变量紧邻非 ASCII 字符的写法（macOS bash 3.2 会并入变量名）→ ${hits.map((h) => `L${h.line}: $${h.snippet}`).join('；')}`)

  // 3) 可伪证性：缺陷夹具必须被同一批判据判红，否则判据是装饰。
  const buggyScript = 'npm run tauri --'
  const buggyArgs = 'build --bundles nsis -v'
  const buggyArgv = simulateTauriActionArgv(buggyScript, buggyArgs)
  const buggyTokens = buggyScript.split(/\s+/).filter(Boolean)
  check(!checkTauriArgv(buggyArgv, buggyTokens).ok, '可伪证性：旧版 tauri-action 配置（tauriScript 带 -- + args 带 build）必须被判为不合法')
  check(buggyArgv.filter((t) => t === 'build').length === 2, '可伪证性：旧版配置应当展开出两个 build 才能复现事故')

  // 合法写法（本次修复后的形状）必须判绿，否则守卫会误报。
  const goodArgv = simulateTauriActionArgv('npm run tauri', '--bundles ${{ matrix.bundles }} -v')
  check(checkTauriArgv(goodArgv, ['npm', 'run', 'tauri']).ok, `可伪证性：修复后的写法必须判绿（argv=${JSON.stringify(goodArgv)}）`)

  const buggyNotes = 'echo "**首次发布**（$TAG）"'
  check(findUnbracedVarBeforeNonAscii(buggyNotes).length === 1, '可伪证性：`（$TAG）` 这种写法必须被命中')
  check(findUnbracedVarBeforeNonAscii('echo "v${TAG}x"').length === 0, '可伪证性：`${TAG}` 花括号写法不应被命中')
  check(findUnbracedVarBeforeNonAscii('# 注释里的 $TAG）不算').length === 0, '可伪证性：注释行不应被命中')

  // 4) 真实工作流：CLI 可引用产物的形状。
  const cli = checkCliArtifactShape(text)
  check(cli.ok, `release.yml：CLI 产物形状不合法 → ${cli.problems.join('；')}`)

  // 4a) 可伪证性：把每条判据各自打回缺陷写法，必须判红。
  const withoutClobber = text.replace(/(gh release upload[\s\S]{0,400}?) --clobber/, '$1')
  check(
    !checkCliArtifactShape(withoutClobber).ok,
    '可伪证性：去掉 --clobber 必须判红（否则重跑通道的缺陷拦不住）'
  )
  // 四类产物写在同一条 `for pattern in …` 行上，去掉其中一项即可证伪该条判据。
  // 2026-09-22 起 CLI 与 portable 产物共用同一行，因此夹具必须定向去掉
  // `dist/cli/...` 这一组，不能只去 `*.sha256`（portable 那组还在）。
  const withoutSidecar = text.replace(/'dist\/cli\/\*\.sha256' ?/g, '')
  check(!checkCliArtifactShape(withoutSidecar).ok, '可伪证性：不传 .sha256 边车必须判红')
  const withoutManifest = text.replace(/'dist\/cli\/\*\.manifest\.json' ?/g, '')
  check(!checkCliArtifactShape(withoutManifest).ok, '可伪证性：不传 manifest 必须判红')
  // 两条 2026-09-22 新增的反向/契约判据，同样要能被打回缺陷写法。
  const withoutMarker = text.replace(/missing-artifact-class: /g, '')
  check(
    !checkCliArtifactShape(withoutMarker).ok,
    '可伪证性：删掉 missing-artifact-class 标记必须判红（演练的豁免判据锚在它上面）'
  )
  const withoutLoopVar = text.replace(/\$\{pattern\} 下没有任何产物/g, '下没有任何产物')
  check(
    !checkCliArtifactShape(withoutLoopVar).ok,
    '可伪证性：标记里丢掉 ${pattern} 必须判红（否则豁免退化成「任何缺失都放行」）'
  )
  const classThenReasonGlued = text.replace(/\.json 下没有下载到/g, '.json下没有下载到')
  check(
    !checkCliArtifactShape(classThenReasonGlued).ok,
    '可伪证性：类名与说明之间少了空格必须判红（演练会把两者粘成一个类名）'
  )
  const withPortableTarGz = text.replace(
    /'dist\/portable\/\*\.zip'/,
    "'dist/portable/*.zip' 'dist/portable/*.tar.gz'"
  )
  check(
    !checkCliArtifactShape(withPortableTarGz).ok,
    '可伪证性：把不可能命中的 dist/portable/*.tar.gz 放回必需清单必须判红'
  )
  const withoutBuildNeed = text.replace(/needs: \[preflight, build, cli, portable\]/, 'needs: [preflight, cli, portable]')
  check(!checkCliArtifactShape(withoutBuildNeed).ok, '可伪证性：去掉 needs: build 必须判红')
  const withoutVerify = text.replace(/--verify-download/g, '--noop')
  check(!checkCliArtifactShape(withoutVerify).ok, '可伪证性：去掉下载后核验必须判红')
  const withoutPackage = text.replace(/npm run package:cli/g, 'echo skipped')
  check(!checkCliArtifactShape(withoutPackage).ok, '可伪证性：去掉打包步骤必须判红')

  // 5) 可伪证性：Release 正文段落改为「必须委托、不得内联」。
  const delegatedOnly = text.replace(/--release-notes/g, '--noop')
  check(!checkCliArtifactShape(delegatedOnly).ok, '可伪证性：不委托段落渲染必须判红')
  const withInline = `${text}\n          node - x <<'NODE'\n          console.log(1)\n          NODE\n`
  check(
    !checkCliArtifactShape(withInline).ok,
    '可伪证性：工作流里出现内联脚本（<<\'NODE\'）必须判红——YAML 内的脚本不可测'
  )
  check(inspectNotesStep(text).delegated, '真实工作流必须委托 package-cli.mjs 渲染段落')

  // 6) 按 job 切片本身要能被证伪：切不出块、或切错块都必须被察觉。
  check(jobBlock(text, 'cli-publish') !== null, 'jobBlock 必须能切出 cli-publish')
  check(jobBlock(text, 'cli-publish').includes('gh release upload'), '切出的 cli-publish 块必须含上传步骤')
  check(!jobBlock(text, 'cli-publish').includes('uses: tauri-apps/tauri-action'), '切出的 cli-publish 块不得混入 build job')
  check(jobBlock(text, 'no-such-job-xyz') === null, '不存在的 job 必须返回 null（而不是悄悄返回全文）')
  // 平台判据必须只看 cli job：把 cli 的平台去掉，即便 build 的矩阵里还有这些平台也要判红。
  const cliBlockStart = text.indexOf('cli:')
  const buildOnly = text.slice(0, cliBlockStart) + text.slice(text.indexOf('cli-publish:'))
  check(
    !checkCliArtifactShape(buildOnly).ok,
    '可伪证性：删掉 cli job 必须判红（平台齐全不能由 build 的矩阵冒充）'
  )
  // 6a) 上传图省事的写法必须判红：不设 nullglob、以及不做正文 null 归一。
  //     注意 `shopt -s nullglob` 在文件里出现两次（核验步骤与上传步骤各一次），
  //     夹具必须**全部**去掉——只去第一处时上传步骤仍然合规，断言会假红为「没判红」。
  const withoutNullglob = text.replace(/shopt -s nullglob\n/g, '')
  check(!checkCliArtifactShape(withoutNullglob).ok, '可伪证性：去掉 shopt -s nullglob 必须判红')
  const withoutBodyNorm = text.replace(/\.body \/\/ ""/, '.body')
  check(
    !checkCliArtifactShape(withoutBodyNorm).ok,
    '可伪证性：去掉正文 null 归一（.body // ""）必须判红'
  )
  check(
    !checkCliArtifactShape(text.replace(/needs: \[preflight, build, cli, portable\]/, 'needs: [preflight, build, portable]')).ok,
    '可伪证性：needs 里去掉 cli 必须判红'
  )

  // 7) 判据必须与检出配置无关（AGENTS §7.3）：同一份工作流换成 CRLF 也须得出同样结论。
  //    缺了这条，上面那些按行切分/替换的断言会在 CRLF 检出下悄悄失效——
  //    「本地绿、CI 红」按平台随机出现，而根因在行尾。
  //
  //    夹具从**原始字节**造：先归一到 LF 再转成 CRLF，这样无论本机检出是哪种行尾，
  //    拿到的都是一份确定的 CRLF 文本（直接在可能已是 CRLF 的读入结果上替换
  //    `\n` → `\r\n` 会得到 `\r\r\n`，那种畸形文本证明不了任何事）。
  const crlf = readFileSync(RELEASE_YML, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
  check(
    checkCliArtifactShape(crlf.replace(/\r\n/g, '\n')).ok === checkCliArtifactShape(text).ok,
    '可伪证性：归一化行尾后判定必须一致（判据不得依赖检出配置）'
  )
  check(
    !checkCliArtifactShape(crlf.replace(/\r\n/g, '\n').replace(/shopt -s nullglob\n/g, '')).ok,
    '可伪证性：CRLF 检出下去掉 nullglob 同样必须判红'
  )

  // 8) 真实工作流：双通道发布形状（tag 后缀 → 构建目标、prerelease 标记）。
  const dual = checkDualChannelShape(text)
  check(dual.ok, `release.yml：双通道形状不合法 → ${dual.problems.join('；')}`)

  // 8a) 可伪证性：把每条判据各自打回缺陷写法，必须判红。
  check(
    !checkDualChannelShape(text.replace(/dsh_target:.*\n/, '')).ok,
    '可伪证性：preflight 不暴露 dsh_target 必须判红（否则 build 只能落回默认目标）'
  )
  check(
    !checkDualChannelShape(text.replace(/dsh-targets\.mjs --channel-of/, 'echo next')).ok,
    '可伪证性：不用 dsh-targets.mjs 推导通道必须判红（两套映射必然漂移）'
  )
  // 可证伪性：**真实炸过的**写法——把 env 传值换成 run 内插值。
  // Windows runner（PowerShell）上它把值丢掉，只有 Windows 的 job 红。
  // 夹具要把 env 传值那一行去掉、换成插值写法（只换 run 会留下 env，判据仍绿）。
  //
  // 2026-09-22 起 DSH_TARGET 放在 job 级别 env（被子进程继承），因此夹具要
  // 匹配 job 级别的 `env:` 块，而不是 step 级别的。
  const interpolated = text.replace(
    /env:\n\s*DSH_TARGET: \$\{\{ needs\.preflight\.outputs\.dsh_target \}\}[\s\S]*?\n(\s*)run: npm run prepare:harness/,
    '$1run: npm run prepare:harness -- --dsh-target="${{ needs.preflight.outputs.dsh_target }}"'
  )
  check(
    !checkDualChannelShape(interpolated).ok,
    '可伪证性：把 env 传值换成 run 内插值必须判红（Windows PowerShell 会丢掉它）'
  )
  check(
    findInterpolatedTargetArg(interpolated).length > 0,
    '可伪证性：插值写法必须同时被 findInterpolatedTargetArg 命中'
  )
  check(
    /Prepare harness resources[\s\S]{0,200}env:/.test(text) ||
      /env:\n\s*DSH_TARGET: \$\{\{ needs\.preflight\.outputs\.dsh_target \}\}/.test(text),
    '真实工作流：组装步骤必须用 env 传 DSH_TARGET'
  )

  // 9) tauri 的构建钩子必须是 `--check`（只校验），否则会在 tauri 内部按默认目标
  //    重新组装、覆盖另一条通道刚组好的树。
  const tauriConf = readFileSync(TAURI_CONF, 'utf8')
  const hooks = checkTauriHooksAreCheckOnly(tauriConf)
  check(hooks.ok, `tauri.conf.json：构建钩子必须是只校验 → ${hooks.problems.join('；')}`)

  // 9a) 可伪证性：打回旧写法（会重新组装）必须判红。
  check(
    !checkTauriHooksAreCheckOnly(
      tauriConf.replace(/npm run prepare:harness -- --check/g, 'npm run prepare:harness')
    ).ok,
    '可伪证性：构建钩子写成会重新组装的形状必须判红（会覆盖另一条通道的树）'
  )
  // 9b) 反向：没有 prepare:harness 的钩子不该被判红（判据只针对这条命令）。
  check(checkTauriHooksAreCheckOnly('{"build":{"beforeBuildCommand":"echo hi"}}').ok, '可伪证性：无关命令不应被命中')
  // 可证伪性：检查器必须能认出插值写法本身。
  check(
    findInterpolatedTargetArg('        run: npm run prepare:harness -- --dsh-target="${{ inputs.x }}"').length === 1,
    '可伪证性：findInterpolatedTargetArg 必须能命中 --dsh-target 插值写法'
  )
  check(
    findInterpolatedTargetArg('        run: npm run prepare:harness').length === 0,
    '可伪证性：不带 --dsh-target 的写法不应被命中'
  )
  check(
    !checkDualChannelShape(
      text.replace(/prerelease: \$\{\{ needs\.preflight\.outputs\.prerelease == 'true' \}\}/, 'prerelease: false')
    ).ok,
    '可伪证性：prerelease 硬编码必须判红（预发布会污染 stable 更新链路）'
  )

  if (failures.length > 0) {
    throw new Error(`发布工作流守卫失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`)
  }
  return { passed }
}

function run() {
  const text = readWorkflow()
  const { tauriScript, args } = extractTauriActionInputs(text)
  const argv = simulateTauriActionArgv(tauriScript ?? '', args ?? '')
  const tokens = String(tauriScript ?? '').trim().split(/\s+/).filter(Boolean)
  const { ok, problems } = checkTauriArgv(argv, tokens)
  const hits = findUnbracedVarBeforeNonAscii(text)

  if (!ok) {
    for (const p of problems) console.error(`  ✗ tauri-action：${p}`)
  } else {
    console.log(`✅ tauri-action argv 合法：npm ${argv.join(' ')}`)
  }
  if (hits.length > 0) {
    for (const h of hits) console.error(`  ✗ release.yml L${h.line}：变量 $${h.snippet} 紧邻非 ASCII 字符`)
  } else {
    console.log('✅ release.yml 无「变量紧邻非 ASCII 字符」写法')
  }
  if (!ok || hits.length > 0) process.exit(1)
}

const isDirectRun = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1])
  } catch {
    return false
  }
})()

if (isDirectRun) {
  if (process.argv.includes('--self-test')) {
    try {
      const { passed } = selfTest()
      console.log(`✅ 发布工作流守卫自测通过（${passed} 项）`)
    } catch (error) {
      console.error(error.message)
      process.exit(1)
    }
  } else {
    run()
  }
}
