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
const WORKFLOW_DIR = join(projectRoot, '.github', 'workflows')
const RELEASE_YML = join(WORKFLOW_DIR, 'release.yml')
const TAURI_CONF = join(projectRoot, 'src-tauri', 'tauri.conf.json')
// 工作区清单：CLI crate 必须保留的判据住在**工作区**里而不是 workflow 里——
// 「取消发布」不该顺手把 INV-6 的兑现载体一起删掉，那个决定与发布无关。
const CARGO_TOML = join(projectRoot, 'Cargo.toml')

/**
 * 需要跑「shell 可移植性」检查的工作流。
 *
 * **三个都要查**，不能只查 release.yml：这个坑与「是哪个工作流」无关，只与
 * 「步骤用了 bash 语法、却可能跑在 Windows 的默认 PowerShell 下」有关。
 * release.yml 已经出过一次；ci.yml / smoke.yml 里那几步只是**暂时**安全
 * （它们恰好都带 `if: runner.os == 'Linux'`），谁把门禁一改就会变成同一类故障。
 */
const WORKFLOW_FILES = ['ci.yml', 'release.yml', 'smoke.yml']

/**
 * CLI 产物的上传路径——**退役通道的核心断言**。
 *
 * 匹配 `dist/cli` 作为路径段出现（`dist/cli/*`、`./dist/cli/foo`），
 * 但不匹配 `dist/cli-x` 这类「恰好以 cli 开头」的名字（避免误判）。
 */
const CLI_UPLOAD_PATH = /(?:^|[\s"'])\.?\/?dist\/cli(?:\/|\s|$|")/

/**
 * 便携版产物的上传路径——**必须存在**（F13：期望资产 13 含这 3 个）。
 *
 * `package-portable.mjs` 的 `--out dist/portable` 决定了这个位置。
 */
const PORTABLE_UPLOAD_PATH = /(?:^|[\s"'])\.?\/?dist\/portable\/\*/

/**
 * 取出 `gh release upload` 的**可执行命令行**。
 *
 * 只在**剥掉整行注释后**的文本上取，且只取以可执行指令开头的行
 * （`- run:` / `run:` 之后的裸命令，以及多行 `run: |` 块内的命令）。
 *
 * 为什么必须逐行而不是全文正则：本仓已两次踩到「退役说明里逐字引用了
 * `gh release upload` 来交代删掉了什么，而判据扫全文 → 守卫被自己的文档命中」。
 * 取「宾语」的判据更需要精确到行——否则无法区分「上传了 cli」与「注释里说
 * 曾上传 cli」。
 *
 * @param {string} code 已剥注释的工作流文本
 * @returns {string[]} 命令行数组（保留原缩进与引号，便于报错时回显）
 */
function uploadCommandLines(code) {
  return code
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      // 只认「命令就是 gh release upload …」的行；YAML 键行（`run: |`）不是命令。
      return /^gh\s+release\s+upload\b/.test(trimmed) || /^-\s*run:\s*gh\s+release\s+upload\b/.test(trimmed)
    })
}

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
 * 读入任意工作流并归一化行尾（理由同 `readWorkflow`）。
 *
 * @param {string} name 工作流文件名，如 `ci.yml`
 * @returns {string} 归一化后的文本
 */
function readWorkflowFile(name) {
  return readFileSync(join(WORKFLOW_DIR, name), 'utf8').replace(/\r\n/g, '\n')
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
 * 这里刻意**不再**去解析/执行 heredoc 内联脚本：那段逻辑曾搬进
 * `scripts/package-cli.mjs`（`--release-notes`），其渲染与幂等性由
 * `npm run verify:cli-package` 的自测覆盖。留在 YAML 里的内联脚本是**不可测**的
 * ——YAML 解析器不碰 `run: |` 的内容，语法错 / argv 下标错只有真发布才炸，
 * 而发布不可逆。因此本守卫判「有没有内联脚本残留」。
 *
 * ⚠️ 2026-09-24：CLI 发布通道退役后，`--release-notes` 的**唯一消费者**（`cli-publish`
 * 的正文渲染步骤）已删除，因此 `delegated` 不再可能为真，`checkCliArtifactShape`
 * 不再据它判红。本函数保留只为一件事：`inlineHeredoc` 那条判据与发布通道无关
 * （任何写进 YAML 的脚本都不可测），继续有效。`delegated` 字段保留供将来有新的
 * 正文段落时复用，但**不要**在退役状态下断言它必须为真——那会让整个守卫恒红。
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
 * 剥掉 YAML 的整行注释，只留可执行文本。
 *
 * ## 为什么必须有这一步
 *
 * 本仓的注释习惯是把**坏写法**引在注释里说明缺陷（`release.yml` 的退役说明就
 * 逐字写了 `gh release upload` 来交代删掉了什么）。判据若扫全文，会被自己的
 * 文档命中而**恒红**——退役说明一写上去，守卫当场误报。
 *
 * 这个坑在本仓出现过两次，都是同一形状：
 *   · `checkCliArtifactShape` 的「不可能命中的模式」判据第一次落地就被自己的注释命中；
 *   · 2026-09-24 退役说明里的 `gh release upload` 命中「不得有上传动作」判据。
 * 前一次改成了「只在 `for pattern in …` 语句里扫」。这里更彻底：一律先剥注释。
 *
 * ## 边界的诚实说明
 *
 * 只剥**整行注释**（行首可选空白 + `#`），不处理行尾 `# …`——YAML 里行尾注释
 * 出现于引号内的可能性无法用正则区分（`name: "a # b"`）。本函数的消费者都是
 * 「某个动作是否出现」的判据，而 YAML 的 `run:` 块注释本来就是整行，因此够用。
 * 若将来要判的文本可能把动作写进行尾注释，必须改成真正的 YAML 解析。
 *
 * @param {string} text 工作流全文
 * @returns {string} 剥掉整行注释后的文本
 */
export function stripYamlComments(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

/**
 * CLI 可引用产物**发布通道已退役**的形状判据（2026-09-24 起，方向反转）。
 *
 * ## 为什么方向反转
 *
 * 原判据断言 `cli` / `cli-publish` 两个 job **存在且形状正确**。退役的依据是
 * 「零外部消费者 + 产物不自足」，逐条实测见
 * [`docs/dev-plan-cli-distribution.md`](../docs/dev-plan-cli-distribution.md) §5：
 *
 *   · **零外部消费者**：三个消费者（`smoke-launch.mjs` / `fault-inject.mjs` /
 *     `cli_blackbox.rs`）全部使用 `target/debug/` 的本地构建，与上传产物零交集；
 *   · **产物不自足**：归档不含 runtime，`start` 必然退出码 3，对「已装桌面的用户」
 *     无增量价值（他们本地就有 resources），对第三方又跑不起来；
 *   · **定位不依赖产物**：INV-6 靠「存在一个能跑二进制的入口」，不靠「挂在 Release 上」。
 *
 * ## 为什么仍然要有判据（而不是直接删掉这个函数）
 *
 * 「取消发布」是一个**有意的决定**，不是遗漏。没有守卫的话，两个方向都会静默退化：
 *   · 有人（或某次从旧分支合并）把 `cli-publish` job 加回来 —— 发布链路悄悄复活，
 *     而它已被判定为不必要，白烧三台 runner 与一轮上传核验；
 *   · 有人以为「顺手把 crate 也删了吧」—— `dsh-host-cli` crate 是**必须保留**的，
 *     它是 INV-6 的兑现载体、两个硬门禁的依赖、`verify:claims` 的对照对象。
 *     见 {@link checkCliCrateRetained}。
 *
 * 因此判据改为**双向**：发布 job 必须缺席，而 crate 与打包器必须仍在。
 * 单边判据（只查缺席）会让「误删 crate」畅通无阻。
 *
 * ### 第 2 条判据的三向修订（2026-09-24）
 *
 * 第 2 条原为「`gh release upload` 一概不得出现」。它在 F13（便携版不上传）
 * 修复时变成硬阻塞——**便携版必须靠这个动作上传**。修订为按**宾语**判：
 *
 * | 方向 | 宾语 | 判定 |
 * |---|---|---|
 * | 禁 | `dist/cli/*` | 🔴 判红（CLI 退役的核心断言） |
 * | 准 | `dist/portable/*` | ✅ 放行（期望资产 13 含它） |
 * | 必须 | 至少一条 `dist/portable/*` | 🔴 缺失即判红（否则资产掉到 10，F13 复现） |
 *
 * 这样「守 CLI 不复活」与「修好便携版发布」两个目标**同时成立**，
 * 而不是互相否决。⚠️ 判据取自 {@link uploadCommandLines}——只看**可执行行**，
 * 不看注释，理由同 {@link stripYamlComments}。
 *
 * ⚠️ 所有「不得出现」的判据都在 {@link stripYamlComments} 之后的文本上跑——
 * 否则退役说明里引用的 `gh release upload` 会让守卫恒红（实测踩到）。
 *
 * @param {string} text release.yml 全文
 * @returns {{ok: boolean, problems: string[]}} 判定与问题清单
 */
export function checkCliArtifactShape(text) {
  const problems = []
  const code = stripYamlComments(text)

  // 1) 上传通道必须缺席。逐个 job 判，而不是查 `cli` 这个子串——`cli-publish`
  //    里也含 `cli`，用子串判会让两个 job 的缺席互相掩盖。
  for (const job of ['cli', 'cli-publish']) {
    if (jobBlock(code, job)) {
      problems.push(
        `\`${job}\` job 又出现了——CLI 发布通道已于 2026-09-24 退役` +
          '（零外部消费者 + 产物不含 runtime 不自足）。' +
          '若确有外部消费者出现，应先按 ADR-045 恢复决策、再连同守卫一起改回来，' +
          '不要让它在没人注意时复活'
      )
    }
  }

  // 2) 产物上传动作：**三向判据**（2026-09-24 修订，原为「一概禁止」）。
  //
  //    原判据是 `if (/gh release upload/) problems.push(…)`。它在 F13 修复时变成
  //    硬阻塞：便携版（3 个 zip + `.sha256`）**必须**挂到 Release 上，而唯一可行的
  //    实现就是 `gh release upload`。于是「守住 CLI 不复活」与「修好便携版发布」
  //    两个正当目标直接打架——原判据分不清「上传便携版」（要的）与
  //    「上传 CLI」（不要的）。
  //
  //    改法的关键：**不禁止动作本身，而是限制它的宾语**。
  //      · 准许：`dist/portable/*`（便携版是发布资产的一部分，期望资产 13 含它）
  //      · 禁止：`dist/cli/*`（CLI 退役的核心断言，别被放宽的口子漏过去）
  //
  //    ⚠️ 判据必须**逐条命令**看宾语，不能只看「文件里有没有出现 dist/cli」——
  //    后者会被注释/文档里的说明命中（本仓已两次踩到这个坑，见 {@link stripYamlComments}）。
  for (const line of uploadCommandLines(code)) {
    if (CLI_UPLOAD_PATH.test(line)) {
      problems.push(
        `release.yml 里仍有把 CLI 产物上传到 Release 的动作：\`${line.trim()}\`\n` +
          '（CLI 发布通道已于 2026-09-24 退役：零外部消费者 + 产物不含 runtime 不自足）'
      )
    }
  }
  // 反向：便携版上传路径**必须存在**，否则资产数是 10 而不是 13（F13）。
  // 这一条与上面的「禁 dist/cli」方向相反，两者必须能同时为真。
  if (uploadCommandLines(code).length === 0) {
    problems.push(
      'release.yml 里没有任何 `gh release upload`——便携版（3 个资产）无法挂到 Release 上，' +
        '期望资产数会从 13 掉到 10（F13）。上传宾语必须是 `dist/portable/*`'
    )
  } else if (!uploadCommandLines(code).some((line) => PORTABLE_UPLOAD_PATH.test(line))) {
    problems.push(
      'release.yml 里的 `gh release upload` 没有一条指向 `dist/portable/*`——' +
        '便携版的三个资产（zip + .sha256 + manifest）没有加进 Release（F13）'
    )
  }

  // 3) 打包器必须仍在被 preflight 调用。取消的是**上传**，不是**打包能力**：
  //    `package-cli.mjs` 的判据（归档丢可执行位、边车格式、篡改可证伪）与上传无关，
  //    属于 ADR-031「可证伪守卫」这一项目核心资产，删掉等于削掉可跑的能力证据。
  const preflight = jobBlock(code, 'preflight')
  if (!preflight) {
    problems.push('没有 `preflight` job——退役后它仍须跑静态门禁')
  } else if (!/npm run verify:cli-package/.test(preflight)) {
    problems.push(
      '`preflight` 里没有 `npm run verify:cli-package`——打包器的判据与上传无关，' +
        '退役的是上传通道，不是打包能力的验证（取消它等于静默丢掉一批可证伪断言）'
    )
  }

  // 4) YAML 里不得有内联脚本——发布工作流不可测的脚本只有真发布才炸，而发布不可逆
  //    （原判据精神，保留有效；与退役无关）。
  if (/<<'NODE'/.test(code)) {
    problems.push("release.yml 里残留内联脚本（<<'NODE'）——YAML 内的脚本不可测，应移入有自测的脚本")
  }
  return { ok: problems.length === 0, problems }
}

/**
 * CLI **crate** 必须保留（与发布通道退役是两件事）。
 *
 * 退役的是「把二进制挂到 Release 上」，不是「存在一个能跑二进制的入口」。
 * `dsh-host-cli` 是 INV-6（无 GUI 核心库）的兑现载体：没有它，「主链路能在
 * 命令行独立复现」就只是一句话。它同时是 `smoke-launch.mjs`（L1/L2 冒烟）与
 * `fault-inject.mjs`（三平台孤儿清理硬门禁）的依赖。
 *
 * 判据住在**工作区内**（`Cargo.toml` 的 members）而不是 workflow 里——因为
 * 这个决定与发布无关，却会被「取消发布」这件事顺手牵连。
 *
 * @param {string} workspaceCargo Cargo.toml 全文
 * @param {string} scriptsSmoke smoke-launch.mjs 全文
 * @param {string} scriptsFault fault-inject.mjs 全文
 * @returns {{ok: boolean, problems: string[]}} 判定与问题清单
 */
export function checkCliCrateRetained(workspaceCargo, scriptsSmoke, scriptsFault) {
  const problems = []

  if (!/"crates\/dsh-host-cli"/.test(workspaceCargo)) {
    problems.push(
      '`crates/dsh-host-cli` 不在 workspace members 里——CLI **crate** 必须保留：' +
        '它是 INV-6 的兑现载体，且 smoke / fault-inject 两个门禁依赖它。' +
        '退役的只是「上传到 Release」，不是这个 crate'
    )
  }
  if (!/cargo build -p dsh-host-cli/.test(scriptsSmoke)) {
    problems.push('`smoke-launch.mjs` 不再构建 dsh-host-cli——L1/L2 冒烟会失去无 GUI 手柄')
  }
  if (!/dsh-host-cli/.test(scriptsFault)) {
    problems.push('`fault-inject.mjs` 不再引用 dsh-host-cli——孤儿清理硬门禁会失去执行载体')
  }
  // 内部消费者必须走 `target/debug`（本地构建），这是「与上传产物零交集」的实证。
  // 一旦有人把它改成去下载发布产物，退役决策的前提就被推翻了，必须当场暴露。
  for (const [label, text] of [
    ['smoke-launch.mjs', scriptsSmoke],
    ['fault-inject.mjs', scriptsFault]
  ]) {
    if (!/'target',\s*\n?\s*'debug'|'target', 'debug'|\/target\/debug\//.test(text)) {
      problems.push(`${label} 不再从 target/debug 取 CLI 二进制——内部消费者与发布产物零交集是退役决策的前提`)
    }
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
 * 找出「用了 POSIX 反斜杠续行、却没声明 `shell: bash`」的步骤。
 *
 * ## 为什么这是必查项，而不是风格偏好
 *
 * `windows-latest` 的默认 shell 是 **PowerShell**，而 `\` **不是** PowerShell 的续行符
 * （它用反引号）。于是 `run: |` 里这种在 bash 下完全正常的写法：
 *
 * ```yaml
 * node scripts/package-portable.mjs \
 *   --bundle-dir target/release \
 * ```
 *
 * 在 PowerShell 下会把第二行开头的 `--bundle-dir` 解析成**自减运算符**，整段脚本在
 * **解析阶段**就死（`ParserError: Missing expression after unary operator '--'`），
 * 一秒都没真正跑起来。而同一段文本在 ubuntu/macos 上因为默认就是 bash 而完全正常——
 * 于是缺陷**只在 Windows 上现形**。
 *
 * 2026-09-22 `v0.7.0-alpha.4` 的真实事故：portable job 编译了 13m40s，最后死在打包步骤的
 * 第 1 秒，且 `cli-publish` 因 `needs: portable` 被跳过——三个平台**已经成功构建**的
 * CLI 产物因此一个都没上传。此前一直没暴露，是因为更早的失败（缺签名私钥）总在编译
 * 前/中就把它拦住了：**这一步在事故前从未被执行过**。
 *
 * ## 为什么判据可以要求「一律显式声明」
 *
 * 本仓其余多行 bash 步骤（apt-get / curl / printf 等）**都**写了 `shell: bash`，
 * 只有出事那处漏了。要求一律显式声明，是把「依赖 runner 默认 shell」这个**隐性假设**
 * 变成看得见的事实——将来谁把某个 job 挪到 Windows、或给矩阵加一行 Windows，
 * 都不会再因为「默认 shell 恰好是 bash」而埋雷。
 *
 * 对现有步骤是**无副作用**的：剩下那几处全是 Linux 门禁下的**无管道**命令，
 * 显式 `shell: bash` 与默认 bash 的唯一差别是多带 `-o pipefail`，而无管道时该差异
 * 不产生任何行为变化。
 *
 * ## 实现
 *
 * 纯文本 + 缩进切块（本仓不依赖 YAML 解析器）：`steps:` 的缩进决定步骤项缩进
 * （+2），每个 `- ` 项到下一个同级项之间算一个步骤块；块内出现反斜杠续行、
 * 且块内没有 `shell: bash`，即判红。
 *
 * ⚠️ 判据**不看 `runs-on`、也不看 `if:`**：故意如此。靠 `if: runner.os == 'Linux'`
 * 推理「所以安全」正是这个缺陷能潜伏至今的原因——判据一旦要跟着门禁走，
 * 门禁一改就悄悄失效。
 *
 * @param {string} text 工作流 YAML 全文（应已把 CRLF 规范成 LF）
 * @param {string} [label] 报错定位用的文件名
 * @returns {string[]} 问题清单（空数组表示通过）
 */
export function shellContinuationProblems(text, label = 'workflow.yml') {
  const lines = text.split('\n')
  const problems = []
  const CONTINUATION = /\\[ \t]*$/

  // 1) 按 `steps:` 的缩进，切出每个步骤块 [start, end)。
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    const header = /^(\s*)steps:\s*$/.exec(lines[i])
    if (!header) continue
    const stepsIndent = header[1].length
    const itemRe = new RegExp(`^ {${stepsIndent + 2}}-\\s`)
    let start = null
    let j = i + 1
    for (; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === '') continue
      if (/^\s*/.exec(line)[0].length <= stepsIndent) break
      if (!itemRe.test(line)) continue
      if (start !== null) blocks.push([start, j])
      start = j
    }
    if (start !== null) blocks.push([start, j])
    i = j - 1
  }

  // 2) 逐块判定：有续行、且没有显式 `shell: bash` → 判红。
  for (const [start, end] of blocks) {
    const chunk = lines.slice(start, end)
    const first = chunk.findIndex((line) => CONTINUATION.test(line))
    if (first === -1) continue
    if (chunk.some((line) => /^\s*shell:\s*bash\s*$/.test(line))) continue
    const name = chunk[0].replace(/^\s*-\s*/, '').replace(/^name:\s*/, '').trim() || '(未命名步骤)'
    problems.push(
      `${label} L${start + first + 1}：步骤「${name}」用了 POSIX 反斜杠续行，却没声明 \`shell: bash\`——` +
        '在 windows-latest 的默认 PowerShell 下会被解析成自减运算符，脚本在解析阶段即失败'
    )
  }

  return problems
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

  // 2b) 三个真实工作流：用了 bash 反斜杠续行的步骤必须显式声明 `shell: bash`。
  for (const file of WORKFLOW_FILES) {
    const shellProblems = shellContinuationProblems(readWorkflowFile(file), file)
    check(shellProblems.length === 0, `shell 可移植性：${shellProblems.join('；')}`)
  }

  // 2c) 可伪证性：两条必须**同时**成立——只验「判红」的话，一条永远返回问题的
  //     判据也能通过，那等于没有判据。
  const continuationFixture = (withShell) =>
    [
      'jobs:',
      '  demo:',
      '    runs-on: windows-latest',
      '    steps:',
      '      - name: 夹具',
      ...(withShell ? ['        shell: bash'] : []),
      '        run: |',
      '          node a.mjs \\',
      '            --flag x'
    ].join('\n')
  const badFixture = shellContinuationProblems(continuationFixture(false), 'fixture.yml')
  const goodFixture = shellContinuationProblems(continuationFixture(true), 'fixture.yml')
  check(badFixture.length === 1, `可伪证性：续行且缺 shell: bash 的步骤必须判红（实得 ${badFixture.length} 条）`)
  check(goodFixture.length === 0, `可伪证性：同一夹具补上 shell: bash 后必须转绿（实得 ${goodFixture.length} 条）`)

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

  // 4) 真实工作流：CLI 发布通道**已退役**，不得复活。
  const cli = checkCliArtifactShape(text)
  check(cli.ok, `release.yml：CLI 退役形状不合法 → ${cli.problems.join('；')}`)

  // 4a) 可伪证性：**两个方向都要验**。只验「缺陷写法必须判红」的话，一条永远
  //     返回问题的判据也能通过；只验「真实文件必须判绿」的话，把 job 加回来
  //     也拦不住。退役类判据的方向是「不得出现」，因此夹具必须证明
  //     「把它加回来会立刻变红」。
  for (const job of ['cli', 'cli-publish']) {
    const revived = `${text}\n  ${job}:\n    runs-on: ubuntu-latest\n    steps: []\n`
    check(
      !checkCliArtifactShape(revived).ok,
      `可伪证性：把 \`${job}\` job 加回来必须判红（否则发布通道会静默复活）`
    )
  }
  // 反向：`cli` 这个子串在 `cli-publish` 里也出现，说明必须按 job 切片判，
  // 用子串判会让两个 job 的缺席互相掩盖。
  check(
    !checkCliArtifactShape(`${text}\n  cli-publish:\n    runs-on: ubuntu-latest\n`).ok,
    '可伪证性：只加回 cli-publish 也必须判红（子串匹配会让它被 cli 掩盖）'
  )
  // 上传动作：按**宾语**判（2026-09-24 三向修订，见 checkCliArtifactShape 文档）。
  //
  // ⚠️ 夹具写法有两条硬要求，缺一条就变成「自测喂了被测遇不到的输入」：
  //   1. **形状要真**：`release.yml` 里的上传是 `run: |` 块内的裸命令行
  //      （`          gh release upload "${TAG}" dist/portable/* --clobber`），
  //      不是 `- run: gh release upload …` 单行。
  //   2. **基线要全**：夹具必须基于**真实的 `text`**（含 `preflight` job），
  //      只把上传那段换掉。从零合成的夹具会让「没有 preflight」这类**无关判据**
  //      跟着红，把待验判据的结论淹没——实测踩到过。
  const uploadProbe = (body) =>
    checkCliArtifactShape(
      text.replace(/\n\s*gh release upload[^\n]*\n/, `\n${body}\n`)
    )

  check(
    uploadProbe('          gh release upload "$TAG" dist/cli/*').problems.some((p) => /CLI 产物上传/.test(p)),
    '可伪证性：上传 dist/cli/* 必须判红（CLI 退役的核心断言）'
  )
  check(
    uploadProbe('          gh release upload "$TAG" ./dist/cli/dsh.tar.gz').problems.some((p) =>
      /CLI 产物上传/.test(p)
    ),
    '可伪证性：用相对路径 ./dist/cli/... 也判红（宾语判据不得只看字面 dist/cli）'
  )
  check(
    uploadProbe('          gh release upload "$TAG" dist/portable/*').problems.length === 0,
    '可伪证性：上传 dist/portable/* 必须完全放行（这是 F13 修复的正当动作）'
  )
  // 反向：把上传整段换成无关命令 → 判红（资产会掉到 10）。
  check(
    uploadProbe('          echo no upload here').problems.some((p) => /没有任何 `gh release upload`/.test(p)),
    '可伪证性：没有任何上传动作必须判红（否则资产静默掉到 10，F13 复现）'
  )
  // 宾语不是 portable → 判红（传了，但传的不是便携版）。
  check(
    uploadProbe('          gh release upload "$TAG" dist/other/*').problems.some((p) =>
      /没有一条指向 `dist\/portable\/\*`/.test(p)
    ),
    '可伪证性：上传宾语不是 dist/portable/* 必须判红（传了，但传的不是便携版）'
  )
  // 打包器必须仍在 preflight 里：退役的是上传，不是打包能力的验证。
  check(
    !checkCliArtifactShape(text.replace(/npm run verify:cli-package/g, 'echo skipped')).ok,
    '可伪证性：从 preflight 摘掉 verify:cli-package 必须判红（打包判据与上传无关，不该一起丢）'
  )
  // 内联脚本判据与发布通道无关，保留有效。
  const withInline = `${text}\n          node - x <<'NODE'\n          console.log(1)\n          NODE\n`
  check(
    !checkCliArtifactShape(withInline).ok,
    '可伪证性：工作流里出现内联脚本（<<\'NODE\'）必须判红——YAML 内的脚本不可测'
  )
  // 4aa) 🔴 可伪证性（真实踩过）：退役说明**逐字引用了** `gh release upload` 来交代
  //      删掉了什么，而判据扫全文 → 守卫被自己的文档命中，恒红。
  //      两条互补断言：注释里的引用必须放行，可执行位置的同一串必须判红。
  //      只验后者的话，「把判据删掉」也能让前者通过。
  check(
    checkCliArtifactShape(`${text}\n  # 退役说明：删掉了 gh release upload 与 cli-publish\n`).ok,
    '可伪证性：注释里引用 gh release upload 必须放行（否则退役说明会让守卫恒红）'
  )
  check(
    !checkCliArtifactShape(`jobs:\n  demo:\n    steps:\n      - name: 夹具\n        run: |\n          gh release upload "$TAG" dist/cli/*\n`).ok,
    '可伪证性：可执行位置的 gh release upload dist/cli 仍必须判红（剥注释不得把判据一起剥掉）'
  )
  // 同理，job 名出现在注释里不得被判为「job 复活」。
  check(
    checkCliArtifactShape(`${text}\n  # 历史上曾有 cli-publish: 这个 job，已于 2026-09-24 删除\n`).ok,
    '可伪证性：注释里提到 cli-publish: 必须放行'
  )
  // stripYamlComments 本身的两向断言：剥掉整行注释、保留正文与缩进。
  check(
    stripYamlComments(['  # x', '    run: y', ''].join('\n')) === '    run: y\n',
    'stripYamlComments 必须只剥整行注释、保留缩进与正文'
  )
  check(
    stripYamlComments(['run: "a # b"', ''].join('\n')) === 'run: "a # b"\n',
    'stripYamlComments 不得吞掉引号内的 # （只剥行首注释）'
  )
  // 退役后 `--release-notes` 无消费者，因此不得再要求它存在（否则守卫恒红）。
  check(
    checkCliArtifactShape(text).ok && !inspectNotesStep(text).delegated,
    '退役状态下不得再断言 `--release-notes` 必须存在（它随 cli-publish 一起删了）'
  )

  // 4b) CLI **crate** 必须保留——与发布通道退役是两件事。
  const workspaceCargo = readFileSync(CARGO_TOML, 'utf8')
  const smokeScript = readFileSync(join(projectRoot, 'scripts', 'smoke-launch.mjs'), 'utf8')
  const faultScript = readFileSync(join(projectRoot, 'scripts', 'fault-inject.mjs'), 'utf8')
  const kept = checkCliCrateRetained(workspaceCargo, smokeScript, faultScript)
  check(kept.ok, `CLI crate 保留判据不合法 → ${kept.problems.join('；')}`)
  // 可伪证性：误删 crate 的三个方向各自都要判红——否则「取消发布」会顺手把
  // 定位载体一起删掉，而没有任何东西会拦。
  check(
    !checkCliCrateRetained(workspaceCargo.replace(/\s*"crates\/dsh-host-cli",?/, ''), smokeScript, faultScript).ok,
    '可伪证性：把 dsh-host-cli 从 workspace members 摘掉必须判红'
  )
  check(
    !checkCliCrateRetained(workspaceCargo, smokeScript.replace(/cargo build -p dsh-host-cli/g, 'echo skip'), faultScript).ok,
    '可伪证性：smoke 不再构建 CLI 必须判红'
  )
  check(
    !checkCliCrateRetained(workspaceCargo, smokeScript, faultScript.replace(/dsh-host-cli/g, 'something-else')).ok,
    '可伪证性：fault-inject 不再引用 CLI 必须判红'
  )
  // 内部消费者必须走 target/debug —— 这是「与发布产物零交集」这个退役前提的实证。
  check(
    !checkCliCrateRetained(workspaceCargo, smokeScript.replace(/'target',\s*\n\s*'debug'/, "'downloads'"), faultScript).ok,
    '可伪证性：smoke 改为从下载产物取 CLI 必须判红（退役前提被推翻）'
  )

  // 5) 按 job 切片本身要能被证伪：切不出块、或切错块都必须被察觉。
  check(jobBlock(text, 'build') !== null, 'jobBlock 必须能切出 build')
  check(jobBlock(text, 'build').includes('tauri-apps/tauri-action'), '切出的 build 块必须含 tauri-action')
  check(!jobBlock(text, 'build').includes('gh release upload'), '切出的 build 块不得混入 cli-publish 的上传步骤')
  check(jobBlock(text, 'no-such-job-xyz') === null, '不存在的 job 必须返回 null（而不是悄悄返回全文）')

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

  // 3) 全部工作流：bash 语法步骤必须显式声明 shell，否则在 Windows 上会被 PowerShell 解析失败。
  const shellProblems = WORKFLOW_FILES.flatMap((file) => shellContinuationProblems(readWorkflowFile(file), file))
  if (shellProblems.length > 0) {
    for (const p of shellProblems) console.error(`  ✗ ${p}`)
  } else {
    console.log(`✅ 三个工作流的 bash 续行步骤都显式声明了 shell: bash（${WORKFLOW_FILES.join(' / ')}）`)
  }

  // 4) CLI 发布通道已退役（2026-09-24）：不得复活，且 crate 不得被顺手删掉。
  const cliShape = checkCliArtifactShape(text)
  if (!cliShape.ok) {
    for (const p of cliShape.problems) console.error(`  ✗ CLI 退役形状：${p}`)
  } else {
    console.log(
      '✅ CLI 发布通道保持退役状态（无 cli / cli-publish job、上传宾语不含 dist/cli）'
    )
    console.log('✅ 便携版上传路径存在（dist/portable/*，F13 的期望资产 13 靠它兑现）')
  }
  const crate = checkCliCrateRetained(
    readFileSync(CARGO_TOML, 'utf8'),
    readFileSync(join(projectRoot, 'scripts', 'smoke-launch.mjs'), 'utf8'),
    readFileSync(join(projectRoot, 'scripts', 'fault-inject.mjs'), 'utf8')
  )
  if (!crate.ok) {
    for (const p of crate.problems) console.error(`  ✗ CLI crate 保留：${p}`)
  } else {
    console.log('✅ CLI crate 仍在（workspace members + smoke / fault-inject 的 target/debug 路径）')
  }

  if (!ok || hits.length > 0 || shellProblems.length > 0 || !cliShape.ok || !crate.ok) process.exit(1)
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
