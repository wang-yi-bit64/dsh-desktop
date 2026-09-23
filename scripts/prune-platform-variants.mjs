#!/usr/bin/env node
/**
 * prune-platform-variants.mjs — 剪掉与发布目标无关的原生平台变体。
 *
 * ## 为什么存在（真实事故，2026-09-11）
 *
 * Linux 的 AppImage 打包步骤连续多轮以 `failed to run linuxdeploy` 收场，
 * 而 tauri-bundler 在默认日志级别下**吞掉 linuxdeploy 的 stderr**，只报这一句
 * 无信息量的错误（deb 正常，因为 deb 不解析 ELF 依赖）。用 `-v` 拿到真实报错：
 *
 *     Deploying dependencies for ELF file .../@koromix/koffi-linux-x64/musl_x64/koffi.node
 *     ERROR: Could not find dependency: libc.musl-x86_64.so.1
 *     ERROR: Failed to deploy dependencies for existing files
 *
 * linuxdeploy 会遍历 AppDir 内**每一个** ELF 并解析其动态依赖。而
 * `@koromix/koffi-linux-x64` 在同一个包里同时带了 glibc 与 musl 两份构建，
 * `node-pty` 的 prebuilds 也带齐了所有平台架构。这些外来变体在 glibc runner 上
 * 必然解析失败（`libc.musl-x86_64.so.1` 不存在），于是整个 AppImage 打包被拖垮。
 * 附带噪声：静态链接的 `landlock-run` 让 patchelf 打 ERROR（非致命），
 * 跨架构的 arm64 `pty.node` 走 ldd 只给警告（同样非致命）——它们是**同一个**
 * 「树里混进了与目标无关的二进制」问题的不同表现。
 *
 * 关键事实：安装包里**没有任何东西能加载这些外来变体**——我们发布的 node 是
 * glibc 链接的，koffi 按运行时的 libc 选构建，prebuildify 按 `platform-arch` 选目录。
 * 所以剪掉它们是纯粹的「省体积 + 让打包器不再撞墙」，不影响运行时。
 *
 * ## 判据的边界（为什么不会误删）
 *
 * 只对**选择器写在哪里**明确的四种布局动手，这是有界的：
 *
 *   1. `prebuilds/` 或 `prebuilt/` 目录内（prebuildify 约定）——其 loader 按
 *      `${platform}-${arch}` 查找，其余条目**按构造即不可达**；
 *   2. 文件名形如 `musl_*` / `musl-*` 的目录（koffi 布局），其前导 token 是 libc；
 *   3. **裸 libc 名**做选择器（`bin/glibc/` 与 `bin/musl/` 并列）——0.1.5-rc.1 的
 *      `@deepseek-ai/node-addon-system-linux-x64` 就是这种；Linux 目标的保留名因此
 *      必须含 `glibc`，否则 `oursIsHere` 那道安全丝认不出「同层有我们的变体」，
 *      会放过同层的 `musl`（2026-09-12 Linux 打包失败的复发原因）；
 *   4. **包名本身**是 libc 选择器（`@img/sharp-linuxmusl-x64` 与 `@img/sharp-linux-x64`
 *      并列）——见上文「libc 维度」，npm 过滤不了这一类。安全丝：**同层必须存在
 *      glibc 对应物**（把包名里的 `linuxmusl` 换成 `linux`）才删，且只在
 *      `platform === 'linux'` 时生效。
 *
 * 包**名**里带平台后缀的（`@img/sharp-linux-x64`、`@vscode/ripgrep-linux-x64`）分两种：
 *
 *   - **os/cpu 维度**：npm 已按 `os`/`cpu` 字段过滤过（`@img/sharp-win32-x64` 在 Linux
 *     runner 上不会被装），本模块不碰；
 *   - **libc 维度**：npm **过滤不了**——它只在包**自己声明了** `libc` 字段时才按 libc 过滤。
 *     `@img/sharp-linuxmusl-x64@0.35.4` 在 lockfile 里只有 `os:["linux"]` / `cpu:["x64"]`，
 *     于是 npm 认为它与 `@img/sharp-linux-x64` 同样适用，把**两个都装进树**
 *     （2026-09-23 实测：`smoke 35856722738` 只有 ubuntu 红，linuxdeploy 在
 *     `sharp-linuxmusl-x64-0.35.4.node` 上报 `Could not find dependency: libc.musl-x86_64.so.1`）。
 *     故本模块必须兜底第 4 类判据（见下）。
 *
 * 还有一道保险：**在 prebuilds 目录之外**，只有当**同一层**目录里存在我们自己平台的
 * 变体（`oursIsHere`）时才按名删邻居——这样永远不会把「最后一个能用的」删没。
 * 第 4 类判据另有一道同构的安全丝：**同层必须存在它的 glibc 对应物**才删。
 *
 * 用法：
 * ```bash
 * node scripts/prune-platform-variants.mjs --self-test   # 自测（含可伪证性检查）
 * ```
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 自测要拿现有门禁做可伪证性对照（见 selfTest 第 5 组），因此静态引用邻模块。
// 两者无循环依赖：prune-harness-deps 不反向引用本模块。
import { pruneNodeModules } from './prune-harness-deps.mjs'

/**
 * 能出现在「平台选择器」目录名前导位置的平台 / libc token。
 * 命中这只是必要条件——还要 `(insidePrebuilds || oursIsHere)` 才删。
 */
const PLATFORM_TOKENS = /^(darwin|linux|linuxmusl|win32|android|freebsd|musl|glibc)$/

/**
 * 「包名即 libc 选择器」的第 4 类判据：包名里的 musl 标记。
 *
 * sharp 系列用**包名**区分 libc（`@img/sharp-linux-x64` / `@img/sharp-linuxmusl-x64`），
 * 而 npm 只在包**自己声明了** `libc` 字段时才按 libc 过滤。`@img/sharp-linuxmusl-x64@0.35.4`
 * 只声明了 `os:["linux"]` / `cpu:["x64"]`，于是它与 glibc 版本**双双被装进树**，
 * linuxdeploy 遍历到它的 `.node` 时解析 `libc.musl-x86_64.so.1` 失败，AppImage 打包整体失败
 * （2026-09-23 实测，smoke `35856722738` 只有 ubuntu 红）。
 */
const MUSL_PACKAGE_MARKER = 'linuxmusl'

/**
 * 把一个「musl 选择器包名」换成它的 glibc 对应物名；不含标记时返回 `null`。
 *
 * 只做**整体 token 替换**（`linuxmusl` → `linux`），因此
 * `@img/sharp-linuxmusl-x64` → `@img/sharp-linux-x64`、
 * `@img/sharp-libvips-linuxmusl-x64` → `@img/sharp-libvips-linux-x64`。
 * 返回 `null` 而非 `name` 本身，是为了让调用点无法把「不是这类名字」误当成命中。
 *
 * @param {string} name 包目录名（不含 scope 时也要能判，例如 `foo-linuxmusl-x64`）
 * @returns {string|null} glibc 对应物名；不含 `linuxmusl` 标记时为 `null`
 */
export function glibcSiblingName(name) {
  if (!name.includes(MUSL_PACKAGE_MARKER)) return null
  return name.split(MUSL_PACKAGE_MARKER).join('linux')
}

/**
 * 计算目标平台「我们自己」的变体目录名集合。
 *
 * glibc 与 musl 两种 Linux 构建用不同目录名：koffi 的 glibc 构建叫 `linux_x64`、
 * musl 构建叫 `musl_x64`；prebuildify 的 glibc 构建叫 `linux-x64`。**本仓只发布
 * glibc Linux 产物**，因此 Linux 目标的 `libc` token 取 `linux`。若将来新增 musl
 * 目标，必须在此把 libc 判成 `musl`，否则会把目标平台唯一的构建删掉。
 *
 * 另有第三种布局：**裸 libc 名**直接做目录选择器（如 0.1.5-rc.1 引入的
 * `@deepseek-ai/node-addon-system-linux-x64/bin/glibc/` 与 `bin/musl/`）。因此
 * Linux 目标的保留名必须包含 `glibc`——否则「同层有我们的变体」这道安全丝
 * （`oursIsHere`）认不出 `bin/glibc`，就会放过同层的 `bin/musl`，linuxdeploy
 * 遂在 musl 的 `system.node` 上 `Failed to run ldd`（2026-09-12 打包失败的原因）。
 *
 * @param {{platform: string, arch: string}} target 打包目标（Node 命名法）
 * @returns {Set<string>} 需要保留的目录名（`-` 与 `_` 两种分隔都收录）
 */
export function keepNamesFor(target) {
  const { platform, arch } = target
  const libc = platform === 'linux' ? 'linux' : platform
  const names = [
    `${platform}-${arch}`,
    `${platform}_${arch}`,
    `${libc}-${arch}`,
    `${libc}_${arch}`
  ]
  // 裸 libc 目录名：我们的 Linux 产物是 glibc 链接的。
  if (platform === 'linux') names.push('glibc')
  return new Set(names)
}

/**
 * 判断一个目录名是否是「非目标平台」的选择器名。
 *
 * 比的是**前导 token**而不是前缀，因此 `linuxmusl-x64` 在 glibc 目标下算外来，
 * 而 `linux_x64` 保留。
 *
 * @param {string} name 目录名
 * @param {Set<string>} keep `keepNamesFor()` 的产物
 * @returns {boolean} 属于外来变体时为 `true`
 */
export function isForeignVariantName(name, keep) {
  const token = name.split(/[-_]/)[0]
  return PLATFORM_TOKENS.test(token) && !keep.has(name)
}

/**
 * 剪掉一棵依赖树里与目标平台无关的原生变体（原地修改）。
 *
 * 覆盖四类判据（详见模块文档「判据的边界」）：prebuilds 目录内的 `platform-arch`、
 * `musl_*` 目录、裸 libc 目录名（`bin/glibc` 与 `bin/musl`），以及**包名里的 libc 选择器**
 * （`@img/sharp-linuxmusl-x64`——`platform === 'linux'` 时且同层存在 glibc 对应物才删）。
 *
 * @param {string} root 依赖树根目录（通常是 `<resources>/harness/node_modules`）
 * @param {{platform: string, arch: string}} [target] 打包目标；默认取当前进程宿主
 * @returns {{ removed: string[] }} 被删目录的相对路径列表，便于报告与断言
 */
export function pruneForeignPlatformVariants(root, target = { platform: process.platform, arch: process.arch }) {
  const keep = keepNamesFor(target)
  const removed = []
  // 第 4 类判据（包名即 libc 选择器）只对 Linux 目标生效：本仓发布的 Linux 产物是
  // glibc 链接的。若将来新增 musl 目标，必须把这里翻转成「保留 musl、删 glibc」，
  // 否则会删掉目标平台唯一的构建。
  const pruningMuslPackages = target.platform === 'linux'

  const walk = (dir, insidePrebuilds) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const dirs = entries.filter((entry) => entry.isDirectory())
    // 保险：只有当我们自己的变体就在这一层时，才允许在 prebuilds 之外按名删除——
    // 于是「最后一个能用的」永远不会被删掉。
    const oursIsHere = dirs.some((entry) => keep.has(entry.name))
    // 同层名字快照，供第 4 类判据的「glibc 对应物存在吗」安全丝使用。
    // 在遍历前取快照：断言的依据是「这一层**本来**有什么」，不受本轮删除顺序影响。
    const namesHere = new Set(dirs.map((entry) => entry.name))

    for (const entry of dirs) {
      const full = join(dir, entry.name)
      // 第 4 类：包名本身是 libc 选择器，且同层有 glibc 对应物。
      const glibcTwin = glibcSiblingName(entry.name)
      const isForeignMuslPackage =
        pruningMuslPackages && glibcTwin !== null && namesHere.has(glibcTwin)
      if (
        isForeignMuslPackage ||
        (isForeignVariantName(entry.name, keep) && (insidePrebuilds || oursIsHere))
      ) {
        try {
          rmSync(full, { recursive: true, force: true })
          removed.push(full)
        } catch {
          /* 删不掉就留着：多占体积也好过把树改坏 */
        }
        continue
      }
      walk(full, entry.name === 'prebuilds' || entry.name === 'prebuilt')
    }
  }

  walk(root, false)
  return { removed }
}

// ---------------------------------------------------------------------------
// 自测
// ---------------------------------------------------------------------------

/**
 * 在临时目录里造一棵覆盖真实布局的树。
 *
 * 布局照搬 2026-09-11 CI 日志里出现过的真实路径：koffi 的 musl/glibc 并列、
 * node-pty 的 prebuilds 多平台、以及一份**没有**同平台邻居的孤独变体。
 *
 * @param {string} root 空目录
 * @returns {string} 造好的根目录（同 `root`）
 */
function makeFixture(root) {
  const put = (rel) => {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, '// fixture\n', 'utf8')
  }
  // koffi：同一个包里并列 glibc 与 musl（CI 事故的现场）
  put('@koromix/koffi-linux-x64/linux_x64/koffi.node')
  put('@koromix/koffi-linux-x64/musl_x64/koffi.node')
  // node-pty：prebuildify 约定，prebuilds/<platform>-<arch>/
  put('node-pty/prebuilds/linux-x64/pty.node')
  put('node-pty/prebuilds/linux-arm64/pty.node')
  put('node-pty/prebuilds/darwin-x64/pty.node')
  put('node-pty/prebuilds/darwin-arm64/pty.node')
  put('node-pty/prebuilds/win32-x64/pty.node')
  // prebuilds 之外、但同层有我们自己的变体：允许按名删邻居
  put('demo-native/linux-x64/a.node')
  put('demo-native/linux-arm64/a.node')
  // 裸 libc 名做目录选择器（0.1.5-rc.1 的 @deepseek-ai/node-addon-system-linux-x64
  // 布局；2026-09-12 linuxdeploy 打包失败的现场）
  put('@deepseek-ai/node-addon-system-linux-x64/bin/glibc/system.node')
  put('@deepseek-ai/node-addon-system-linux-x64/bin/musl/system.node')
  // prebuilds 之外且**没有**同平台邻居：保险丝，必须原样保留
  put('lonely/darwin-arm64/keep.node')
  // 只有 musl、没有 glibc 邻居的孤独 libc 变体：安全丝必须挡住（保留）
  put('lonely-libc/bin/musl/system.node')
  // @img/sharp 布局：**包名本身**是 libc 选择器。0.35.4 的 bin 包不声明 `libc` 字段，
  // 于是 npm 在 linux/x64 上把 glibc 与 musl 两份都装进树（2026-09-23 现场：
  // linuxdeploy 在 sharp-linuxmusl-x64-0.35.4.node 上解析 libc.musl-x86_64.so.1 失败）。
  put('@img/sharp-linux-x64/lib/sharp-linux-x64.node')
  put('@img/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64.node')
  put('@img/sharp-libvips-linux-x64/lib/libvips.node')
  put('@img/sharp-libvips-linuxmusl-x64/lib/libvips.node')
  // prebuilds 之外、且**没有** glibc 对应物的孤独 musl 包：安全丝必须挡住（保留）
  put('@img/sharp-lonely-linuxmusl-x64/lib/x.node')
  // 与平台无关的运行时模块：绝不能被这套判据碰到
  put('yaml/dist/doc/directives.js')
  put('demo/package.json')
  return root
}

/**
 * 自测：造树 → 跑真实的 `pruneForeignPlatformVariants()` → 断言。
 *
 * 第 5 组是**可伪证性检查**：把「现有门禁」——即 `prune-harness-deps.mjs` 的
 * `pruneNodeModules()`——作用于同一棵树，必须复现出「`musl_x64/koffi.node` 原样
 * 幸存」。这证明该缺陷**逃得过现有全部门禁**，本模块的断言不是装饰。
 *
 * @returns {{ passed: number }} 通过项数
 * @throws {Error} 任一断言失败时抛出，并汇总全部失败项
 */
export function selfTest() {
  const failures = []
  let passed = 0
  const check = (condition, message) => {
    passed += 1
    if (!condition) failures.push(message)
  }

  const root = mkdtempSync(join(tmpdir(), 'variant-selftest-'))
  const rel = (p) => join(root, p)
  const exists = (p) => existsSync(rel(p))

  try {
    makeFixture(root)
    pruneForeignPlatformVariants(root, { platform: 'linux', arch: 'x64' })

    // 1) 事故现场：musl 变体必须被删，glibc 变体必须留。
    check(!exists('@koromix/koffi-linux-x64/musl_x64/koffi.node'), '变体剪枝：koffi 的 musl_x64 未被删除（CI 事故未修）')
    check(exists('@koromix/koffi-linux-x64/linux_x64/koffi.node'), '变体剪枝：koffi 的 glibc linux_x64 被误删')

    // 2) prebuilds：只留目标平台架构，其余（含 arm64 / 其他 OS）全清。
    check(exists('node-pty/prebuilds/linux-x64/pty.node'), '变体剪枝：prebuilds/linux-x64 被误删')
    for (const gone of ['linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64']) {
      check(!exists(`node-pty/prebuilds/${gone}/pty.node`), `变体剪枝：prebuilds/${gone} 未被删除`)
    }

    // 3) prebuilds 之外、但有同平台邻居：同样按名删邻居。
    check(exists('demo-native/linux-x64/a.node'), '变体剪枝：有邻居的 demo-native/linux-x64 被误删')
    check(!exists('demo-native/linux-arm64/a.node'), '变体剪枝：有邻居的 demo-native/linux-arm64 未被删除')

    // 4) 保险丝与越界保护：孤独变体、无关运行时模块必须原样保留。
    check(exists('lonely/darwin-arm64/keep.node'), '变体剪枝：没有同平台邻居的孤独变体被误删（保险丝失效）')
    check(exists('yaml/dist/doc/directives.js'), '变体剪枝：误删了与平台无关的运行时模块')
    check(exists('demo/package.json'), '变体剪枝：误删了 package.json')

    // 4b) 裸 libc 布局（bin/glibc + bin/musl）：musl 必须删、glibc 必须留。
    check(
      !exists('@deepseek-ai/node-addon-system-linux-x64/bin/musl/system.node'),
      '变体剪枝：裸 libc 布局的 bin/musl 未被删除（0.1.5-rc.1 的 linuxdeploy 打包事故未修）'
    )
    check(
      exists('@deepseek-ai/node-addon-system-linux-x64/bin/glibc/system.node'),
      '变体剪枝：裸 libc 布局的 bin/glibc 被误删（会删掉目标平台唯一的构建）'
    )
    // 安全丝：没有 glibc 邻居的孤独 musl 目录必须保留——证明删除是「有邻居」驱动的，
    // 不是见到 musl 就删。
    check(
      exists('lonely-libc/bin/musl/system.node'),
      '变体剪枝：没有同 libc 邻居的孤独 musl 变体被误删（安全丝对裸 libc 布局失效）'
    )

    // 4c) 包名即 libc 选择器（@img/sharp 布局）：musl 包必须删、glibc 包必须留。
    check(
      !exists('@img/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64.node'),
      '变体剪枝：包名选择器的 musl 包未被删除（2026-09-23 linuxdeploy 打包事故未修）'
    )
    check(exists('@img/sharp-linux-x64/lib/sharp-linux-x64.node'), '变体剪枝：sharp 的 glibc 包被误删')
    check(
      !exists('@img/sharp-libvips-linuxmusl-x64/lib/libvips.node'),
      '变体剪枝：libvips 的 musl 包未被删除（带 scope + 中间词，替换必须是整体 token）'
    )
    check(exists('@img/sharp-libvips-linux-x64/lib/libvips.node'), '变体剪枝：libvips 的 glibc 包被误删')
    // 安全丝：同层**没有** glibc 对应物的孤独 musl 包必须保留——证明删除是
    // 「有 glibc 兄弟」驱动的，不是见到包名里有 linuxmusl 就删。
    check(
      exists('@img/sharp-lonely-linuxmusl-x64/lib/x.node'),
      '变体剪枝：没有 glibc 对应物的孤独 musl 包被误删（安全丝对包名选择器失效）'
    )

    // 4d) 纯函数：只对含标记的名字给出对应物，且是**整体 token** 替换。
    check(glibcSiblingName('@img/sharp-linux-x64') === null, 'glibcSiblingName：非 musl 名应为 null')
    check(
      glibcSiblingName('@img/sharp-linuxmusl-x64') === '@img/sharp-linux-x64',
      'glibcSiblingName：scope 名替换错误'
    )
    check(
      glibcSiblingName('sharp-libvips-linuxmusl-arm64') === 'sharp-libvips-linux-arm64',
      'glibcSiblingName：中间词应整体替换而不是只换开头'
    )

    // 5) 目标参数化：换成 darwin/arm64，保留集合必须整体翻转。
    const macRoot = mkdtempSync(join(tmpdir(), 'variant-selftest-mac-'))
    try {
      makeFixture(macRoot)
      pruneForeignPlatformVariants(macRoot, { platform: 'darwin', arch: 'arm64' })
      check(existsSync(join(macRoot, 'node-pty/prebuilds/darwin-arm64/pty.node')), '变体剪枝：darwin/arm64 目标下误删了 darwin-arm64')
      check(!existsSync(join(macRoot, 'node-pty/prebuilds/linux-x64/pty.node')), '变体剪枝：darwin/arm64 目标下未删除 linux-x64')
      check(existsSync(join(macRoot, 'lonely/darwin-arm64/keep.node')), '变体剪枝：darwin/arm64 目标下误删了孤独变体')
      // 第 4 类判据**只对 linux 目标**生效：darwin 目标下不得按 libc 剪包，
      // 否则一旦将来新增 musl Linux 目标，目标平台唯一的构建会被删掉。
      check(
        existsSync(join(macRoot, '@img/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64.node')),
        '变体剪枝：非 linux 目标下按 libc 剪了包（判据越界）'
      )
    } finally {
      rmSync(macRoot, { recursive: true, force: true })
    }

    // 6) 可伪证性：现有门禁作用于同一棵树时，musl 必须**幸存**，本断言才有意义。
    const bugRoot = mkdtempSync(join(tmpdir(), 'variant-bugcheck-'))
    try {
      makeFixture(bugRoot)
      pruneNodeModules(bugRoot)
      const survived = existsSync(join(bugRoot, '@koromix/koffi-linux-x64/musl_x64/koffi.node'))
      check(survived, '变体剪枝：可伪证性检查失败——现有 prune 应当留下 musl_x64，断言才有意义')
      // 第 4 类同理：现有门禁对「包名里的 libc 选择器」完全无感，musl 包必然幸存。
      const survivedSharp = existsSync(
        join(bugRoot, '@img/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64.node')
      )
      check(
        survivedSharp,
        '变体剪枝：可伪证性检查失败——现有 prune 应当留下 sharp 的 linuxmusl 包，断言才有意义'
      )
    } finally {
      rmSync(bugRoot, { recursive: true, force: true })
    }

    if (failures.length > 0) {
      throw new Error(`变体剪枝自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`)
    }
    return { passed }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const isDirectRun = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
})()

if (isDirectRun) {
  if (process.argv.includes('--self-test')) {
    try {
      const { passed } = selfTest()
      console.log(`✅ 变体剪枝自测通过（${passed} 项）`)
    } catch (error) {
      console.error(error.message)
      process.exit(1)
    }
  } else {
    console.log('用法：node scripts/prune-platform-variants.mjs --self-test')
    console.log('被 prepare-harness.mjs 引用：pruneForeignPlatformVariants(<resources>/harness/node_modules, target)')
    process.exit(1)
  }
}
