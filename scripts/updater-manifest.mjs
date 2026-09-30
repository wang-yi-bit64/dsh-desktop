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
import { channelOfPrerelease, listTargetNames, resolveTarget, targetForVersion } from './dsh-targets.mjs'

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

function parseSemver(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version).replace(/^v/, ''))
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null }
}

function comparePrerelease(a, b) {
  const as = a.split('.')
  const bs = b.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}



/**
 * 判定一个通道的更新链是否健康。**纯函数**，喂夹具即可证伪。
 * @returns {string[]} problems（空数组 = 通过）
 */
export function checkChannelManifest({ channel, manifestVersion, newestTagVersion, endpoint }) {
  const problems = []
  if (!manifestVersion) {
    problems.push('通道 ' + channel + '：端点 ' + (endpoint || '(未提供)') + ' 读不到 version——manifest 缺失或不可解析；缺了它更新链路就断。')
    return problems
  }
  let cmp
  try {
    cmp = compareSemver(manifestVersion, newestTagVersion)
  } catch (error) {
    problems.push('通道 ' + channel + '：版本无法比较（' + error.message + '）')
    return problems
  }
  if (cmp < 0) {
    problems.push(
      '通道 ' + channel + '：端点 version ' + manifestVersion + ' **低于**该通道最新已发布 tag ' +
        newestTagVersion + ' ⇒ 更新零投递（用户拿到的版本号比已安装的还小，永远不提示更新）。',
    )
  }
  return problems
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** 该通道下最新的 v* tag（只看 v* 前缀，滚动 tag 不参与比较）。 */
export function newestTagFor(channel, cwd = process.cwd()) {
  const out = git(['tag', '--list', 'v*'], cwd)
  if (!out) return null
  const candidates = out.split(/\r?\n/).map((t) => t.trim()).filter((t) => t && channelOfPrerelease(t) === channel)
  let best = null
  for (const tag of candidates) {
    if (best === null || compareSemver(tag.replace(/^v/, ''), best.replace(/^v/, '')) > 0) best = tag
  }
  return best === null ? null : best.replace(/^v/, '')
}

async function fetchManifestVersion(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'dsh-desktop-updater-channel-check' } })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const json = await response.json()
  return json.version
}

function writeConfig(version, outPath) {
  const channel = publishChannelForVersion(version)
  const endpoint = endpointFor(channel, repoSlug())
  writeFileSync(outPath, JSON.stringify({ plugins: { updater: { endpoints: [endpoint] } } }, null, 2) + '\n', 'utf8')
  console.log('[updater-manifest] ' + version + ' → 通道 ' + channel)
  console.log('[updater-manifest] 端点 ' + endpoint)
  console.log('[updater-manifest] 写入 ' + outPath)
  return { channel, endpoint }
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
  const lines = []
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
  for (const channel of channels) {
    const targetEntry = listTargetNames().map((n) => resolveTarget(n)).find((t) => t.publishChannel === channel)
    if (targetEntry.status === 'dormant') {
      lines.push('· 通道 ' + channel + '：目标已裁定休眠（ADR-056；复役见 ADR-057），跳过通道健康核对')
      continue
    }
    examined += 1
    const endpoint = endpointFor(channel, repo)
    const newest = newestTagFor(channel)
    let manifestVersion = null
    let note = ''
    try {
      manifestVersion = await fetchManifestVersion(endpoint)
    } catch (error) {
      note = '（端点不可达：' + error.message + '）'
    }
    if (newest === null) {
      lines.push('· 通道 ' + channel + '：本仓尚无该通道的 v* tag，跳过')
      continue
    }
    problems.push(...checkChannelManifest({ channel, manifestVersion, newestTagVersion: newest, endpoint }))
    lines.push('· 通道 ' + channel + '：端点 ' + (manifestVersion ?? '不可达') + ' / 最新 tag ' + newest + note)
  }
  for (const line of lines) console.log(line)
  if (examined === 0) {
    console.error('❌ 没有在役目标可核对——全部休眠时没有可断言的东西（默认目标必须在役，见 ADR-056）。')
    return 1
  }
  if (problems.length > 0) {
    for (const p of problems) console.error('❌ ' + p)
    return 1
  }
  console.log(onlyChannel
    ? '✅ 更新通道 ' + onlyChannel + '：端点 version ≥ 该通道最新已发布 tag'
    : '✅ 更新通道：每条在役通道的端点 version 均 ≥ 该通道最新已发布 tag')
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
