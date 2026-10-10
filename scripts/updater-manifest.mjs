#!/usr/bin/env node
/**
 * updater-manifest.mjs — 自动更新端点的**唯一产地**（ADR-053）
 *
 * ## 为什么有它
 * 端点原为 releases/latest/download/latest.json。GitHub 的 releases/latest **排除预发布**，
 * 而本仓自 v0.6.0-alpha.1 起每一次发布都是 prerelease ⇒ 2026-09-30 实测该 URL 返回
 * 0.5.0-next.1，而已发布到 0.7.x ⇒ **自动更新自 2026-09-15 起零投递**（任何 0.6/0.7 用户
 * 拿到的版本号低于已安装版本，于是永远不提示更新）。
 *
 * 双通道在役（ADR-052）之后，一个 latest.json 也无法表达两条线各自的更新来源。
 *
 * ## 它负责三件事（端点 URL 只在此处构造，别处不许再拼）
 *   1. --write-config <tag|版本> <out>  构建期生成覆盖 plugins.updater.endpoints 的配置
 *   2. --publish <tag>                 把该版本 Release 的 latest.json 覆盖到滚动 Release
 *   3. --verify [--tag <tag>]          核对端点 version ≥ 该通道最新 v* tag 的版本。
 *                                      给 --tag 时只核对该 tag 所属通道：发布时自检只管
 *                                      「本次发布的通道活了」——其余在役通道的问题与休眠
 *                                      目标（ADR-056，显式跳过）不属于本次发布的失败；
 *                                      全通道健康归每日 drift / 手动全量核对
 *                                      （2026-09-30 v0.7.1-rc.1 首发实测教训）
 *   4. --self-test                     纯逻辑自检（含可证伪夹具）
 *
 * ## 通道从哪来
 * 由 tag/版本经 scripts/dsh-targets.mjs 推导（targetForVersion → publishChannel），
 * 与 release.yml 选择运行时通道**同源**——「二进制里的更新源」与「它内置的运行时线」
 * 因此不可能各说各话。手写第二份通道名会漂移，本脚本拒绝这种写法。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { argv, env as processEnv, exit } from 'node:process'
import { compareSemver } from './conventional-commits.mjs'
// ⚠️ 只导入**仍在用**的：`newestTagFrom` 迁到台账侧（见该函数文档）之后，
//    `channelOfPrerelease` / `parseVersionShape` 在本文件已无使用点——留着它们正是
//    本模块文档记过的「从未被使用的导入（2d 重构残留，无 linter 因而一直没现形）」。
import { listTargetNames, resolveTarget, targetForVersion } from './dsh-targets.mjs'
// 桥接版（ADR-063）的两个判据都在台账侧：`bridges[]` 是它的登记处，
// 「该通道有没有合格桥接版」是豁免的唯一产地。本模块只**消费**，不自己判。
// 依赖方向：updater-manifest → release-ledger → dsh-targets，无环。
import { findPermittingBridge, newestPublishedForChannel, readLedger, releaseChannelOf } from './release-ledger.mjs'

export const DEFAULT_REPO = 'wang-yi-bit64/dsh-desktop'

export function repoSlug(env = processEnv) {
  return env.DSH_UPDATER_REPO || DEFAULT_REPO
}

/** 滚动 Release 的 tag：更新通道载体，**不是可安装的产品版本**。 */
export function rollingTagFor(publishChannel) {
  return 'updater-' + publishChannel
}

export function endpointFor(publishChannel, repo = DEFAULT_REPO) {
  return 'https://github.com/' + repo + '/releases/download/' + rollingTagFor(publishChannel) + '/latest.json'
}

/**
 * --verify 的作用域：给 only 时只保留该通道；不给 = 全通道（每周/手动全量核对用）。
 * 返回空数组是**配置错误**的信号（通道名不在目标总表里），调用方必须据此报错——
 * 「扫出数为 0 时先怀疑扫描器」（AGENTS.md §7.3）：作用域写错的核对一行绿都不该有。
 */
export function scopedChannels(channels, only) {
  return only ? channels.filter((c) => c === only) : channels
}

/** 版本/tag → 该版本应使用的更新通道（= 目标的 publishChannel）。未知后缀直接抛错。 */
export function publishChannelForVersion(version) {
  const target = targetForVersion(version)
  if (target === null) {
    throw new Error(
      '版本 ' + version + ' 的预发布后缀不对应任何 DSH 目标的 publishChannel；' +
        '按 ADR-022/052 的纪律，未知后缀必须失败，不得回退默认通道。',
    )
  }
  return resolveTarget(target).publishChannel
}

/**
 * 判定一个通道的更新链是否健康。**纯函数**，喂夹具即可证伪。
 *
 * 出口分工（与 `version.mjs::diagnoseVersionMonotonic` 同一形态）：
 *   · `problems` 非空 ⇒ 调用方必须判红；
 *   · `notes` 非空 ⇒ 调用方必须**打印**——豁免（ADR-063）必须留下可读依据，
 *     否则「豁免成立」与「判据根本没在查」在输出上无法区分。
 *
 * @param {object} input
 * @param {string} input.channel - 通道名（`publishChannel`）。
 * @param {string|null} input.manifestVersion - 端点 `latest.json` 里的 version。
 * @param {string} input.newestTagVersion - **该通道**最新已发布 tag 的版本号（不含前导 `v`）。
 * @param {string} [input.endpoint] - 端点 URL（仅用于报错信息）。
 * @param {object[]} [input.bridges] - 台账 `bridges[]`；给了才可能触发桥接版豁免。
 * @param {string[]} [input.tags] - 已发布 tag 语料。豁免还要求「桥接版**真的发布过**」，
 *   因此不给 `tags` 时豁免不成立（无凭据不等于默认成立，见
 *   `release-ledger.mjs::findPermittingBridge`）。
 * @returns {{ problems: string[], notes: string[] }} 诊断结果。
 */
export function diagnoseChannelManifest({ channel, manifestVersion, newestTagVersion, endpoint, bridges = [], tags = [] }) {
  const problems = []
  const notes = []
  if (!manifestVersion) {
    problems.push('通道 ' + channel + '：端点 ' + (endpoint || '(未提供)') + ' 读不到 version——manifest 缺失或不可解析；缺了它更新链路就断。')
    return { problems, notes }
  }
  let cmp
  try {
    cmp = compareSemver(manifestVersion, newestTagVersion)
  } catch (error) {
    problems.push('通道 ' + channel + '：版本无法比较（' + error.message + '）')
    return { problems, notes }
  }
  if (cmp < 0) {
    // 桥接版豁免（ADR-063）：该通道若已有一个「版本 ≥ 本通道最高已发布 tag **且其 tag 已发布**」
    // 的桥接版，说明该通道最新的号本身就是那个放宽了比较器的版本 ⇒ 后续更低的合成号可以送达。
    // ⚠️ 基准是**本通道**最新 tag（本函数的调用方就是这么传的），不是全通道最高——
    //    每个通道有自己的端点，别的通道的最高号与本通道的投递无关。
    const bridge = findPermittingBridge({ bridges, channel, atLeast: newestTagVersion, tags })
    if (bridge !== null) {
      notes.push(
        '通道 ' + channel + '：端点 version ' + manifestVersion + ' 低于本通道最新已发布 tag ' +
          newestTagVersion + '，但该通道的桥接版 v' + bridge.version + ' 覆盖了它（≥ ' + newestTagVersion +
          '）⇒ 该通道客户端的比较器已放宽为「必须不同」（' + bridge.relaxes + '，ADR-063），投递可达，故不判红。' +
          '⚠️ 这是换代期的**预期状态**，不是端点没跟上。',
      )
      return { problems, notes }
    }
    problems.push(
      '通道 ' + channel + '：端点 version ' + manifestVersion + ' **低于**该通道最新已发布 tag ' +
        newestTagVersion + ' ⇒ 更新零投递（用户拿到的版本号比已安装的还小，永远不提示更新）。' +
        (bridges.length === 0
          ? '台账 bridges[] 为空 ⇒ 没有可用作豁免的桥接版记录。'
          : 'bridges[] 里虽有 ' + bridges.length + ' 条记录，但没有本通道上「≥ ' + newestTagVersion +
            ' 且 tag 已发布」的一条。'),
    )
  }
  return { problems, notes }
}

/**
 * `diagnoseChannelManifest` 的 **problems 投影**（旧调用点语义不变）。
 * @param {object} input - 同 {@link diagnoseChannelManifest}。
 * @returns {string[]} problems（空数组 = 通过）。
 */
export function checkChannelManifest(input) {
  return diagnoseChannelManifest(input).problems
}

/**
 * 执行 git 并返回 stdout。
 *
 * 🔴 `stdin: 'ignore'` 不是可选项：Windows 上默认的 `stdin: 'pipe'` 会让 spawn 直接抛
 * `EBUSY`（本机实测 `spawnSync git EBUSY`，`errno: -4082`）。CI 在 Linux 上跑，
 * 所以这处**只在本地**会现形——`version.mjs` / `release-ledger.mjs` 的同类 helper
 * 早已统一带上它，这里此前漏了。
 */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * 从 tag 列表里挑出该通道最新的 `v*` tag。**纯函数**，喂夹具即可证伪。
 *
 * 🔴 这是**语料扫描**，不是版本校验：`git tag --list 'v*'` 的结果里可能有非 semver 的
 * tag（人工打的 tag、命名变更期的旧 tag）。这类元素必须**跳过**，绝不能让它们抛错——
 * 否则 `git tag --list` 里任一脏元素都会让整趟通道健康核对失败，且报错信息与真正的
 * 「端点 version 低于最新 tag」混在一起，无法区分是**扫描器坏了**还是**投递真的断了**。
 * 判据：喂一个含垃圾 tag 的列表，本函数必须正常返回正确结果。
 * （对照：已知的单个版本号走 `channelOfPrerelease`，形状不合法**必须**抛错——见 `ADR-061` 缺口 2i。）
 *
 * ⚠️ **实现已迁至 `release-ledger.mjs::newestPublishedForChannel`**（2026-10-09，ADR-063）：
 * 「通道 → 该通道最高已发布版本」现在有两个消费者——本模块的通道核对，以及
 * `version.mjs` 的单调性豁免。豁免必须和核对用**同一条基准**，否则会出现
 * 「核对认为端点健康、版本守卫却认为桥接版不覆盖它」。两处各留一份实现就是两个产地，
 * 迟早漂。本函数因此保留为**别名**（调用点语义不变），逻辑只有一处。
 *
 * @param {string[]} tags tag 列表（可带前导 `v`）。
 * @param {string} channel 通道名（= 目标的 `publishChannel`）。
 * @returns {string|null} 版本号（**不含**前导 `v`）；该通道无匹配时 `null`。
 */
export function newestTagFrom(tags, channel) {
  return newestPublishedForChannel(tags, channel)
}

/**
 * 读一次**全部**已发布 tag（只看 `v*` 前缀；滚动 tag `updater-*` 天然排除）。
 *
 * 为什么返回整份语料而不是「某通道最新的一个」：`--verify` 既要算每条通道的最高 tag，
 * 又要判「桥接版的 tag 到底发布没发布」（ADR-063），两者用的是同一份语料。
 * 分开读两次 = 同一事实两个产地，且可能读到不同快照（tag 正在推送时）。
 *
 * ⚠️ 浅克隆下 `git tag` 只返回部分 tag ⇒ 结果**不完整但不报错**。
 * 权威执行点仍是 `fetch-depth: 0` 的 release.yml（与 `version.mjs::readPublishedTags`
 * 的浅克隆告警同一纪律）。
 *
 * @param {string} [cwd] 仓库路径。
 * @returns {string[]} tag 语料（无 tag 时为空数组）。
 */
export function readTagCorpus(cwd = process.cwd()) {
  const out = git(['tag', '--list', 'v*'], cwd)
  return out ? out.split(/\r?\n/).filter(Boolean) : []
}

async function fetchManifestVersion(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'dsh-desktop-updater-channel-check' } })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const json = await response.json()
  return json.version
}

/**
 * 组装 `plugins.updater` 覆盖配置。**纯函数**，喂夹具即可证伪。
 *
 * 🔴 **不得无条件写 `allowDowngrades`**：它把插件的比较器从「必须更新」放宽成
 * 「必须不同」（`tauri-plugin-updater` 的 `version_comparator` 默认实现），
 * 意味着**用户可以装回更旧的版本**。这是换代桥接版必须付出的代价（ADR-063），
 * 但只该在那一个版本上付出。判据：不给放宽手段时，产物里**不许出现**该键。
 *
 * @param {object} input
 * @param {string} input.endpoint - 更新端点 URL。
 * @param {string[]} [input.relaxations] - 放宽手段（取值见 `release-ledger.mjs::BRIDGE_RELAXATIONS`）。
 * @returns {{plugins: {updater: object}}} 待写入的 JSON 值。
 * @throws {Error} 出现未知放宽手段时——构建期配不出它，等于**把桥接版发成一个普通版**，
 *   而这种失败在校验阶段完全看不出来（它只是少了一个键），必须在这里炸。
 */
export function composeUpdaterConfig({ endpoint, relaxations = [] }) {
  const updater = { endpoints: [endpoint] }
  for (const relaxation of relaxations) {
    if (relaxation === 'allowDowngrades') {
      updater.allowDowngrades = true
      continue
    }
    throw new Error(
      '未知放宽手段 ' + JSON.stringify(relaxation) + '：构建期无法把它变成插件配置。' +
        '换机制必须同时改本函数与 release-ledger.mjs::BRIDGE_RELAXATIONS（不许只改台账）。',
    )
  }
  return { plugins: { updater } }
}

/**
 * 查台账判定「这个版本是不是桥接版」，并取出它要内置的放宽手段。
 *
 * 为什么必须有这一步（而不是让 `--write-config` 一律写普通配置）：桥接版的**全部作用**
 * 就是那一行 `allowDowngrades`。少了它的桥接版与普通版在产物上毫无区别，却已经被
 * 写进台账 `bridges[]` 并被豁免判据依赖——于是整条换代链会在「豁免已成立、
 * 客户端其实收不到」的状态下静默空转。
 *
 * @param {object} input
 * @param {object} input.ledger - 台账内容（{@link readLedger} 的产物）。
 * @param {string} input.version - 版本号（可带前导 `v`）。
 * @returns {{isBridge: boolean, relaxations: string[], channel: string|null, bridge: object|null}} 判定结果。
 * @throws {Error} 同一版本在 `bridges[]` 里对应多组「通道 + 放宽手段」时——那时「该内置什么」
 *   没有唯一定论，猜一个等于伪造配置（台账侧另有守卫把「同通道同版本登记两次」判红）。
 */
export function bridgeRelaxationsFor({ ledger, version }) {
  const wanted = String(version ?? '').replace(/^v/i, '').trim()
  const hits = (ledger?.bridges ?? []).filter((bridge) => String(bridge?.version ?? '').trim() === wanted)
  if (hits.length === 0) return { isBridge: false, relaxations: [], channel: null, bridge: null }
  const channels = new Set(hits.map((bridge) => bridge.channel))
  const relaxations = new Set(hits.map((bridge) => bridge.relaxes))
  if (channels.size !== 1 || relaxations.size !== 1) {
    throw new Error(
      '台账 bridges[] 里版本 ' + wanted + ' 对应 ' + hits.length + ' 条记录，但通道/放宽手段不唯一（' +
        [...channels].join('/') + ' × ' + [...relaxations].join('/') + '）⇒ 不知道该内置什么，拒绝猜。',
    )
  }
  return { isBridge: true, relaxations: [...relaxations], channel: [...channels][0], bridge: hits[0] }
}

/**
 * 构建期生成覆盖配置（`--write-config`）。
 *
 * 读取台账以判定桥接版：台账读不到时**抛错**而不是当成「不是桥接版」——后者会把一次
 * 换代发布静默降级成普通发布（产物里少了 `allowDowngrades`，而豁免判据照旧放行）。
 * 台账是仓库内的受版本控制文件，缺失本身就是必须立刻修的状态，不是可以兜底的输入。
 */
function writeConfig(version, outPath) {
  const channel = publishChannelForVersion(version)
  const endpoint = endpointFor(channel, repoSlug())
  let ledger
  try {
    ledger = readLedger(process.cwd())
  } catch (error) {
    throw new Error(
      '--write-config 需要台账来判定「本版是不是桥接版」（ADR-063），但读不到：' + error.message +
        '（不存在「当成不是桥接版」的兜底——那会把换代版静默发成普通版。）',
    )
  }
  const bridging = bridgeRelaxationsFor({ ledger, version })
  if (bridging.isBridge && bridging.channel !== channel) {
    // 台账侧 validateBridge 已断言「记录 channel == 由 target 现算的 publishChannel」。
    // 这里再断言一次是**消费点自查**：写盘面才是产生后果的地方，且台账可能在登记后被手改。
    throw new Error(
      '桥接版 ' + version + ' 在台账里记的通道是 ' + bridging.channel + '，但由版本号现算的通道是 ' +
        channel + ' ⇒ 豁免会去找错通道的桥接版。先在台账侧修好这条记录。',
    )
  }
  const config = composeUpdaterConfig({ endpoint, relaxations: bridging.relaxations })
  writeFileSync(outPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
  console.log('[updater-manifest] ' + version + ' → 通道 ' + channel)
  console.log('[updater-manifest] 端点 ' + endpoint)
  if (bridging.isBridge) {
    console.log(
      '[updater-manifest] ⚠️ 本版是桥接版（ADR-063）：内置 ' + bridging.relaxations.join(', ') +
        '（比较器放宽为「必须不同」——这条路只该走一次，用于把已装用户带过版本号换代处）',
    )
  }
  console.log('[updater-manifest] 写入 ' + outPath)
  return { channel, endpoint, relaxations: bridging.relaxations }
}

function publish(tag) {
  const version = tag.replace(/^v/, '')
  const channel = publishChannelForVersion(version)
  const rolling = rollingTagFor(channel)
  // 滚动 tag 必须指向**本次发布的提交**，而不是默认分支的 HEAD：否则它会落在无关
  // 提交上，任何漏加 --match 'v*' 的 tag 发现路径都会算错发布区间（ADR-053 的后果段）。
  const target = git(['rev-list', '-n1', tag], process.cwd())
  const dir = mkdtempSync(join(tmpdir(), 'dsh-updater-'))
  execFileSync('gh', ['release', 'download', tag, '-p', 'latest.json', '-O', join(dir, 'latest.json'), '--clobber'], { stdio: 'inherit' })
  let exists = true
  try {
    execFileSync('gh', ['release', 'view', rolling], { stdio: 'ignore' })
  } catch {
    exists = false
  }
  if (!exists) {
    execFileSync(
      'gh',
      [
        'release', 'create', rolling,
        '--target', target,
        '--prerelease', '--latest=false',
        '--title', 'Updater channel: ' + channel + ' (rolling)',
        '--notes', '更新通道载体，**不是可安装版本**（ADR-053）。最新 manifest 由 release 工作流覆盖上传。',
      ],
      { stdio: 'inherit' },
    )
  }
  execFileSync('gh', ['release', 'upload', rolling, join(dir, 'latest.json'), '--clobber'], { stdio: 'inherit' })
  console.log('[updater-manifest] 已把 ' + tag + ' 的 latest.json 覆盖到 ' + rolling)
}

async function verify(onlyChannel = null) {
  const repo = repoSlug()
  const problems = []
  const notes = []
  const lines = []
  // 桥接版豁免（ADR-063）的依据只来自台账。读不到**必须**停在这里：
  // 若当成「没有桥接版」，合成号换代期会把「预期内的低投递」报成「投递断了」，
  // 而那两件事的处置完全不同（一个是正常、一个是发布事故）。
  let bridges
  try {
    bridges = readLedger(process.cwd()).bridges ?? []
  } catch (error) {
    console.error('❌ 读不到台账 ⇒ 无法判定桥接版豁免（ADR-063）：' + error.message)
    return 1
  }
  // 同一份 tag 语料同时喂给「通道最高 tag」与「桥接版是否已发布」两个判据。
  const tags = readTagCorpus()
  const channels = scopedChannels(
    listTargetNames().map((name) => resolveTarget(name).publishChannel),
    onlyChannel,
  )
  if (channels.length === 0) {
    console.error('❌ 作用域通道 ' + onlyChannel + ' 不在 dsh-targets 总表里——先修通道名，再谈核对。')
    return 1
  }
  // examined：实际被核对的**在役**通道数。休眠目标（ADR-056）显式跳过、不计入；
  // 若为 0，下面必须报错——「没有可核对的东西」不能冒充「核对通过」（扫出数 > 0 纪律）。
  let examined = 0
  // 三种结局分开计数：结论行必须**按实际发生过什么**来写，不能笼统地宣称全部健康。
  let strictOk = 0
  let exempted = 0
  let skippedNoTag = 0
  for (const channel of channels) {
    const targetEntry = listTargetNames().map((n) => resolveTarget(n)).find((t) => t.publishChannel === channel)
    if (targetEntry.status === 'dormant') {
      lines.push('· 通道 ' + channel + '：目标已裁定休眠（ADR-056；复役见 ADR-057），跳过通道健康核对')
      continue
    }
    examined += 1
    const endpoint = endpointFor(channel, repo)
    const newest = newestPublishedForChannel(tags, channel)
    let manifestVersion = null
    let note = ''
    try {
      manifestVersion = await fetchManifestVersion(endpoint)
    } catch (error) {
      note = '（端点不可达：' + error.message + '）'
    }
    if (newest === null) {
      lines.push('· 通道 ' + channel + '：本仓尚无该通道的 v* tag，跳过')
      skippedNoTag += 1
      continue
    }
    const verdict = diagnoseChannelManifest({ channel, manifestVersion, newestTagVersion: newest, endpoint, bridges, tags })
    problems.push(...verdict.problems)
    notes.push(...verdict.notes)
    if (verdict.notes.length > 0) exempted += 1
    else if (verdict.problems.length === 0) strictOk += 1
    lines.push('· 通道 ' + channel + '：端点 ' + (manifestVersion ?? '不可达') + ' / 最新 tag ' + newest + note)
  }
  for (const line of lines) console.log(line)
  // 豁免是**例外路径**，必须显式留痕（否则「豁免成立」与「判据没查」输出一样）。
  for (const note of notes) console.log('ℹ️  ' + note)
  if (examined === 0) {
    console.error('❌ 没有在役目标可核对——全部休眠时没有可断言的东西（默认目标必须在役，见 ADR-056）。')
    return 1
  }
  if (problems.length > 0) {
    for (const p of problems) console.error('❌ ' + p)
    return 1
  }
  // ⚠️ 有豁免时**不得**宣称「端点 version ≥ 该通道最新已发布 tag」——那是假的：
  //    豁免场景的定义就是端点 version **低于**它。结论行按实际结局分项写（ADR-007）。
  const scope = onlyChannel ? '更新通道 ' + onlyChannel : '更新通道'
  const parts = []
  if (strictOk > 0) parts.push(strictOk + ' 条通道端点 version ≥ 该通道最新已发布 tag')
  if (exempted > 0) {
    parts.push(
      exempted + ' 条通道走**桥接版豁免**（ADR-063：端点 version 低于最新 tag，但该通道的桥接版' +
        '已把客户端比较器放宽为「必须不同」⇒ 投递可达；依据见上方 ℹ️ 行）',
    )
  }
  if (skippedNoTag > 0) parts.push(skippedNoTag + ' 条通道尚无 v* tag（无比较对象，未核对）')
  console.log('✅ ' + scope + '：' + (parts.length > 0 ? parts.join('；') + '。' : '（无可断言对象）'))
  return 0
}

export function selfTest() {
  let failed = 0
  let total = 0
  const eq = (name, actual, expected) => {
    total += 1
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) { console.error('❌ ' + name + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual)); failed += 1 }
  }
  eq('通道：rc 后缀', publishChannelForVersion('0.7.0-rc.1'), 'rc')
  eq('通道：alpha 后缀', publishChannelForVersion('0.7.0-alpha.8'), 'alpha')
  eq('通道：带前导 v', publishChannelForVersion('v0.7.0-rc.1'), 'rc')
  eq('端点：由通道推导', endpointFor('rc'), 'https://github.com/wang-yi-bit64/dsh-desktop/releases/download/updater-rc/latest.json')
  eq('端点：alpha', endpointFor('alpha', 'o/r'), 'https://github.com/o/r/releases/download/updater-alpha/latest.json')
  eq('滚动 tag 与产品 tag 不同名', rollingTagFor('rc') !== 'v0.7.0-rc.1', true)
  eq('semver：alpha.8 < rc.1', compareSemver('0.7.0-alpha.8', '0.7.0-rc.1') < 0, true)
  eq('semver：rc.1 < 正式版', compareSemver('0.7.0-rc.1', '0.7.0') < 0, true)
  eq('semver：patch 位前进即更高', compareSemver('0.7.1-alpha.1', '0.7.0-rc.1') > 0, true)
  eq('semver：相等', compareSemver('0.7.0-rc.1', '0.7.0-rc.1'), 0)
  // 🔴 可伪证性夹具：2026-09-30 的**真实线上状态**——端点 0.5.0-next.1、已发布到 0.7.0-rc.1。
  const broken = checkChannelManifest({ channel: 'rc', manifestVersion: '0.5.0-next.1', newestTagVersion: '0.7.0-rc.1' })
  eq('可伪证：修复前的真实状态必须报红', broken.length > 0, true)
  eq('可伪证：报错必须点明低投递', /低于/.test(broken.join(' ')), true)
  eq('健康：端点等于最新 tag', checkChannelManifest({ channel: 'rc', manifestVersion: '0.7.0-rc.1', newestTagVersion: '0.7.0-rc.1' }).length, 0)
  eq('健康：端点高于最新 tag', checkChannelManifest({ channel: 'rc', manifestVersion: '0.7.1-rc.1', newestTagVersion: '0.7.0-rc.1' }).length, 0)
  eq('端点缺失必须报红', checkChannelManifest({ channel: 'rc', manifestVersion: null, newestTagVersion: '0.7.0-rc.1' }).length > 0, true)
  eq('未知后缀必须抛错（不得回退默认通道）', (() => { try { publishChannelForVersion('0.7.0-beta.1'); return 'no-throw' } catch { return 'throw' } })(), 'throw')
  // 作用域（2026-09-30 v0.7.1-rc.1 首发实测：无作用域的全通道断言把 alpha 的引导期
  // 404 误判成本次发布失败——发布时自检只管本次通道，全通道归 drift/手动核对）
  eq('scope：指定通道只留自己', scopedChannels(['rc', 'alpha'], 'rc'), ['rc'])
  eq('scope：不给作用域 = 全通道', scopedChannels(['rc', 'alpha'], null), ['rc', 'alpha'])
  eq('scope：作用域写错必须扫出 0（调用方据此报错）', scopedChannels(['rc', 'alpha'], 'beta'), [])
  // 目标状态：休眠/复役都是**有记录的裁定**（ADR-056 → ADR-057），本行把裁定钉在自测里——
  // 休眠目标跳过通道健康核对；跳过必须显式出现在输出里，且不能冒充「已核对」
  // （verify 里 examined 计数守着这条）。
  eq('目标状态：alpha 已复役（ADR-057 修订 ADR-056）', resolveTarget('alpha').status, 'active')
  eq('目标状态：next 在役', resolveTarget('next').status, 'active')
  // 🔴 tag 扫描的**语料**语义：脏元素必须被跳过，不得炸掉整趟扫描
  //    （本仓缺陷族「守卫只覆盖 N 段里的 N-1 段」的镜像：把校验判据错用在扫描点上）
  eq('扫描：含垃圾 tag 的列表照常返回', newestTagFrom(['vNext', 'v0.7.0-rc.1', 'v0.7', ''], 'rc'), '0.7.0-rc.1')
  eq('扫描：垃圾 tag 在前也不受影响', newestTagFrom(['vNext', 'batch-2026', 'v0.7.0-rc.1'], 'rc'), '0.7.0-rc.1')
  eq('扫描：只挑本通道，不取全局最高', newestTagFrom(['v0.7.3-alpha.1', 'v0.7.2-rc.1'], 'rc'), '0.7.2-rc.1')
  eq('扫描：本通道无 tag → null', newestTagFrom(['v0.7.0-alpha.8', 'vNext'], 'rc'), null)
  eq('扫描：空列表 → null', newestTagFrom([], 'rc'), null)
  eq('扫描：版本号不带前导 v 返回', newestTagFrom(['v0.7.1-rc.1', 'v0.7.0-rc.1'], 'rc'), '0.7.1-rc.1')
  eq(
    '扫描：整趟不抛错（脏语料下）',
    (() => { try { newestTagFrom(['x', '', 'vNext', 'v0.7.0-rc.1'], 'rc'); return 'ok' } catch { return 'throw' } })(),
    'ok'
  )
  // 🔴 两分法（对称失效守卫）：**同一个输入、两种意图、相反结果**，期望值硬编码。
  //    若有人把扫描点改回抛错入口，第一条会变 throw。
  eq(
    '两分法：同一串在扫描里只是被跳过',
    newestTagFrom(['v0.7.0.1-rc.1', 'v0.7.0-rc.1'], 'rc'),
    '0.7.0-rc.1'
  )
  eq(
    '两分法：同一串作「已知版本号」必须抛错',
    (() => { try { publishChannelForVersion('0.7.0.1-rc.1'); return 'no-throw' } catch { return 'throw' } })(),
    'throw'
  )
  // 合成版本号（ADR-061）：本仓序号追加在上游预发布段之后，通道判定只看首标识符
  eq('合成号：通道判定不受本仓序号影响', publishChannelForVersion('0.2.1-alpha.1.3'), 'alpha')
  eq('合成号：rc 合成号 → rc 通道', publishChannelForVersion('0.2.0-rc.3.1'), 'rc')
  eq('合成号：扫描取本仓序号最高的那个', newestTagFrom(['v0.2.1-alpha.1.3', 'v0.2.1-alpha.1.10'], 'alpha'), '0.2.1-alpha.1.10')

  // === ADR-063：桥接版（bridges[]）==========================================
  const BRIDGE_RC = { version: '0.7.3-rc.1', tag: 'v0.7.3-rc.1', channel: 'rc', target: 'next', upstreamDsh: '0.2.0-rc.2', relaxes: 'allowDowngrades', date: '2026-10-09' }
  const BRIDGE_ALPHA = { ...BRIDGE_RC, version: '0.7.4-alpha.1', tag: 'v0.7.4-alpha.1', channel: 'alpha', target: 'alpha', upstreamDsh: '0.2.1-alpha.1' }

  // 🔴 跨模块一致性（跨模块漂移是这一类 bug 的常见形态）：本模块的
  //    `publishChannelForVersion` 与台账侧的 `releaseChannelOf` 必须同答——
  //    前者决定**构建期用哪个端点**，后者决定**豁免去哪个通道找桥接版**。
  //    两者分头实现，任一侧改了后缀表而另一侧没跟，这条立刻变红。
  for (const version of ['0.7.0-rc.1', '0.7.0-alpha.8', '0.2.1-alpha.1.3', '0.2.0-rc.3.1', '0.7.3-rc.1', '0.2.1']) {
    let lhs
    let rhs
    try { lhs = publishChannelForVersion(version) } catch { lhs = 'throw' }
    try { rhs = releaseChannelOf(version) } catch { rhs = 'throw' }
    eq('跨模块：通道推导同答（' + version + '）', lhs, rhs)
  }
  eq(
    '跨模块：未知后缀两侧都必须判 null / 抛错，不许一边放行',
    [releaseChannelOf('0.7.0-beta.1'), (() => { try { publishChannelForVersion('0.7.0-beta.1'); return 'no-throw' } catch { return 'throw' } })()],
    [null, 'throw'],
  )

  // 构建配置组装：**只有**给了放宽手段时才出现 allowDowngrades。
  const plainConfig = composeUpdaterConfig({ endpoint: endpointFor('rc') })
  eq('配置：普通版不含 allowDowngrades（放宽只该在桥接版上付出）', 'allowDowngrades' in plainConfig.plugins.updater, false)
  eq('配置：端点仍写在 endpoints 里', plainConfig.plugins.updater.endpoints.length, 1)
  const bridgeConfig = composeUpdaterConfig({ endpoint: endpointFor('rc'), relaxations: ['allowDowngrades'] })
  eq('配置：桥接版内置 allowDowngrades', bridgeConfig.plugins.updater.allowDowngrades, true)
  eq('配置：放宽不影响端点', bridgeConfig.plugins.updater.endpoints, [endpointFor('rc')])
  eq(
    '配置：未知放宽手段必须抛错（配不出来 = 桥接版会静默变成普通版）',
    (() => { try { composeUpdaterConfig({ endpoint: endpointFor('rc'), relaxations: ['versionComparator'] }); return 'no-throw' } catch { return 'throw' } })(),
    'throw'
  )
  // 台账查询：命中 / 未命中 / 同版本多义
  eq('台账查询：命中桥接版', bridgeRelaxationsFor({ ledger: { bridges: [BRIDGE_RC] }, version: 'v0.7.3-rc.1' }).isBridge, true)
  eq('台账查询：命中时取出放宽手段', bridgeRelaxationsFor({ ledger: { bridges: [BRIDGE_RC] }, version: '0.7.3-rc.1' }).relaxations, ['allowDowngrades'])
  eq('台账查询：非桥接版', bridgeRelaxationsFor({ ledger: { bridges: [BRIDGE_RC] }, version: '0.7.3-alpha.1' }), { isBridge: false, relaxations: [], channel: null, bridge: null })
  eq('台账查询：空 bridges 不炸', bridgeRelaxationsFor({ ledger: { bridges: [] }, version: '0.7.3-rc.1' }).isBridge, false)
  eq('台账查询：ledger 无 bridges 键也不炸', bridgeRelaxationsFor({ ledger: {}, version: '0.7.3-rc.1' }).isBridge, false)
  eq(
    '台账查询：同版本跨通道重复登记必须抛错（内置什么无唯一定论，拒绝猜）',
    (() => {
      try {
        bridgeRelaxationsFor({ ledger: { bridges: [BRIDGE_RC, { ...BRIDGE_RC, channel: 'alpha' }] }, version: '0.7.3-rc.1' })
        return 'no-throw'
      } catch { return 'throw' }
    })(),
    'throw'
  )

  // 通道健康核对：桥接版豁免不得把真事故一起放行。
  // `TAGS_RC` = 该通道的 tag 语料，**含桥接版自己那条**——「已送达」是豁免的必要条件。
  const TAGS_RC = ['v0.7.2-rc.1', 'v0.7.3-rc.1']
  eq('通道核对：不登记桥接版时低投递仍报红',
    diagnoseChannelManifest({ channel: 'rc', manifestVersion: '0.2.0-rc.2.1', newestTagVersion: '0.7.3-rc.1' }).problems.length > 0, true)
  const exemptVerdict = diagnoseChannelManifest({ channel: 'rc', manifestVersion: '0.2.0-rc.2.1', newestTagVersion: '0.7.3-rc.1', bridges: [BRIDGE_RC], tags: TAGS_RC })
  eq('通道核对：桥接版覆盖后不判红', exemptVerdict.problems, [])
  eq('通道核对：豁免必须留 note（禁止无声通过）', exemptVerdict.notes.length, 1)
  eq('通道核对：note 必须点名桥接版与放宽手段', /0\.7\.3-rc\.1/.test(exemptVerdict.notes[0]) && /allowDowngrades/.test(exemptVerdict.notes[0]), true)
  eq('通道核对：别的通道的桥接版不许豁免本通道',
    diagnoseChannelManifest({ channel: 'rc', manifestVersion: '0.2.0-rc.2.1', newestTagVersion: '0.7.3-rc.1', bridges: [BRIDGE_ALPHA], tags: TAGS_RC }).problems.length > 0, true)
  eq('通道核对：桥接版低于本通道最新 tag 时不许豁免',
    diagnoseChannelManifest({ channel: 'rc', manifestVersion: '0.2.0-rc.2.1', newestTagVersion: '0.8.0-rc.1', bridges: [BRIDGE_RC], tags: [...TAGS_RC, 'v0.8.0-rc.1'] }).problems.length > 0, true)
  // 🔴 可伪证夹具：「台账登记了但 tag 没发」必须与真事故一样判红——
  //    否则豁免会在「客户端其实收不到」的状态下被放行。
  eq('通道核对：桥接版已登记但**未发布 tag** ⇒ 仍判红',
    diagnoseChannelManifest({ channel: 'rc', manifestVersion: '0.2.0-rc.2.1', newestTagVersion: '0.7.3-rc.1', bridges: [BRIDGE_RC], tags: [] }).problems.length > 0, true)
  eq('通道核对：不给 tags ⇒ 豁免不成立（无凭据不等于默认成立）',
    diagnoseChannelManifest({ channel: 'rc', manifestVersion: '0.2.0-rc.2.1', newestTagVersion: '0.7.3-rc.1', bridges: [BRIDGE_RC] }).problems.length > 0, true)
  eq('通道核对：报红必须说明「有记录但没有合格的一条」',
    /没有本通道上/.test(diagnoseChannelManifest({ channel: 'rc', manifestVersion: '0.2.0-rc.2.1', newestTagVersion: '0.7.3-rc.1', bridges: [BRIDGE_ALPHA], tags: TAGS_RC }).problems[0]), true)
  eq('通道核对：健康通道既无 problem 也无 note',
    JSON.stringify(diagnoseChannelManifest({ channel: 'rc', manifestVersion: '0.7.3-rc.1', newestTagVersion: '0.7.3-rc.1', bridges: [BRIDGE_RC], tags: TAGS_RC })),
    JSON.stringify({ problems: [], notes: [] }))
  eq('兼容：checkChannelManifest 仍只返回 problems',
    checkChannelManifest({ channel: 'rc', manifestVersion: '0.2.0-rc.2.1', newestTagVersion: '0.7.3-rc.1', bridges: [BRIDGE_RC], tags: TAGS_RC }),
    [])
  // 同一份语料喂两个判据：通道最高 tag 必须取本通道的，桥接版必须真的在里面。
  eq('语料：通道最高 tag 就取自这份语料', newestPublishedForChannel(TAGS_RC, 'rc'), '0.7.3-rc.1')
  eq('语料：桥接版那条确实在语料里（豁免前提可核）', TAGS_RC.includes('v' + BRIDGE_RC.version), true)


  if (failed > 0) { console.error('updater-manifest self-test 失败 ' + failed + ' 项'); return 1 }
  console.log('✅ updater-manifest 自检通过（' + total + ' 项）')
  return 0
}

async function main() {
  const args = argv.slice(2)
  if (args.includes('--self-test')) return selfTest()
  if (args.includes('--write-config')) {
    const i = args.indexOf('--write-config')
    const version = args[i + 1]
    const out = args[i + 2]
    if (!version || !out) { console.error('用法：--write-config <tag|版本> <输出路径>'); return 2 }
    writeConfig(version, out)
    return 0
  }
  if (args.includes('--publish')) {
    const i = args.indexOf('--publish')
    const tag = args[i + 1]
    if (!tag) { console.error('用法：--publish <tag>'); return 2 }
    publish(tag)
    return 0
  }
  if (args.includes('--verify')) {
    let onlyChannel = null
    if (args.includes('--tag')) {
      const i = args.indexOf('--tag')
      const tag = args[i + 1]
      if (!tag) { console.error('用法：--verify [--tag <tag>]'); return 2 }
      try {
        onlyChannel = publishChannelForVersion(tag)
      } catch (error) {
        console.error('❌ 无法从 tag 推导通道：' + error.message)
        return 2
      }
    }
    return verify(onlyChannel)
  }
  console.log('用法：updater-manifest.mjs --write-config <tag|版本> <out> | --publish <tag> | --verify [--tag <tag>] | --self-test')
  return 2
}

if (import.meta.url === (await import('node:url')).pathToFileURL(argv[1] ?? '').href) {
  exit(await main())
}
