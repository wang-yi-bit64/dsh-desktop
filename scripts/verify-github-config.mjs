#!/usr/bin/env node
/**
 * verify-github-config.mjs — .github/ 下的配置准入守卫（ADR-054）
 *
 * ## 它守什么（五条规则，各自都能静默失效）
 *
 * A. **工作流必须住在 .github/workflows/ 下**。GitHub Actions 只从该目录加载文件；
 *    放在别处的工作流是「看得见、从不运行」的死配置——YAML 合法、编辑器有高亮、
 *    commit 标题也能把它记成已交付，而它一次都不会跑。
 *    真实案例：2026-09-29 的 e9f8dc5「Add Qodo AI PR Agent workflow」把文件放在了
 *    .github/pr-agent.yml。本规则就是为它写的。
 *
 * B. **第三方 action 必须钉到 40 位 commit SHA**。浮动 ref（@v5 / @main / @stable）
 *    会在上游被改动时静默换掉代码——本仓持有发布签名私钥，那是最不该有的组合。
 *
 * C. **未加引号的标量里不允许出现 `: `（冒号 + 空格）**（见下方专节）。
 *
 * D. **CODEOWNERS 必须是「合法且非全绿恒真」的**（2026-10-08 新增）。
 *    CODEOWNERS 没有解析器、没有编译器、GitHub 对非法行**静默跳过**（不报错），
 *    因此它天然落在本文件要守的「配置看着在、实际不生效」这一类里。本规则查四点，
 *    每一点都对应一次真实踩坑或一条官方口径：
 *      D1. `*`（默认所有者）**必须在第一条规则**。GitHub 是「最后匹配生效」，
 *          而单个 `*` 的匹配范围等价于 `**` + `/*`（**含任意层级**）。把它当兜底放末尾
 *          会盖掉上面每一条细则，整个文件退化成「所有文件归同一个人」——
 *          配置合法、GitHub 不报错、hover 显示有 owner，**只是你的划分全废了**。
 *          官方示例把 `*` 写在开头并注明 "Unless a later match takes precedence"。
 *      D2. 每条规则恰有 1 个 owner，且是 `@user` 形态（`@org/team` 需 org 存在，
 *          本仓是个人仓库）。owner 写错一个字符 GitHub 只忽略该条、不报错。
 *      D3. **目录型规则必须与它的父目录同值**。CODEOWNERS 里「后面的规则覆盖前面的」
 *          是唯一收窄手段，因此「宽在前、窄在后」才有效；反之则该目录下的细则全是
 *          **装饰**——它们仍然存在、仍然能被 grep 到、reviewer 仍然相信它们在生效。
 *          本规则用值比较而非匹配模拟来判定：同一个 owner 下，父目录规则与子路径
 *          规则的先后顺序不影响归属结果，只有**owner 不同**时才需要顺序保证。
 *          因此本仓「全部规则同 owner」时 D3 恒真——它防的是**将来加了协作者之后**，
 *          有人按直觉把具体规则写在泛化规则前面。
 *      D4. 模式不能含 `!` 取反 / `[ ]` 字符范围——这两条是 gitignore 语法，
 *          在 CODEOWNERS 里**不生效**（GitHub 文档明列）。写了等于没写。
 *
 * E. **已退役的工作流不得复活**（ADR-062，2026-10-09 新增）。
 *    `.github/workflows/pullfrog.yml` 按 ADR-058 删除过一次，随后**被恢复过一次**
 *    （commit `d286f44`）。这就是「把禁令写在散文里」的实测结果：散文没有执行者，
 *    下一个人（或下一个 agent）读到的只是一段说明，而恢复文件不需要通过任何检查。
 *    因此本条把禁令**写死成机器可判据**（`RETIRED_WORKFLOWS` 表）：文件重新出现即报红。
 *    它还额外守一条**空集判据**——**禁令表被清空同样报红**：清空这张表等于删掉禁令，
 *    而那种删除与「文件复活」一样静默（AGENTS.md §7.3：扫出 0 个不得冒充通过）。
 *    正当出路是**另立新工作流**（新文件名 + 新 ADR 过准入），不是复活旧文件。
 *
 * ## 为什么 B 有一张基线表
 * `PRE_EXISTING_FLOATING` 是**预先存在**的浮动 ref，属 docs/dev-plan-defect-remediation.md
 * 的 S3-3，尚未执行。本守卫对**新增**浮动 ref 一律报错（防回归），并在基线非空时打印
 * 提示。S3-3 执行后基线必须清空——空表是本守卫的目标状态（与 ALLOW_UNUSED_COMMANDS 同形）。
 *
 * ## 可证伪性
 * --self-test 以「修复前的真实形态」为夹具（错放目录的工作流、@v5 的 action）：
 * 喂进去必须报红。这些夹具用的就是本仓自己踩过的写法，不是构造出来的玩具。
 * D 的夹具同样是**本文件初版真实写错的两处**（`*` 放末尾、`/docs/` 写在
 * `/docs/adr/` 之后），不是假想形态。
 * E 的夹具同样是真实形态：`pullfrog.yml` 确实**复活过一次**（`d286f44`），
 * 因此「文件重新出现 ⇒ 报红」这条断言不是假想分支。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { argv, exit } from 'node:process'

const ROOT = process.cwd()
const WORKFLOW_DIR = join('.github', 'workflows')

/**
 * 基线外的浮动 ref 白名单。**空表是目标状态**——S3-3（2026-09-30）已把全部 7 个
 * 预先存在的浮动 ref 钉到 40 位 SHA，此后任何浮动 ref（不管新旧）一律报红；
 * 本表留作「将来确需豁免时在此登记 + 写理由」的机制，加条目必须附理由。
 */
export const PRE_EXISTING_FLOATING = []

/** 一个文件是否是「工作流形态」：同时出现顶层的 on: 与 jobs:。 */
export function isWorkflowShaped(text) {
  return /^on:/m.test(text) && /^jobs:/m.test(text)
}

/** 抽出所有 uses 的 ref（去注释、去引号）。 */
export function extractUses(text) {
  const refs = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/.exec(line)
    if (m) refs.push(m[1].replace(/["']/g, ''))
  }
  return refs
}

export function isShaPinned(ref) {
  const at = ref.lastIndexOf('@')
  if (at === -1) return false
  return /^[0-9a-f]{40}$/i.test(ref.slice(at + 1))
}

export function checkUsesRefs(file, refs, allowedFloating = PRE_EXISTING_FLOATING) {
  const problems = []
  for (const ref of refs) {
    if (ref.startsWith('./') || ref.startsWith('docker://')) continue
    if (isShaPinned(ref)) continue
    if (allowedFloating.includes(ref)) continue
    problems.push(
      file + '：uses 未钉 SHA → ' + ref +
        '（第三方 action 必须钉到 40 位 commit SHA；浮动 ref 会在上游被改动时静默换代码）',
    )
  }
  return problems
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.ya?ml$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * C. **未加引号的标量里不允许出现 `: `（冒号 + 空格）**。
 *
 * YAML 的纯标量（plain scalar）不包含 `冒号+空格`——出现即被解析成**嵌套映射的键**。
 * GitHub Actions 的加载器对这类文件不会明确报错，而是直接**不认这个 trigger**：
 * 2026-10-06 实测，`- name: Static gates (single source of truth: scripts/gate-manifest.mjs)`
 * 让 `POST /actions/workflows/ci.yml/dispatches` 返回
 * `422 Workflow does not have 'workflow_dispatch' trigger`——而文件里明明写着
 * `workflow_dispatch:`。后果是 CI **无法被手动触发**，且没有任何提示指向这一行。
 *
 * 修法：给整个值加双引号。注意这条**不能用 YAML 解析器兜住**：`yaml.safe_load`
 * 能通过被 `#` 截断的形态（见 authoring-github-workflows 技能），对 `: ` 也只是
 * 在严格模式下才报错；actionlint 能抓住它，但本仓 CI 不跑 actionlint。
 * 因此这里做定向静态检查：只查 `name:` / `run-name:` / `if:` 三种**步级键**，
 * 值未加引号且含 `: ` 即报红。
 */

/** 会被本条规则检查的键（步级，避免误伤 block scalar 内部）。 */
const SCALAR_KEYS = ['name', 'run-name', 'if']

/**
 * 扫描文本里所有 name / run-name / if 标量，并标记哪些是**未加引号且含 `: `**的。
 * @param {string} text
 * @returns {{ line: number, raw: string, unsafe: boolean }[]}
 */
export function scanScalars(text) {
  const found = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*(?:-\s*)?)(name|run-name|if):(\s+)(\S.*)$/.exec(lines[i])
    if (m === null) continue
    if (!SCALAR_KEYS.includes(m[2])) continue
    const value = m[4]
    // 已加引号 / 块标量 / 流式集合开头 → 不归本条管
    const exempt = /^["'|>&*?[\]{}]/.test(value)
    found.push({ line: i + 1, raw: lines[i], unsafe: !exempt && /: /.test(value) })
  }
  return found
}

/**
 * 只取其中「未加引号且含 `: `」的那些（即违例）。
 * @param {string} text
 * @returns {{ line: number, raw: string }[]}
 */
export function extractUnsafeScalars(text) {
  return scanScalars(text)
    .filter((s) => s.unsafe)
    .map(({ line, raw }) => ({ line, raw }))
}

/**
 * 解析 CODEOWNERS 文本成规则列表。
 *
 * 只做**保守**解析：不认识的行（缺 owner、`!` 取反等）会被原样留下交给调用方判，
 * 而不是静默丢弃——静默丢弃正是本文件要防的形态（GitHub 对非法行就是这么做的）。
 *
 * @param {string} text
 * @returns {{ line: number, raw: string, pattern: string, owners: string[] }[]}
 */
export function parseCodeowners(text) {
  const rules = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const bare = raw.replace(/#.*$/, '').trim()
    if (bare === '') continue
    const parts = bare.split(/\s+/)
    rules.push({ line: i + 1, raw, pattern: parts[0], owners: parts.slice(1) })
  }
  return rules
}

/** `@user` 或 `@org/team`（另允许邮箱形态，但本仓不用）。 */
const OWNER_RE = /^(?:@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9._-]+)?|[^\s@]+@[^\s@]+\.[^\s@]+)$/

/**
 * CODEOWNERS 准入检查（规则 D）。
 *
 * @param {string} text CODEOWNERS 全文
 * @param {(rel: string) => string[]} listFiles 给定目录返回其下的文件（相对仓库根、posix 风格）；
 *        用于判断「目录规则是否覆盖到真实文件」——扫出数为 0 时不能判通过（AGENTS §7.3）。
 * @returns {{ problems: string[], ruleCount: number, dirRules: number, matchedFiles: number }}
 */
export function checkCodeowners(text, listFiles) {
  const problems = []
  const rules = parseCodeowners(text)

  if (rules.length === 0) {
    problems.push(
      'CODEOWNERS 里扫出 0 条规则——这不是「干净」，是解析器或文件失效了。先怀疑解析器，再怀疑源码（AGENTS.md §7.3）。',
    )
    return { problems, ruleCount: 0, dirRules: 0, matchedFiles: 0 }
  }

  // D1：`*` 必须在第一条规则。
  const starIdx = rules.findIndex((r) => r.pattern === '*')
  if (starIdx === -1) {
    problems.push(
      'CODEOWNERS 缺少 `*` 默认所有者规则。没有它，未被任何细则命中的文件**不会有 code owner**，' +
        '分支保护下这类改动无人被要求 review。',
    )
  } else if (starIdx !== 0) {
    problems.push(
      `CODEOWNERS:${rules[starIdx].line}：` + '`*` 默认所有者必须是**第一条规则**，现在排在第 ' +
        (starIdx + 1) + ' 条。' +
        'GitHub 是「最后匹配生效」，而单个 `*` 的匹配范围等价于 `**/*`（含任意层级），' +
        '放在后面它会盖掉上面每一条细则——文件仍合法、GitHub 不报错、hover 仍显示 owner，' +
        '但你的路径划分**全部失效**。官方示例把 `*` 写在开头（"Unless a later match takes precedence"）。',
    )
    // 同一问题会在归因上层层伪装，这里额外把「被盖掉」的条数说清楚，避免读者以为只是顺序难看。
    const shadowedPatterns = rules.slice(0, starIdx).map((r) => r.pattern)
    if (shadowedPatterns.length > 0) {
      // ⚠️ 不要在这条模板字符串里写反引号包住的 `*` —— 反引号会**提前结束模板字面量**
      // （本行初版就因此把 message 拼成 NaN，夹具抓出来的）。用单引号形态描述它。
      problems.push(
        '↳ 具体后果：上面 ' + shadowedPatterns.length + ' 条细则（' +
          shadowedPatterns.join(', ') + '）已被那条 * 规则全部盖掉。',
      )
    }
  }

  // D2：每条规则恰有 1 个合法 owner。
  for (const r of rules) {
    if (r.owners.length === 0) {
      problems.push(
        `CODEOWNERS:${r.line}：规则 \`${r.pattern}\` 没有 owner。` +
          'GitHub 会把该行**静默跳过**（不报错）——看着有规则，实际没人被指派。',
      )
      continue
    }
    if (r.owners.length > 1) {
      problems.push(
        `CODEOWNERS:${r.line}：规则 \`${r.pattern}\` 有 ${r.owners.length} 个 owner。` +
          '本仓是单人仓库，多 owner 会让人误以为存在审批分工。' +
          '（GitHub 语义：同一 pattern 的多 owner 须在同一行，任一批准即可。）',
      )
    }
    for (const o of r.owners) {
      if (!OWNER_RE.test(o)) {
        problems.push(
          `CODEOWNERS:${r.line}：owner \`${o}\` 形态非法。` +
            '必须是 `@user` 或 `@org/team`；写错一个字符 GitHub 只忽略该条、**不报错**。',
        )
      }
      if (o.includes('/')) {
        problems.push(
          `CODEOWNERS:${r.line}：owner \`${o}\` 是团队形态。` +
            '本仓是**个人公开仓库**（owner 与唯一 collaborator 均为 wang-yi-bit64，无组织），' +
            '不存在的团队会被 GitHub 静默忽略 ⇒ 该规则永不生效。用 `@wang-yi-bit64`。',
        )
      }
    }
  }

  // D4：`!` 取反 / `[ ]` 字符范围是 gitignore 语法，CODEOWNERS 不支持（官方文档明列）。
  for (const r of rules) {
    if (r.pattern.startsWith('!')) {
      problems.push(
        `CODEOWNERS:${r.line}：模式 \`${r.pattern}\` 用了 \`!\` 取反——` +
          'CODEOWNERS **不支持**取反（GitHub 文档明列 gitignore 的 `!` 在此无效）。' +
          '要收窄范围只能靠「后面的规则覆盖前面的」。',
      )
    }
    if (/\[[^\]]*\]/.test(r.pattern)) {
      problems.push(
        `CODEOWNERS:${r.line}：模式 \`${r.pattern}\` 用了 \`[ ]\` 字符范围——` +
          'CODEOWNERS **不支持**（同上）。',
      )
    }
  }

  // D3：泛化规则（祖先目录）与其下的具体规则**若 owner 不同**，泛化必须在前。
  //     同 owner 时顺序不影响结果，因此本仓恒真；防的是加协作者后按直觉写反。
  const dirRules = rules.filter((r) => r.pattern.endsWith('/') && r.pattern !== '*/')
  let matchedFiles = 0
  for (const ancestor of dirRules) {
    const base = ancestor.pattern.replace(/^\//, '').replace(/\/$/, '')
    for (const descendant of rules) {
      if (descendant === ancestor) continue
      const dBase = descendant.pattern.replace(/^\//, '').replace(/\/$/, '')
      const isUnder =
        dBase !== base && (dBase.startsWith(base + '/') || dBase === base)
      if (!isUnder) continue
      if (descendant.line < ancestor.line) {
        problems.push(
          `CODEOWNERS:${descendant.line}：\`${descendant.pattern}\` 是 \`${ancestor.pattern}\` 的子孙，` +
            '却排在它**前面**——「最后匹配生效」会让祖先规则反过来盖掉这条细则。' +
            '把宽的写在前面、窄的写在后面。',
        )
      }
    }
    // 该目录规则是否真的覆盖到文件？扫出 0 个要报，否则守卫在替不存在的检查背书。
    const files = typeof listFiles === 'function' ? listFiles(base) : []
    if (files.length === 0) {
      // 目录不存在本身不算错（例如 packages/ 在两条线都清空后确实为空），但必须**显式说明**。
      problems.push(
        `CODEOWNERS:${ancestor.line}：目录规则 \`${ancestor.pattern}\` 在仓库里找不到对应文件或目录。` +
          '若该目录确实还不存在（尚未创建的占位），请确认这是有意的；' +
          '若目录已改名或删除，这条规则是死规则，应同步更新。',
      )
    } else {
      matchedFiles += files.length
    }
  }

  return { problems, ruleCount: rules.length, dirRules: dirRules.length, matchedFiles }
}

/** 纯函数：给定 [{path, text}]，返回 problems。路径用 posix 风格以便跨平台判据一致。 */
export function checkFiles(files, allowedFloating = PRE_EXISTING_FLOATING) {
  const problems = []
  let workflowShaped = 0
  let useRefs = 0
  let misplaced = 0
  let scalarKeys = 0
  for (const f of files) {
    const p = f.path.split(sep).join('/')
    const inWorkflows = p.startsWith('.github/workflows/')
    const shaped = isWorkflowShaped(f.text)
    if (shaped) workflowShaped += 1
    if (shaped && !inWorkflows) {
      misplaced += 1
      problems.push(
        p + '：这是**工作流形态**的 YAML（含顶层 on: 与 jobs:），却不在 .github/workflows/ 下——' +
          'GitHub 从不加载它，它会静默地不运行。挪进 .github/workflows/ 或删掉（ADR-005）。',
      )
    }
    if (inWorkflows) {
      const refs = extractUses(f.text)
      useRefs += refs.length
      problems.push(...checkUsesRefs(p, refs, allowedFloating))
      const scalars = scanScalars(f.text)
      scalarKeys += scalars.length
      for (const u of scalars.filter((s) => s.unsafe)) {
        problems.push(
          `${p}:${u.line}：未加引号的标量里含「冒号 + 空格」——YAML 会把它解析成嵌套映射键，` +
            'GitHub Actions 会因此不认该文件的 trigger（实测表现：dispatch 报 ' +
            '`Workflow does not have \'workflow_dispatch\' trigger`）。修法：给整个值加双引号。',
        )
      }
    }
  }
  if (workflowShaped === 0) {
    problems.push(
      '扫出 0 个工作流形态的文件——这不是「干净」，是扫描器失效了。' +
        '先怀疑扫描器，再怀疑源码（AGENTS.md §7.3）。',
    )
  }
  if (useRefs === 0) {
    problems.push('扫出 0 个 uses 引用——同上，扫描器或工作流目录有问题，不得判通过。')
  }
  if (scalarKeys === 0 && workflowShaped > 0) {
    // 「扫出来再校验」纪律：扫出 0 个不是干净，多半是扫描器不认新写法。
    // 注意这里数的是**扫出的标量总数**，不是违例数——违例为 0 是健康状态。
    problems.push(
      '扫出 0 个 name / run-name / if 标量——工作流不可能没有步骤名，先怀疑扫描器，再怀疑源码。',
    )
  }
  return { problems, workflowShaped, useRefs, misplaced, scalarKeys }
}

/**
 * 退役工作流禁令表（规则 E 的唯一产地，ADR-062）。
 *
 * ⚠️ 这张表是**写死的**，不是从别处推导来的：「哪些工作流被永久移除」无法由仓库当前
 * 状态推出（文件不在，就什么线索都没有），只能显式登记。加条目必须同时：
 *   · 在对应 ADR 里写明**为什么不可恢复**（不是「暂时停用」）；
 *   · 确认它在仓库里已无任何消费方（否则删除会让别的门禁/工作流失效）。
 *
 * ⚠️ **本表不得清空**：清空 == 删掉禁令。判据见 {@link checkRetiredWorkflows}。
 *
 * @type {{ file: string, adr: string, retired: string, irreversible: string, why: string }[]}
 */
export const RETIRED_WORKFLOWS = [
  {
    file: '.github/workflows/pullfrog.yml',
    adr: 'ADR-062',
    retired: '2026-09-30',
    irreversible: '2026-10-09',
    why:
      '厂商模板原样入库、仅 workflow_dispatch 触发，在仓库内零消费方，' +
      '并在 SECURITY.md 里挂着 13 个 provider key 的暴露面。ADR-058 已裁定停用，' +
      '但它把「从 git 历史取回文件」写成了正当的恢复路径 ⇒ 该文件被恢复过一次' +
      '（commit d286f44）。ADR-062 关闭该路径：禁令写死在本表，文件重现即报红。',
  },
]

/**
 * 规则 E：已退役的工作流不得复活（ADR-062）。
 *
 * ## 为什么是「文件存在性」而不是「文件内容」
 *
 * 判据只问一件事：**这个路径在不在**。不做内容扫描是有意的——本仓已两次踩过
 * 「『不得出现』类判据被自己的文档命中」的坑（本文件的 E 段注释里就逐字写着
 * `pullfrog.yml`）。存在性判据没有这个失效模式。
 *
 * ## 空集判据（AGENTS.md §7.3）
 *
 * `retired` 为空时**不得判通过**：空表意味着「禁令被删掉了」，而删掉禁令与复活文件
 * 一样静默。这与本文件其它「扫出 0 个必须报红」的断言同形。
 *
 * @param {string[]} presentFiles 当前仓库里实际存在的文件（相对仓库根，任意分隔符）。
 * @param {typeof RETIRED_WORKFLOWS} [retired] 禁令表；默认 {@link RETIRED_WORKFLOWS}。
 * @returns {{ problems: string[], checked: number, revived: number }}
 */
export function checkRetiredWorkflows(presentFiles, retired = RETIRED_WORKFLOWS) {
  const problems = []
  if (!Array.isArray(retired) || retired.length === 0) {
    problems.push(
      '退役工作流禁令表是空的。这不是「没有退役项」，是**禁令被删掉了**——' +
        '空表与「文件复活」一样静默（AGENTS.md §7.3：扫出 0 个不得冒充通过）。' +
        '若确实不再需要任何禁令，请连同 ADR-062 与 ADR-058 的修订行一起显式处置。',
    )
    return { problems, checked: 0, revived: 0 }
  }
  const present = new Set(presentFiles.map((p) => String(p).split(sep).join('/')))
  let revived = 0
  for (const item of retired) {
    if (!present.has(item.file)) continue
    revived += 1
    problems.push(
      `${item.file} 又出现了——该文件已于 ${item.retired} 被永久移除（${item.adr}，` +
        `不可恢复声明于 ${item.irreversible}）。原因：${item.why}\n` +
        '   禁止复活：GitHub 只从 .github/workflows/ 加载工作流，文件存在 == 工作流存在，' +
        '它会立刻重新出现在可触发列表里，并重新带上那 13 个 provider key 的 secrets 暴露面。\n' +
        '   正当出路：需要按需 agent 时**另立新工作流**（新文件名 + 新 ADR 过 ADR-054 的准入），' +
        '不要复活这个文件。若确要推翻本禁令，须先显式改掉 ADR-062 与本表——那是有意的摩擦。',
    )
  }
  return { problems, checked: retired.length, revived }
}

function main() {
  const files = walk(join(ROOT, '.github')).map((full) => ({
    path: relative(ROOT, full),
    text: readFileSync(full, 'utf8'),
  }))
  const { problems, workflowShaped, useRefs, misplaced, scalarKeys } = checkFiles(files)
  console.log(
    '· 扫描 .github 下 ' + files.length + ' 个 YAML：工作流形态 ' + workflowShaped +
      ' 个 · uses 引用 ' + useRefs + ' 个 · 错放 ' + misplaced + ' 个' +
      ' · 未加引号标量 ' + scalarKeys + ' 个',
  )
  if (PRE_EXISTING_FLOATING.length > 0) {
    console.log(
      '· 提示：仍有 ' + PRE_EXISTING_FLOATING.length + ' 个预先存在的浮动 ref 在基线表里' +
        '（S3-3 未执行）。空表是目标状态。',
    )
  }

  // 规则 D：CODEOWNERS 准入。
  // ⚠️ 它**不是** YAML，因此不在上面的 walk() 收集面里；这里单独读。
  const coPath = join(ROOT, '.github', 'CODEOWNERS')
  if (!existsSync(coPath)) {
    problems.push(
      '.github/CODEOWNERS 不存在。本仓要求它有两条理由：(1) 分支保护一旦开启，' +
        '「Require review from Code Owners」需要有它才有效；(2) 路径 → 审核人的划分是仓库内可评审的事实。' +
        '若有意删除，请同时更新 docs/adr/ 与删除本条断言（不要留下「文件没了、守卫还在找它」的状态）。',
    )
  } else {
    const coText = readFileSync(coPath, 'utf8')
    // 目录规则的「是否覆盖到真实文件」判定：直接看磁盘（不管是否被 git 跟踪——
    // 这条只用来区分「目录不存在」与「目录存在但空」，两者都合法，语气不同而已）。
    const co = checkCodeowners(coText, (rel) => {
      const dir = join(ROOT, rel)
      if (!existsSync(dir)) return []
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    })
    // 占位目录的说明不是错误，降级为提示；其余是错误。
    for (const p of co.problems) {
      if (/找不到对应文件或目录/.test(p)) {
        console.log('· 提示：' + p)
      } else {
        problems.push(p)
      }
    }
    console.log(
      '· CODEOWNERS：' + co.ruleCount + ' 条规则 · 目录规则 ' + co.dirRules + ' 条 · ' +
        '目录规则共匹配 ' + co.matchedFiles + ' 个条目',
    )
    if (co.ruleCount === 0) {
      problems.push('CODEOWNERS 扫出 0 条规则——先怀疑解析器，再怀疑源码（AGENTS.md §7.3）。')
    }
    if (co.dirRules > 0 && co.matchedFiles === 0) {
      problems.push(
        'CODEOWNERS 的目录规则一条都没匹配到仓库内容——「扫出来再校验」的扫出数为 0，' +
          '不得判通过（AGENTS.md §7.3）。',
      )
    }
  }

  // 规则 E：退役工作流不得复活（ADR-062）。
  // 判据只看「路径在不在」，不扫内容——见 checkRetiredWorkflows 的注释。
  const retired = checkRetiredWorkflows(files.map((f) => f.path))
  console.log(
    '· 退役工作流禁令：' + retired.checked + ' 项在册 · 复活 ' + retired.revived + ' 项',
  )
  problems.push(...retired.problems)

  if (problems.length > 0) {
    for (const p of problems) console.error('❌ ' + p)
    return 1
  }
  console.log('✅ .github 配置准入：工作流都在 workflows/ 下，没有未钉 SHA 的新增 action，已退役工作流未复活')
  return 0
}

export function selfTest() {
  let failed = 0
  // 计数器而不是手写的「通过 N 项」：手写的数字会随断言增删悄悄失真，
  // 而一个失真的数字本身就是错误宣称（本文件此前的 28 就是这么来的）。
  let passed = 0
  const check = (name, cond) => { passed += 1; if (!cond) { console.error('❌ ' + name); failed += 1 } }
  const misplacedSample = 'name: PR Agent\non:\n  pull_request:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: qodo-ai/pr-agent@main\n'
  const dependabotSample = 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: "/"\n'
  const pinnedWorkflow = 'on: [push]\njobs:\n  a:\n    steps:\n      - name: checkout\n        uses: actions/checkout@' + 'a'.repeat(40) + '\n'
  // ⚠️ 夹具不能用 actions/checkout@v5 —— 它在基线表里（预先存在），拿它当夹具等于
  // 让断言恒真。可证伪夹具必须用**基线之外**的浮动 ref，这正是 S3-3 之后的世界。
  const floatingWorkflow = 'on: [push]\njobs:\n  a:\n    steps:\n      - uses: some/other-action@v5\n'
  const newFloating = 'on: [push]\njobs:\n  a:\n    steps:\n      - uses: some/new-action@main\n'
  const localAction = 'on: [push]\njobs:\n  a:\n    steps:\n      - name: local\n        uses: ./.github/actions/local\n'

  check('依赖形态判定：错放的 pr-agent 是工作流形态', isWorkflowShaped(misplacedSample))
  check('依赖形态判定：dependabot.yml 不是工作流形态', !isWorkflowShaped(dependabotSample))
  // 🔴 可伪证夹具 1：错放目录必须报红
  const r1 = checkFiles([{ path: join('.github', 'pr-agent.yml'), text: misplacedSample }])
  check('可伪证：错放目录的工作流必须报红', r1.problems.some((p) => /不在 .github\/workflows\//.test(p)))
  // 🔴 可伪证夹具 2：@v5 必须报红
  const r2 = checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: floatingWorkflow }])
  check('可伪证：@v5 必须报红（基线之外）', r2.problems.some((p) => /未钉 SHA/.test(p)))
  // 基线机制要**显式被断言**，否则「基线兜住本该报红的写法」这件事没人看得见。
  // S3-3（2026-09-30）后全局基线是**空表**，因此机制测试改为注入式：显式传一个
  // 带浮动 ref 的 allowedFloating，验证该机制本身仍工作；空基线下的真实仓库里
  // 同样的写法必须报红（与可伪证夹具 2 同一条断言）。
  check(
    '基线机制：显式注入的 allowedFloating 必须放行其条目',
    checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: 'on: [push]\njobs:\n  a:\n    steps:\n      - name: checkout\n        uses: actions/checkout@v5\n' }], ['actions/checkout@v5']).problems.length === 0
  )
  check('S3-3 后基线为空：checkout@v5 在真实仓库里必须报红', checkUsesRefs('x.yml', ['actions/checkout@v5'], PRE_EXISTING_FLOATING).length === 1)
  const r3 = checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: pinnedWorkflow }])
  check('钉了 SHA 必须通过', r3.problems.length === 0)
  const r4 = checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: localAction }])
  check('本地 action（./）豁免', r4.problems.length === 0)
  const r5 = checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: newFloating }])
  check('基线之外的新浮动 ref 必须报红', r5.problems.some((p) => /未钉 SHA/.test(p)))
  check('dependabot 不进工作流规则', checkFiles([{ path: join('.github', 'dependabot.yml'), text: dependabotSample }, { path: join('.github', 'workflows', 'x.yml'), text: pinnedWorkflow }]).problems.length === 0)
  // 🔴 可伪证夹具 4：真实事故行——`- name: Static gates (single source of truth: …)`
  //    它在 2026-10-06 之前让 ci.yml / release.yml 都无法被 workflow_dispatch 触发。
  const colonSpaceWorkflow = [
    'on:',
    '  workflow_dispatch:',
    '  schedule:',
    "    - cron: '41 2 * * *'",
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Static gates (single source of truth: scripts/gate-manifest.mjs)',
    '        run: npm run gate',
    '      - uses: actions/checkout@' + 'a'.repeat(40),
    '',
  ].join('\n')
  const r7 = checkFiles([{ path: join('.github', 'workflows', 'ci.yml'), text: colonSpaceWorkflow }])
  check(
    '可伪证：未加引号标量含「冒号+空格」必须报红（真实事故：dispatch 失效）',
    r7.problems.some((p) => /冒号 \+ 空格/.test(p)),
  )
  // 同一行加引号后必须放行——否则本条规则会把所有步骤名都毙掉。
  const quoted = colonSpaceWorkflow.replace(
    '- name: Static gates (single source of truth: scripts/gate-manifest.mjs)',
    '- name: "Static gates (single source of truth: scripts/gate-manifest.mjs)"',
  )
  check(
    '加引号后必须放行',
    checkFiles([{ path: join('.github', 'workflows', 'ci.yml'), text: quoted }]).problems.length === 0,
  )
  // run: / shell: 这类块标量与普通字符串值不归本条管（不含冒号空格也不该被误报）。
  check(
    '普通步骤名不受影响',
    extractUnsafeScalars('jobs:\n  a:\n    steps:\n      - name: build\n        run: make\n').length === 0,
  )
  // 已加引号 / 流式开头 / 块标量三种形态都不报。
  check(
    '引号、流式、块标量形态不误报',
    extractUnsafeScalars(
      '- name: "a: b"\n- run-name: ${{ inputs.x }}\n- if: |\n    a: b\n- name: [x, y]\n',
    ).length === 0,
  )
  // 「扫出 0 个标量」必须判失败（§7.3 纪律）：空夹具证明扫描器有输出能力。
  check(
    '扫出 0 个标量也必须报错而不是通过',
    checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: 'on: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@' + 'a'.repeat(40) + '\n' }]).problems.some((p) => /0 个 name/.test(p)),
  )
  // 🔴 可伪证夹具 3：扫出 0 个必须判失败（§7.3「扫出来再校验」纪律）
  const r6 = checkFiles([{ path: join('.github', 'dependabot.yml'), text: dependabotSample }])
  check('扫出 0 个工作流必须报错而不是通过', r6.problems.some((p) => /扫描器失效/.test(p)))
  check('uses 数量 0 也必须报错', checkFiles([{ path: join('.github', 'workflows', 'x.yml'), text: 'on: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n' }]).problems.some((p) => /0 个 uses/.test(p)))

  // ---------------------------------------------------------------------------
  // 规则 D：CODEOWNERS 的可证伪夹具
  //
  // 🔴 以下两个坏夹具是**本文件初版的真实写法**，不是构造出来的玩具：
  //    本文件第一次写 CODEOWNERS 时就同时踩了 D1（`*` 放末尾）与 D3（`/docs/`
  //    写在 `/docs/adr/` 之后），而两种写法都**没有**让任何工具报错——
  //    是 owner 归属模拟（`.workbuddy/tmp-co-sim.mjs`）把它们揪出来的。
  //    守卫必须能独立复现这两次误判，否则它只是装饰。
  // ---------------------------------------------------------------------------
  const coFiles = () => ['a.txt', 'b.txt'] // 目录存在且非空
  const goodCo = [
    '# 默认所有者必须最先',
    '*                             @wang-yi-bit64',
    '/.github/workflows/           @wang-yi-bit64',
    '/docs/                        @wang-yi-bit64',
    '/docs/adr/                    @wang-yi-bit64',
    '',
  ].join('\n')
  const good = checkCodeowners(goodCo, coFiles)
  check('D 好夹具：合法 CODEOWNERS 必须通过', good.problems.length === 0)

  // D1 🔴 真实误判 1：`*` 放末尾
  const starLast = [
    '/.github/workflows/           @wang-yi-bit64',
    '/docs/adr/                    @wang-yi-bit64',
    '*                             @wang-yi-bit64',
    '',
  ].join('\n')
  const d1 = checkCodeowners(starLast, coFiles)
  check(
    'D1 可伪证：`*` 放末尾必须报红（会盖掉全部细则）',
    d1.problems.some((p) => /必须是\*\*第一条规则\*\*/.test(p)),
  )
  check(
    'D1 报红时必须点名被盖掉的条目数（不能只说「顺序不对」）',
    d1.problems.some((p) => /已被那条 \* 规则全部盖掉/.test(p)),
  )
  // `*` 在开头时必须放行——否则这条规则会把正确写法也毙掉。
  check('D1 反向：`*` 在开头必须放行', checkCodeowners(goodCo, coFiles).problems.length === 0)

  // D3 🔴 真实误判 2：子孙规则排在祖先规则之前
  const descendantFirst = [
    '*                             @wang-yi-bit64',
    '/docs/adr/                    @wang-yi-bit64',
    '/docs/                        @wang-yi-bit64',
    '',
  ].join('\n')
  const d3 = checkCodeowners(descendantFirst, coFiles)
  check(
    'D3 可伪证：子孙规则排在祖先规则之前必须报红（细则是装饰）',
    d3.problems.some((p) => /却排在它\*\*前面\*\*/.test(p)),
  )

  // D2：owner 形态
  check(
    'D2 可伪证：团队 owner 在个人仓库必须报红（会被静默忽略）',
    checkCodeowners('*  @some-org/some-team\n', coFiles).problems.some((p) => /团队形态/.test(p)),
  )
  check(
    'D2 可伪证：没有 owner 的规则必须报红（GitHub 静默跳过该行）',
    checkCodeowners('*  @wang-yi-bit64\n/docs/\n', coFiles).problems.some((p) => /没有 owner/.test(p)),
  )
  check(
    'D2 可伪证：owner 写错形态必须报红',
    checkCodeowners('*  wang-yi-bit64\n', coFiles).problems.some((p) => /形态非法/.test(p)),
  )

  // D4：gitignore 专有语法在 CODEOWNERS 里不生效
  check(
    'D4 可伪证：`!` 取反必须报红（CODEOWNERS 不支持）',
    checkCodeowners('*  @wang-yi-bit64\n!docs/  @wang-yi-bit64\n', coFiles).problems.some((p) => /取反/.test(p)),
  )
  check(
    'D4 可伪证：`[ ]` 字符范围必须报红（CODEOWNERS 不支持）',
    checkCodeowners('*  @wang-yi-bit64\n/docs/*.[md]  @wang-yi-bit64\n', coFiles).problems.some((p) => /字符范围/.test(p)),
  )

  // 「扫出 0 条必须报错」纪律
  check(
    'D 扫出 0 条规则必须报错而不是通过',
    checkCodeowners('# 只有注释\n\n', coFiles).problems.some((p) => /扫出 0 条规则/.test(p)),
  )
  // 目录规则匹配到 0 个条目 → 提示（不是错误）：这里断言它至少**被报出来**。
  check(
    'D 目录规则匹配 0 个条目必须被报出（不得静默）',
    checkCodeowners('*  @wang-yi-bit64\n/nonexistent-dir/  @wang-yi-bit64\n', () => [])
      .problems.some((p) => /找不到对应文件或目录/.test(p)),
  )

  // ---------------------------------------------------------------------------
  // 规则 E：退役工作流不得复活（ADR-062）的可证伪夹具
  //
  // 🔴 夹具用的就是真实形态：pullfrog.yml **确实复活过一次**（commit `d286f44`），
  //    而当时没有任何检查报红——因为禁令只写在散文里。
  // ---------------------------------------------------------------------------
  check(
    'E 好夹具：禁令表非空 + 文件缺席必须通过',
    checkRetiredWorkflows([join('.github', 'workflows', 'ci.yml'), join('.github', 'CODEOWNERS')]).problems.length === 0,
  )
  const eRevived = checkRetiredWorkflows([join('.github', 'workflows', 'pullfrog.yml')])
  check(
    'E 可伪证：退役文件重新出现必须报红',
    eRevived.problems.some((p) => /又出现了/.test(p)),
  )
  check('E 报红时必须点名 ADR 与不可恢复日期', eRevived.problems.some((p) => /ADR-062/.test(p) && /2026-10-09/.test(p)))
  check(
    'E 报红时必须给出正当出路（另立新工作流），而不是只说「不许」',
    eRevived.problems.some((p) => /另立新工作流/.test(p)),
  )
  check('E 反向：其他工作流在役不得误报', checkRetiredWorkflows([join('.github', 'workflows', 'release.yml')]).problems.length === 0)
  // 🔴 空集判据：清空禁令表 == 删掉禁令，必须报红而不是「没有退役项 ⇒ 通过」。
  const eEmpty = checkRetiredWorkflows([], [])
  check(
    'E 可伪证：禁令表被清空必须报红（清空即删掉禁令）',
    eEmpty.problems.some((p) => /禁令表是空的/.test(p)),
  )
  // 分隔符归一：Windows 的 `\\` 与 posix 的 `/` 必须判等（本机是 Windows）。
  check(
    'E 分隔符归一：反斜杠路径也必须命中',
    checkRetiredWorkflows(['.github\\workflows\\pullfrog.yml']).problems.length > 0,
  )

  if (failed > 0) { console.error('verify-github-config self-test 失败 ' + failed + ' 项'); return 1 }
  console.log('✅ verify-github-config 自检通过（' + passed + ' 项）')
  return 0
}

if (import.meta.url === (await import('node:url')).pathToFileURL(argv[1] ?? '').href) {
  exit(argv.includes('--self-test') ? selfTest() : main())
}
