#!/usr/bin/env node
/**
 * verify-cargo-lock-scope.mjs — 断言 **workspace 成员目录下不得存在独立 `Cargo.lock`**，
 * 且根 `Cargo.lock` 必须存在。
 *
 * ## 为什么有这条门禁（守的是哪一类缺陷）
 *
 * 2026-10-09：Dependabot 告警 #7（`rustls`，GHSA-2mjx-qc3c-rqvc，medium）报在
 * `src-tauri/Cargo.lock` 上。核下去发现那个文件**构建里根本用不到**：
 *
 *   · `src-tauri` 是根 Cargo workspace 的成员（`cargo metadata` 的 `workspace_root`
 *     就是仓库根），**cargo 只用根 `Cargo.lock`**；
 *   · 那个文件提交于 2026-09-04 的初版单 crate 布局（`2d91067`），此后**一次未动**；
 *   · 把它移走，cargo 既不报错也**不重建**它 —— 真正的孤儿；
 *   · 根 `Cargo.lock` 里没有 `rustls`：updater 用的是 `native-tls`/`schannel`
 *     （`tauri-plugin-updater` 显式 `default-features = false, features = ["native-tls", …]`）。
 *
 * 真正被它损坏的是**三处声明面与症状面互相打架**，而没有任何一处会报错：
 *
 *   | 面 | 它说什么 | 事实 |
 *   |---|---|---|
 *   | `.github/dependabot.yml` cargo 段 | `directory: "/"`，注释写「指向 workspace 根（Cargo.lock 所在处）」 | 症状面**同时**按孤儿 lock 开告警 |
 *   | `.github/CODEOWNERS` | 只认 `/Cargo.lock` | 孤儿 lock 无归属 |
 *   | GitHub 依赖图（SBOM） | —— | **两个 lock 都在图里**（实测：孤儿特有的 `hyper-rustls`/`tokio-rustls`/`rustls-platform-verifier` 与根 lock 特有的 `hyper-tls`/`tokio-native-tls`/`schannel` 并存） |
 *
 * ⇒ 一条**构建产物里不存在的依赖**拿到了 medium 告警，并已经把一次人工分析的结论
 * 带偏成「rustls 在本仓自己的 Cargo 依赖链里（Tauri 侧）」——
 * 见 `docs/dsh-upgrade-checklist.md` §6 尾部那条注释（同批订正）。
 *
 * 这是本仓反复出现的那一类缺陷：**注释里的现状声明零守卫**（模板见用户级技能
 * `doc-fact-guard`）。这条守卫把其中「可机械判定的那一半」变成会报红的事实。
 *
 * ## 判什么（可证伪）
 *
 *   1. `Cargo.lock`（根）**必须存在** —— 否则「消灭告警」的最省事写法会变成
 *      「把真正的 lock 也删掉」，那是把 rust 生态整个移出扫描面。**成对判据**：
 *      这条与第 2 条必须同时成立，只满足一条即为坏。
 *   2. 每个 workspace 成员的目录下**不得存在** `Cargo.lock`。
 *   3. 成员清单必须解析得出且非空 —— 解析失败**不得冒充通过**
 *      （空集给绿是这类门禁最常见的假阳性来源）。
 *   4. 成员条目含通配符时不静默放过：能展开就展开（`fs.globSync`），展开不了判红。
 *
 * ## 刻意不做的事
 *
 *   · **不**读 `[workspace] exclude`：被排除的目录有自己的 lock 是合法的。
 *   · **不**联网、不调用 cargo：纯文件系统判定，进 fast 档零成本。
 *   · **不**试图修文件：它只报告。修法是删掉那个 lock（cargo 会自然回落到根 lock）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-cargo-lock-scope.mjs              # 真检查
 * node scripts/verify-cargo-lock-scope.mjs --self-test  # 自检（含真实临时根端到端）
 * ```
 *
 * 退出码：`0` 通过 · `1` 不一致 · `2` 参数错误。
 */

import { argv, exit } from 'node:process'
import { dirname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  globSync,
} from 'node:fs'
import { tmpdir } from 'node:os'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 根 lock 与 workspace 清单的相对路径（唯一产地）。 */
export const ROOT_LOCK_REL = 'Cargo.lock'
export const ROOT_MANIFEST_REL = 'Cargo.toml'

/**
 * 剥掉 TOML 行内注释。**只处理引号外**的 `#`：成员路径里理论上可以含 `#`，
 * 直接 `split('#')` 会把合法路径截断成「看起来干净、其实漏了成员」的假绿。
 *
 * @param {string} line 单行文本（已归一换行）
 * @returns {string} 去掉注释后的文本
 */
function stripTomlComment(line) {
  let inBasic = false
  let inLiteral = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '\\' && inBasic) {
      i += 1
      continue
    }
    if (ch === '"' && !inLiteral) inBasic = !inBasic
    else if (ch === "'" && !inBasic) inLiteral = !inLiteral
    else if (ch === '#' && !inBasic && !inLiteral) return line.slice(0, i)
  }
  return line
}

/**
 * 从 `Cargo.toml` 文本里解析 `[workspace] members`。
 *
 * 纯逻辑、无 IO —— 自检可以直接喂夹具。支持多行数组与同行数组两种写法
 * （本仓当前是多行），并**先归一换行**：`core.autocrlf=true` 的检出会让多行锚点
 * 静默未命中（本仓踩过，见 `.workbuddy/memory` 的宿主限制节）。
 *
 * @param {string} tomlText `Cargo.toml` 全文
 * @returns {{ members: string[], problem: string | null }} 解析结果；
 *           `problem` 非空表示**无法可信解析**（调用方必须判红，不得当空集处理）
 */
export function parseWorkspaceMembers(tomlText) {
  const lines = String(tomlText).replace(/\r\n?/g, '\n').split('\n')
  const members = []
  let inWorkspaceTable = false
  let collecting = false
  let buffer = ''

  const flush = () => {
    const body = buffer.replace(/\]\s*$/, '')
    for (const raw of body.split(',')) {
      const item = raw.trim()
      if (item === '') continue
      const quoted = /^"(.*)"$/.exec(item) ?? /^'(.*)'$/.exec(item)
      if (!quoted) {
        return `members 条目不是字符串字面量：${item}`
      }
      members.push(quoted[1])
    }
    buffer = ''
    return null
  }

  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim()

    if (collecting) {
      buffer += ` ${line}`
      if (line.includes(']')) {
        collecting = false
        const problem = flush()
        if (problem) return { members: [], problem }
      }
      continue
    }

    if (line.startsWith('[')) {
      inWorkspaceTable = line === '[workspace]'
      continue
    }
    if (!inWorkspaceTable || line === '') continue

    const match = /^members\s*=\s*\[(.*)$/.exec(line)
    if (!match) continue

    buffer = match[1]
    if (buffer.includes(']')) {
      const problem = flush()
      if (problem) return { members: [], problem }
    } else {
      collecting = true
    }
  }

  if (collecting) {
    return { members: [], problem: '`[workspace] members` 数组未闭合 —— 解析不可信' }
  }
  if (members.length === 0) {
    return { members: [], problem: '没解析到任何 `[workspace] members` —— 不得冒充通过' }
  }
  return { members, problem: null }
}

/**
 * 纯逻辑判定：给定成员清单与「某相对路径是否存在文件」的探针，返回问题列表。
 *
 * 探针参数化是为了自检能构造**成对夹具**（有孤儿 / 无孤儿 / 缺根 lock / 空成员）
 * 而不碰真实仓库 —— 判据本身写坏时，自检必须能红。
 *
 * @param {object} input
 * @param {string[]} input.workspaceMembers workspace 成员相对路径
 * @param {(rel: string) => boolean} input.isFile 探针：相对 projectRoot 是否是普通文件
 * @returns {string[]} 问题清单（空数组＝通过）
 */
export function auditCargoLockScope({ workspaceMembers, isFile }) {
  const problems = []

  if (!isFile(ROOT_LOCK_REL)) {
    problems.push(
      `根 ${ROOT_LOCK_REL} 不存在 —— 它是 rust 生态依赖图的唯一入口，删它等于把整条 ` +
        'rust 扫描面移出仓库；「消灭告警」不得走这条'
    )
  }

  if (!Array.isArray(workspaceMembers) || workspaceMembers.length === 0) {
    problems.push('workspace 成员清单为空 —— 空集不得冒充通过')
    return problems
  }

  for (const member of workspaceMembers) {
    const lockRel = `${member.replace(/\/+$/, '')}/Cargo.lock`
    if (!isFile(lockRel)) continue
    problems.push(
      `${lockRel} 存在，但 \`${member}\` 是根 workspace 成员 —— cargo 只用根 ` +
        `${ROOT_LOCK_REL}，这份 lock 是**孤儿**：cargo 不读它、不重建它，而 GitHub ` +
        '依赖图会读它并按它开 Dependabot 告警（构建产物里没有的依赖也会拿到告警）。' +
        '修法：`git rm ' +
        lockRel +
        '`（删除后 cargo 自动回落到根 lock，无需其它改动）'
    )
  }

  return problems
}

/**
 * 把含通配符的成员条目展开成具体目录。
 *
 * @param {string} member 成员条目原文
 * @returns {{ dirs: string[], problem: string | null }}
 */
function expandMember(member) {
  if (!/[*?[\]]/.test(member)) return { dirs: [member], problem: null }
  if (typeof globSync !== 'function') {
    return {
      dirs: [],
      problem: `成员条目 \`${member}\` 含通配符，但本 Node 无 fs.globSync ⇒ 无法核验（不得当通过）`,
    }
  }
  let hits = []
  try {
    hits = globSync(member, { cwd: projectRoot }).filter((rel) => {
      try {
        return statSync(resolve(projectRoot, rel)).isDirectory()
      } catch {
        return false
      }
    })
  } catch (error) {
    return { dirs: [], problem: `通配符成员 \`${member}\` 展开失败：${error.message}` }
  }
  if (hits.length === 0) {
    return { dirs: [], problem: `通配符成员 \`${member}\` 展开为空 —— 不得冒充通过` }
  }
  return { dirs: hits, problem: null }
}

/**
 * 真检查：读仓库根 `Cargo.toml`，展开成员，按真实文件系统判定。
 *
 * @param {string} root 仓库根绝对路径
 * @returns {{ problems: string[], members: string[] }}
 */
export function auditRepo(root = projectRoot) {
  const manifestAbs = resolve(root, ROOT_MANIFEST_REL)
  if (!existsSync(manifestAbs)) {
    return { problems: [`${ROOT_MANIFEST_REL} 不存在：${manifestAbs}`], members: [] }
  }

  const parsed = parseWorkspaceMembers(readFileSync(manifestAbs, 'utf8'))
  if (parsed.problem) return { problems: [parsed.problem], members: [] }

  const members = []
  const problems = []
  for (const member of parsed.members) {
    const { dirs, problem } = expandMember(member)
    if (problem) problems.push(problem)
    members.push(...dirs)
  }

  const isFile = (rel) => {
    if (isAbsolute(rel)) return false
    try {
      return statSync(resolve(root, rel)).isFile()
    } catch {
      return false
    }
  }

  problems.push(...auditCargoLockScope({ workspaceMembers: members, isFile }))
  return { problems, members }
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/** 极简断言（本仓 scripts 不引测试框架，与其它 verify-*.mjs 同口径）。 */
function assertCase({ name, actual, expected }) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    console.error(`❌ 自检失败：${name}`)
    console.error(`   期望：${JSON.stringify(expected)}`)
    console.error(`   实际：${JSON.stringify(actual)}`)
    return false
  }
  console.log(`  ✅ ${name}`)
  return true
}

function runSelfTest() {
  console.log('[verify-cargo-lock-scope] self-test')
  let ok = true

  // ---- 夹具 1：解析器（成对：能解析的写法 × 两种）
  ok = assertCase({
    name: '多行数组（本仓真实写法）解析出全部成员',
    actual: parseWorkspaceMembers(
      '[workspace]\nresolver = "2"\nmembers = [\n  "src-tauri",\n  "crates/dsh-host",\n]\n'
    ),
    expected: {
      members: ['src-tauri', 'crates/dsh-host'],
      problem: null,
    },
  }) && ok

  ok = assertCase({
    name: 'CRLF 检出下仍能解析（多行锚点不得静默未命中）',
    actual: parseWorkspaceMembers(
      '[workspace]\r\nmembers = [\r\n  "src-tauri",\r\n  "crates/dsh-host",\r\n]\r\n'
    ),
    expected: { members: ['src-tauri', 'crates/dsh-host'], problem: null },
  }) && ok

  ok = assertCase({
    name: '同行数组写法解析',
    actual: parseWorkspaceMembers('[workspace]\nmembers = ["src-tauri", "crates/a"]\n'),
    expected: { members: ['src-tauri', 'crates/a'], problem: null },
  }) && ok

  ok = assertCase({
    name: '行内注释被剥掉（`#` 在引号外）',
    actual: parseWorkspaceMembers('[workspace]\nmembers = [\n  "src-tauri", # 桌面壳\n]\n'),
    expected: { members: ['src-tauri'], problem: null },
  }) && ok

  const notAWorkspace = parseWorkspaceMembers('[package]\nname = "x"\n')
  ok = assertCase({
    name: '没有 [workspace] 段 ⇒ 判「无法解析」而不是空集给绿',
    actual: notAWorkspace.members.length === 0 && typeof notAWorkspace.problem === 'string',
    expected: true,
  }) && ok

  const otherTable = parseWorkspaceMembers('[workspace]\nmembers = ["src-tauri"]\n\n[other]\nmembers = ["x"]\n')
  ok = assertCase({
    name: '别处的 `members` 不得被当成 workspace 成员',
    actual: otherTable.members,
    expected: ['src-tauri'],
  }) && ok

  // ---- 夹具 2：判定器（成对：红 × 2 / 绿 × 1）
  const probe = (present) => (rel) => present.includes(rel)

  ok = assertCase({
    name: '🔴 成员带独立 lock ⇒ 必须报红（这就是 2026-10-09 那次告警的形态）',
    actual:
      auditCargoLockScope({
        workspaceMembers: ['src-tauri', 'crates/dsh-host'],
        isFile: probe(['Cargo.lock', 'src-tauri/Cargo.lock']),
      }).length,
    expected: 1,
  }) && ok

  ok = assertCase({
    name: '🔴 根 lock 缺失 ⇒ 必须报红（不得靠删真 lock「消灭告警」）',
    actual:
      auditCargoLockScope({
        workspaceMembers: ['src-tauri'],
        isFile: probe([]),
      }).length,
    expected: 1,
  }) && ok

  ok = assertCase({
    name: '🔴 空成员集 ⇒ 必须报红（空集不得冒充通过）',
    actual:
      auditCargoLockScope({
        workspaceMembers: [],
        isFile: probe(['Cargo.lock']),
      }).length,
    expected: 1,
  }) && ok

  ok = assertCase({
    name: '✅ 只有根 lock、成员全干净 ⇒ 通过',
    actual: auditCargoLockScope({
      workspaceMembers: ['src-tauri', 'crates/dsh-host', 'crates/dsh-host-cli'],
      isFile: probe(['Cargo.lock']),
    }),
    expected: [],
  }) && ok

  ok = assertCase({
    name: '成员目录尾斜杠不产生假红/假绿',
    actual:
      auditCargoLockScope({
        workspaceMembers: ['src-tauri/'],
        isFile: probe(['Cargo.lock', 'src-tauri/Cargo.lock']),
      }).length,
    expected: 1,
  }) && ok

  // ---- 夹具 3：真实临时根端到端（新路径必须真跑通一次）
  const tempRoot = mkdtempSync(resolve(tmpdir(), 'dsh-lock-scope-'))
  try {
    mkdirSync(resolve(tempRoot, 'crates/dsh-host'), { recursive: true })
    writeFileSync(resolve(tempRoot, 'Cargo.lock'), '# root\n')
    writeFileSync(resolve(tempRoot, 'Cargo.toml'), '[workspace]\nmembers = [\n  "crates/dsh-host",\n]\n')

    const clean = auditRepo(tempRoot)
    ok = assertCase({
      name: '端到端：干净的临时根 ⇒ 通过',
      actual: clean.problems,
      expected: [],
    }) && ok

    writeFileSync(resolve(tempRoot, 'crates/dsh-host/Cargo.lock'), '# orphan\n')
    const dirty = auditRepo(tempRoot)
    ok = assertCase({
      name: '端到端：放入孤儿 lock ⇒ 报红且点名该路径',
      actual: dirty.problems.length === 1 && dirty.problems[0].includes('crates/dsh-host/Cargo.lock'),
      expected: true,
    }) && ok

    rmSync(resolve(tempRoot, 'Cargo.lock'))
    const noRoot = auditRepo(tempRoot)
    ok = assertCase({
      name: '端到端：删掉根 lock ⇒ 报红',
      actual: noRoot.problems.some((p) => p.includes('根 Cargo.lock 不存在')),
      expected: true,
    }) && ok
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }

  if (!ok) {
    console.error('\n❌ [verify-cargo-lock-scope] self-test 未通过')
    exit(1)
  }
  console.log('✅ [verify-cargo-lock-scope] self-test 全部通过')
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function main() {
  const args = argv.slice(2)
  const unknown = args.filter((arg) => arg !== '--self-test')
  if (unknown.length > 0) {
    console.error(`[verify-cargo-lock-scope] 未知参数：${unknown.join(' ')}`)
    exit(2)
  }

  if (args.includes('--self-test')) {
    runSelfTest()
    return
  }

  const { problems, members } = auditRepo(projectRoot)
  if (problems.length > 0) {
    console.error('❌ [verify-cargo-lock-scope] Cargo lock 作用域不一致：')
    for (const problem of problems) console.error(`   - ${problem}`)
    exit(1)
  }
  console.log(
    `✅ [verify-cargo-lock-scope] 根 ${ROOT_LOCK_REL} 在位，${members.length} 个 workspace ` +
      `成员（${members.join(' / ')}）均无独立 lock`
  )
}

main()
