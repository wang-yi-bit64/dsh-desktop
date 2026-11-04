#!/usr/bin/env node
/**
 * verify-error-code-parity.mjs — **错误码文案 ↔ Rust 码表的双向一致性**（CD14）。
 *
 * ## 守的是什么缺陷
 *
 * `src-tauri/frontend/updates.html` 按**稳定错误码**给用户在更新失败时选文案：
 *
 *   ```js
 *   if (phase === 'error' && snapshot.code && t.codes[snapshot.code]) text = t.codes[snapshot.code]
 *   ```
 *
 * 这是刻意的（不对上游 updater 的英文 `message` 做字符串匹配——它会随 locale /
 * 版本漂移）。代价是这张码表成了 `crates/dsh-contracts/src/errors.rs` 里
 * `UPDATE_*` 常量的**手抄副本**，而且是**两份**（`en` / `zh`）。三处手抄之间
 * 没有任何编译期联系：
 *
 *   · Rust 加一个细分码（例如把「签名校验超时」从 E1008 拆出来）→ 前端没有文案
 *     ⇒ 页面退回「检查更新失败。」这句兜底文案，**分类信息静默消失**，没有任何
 *     检查会红；
 *   · Rust 删码 / 改号码，前端表还留着 → 那张表里就有一条永远不可能命中的文案，
 *     下一个人会以为那个错误还在；
 *   · 只改了 `en` 忘了 `zh`（或反过来）→ 一半用户看到的还是兜底文案；
 *   · 文案被改成空串 → 错误页显示一片空白，比兜底文案更糟。
 *
 * 这四类都**没有编译错误、没有运行时异常**，只有跨文件比对能看见。
 *
 * ## 判据（五条失败条件缺一不可）
 *
 * | 编号 | 失败条件 | 夹具 |
 * |------|----------|------|
 * | P1 | Rust 有码、前端没有（含 en / zh 分别判） | `夹具 P1` |
 * | P2 | 前端有码、Rust 没有（多出码 / 码被删） | `夹具 P2` |
 * | P3 | 文案为空（或只有空白） | `夹具 P3` |
 * | P4 | 无法解析（语法 / 结构变更：码表改宏、值不是字符串字面量、找不到块） | `夹具 P4` |
 * | P5 | **解析结果为空集** | `夹具 P5` |
 *
 * 另两条是**独立维度**的判据，不算在上面那五条里——它们问的不是「该显示什么文本」，
 * 而是「码本身自洽吗」：
 *
 * | 编号 | 判据 | 夹具 |
 * |------|------|------|
 * | P6 | Rust 侧码值唯一——**全量**，不限 `UPDATE_*` 前缀 | `夹具 P6` |
 * | P7 | 前端引用 ⊆ Rust 全量码（含注释与散文里的 `E\d{4}`） | `夹具 P7` |
 *
 * P6/P7 并自 `feat/v3-error-code-parity` 那份未合并的旧实现（那里叫 P8 与 P4）。
 * 之所以只并这两条、不并它的**全量豁免清单**：这两条零维护就能守，而豁免清单是
 * 一份需要跟着码表长期维护的债——加一个不到页面的码就得补一段理由（CD02 新加的
 * `E3004` 就会立刻把旧实现顶红）。
 *
 * P6 刻意放在前缀过滤**之前**：若只查 `UPDATE_*` 内部重复，两个非 `UPDATE_` 的码
 * 撞车会被静默漏掉，而 `AppError::exit_code()` 一样会取到不确定的那一个。
 * P7 的判据集是**全量码**而非 `UPDATE_*` 子集：壳层还会引用环境族、进程族的码
 * （`error.html` 就引用了 `E3003`），这条问的是「这码存不存在」。
 *
 * ⚠️ P5 是这张表里最重要的一条：`扫出 0 个码 ⇒ 两边都缺 ⇒ 判绿` 是经典的
 * vacuous pass（本仓 §7.3 / E5-空）。因此「Rust 侧解析出 0 个 `UPDATE_*` 码」
 * 与「某语言码表解析出 0 条」**本身就是失败**，不需要等比对结果。
 *
 * ## 码表的范围怎么定（为什么不把 E1005~E1008 抄进来）
 *
 * 被测集合 = Rust `codes` 模块里**常量名以 `UPDATE_` 开头**的 E 码。用「名字前缀」
 * 而不是在脚本里硬编码四个码，理由是后者会让「Rust 新增码而前端没有」这条**永远
 * 抓不到**——新码不在脚本的清单里，脚本只证明「我抄的两遍一样」。而那个名字前缀
 * 正是 Rust 侧自己划出的语义分组（`UpdateFailure::code()` 逐条映射的也全是它们）。
 *
 * ## 长期方向（**本轮未实现**）
 *
 * 正解是单向派生：`errors.rs` 生成前端可消费的映射，`updates.html` 消费生成物，
 * 手抄副本消失。本轮**只做门禁**、不做代码生成——生成物一旦引入，就需要配套的
 * 「重新生成 + 漂移检查」流程，那是独立的一步。在那之前，本文件就是那道防线。
 *
 * ## 用法
 *
 *   node scripts/verify-error-code-parity.mjs              # 真检查（读仓库）
 *   node scripts/verify-error-code-parity.mjs --self-test  # 自检（纯内存夹具）
 *
 * 只用 `node:` 内置模块（仓内脚本的约定：门禁不得依赖第三方包）。
 * 退出码：0 一致 · 1 有漂移 / 自检失败。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { argv, exit } from 'node:process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const errorsRsPath = join(projectRoot, 'crates', 'dsh-contracts', 'src', 'errors.rs')
const updatesHtmlPath = join(projectRoot, 'src-tauri', 'frontend', 'updates.html')

/** 引用扫描的根目录；P7 要扫**全部**壳层页面，不只看 `updates.html`。 */
const frontendDir = join(projectRoot, 'src-tauri', 'frontend')

/** 引用扫描的文件类型。壳层页面是 `.html`，注入脚本是 `.js`。 */
const FRONTEND_EXTENSIONS = ['.html', '.js']

/** 前端码表所属的两门语言；**两份都必须在**。 */
const LANGUAGES = ['en', 'zh']

/**
 * Rust 侧被测码的常量名前缀。
 *
 * 与 `src-tauri/src/update.rs::UpdateFailure::code()` 的映射集合一致；改这个前缀
 * 等于改「前端该给哪些失败码写文案」的契约，属显式决定，不是实现细节。
 */
const UPDATE_CODE_PREFIX = 'UPDATE_'

// ---------------------------------------------------------------------------
// 解析原语
// ---------------------------------------------------------------------------

/**
 * 从 `openIndex` 处的 `{` 起按花括号配对取出块内文本。
 *
 * 不认字符串 / 字符字面量里的花括号——本仓这两个被测文件的块内没有这种写法
 * （码表是 `'E1005': '…'`；码定义是 `pub const X: &str = "E1005";`）。这是刻意的
 * 简化：为了两个静态检查样本引入词法器，收益不抵成本。若将来真的出现，`P4`
 * （无法解析）会把它暴露成**红**，而不是静默漏码。
 *
 * @param {string} text 全文
 * @param {number} openIndex `{` 的下标
 * @returns {string|null} 块内文本（不含外层花括号）；不配对时 null
 */
function extractBracedBlock(text, openIndex) {
  if (text[openIndex] !== '{') return null
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(openIndex + 1, index)
    }
  }
  return null
}

/**
 * 解析 Rust `codes` 模块里的 `UPDATE_*` 码。
 *
 * 关键判据不是「找到了几个」，而是「**块里所有 `pub const … : &str` 都认出来了**」：
 * 声明数 ≠ 解析数说明语法变了（改成宏 / 换了字面量形态 / 加了类型注解），
 * 此时少掉的那些码会让 P1 变成假阴性——所以直接判「无法解析」而不是继续比对。
 *
 * @param {string} text `errors.rs` 全文
 * @returns {{ codes: Map<string, string>, allCodes: Map<string, string>, problems: string[] }}
 *   `codes` 是 `UPDATE_*` 子集（参与前端文案比对）；
 *   `allCodes` 是块内**全部** E 码（P6 唯一性检测与 P7 引用存在性检测用）。
 */
export function parseRustCodes(text) {
  const codes = new Map()
  const allCodes = new Map()
  const problems = []

  const moduleMatch = /\bpub mod codes\b/.exec(text)
  if (!moduleMatch) {
    return { codes, problems: ['无法解析：errors.rs 里找不到 `pub mod codes`——码表的产地变了'] }
  }
  const braceIndex = text.indexOf('{', moduleMatch.index)
  const block = braceIndex < 0 ? null : extractBracedBlock(text, braceIndex)
  if (block === null) {
    return { codes, problems: ['无法解析：`pub mod codes` 的花括号不配对——文件结构变了'] }
  }

  const declarations = [...block.matchAll(/\bpub const\s+([A-Z0-9_]+)\s*:\s*&str\s*=/g)]
  const parsed = [...block.matchAll(/\bpub const\s+([A-Z0-9_]+)\s*:\s*&str\s*=\s*"(E[0-9]{4})"\s*;/g)]
  if (declarations.length === 0) {
    problems.push('无法解析：`pub mod codes` 块里一个 `pub const … : &str` 都没有')
  } else if (declarations.length !== parsed.length) {
    problems.push(
      '无法解析：块内有 ' + declarations.length + ' 个 `pub const … : &str` 声明，' +
        '但只认出 ' + parsed.length + ' 个 E 码——语法/结构变了（改用宏、换字面量形态、或加了类型注解）'
    )
  }

  // P6：码值唯一性是**全量**判据，刻意放在前缀过滤之前——两个常量共用一个码时，
  // `AppError::exit_code()` 与前端分派都会取到「不确定的那一个」。若把这一步放到
  // 前缀过滤之后，两个非 `UPDATE_` 码撞车会被静默漏掉（旧版把这条叫 P8）。
  for (const [, name, code] of parsed) {
    if (allCodes.has(code)) {
      problems.push('Rust 侧重复码 ' + code + '（' + allCodes.get(code) + ' 与 ' + name + '）——同一码两个语义')
      continue
    }
    allCodes.set(code, name)
  }

  for (const [code, name] of allCodes) {
    if (!name.startsWith(UPDATE_CODE_PREFIX)) continue
    codes.set(code, name)
    if (!code.startsWith('E1')) {
      problems.push(code + '（' + name + '）不在 E1 族——更新失败码必须与环境族一致（见 errors.rs 的族号表）')
    }
  }

  // P5：空集绝不冒充通过。走到这里 0 个码只可能是「码被删空」或「常量改名」，
  // 两者都意味着这张门禁**不再回答任何问题**，必须红。
  if (codes.size === 0) {
    problems.push(
      'Rust 侧解析出 0 个 `' + UPDATE_CODE_PREFIX + '*` 码——**空集不得冒充通过**（码表被删空，或常量改名了）'
    )
  }

  return { codes, allCodes, problems }
}

/**
 * 解析 `updates.html` 里 `en` / `zh` 两份 code 表。
 *
 * 语言归属靠「最近的 `en: {` / `zh: {` 标记」判断，而不是「第一张是 en、第二张是
 * zh」——后者在有人把两份顺序对调时会静默把语言弄反，报出来的漂移全是错的。
 *
 * @param {string} text `updates.html` 全文
 * @returns {{ tables: { en: Map<string, string>, zh: Map<string, string> }, problems: string[] }}
 */
export function parseFrontendTables(text) {
  const tables = { en: new Map(), zh: new Map() }
  const problems = []

  const languageMarks = []
  for (const match of text.matchAll(/(?:^|\n)[ \t]*([a-z]{2})[ \t]*:[ \t]*\{/g)) {
    if (LANGUAGES.includes(match[1])) languageMarks.push({ lang: match[1], index: match.index })
  }

  const blocks = [...text.matchAll(/\bcodes[ \t]*:[ \t]*\{/g)]
  if (blocks.length !== 2) {
    problems.push('无法解析：应恰好有 2 张 code 表（en / zh），实际 ' + blocks.length + ' 张')
  }

  const seen = new Map()
  for (const block of blocks) {
    const mark = [...languageMarks].reverse().find((candidate) => candidate.index < block.index)
    if (mark === undefined) {
      problems.push('无法解析：找不到这张 code 表所属的语言块（en / zh 标记缺失）')
      continue
    }
    const lang = mark.lang
    seen.set(lang, (seen.get(lang) ?? 0) + 1)
    if (seen.get(lang) > 1) {
      problems.push('无法解析：' + lang + ' 有 ' + seen.get(lang) + ' 张 code 表——一张还是两张？判据无法判定')
      continue
    }

    const openIndex = block.index + block[0].length - 1
    const body = extractBracedBlock(text, openIndex)
    if (body === null) {
      problems.push('无法解析：' + lang + ' 的 code 表花括号不配对')
      continue
    }

    // 键位数 ≠ 认出数 ⇒ 有值不是字符串字面量（改成变量 / 模板 / 函数调用）。
    // 那种形状下「文案为空」与「文案是表达式」长得一样，必须判「无法解析」。
    const keys = [...body.matchAll(/['"]E[0-9]{4}['"]\s*:/g)]
    const entries = [
      ...body.matchAll(/['"](E[0-9]{4})['"]\s*:\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`([^`]*)`)/g)
    ]
    if (keys.length !== entries.length) {
      problems.push(
        '无法解析：' + lang + ' 的 code 表有 ' + keys.length + ' 个键位，' +
          '但只有 ' + entries.length + ' 条的值是字符串字面量——结构变了'
      )
    }
    for (const entry of entries) {
      const code = entry[1]
      const value = entry[2] ?? entry[3] ?? entry[4] ?? ''
      if (tables[lang].has(code)) {
        problems.push(lang + ' 的 code 表重复键 ' + code + '——后一条会静默覆盖前一条')
        continue
      }
      tables[lang].set(code, value)
    }
    // P5（前端侧）：空表 = 「这个页面不再分派任何码」，要么是清空了、要么是
    // 解析器失效；两者都不能给绿。
    if (tables[lang].size === 0) {
      problems.push('前端 ' + lang + ' 的 code 表解析出 0 条——**空集不得冒充通过**')
    }
  }

  for (const lang of LANGUAGES) {
    if (!seen.has(lang)) problems.push('无法解析：找不到 ' + lang + ' 的 code 表')
  }

  return { tables, problems }
}

/**
 * 双向比对：Rust 码集 ↔ en 表 ↔ zh 表。
 *
 * @param {Map<string, string>} rust 码 → 常量名
 * @param {{ en: Map<string, string>, zh: Map<string, string> }} tables
 * @returns {string[]} 问题列表
 */
export function compareTables(rust, tables) {
  const problems = []

  // P1 / P3：Rust 有、前端必须有且文案非空。
  for (const [code, name] of rust) {
    for (const lang of LANGUAGES) {
      const table = tables[lang]
      if (!table.has(code)) {
        problems.push(lang + ' 缺 ' + code + '（Rust ' + name + '）——Rust 新增了码，前端没有对应文案，用户只会看到兜底文案')
        continue
      }
      if (table.get(code).trim() === '') {
        problems.push(lang + ' 的 ' + code + ' 文案为空——错误页会显示一片空白，比兜底文案更糟')
      }
    }
  }

  // P2：前端有、Rust 没有。
  for (const lang of LANGUAGES) {
    for (const code of tables[lang].keys()) {
      if (rust.has(code)) continue
      problems.push(lang + ' 多出 ' + code + '——Rust 的 codes 模块里没有这个 `' + UPDATE_CODE_PREFIX + '*` 码（码被删了、或前端自己造了一个）')
    }
  }

  // 两份手抄之间也必须一致：只改一种语言同样是缺陷（那一半用户看到兜底文案）。
  for (const code of tables.en.keys()) {
    if (!tables.zh.has(code)) problems.push('en 有 ' + code + ' 而 zh 没有——两份手抄已漂移')
  }
  for (const code of tables.zh.keys()) {
    if (!tables.en.has(code)) problems.push('zh 有 ' + code + ' 而 en 没有——两份手抄已漂移')
  }

  return problems
}

/**
 * 扫出前端源码里**每一处** `E\d{4}`（含注释与散文引用）。
 *
 * 与文案表分开是刻意的：文案表回答「应显示什么」，引用回答「代码里提到了什么」。
 * 后者更宽（注释里点名一个码也算），因为**发明一个不存在的码**有两种形态：
 * 抄错文案键，或者在注释 / 分支里写错码——两者都该红。旧版把这条叫 P4。
 *
 * @param {{ path: string, text: string }[]} files
 * @returns {{ path: string, line: number, code: string }[]}
 */
export function scanCodeReferences(files) {
  const references = []
  for (const file of files) {
    const lines = String(file.text ?? '').split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      for (const match of lines[i].matchAll(/\bE[0-9]{4}\b/g)) {
        references.push({ path: file.path, line: i + 1, code: match[0] })
      }
    }
  }
  return references
}

/**
 * P7：**前端引用 ⊆ Rust 全量码**。
 *
 * 注意被测集合是 `allCodes`（全部 E 码）而不是 `UPDATE_*` 子集——壳层还能引用
 * 环境族、网络族等不进更新页面的码（当前 `error.html` 就引用了 `E3003`）。
 * 这条判据问的是「这码到底存不存在」，不是「该不该有文案」。
 *
 * @param {Map<string, string>} allCodes
 * @param {{ path: string, line: number, code: string }[]} references
 * @returns {string[]} 问题列表
 */
export function checkReferences(allCodes, references) {
  if (references.length === 0) {
    return ['前端一处 E 码引用都没扫到——**空集不得冒充通过**（扫描器失效，或前端真的不再提任何码）']
  }

  const missing = new Map()
  for (const reference of references) {
    if (allCodes.has(reference.code)) continue
    const sites = missing.get(reference.code) ?? []
    sites.push(reference.path + ':' + reference.line)
    missing.set(reference.code, sites)
  }

  const problems = []
  for (const [code, sites] of missing) {
    const shown = sites.slice(0, 3).join('、')
    const more = sites.length > 3 ? ' 等 ' + sites.length + ' 处' : ''
    problems.push(
      '前端引用了 ' + code + '，但 errors.rs 的 codes 模块里没有这个码（' + shown + more +
        '）——前端自己造了一个，或 Rust 删码 / 改号码后前端没跟上'
    )
  }
  return problems
}

/**
 * 收集壳层前端源码（P7 的输入）。
 *
 * @param {string} [dir] 默认 `src-tauri/frontend`
 * @returns {{ path: string, text: string }[]} path 是相对仓库根的 posix 路径（日志稳定）
 */
function collectFrontendSources(dir = frontendDir) {
  const sources = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!FRONTEND_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue
      sources.push({
        path: relative(projectRoot, full).split(sep).join('/'),
        text: readFileSync(full, 'utf8')
      })
    }
  }
  walk(dir)
  return sources
}

/**
 * 完整判据：解析两侧 → 比对。
 *
 * 任一侧「无法解析」时**不继续比对**：那时比对结果全是解析失败的次生噪声，
 * 会把「哪一步真的坏了」埋掉（P4 的报错本身已经点名）。
 *
 * @param {string} rustText
 * @param {string} htmlText
 * @param {{ path: string, text: string }[]} [referenceFiles]
 *   P7 的输入。**不传**表示「本调用不适用引用判据」（纯内存夹具只测前两维）；
 *   传了（含空数组）就执行，且**空数组本身判红**——防空转。
 * @returns {{ problems: string[], rustCodes: Map<string, string>, allRustCodes: Map<string, string>, tables: { en: Map<string, string>, zh: Map<string, string> }, references: { path: string, line: number, code: string }[] }}
 */
export function checkParity(rustText, htmlText, referenceFiles) {
  const rust = parseRustCodes(rustText)
  const front = parseFrontendTables(htmlText)
  const problems = [...rust.problems, ...front.problems]
  const references = referenceFiles === undefined ? [] : scanCodeReferences(referenceFiles)
  if (problems.length === 0) {
    problems.push(...compareTables(rust.codes, front.tables))
    if (referenceFiles !== undefined) problems.push(...checkReferences(rust.allCodes, references))
  }
  return { problems, rustCodes: rust.codes, allRustCodes: rust.allCodes, tables: front.tables, references }
}

// ---------------------------------------------------------------------------
// 自检（纯内存夹具；不读仓库文件）
// ---------------------------------------------------------------------------

/**
 * 构造一段 `errors.rs` 的 `codes` 模块夹具。
 *
 * 夹具里**刻意保留一个非 `UPDATE_` 前缀的码**（`LOG_DIR_UNWRITABLE` / E1004）：
 * 它证明「范围 = `UPDATE_*`」这条规则真的在生效——若实现退化成「拿块里所有码
 * 去比」，干净样本会立刻因为 E1004 缺文案而变红。
 *
 * @param {[string, string][]} entries [常量名, 码]
 * @param {boolean} [withForeignCode] 是否附一个非 UPDATE_ 码
 * @returns {string}
 */
function rustFixture(entries, withForeignCode = true) {
  const lines = ['pub mod codes {']
  for (const [name, code] of entries) lines.push('    pub const ' + name + ': &str = "' + code + '";')
  if (withForeignCode) lines.push('    pub const LOG_DIR_UNWRITABLE: &str = "E1004";')
  lines.push('}')
  return lines.join('\n')
}

/**
 * 构造一段 `updates.html` 的 TEXT 夹具（只保留判据需要的形状）。
 *
 * @param {{ en: [string, string][], zh: [string, string][] }} tables
 * @returns {string}
 */
function htmlFixture(tables) {
  const lines = ['<script>', '      const TEXT = {']
  for (const lang of LANGUAGES) {
    lines.push('        ' + lang + ': {')
    lines.push('          codes: {')
    for (const [code, value] of tables[lang]) lines.push("            '" + code + "': '" + value + "',")
    lines.push('          },')
    // 同一对象里还有别的块：语言归属判定必须扛得住它们（`installMode: {` 不是语言块）。
    lines.push("          installMode: { portable: 'x' }")
    lines.push('        }' + (lang === 'en' ? ',' : ''))
  }
  lines.push('      };', '</script>')
  return lines.join('\n')
}

/** 干净样本：Rust 两个码，en / zh 各两份文案。 */
function cleanSample() {
  const rust = rustFixture([
    ['UPDATE_CHECK_NETWORK', 'E1005'],
    ['UPDATE_SIGNATURE_REJECTED', 'E1008']
  ])
  const html = htmlFixture({
    en: [
      ['E1005', 'Cannot reach the update server.'],
      ['E1008', 'Signature verification failed.']
    ],
    zh: [
      ['E1005', '连不上更新服务器。'],
      ['E1008', '签名校验失败。']
    ]
  })
  return { rust, html }
}

function selfTest() {
  let failed = 0
  const check = (label, ok) => {
    if (ok) {
      console.log('PASS ' + label)
    } else {
      failed += 1
      console.error('FAIL ' + label)
    }
  }
  /** 断言问题列表里有点名 code 的那条（避免「红了但原因不对」也算过）。 */
  const mentions = (problems, token) => problems.some((problem) => problem.includes(token))

  // --- 夹具 0：干净样本必须绿（否则后面所有「必须红」都没有意义） ---
  const clean = cleanSample()
  const cleanResult = checkParity(clean.rust, clean.html)
  check('夹具 0：干净样本必须判绿', cleanResult.problems.length === 0)

  // --- 夹具 P1：Rust 新增码而前端没有 ---
  const p1Rust = rustFixture([
    ['UPDATE_CHECK_NETWORK', 'E1005'],
    ['UPDATE_SIGNATURE_REJECTED', 'E1008'],
    ['UPDATE_SIGNATURE_TIMEOUT', 'E1009']
  ])
  const p1 = checkParity(p1Rust, clean.html).problems
  check('夹具 P1：Rust 新增码而 en 缺 → 判红', mentions(p1, 'en 缺 E1009'))
  check('夹具 P1：Rust 新增码而 zh 缺 → 判红', mentions(p1, 'zh 缺 E1009'))

  // --- 夹具 P2：前端有多余码而 Rust 没有 ---
  const p2Html = htmlFixture({
    en: [
      ['E1005', 'Cannot reach the update server.'],
      ['E1008', 'Signature verification failed.'],
      ['E1099', 'A code nobody defines.']
    ],
    zh: [
      ['E1005', '连不上更新服务器。'],
      ['E1008', '签名校验失败。'],
      ['E1099', '一个没人定义的码。']
    ]
  })
  const p2 = checkParity(clean.rust, p2Html).problems
  check('夹具 P2：前端多出码 → 判红', mentions(p2, 'en 多出 E1099') && mentions(p2, 'zh 多出 E1099'))

  // --- 夹具 P3：文案为空 ---
  const p3Html = htmlFixture({
    en: [['E1005', 'Cannot reach the update server.'], ['E1008', '']],
    zh: [['E1005', '连不上更新服务器。'], ['E1008', '签名校验失败。']]
  })
  const p3 = checkParity(clean.rust, p3Html).problems
  check('夹具 P3：文案为空 → 判红', mentions(p3, 'en 的 E1008 文案为空'))
  const p3Blank = checkParity(
    clean.rust,
    htmlFixture({
      en: [['E1005', 'Cannot reach the update server.'], ['E1008', '   ']],
      zh: [['E1005', '连不上更新服务器。'], ['E1008', '签名校验失败。']]
    })
  ).problems
  check('夹具 P3：纯空白文案同样判红（不许 trim 后当有内容）', mentions(p3Blank, 'en 的 E1008 文案为空'))

  // --- 夹具 P4：无法解析（结构变更） ---
  // P4-a：Rust 侧改成宏 / 数组形态 ⇒ 找不到 `pub mod codes`
  const p4Rust = 'pub const UPDATE_CODES: [(&str, &str); 2] = [("UPDATE_CHECK_NETWORK", "E1005")];\n'
  check('夹具 P4：Rust 码表形状变了 → 判红（无法解析）', mentions(checkParity(p4Rust, clean.html).problems, '无法解析'))
  // P4-b：Rust 侧混进一个非字面量声明 ⇒ 块内声明数 ≠ 认出数
  const p4RustMixed = [
    'pub mod codes {',
    '    pub const UPDATE_CHECK_NETWORK: &str = "E1005";',
    '    pub const UPDATE_SIGNATURE_REJECTED: &str = "E1008";',
    '    pub const SPECULATIVE_CODE: &str = pick();',
    '}'
  ].join('\n')
  check('夹具 P4：块内声明数 ≠ 认出数 → 判红', mentions(checkParity(p4RustMixed, clean.html).problems, '无法解析'))
  // P4-c：前端值改成表达式（不再是字符串字面量）⇒ 键位数 ≠ 认出数
  const p4Html = clean.html.replace("'E1008': 'Signature verification failed.'", "'E1008': makeText()")
  check('夹具 P4：前端码表值不是字符串字面量 → 判红', mentions(checkParity(clean.rust, p4Html).problems, '无法解析'))
  // P4-d：前端只剩一张码表（另一门语言被删）
  const p4SingleTable = clean.html.replace(/zh: \{[\s\S]*?\n        \}/, 'zh: { }')
  check('夹具 P4：缺一门语言 / 只剩一张码表 → 判红', mentions(checkParity(clean.rust, p4SingleTable).problems, '无法解析'))

  // --- 夹具 P5：解析结果为空集（空集绝不得冒充通过） ---
  const p5Rust = rustFixture([], true) // 只有那个非 UPDATE_ 码
  const p5 = checkParity(p5Rust, clean.html).problems
  check('夹具 P5：Rust 侧 0 个 UPDATE_* 码 → 判红', mentions(p5, '空集不得冒充通过'))
  const p5Html = htmlFixture({ en: [], zh: [] })
  const p5f = checkParity(clean.rust, p5Html).problems
  check('夹具 P5：前端两份码表都为空 → 判红', mentions(p5f, '空集不得冒充通过'))
  // 空 ↔ 空 是 vacuous pass 的典型入口：两边都空时比对结果本来是「一致」。
  const p5Both = checkParity(p5Rust, p5Html).problems
  check('夹具 P5：两边都为空也必须判红（不得 vacuous pass）', p5Both.length > 0)

  // --- 附加：en / zh 互相漂移（只改一门语言） ---
  const driftHtml = htmlFixture({
    en: [['E1005', 'Cannot reach the update server.'], ['E1008', 'Signature verification failed.']],
    zh: [['E1005', '连不上更新服务器。']]
  })
  const drift = checkParity(clean.rust, driftHtml).problems
  check('附加夹具：en 有而 zh 无 → 判红（两份手抄漂移）', mentions(drift, 'en 有 E1008 而 zh 没有'))
  check('附加夹具：漂移同时报出「zh 缺」这层原因', mentions(drift, 'zh 缺 E1008'))

  // --- 附加：范围判据本身有效（非 UPDATE_ 码不参与比对） ---
  check(
    '附加夹具：非 UPDATE_ 的码（E1004）不要求前端有文案',
    cleanResult.problems.every((problem) => !problem.includes('E1004'))
  )

  // --- 夹具 P6：Rust 侧码值重复（**全量**，不限 UPDATE_ 前缀） ---
  const p6Rust = [
    'pub mod codes {',
    '    pub const UPDATE_CHECK_NETWORK: &str = "E1005";',
    '    pub const UPDATE_SIGNATURE_REJECTED: &str = "E1008";',
    '    pub const DUPLICATE_OF_SIGNATURE: &str = "E1008";',
    '}'
  ].join('\n')
  check(
    '夹具 P6：两个常量共用一个码 → 判红',
    mentions(checkParity(p6Rust, clean.html).problems, 'Rust 侧重复码 E1008')
  )
  // 这条是「全量」的证明：若实现退化成只查 UPDATE_*，这两条会假绿。
  const p6Foreign = [
    'pub mod codes {',
    '    pub const UPDATE_CHECK_NETWORK: &str = "E1005";',
    '    pub const UPDATE_SIGNATURE_REJECTED: &str = "E1008";',
    '    pub const LOG_DIR_UNWRITABLE: &str = "E4001";',
    '    pub const SOMETHING_ELSE: &str = "E4001";',
    '}'
  ].join('\n')
  check(
    '夹具 P6：非 UPDATE_ 前缀的重复同样判红（这是「全量」而非「子集」的判据）',
    mentions(checkParity(p6Foreign, clean.html).problems, 'Rust 侧重复码 E4001')
  )

  // --- 夹具 P7：前端引用 ⊆ Rust 全量码（含注释与散文里的引用） ---
  const refOk = [{ path: 'src-tauri/frontend/updates.html', text: '// E1005 与 E1008 都在 Rust 里\nconst a = 1\n' }]
  check(
    '夹具 P7：引用的码都存在 → 不额外判红',
    checkParity(clean.rust, clean.html, refOk).problems.length === 0
  )
  const refBad = [{ path: 'src-tauri/frontend/error.html', text: '// 顺手写了个 E9999\n' }]
  const p7 = checkParity(clean.rust, clean.html, refBad).problems
  check('夹具 P7：引用了 Rust 不存在的码 → 判红', mentions(p7, '前端引用了 E9999'))
  check('夹具 P7：判红必须点名文件与行号', mentions(p7, 'error.html:1'))
  // 与「文案表」不同：注释里点名一个不存在的码也算红。旧版 P4 刻意比文案表更宽。
  check(
    '夹具 P7：注释里的引用同样被扫到（比文案表更宽的那一维）',
    mentions(checkParity(clean.rust, clean.html, [{ path: 'x.html', text: '/* 见 E7777 */' }]).problems, 'E7777')
  )
  // 非 UPDATE_ 的码只要 Rust 里存在就不该红——否则 error.html 引用 E3003 会假红。
  const refForeign = [{ path: 'src-tauri/frontend/error.html', text: 'E1004 是环境族（Rust 有）\n' }]
  check(
    '夹具 P7：非 UPDATE_ 的引用只要 Rust 存在就不判红',
    checkParity(clean.rust, clean.html, refForeign).problems.length === 0
  )
  check(
    '夹具 P7：一处引用都没扫到 → 判红（空集不得冒充通过）',
    mentions(checkParity(clean.rust, clean.html, []).problems, '空集不得冒充通过')
  )
  // 不传第三参数 = 本调用不适用引用判据（纯内存夹具只测前两维），不得因此报空集。
  check('夹具 P7：不传引用样本时该判据整体跳过', !mentions(cleanResult.problems, '空集不得冒充通过'))

  // --- 真实仓库自洽（读的是真文件，防「夹具全绿、真实形状解析不出来」） ---
  if (existsSync(errorsRsPath) && existsSync(updatesHtmlPath)) {
    const real = checkParity(
      readFileSync(errorsRsPath, 'utf8'),
      readFileSync(updatesHtmlPath, 'utf8'),
      existsSync(frontendDir) ? collectFrontendSources() : []
    )
    check('真实仓库：码表双向一致（本项失败说明当前工作区已有漂移）', real.problems.length === 0)
    if (real.problems.length > 0) for (const problem of real.problems) console.error('  · ' + problem)
    check('真实仓库：Rust 侧解析出 ≥ 1 个 UPDATE_* 码', real.rustCodes.size > 0)
    check('真实仓库：Rust 全量码解析出 ≥ 1 个（P6/P7 的输入非空）', real.allRustCodes.size > 0)
    check(
      '真实仓库：前端引用扫出 > 0 处（扫描器没空转）',
      real.references.length > 0
    )
    if (real.references.length === 0) {
      console.error('  · 引用扫描根目录：' + relative(projectRoot, frontendDir))
    }
  }

  if (failed > 0) {
    console.error('verify-error-code-parity self-test: ' + failed + ' 项失败')
    exit(1)
  }
  console.log('verify-error-code-parity self-test: 全部通过（P1~P5 五条失败条件 + P6 码值唯一性 + P7 引用存在性）')
  exit(0)
}

// ---------------------------------------------------------------------------
// 真检查
// ---------------------------------------------------------------------------

function main() {
  for (const [label, path] of [
    ['errors.rs', errorsRsPath],
    ['updates.html', updatesHtmlPath]
  ]) {
    if (!existsSync(path)) {
      console.error('❌ 找不到 ' + label + '：' + path)
      exit(1)
    }
  }

  const result = checkParity(
    readFileSync(errorsRsPath, 'utf8'),
    readFileSync(updatesHtmlPath, 'utf8'),
    existsSync(frontendDir) ? collectFrontendSources() : []
  )

  if (result.problems.length > 0) {
    console.error('❌ 错误码表漂移 ' + result.problems.length + ' 处：')
    for (const problem of result.problems) console.error('  · ' + problem)
    console.error('')
    console.error('  修法：前端两张 code 表都是 crates/dsh-contracts/src/errors.rs 里 `UPDATE_*`')
    console.error('  常量的手抄副本——Rust 改码就同步改 en / zh 两份，反之亦然。')
    console.error('  若报「前端引用了 X 但 codes 模块里没有」，改的是引用的那一侧（通常是注释里的笔误）。')
    exit(1)
  }

  console.log(
    '✅ 错误码一致：Rust ' + result.rustCodes.size + ' 个 `' + UPDATE_CODE_PREFIX + '*` 码 ↔ ' +
      LANGUAGES.map((lang) => lang + ' ' + result.tables[lang].size + ' 条文案').join(' / ') +
      ' · 全量码 ' + result.allRustCodes.size + ' 个无重复 · 前端引用 ' + result.references.length + ' 处全部存在'
  )
  exit(0)
}

// 只在**被当脚本执行**时跑检查：本文件的判定函数是导出的纯函数（自测与
// 「拿真实文件做定向变异」的探针都直接 import 它们），import 时执行 `main()`
// 会让调用方莫名其妙 exit。
const invokedAsScript =
  argv[1] !== undefined && pathToFileURL(resolve(argv[1])).href === import.meta.url

if (invokedAsScript) {
  if (argv.includes('--self-test')) selfTest()
  main()
}
