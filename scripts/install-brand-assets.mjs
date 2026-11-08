#!/usr/bin/env node
/**
 * install-brand-assets.mjs — 把桌面自己的图标装进 Harness 前端的 dist。
 *
 * ## 它改哪三处
 *
 *   1. `dist/index.html` 的 `<link rel="icon">` → 桌面图标；
 *   2. `dist/manifest.webmanifest` 的 `icons[]` 里**一个**条目 → 桌面图标；
 *   3. 把 `build/icon.png` / `logo-light.png` / `logo-dark.png` 复制进 `dist/`。
 *
 * ## 为什么每条匹配都要「零命中即失败」
 *
 * 上游每动一次图标声明，这里就可能从「改了」静默退化成「没改」——而没改的产物
 * 打包、签名、安装全部成功，只是应用里显示的还是上游的图标。这种缺陷没有任何
 * 编译期或运行期信号（§7.1 规则 2 的形态），因此**匹配不到就抛错**，让组装当场红。
 *
 * 已经踩过两次，两次都只在真实组装时暴露：
 *   · 0.1.2-alpha.1：`/favicon.svg` → `./favicon.svg`（href 改为按后缀匹配，不钉路径）；
 *   · 0.2.0：单个 icon link 拆成两个 scheme-gated link（改为「替换全部 icon link」）；
 *   · 0.2.2：manifest 的单个 `favicon.svg` 换成标准 PWA 位图三件套
 *     （`icon-192.png` / `icon-512.png` / `icon-maskable-512.png`），`display` 也从
 *     `fullscreen` 变 `standalone` —— 旧匹配链只认 `favicon.svg`，组装直接报
 *     `no icon entry to replace`。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/install-brand-assets.mjs [<install root>]   # 默认仓库根
 * node scripts/install-brand-assets.mjs --self-test        # 纯逻辑自检，不碰磁盘
 * ```
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const DESKTOP_ICON_SRC = '/dsh-desktop-logo.png'

/**
 * 上游 0.2.2 起的标准 PWA 位图图标（`icon-192.png` / `icon-512.png` /
 * `icon-maskable-512.png`）。**按形状匹配而不是逐个钉文件名**：尺寸与档位是上游
 * 自己的事，钉死三个名字下一次它加一档就又断。
 */
const PWA_RASTER_ICON = /(?:^|\/)icon-(?:maskable-)?\d+\.png$/u

/** index.html 里的 icon link 标签（全局；每次用前新建，避免 lastIndex 串状态）。 */
const ICON_LINK_SOURCE = '<link rel="icon"[^>]*\\/?>(?:<\\/link>)?'

/**
 * Swap the Harness favicon links for the desktop's own.
 *
 * The href is matched rather than pinned: 0.1.2-alpha.1 moved it from
 * `/favicon.svg` to `./favicon.svg`, and either is the same link. Upstream
 * 0.2.0 split it into two scheme-gated links (`favicon-dark.svg` /
 * `favicon.svg` with `media=`), so the rule is "exactly one icon target",
 * not "exactly one tag": the **first** icon link becomes the desktop link and
 * the remaining ones are dropped, because the desktop icon is
 * scheme-independent and one link wins for both schemes. *Zero* icon links is
 * still a failure — a frontend that stopped declaring one is a change worth
 * failing on, not one to paper over.
 *
 * Collapsing instead of replacing each in place is not cosmetic: replacing
 * every link emits N copies of the same tag, and duplicate icon links are
 * exactly the sort of thing a later `sizes`/`media` edit silently gets wrong.
 * @param contents - index.html source.
 * @param file - path shown in the failure message.
 * @returns index.html with exactly one desktop icon link.
 */
function replaceIconLink(contents, file) {
  const desktop = '<link rel="icon" type="image/png" href="/dsh-desktop-logo.png" />'
  const source = new RegExp(ICON_LINK_SOURCE, 'gu')
  if ([...contents.matchAll(source)].length === 0) {
    throw new Error(
      `Could not update DSH Desktop branding in ${file}: expected at least one icon link, found none`
    )
  }
  // A desktop link already in place is just "the first link", so this is
  // idempotent *and* collapses duplicates left by an earlier version of this
  // script. Done in one pass on the original string: replacing tag-by-tag
  // would make the second identical tag match the *replacement* and delete the
  // link that was just written.
  let emitted = false
  return contents.replace(new RegExp(ICON_LINK_SOURCE, 'gu'), () => {
    if (emitted) return ''
    emitted = true
    return desktop
  })
}

/**
 * 从 manifest 的 `icons[]` 里挑出要改写的那一个条目；挑不到返回 undefined。
 *
 * 三种形态按**新→旧**排（先认已改写的，再认老形态，最后认新形态），因此对已经
 * 打好品牌的文件是幂等 no-op。maskable 条目刻意排在普通条目之后：部分启动器会把
 * maskable 图标裁成圆形，而桌面 logo 不是按那个安全区画的——只有在**只剩**
 * maskable 条目时才退而改它，因为那仍然好过让组装失败。
 * @param icons - manifest.icons 数组（已保证是数组）。
 */
function selectIcon(icons) {
  const isPng = (icon) => typeof icon?.src === 'string' && PWA_RASTER_ICON.test(icon.src)
  return (
    icons.find((icon) => icon?.src === DESKTOP_ICON_SRC) ??
    icons.find((icon) => typeof icon?.src === 'string' && icon.src.endsWith('favicon.svg')) ??
    icons.find((icon) => isPng(icon) && icon.purpose !== 'maskable') ??
    icons.find(isPng)
  )
}

/**
 * Point the web manifest's icon at the desktop logo.
 *
 * Edited as JSON rather than as text: upstream added `"purpose": "any"` to the
 * entry in 0.1.2-alpha.1, which a pinned multi-line string could not survive,
 * and key order is not a contract. The entry still has to exist.
 *
 * Only one entry is rewritten; the rest are left alone. Their files still ship,
 * they just are not what the desktop uses — rewriting all three would need
 * three copies of the logo at three declared sizes, and a wrong `sizes` value
 * is worse than a stale-but-truthful one.
 * @param contents - manifest source.
 * @param file - path shown in the failure message.
 * @returns manifest JSON with the desktop icon.
 */
function replaceManifestIcon(contents, file) {
  const manifest = JSON.parse(contents)
  const icons = Array.isArray(manifest.icons) ? manifest.icons : []
  const target = selectIcon(icons)
  if (target === undefined) {
    throw new Error(`Could not update DSH Desktop branding in ${file}: no icon entry to replace`)
  }
  target.src = DESKTOP_ICON_SRC
  target.sizes = '1254x1254'
  target.type = 'image/png'
  return `${JSON.stringify(manifest, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// 自检（纯逻辑，不读盘、不写盘）
// ---------------------------------------------------------------------------

/** 0.2.1-rc.4 及更早的 manifest 图标形态。 */
const FIXTURE_OLD_MANIFEST = JSON.stringify({
  name: 'DeepSeek Harness',
  display: 'fullscreen',
  icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
})

/** 0.2.2-rc.1 实测的 manifest 图标形态（从 registry 产物抄下来的原文）。 */
const FIXTURE_PWA_MANIFEST = JSON.stringify({
  name: 'DeepSeek Harness',
  short_name: 'DSH',
  display: 'standalone',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
})

function selfTest() {
  const failures = []
  let passed = 0
  const check = (name, fn) => {
    try {
      fn()
      passed += 1
    } catch (error) {
      failures.push(`${name}：${error.message}`)
    }
  }
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const throws = (fn, message) => {
    let threw = false
    try {
      fn()
    } catch {
      threw = true
    }
    assert(threw, message)
  }
  const iconAt = (json, index) => JSON.parse(json).icons[index]

  // --- 老形态：单个 favicon.svg -------------------------------------------
  check('老形态（favicon.svg）被改写', () => {
    const out = replaceManifestIcon(FIXTURE_OLD_MANIFEST, 'fixture')
    const icon = iconAt(out, 0)
    assert(icon.src === DESKTOP_ICON_SRC, `src 未改写：${icon.src}`)
    assert(icon.sizes === '1254x1254', `sizes 未改写：${icon.sizes}`)
    assert(icon.type === 'image/png', `type 未改写：${icon.type}`)
    assert(JSON.parse(out).display === 'fullscreen', '其它字段被破坏')
  })

  // --- 新形态：PWA 位图三件套（0.2.2 起的真实形状）------------------------
  check('新形态（PWA 三件套）被改写且只改一个', () => {
    const out = replaceManifestIcon(FIXTURE_PWA_MANIFEST, 'fixture')
    const icons = JSON.parse(out).icons
    const rewritten = icons.filter((icon) => icon.src === DESKTOP_ICON_SRC)
    assert(rewritten.length === 1, `改写条目数应为 1，实为 ${rewritten.length}`)
    assert(icons[0].src === DESKTOP_ICON_SRC, '应改写第一个普通条目（icon-192.png）')
    assert(icons[0].purpose === 'any', '普通条目的 purpose 不应被改动')
    assert(
      icons[2].src === 'icon-maskable-512.png' && icons[2].purpose === 'maskable',
      'maskable 条目在有普通条目时不应被改写'
    )
    assert(JSON.parse(out).display === 'standalone', '其它字段被破坏')
  })

  // --- 只有 maskable：退而改它（仍好过让组装失败）-------------------------
  check('只剩 maskable 条目时退而改它', () => {
    const out = replaceManifestIcon(
      JSON.stringify({
        icons: [{ src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }]
      }),
      'fixture'
    )
    assert(iconAt(out, 0).src === DESKTOP_ICON_SRC, 'maskable 兜底分支失效')
  })

  // --- 零命中必须抛错（不得静默放过）--------------------------------------
  check('无 icons 字段必须抛错', () => {
    throws(
      () => replaceManifestIcon(JSON.stringify({ name: 'x' }), 'fixture'),
      '缺 icons 字段却未抛错'
    )
  })
  check('icons 为空数组必须抛错', () => {
    throws(() => replaceManifestIcon(JSON.stringify({ icons: [] }), 'fixture'), '空数组却未抛错')
  })
  check('只有无法识别的图标条目必须抛错', () => {
    throws(
      () =>
        replaceManifestIcon(
          JSON.stringify({ icons: [{ src: 'screenshot.png', sizes: '1080x1920' }] }),
          'fixture'
        ),
      '无法识别的条目被当成了命中（会静默留下上游图标）'
    )
  })

  // --- 幂等：已经打好品牌的文件再跑一次不应变化 ---------------------------
  check('已改写过的 manifest 再跑一次不变', () => {
    const once = replaceManifestIcon(FIXTURE_PWA_MANIFEST, 'fixture')
    const twice = replaceManifestIcon(once, 'fixture')
    assert(once === twice, '二次运行结果不一致（非幂等）')
  })

  // --- 可证伪性：把新分支打回旧匹配链，新形态必须失败 ---------------------
  // 没有这一条，上面的「新形态被改写」只证明当前实现能跑，不证明**那条新分支
  // 是必需的**：有人把 PWA 分支删掉、又恰好换了夹具，测试仍可能绿。
  check('可证伪：旧匹配链在新形态上必须失败', () => {
    const oldSelect = (icons) =>
      icons.find((icon) => icon?.src === DESKTOP_ICON_SRC) ??
      icons.find((icon) => typeof icon?.src === 'string' && icon.src.endsWith('favicon.svg'))
    const icons = JSON.parse(FIXTURE_PWA_MANIFEST).icons
    assert(
      oldSelect(icons) === undefined,
      '旧匹配链竟能命中新形态——夹具已不代表 0.2.2 的真实形状，断言失效'
    )
    assert(selectIcon(icons) !== undefined, '当前匹配链在新形态上未命中')
  })

  // --- index.html 的 icon link -------------------------------------------
  check('两个 scheme-gated link 被合并为一个桌面 link', () => {
    const html =
      '<head><link rel="icon" type="image/svg+xml" href="/favicon.svg" media="(prefers-color-scheme: light)">' +
      '<link rel="icon" type="image/svg+xml" href="/favicon-dark.svg" media="(prefers-color-scheme: dark)"></head>'
    const out = replaceIconLink(html, 'fixture')
    const desktopLinks = out.match(/dsh-desktop-logo\.png/gu) ?? []
    assert(desktopLinks.length === 1, `桌面 link 数应为 1，实为 ${desktopLinks.length}`)
    assert(!out.includes('favicon.svg'), '上游 favicon link 未被替换')
    assert(out.includes('</head>'), '页面结构被破坏')
  })
  check('无 icon link 必须抛错', () => {
    throws(() => replaceIconLink('<head></head>', 'fixture'), '零 icon link 却未抛错')
  })
  check('已改写过的 index.html 再跑一次不变', () => {
    const html = '<head><link rel="icon" href="/favicon.svg"></head>'
    const a = replaceIconLink(html, 'fixture')
    const b = replaceIconLink(a, 'fixture')
    assert(a === b, '二次运行结果不一致（非幂等）')
  })

  if (failures.length > 0) {
    console.error('❌ install-brand-assets 自测失败：')
    for (const failure of failures) console.error(`  · ${failure}`)
    process.exit(1)
  }
  console.log(`✅ install-brand-assets 自测通过（${passed} 项）`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) selfTest()

  // Optional positional argument: the install root whose node_modules receives
  // the brand assets (defaults to the project root). prepare-harness.mjs passes
  // its staging directory.
  const positional = args.filter((arg) => !arg.startsWith('--'))
  const installRoot = positional[0] ? path.resolve(positional[0]) : projectRoot
  const source = path.join(projectRoot, 'build', 'icon.png')
  const lightSource = path.join(projectRoot, 'build', 'logo-light.png')
  const darkSource = path.join(projectRoot, 'build', 'logo-dark.png')
  const destinationDirectory = path.join(
    installRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh-web-frontend',
    'dist'
  )
  const destination = path.join(destinationDirectory, 'dsh-desktop-logo.png')
  const lightDestination = path.join(destinationDirectory, 'dsh-desktop-logo-light.png')
  const darkDestination = path.join(destinationDirectory, 'dsh-desktop-logo-dark.png')
  const indexPath = path.join(destinationDirectory, 'index.html')
  const manifestPath = path.join(destinationDirectory, 'manifest.webmanifest')

  await mkdir(destinationDirectory, { recursive: true })
  await copyFile(source, destination)
  await copyFile(lightSource, lightDestination)
  await copyFile(darkSource, darkDestination)

  const index = await readFile(indexPath, 'utf8')
  await writeFile(indexPath, replaceIconLink(index, path.relative(projectRoot, indexPath)))

  const manifest = await readFile(manifestPath, 'utf8')
  await writeFile(
    manifestPath,
    replaceManifestIcon(manifest, path.relative(projectRoot, manifestPath))
  )

  console.log(
    `Installed DSH Desktop brand assets: ${[destination, lightDestination, darkDestination]
      .map((file) => path.relative(projectRoot, file))
      .join(', ')}`
  )
}

await main()
