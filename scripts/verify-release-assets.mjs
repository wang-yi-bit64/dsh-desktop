#!/usr/bin/env node
/**
 * verify-release-assets.mjs — Release 资产清单判据（F13 的真守卫）。
 *
 * ## 为什么存在（2026-09-24）
 *
 * `AGENTS.md` §8.5 声明「一次完整发布的期望资产数是 **13** = 9 平台安装包
 * + 1 `latest.json` + 3 个便携版」。但**这个数字此前没有任何可执行判据**——
 * 它只活在文档里，是一句**承诺**而不是**断言**。
 *
 * 于是 F13 得以潜伏：CLI 通道退役时，`cli-publish` job（做「下载 artifact →
 * 核验 → `gh release upload` → 写正文」四件事）被整个删掉，其中**便携版那半截
 * 职责没有被搬走**。此后每次发布的实际资产是 10 而不是 13——而全部门禁绿灯。
 *
 * 「口径改了、实现与判据双双缺席」是本仓的已知缺陷族。本脚本补的就是**判据**那一半：
 * 把 13 拆成**逐项枚举的名字**，让「少一个」当场变成红，而不是等用户发现。
 *
 * ## 判据分两层（不能只做一层）
 *
 * | 层 | 对象 | 回答的问题 |
 * |---|---|---|
 * | **L1 形状** | `release.yml` 文本 | 工作流**结构上**能不能产出这 13 个？ |
 * | **L2 清单** | 真实 Release（需 `gh`，可选） | 某次发布**实际**产出了几个？ |
 *
 * L1 可静态跑、进 CI；L2 要联网、只在发布后或本地手动跑（`--check-release <tag>`）。
 * 只做 L2 的话，缺陷要等下次真发布才暴露；只做 L1 的话，管不住「工作流对但跑错了」。
 *
 * ## L2 同时核对 **Release 的自身属性**（F15，2026-10-10）
 *
 * 资产齐 ≠ 发布正确。`docs/version-policy.md` §5.3 的发布后回读同时要求
 * 「`prerelease` 与目标通道一致、`draft: false`」，但**那两条此前没有任何判据**：
 * `prerelease` 在本仓全部代码里只出现过两次，一次在注释里、一次是滚动 tag 的
 * `gh release create --prerelease`。后果是 rc 线的 3 个 Release（`v0.7.2-rc.1`、
 * `v0.2.0-rc.2.1`、`v0.2.0-rc.2.2`）实际是 `prerelease=false`——它们因此进了
 * `releases/latest`，stable 用户看到的「最新版」是 rc 构建。**全部门禁绿灯。**
 *
 * 因此 L2 现在成对地断言（tag 的版本号决定应当是什么，不看工作流怎么写的）：
 *
 * | 断言 | 判据 | 错了的后果 |
 * |---|---|---|
 * | `prerelease` | 版本号**带**预发布段 ⇔ `true` | 预发布进 latest ⇒ stable 用户收到 rc；正式版被标预发布 ⇒ 从 latest 里消失 |
 * | `draft` | 必须 `false` | 草稿对用户不可见，而资产与滚动端点都已是新版（外表完全正常） |
 *
 * ⚠️ 覆盖面边界（诚实说明）：**不**断言「正式版应当等于 `releases/latest`」——
 * 那需要额外一次 API 调用去解 ref，且 `make_latest` 的语义会随 GitHub 侧变化
 * （本仓无 stable 发布，这条路径至今零执行，写判据等于凭空规定行为）。
 *
 * ## 为什么名字要逐项枚举，而不是只数个数
 *
 * 「== 13 个」这条判据可以被 13 个**错误**的资产满足（比如少了便携版却多了
 * 4 个 `.sig`）。枚举名字才能回答「是不是**要的那 13 个**」。
 * 这正是本仓在别处已确立的纪律：判据要能证伪，不是能计数。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-release-assets.mjs                  # L1：静态校验 release.yml 形状
 * node scripts/verify-release-assets.mjs --self-test      # 自测（含可伪证夹具）
 * node scripts/verify-release-assets.mjs --check-release v0.7.0-alpha.7
 *                                                         # L2：核对真实 Release（资产 + 属性，需 gh + 联网）
 * node scripts/verify-release-assets.mjs --print-expected # 打印期望清单（供人工比对）
 * ```
 *
 * 退出码：`0` 通过 · `1` 判据失败 · `2` 参数错误。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { argv, env, exit } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 「这个 tag 应不应当是预发布」的判据**不在本文件里自造**：形状正则的唯一产地是
// `dsh-targets.mjs` 的 `parseVersionShape`（`channelOfPrerelease` 也委托它）。
// 用 `parseVersionShape` 而不是抛错的 `channelOfPrerelease`：这里消费的是**tag 字符串**
// 这类来路不明的语料，脏输入应当变成一条可读的 problems，而不是让整趟核对崩栈。
import { parseVersionShape } from './dsh-targets.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_YML = join(projectRoot, '.github', 'workflows', 'release.yml')

/**
 * 期望资产数的**权威值**（与 `AGENTS.md` §8.5 同源）。
 *
 * ⚠️ 改这个数字必须同时改 `AGENTS.md` §8.5 与 `README`（若有提及），
 * 三处不一致会被 `verify:claims` 的宣称纪律抓——但那个守卫管的是**文档之间**
 * 一致，管不住「文档与工作流一致」。本脚本补的正是后者。
 */
export const EXPECTED_ASSET_COUNT = 13

/**
 * 平台安装包的枚举（**10 个**：9 安装包/签名 + 1 `latest.json` 由 tauri-action 产出）。
 *
 * ## 🔴 命名前缀是实测出来的，不是推出来的（2026-09-24 踩过）
 *
 * `tauri.conf.json` 的 `productName` 是 **`DSH Desktop`**（带空格）。
 * tauri-bundler 按平台把它渲染成不同形状：
 *
 * | 资产 | 真实形状 | 备注 |
 * |---|---|---|
 * | Windows 安装包 | `DSH.Desktop_<ver>_x64-setup.exe` | `.` 作产品名分隔、`_` 作版本分隔 |
 * | macOS dmg | `DSH.Desktop_<ver>_aarch64.dmg` | **只出 aarch64 一个**（x64 dmg 不存在） |
 * | macOS updater 包 | `DSH.Desktop_aarch64.app.tar.gz` | **无版本段** |
 * | Linux 包 | `DSH.Desktop_<ver>_amd64.{deb,AppImage}` | 各带 `.sig` |
 *
 * 我第一版把模式写成 `^DSH-Desktop-.*-setup\.exe$`（连字符、产品名也错），
 * 而**自测夹具用的就是我自己编的名字** ⇒ 13 项全绿，却一个真实资产都匹配不上。
 * 这是本仓「自测与被测犯同一个错 → 对称失效」的又一例：夹具必须取自**真实 Release**
 * 抄下来的名字，否则它测的只是自己的假设。
 *
 * 故本清单的期望值**全部来自实测**（`gh api .../releases/tags/v0.7.0-alpha.7`
 * 的 `assets[].name`，过滤掉已退役的 CLI 资产后恰为 13 项）。命名若变化判据会红——
 * 这正是想要的信号（说明 bundler 的规则变了）。
 */
export const PLATFORM_ASSET_PATTERNS = [
  // Windows / NSIS（安装包 + 签名）
  { pattern: /^DSH\.Desktop_\S+_x64-setup\.exe$/, platform: 'windows', kind: 'installer' },
  { pattern: /^DSH\.Desktop_\S+_x64-setup\.exe\.sig$/, platform: 'windows', kind: 'signature' },
  // macOS：dmg（只 aarch64）+ updater 包（无版本段）+ 后者签名
  { pattern: /^DSH\.Desktop_\S+_aarch64\.dmg$/, platform: 'macos', kind: 'installer' },
  { pattern: /^DSH\.Desktop_aarch64\.app\.tar\.gz$/, platform: 'macos', kind: 'updater-bundle' },
  { pattern: /^DSH\.Desktop_aarch64\.app\.tar\.gz\.sig$/, platform: 'macos', kind: 'signature' },
  // Linux：deb + AppImage，各带签名
  { pattern: /^DSH\.Desktop_\S+_amd64\.deb$/, platform: 'linux', kind: 'installer' },
  { pattern: /^DSH\.Desktop_\S+_amd64\.deb\.sig$/, platform: 'linux', kind: 'signature' },
  { pattern: /^DSH\.Desktop_\S+_amd64\.AppImage$/, platform: 'linux', kind: 'installer' },
  { pattern: /^DSH\.Desktop_\S+_amd64\.AppImage\.sig$/, platform: 'linux', kind: 'signature' }
]

/**
 * 便携版产物的三件（`package-portable.mjs` 产出）。
 *
 * 基线名 = `portableBaseName(version)` = `DSH-Desktop-<version>-portable`：
 *   1. `<base>.zip`
 *   2. `<base>.zip.sha256`（边车，格式 `<hex>  <文件名>`）
 *   3. `<base>.manifest.json`
 */
export const PORTABLE_ASSET_PATTERNS = [
  { pattern: /^DSH-Desktop-.*-portable\.zip$/, kind: 'archive' },
  { pattern: /^DSH-Desktop-.*-portable\.zip\.sha256$/, kind: 'sidecar' },
  { pattern: /^DSH-Desktop-.*-portable\.manifest\.json$/, kind: 'manifest' }
]

/** updater 清单（tauri-action 生成，`uploadUpdaterJson` 默认开）。 */
export const UPDATER_ASSET_PATTERN = /^latest\.json$/

/** 仅由 tauri-action 产出的资产（不由 `gh release upload` 上传）。 */
export const TAURI_ACTION_ASSETS = [
  ...PLATFORM_ASSET_PATTERNS,
  { pattern: UPDATER_ASSET_PATTERN, platform: 'all', kind: 'updater-manifest' }
]

/** 仅由 `publish-assets` job 的 `gh release upload` 上传的资产。 */
export const PUBLISH_ASSETS_ASSETS = PORTABLE_ASSET_PATTERNS

/**
 * 去掉整行注释。
 *
 * 与 `verify-release-workflow.mjs` 的同名函数同源、同理由：本仓已两次踩到
 * 「退役说明在 YAML 里逐字引用了某个动作，而判据扫全文 → 守卫被自己的文档命中」。
 * 判据必须在**代码面**上跑，不在**说明面**上跑。
 *
 * 边界：只剥整行注释，不处理行尾 `# …`（引号内的 `#` 正则区分不了）。
 *
 * @param {string} text YAML 全文
 * @returns {string} 剥掉整行注释后的文本（保留行结构）
 */
export function stripYamlComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

/**
 * 从 `release.yml` 抽出每个 job 的文本块。
 *
 * @param {string} text release.yml 全文（已剥注释）
 * @param {string} name job 名
 * @returns {string|null} job 文本块；不存在时 `null`
 */
export function jobBlock(text, name) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => new RegExp(`^  ${name}:\\s*$`).test(line))
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^  \S/.test(line) || /^[a-z]/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/**
 * L1 静态判据：`release.yml` 的形状**能不能**产出 13 个资产。
 *
 * 判据五条（缺一不可）：
 *   P1 `build` job 用 tauri-action 且带 `prerelease` 从版本号派生（tauri-action
 *      负责 9 安装包 + `latest.json`）；
 *   P2 `portable` job 产出 `dist/portable/*` 并 `upload-artifact`（3 件）；
 *   P3 **存在**把 `dist/portable/*` 上传到 Release 的动作（F13 的直防）；
 *   P4 该动作用的是 `--clobber`（重复发布时可覆盖，否则重跑会因重名失败）；
 *   P5 `releaseDraft: false`（草稿发布对用户不可见，而资产与滚动端点都已是新版）。
 *
 * ⚠️ P3 是**唯一**能直接拦住 F13 的判据。它在 F13 修复前会红——实测过。
 *
 * @param {string} text release.yml 全文
 * @returns {{ok: boolean, problems: string[], findings: string[]}} 判定结果
 */
export function checkAssetShape(text) {
  const problems = []
  const findings = []
  const code = stripYamlComments(text)

  // P1：build job 负责 9 安装包 + latest.json（由 tauri-action 上传）。
  const build = jobBlock(code, 'build')
  if (!build) {
    problems.push('没有 `build` job——9 个平台安装包与 `latest.json` 无从产生')
  } else {
    if (!/uses:\s*tauri-apps\/tauri-action@/.test(build)) {
      problems.push('`build` 没有用 `tauri-apps/tauri-action`——安装包与 `latest.json` 的产出通道不明')
    }
    if (!/prerelease:\s*\$\{\{/.test(build)) {
      problems.push(
        '`build` 的 `prerelease` 不是从版本号派生——硬编码会让预发布被标成正式版，' +
          '进而进 releases/latest（stable 用户收到 rc 更新）'
      )
    } else {
      findings.push('build：tauri-action + prerelease 派生 ✅')
    }
    // P1b：Release 不得是草稿（2026-10-10 新增，与 L2 的属性断言成对）。
    //      `releaseDraft: true` 时 tauri-action 建的是 draft：资产照样上传、滚动端点
    //      照样更新，**外表完全正常**，只是用户看不见——属「静默改变可见性」那一族。
    if (!/releaseDraft:\s*false\b/.test(build)) {
      problems.push(
        '`build` 的 tauri-action 没有 `releaseDraft: false`——草稿发布对用户不可见，' +
          '而资产与滚动端点都已是新版（外表完全正常，只有用户看不到）'
      )
    } else {
      findings.push('build：releaseDraft: false（发布即刻可见）✅')
    }
  }

  // P2：portable job 产出 3 件并暂存为 artifact。
  const portable = jobBlock(code, 'portable')
  if (!portable) {
    problems.push('没有 `portable` job——3 个便携版资产无从产生')
  } else {
    if (!/package-portable\.mjs/.test(portable)) {
      problems.push('`portable` 没有调用 `package-portable.mjs`——便携版打包器不在链路上')
    }
    if (!/upload-artifact@/.test(portable)) {
      problems.push('`portable` 没有 `upload-artifact`——产物无法跨 job 传递到上传环节')
    } else {
      findings.push('portable：打包 + upload-artifact ✅')
    }
  }

  // P3/P4：存在把便携版上传到 Release 的动作，且带 --clobber。
  const uploads = code
    .split('\n')
    .filter((line) => /^\s*gh\s+release\s+upload\b/.test(line))
  const toPortable = uploads.filter((line) => /dist\/portable\/\*/.test(line))
  if (toPortable.length === 0) {
    problems.push(
      '没有任何 `gh release upload … dist/portable/*`——3 个便携版只到 Actions artifacts，' +
        '不会成为 Release 资产（这正是 F13：期望 13 实际 10）'
    )
  } else {
    findings.push(`上传便携版：${toPortable.length} 条动作 ✅`)
    if (!toPortable.some((line) => /--clobber/.test(line))) {
      problems.push(
        '便携版上传动作没有 `--clobber`——同一 tag 重跑时资产已存在，`gh release upload` ' +
          '会因重名失败（发布不可中途取消，重跑是既定恢复手段）'
      )
    } else {
      findings.push('上传便携版带 --clobber（可覆盖重跑）✅')
    }
    // 上传必须在 Release 创建之后：判据是「上传所在的 job needs 了 build」。
    const publisher = ['publish-assets', 'portable'].find((name) => {
      const block = jobBlock(code, name)
      return block !== null && /gh\s+release\s+upload/.test(block)
    })
    if (publisher === undefined) {
      problems.push('找不到承载上传动作的 job——判据无法核对它是否 `needs` 了 `build`')
    } else {
      const block = jobBlock(code, publisher)
      if (!/needs:.*\bbuild\b/.test(block)) {
        problems.push(
          `\`${publisher}\` 承担上传但没有 \`needs: build\`——Release 对象由 build 的 ` +
            'tauri-action 创建，不等它就会在 Release 尚不存在时上传'
        )
      } else {
        findings.push(`${publisher}：needs: build（Release 已创建）✅`)
      }
    }
  }

  return { ok: problems.length === 0, problems, findings }
}

/**
 * L2 属性判据：Release 的 `prerelease` / `draft` 是否与该 tag 的版本号一致（F15）。
 *
 * ## 为什么判据的输入是 **tag 的版本号**而不是工作流的写法
 *
 * 工作流怎么写属于 L1（`checkAssetShape` 的 P1/P5）。L2 要回答的是**结果对不对**：
 * 那个 Release 对象**实际**被标成了什么。因此期望值必须从**客观事实**（tag 的版本号）
 * 推出，而不是从「配置里写了什么」推出——否则配置写错时判据会跟着一起错
 * （本仓的「自测与被测共享同一个错误假设」正是这一族）。
 *
 * 判据只有两条，且都**双向**（两个方向都是真实故障，不是一个方向）：
 *
 * | 断言 | 期望 | 反向故障 |
 * |---|---|---|
 * | `prerelease` | 版本号带预发布段 ⇔ `true` | 预发布标成正式 ⇒ 进 `releases/latest`（stable 用户收到 rc）；正式标成预发布 ⇒ 从 latest 消失 |
 * | `draft` | `false` | 草稿 ⇒ 用户看不见，而资产与滚动端点已是新版 |
 *
 * ⚠️ 「判不了」必须**判红**，不得当作通过：tag 形状非法时（`v0.2-rc.1`）无从知道
 * 期望值，而「无从知道」与「一致」是两件事——本仓在 `latestTagForChannel` 上已
 * 立过同一条纪律（未知通道抛错，不静默返回空）。
 *
 * @param {string} tag Release tag（如 `v0.2.0-rc.2.2`）
 * @param {{prerelease?: unknown, draft?: unknown}} properties `gh api` 返回的同名字段
 * @returns {{ok: boolean, problems: string[], expectedPrerelease: boolean|null}}
 *   判定与问题清单；`expectedPrerelease` 为 `null` 表示判不了（tag 形状非法）
 */
export function judgeReleaseProperties(tag, properties) {
  const problems = []
  const prerelease = properties?.prerelease
  const draft = properties?.draft

  const parsed = parseVersionShape(tag)
  let expectedPrerelease = null
  if (!parsed.ok) {
    problems.push(
      `无法从 tag ${JSON.stringify(tag)} 推出应有的 prerelease 属性——` +
        'tag 应为 `<major>.<minor>.<patch>[-<预发布>][+<build>]`（可带前导 v）。' +
        '「判不了」不等于「一致」，因此这里判红'
    )
  } else {
    expectedPrerelease = parsed.prerelease !== null
    if (prerelease !== expectedPrerelease) {
      problems.push(
        `Release ${tag} 的 prerelease=${JSON.stringify(prerelease)}，应为 ${expectedPrerelease}——` +
          `tag 的版本号${expectedPrerelease ? '**带**' : '**不带**'}预发布段。` +
          (expectedPrerelease
            ? '预发布被标成正式版会进 releases/latest，stable 用户会收到 rc/alpha 更新'
            : '正式版被标成预发布会从 releases/latest 里消失')
      )
    }
  }

  // `draft` 严格判 `false`：缺字段（undefined）也判红——读不到 ≠ 不是草稿。
  if (draft !== false) {
    problems.push(
      `Release ${tag} 的 draft=${JSON.stringify(draft)}，必须是 false——` +
        '草稿对用户不可见，等于这次发布没有发生；而资产与滚动端点都已更新到新版，' +
        '外表完全正常，只有用户看不到'
    )
  }

  return { ok: problems.length === 0, problems, expectedPrerelease }
}

/**
 * L2 清单判据：核对一个**真实 Release** 的资产是否恰好是期望的 13 个。
 *
 * 需要 `gh` 与联网。适配 `gh api repos/<owner>/<repo>/releases/tags/<tag>` 的
 * `assets[].name`，并用**同一次调用**取回 `prerelease` / `draft`（见下）。
 *
 * 🔴 2026-10-10（F15）：`--jq` 从 `.assets[].name` 改成
 * `{prerelease, draft, assets: [.assets[].name]}`，一次调用同时取回属性与清单。
 * 不分成两次调用的理由：两次调用之间 Release 可以被改（TOCTOU），得到的
 * 「属性」与「清单」可能来自不同时刻的**两个不同对象**——判据要回答的是
 * 「**这一个** Release 对不对」。
 *
 * @param {string} tag Release tag
 * @param {{slug?: string, runner?: (cmd: string, args: string[]) => {status: number, stdout: string, stderr: string}}} [options]
 *   `slug` 直接指定 `owner/repo`（跳过 git 推导）；`runner` 为 `gh`/`git` 调用器（自测注入用）
 * @returns {{ok: boolean, problems: string[], assets: string[], missing: string[], unexpected: string[],
 *   prerelease: unknown, draft: unknown}}
 */
export function checkReleaseAssets(tag, options = {}) {
  // ⚠️ 必须与 `repoSlug` 共用同一份默认实现（见 `spawnRunner` 的注释）：
  //    这里曾经内联了**第二份**同样的实现，于是只修 `repoSlug` 那份时
  //    真实路径毫无变化——「修了同类点里的一个」正是本仓反复踩的形态。
  const runner = options.runner ?? spawnRunner

  const empty = { assets: [], missing: [], unexpected: [], prerelease: undefined, draft: undefined }

  // owner/repo 推导失败（本机 `spawnSync git` 可能因 EBUSY 返回空）不应崩栈，
  // 而要降级成一条可读的 problems，让调用者看到真正的原因。
  let slug = ''
  try {
    slug = options.slug ?? repoSlug(runner)
  } catch (err) {
    return {
      ok: false,
      problems: [`${err.message}（若本机 spawnSync git 受限，可显式传 options.slug）`],
      ...empty
    }
  }

  const result = runner('gh', [
    'api',
    `repos/${slug}/releases/tags/${tag}`,
    '--jq',
    '{prerelease, draft, assets: [.assets[].name]}'
  ])
  if (result.status !== 0) {
    return {
      ok: false,
      problems: [`读取 Release ${tag} 的资产失败：${result.stderr.trim() || '(无输出)'}`],
      ...empty
    }
  }

  let payload
  try {
    payload = JSON.parse(result.stdout)
  } catch (err) {
    return {
      ok: false,
      problems: [
        `无法解析 \`gh api\` 的输出为 JSON（${err.message}）；` +
          `首 200 字符：${JSON.stringify(result.stdout.slice(0, 200))}`
      ],
      ...empty
    }
  }

  // assets 字段不存在 ≠ 一个资产都没有：前者说明 API 形状与判据假设不符，
  // 后者是真实的「资产掉光」。混成一个出口会让「形状变了」伪装成「资产缺失 13 个」。
  if (!Array.isArray(payload?.assets)) {
    return {
      ok: false,
      problems: [
        `\`gh api\` 的输出里没有 assets 数组（实际键：${JSON.stringify(Object.keys(payload ?? {}))}）——` +
          'API 形状与判据假设不符，判据需要跟着改，而不是当作「没有资产」'
      ],
      ...empty,
      prerelease: payload?.prerelease,
      draft: payload?.draft
    }
  }

  const assets = payload.assets.map((name) => String(name).trim()).filter(Boolean)
  const judged = judgeAssets(assets, tag)
  const props = judgeReleaseProperties(tag, { prerelease: payload.prerelease, draft: payload.draft })

  return {
    ...judged,
    ok: judged.ok && props.ok,
    problems: [...judged.problems, ...props.problems],
    prerelease: payload.prerelease,
    draft: payload.draft
  }
}

/**
 * 默认的子进程调用器 —— **全文件唯一一份**，别在任何地方再内联写一遍。
 *
 * 🔴 2026-09-25：这里原来有两份**逐字相同**的内联默认实现（一份在 `repoSlug`、
 * 一份在 `checkReleaseAssets`）。给前者加上 `stdio` 后 `--check-release` 仍然失败——
 * 因为真实路径用的是后者那份，`repoSlug` 的默认实现在这条链上根本走不到。
 * **修「同类点的其中一个」比不修更危险：它会让剩下的缺口看起来已经被处理过。**
 *
 * ⚠️ `stdio: ['ignore',…]` 不是风格问题：Windows 上默认的 `stdin: 'pipe'` 会让 spawn
 * 直接失败（`EBUSY`），而这里的失败**外表是「推导不出 owner/repo」**——本仓当初据此
 * 把它当成「不可修的宿主限制」，甚至把 `'EBUSY'` 写进了自测夹具当作既定条件。
 * GitHub 的这三种调用（`git remote get-url` / `gh api`）都不读 stdin，语义等价。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function spawnRunner(cmd, args) {
  const out = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: out.status ?? 1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
}

/**
 * 从 git remote 推导 `owner/repo`。
 *
 * @param {(cmd: string, args: string[]) => {status: number, stdout: string, stderr: string}} [runner]
 *   git 调用器（自测 / 受限宿主注入用）。缺省走 {@link spawnRunner}。
 * @returns {string} `owner/repo`
 * @throws {Error} 远端 URL 缺失或不匹配 GitHub 形态
 */
function repoSlug(runner) {
  const run = runner ?? spawnRunner
  const res = run('git', ['remote', 'get-url', 'origin'])
  const url = (res.stdout ?? '').replace(/\r/g, '').trim()
  // 支持 https://github.com/o/r(.git) 与 git@github.com:o/r(.git) 两种形态。
  const m = /github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)
  if (!m) throw new Error(`无法从 origin 推导 owner/repo：${JSON.stringify(url)}`)
  return m[1]
}

/**
 * 纯逻辑的清单判定（自测的主入口，不联网）。
 *
 * @param {string[]} assets 实际资产名数组
 * @param {string} tag 用于报错的 tag
 * @returns {{ok: boolean, problems: string[], assets: string[], missing: string[], unexpected: string[]}}
 */
export function judgeAssets(assets, tag = '(unknown)') {
  const problems = []
  const allPatterns = [...TAURI_ACTION_ASSETS, ...PUBLISH_ASSETS_ASSETS]
  const used = new Set()

  const missing = []
  for (const { pattern, kind, platform } of allPatterns) {
    const hit = assets.findIndex((name, i) => !used.has(i) && pattern.test(name))
    if (hit === -1) {
      missing.push(`${kind}${platform ? ` (${platform})` : ''}：${pattern}`)
    } else {
      used.add(hit)
    }
  }

  // 未被任何期望模式命中的资产 = 多余项。**不一律判红**：`.sig`、`.sha256`
  // 之外还可能有意外的中间产物，但 CLI 资产（`dsh-host-cli*`）是明确禁止的。
  const unexpected = assets.filter((_, i) => !used.has(i))
  const cliAssets = unexpected.filter((name) => /dsh-host-cli/i.test(name))
  if (cliAssets.length > 0) {
    problems.push(
      `Release ${tag} 上出现了 CLI 资产（已于 2026-09-24 退役）：${cliAssets.join(', ')}`
    )
  }

  if (missing.length > 0) {
    problems.push(
      `Release ${tag} 缺少 ${missing.length} 个期望资产：\n` +
        missing.map((m) => `    - ${m}`).join('\n')
    )
  }

  // 计数校验：即便名字都对，数量也该吻合（防「同名重复」之类）。
  const matched = allPatterns.length - missing.length
  if (matched !== EXPECTED_ASSET_COUNT) {
    problems.push(
      `期望资产数 ${EXPECTED_ASSET_COUNT}，实际匹配 ${matched}（与 AGENTS.md §8.5 对照）`
    )
  }

  return { ok: problems.length === 0, problems, assets, missing, unexpected }
}

/** 自测：纯逻辑，不联网。 */
export function selfTest() {
  const failures = []
  let passed = 0
  const check = (cond, label) => {
    passed += 1
    if (!cond) failures.push(label)
  }

  const realYml = readFileSync(RELEASE_YML, 'utf8').replace(/\r\n/g, '\n')

  // 1) 真实工作流必须通过 L1（F13 修复后）。
  const shape = checkAssetShape(realYml)
  check(shape.ok, `真实 release.yml 资产形状不合法 → ${shape.problems.join('；')}`)

  // 2) 可伪证性：把上传动作删掉必须判红（这就是 F13 的复现）。
  const noUpload = realYml.replace(/^\s*gh release upload[^\n]*\n/gm, '')
  const noUploadResult = checkAssetShape(noUpload)
  check(
    !noUploadResult.ok && noUploadResult.problems.some((p) => /没有任何 `gh release upload/.test(p)),
    '可伪证性：删掉便携版上传动作必须判红（F13 的直防）'
  )
  // 补一条：不带 --clobber 也要判红（重跑会因重名失败）。
  const noClobber = realYml.replace(/--clobber/g, '')
  check(
    checkAssetShape(noClobber).problems.some((p) => /没有 `--clobber`/.test(p)),
    '可伪证性：去掉 --clobber 必须判红（同 tag 重跑会因重名失败）'
  )
  // 上传宾语改成 cli → 判红（退役断言不得被放宽）。
  const cliUpload = realYml.replace(/dist\/portable\/\*/g, 'dist/cli/*')
  check(
    checkAssetShape(cliUpload).problems.some((p) => /没有任何 `gh release upload/.test(p)),
    '可伪证性：把上传宾语改成 dist/cli/* 必须判红（便携版反而没上传）'
  )

  // 3) judgeAssets：正向。
  //
  // 🔴 夹具**逐字取自真实 Release**（`gh api .../releases/tags/v0.7.0-alpha.7`
  //    的 `assets[].name`，过滤掉 CLI 部分）。这不是"好看"，是**必须**——
  //    第一版夹具用的是我自己编的名字（`DSH-Desktop-...-setup.exe`），
  //    与被测的真实命名（`DSH.Desktop_..._x64-setup.exe`）不一致，
  //    于是自测 13 项全绿、而实际一个资产都匹配不上。
  //    **对称失效**：自测与被测共享同一个错误假设时，永远测不出来。
  const good = [
    'DSH.Desktop_0.7.0-alpha.7_aarch64.dmg',
    'DSH.Desktop_0.7.0-alpha.7_amd64.AppImage',
    'DSH.Desktop_0.7.0-alpha.7_amd64.AppImage.sig',
    'DSH.Desktop_0.7.0-alpha.7_amd64.deb',
    'DSH.Desktop_0.7.0-alpha.7_amd64.deb.sig',
    'DSH.Desktop_0.7.0-alpha.7_x64-setup.exe',
    'DSH.Desktop_0.7.0-alpha.7_x64-setup.exe.sig',
    'DSH.Desktop_aarch64.app.tar.gz',
    'DSH.Desktop_aarch64.app.tar.gz.sig',
    'latest.json',
    'DSH-Desktop-0.7.0-alpha.7-portable.manifest.json',
    'DSH-Desktop-0.7.0-alpha.7-portable.zip',
    'DSH-Desktop-0.7.0-alpha.7-portable.zip.sha256'
  ]
  check(good.length === EXPECTED_ASSET_COUNT, `夹具本身必须是 ${EXPECTED_ASSET_COUNT} 项（实得 ${good.length}）`)
  const goodResult = judgeAssets(good, 'v0.7.0-alpha.7')
  check(goodResult.ok, `正向夹具必须通过 → ${goodResult.problems.join('；')}`)

  // 3b) 🔴 反向夹具：把「我第一版编的名字」喂进去，**必须判红**。
  //     这条夹具的意义：如果哪天有人把模式改回 `DSH-Desktop-…`，它会立刻红。
  //     同时它也是这次事故的**回归测试**——本仓已记录「按宿主环境分支的断言 = 只验一半」，
  //     而这条是它的同族：「按自己假设的命名写夹具 = 只验假设」。
  const wrongNaming = [
    'DSH-Desktop-0.7.0-x64-setup.exe',
    'DSH-Desktop-0.7.0-x64-setup.exe.sig',
    'DSH-Desktop-0.7.0-aarch64.dmg',
    'DSH-Desktop-0.7.0.app.tar.gz',
    'DSH-Desktop-0.7.0.app.tar.gz.sig',
    'DSH-Desktop-0.7.0_amd64.deb',
    'DSH-Desktop-0.7.0_amd64.deb.sig',
    'DSH-Desktop-0.7.0.AppImage',
    'DSH-Desktop-0.7.0.AppImage.sig',
    'latest.json',
    'DSH-Desktop-0.7.0-portable.zip',
    'DSH-Desktop-0.7.0-portable.zip.sha256',
    'DSH-Desktop-0.7.0-portable.manifest.json'
  ]
  check(
    !judgeAssets(wrongNaming, 'v0.7.0').ok,
    '可伪证性：用连字符命名（DSH-Desktop-…-setup.exe）必须判红——' +
      '这是真实 tauri-bundler 命名（DSH.Desktop_…）之外的形状，绑死命名假设的判据会漏掉它'
  )

  // 4) judgeAssets 反向：少 3 个便携版 → 判红（F13 的实际形状）。
  const missingPortable = good.filter((n) => !/portable/.test(n))
  const mpResult = judgeAssets(missingPortable, 'v0.7.0')
  check(
    !mpResult.ok && mpResult.missing.length === 3,
    `可伪证性：少 3 个便携版必须判红且 missing 恰为 3（实得 ${mpResult.missing.length}）`
  )
  // 少 latest.json → 判红（更新链路断）。
  const noUpdater = good.filter((n) => n !== 'latest.json')
  check(!judgeAssets(noUpdater, 'v0.7.0').ok, '可伪证性：缺 latest.json 必须判红（更新链路断）')
  // CLI 资产复活 → 判红（退役断言）。
  const withCli = [...good, 'dsh-host-cli-v0.7.0-x86_64-unknown-linux-gnu.tar.gz']
  check(
    judgeAssets(withCli, 'v0.7.0').problems.some((p) => /CLI 资产/.test(p)),
    '可伪证性：Release 上出现 CLI 资产必须判红（退役通道不得复活）'
  )
  // 名字对但数量被凑成别的数 → 报警（防「13 个错误资产」）。
  const wrongNames = good.map((n, i) => (i === 0 ? `${n}X` : n))
  check(!judgeAssets(wrongNames, 'v0.7.0').ok, '可伪证性：名字不匹配必须判红（计数判据不能替代名字判据）')

  // 5) stripYamlComments 两向。
  check(
    stripYamlComments(['  # x', '    run: y', ''].join('\n')) === '    run: y\n',
    'stripYamlComments 必须只剥整行注释、保留缩进与正文'
  )
  check(
    stripYamlComments(['run: "a # b"', ''].join('\n')) === 'run: "a # b"\n',
    'stripYamlComments 不得吞掉引号内的 # （只剥行首注释）'
  )
  // 注释里提到 gh release upload 不得被判为「上传动作存在」。
  check(
    checkAssetShape(`${realYml}\n  # 说明：这里曾用 gh release upload 上传 dist/cli/*\n`).ok ||
      !checkAssetShape(`${realYml}\n  # 说明：这里曾用 gh release upload 上传 dist/cli/*\n`).problems.some((p) =>
        /没有任何 `gh release upload/.test(p)
      ),
    '注释里引用上传动作必须放行（否则退役说明会让守卫恒红）'
  )

  // 6) repoSlug 推导两向 + 受限宿主下的优雅降级。
  //
  //    背景：`checkReleaseAssets` 曾被 `spawnSync git` 返回空串直接崩栈
  //    （本机 spawnSync 外部进程 EBUSY），错误信息是无意义的 `""`。
  //    这里把 git 调用器参数化，让两条 URL 形态都有夹具，并断言
  //    「推导失败 = 一条可读 problems，而不是抛异常」。
  const fakeGit = (url) => (cmd, args) =>
    cmd === 'git' && args[0] === 'remote'
      ? { status: 0, stdout: `${url}\r\n`, stderr: '' } // 故意带 \r，模拟 Windows
      : { status: 1, stdout: '', stderr: 'unexpected' }
  check(
    repoSlug(fakeGit('https://github.com/wang-yi-bit64/dsh-desktop.git')) ===
      'wang-yi-bit64/dsh-desktop',
    'repoSlug 必须解析 https 形态并在 Windows 的 \\r 尾随下仍正确'
  )
  check(
    repoSlug(fakeGit('git@github.com:wang-yi-bit64/dsh-desktop.git')) ===
      'wang-yi-bit64/dsh-desktop',
    'repoSlug 必须解析 scp 形态（git@github.com:owner/repo.git）'
  )
  // 远端不可读（模拟 EBUSY 空输出）→ 不得崩栈，必须返回 ok:false + problems。
  const deadGit = () => ({ status: 1, stdout: '', stderr: 'EBUSY' })
  const degraded = checkReleaseAssets('v0.0.0', { runner: deadGit })
  check(
    degraded.ok === false &&
      degraded.problems.length === 1 &&
      /无法从 origin 推导 owner\/repo/.test(degraded.problems[0]) &&
      /options\.slug/.test(degraded.problems[0]),
    `git 推导失败必须优雅降级为 problems 而非崩栈（实得 ${JSON.stringify(degraded.problems)}）`
  )
  // 显式传 slug 时，git 完全不被触碰。
  //
  // 🔴 夹具**按 jq 表达式回数据**，不是无条件回 JSON：若把 `--jq` 改回
  //    `.assets[].name`，本夹具会回纯名单 ⇒ `JSON.parse` 失败 ⇒ 判红。
  //    无条件回 JSON 的夹具会让「jq 改回旧形状」畅通无阻——那是本仓反复踩的
  //    「夹具与被测不共形 → 对称失效」。
  const ghCalls = []
  const runnerFor = (props) => (cmd, args) => {
    ghCalls.push([cmd, args])
    if (cmd !== 'gh') return { status: 1, stdout: '', stderr: 'git must not be called' }
    const jq = args[args.indexOf('--jq') + 1] ?? ''
    if (/prerelease/.test(jq) && /draft/.test(jq) && /assets/.test(jq)) {
      return { status: 0, stdout: JSON.stringify({ ...props, assets: good }), stderr: '' }
    }
    return { status: 0, stdout: `${good.join('\n')}\n`, stderr: '' }
  }
  const slugged = checkReleaseAssets('v0.0.0', { slug: 'owner/repo', runner: runnerFor({ prerelease: false, draft: false }) })
  check(slugged.ok, `显式 slug 路径必须跳过 git 推导并正常判定 → ${slugged.problems.join('；')}`)
  // 真实调用必须用**一次调用取回属性 + 清单**的 jq（两次调用之间存在 TOCTOU）。
  check(
    ghCalls.some(([cmd, args]) => cmd === 'gh' && /prerelease/.test(String(args.at(-1))) && /assets/.test(String(args.at(-1)))),
    'L2 必须用一次 gh api 调用同时取回 prerelease / draft / assets（分两次调用会得到两个时刻的对象）'
  )

  // 7) 🔴 F15（2026-10-10）：Release 的 `prerelease` / `draft` 必须与 tag 的版本号一致。
  //    缺陷本体：rc 线的 3 个 Release（v0.7.2-rc.1 / v0.2.0-rc.2.1 / v0.2.0-rc.2.2）
  //    实际是 `prerelease=false` —— 它们因此进了 `releases/latest`。
  const rcTag = 'v0.2.0-rc.2.2'
  check(
    judgeReleaseProperties(rcTag, { prerelease: true, draft: false }).ok,
    '正向：预发布 tag + prerelease=true + draft=false 必须通过'
  )
  check(
    judgeReleaseProperties('v0.7.2', { prerelease: false, draft: false }).ok,
    '正向：正式版 tag + prerelease=false 必须通过（判据不得硬编码「必须为 true」）'
  )
  check(
    judgeReleaseProperties('v0.7.2+hotfix', { prerelease: false, draft: false }).ok &&
      judgeReleaseProperties('v0.2.1-alpha.1.2', { prerelease: true, draft: false }).ok,
    '正向：build 段（`+hotfix`）不参与预发布判定，合成号（`alpha.1.2`）判为预发布'
  )
  check(
    !judgeReleaseProperties(rcTag, { prerelease: false, draft: false }).ok,
    '可伪证性：预发布被标成 prerelease=false 必须判红（F15 本体：它因此进了 releases/latest）'
  )
  check(
    !judgeReleaseProperties('v0.7.2', { prerelease: true, draft: false }).ok,
    '可伪证性：正式版被标成 prerelease=true 必须判红（会从 releases/latest 里消失）'
  )
  check(
    !judgeReleaseProperties(rcTag, { prerelease: true, draft: true }).ok,
    '可伪证性：draft=true 必须判红（草稿对用户不可见，而资产与滚动端点已是新版）'
  )
  check(
    !judgeReleaseProperties(rcTag, {}).ok,
    '可伪证性：属性字段全缺（API 形状变了）必须判红——读不到不等于没问题（fail-closed）'
  )
  check(
    !judgeReleaseProperties('v0.2-rc.1', { prerelease: true, draft: false }).ok &&
      !judgeReleaseProperties('release-2024', { prerelease: true, draft: false }).ok,
    '可伪证性：tag 形状非法（推不出期望值）必须判红——「判不了」不等于「一致」'
  )
  // 端到端（注入 runner，不联网）：同一个 13 项清单，属性错也必须判红——
  // 这条钉住「L2 的两半真的被合成一个出口」，而不是各判各的、只看后者。
  const cleanRelease = checkReleaseAssets('v0.7.0-alpha.7', {
    slug: 'owner/repo',
    runner: runnerFor({ prerelease: true, draft: false })
  })
  check(cleanRelease.ok, `L2 端到端：资产齐全 + 属性正确必须通过 → ${cleanRelease.problems.join('；')}`)
  const flippedRelease = checkReleaseAssets('v0.7.0-alpha.7', {
    slug: 'owner/repo',
    runner: runnerFor({ prerelease: false, draft: false })
  })
  check(
    !flippedRelease.ok && flippedRelease.problems.some((p) => /prerelease=false/.test(p)),
    'L2 端到端：资产齐全但 prerelease 错必须判红（资产齐 ≠ 发布正确）'
  )

  if (failures.length > 0) {
    throw new Error(`资产清单自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`)
  }
  return { passed }
}

function printExpected() {
  console.log(`期望资产清单（${EXPECTED_ASSET_COUNT} 项，与 AGENTS.md §8.5 同源）：`)
  console.log('\n  【tauri-action 产出】')
  for (const { pattern, kind, platform } of TAURI_ACTION_ASSETS) {
    console.log(`    ${String(kind).padEnd(18)} ${String(platform ?? '').padEnd(8)} ${pattern}`)
  }
  console.log('\n  【publish-assets 产出】')
  for (const { pattern, kind } of PUBLISH_ASSETS_ASSETS) {
    console.log(`    ${String(kind).padEnd(18)} ${''.padEnd(8)} ${pattern}`)
  }
}

function run() {
  const args = argv.slice(2)
  if (args.includes('--print-expected')) {
    printExpected()
    return
  }
  if (args.includes('--self-test')) {
    const { passed } = selfTest()
    console.log(`✅ 资产清单自测通过（${passed} 项）`)
    return
  }
  if (args.includes('--check-release')) {
    const tag = args[args.indexOf('--check-release') + 1]
    if (tag === undefined) {
      console.error(
        '用法：node scripts/verify-release-assets.mjs --check-release <tag> [--repo <owner/repo>]'
      )
      exit(2)
    }
    // `--repo` 让受限宿主（spawnSync git 返回空）也能核对真实 Release。
    const repoIdx = args.indexOf('--repo')
    const slug = repoIdx === -1 ? undefined : args[repoIdx + 1]
    const result = checkReleaseAssets(tag, { slug })
    if (result.ok) {
      const parsed = parseVersionShape(tag)
      const hasPrerelease = parsed.ok && parsed.prerelease !== null
      console.log(`✅ Release ${tag} 的资产清单完整（${EXPECTED_ASSET_COUNT} 项）`)
      console.log(
        `✅ Release ${tag} 的属性正确：prerelease=${result.prerelease}、draft=${result.draft}` +
          `（tag 的版本号${hasPrerelease ? '带' : '不带'}预发布段）`
      )
      if (result.unexpected.length > 0) {
        console.log(`   （另有 ${result.unexpected.length} 个未在期望清单内的资产：${result.unexpected.join(', ')}）`)
      }
      return
    }
    console.error(`❌ Release ${tag} 的核对未通过：`)
    console.error(`   prerelease=${result.prerelease}、draft=${result.draft}、资产 ${result.assets.length} 个`)
    for (const p of result.problems) console.error(`  - ${p}`)
    exit(1)
  }

  // 离线核对：从文件读资产名（每行一个），走纯逻辑判定。
  //
  // ⚠️ 这条路径**只**覆盖清单（名字 / 数量）那一半，**不**覆盖 Release 的
  //    `prerelease` / `draft` 属性——属性只存在于真实 API 响应里，文件里没有它。
  //    要核对属性必须走 `--check-release`（联网）。
  //
  // 存在的理由：本机 `spawnSync` 外部进程会 EBUSY，`gh api` 走不通
  // （与 verify:target / verify:cli-package 同源）。这条路径让受限宿主
  // 也能拿**真实**的 `gh api ... --jq '.assets[].name'` 输出做双向验证。
  // 生成清单：gh api repos/<owner>/<repo>/releases/tags/<tag> --jq '.assets[].name' > assets.txt
  if (args.includes('--assets-from')) {
    const file = args[args.indexOf('--assets-from') + 1]
    if (file === undefined) {
      console.error('用法：node scripts/verify-release-assets.mjs --assets-from <文件> [--tag <tag>]')
      exit(2)
    }
    const tagIdx = args.indexOf('--tag')
    const tag = tagIdx === -1 ? '(离线清单)' : args[tagIdx + 1]
    const assets = readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.replace(/\r/g, '').trim())
      .filter(Boolean)
    const result = judgeAssets(assets, tag)
    if (result.ok) {
      console.log(`✅ 资产清单完整（${EXPECTED_ASSET_COUNT} 项）`)
      if (result.unexpected.length > 0) {
        console.log(`   （另有 ${result.unexpected.length} 个未在期望清单内的资产：${result.unexpected.join(', ')}）`)
      }
      return
    }
    console.error('❌ 资产清单不完整：')
    for (const p of result.problems) console.error(`  - ${p}`)
    if (result.unexpected.length > 0) {
      console.error(`  未在期望清单内的资产（${result.unexpected.length} 个）：${result.unexpected.join(', ')}`)
    }
    exit(1)
  }

  // 默认：L1 静态校验。
  const text = readFileSync(RELEASE_YML, 'utf8').replace(/\r\n/g, '\n')
  const shape = checkAssetShape(text)
  if (shape.ok) {
    for (const f of shape.findings) console.log(`✅ ${f}`)
    console.log(`✅ release.yml 的资产形状能产出期望的 ${EXPECTED_ASSET_COUNT} 项资产`)
    console.log('   （实际是否凑齐需在发布后跑 --check-release <tag> 核对）')
    return
  }
  console.error('❌ release.yml 的资产形状不合法：')
  for (const p of shape.problems) console.error(`  - ${p}`)
  exit(1)
}

const isDirectRun = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(argv[1] ?? '')
  } catch {
    return false
  }
})()

if (isDirectRun) {
  try {
    run()
  } catch (error) {
    console.error(error.message)
    exit(1)
  }
}
