#!/usr/bin/env node
/**
 * manifest-v3.mjs — `MANIFEST.json` 的 **v3 字段块**合成器（唯一产地、无副作用、可独立自测）。
 *
 * ## 为什么单独成模块（而不是留在写入点里）
 *
 * 写入点是 `scripts/prepare-harness.mjs`，但那个脚本**在模块顶层就跑整趟组装**
 * （npm ci → patch-package → 拷贝 `resources/`）。本机跑不起来它（宿主限制：`koffi`
 * 的 postinstall 需要 CMake；原生 Rust 进程无法写盘）。把 v3 的合成逻辑留在那里，
 * 「形状自测」就只能靠**一次真实组装**来触发 —— 那等于没有守卫
 * （本仓缺陷族：「没跑过成功路径 = 没验证过」）。
 * ⇒ 本模块只吃**已备好的字符串与对象**：不碰文件系统、不起子进程、不联网。
 *
 * ## 与 v1 字段的关系：v3 是**增量**
 *
 * `prepare-harness.mjs` 原有的 `fingerprint` / `generatedAt` / `lockfileHash` / `target` /
 * `versions` / `overrides` / `patchFilesPresent` / `patchesStrict` / `patches` /
 * `primaryRuntime` **全部保留**，本模块只追加 `releaseSchemaVersion` 与六个新块。
 * 读取端 `crates/dsh-host/src/runtime_manifest.rs` **不用** `deny_unknown_fields`
 * ⇒ 新增字段向后兼容（旧读取端不会因为多了字段而解析失败）。
 *
 * ## 🔴 禁止伪造（AGENTS.md §7.1 规则 2 / 规则 3）
 *
 * 计划 §4.6 的 2g 字段清单里，有**四个当下没有产地**：
 *
 * | 字段 | 为什么没有产地 |
 * |---|---|
 * | `upstreamDsh.tag` / `upstreamDsh.commit` | 台账条目的 `upstreamTag` / `upstreamCommit` **刻意留空**：只有 `sync-upstream-release.mjs` 核实过「上游 Release 存在」+「npm 精确版本可安装」之后才写 |
 * | `desktop.desktopBuild` | 全仓无定义（原提案的 `2026.10.08.1` 形态没有任何产地）。本仓构建标识已由 `desktopVersion.composite` 与 `release.tag` 承担 |
 * | `release.tag` | 只有发布链路知道（`release.yml` 的 preflight 输出）⇒ 组装期由环境变量 {@link RELEASE_TAG_ENV} 传入 |
 * | `changelogPointers.upstream` | 依赖 D7 的「两股同段落」形态（{@link UPSTREAM_SECTION_HEADING}），而 CHANGELOG 尚未改造 |
 *
 * 这四个字段**照样出现在产物里**（形状先冻结，消费者可以照写），但值是 `null`，
 * 且在 `unresolvedFields[]` 里逐条记录**哪个字段**与**为什么读不到**。
 * 编造一个「看起来合理」的值会把读诊断包的人引到错误方向——「降级/缺失必须写进产物」
 * 正是 §7.1 规则 3 的要求。
 *
 * ## 命名
 *
 * 「`channel`」在本模块里**只**指**桌面通道**（`stable` / `rc` / `alpha`，由版本后缀推导，
 * 见 `dsh-targets.mjs::desktopChannelForVersion`）。上游那条 npm dist-tag 叫
 * `upstreamDistTag`，只用于发现（见 `docs/version-policy.md` §3.3）。
 *
 * ```bash
 * node scripts/manifest-v3.mjs --self-test   # 纯逻辑自测（不碰文件系统）
 * ```
 */

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { argv, exit } from 'node:process'
import { fileURLToPath } from 'node:url'

import { desktopChannelForVersion, parseVersionShape } from './dsh-targets.mjs'
import { LEDGER_RELATIVE, splitRepoSequence } from './release-ledger.mjs'
import { UPSTREAM_REPO, tagForVersion } from './upstream-release.mjs'

/** 产物里的 schema 版本（计划 2g：`releaseSchemaVersion: 3`）。 */
export const RELEASE_SCHEMA_VERSION = 3

/**
 * 发布 tag 的注入点：`release.yml` 的 `prepare:harness` 步骤把 preflight 输出的 tag
 * 经这个环境变量传进来。**本地组装不设它是正常的**——那会让 `release.tag` 落在
 * `null` + `unresolvedFields` 里，而不是一个猜出来的 tag。
 */
export const RELEASE_TAG_ENV = 'DSH_RELEASE_TAG'

/**
 * CHANGELOG 里**上游股**的子节标题（D7 定案，计划 §4.12.3 第 2 条：
 * 两股是**同一段落的两个子节**，不是两段）。
 */
export const UPSTREAM_SECTION_HEADING = '### ⬆️ 上游变更'

/** 本仓股子节标题（用于判「两股是否都在」；本模块不消费它的正文）。 */
export const OWN_SECTION_HEADING = '### 🔧 本仓更新'

// ---------------------------------------------------------------------------
// 纯逻辑层
// ---------------------------------------------------------------------------

/**
 * 计算 CHANGELOG 里某一段**上游股子节正文**的 sha256 摘要（计划 §4.12.4 的 `digest`）。
 *
 * 判据（§4.12.4）：`digest` 必须与 CHANGELOG 里该段上游子节的正文摘要一致；
 * 重生成 CHANGELOG 后若 `digest` 变了 ⇒ 判红——因为那说明**上游段被重新抓取**，
 * 违反了「上游段冻结入库」。
 *
 * ⚠️ 正文在摘要前**归一化换行**（`\r\n` → `\n`）并去掉首尾空白。本仓
 * `core.autocrlf=true`（工作区 CRLF / 仓库 LF）⇒ 不归一会让同一份正文在两种
 * 检出形态下算出**两个不同的 digest**，于是「冻结」判据恒红（本仓已踩过一次同类坑）。
 *
 * @param {string} changelogText CHANGELOG.md 全文。
 * @param {string} sectionKey 段落键（= 合成版本号，如 `0.2.0-rc.3.1`）。
 * @returns {{ok: true, digest: string} | {ok: false, reason: string}}
 *   命中给出 `sha256:<hex>`；未命中给出**可读的原因**（不返回空串冒充成功）。
 */
export function upstreamSectionDigest(changelogText, sectionKey) {
  const text = String(changelogText ?? '').replace(/\r\n/g, '\n')
  const key = String(sectionKey ?? '').trim()
  if (key.length === 0) return { ok: false, reason: '段落键为空，无从定位上游股' }
  if (text.length === 0) return { ok: false, reason: 'CHANGELOG 正文为空，无从定位上游股' }

  // 段键里的 `+` / `*` / `.` 都要转义；`+` 尤其重要（合成号带 `+w`）。
  // 模式要求紧跟 `]`，因此 `1` 不会匹配到 `10`（§4.12.3 第 4 条实测过这一形态）。
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp(`^## \\[${escaped}\\]`, 'm')
  const headingMatch = heading.exec(text)
  if (headingMatch === null) {
    return { ok: false, reason: `CHANGELOG 里没有段落键 \`${key}\`（段键 = 合成版本号，含 +w）` }
  }
  const rest = text.slice(headingMatch.index + headingMatch[0].length)
  // 段落 = 到下一个 `## [` 为止（或用尽全文）。
  const nextHeading = /^## \[/m.exec(rest)
  const section = nextHeading === null ? rest : rest.slice(0, nextHeading.index)

  const sub = section.indexOf(UPSTREAM_SECTION_HEADING)
  if (sub === -1) {
    return {
      ok: false,
      reason:
        `段落 \`${key}\` 里没有上游股子节 \`${UPSTREAM_SECTION_HEADING}\`——` +
        `D7 的两股形态尚未在此段落落地（CHANGELOG 由 changelog.mjs 生成）`,
    }
  }
  const afterSub = section.slice(sub + UPSTREAM_SECTION_HEADING.length)
  // 子节正文 = 到下一个 `### ` 或段落结束为止。
  const nextSub = /^### /m.exec(afterSub)
  const body = (nextSub === null ? afterSub : afterSub.slice(0, nextSub.index)).trim()
  if (body.length === 0) {
    return { ok: false, reason: `段落 \`${key}\` 的上游股子节是空的——空正文不得冒充「无变更」` }
  }
  return { ok: true, digest: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}` }
}

/** 非空字符串才算「有值」；`''` / `undefined` / `null` 一律归 `null`。 */
function nonEmpty(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text.length === 0 ? null : text
}

/**
 * 合成 `MANIFEST.json` 的 v3 字段块。
 *
 * 本函数**从不抛错**（除编程错误外）：它把「读不到某字段」表达为
 * `null` + `unresolvedFields[]`，把「字段之间自相矛盾」表达为 `problems[]`。
 * 这样调用方（组装脚本）能区分两种处置：
 *
 * * `problems` 非空 ⇒ **必须失败**（矛盾说明产物会说谎，例如 CI 传的 tag 与版本号不符）；
 * * `unresolvedFields` 非空 ⇒ **照常产出**（缺失是如实上报，不是错误）。
 *
 * @param {object} input
 * @param {string} input.compositeVersion 本次构建的桌面版本号（`package.json` 是唯一真源）。
 * @param {{releases: Record<string, {patchTarget?: string, status?: string,
 *   upstreamTag?: string, upstreamCommit?: string, builds?: object[]}>}} input.ledger 台账内容
 *   （`harness-locks/dsh-releases.json`）。缺省时按空台账处理（一切上游字段落 null）。
 * @param {string|null} [input.changelogText] CHANGELOG.md 全文；缺省则不试图算 `digest`。
 * @param {string|null} [input.shellCommit] 本仓 HEAD（组装所在地的提交）。
 * @param {string|null} [input.releaseTag] 发布 tag（`release.yml` preflight 输出）；
 *   必须是 `v<compositeVersion>`，否则进 `problems`。
 * @param {string|null} [input.patchSetHash] 补丁集摘要（`patches/<target>/*.patch` 的内容摘要）。
 * @param {string|null} [input.runtimeLockHash] 运行时 lockfile 摘要（= 组装侧已算的 `lockfileHash`）。
 * @returns {{fields: object, problems: string[]}}
 *   `fields` 可直接 `Object.assign` 进 MANIFEST；`problems` 空数组 = 通过。
 *
 * @example
 * const { fields, problems } = composeReleaseManifestV3({
 *   compositeVersion: '0.2.0-rc.3.1',
 *   ledger: { releases: { '0.2.0-rc.3': { patchTarget: 'next', status: 'active', builds: [] } } },
 *   shellCommit: 'abc1234',
 *   releaseTag: 'v0.2.0-rc.3.1'
 * })
 * // fields.upstreamDsh.version === '0.2.0-rc.3'
 * // fields.desktopVersion === { composite: '0.2.0-rc.3.1', upstreamXyz: '0.2.0', channel: 'rc', seq: 1, w: null }
 */
export function composeReleaseManifestV3(input = {}) {
  const problems = []
  const unresolvedFields = []
  /** 记一条「如实缺失」。字段名用 `a.b.c` 点路径，便于按名字检索。 */
  const note = (field, reason) => {
    unresolvedFields.push({ field, reason })
  }

  const composite = nonEmpty(input.compositeVersion)
  if (composite === null) {
    problems.push(
      'compositeVersion 为空：v3 字段块的上游段 / 序号 / 通道全由它推出，' +
        '没有它就没有任何可写的东西（唯一真源是 package.json）。',
    )
    return { fields: {}, problems }
  }

  const shape = parseVersionShape(composite)
  if (!shape.ok) {
    problems.push(
      `compositeVersion ${JSON.stringify(composite)} 不是 major.minor.patch[-预发布][+build] 形状 ⇒ ` +
        '无法推出上游段 / 序号 / 通道。',
    )
    return { fields: {}, problems }
  }

  const ledger = input.ledger ?? {}
  const releases = ledger.releases ?? {}

  // ---- upstreamDsh：只认**台账键**（上游身份不得由桌面号反推） ----------------
  //
  // ⚠️ 这一步必须**先**于 desktopVersion.seq。理由见下面那段注释。
  const split = splitRepoSequence(composite)
  const candidate = split.ok ? split.base : null
  const entry = candidate === null ? undefined : releases[candidate]
  let upstreamDsh
  if (entry === undefined) {
    // ⚠️ 这一支**不是**「版本号坏了」。`splitRepoSequence` 明确写着「不得用于从 tag 反推上游」：
    //    `0.7.3-alpha.1` 会得到 `0.7.3-alpha`（实测），与真实上游同构而不可区分。
    //    因此这里的判据是**台账里有没有这个键**，而不是「拆出来的 base 像不像上游版本」。
    upstreamDsh = { version: null, tag: null, commit: null }
    note(
      'upstreamDsh',
      candidate === null
        ? `${composite} 里没有「上游精确版本 + 本仓序号」的切分点 ⇒ 连候选上游版本都提不出来`
        : `台账 ${LEDGER_RELATIVE} 里没有键 ${JSON.stringify(candidate)} ⇒ 上游身份无从确认。` +
          '上游版本必须由台账回答（桌面号与上游号**同构**，反推会得到假值）。',
    )
  } else {
    upstreamDsh = {
      version: candidate,
      tag: nonEmpty(entry.upstreamTag),
      commit: nonEmpty(entry.upstreamCommit),
    }
    for (const [field, value] of [
      ['upstreamDsh.tag', upstreamDsh.tag],
      ['upstreamDsh.commit', upstreamDsh.commit],
    ]) {
      if (value === null) {
        note(
          field,
          `台账键 ${JSON.stringify(candidate)} 刻意不存 ${field.slice('upstreamDsh.'.length)}：` +
            '只有在 sync-upstream-release.mjs 核实「上游 Release 存在」+「npm 精确版本可安装」之后才写' +
            '（核实之前填猜测值 = 伪造成功）。',
        )
      }
    }
  }

  // ---- desktopVersion：五段里只有「序号」需要台账背书 --------------------------
  const upstreamXyz = `${shape.major}.${shape.minor}.${shape.patch}`

  let channel = null
  try {
    // 形状已在上面校验过，这里不会因形状抛错；仍包 try 是因为它是**另一个模块**的契约，
    // 静默吞掉会让「通道推导坏了」表现为一个 null 通道而不是一次明确的失败。
    channel = desktopChannelForVersion(composite)
  } catch (error) {
    problems.push(`desktopChannelForVersion(${JSON.stringify(composite)}) 抛错：${error.message}`)
  }

  // 🔴 **序号只在台账确认了切分点时才可信。**
  // `splitRepoSequence('0.7.3-alpha.1')` 返回 `{base:'0.7.3-alpha', n:1}` —— 它**不报错**，
  // 因为「末位数字是上游自己的预发布序号」与「是本仓序号」在字形上同构（模块文档原文）。
  // 照抄会让一个从未有过本仓序号的历史版本写出 `seq: 1`，即**谎称「这是第 1 次构建」**。
  // 判据因此是「台账里有没有候选键」，而不是「splitRepoSequence 成不成功」。
  let seq = null
  if (entry === undefined) {
    note(
      'desktopVersion.seq',
      split.ok
        ? `台账里没有键 ${JSON.stringify(candidate)} ⇒ 无法确认预发布段末位的纯数字是**上游自己的**` +
          `预发布序号还是**本仓**序号（两者同构，反向推断会得到假值）`
        : `${composite} 的预发布段里没有「纯数字末标识符」⇒ 读不出本仓序号（${split.reason}）`,
    )
  } else {
    seq = split.n
  }

  // `w` 直接读版本号的 build 段（`+w` 是版本串自身的一部分，不依赖台账背书）。
  const w = shape.build

  const desktopVersion = {
    composite,
    upstreamXyz,
    channel,
    seq,
    w: w === null ? null : `w${w.replace(/^w/, '')}`,
  }

  // ---- release：通道与 desktopVersion.channel 是**同一次派生**（不是两份产地） ----
  const releaseTag = nonEmpty(input.releaseTag)
  let releaseTagOut = null
  if (releaseTag === null) {
    note(
      'release.tag',
      `组装期未拿到发布 tag（环境变量 ${RELEASE_TAG_ENV} 未设）。本地组装属正常；` +
        '发布链路必须由 release.yml 的 prepare:harness 步骤传入，否则发布证明文件缺一半。',
    )
  } else if (releaseTag !== `v${composite}`) {
    problems.push(
      `release tag ${JSON.stringify(releaseTag)} 与 desktopVersion.composite 要求的不一致：` +
        `应为 ${JSON.stringify(`v${composite}`)}。两者不一致意味着「打的是这个 tag、包里写的是另一个版本」，` +
        'updater 会据此判定更新方向 ⇒ 必须失败而不是照写。',
    )
  } else {
    releaseTagOut = releaseTag
  }

  // ---- desktop ---------------------------------------------------------------
  const shellCommit = nonEmpty(input.shellCommit)
  if (shellCommit === null) {
    note('desktop.shellCommit', '组装期未取到本仓 HEAD（不在 git 工作树内？）⇒ 无法指认是哪份壳层代码')
  }
  note(
    'desktop.desktopBuild',
    '全仓无产地（原提案的 `2026.10.08.1` 形态没有任何生成点）。本仓构建标识已由 ' +
      'desktopVersion.composite 与 release.tag 承担，此字段刻意留 null 而不是编一个日期号。',
  )

  // ---- runtime ---------------------------------------------------------------
  const patchSetHash = nonEmpty(input.patchSetHash)
  const runtimeLockHash = nonEmpty(input.runtimeLockHash)
  if (patchSetHash === null) note('runtime.patchSetHash', '组装期未算补丁集摘要')
  if (runtimeLockHash === null) note('runtime.runtimeLockHash', '组装期未算 lockfile 摘要')

  // ---- changelogPointers（D7 的机器可读落点，计划 §4.12.4） --------------------
  const builds = entry?.builds ?? []
  const previous = builds.length > 0 ? builds[builds.length - 1] : null
  const previousTag = previous === null ? null : nonEmpty(previous.tag)
  let own
  if (previousTag === null) {
    note(
      'changelogPointers.own.fromTag',
      `台账键 ${JSON.stringify(candidate)} 的 builds[] 为空 ⇒ 没有「上一版」可当基线` +
        '（builds 为空是真实状态：合成号机制落地后尚未发布过）。',
    )
    own = { fromTag: null, toCommit: shellCommit }
  } else {
    own = { fromTag: previousTag, toCommit: shellCommit }
  }

  let upstreamPointer = null
  if (input.changelogText === undefined || input.changelogText === null) {
    note('changelogPointers.upstream', '组装期未提供 CHANGELOG 正文 ⇒ 无法算上游股摘要（digest）')
  } else {
    const digest = upstreamSectionDigest(input.changelogText, composite)
    if (!digest.ok) {
      note('changelogPointers.upstream', digest.reason)
    } else {
      // `version` / `releaseUrl` 指**基线那一版上游**（上一版构建所绑的上游精确版本）——
      // 上游股收录的正是「相对基线新增的上游变更」（§4.12.4 的示例：own.fromTag 是
      // `v0.2.0-rc.2+w2`，upstream.version 就是 `0.2.0-rc.2`）。
      const baseVersion = previousTag === null ? null : (splitRepoSequence(previousTag).ok
        ? splitRepoSequence(previousTag).base
        : null)
      upstreamPointer = {
        version: baseVersion,
        releaseUrl: baseVersion === null
          ? null
          : `https://github.com/${UPSTREAM_REPO}/releases/tag/${tagForVersion(baseVersion)}`,
        frozen: true,
        digest: digest.digest,
      }
      if (baseVersion === null) {
        note(
          'changelogPointers.upstream.version',
          `上一版 tag ${JSON.stringify(previousTag)} 里读不出基线上游版本 ⇒ releaseUrl 一并落 null`,
        )
      }
    }
  }

  const fields = {
    releaseSchemaVersion: RELEASE_SCHEMA_VERSION,
    upstreamDsh,
    desktopVersion,
    // `release.channel` 与 `desktopVersion.channel` 是**同一次派生**的两个读路径
    // （不是两份产地）：一个答「这一版对外属于哪条通道」，一个答「版本号的哪一段推出它」。
    release: { channel, tag: releaseTagOut },
    desktop: { shellCommit, desktopBuild: null },
    runtime: { patchSetHash, runtimeLockHash },
    changelogPointers: { sectionKey: composite, upstream: upstreamPointer, own },
    unresolvedFields
  }

  return { fields, problems }
}

// ---------------------------------------------------------------------------
// 自测
// ---------------------------------------------------------------------------

/** 断言相等。 */
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}\n  期望 ${b}\n  实际 ${a}`)
  return 1
}

/** 断言为真。 */
function ok(label, value) {
  if (!value) throw new Error(`${label}（实际 ${JSON.stringify(value)}）`)
  return 1
}

/** 有夹具的台账：next 线一条在役键，空 builds。 */
function fixtureLedger(overrides = {}) {
  return {
    releases: {
      '0.2.0-rc.3': { patchTarget: 'next', status: 'active', builds: [], ...overrides.next }
    }
  }
}

/**
 * 纯逻辑自测。返回断言条数；失败即抛错（由 CLI 入口转成退出码 1）。
 *
 * @returns {number} 通过的断言数。
 */
export function selfTest() {
  let n = 0
  const t = (x) => {
    n += x
  }

  // --- 1. 台账命中：五段全部推出，且上游段来自台账键 ---------------------------
  {
    const { fields, problems } = composeReleaseManifestV3({
      compositeVersion: '0.2.0-rc.3.1',
      ledger: fixtureLedger(),
      shellCommit: 'abc1234',
      releaseTag: 'v0.2.0-rc.3.1',
      patchSetHash: 'sha256:aaa',
      runtimeLockHash: 'sha256:bbb'
    })
    t(eq('命中：problems 为空', problems, []))
    t(eq('命中：releaseSchemaVersion', fields.releaseSchemaVersion, 3))
    t(eq('命中：upstreamDsh.version = 台账键', fields.upstreamDsh.version, '0.2.0-rc.3'))
    t(eq('命中：desktopVersion', fields.desktopVersion, {
      composite: '0.2.0-rc.3.1',
      upstreamXyz: '0.2.0',
      channel: 'rc',
      seq: 1,
      w: null
    }))
    t(eq('命中：release.channel 与 desktopVersion.channel 同源', fields.release.channel, fields.desktopVersion.channel))
    t(eq('命中：release.tag', fields.release.tag, 'v0.2.0-rc.3.1'))
    t(eq('命中：runtime', fields.runtime, { patchSetHash: 'sha256:aaa', runtimeLockHash: 'sha256:bbb' }))
    // 期望清单**硬编码**（不得由 unresolvedFields 现算，否则「全都记下来」与「一条都没记」
    // 都会通过）。这里恰有五条：两个上游字段（台账刻意不存）+ desktopBuild（无产地）
    // + release.tag（本地组装无 env）+ own.fromTag（夹具的 builds 为空）。
    const named = fields.unresolvedFields.map((u) => u.field).sort()
    t(eq('命中：未决字段恰为这五项', named, [
      'changelogPointers.own.fromTag',
      'changelogPointers.upstream',
      'desktop.desktopBuild',
      'upstreamDsh.commit',
      'upstreamDsh.tag'
    ]))
    t(ok('命中：desktopBuild 恒为 null', fields.desktop.desktopBuild === null))
  }

  // --- 2. 反证：台账里**没有**这个键 ⇒ upstreamDsh 三个字段全部 null ------------
  //      （若实现改成「由桌面号反推上游」，`0.7.3-alpha.1` 会得到假的 `0.7.3-alpha`）
  {
    const { fields, problems } = composeReleaseManifestV3({
      compositeVersion: '0.2.0-rc.3.1',
      ledger: { releases: {} }
    })
    t(eq('未登记：仍不判红（缺键是如实状态，不是矛盾）', problems, []))
    t(eq('未登记：upstreamDsh 整体为 null', fields.upstreamDsh, { version: null, tag: null, commit: null }))
    const up = fields.unresolvedFields.find((u) => u.field === 'upstreamDsh')
    t(ok('未登记：upstreamDsh 有原因记录', up && /台账/.test(up.reason)))
    t(ok('未登记：原因里点名了候选键', up.reason.includes('0.2.0-rc.3')))
  }

  // --- 3. 历史版本（合成号机制之前）必须**可组装**、不得抛错 --------------------
  {
    const { fields, problems } = composeReleaseManifestV3({
      compositeVersion: '0.7.3-alpha.1',
      ledger: { releases: { '0.2.1-alpha.1': { patchTarget: 'alpha', status: 'active', builds: [] } } }
    })
    t(eq('历史版本：不判红', problems, []))
    t(eq('历史版本：上游段仍可读出（这是版本号的第 1-3 段，不是上游身份）', fields.desktopVersion.upstreamXyz, '0.7.3'))
    t(eq('历史版本：通道由后缀推出', fields.desktopVersion.channel, 'alpha'))
    t(eq('历史版本：序号落 null（预发布段末位不是纯数字）', fields.desktopVersion.seq, null))
    t(eq('历史版本：上游身份落 null（台账里没有 0.7.3-alpha）', fields.upstreamDsh.version, null))
    const seqNote = fields.unresolvedFields.find((u) => u.field === 'desktopVersion.seq')
    // 🔴 这一条是**反证**：`splitRepoSequence('0.7.3-alpha.1')` 会给出 `{base:'0.7.3-alpha', n:1}`
    //    而**不报错** ⇒ 若实现照抄它，这里会得到 seq === 1（谎称「第 1 次构建」）。
    t(ok('历史版本：序号缺失有原因，且原因点名「同构」', seqNote && /同构/.test(seqNote.reason)))
  }

  // --- 4. `+w` 与序号：`0.2.0-rc.3.2+w4` ⇒ seq=2 / w='w4' ----------------------
  {
    const { fields } = composeReleaseManifestV3({
      compositeVersion: '0.2.0-rc.3.2+w4',
      ledger: fixtureLedger()
    })
    t(eq('+w：seq', fields.desktopVersion.seq, 2))
    t(eq('+w：w', fields.desktopVersion.w, 'w4'))
    t(eq('+w：composite 原样保留（含 +w）', fields.desktopVersion.composite, '0.2.0-rc.3.2+w4'))
    t(eq('+w：build 段不污染通道解析', fields.desktopVersion.channel, 'rc'))
  }

  // --- 5. 正式版（无预发布段）：通道 stable、序号 null，且不判红 ----------------
  {
    const { fields, problems } = composeReleaseManifestV3({ compositeVersion: '0.2.2', ledger: fixtureLedger() })
    t(eq('正式版：不判红', problems, []))
    t(eq('正式版：通道 = stable', fields.desktopVersion.channel, 'stable'))
    t(eq('正式版：序号 null', fields.desktopVersion.seq, null))
  }

  // --- 6. 形状非法 ⇒ problems（这是矛盾，不是缺失） ---------------------------
  {
    const { fields, problems } = composeReleaseManifestV3({ compositeVersion: '0.2-rc.3', ledger: fixtureLedger() })
    t(ok('形状非法：判红', problems.length === 1))
    t(ok('形状非法：原因点名形状', /major\.minor\.patch/.test(problems[0])))
    t(eq('形状非法：不产出字段块', fields, {}))
  }
  {
    const { problems } = composeReleaseManifestV3({ compositeVersion: '', ledger: fixtureLedger() })
    t(ok('空版本：判红', problems.length === 1))
  }

  // --- 7. release.tag 与版本号不符 ⇒ problems（发布证明不得说谎） --------------
  {
    const { fields, problems } = composeReleaseManifestV3({
      compositeVersion: '0.2.0-rc.3.1',
      ledger: fixtureLedger(),
      releaseTag: 'v0.2.0-rc.3.2'
    })
    t(ok('tag 不符：判红', problems.length === 1))
    t(ok('tag 不符：原因含两个串', problems[0].includes('v0.2.0-rc.3.2') && problems[0].includes('v0.2.0-rc.3.1')))
    t(eq('tag 不符：release.tag 不写出错的值', fields.release.tag, null))
  }
  {
    const { fields } = composeReleaseManifestV3({
      compositeVersion: '0.2.0-rc.3.1',
      ledger: fixtureLedger()
    })
    t(eq('无 tag（本地组装）：落 null', fields.release.tag, null))
    t(ok('无 tag：有原因记录', fields.unresolvedFields.some((u) => u.field === 'release.tag')))
  }

  // --- 8. changelogPointers：上游股摘要 & 上一版基线 --------------------------
  {
    const changelog = [
      '# 变更日志',
      '',
      '## [0.2.0-rc.3.1] - 2026-10-15',
      '',
      UPSTREAM_SECTION_HEADING,
      '',
      '- 上游把 preset roots 重铸为注册模型',
      '',
      OWN_SECTION_HEADING,
      '',
      '- 修了一个壳层缺陷',
      '',
      '## [0.2.0-rc.2.9] - 2026-10-01',
      ''
    ].join('\n')
    const ledger = {
      releases: {
        '0.2.0-rc.3': {
          patchTarget: 'next',
          status: 'active',
          builds: [{ channel: 'rc', n: 9, desktopVersion: '0.2.0-rc.2.9', tag: 'v0.2.0-rc.2.9', date: '2026-10-01' }]
        }
      }
    }
    const { fields, problems } = composeReleaseManifestV3({
      compositeVersion: '0.2.0-rc.3.1',
      ledger,
      changelogText: changelog,
      shellCommit: 'deadbee'
    })
    t(eq('changelog：不判红', problems, []))
    const cp = fields.changelogPointers
    t(eq('changelog：sectionKey = 合成号', cp.sectionKey, '0.2.0-rc.3.1'))
    t(ok('changelog：digest 是 sha256:<hex>', /^sha256:[0-9a-f]{64}$/.test(cp.upstream.digest)))
    t(eq('changelog：frozen', cp.upstream.frozen, true))
    t(eq('changelog：own.fromTag = 上一版 tag', cp.own.fromTag, 'v0.2.0-rc.2.9'))
    t(eq('changelog：own.toCommit = 本仓 HEAD', cp.own.toCommit, 'deadbee'))
    t(eq('changelog：upstream.version = 基线上游版本', cp.upstream.version, '0.2.0-rc.2'))
    t(eq('changelog：releaseUrl 指向上游 Release', cp.upstream.releaseUrl,
      `https://github.com/${UPSTREAM_REPO}/releases/tag/dsh-v0.2.0-rc.2`))
    t(eq('changelog：无未决的上游指针', fields.unresolvedFields.some((u) => u.field === 'changelogPointers.upstream'), false))
  }

  // --- 9. 反证：上游股**重新抓取**（正文变了）⇒ digest 必须变 ----------------
  //      这正是「上游段冻结入库」的判据：摘要相等才说明没被重抓。
  {
    const mk = (body) => [
      '## [0.2.0-rc.3.1] - 2026-10-15',
      '',
      UPSTREAM_SECTION_HEADING,
      '',
      body,
      '',
      OWN_SECTION_HEADING,
      '',
      '- 本仓改动',
      ''
    ].join('\n')
    const ledger = { releases: { '0.2.0-rc.3': { patchTarget: 'next', status: 'active', builds: [] } } }
    const a = composeReleaseManifestV3({ compositeVersion: '0.2.0-rc.3.1', ledger, changelogText: mk('- 甲') })
    const b = composeReleaseManifestV3({ compositeVersion: '0.2.0-rc.3.1', ledger, changelogText: mk('- 乙') })
    t(ok('冻结：正文不同 ⇒ digest 不同', a.fields.changelogPointers.upstream.digest !== b.fields.changelogPointers.upstream.digest))
    // CRLF / LF 两种检出形态必须算出**同一个** digest（否则「冻结」判据在 Windows 上恒红）。
    const crlf = composeReleaseManifestV3({
      compositeVersion: '0.2.0-rc.3.1',
      ledger,
      changelogText: mk('- 甲').replace(/\n/g, '\r\n')
    })
    t(eq('冻结：CRLF 与 LF 同摘要', crlf.fields.changelogPointers.upstream.digest, a.fields.changelogPointers.upstream.digest))
  }

  // --- 10. 反证：上游股子节不存在 / 为空 ⇒ 落 null + 原因，且**不判红** -------
  {
    const noSub = '## [0.2.0-rc.3.1] - 2026-10-15\n\n### ✨ 新功能\n\n- x\n'
    const r1 = composeReleaseManifestV3({
      compositeVersion: '0.2.0-rc.3.1',
      ledger: fixtureLedger(),
      changelogText: noSub
    })
    t(eq('无上游股：不判红', r1.problems, []))
    t(eq('无上游股：指针落 null', r1.fields.changelogPointers.upstream, null))
    const note1 = r1.fields.unresolvedFields.find((u) => u.field === 'changelogPointers.upstream')
    t(ok('无上游股：原因点名 D7 形态', note1 && /上游变更/.test(note1.reason)))

    // 空正文不得冒充「无变更」。
    const emptyBody = `## [0.2.0-rc.3.1] - 2026-10-15\n\n${UPSTREAM_SECTION_HEADING}\n\n${OWN_SECTION_HEADING}\n\n- y\n`
    const r2 = composeReleaseManifestV3({
      compositeVersion: '0.2.0-rc.3.1',
      ledger: fixtureLedger(),
      changelogText: emptyBody
    })
    t(eq('空上游股：指针落 null', r2.fields.changelogPointers.upstream, null))
    t(ok('空上游股：原因点名「空」', r2.fields.unresolvedFields.some((u) => /上游股/.test(u.reason) && /空/.test(u.reason))))

    // 段落键不存在。
    const otherSection = '## [9.9.9-rc.1.1] - 2026-01-01\n\n- z\n'
    const r3 = composeReleaseManifestV3({
      compositeVersion: '0.2.0-rc.3.1',
      ledger: fixtureLedger(),
      changelogText: otherSection
    })
    t(ok('段键不存在：原因点名段键', r3.fields.unresolvedFields.some((u) => /没有段落键/.test(u.reason))))
  }

  // --- 11. 段键前缀碰撞：`1` 不得匹配到 `10`（§4.12.3 第 4 条） ---------------
  {
    const text = `## [0.2.0-rc.3.10] - 2026-10-15\n\n${UPSTREAM_SECTION_HEADING}\n\n- 十\n`
    const ten = upstreamSectionDigest(text, '0.2.0-rc.3.10')
    const one = upstreamSectionDigest(text, '0.2.0-rc.3.1')
    t(ok('前缀碰撞：段键 10 命中', ten.ok))
    t(ok('前缀碰撞：段键 1 不命中 10', one.ok === false))
  }

  // --- 12. `upstreamSectionDigest` 的自我否证：空输入不得冒充成功 ------------
  {
    t(ok('摘要：空段键不 ok', upstreamSectionDigest('## [x] - d\n', '').ok === false))
    t(ok('摘要：空正文不 ok', upstreamSectionDigest('', 'x').ok === false))
  }

  // --- 13. 缺失字段**逐条**记录（不得只报一条笼统的「有东西缺了」） ----------
  {
    const { fields } = composeReleaseManifestV3({ compositeVersion: '0.2.0-rc.3.1', ledger: fixtureLedger() })
    const names = fields.unresolvedFields.map((u) => u.field)
    for (const expected of ['upstreamDsh.tag', 'upstreamDsh.commit', 'release.tag', 'desktop.shellCommit',
      'desktop.desktopBuild', 'runtime.patchSetHash', 'runtime.runtimeLockHash',
      'changelogPointers.upstream', 'changelogPointers.own.fromTag']) {
      t(ok(`缺失逐条：点名 ${expected}`, names.includes(expected)))
    }
    t(ok('缺失逐条：每条都带 reason', fields.unresolvedFields.every((u) => typeof u.reason === 'string' && u.reason.length > 0)))
  }

  return n
}

const isDirectRun = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv[1])
  } catch {
    return false
  }
})()

if (isDirectRun) {
  if (argv.includes('--self-test')) {
    try {
      const count = selfTest()
      console.log(`✅ manifest-v3 自测通过（${count} 项）`)
    } catch (error) {
      console.error(`❌ manifest-v3 自测失败：${error.message}`)
      exit(1)
    }
  } else {
    console.log('用法：node scripts/manifest-v3.mjs --self-test')
    console.log('（本模块是纯逻辑库；写入点是 scripts/prepare-harness.mjs 的 buildManifest）')
  }
}
