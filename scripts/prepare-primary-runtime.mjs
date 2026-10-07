#!/usr/bin/env node
/**
 * 组装 primary runtime 载荷（CX-17）：把它放进 `src-tauri/resources/runtime/`，
 * 让 Harness 的 `skill-office` / `tool-workspace-dependencies` 两行得以启用。
 *
 * # 为什么需要一个独立脚本
 *
 * 那两个插件的启用条件只是一个环境变量（`DSH_BUNDLED_PRIMARY_RUNTIME`，见
 * `dsh-sdk-app/cordis.patch.yml`），但**载荷本身缺任何一块都会让 Harness 启动期
 * stat 失败**——那就不是"少个功能"，而是"应用起不来"。所以组装必须是"全齐才落盘"，
 * 且落盘结果要如实写进 `MANIFEST.json`（AGENTS.md §7.1 规则 3：没有静默降级）。
 *
 * # 载荷布局（相对关系由上游 patch 行写死，不是本仓的选择）
 *
 * ```text
 * resources/runtime/primary-runtime/
 *   runtime.json                 # 上游 `parsePrimaryRuntime` 的 schema
 *   dependencies/python/…        # python.exe（win）或 bin/python3 + site-packages
 *   dependencies/node/bin/node[.exe]
 *   dependencies/node/node_modules/
 *   dependencies/pnpm/bin/pnpm.mjs
 * resources/runtime/office-skills/        # 与 primary-runtime **同级**
 *   scripts/check_office.py
 *   office-docx/SKILL.md  office-pptx/SKILL.md  office-xlsx/SKILL.md
 * ```
 *
 * # 三条不可协商的规则
 *
 * 1. **fail-closed**：源目录缺任何一项 → 不落盘、不改 MANIFEST 的 payload 记录、
 *    Rust 侧也就不注入环境变量。绝不放一个"半份"进去。
 * 2. **不凭空造版本号**：`--python-version` 等由调用方给；缺省时脚本报错，
 *    绝不猜一个写进 `runtime.json`（上游会按平台/架构校验，猜错就是启动失败）。
 * 3. **平台/架构必须匹配目标**：默认取宿主机；`--target-platform/--target-arch`
 *    可显式指定。manifest 与目标不符 → 拒绝（否则打出来的包在用户机上起不来）。
 * 4. **不代写上游资产**：三个 office skills 的 `SKILL.md` 由 `--office-skills` 提供。
 *    本仓**刻意不内置**它们——整棵 Harness 树与 npm 包里都只有名字引用、零正文
 *    （`dsh-skill-office/lib/index.js` 的 `SKILLS` 常量），
 *    自己造三份等于伪造上游能力（AGENTS.md §7.1 规则 1/2）。缺它们 → 载荷不落盘。
 *
 * # 它装什么（2026-10-07 起只有一种形态）
 *
 * 一份完整载荷 = CPython 解释器 + office-skills（三份 `SKILL.md` + `check_office.py`）
 * + node + pnpm。模型据此可创建/编辑 docx/pptx/xlsx，并跑 `check_office.py` 校验。
 *
 * 曾经还有第二种形态（另带 site-packages 里 8 个库：numpy/pandas/python-docx/
 * python-pptx/openpyxl/Pillow/lxml/XlsxWriter）。2026-10-07 拆除：那 8 个库的唯一
 * 读者是上游**工具描述**与 skill 的 `SKILL.md`，本仓代码一个都不引用，整条
 * `--tier full` / `--python-packages-dir` / wheel 交叉安装因此是死路。需要时按
 * git 历史恢复。
 *
 * # 用法
 *
 * ```bash
 * node scripts/prepare-primary-runtime.mjs --source <dir> \
 *      --office-skills <dir> --desktop-version 0.7.2 --python-version 3.12.10 \
 *      --node-version 24.19.0 --pnpm-version 11.7.0
 * node scripts/prepare-primary-runtime.mjs --check          # 只检验已落盘的载荷
 * node scripts/prepare-primary-runtime.mjs --self-test     # 离线自检（CI 用）
 * ```
 *
 * `--check` 与 `--self-test` 都不碰网络；`--source` 指向的目录由上游构建产物提供
 * （本仓不写死任何下载 URL——硬编码外部 URL 违反 AGENTS.md §3.2）。输入可用
 * `scripts/fetch-primary-runtime.mjs` 拉取。
 */

import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync, renameSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const PRIMARY_RUNTIME_ROOT = 'primary-runtime'
const OFFICE_SKILLS_DIR = 'office-skills'
const RUNTIME_JSON = 'runtime.json'
const SKILLS = ['office-docx', 'office-pptx', 'office-xlsx']
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u
const PLATFORMS = ['win32', 'darwin', 'linux']
const ARCHES = ['x64', 'arm64']
const TIERS = ['authoring', 'full']

/** 打印一行（统一前缀，便于 CI 抓取）。 */
function log(line) {
  console.log(`[primary-runtime] ${line}`)
}

function fail(line) {
  console.error(`[primary-runtime] ${line}`)
  process.exitCode = 1
}

/** 递归计算目录体积（字节），用于 manifest 摘要。 */
function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else total += statSync(full).size
  }
  return total
}

/**
 * 按目标平台推导载荷内各条目路径（与 Rust 侧 `Layout::primary_runtime` 逐字对应）。
 *
 * 两边必须一致，否则会出现"脚本说齐了、Rust 说没齐"——那种分歧没有任何日志能发现。
 * @param {string} root 载荷根
 * @param {'win32'|'darwin'|'linux'} platform 目标平台
 */
/**
 * 档1.5 及格线的逐项清单（与 Rust 侧 `Layout::primary_runtime` 同一张表）。
 *
 * 注意这里**没有** `Lib` / `lib/python*`：Windows 可嵌入发行版整个包是扁平的
 * （标准库在 `python312.zip` 里，实测解包 21.5 MB / 35 个文件、无 `Lib` 目录）。
 * site-packages 只在判档2 时用（见 {@link sitePackages}），不进档1.5 及格线。
 *
 * 两边必须一致，否则会出现"脚本说齐了、Rust 说没齐"——那种分歧没有任何日志能发现。
 * @param {string} root 载荷根
 * @param {'win32'|'darwin'|'linux'} platform 目标平台
 */
function expectedEntries(root, platform) {
  const deps = join(root, 'dependencies')
  const windows = platform === 'win32'
  return [
    { path: join(deps, 'python', windows ? 'python.exe' : 'bin', ...(windows ? [] : ['python3'])), kind: 'file', label: 'python interpreter' },
    { path: join(deps, 'node', 'bin', windows ? 'node.exe' : 'node'), kind: 'file', label: 'standalone node' },
    { path: join(deps, 'node', 'node_modules'), kind: 'dir', label: 'node packages' },
    { path: join(deps, 'pnpm', 'bin', 'pnpm.mjs'), kind: 'file', label: 'pnpm entry' },
    { path: join(dirname(root), OFFICE_SKILLS_DIR, 'scripts', 'check_office.py'), kind: 'file', label: 'office skill assets' },
  ]
}

/**
 * 校验单项存在且类型正确。
 * @param {{path: string, kind: string, label: string}} entry
 * @returns {string|null} 缺失/类型不符的原因，`null` 表示通过
 */
function checkEntry(entry) {
  if (!existsSync(entry.path)) return `${entry.label} 不存在：${entry.path}`
  if (entry.kind === 'dir' || entry.kind === 'dir-python') {
    if (!statSync(entry.path).isDirectory()) return `${entry.label} 不是目录：${entry.path}`
    if (entry.kind === 'dir-python' && entry.path.endsWith('lib')) {
      // POSIX 的判据是 `lib/python*` 下有内容（次版本号无法在常量里写死）。
      const children = readdirSync(entry.path).filter((name) => name.startsWith('python'))
      if (children.length === 0) return `${entry.label} 下没有 python* 目录：${entry.path}`
    }
    return null
  }
  if (!statSync(entry.path).isFile()) return `${entry.label} 不是文件：${entry.path}`
  return null
}

/**
 * 检验已落盘的载荷。
 *
 * 三态必须分清——把「缺席」当错误会让每次 `npm run gate` 都红，而那是个合法的
 * 部署形态（不打 python 载荷，office skills 保持禁用）：
 *
 * | 状态 | 判据 | `ok` |
 * |------|------|------|
 * | `absent` | 载荷根目录不存在 | ✅（`absent: true`） |
 * | `partial` | 根在，但缺任一项 | ❌ —— 残缺载荷会让 Harness 启动期 stat 失败 |
 * | `complete` | 全部齐备 | ✅ |
 *
 * 判据与 Rust 侧 `Layout::primary_runtime` **逐字同构**（同一张表、同样的 fail-closed
 * 口径）。两边漂移的后果是"脚本说齐了、Rust 说没齐"——没有任何日志能发现，所以
 * `--self-test` 里逐项抽走夹具来钉住这一点。
 *
 * @param {string} root 载荷根
 * @param {'win32'|'darwin'|'linux'} platform 目标平台
 */
function inspectPayload(root, platform) {
  if (!existsSync(root)) {
    return { ok: true, absent: true, problems: [], bytes: 0 }
  }
  const problems = expectedEntries(root, platform).map(checkEntry).filter(Boolean)
  const officeSkills = join(dirname(root), OFFICE_SKILLS_DIR)
  // 三份 SKILL.md 是**硬需求**：`dsh-skill-office/lib/index.js` 在插件挂载期对每个
  // `SKILL.md` 做 `readFileSync`，缺一个就 ENOENT → Harness 起不来。
  for (const skill of SKILLS) {
    const md = join(officeSkills, skill, 'SKILL.md')
    if (!existsSync(md)) problems.push(`skill 资产缺失：${md}`)
  }
  // runtime.json 内容校验（与上游 `parsePrimaryRuntime` 同构；不含 sha256 复算——
  // 那是组装期的事）。
  const manifestPath = join(root, RUNTIME_JSON)
  let manifest
  if (!existsSync(manifestPath)) {
    problems.push(`${RUNTIME_JSON} 不存在：${manifestPath}`)
  } else {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      problems.push(`${RUNTIME_JSON} 不是合法 JSON：${error.message}`)
    }
  }
  if (manifest) {
    // 与上游 `parsePrimaryRuntime` 同构的字段校验（不含 sha256 复算——那是组装期的事）。
    for (const key of ['desktopVersion', 'platform', 'arch', 'python']) {
      if (typeof manifest[key] !== 'string' || manifest[key].length === 0) {
        problems.push(`${RUNTIME_JSON} 缺少 ${key}`)
      }
    }
    if (manifest.platform !== undefined && manifest.platform !== platform) {
      problems.push(`${RUNTIME_JSON} 的 platform=${manifest.platform} 与目标 ${platform} 不符`)
    }
    if (!PLATFORMS.includes(manifest.platform)) problems.push(`${RUNTIME_JSON} platform 非法`)
    if (!ARCHES.includes(manifest.arch)) problems.push(`${RUNTIME_JSON} arch 非法：${manifest.arch}`)
    for (const key of ['python', 'node', 'pnpm']) {
      if (manifest[key] !== undefined && !SEMVER.test(manifest[key])) {
        problems.push(`${RUNTIME_JSON} ${key} 不是 semver：${manifest[key]}`)
      }
    }
    if (manifest.node === undefined && manifest.pnpm !== undefined) {
      problems.push(`${RUNTIME_JSON} 有 pnpm 却无 node——上游 schema 禁止该组合`)
    }
    // `pythonPackages` 是上游 schema 的**可选**字段。本仓自 2026-10-07 起不再往里
    // 装 8 个库（它们的唯一读者是上游工具描述，本仓代码零引用），因此自己组装的
    // 载荷不写这个字段；这里仍然校验它——万一别人给的载荷带了，不能因为形状不熟
    // 就把一份合法载荷判成残缺。
    if (manifest.pythonPackages !== undefined) {
      const normalised = new Set()
      for (const [name, version] of Object.entries(manifest.pythonPackages)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) problems.push(`${RUNTIME_JSON} 分发包名非法：${name}`)
        if (!/^\d[\w.!+-]*$/u.test(version)) problems.push(`${RUNTIME_JSON} ${name} 版本非法：${version}`)
        // PEP 503 归一化后重名 → 上游直接拒绝。
        const key = name.toLowerCase().replace(/[-_.]+/gu, '-')
        if (normalised.has(key)) problems.push(`${RUNTIME_JSON} 归一化后重名：${name}`)
        normalised.add(key)
      }
    }
  }

  if (problems.length > 0) {
    return { ok: false, absent: false, problems, bytes: dirSize(root) }
  }
  return { ok: true, absent: false, problems, bytes: dirSize(root), manifest }
}

/** 解析命令行参数（只支持 `--key value` 与 `--flag`）。 */
function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next
      index += 1
    } else {
      args[key] = true
    }
  }
  return args
}

/**
 * 从源目录组装载荷。
 * @param {Record<string, string|true>} args
 * @returns {boolean} 是否成功（失败时置 `process.exitCode` 并返回 false）
 */
function assemble(args) {
  const resources = resolve(String(args.resources ?? 'src-tauri/resources'))
  const source = args.source === undefined ? null : resolve(String(args.source))
  const platform = String(args['target-platform'] ?? process.platform)
  const arch = String(args['target-arch'] ?? (process.arch === 'arm64' ? 'arm64' : 'x64'))
  if (!PLATFORMS.includes(platform) || !ARCHES.includes(arch)) {
    fail(`目标平台/架构非法：${platform}/${arch}`)
    return false
  }
  if (source === null) {
    fail('缺少 --source（指向已备好 python 依赖的载荷目录）')
    return false
  }
  if (!existsSync(source)) {
    fail(`源目录不存在：${source}`)
    return false
  }
  const windows = platform === 'win32'

  const problems = []
  for (const key of ['desktop-version', 'python-version', 'node-version', 'pnpm-version']) {
    const value = args[key] === undefined ? undefined : String(args[key])
    if (value === undefined || !SEMVER.test(value)) {
      problems.push(`--${key} 缺失或不是 semver：${value ?? '(未提供)'}`)
    }
  }
  if (problems.length > 0) {
    fail(`参数不合法：\n  - ${problems.join('\n  - ')}`)
    return false
  }

  const runtimeDir = join(resources, 'runtime')
  const root = join(runtimeDir, PRIMARY_RUNTIME_ROOT)
  const officeSkills = join(runtimeDir, OFFICE_SKILLS_DIR)

  const manifest = {
    desktopVersion: String(args['desktop-version']),
    platform,
    arch,
    python: String(args['python-version']),
    node: String(args['node-version']),
    pnpm: String(args['pnpm-version']),
  }

  // 先落临时目录，全部校验通过后再替换产物——避免"拷到一半失败留下残包"。
  //
  // 暂存布局与产物**完全一致**（`primary-runtime/dependencies/…` + 同级 `office-skills/`），
  // 这样 `inspectPayload` 可以原样跑在同一套判据上；否则"脚本说齐了、Rust 说没齐"
  // 这种分歧没有任何日志能发现。
  const staging = join(runtimeDir, '.staging-primary-runtime')
  rmSync(staging, { recursive: true, force: true })
  const stagedPayload = join(staging, PRIMARY_RUNTIME_ROOT)
  const stagedDeps = join(stagedPayload, 'dependencies')
  const stagedOffice = join(staging, OFFICE_SKILLS_DIR)
  mkdirSync(stagedDeps, { recursive: true })
  mkdirSync(stagedOffice, { recursive: true })
  try {
    // 源目录布局与产物一致（`dependencies/` 在根或上一级），整体拷贝。
    const sourceRoot = existsSync(join(source, 'dependencies'))
      ? source
      : dirname(source)
    cpSync(join(sourceRoot, 'dependencies'), stagedDeps, { recursive: true })
    // office skills：`--office-skills` 显式指定，或 `source/office-skills`。
    //
    // **刻意不内置**：上游三份 SKILL.md 在本仓与 npm 包里都只有名字引用、零正文，
    // 自己造等于伪造上游能力（AGENTS.md §7.1）。因此这里只"转交"，不"生产"。
    const skillSource = existsSync(join(sourceRoot, OFFICE_SKILLS_DIR))
      ? join(sourceRoot, OFFICE_SKILLS_DIR)
      : (args['office-skills'] === undefined ? null : resolve(String(args['office-skills'])))
    if (skillSource === null) {
      fail(`找不到 ${OFFICE_SKILLS_DIR}/（用 --office-skills 指向上游产物；本仓刻意不自备，见 §7.1）`)
      rmSync(staging, { recursive: true, force: true })
      return false
    }
    cpSync(skillSource, stagedOffice, { recursive: true })
    // node / pnpm 允许分开提供（`--source` 只带 python 时最常见）。
    //
    // 目录形态宽容一点：上游 schema 要求 `dependencies/node/bin/node[.exe]` 与
    // `dependencies/pnpm/bin/pnpm.mjs`，而本仓自己的 `resources/node/` 是**平铺**的
    // （`node.exe` 直接在里面，见 `prepare-harness.mjs`）。因此源目录给的是包根
    // （`bin/` 在下面）还是已经就是 `bin/` 本身，都要能接。
    for (const [name, binary, provided] of [
      ['node', windows ? 'node.exe' : 'node', args['node-source']],
      ['pnpm', 'pnpm.mjs', args['pnpm-source']],
    ]) {
      if (provided === undefined) continue
      const from = resolve(String(provided))
      const flat = join(from, binary)
      const nested = join(from, 'bin', binary)
      const to = join(stagedDeps, name, 'bin')
      mkdirSync(to, { recursive: true })
      if (existsSync(nested)) {
        cpSync(nested, join(to, binary))
      } else if (existsSync(flat)) {
        cpSync(flat, join(to, binary))
      } else {
        fail(`${name} 源里找不到 ${binary}（试过 ${nested} 与 ${flat}）`)
        rmSync(staging, { recursive: true, force: true })
        return false
      }
      // node 还要一个 `node_modules` 目录（上游判据是"目录存在"）。
      if (name === 'node') {
        const modules = existsSync(join(from, 'node_modules'))
          ? join(from, 'node_modules')
          : join(from, '..', 'node_modules')
        if (existsSync(modules)) {
          cpSync(modules, join(stagedDeps, 'node', 'node_modules'), { recursive: true })
        } else {
          mkdirSync(join(stagedDeps, 'node', 'node_modules'), { recursive: true })
          log('node 源无 node_modules，建空目录占位（上游只校验它是目录）')
        }
      }
    }
    writeFileSync(join(stagedPayload, RUNTIME_JSON), `${JSON.stringify(manifest, null, 2)}\n`)
  } catch (error) {
    fail(`拷贝载荷失败：${error.message}`)
    rmSync(staging, { recursive: true, force: true })
    return false
  }

  const result = inspectPayload(stagedPayload, platform)
  if (!result.ok) {
    fail(`载荷不完整，未落盘：\n  - ${result.problems.join('\n  - ')}`)
    rmSync(staging, { recursive: true, force: true })
    return false
  }

  // 校验通过才替换产物。
  //
  // 刻意**不**整目录 rm 了再拷：`prepare-harness.mjs` 在载荷根里写的 `.payload-root`
  // 标记属于它，不属于本脚本。整目录删会让两个脚本对同一目录产生隐式顺序依赖
  // （谁后跑谁把标记删了），而标记的意义恰恰是"载荷缺席时 glob 依然可满足"。
  // 因此这里只清载荷自己那份（dependencies/），再整体拷回。
  rmSync(join(root, 'dependencies'), { recursive: true, force: true })
  rmSync(officeSkills, { recursive: true, force: true })
  cpSync(stagedPayload, root, { recursive: true })
  cpSync(stagedOffice, officeSkills, { recursive: true })
  rmSync(staging, { recursive: true, force: true })
  log(`载荷已就位：${root}（${result.bytes} 字节，${platform}/${arch}，python ${manifest.python}）`)
  return true
}

/**
 * 建一份完整载荷夹具（桩文件即可：判定只看类型，不看内容）。
 *
 * 抽成函数是为了让「manifest 内容规则」那组断言能在**独立的干净树**上跑——
 * 复用同一棵树会让它读到前面几组删剩的「不存在」，断言随之退化成对执行顺序的
 * 偶然检验（2026-10-07 macOS CI 红、Windows 侥幸通过，就是这个原因）。
 *
 * @param {string} root 载荷根（`primary-runtime`）
 * @param {'win32'|'darwin'|'linux'} platform
 */
function buildFixture(root, platform) {
  const windows = platform === 'win32'
  const deps = join(root, 'dependencies')
  const office = join(dirname(root), OFFICE_SKILLS_DIR)
  mkdirSync(join(deps, 'python', windows ? '.' : 'bin'), { recursive: true })
  mkdirSync(join(deps, 'node', 'bin'), { recursive: true })
  mkdirSync(join(deps, 'node', 'node_modules'), { recursive: true })
  mkdirSync(join(deps, 'pnpm', 'bin'), { recursive: true })
  writeFileSync(join(deps, 'python', ...(windows ? ['python.exe'] : ['bin', 'python3'])), 'stub')
  writeFileSync(join(deps, 'node', 'bin', windows ? 'node.exe' : 'node'), 'stub')
  writeFileSync(join(deps, 'pnpm', 'bin', 'pnpm.mjs'), 'stub')
  mkdirSync(join(office, 'scripts'), { recursive: true })
  writeFileSync(join(office, 'scripts', 'check_office.py'), 'stub')
  for (const skill of SKILLS) {
    mkdirSync(join(office, skill), { recursive: true })
    writeFileSync(join(office, skill, 'SKILL.md'), 'stub')
  }
  writeFileSync(join(root, RUNTIME_JSON), JSON.stringify({
    desktopVersion: '0.0.0-test', platform, arch: 'x64', python: '3.13.1', node: '24.14.0', pnpm: '11.7.0',
  }))
}

/**
 * `--self-test`：用夹具离线验证完整性判据。
 *
 * 覆盖四组断言，每组都可证伪（把实现打回旧写法必须转红）：
 *
 * 1. 全齐 → 放行；
 * 2. **逐项**抽走任一项（含三份 `SKILL.md`）→ 判残缺（fail-closed）；
 *    `node_modules` 类型不对也要红；
 * 3. 缺席 → `ok:true` 且 `absent:true`（不打载荷是合法部署形态）；
 * 4. `runtime.json` 内容规则生效（platform 不符 / arch 非法 / 非 semver / 有 pnpm 无 node）。
 */
function selfTest() {
  const tmp = join(process.cwd(), 'node_modules', '.cache', 'primary-runtime-selftest')
  rmSync(tmp, { recursive: true, force: true })
  const platform = process.platform
  const windows = platform === 'win32'
  const root = join(tmp, 'resources', 'runtime', PRIMARY_RUNTIME_ROOT)
  const deps = join(root, 'dependencies')
  const office = join(tmp, 'resources', 'runtime', OFFICE_SKILLS_DIR)
  buildFixture(root, platform)

  const problems = []

  // 1) 全齐 → 放行。
  const complete = inspectPayload(root, platform)
  if (!complete.ok) {
    problems.push(`夹具应通过校验，却报了：${complete.problems.join('; ')}`)
  }

  // 2) 逐项抽走 → 必须判残缺（fail-closed）。含三份 SKILL.md——缺一个就会让
  //    `dsh-skill-office` 在挂载期 readFileSync 抛 ENOENT、Harness 起不来。
  const victims = [
    join(deps, 'python', ...(windows ? ['python.exe'] : ['bin', 'python3'])),
    join(deps, 'node', 'bin', windows ? 'node.exe' : 'node'),
    join(deps, 'pnpm', 'bin', 'pnpm.mjs'),
    join(office, 'scripts', 'check_office.py'),
    ...SKILLS.map((skill) => join(office, skill, 'SKILL.md')),
    join(root, RUNTIME_JSON),
  ]
  for (const victim of victims) {
    rmSync(victim, { force: true })
    const broken = inspectPayload(root, platform)
    if (broken.ok) problems.push(`抽走 ${victim} 后仍判为可用——残缺载荷会让 Harness 起不来`)
  }

  // 2b) `node_modules` 是判据里唯一一项"目录"，类型不对也要红。
  const modules = join(deps, 'node', 'node_modules')
  const stash = `${modules}.stash`
  rmSync(stash, { recursive: true, force: true })
  renameSync(modules, stash)
  writeFileSync(modules, 'now a file')
  if (inspectPayload(root, platform).ok) problems.push('node_modules 变成文件后仍判为可用')
  rmSync(modules, { force: true })
  renameSync(stash, modules)

  // 3) 缺席合法。
  const absent = inspectPayload(join(tmp, 'does-not-exist'), platform)
  if (!absent.ok || absent.absent !== true) {
    problems.push('载荷缺席必须判为 ok + absent（不打载荷是合法部署形态）')
  }

  // 4) runtime.json 内容规则。**独立夹具**：前面几组已把这棵树删改得面目全非，
  //    复用它会读到一堆「不存在」而不是想要的 manifest 违规——那断言就变成了
  //    「夹具有没有被弄脏」的偶然检验（见 buildFixture 的说明）。
  const solo = join(tmp, 'solo', 'resources', 'runtime', PRIMARY_RUNTIME_ROOT)
  buildFixture(solo, platform)
  const bad = (patch) => {
    writeFileSync(join(solo, RUNTIME_JSON), JSON.stringify({
      desktopVersion: '0.0.0-test', platform, arch: 'x64', python: '3.13.1', node: '24.14.0', pnpm: '11.7.0', ...patch,
    }))
    return inspectPayload(solo, platform)
  }
  // 不得硬编码某个平台名（`platform: 'darwin'`）当"错误值"：在 macOS 上那正是
  // 当前平台，改完等于没改，于是 ok=true、断言误判为缺陷（2026-10-07 macOS CI
  // 两连红的原因）。要挑一个**当前平台之外**的值。
  const otherPlatform = PLATFORMS.find((p) => p !== platform)
  const cases = [
    [{ platform: otherPlatform }, /platform=/u],
    [{ arch: 'mips' }, /arch 非法/u],
    [{ python: '3.13' }, /不是 semver/u],
    [{ node: undefined }, /有 pnpm 却无 node/u],
  ]
  for (const [patch, expect] of cases) {
    const r = bad(patch)
    if (r.ok || !expect.test(r.problems.join(';'))) {
      // 输出**完整** problems：这条断言曾在 macOS 上红而 Windows 上绿，差异全在
      // problems 的内容里，截断过的消息只会让下一次排查又从零开始。
      problems.push(
        `runtime.json 违规未被拒：${JSON.stringify(patch)} → ` +
          `ok=${r.ok} absent=${r.absent} problems=[${r.problems.join(' || ')}]`,
      )
    }
  }

  rmSync(tmp, { recursive: true, force: true })
  if (problems.length > 0) {
    fail(`self-test 失败：\n  - ${problems.join('\n  - ')}`)
    return false
  }
  log('self-test 通过（全齐放行 / 逐项缺失被拒 / 缺席合法 / runtime.json 规则生效）')
  return true
}

const args = parseArgs(process.argv.slice(2))
if (args['self-test']) {
  selfTest()
} else if (args.check) {
  const platform = String(args['target-platform'] ?? process.platform)
  const root = resolve(String(args.resources ?? 'src-tauri/resources'), 'runtime', PRIMARY_RUNTIME_ROOT)
  const result = inspectPayload(root, platform)
  if (result.absent) {
    log('载荷缺席（合法：office skills 保持禁用）')
  } else if (result.ok) {
    log(`载荷达标（${result.bytes} 字节）：可创建/编辑 docx/pptx/xlsx + 跑 check_office.py 校验`)
  } else {
    fail(`载荷残缺（缺一块就会让 Harness 起不来）：\n  - ${result.problems.join('\n  - ')}`)
  }
} else {
  const ok = assemble(args)
  if (ok && args.check !== undefined) {
    const platform = String(args['target-platform'] ?? process.platform)
    const root = resolve(String(args.resources ?? 'src-tauri/resources'), 'runtime', PRIMARY_RUNTIME_ROOT)
    const result = inspectPayload(root, platform)
    if (!result.ok) fail(`落盘后自检失败：\n  - ${result.problems.join('\n  - ')}`)
  }
}
