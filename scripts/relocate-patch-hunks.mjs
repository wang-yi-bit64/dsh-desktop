#!/usr/bin/env node
/**
 * relocate-patch-hunks.mjs — 把补丁的 `@@` 行号重定位到目标版本的真实位置。
 * **只改写 `@@` 行，其余逐字节保真**。
 *
 * ## 与 `recount-patches.mjs` 的分工（互补，不是替代）
 *
 * | | `recount-patches.mjs` | 本脚本 |
 * |---|---|---|
 * | 做法 | 在纯净树上按内容应用，再与纯净文件 `git diff` **重生成**补丁 | 按内容定位每个 hunk 的 before 块，**只改写 `@@` 行** |
 * | 依赖 | `spawnSync('git', …)` | **无外部进程** |
 * | 产出 | 规范化的补丁（上下文与计数由 git 重算） | 原文保真，只有 `@@` 行变化 |
 * | 适用 | 能跑 git 的环境 | git 不可用（本机 `spawnSync` 报 EBUSY），或希望零副作用改行号 |
 *
 * 两条路径算出的**行号必然一致**（都基于「按内容定位」）；但上下文行与 `@@` 计数
 * **不保证逐字相同**。因此：**同一份补丁只用其中一条路径**，不要混用，
 * 否则会在「哪个是权威文本」上产生不可复现的差异。
 *
 * ## 为什么需要「只改行号」这条路
 *
 * `patch-package` 从 `@@ -N` 给的 N 起，偏移取 0、±1、±2 …，**绝对值超过 20 就放弃**
 * （`node_modules/patch-package/dist/patch/apply.js` 的 `fuzzingOffset`）。上游小版本
 * 升级后上下文仍在、行号却漂出 20 行以外时，真实组装报 `cannot apply the patch file`，
 * 而按内容搜索的预检（比它宽松）判 clean —— 两处结论相反，缺陷只在组装后才暴露。
 *
 * 顺带把每个 hunk 分成两类，正是 `docs/dsh-upgrade-checklist.md` §2.4 的前两类：
 *   · 定位到   → 纯漂移，重算行号即可修（第二类：上游仅改了上下文行）
 *   · 定位不到 → 上游重构了该段，需人判语义（第三类）
 *
 * ## 用法
 *
 * ```bash
 * node scripts/relocate-patch-hunks.mjs --dsh-target=<目标> --pristine=<纯净包根>          # 只报告
 * node scripts/relocate-patch-hunks.mjs --dsh-target=<目标> --pristine=<纯净包根> --write  # 写回
 * node scripts/relocate-patch-hunks.mjs --self-test                                       # 纯逻辑自检
 * ```
 *
 * `--pristine` 的布局是 `<root>/<包名>/<包内相对路径>`，包名是**带作用域的全名**
 * （`@deepseek-ai/dsh-client-ui-chat`），与 `recount-patches.mjs` 一致。
 * 输入必须是**未打补丁**的上游包（`npm pack` / registry tarball 解包），
 * 已组装过的 `harness-deps/<target>/node_modules` 不能用——它已经打过补丁了。
 *
 * ## 两道「静默放行」判据（2026-09-25 加）
 *
 * ① **纯净树的版本身份必须与补丁声明同版**。`--pristine` 的默认路径是
 *    `harness-deps/<target>-pristine`，而那是**目标键**、不带版本——同一目录在通道内
 *    被复用（与 `harness-lockfile.mjs` 规则 4 是同一个论证）。**路径证明不了里面是哪一版**：
 *    本机实测该目录曾装着 `0.1.7-rc.1` 而当时目标是 `0.1.5-rc.3`。若不校验，
 *    能定位到的 hunk 会**照错树的行号写回**，且打印 `✅`——缺陷要到真实组装才炸。
 *    拿 `<包>/package.json` 的 `version` 与补丁文件名里的版本段比（对
 *    `cordis-plugin-loader` 这类独立版本号的包天然正确，无需知道 DSH 版本）。
 *
 * ② **纯净树里找不到目标文件 ⇒ 判红**（此前只记 warning 却仍标 `✅`）。
 *    「找不到」既可能是取错了树，也可能真的是新增文件——两者都不该静默通过。
 *
 * 退出码：`0` 全部定位成功 · `1` 存在定位不到 / 缺失 / 版本不符 · `2` 参数错误。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { packageNameFromPatchFile, versionFromPatchFile } from './patch-layers.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// 纯逻辑层（可自测；不碰文件系统）
// ---------------------------------------------------------------------------

/**
 * 纯净树版本身份判据：**补丁文件名里的版本段必须等于纯净树里那个包的 `version`**。
 *
 * 为什么不能用路径判断：`--pristine` 的默认路径是 `harness-deps/<target>-pristine`，
 * `<target>` 是**目标键**而非版本键，同一目录在通道内长期复用（`next/` 从 rc.2 一路
 * 用到 rc.3）。所以「路径叫 next」证明不了「里面是 rc.3」——本机实测该目录当时装的
 * 是 `0.1.7-rc.1`。不校验的后果不是报错，而是**照错树的行号写回并打印 `✅`**，
 * 缺陷要到真实组装（下载完 300MB 之后）才以 `cannot apply the patch file` 现形。
 *
 * 拿「补丁文件名里的版本段」而不是目标的 `dshVersion` 作基准，是为了对
 * `cordis-plugin-loader` 这类**独立版本号**的包天然正确——`verify:patches` 已保证
 * 文件名版本段与该包在上游的实际版本一致。
 *
 * @param {object} input
 * @param {string|null} input.pkgName 从补丁文件名推导的包名
 * @param {string|null} input.patchVersion 从补丁文件名推导的版本段
 * @param {string|null} input.pristineVersion 纯净树里该包 `package.json` 的 `version`（读不到为 null）
 * @returns {string|null} 问题描述；`null` 表示通过
 */
export function pristineVersionProblem({ pkgName, patchVersion, pristineVersion }) {
  if (!pkgName) return '补丁文件名里解析不出包名'
  if (!patchVersion) return `补丁文件名里解析不出版本段（${pkgName}）`
  if (pristineVersion === null) {
    // 读不到也要判红：若放行，等于让「纯净树不完整 / package.json 缺失」这条路径
    // 静默退回「不校验版本」——正是这条判据要堵的东西。
    return `纯净树里读不到 ${pkgName} 的 version（缺 ${pkgName}/package.json，或其中没有 version 字段）`
  }
  if (pristineVersion !== patchVersion) {
    return (
      `纯净树里 ${pkgName} 是 ${pristineVersion}，补丁声明的是 ${patchVersion}` +
      '——纯净树取错了版本，能定位到的 hunk 会按错树的行号写回'
    )
  }
  return null
}

/**
 * 在 `lines` 里从 `from` 起找 `block` 的首次出现，返回下标；找不到返回 -1。
 *
 * 空 block 一律返回 -1：一个没有任何 before 行的 hunk 无法被定位，
 * 把它当成「处处匹配」会让该 hunk 静默落在文件开头。
 *
 * @param {string[]} lines
 * @param {string[]} block
 * @param {number} from
 * @returns {number}
 */
export function indexOfBlock(lines, block, from) {
  if (block.length === 0) return -1
  outer: for (let i = from; i + block.length <= lines.length; i += 1) {
    for (let k = 0; k < block.length; k += 1) {
      if (lines[i + k] !== block[k]) continue outer
    }
    return i
  }
  return -1
}

/**
 * 保真解析：**逐行保留原文**，只为每个 `@@` 记下它在行数组里的下标。
 *
 * 这是本脚本与 `check-patch-applicability.mjs` 的 `parsePatch` 的关键区别——
 * 那个是**提取**语义（只留 hunk 内容，丢掉 `diff --git` / `---` / `+++`），
 * 适合「判断能否打上」；我们需要**写回**，所以必须一个字节都不丢。
 *
 * ⚠️ 长度 0 的行**不是 hunk 内容**。空行经过 `split('\n')` 后是空字符串，
 * `marker` 取 `''[0]` 即 `undefined`，不落入任何分支——这一步是**刻意的**。
 * 若把它当「空上下文行」，补丁文件**末尾**的空行会被附到**最后一个 hunk** 上，
 * 使该 hunk 永远定位不到：`llm-pi-ai` / `client-modules` / `trajectory` 三个纯漂移
 * 补丁都被这样误报过。同类形状见 `AGENTS.md` 的「先判定长度 0 为非内容」。
 *
 * @param {string} text 补丁全文（调用方保证已归一化为 LF）
 * @returns {{lines: string[], groups: {file: string|null, hunks: object[]}[]}}
 */
export function parsePatchForRelocate(text) {
  const lines = text.split('\n')
  const groups = []
  let group = null
  let hunk = null

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    if (line.startsWith('+++ ')) {
      // `+++ b/node_modules/<pkg>/<rel>` —— 片段从 b/ 侧开始
      group = { file: line.slice(4).trim().replace(/^[ab]\//, ''), hunks: [] }
      groups.push(group)
      hunk = null
      continue
    }

    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
    if (header) {
      hunk = {
        lineIndex: i,
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        headerTail: header[5] ?? '',
        lines: [],
        added: 0,
        removed: 0
      }
      if (group) group.hunks.push(hunk)
      continue
    }

    if (!hunk) continue
    const marker = line[0]
    if (marker === ' ' || marker === '-') {
      hunk.lines.push({ type: marker, text: line.slice(1) })
      if (marker === '-') hunk.removed += 1
    } else if (marker === '+') {
      hunk.lines.push({ type: '+', text: line.slice(1) })
      hunk.added += 1
    } else if (marker === '\\') {
      // `\ No newline at end of file`：**连反斜杠一起**保留，否则写回会丢这个标记。
      hunk.lines.push({ type: '\\', text: line.slice(1) })
    }
    // 其余（含长度 0 的行）一律不是 hunk 内容，见上方警告。
  }
  return { lines, groups }
}

/**
 * 把一个补丁文本里的所有 `@@` 行重定位到纯净文件的真实位置。
 *
 * `delta` 与 `cursor` **按文件段累积**：同一目标文件内的后一个 hunk 的 `newStart`
 * 取决于前一个 hunk 净增删了多少行。跨文件的段必须重置（否则会串味）。
 *
 * 定位不到的 hunk **原样保留**其 `@@` 行——不猜、不删，交给升级清单 §2.4 的
 * 第三类流程由人判语义。
 *
 * @param {string} patchText 补丁全文（LF）
 * @param {(file: string) => string[]|null} pristineForFile 给定 `+++` 侧路径返回纯净文件行；
 *   返回 null 表示该文件在纯净树里不存在。
 * @returns {{text: string, relocated: number, unchanged: number, orphans: string[], warnings: string[], missing: string[]}}
 *   `missing` 单独成列而**不是**塞进 `warnings`：调用方要据此判定这**不是**通过
 *   （只记警告却仍标成功，就是本轮修掉的那种静默放行）。
 */
export function relocatePatchHunks(patchText, pristineForFile) {
  const { lines, groups } = parsePatchForRelocate(patchText)
  const out = [...lines]
  let relocated = 0
  let unchanged = 0
  const orphans = []
  const warnings = []
  const missing = []

  for (const group of groups) {
    const pristine = group.file === null ? null : pristineForFile(group.file)
    if (pristine === null) {
      // 文件不存在时**不做任何改动**：整段（含所有 hunk）原样保留。
      const label = group.file ?? '(无 +++ 头)'
      if (group.hunks.length > 0) warnings.push(`${label} → 纯净树里不存在`)
      missing.push(label)
      continue
    }

    let cursor = 0
    let delta = 0
    for (const hunk of group.hunks) {
      const before = hunk.lines.filter((l) => l.type === ' ' || l.type === '-').map((l) => l.text)

      // 计数自洽性**只警告不阻断**：`@@` 声明与实际行数不符时，`patch-package` 的行为
      // 本就不可预期（它按声明推进），但这是补丁自身的问题，不是漂移。重定位照做，
      // 计数保持原值（本脚本的职责是「只改行号」），把异常摆到人眼前。
      if (before.length !== hunk.oldCount) {
        warnings.push(
          `${group.file} @@${hunk.oldStart}：上下文 ${before.length} 行与 @@ 声明的 ${hunk.oldCount} 行不符（计数保持原值）`
        )
      }

      const found = indexOfBlock(pristine, before, cursor)
      if (found === -1) {
        orphans.push(`${group.file} @@${hunk.oldStart}`)
        continue
      }

      const oldStart = found + 1
      const newStart = oldStart + delta
      if (oldStart !== hunk.oldStart || newStart !== hunk.newStart) relocated += 1
      else unchanged += 1
      out[hunk.lineIndex] = `@@ -${oldStart},${hunk.oldCount} +${newStart},${hunk.newCount} @@${hunk.headerTail}`

      cursor = found + before.length
      delta += hunk.added - hunk.removed
    }
  }

  return { text: out.join('\n'), relocated, unchanged, orphans, warnings, missing }
}

// ---------------------------------------------------------------------------
// 自测（纯逻辑，不读写仓库文件）
// ---------------------------------------------------------------------------

function selfTest() {
  let passed = 0
  const failures = []
  const eq = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (ok) passed += 1
    else failures.push(`${name}\n    实际: ${JSON.stringify(actual)}\n    期望: ${JSON.stringify(expected)}`)
  }

  const P = '@deepseek-ai/dsh-client-ui-demo'
  const header = (rel) => [
    `diff --git a/node_modules/${P}/${rel} b/node_modules/${P}/${rel}`,
    `--- a/node_modules/${P}/${rel}`,
    `+++ b/node_modules/${P}/${rel}`
  ]
  const filePath = (rel) => `node_modules/${P}/${rel}`

  // --- 夹具 1：无漂移 ⇒ 输出与输入逐字节相同 ---
  const pristine1 = ['row1', 'row2', 'row3', 'row4', 'row5']
  const patch1 = [...header('lib/a.js'), '@@ -2,3 +2,4 @@', ' row2', '-row3', '+row3b', '+row3c', ' row4'].join('\n') + '\n'
  const r1 = relocatePatchHunks(patch1, () => pristine1)
  eq('夹具1：无漂移 → 原文逐字节不变', r1.text, patch1)
  eq('夹具1：计数 unchanged=1 / relocated=0', [r1.unchanged, r1.relocated], [1, 0])
  eq('夹具1：无 orphan/warning', [r1.orphans.length, r1.warnings.length], [0, 0])

  // --- 夹具 2：纯漂移（上方插了 2 行 → row2 从第 2 行移到第 3 行）⇒ 只改 @@ 行 ---
  const pristine2 = ['pad1', 'pad2', 'row2', 'row3', 'row4']
  const r2 = relocatePatchHunks(patch1, () => pristine2)
  eq('夹具2：漂移 → @@ 行号 +1', r2.text.includes('@@ -3,3 +3,4 @@'), true)
  eq('夹具2：其余行逐字不变', r2.text.replace('@@ -3,3 +3,4 @@', '@@ -2,3 +2,4 @@'), patch1)
  eq('夹具2：relocated=1', r2.relocated, 1)

  // --- 夹具 3：同文件两个 hunk，delta 必须累积 ---
  const pristine3 = ['a1', 'a2', 'c1', 'c2', 'c3', 'c4', 'b1', 'b2']
  const patch3 = [
    ...header('lib/b.js'),
    '@@ -1,2 +1,2 @@',
    ' a1',
    '-a2',
    '+a2x',
    '+a2y',
    '+a2z',
    '@@ -10,2 +10,2 @@',
    ' b1',
    '-b2',
    '+b2x'
  ].join('\n')
  const r3 = relocatePatchHunks(patch3, () => pristine3)
  // hunk1 定位到下标 0（oldStart 1，newStart 1）⇒ delta += (3 added - 1 removed) = +2
  eq('夹具3：hunk1 行号不变', r3.text.includes('@@ -1,2 +1,2 @@'), true)
  // hunk2 定位到下标 6（oldStart 7），newStart = 7 + 2 = 9
  eq('夹具3：hunk2 的 newStart 累积 delta（10 → 9）', r3.text.includes('@@ -7,2 +9,2 @@'), true)
  // 反过来断言「不累积」是错的：若实现漏了 delta，这里会是 +7
  eq('夹具3：hunk2 的 newStart 不等于未累积的值', r3.text.includes('@@ -7,2 +7,2 @@'), false)

  // --- 夹具 4：定位不到 ⇒ 该 @@ 行原样保留，计入 orphan ---
  const r4 = relocatePatchHunks(patch1, () => ['完全', '不同的', '内容'])
  eq('夹具4：orphan 计数', r4.orphans.length, 1)
  eq('夹具4：@@ 行原样保留', r4.text, patch1)
  eq('夹具4：orphan 说明点名文件与行号', r4.orphans[0].includes('lib/a.js') && r4.orphans[0].includes('@@2'), true)

  // --- 夹具 5：文件在纯净树里不存在 ⇒ 整段不动 + warning + **单列 missing** ---
  const r5 = relocatePatchHunks(patch1, () => null)
  eq('夹具5：文件不存在 → 原文不变', r5.text, patch1)
  eq('夹具5：warning 提到文件', r5.warnings.join(' ').includes('lib/a.js'), true)
  // `missing` 必须与 `warnings` **分开**：调用方靠它判定「这不是通过」。
  // 若实现把两者合并（只记警告），这里会拿到 0 —— 那正是被修掉的那个静默放行。
  eq('夹具5：missing 单独成列且计数为 1', r5.missing.length, 1)
  eq('夹具5：missing 不混入 warnings 之外的其他列', [r5.orphans.length, r5.relocated], [0, 0])

  // --- 夹具 6：`\ No newline at end of file` 连反斜杠保留 ---
  const patch6 = [
    ...header('lib/c.js'),
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-tail',
    '+tail2',
    '\\ No newline at end of file'
  ].join('\n')
  const r6 = relocatePatchHunks(patch6, () => ['keep', 'tail'])
  eq('夹具6：反斜杠行逐字保留', r6.text.includes('\\ No newline at end of file'), true)
  eq('夹具6：该 hunk 正常重定位（无漂移）', r6.unchanged, 1)

  // --- 夹具 7：末尾空行不得被当成上下文行（本工具踩过的坑的回归断言） ---
  // 若解析器把末尾空行附到最后那个 hunk，`before` 会多一项，定位必然失败。
  const patch7 = [...header('lib/d.js'), '@@ -1,2 +1,2 @@', ' p', '-q', '+q2', ' r', ''].join('\n')
  const r7 = relocatePatchHunks(patch7, () => ['p', 'q', 'r'])
  eq('夹具7：末尾空行不影响定位', [r7.orphans.length, r7.unchanged], [0, 1])
  eq('夹具7：末尾空行原样写回', r7.text.endsWith(' r\n'), true)

  // --- 夹具 8：多个文件段 —— delta 与 cursor 必须按段重置 ---
  const patch8 = [
    ...header('lib/e.js'),
    '@@ -1,1 +1,3 @@',
    '-e1',
    '+e1a',
    '+e1b',
    '+e1c',
    ...header('lib/f.js'),
    '@@ -1,1 +1,1 @@',
    ' f1'
  ].join('\n')
  const r8 = relocatePatchHunks(patch8, (f) => (f.endsWith('e.js') ? ['e1'] : ['f1']))
  eq('夹具8：第二段不继承第一段的 delta', r8.text.includes('@@ -1,1 +1,1 @@'), true)

  // --- 夹具 9：`oldCount` 与实际不符 ⇒ 只警告，仍重定位 ---
  const patch9 = [...header('lib/g.js'), '@@ -1,9 +1,9 @@', ' g1', '-g2', '+g2x'].join('\n')
  const r9 = relocatePatchHunks(patch9, () => ['g1', 'g2'])
  eq('夹具9：计数不符 → warning', r9.warnings.length, 1)
  eq('夹具9：计数不符 → 仍重定位', r9.unchanged, 1)
  eq('夹具9：@@ 计数保持原值（职责是只改行号）', r9.text.includes('@@ -1,9 +1,9 @@'), true)

  // --- 夹具 10：indexOfBlock 的边界 ---
  eq('indexOfBlock：空 block → -1', indexOfBlock(['a'], [], 0), -1)
  eq('indexOfBlock：from 之后才出现', indexOfBlock(['x', 'a', 'b'], ['a', 'b'], 1), 1)
  eq('indexOfBlock：找不到 → -1', indexOfBlock(['a'], ['z'], 0), -1)
  eq('indexOfBlock：block 长于 lines → -1', indexOfBlock(['a'], ['a', 'b'], 0), -1)

  // --- 夹具 11：纯净树版本身份判据（本机实测踩到的形态） ---
  // 反证基准：**同版必须放行**，否则这道判据就变成「一律拒绝」而不校验任何东西。
  const PKG = '@deepseek-ai/dsh-client-ui-demo'
  eq(
    '夹具11：同版 → 通过',
    pristineVersionProblem({ pkgName: PKG, patchVersion: '0.1.5-rc.3', pristineVersion: '0.1.5-rc.3' }),
    null
  )
  // 真事故形态：目标是 0.1.5-rc.3，纯净树目录却装着 0.1.7-rc.1。
  const crossVerdict = pristineVersionProblem({
    pkgName: PKG,
    patchVersion: '0.1.5-rc.3',
    pristineVersion: '0.1.7-rc.1'
  })
  eq('夹具11：跨版本 → 判红', typeof crossVerdict === 'string', true)
  eq(
    '夹具11：跨版本的说明**同时**给出两个版本（否则人看不出该重取哪一版）',
    crossVerdict.includes('0.1.7-rc.1') && crossVerdict.includes('0.1.5-rc.3'),
    true
  )
  // 独立版本号的包：`cordis-plugin-loader+1.0.3.patch`。判据以「文件名里的版本段」为基准，
  // 因此不必知道 DSH 版本；用 dshVersion 当基准的实现会在这里判红 ⇒ 可伪证。
  eq(
    '夹具11：独立版本号的包（1.0.3）同版 → 通过',
    pristineVersionProblem({ pkgName: '@deepseek-ai/cordis-plugin-loader', patchVersion: '1.0.3', pristineVersion: '1.0.3' }),
    null
  )
  // 读不到 version 必须判红：放行等于让「纯净树不完整」静默退回「不校验版本」。
  eq(
    '夹具11：纯净树缺 version → 判红（不得静默退回不校验）',
    typeof pristineVersionProblem({ pkgName: PKG, patchVersion: '0.1.5-rc.3', pristineVersion: null }) === 'string',
    true
  )
  eq(
    '夹具11：文件名解析不出版本段 → 判红',
    typeof pristineVersionProblem({ pkgName: PKG, patchVersion: null, pristineVersion: '0.1.5-rc.3' }) === 'string',
    true
  )
  eq(
    '夹具11：文件名解析不出包名 → 判红',
    typeof pristineVersionProblem({ pkgName: null, patchVersion: '0.1.5-rc.3', pristineVersion: '0.1.5-rc.3' }) === 'string',
    true
  )
  // 判据必须对**输入本身**敏感：同一组入参换掉任一版本都要翻转结论。
  eq(
    '夹具11：只改纯净树版本 → 结论翻转（证明判据真的在比对）',
    [
      pristineVersionProblem({ pkgName: PKG, patchVersion: '0.1.5-rc.3', pristineVersion: '0.1.5-rc.3' }),
      typeof pristineVersionProblem({ pkgName: PKG, patchVersion: '0.1.5-rc.3', pristineVersion: '0.1.5-rc.2' })
    ],
    [null, 'string']
  )

  if (failures.length > 0) {
    console.error('❌ relocate-patch-hunks 自测失败：')
    for (const f of failures) console.error(`  · ${f}`)
    process.exit(1)
  }
  console.log(`✅ relocate-patch-hunks 自测通过（${passed} 项）`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) selfTest()

  const write = args.includes('--write')
  const targetName = args.find((a) => a.startsWith('--dsh-target='))?.slice('--dsh-target='.length) ?? 'next'
  const pristineRoot = args.find((a) => a.startsWith('--pristine='))?.slice('--pristine='.length)
  if (!pristineRoot) {
    console.error('必须传 --pristine=<未打补丁的包根>（布局 <root>/<包名>/<包内相对路径>）')
    process.exit(2)
  }
  if (!existsSync(pristineRoot)) {
    console.error(`--pristine 指向的路径不存在：${pristineRoot}`)
    process.exit(2)
  }

  const patchDir = join(projectRoot, 'patches', targetName)
  const files = readdirSync(patchDir)
    .filter((f) => f.endsWith('.patch'))
    .sort()

  let okFiles = 0
  let totalRelocated = 0
  let totalOrphans = 0
  const orphanDetail = []
  const problemDetail = []

  for (const file of files) {
    const pkgName = packageNameFromPatchFile(file)
    const raw = readFileSync(join(patchDir, file), 'utf8')
    const crlf = raw.includes('\r\n')
    const text = raw.replace(/\r\n/g, '\n')

    // ① 版本身份：纯净树必须与补丁声明的版本同版。不通过就**整个文件跳过**——
    //    这既是不让错树污染补丁，也是让人一眼看出「该换哪一版纯净树」。
    let problem = null
    try {
      const pkgJsonPath = join(pristineRoot, pkgName ?? '', 'package.json')
      const pristineVersion = existsSync(pkgJsonPath)
        ? (JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version ?? null)
        : null
      problem = pristineVersionProblem({ pkgName, patchVersion: versionFromPatchFile(file), pristineVersion })
    } catch (error) {
      problem = `读 ${pkgName ?? '?'}/package.json 失败：${error.message}`
    }
    if (problem !== null) {
      console.log(`❌ ${file}`)
      console.log(`   ✗ ${problem}`)
      problemDetail.push(`${file}  ${problem}`)
      continue
    }

    const result = relocatePatchHunks(text, (repoRelPath) => {
      // `node_modules/<pkg>/<rel>` → `<pristineRoot>/<pkg>/<rel>`
      const rel = repoRelPath.replace(`node_modules/${pkgName}/`, '')
      const abs = join(pristineRoot, pkgName, rel)
      if (!existsSync(abs)) return null
      return readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n')
    })

    totalRelocated += result.relocated
    totalOrphans += result.orphans.length
    for (const o of result.orphans) orphanDetail.push(`${file}  ${o}`)

    // ② 定位不到的 hunk 与「纯净树里没有这个文件」**都算不通过**。
    //    后者此前只记 warning 却仍标 ✅ —— 一个静默放行的入口。
    const ok = result.orphans.length === 0 && result.missing.length === 0
    if (ok) okFiles += 1
    const drift = result.relocated > 0 ? `重算 ${result.relocated} 个 hunk` : '无需改动'
    console.log(`${ok ? '✅' : '❌'} ${file}  （${drift}，${result.unchanged} 个已对齐）`)
    for (const w of result.warnings) console.log(`   ⚠️ ${w}`)
    for (const m of result.missing) console.log(`   ✗ ${m} —— 纯净树里找不到该文件（取错了树，或补丁新增的文件）`)
    for (const o of result.orphans) console.log(`   ✗ ${o} —— 上下文在纯净树里找不到（上游重构）`)

    if (write && ok && result.relocated > 0) {
      const body = crlf ? result.text.replace(/\n/g, '\r\n') : result.text
      writeFileSync(join(patchDir, file), body)
    } else if (write && ok) {
      // 即便没有漂移也要确认写回是幂等的：内容一致时**不碰文件**，避免无意义 mtime 变动。
      const body = crlf ? result.text.replace(/\n/g, '\r\n') : result.text
      if (body !== raw) {
        console.error(`   ❌ ${file}：报告「无需改动」但往返后字节不同——这是缺陷，已中止写回`)
        process.exit(1)
      }
    }
  }

  console.log('')
  console.log(`补丁文件：${okFiles}/${files.length} 个全部可定位`)
  console.log(`hunk：${totalRelocated} 个重算行号，${totalOrphans} 个定位不到`)
  if (problemDetail.length > 0) {
    console.log('')
    console.log('纯净树版本身份不符（**必须先换对纯净树**，见文件头「两道静默放行判据」）：')
    for (const p of problemDetail) console.log(`  · ${p}`)
    console.log('  默认路径 harness-deps/<target>-pristine 是**目标键、不带版本**，')
    console.log('  同一目录在通道内被复用 ⇒ 路径无法证明里面是哪一版，故须显式 --pristine=<该版本>。')
  }
  if (orphanDetail.length > 0) {
    console.log('')
    console.log('定位不到的 hunk（需人判语义，见升级清单 §2.4 第三类）：')
    for (const o of orphanDetail) console.log(`  · ${o}`)
  }
  console.log(write ? '\n已写回。' : '\n（报告模式，未写回；加 --write 写回）')
  process.exit(problemDetail.length > 0 || totalOrphans > 0 || files.length !== okFiles ? 1 : 0)
}

main()
