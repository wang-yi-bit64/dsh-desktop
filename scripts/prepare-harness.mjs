#!/usr/bin/env node
/**
 * prepare-harness.mjs — assemble the bundled Harness runtime for Tauri.
 *
 * Steps:
 *   1. Stage a scratch install directory (harness-deps/) with the pinned
 *      @deepseek-ai/dsh release, the bundled Node.js runtime, pnpm, and the
 *      local desktop customization packages (vendor/).
 *   2. npm install (online) materializes the full dependency tree.
 *   3. patch-package reapplies the tracked desktop patches to node_modules.
 *   4. install-brand-assets injects the DSH Desktop logo into the Harness
 *      web frontend dist.
 *   5. Everything is copied into src-tauri/resources/ for bundling:
 *        resources/node/node(.exe)                 bundled Node.js runtime
 *        resources/harness/node_modules/...        full dsh dependency tree
 *        resources/harness-node-entry.mjs          wrapper entry
 *        resources/windows-child-process-hide.mjs  sibling of the wrapper
 *        resources/dsh-desktop.patch.yml           --patch layer
 *        resources/dsh-desktop-safe.patch.yml      --patch layer (safe mode, C10)
 *        resources/<pages & brand assets>
 *
 * The node_modules tree keeps its npm layout so `bin.js` resolves its
 * dependencies by walking upward from its own location.
 */

import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CRITICAL_LAYER,
  PATCHES_DIR,
  auditPatchLayers,
  layerOf,
  listPatchFiles,
  packageNameFromPatchFile
} from './patch-layers.mjs'

// 打包目标守卫（见下方 `--target` 段）。import 模块级无副作用：
// verify-target.mjs 的 CLI 入口有「主模块」判定保护。
import { checkTarget } from './verify-target.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const staging = join(projectRoot, 'harness-deps')
const resources = join(projectRoot, 'src-tauri', 'resources')
const buildDir = join(projectRoot, 'build')
const vendorDir = join(projectRoot, 'vendor')

const DSH_VERSION = '0.1.2-alpha.4'
const NODE_VERSION = '24.9.0'
const PNPM_VERSION = '10.34.5'

// 任务 0.3：连续两次运行，第二次必须因「输入未变」而跳过（lockfile hash
// 一致），保证构建可复现。`--force` 可跳过这一检查。
const forceRebuild = process.argv.includes('--force')

// 补丁失败策略：默认按 patches/LAYERS.md 的分级（functional 才中断构建）；
// `--strict` 让所有层都 fail-fast，等价于分级引入前的行为。
const strictPatches = process.argv.includes('--strict')

// 打包目标平台守卫：`--target=<platform>/<arch>`（例：`--target=win32/x64`）。
//
// 为什么这一步必须存在：本脚本会把**当前主机架构**的 Node 二进制组装进
// resources/node/。若构建主机与目标平台不一致，产出的安装包会内嵌错误架构
// 的 Node，在目标机上表现为「Harness 起不来」——根因在构建期，事后极难归因。
// 因此显式声明目标时先校验再组装，把事故前移到构建前一刻。
//
// 默认（不传 `--target`）不校验：本地开发机常常没有 rustc 在 PATH 上，
// 强制校验会让 `npm run dev` 莫名失败。CI 侧另有独立步骤跑自动推断校验。
const targetArg = (process.argv.find((arg) => arg.startsWith('--target=')) ?? '').slice(
  '--target='.length
)

// 补丁应用结果（由 applyTieredPatches 填充，buildManifest 消费）。
let patchReport = []

const isWindows = process.platform === 'win32'

function log(message) {
  console.log(`[prepare-harness] ${message}`)
}

function run(command, args, cwd) {
  log(`$ ${command} ${args.join(' ')} (in ${cwd})`)
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: isWindows })
}

/**
 * Delete a directory tree, with a native-command fallback.
 *
 * Some environments (e.g. sandboxed shells) intercept `rmSync` and route
 * deletions through the OS trash, which times out on huge trees such as
 * `harness-deps/` (15k+ files). Fall back to the platform's native remove
 * command, which bypasses the trash entirely.
 *
 * @param {string} path - Absolute directory path to remove.
 * @returns {void}
 */
function rmTreeSafe(path) {
  // 优先使用平台原生命令：不经回收站、不受 fs shim 拦截，且在超大目录
  // （harness-deps/ 约 2 万个文件）上比 rmSync 快一个数量级以上。
  try {
    if (isWindows) {
      execFileSync('cmd.exe', ['/d', '/s', '/c', 'rd', '/s', '/q', path], { stdio: 'ignore' })
    } else {
      execFileSync('rm', ['-rf', path], { stdio: 'ignore' })
    }
    if (!existsSync(path)) return
  } catch {
    // 原生命令不可用时回退到 rmSync。
  }
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (error) {
    log(`rmSync 失败（${String(error.message).split('\n')[0]}），请手动删除 ${path}`)
    throw error
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function directoryFingerprint(directory) {
  const entries = readdirSafe(directory)
    .sort()
    .map((file) => {
      const full = join(directory, file)
      const digest = statSync(full).isDirectory()
        ? directoryFingerprint(full)
        : sha256(readFileSync(full))
      return `${file}:${digest}`
    })
  return sha256(entries.join('\n'))
}

// ---------------------------------------------------------------------------
// 0. 打包目标守卫（仅当显式传 `--target` 时）。
//    放在任何删除/下载之前：目标不匹配就立刻退出，不浪费一次 300MB 组装。
// ---------------------------------------------------------------------------
if (targetArg) {
  const [expectedPlatform, expectedArch] = targetArg.split('/')
  if (!expectedPlatform || !expectedArch) {
    console.error(`[prepare-harness] 非法 --target=${targetArg}；期望 <platform>/<arch>，例：win32/x64`)
    process.exit(2)
  }
  const { ok, message } = checkTarget({ platform: expectedPlatform, arch: expectedArch })
  if (!ok) {
    console.error(`[prepare-harness] 打包目标校验失败：\n${message}`)
    console.error(
      '[prepare-harness] 本脚本会把当前主机的 Node 二进制组装进 resources/node/，' +
        '跨平台产物会内嵌错误架构的运行时，因此拒绝继续。'
    )
    process.exit(1)
  }
  log(message)
}

// ---------------------------------------------------------------------------
// 0. 输入指纹与 overrides。
//    幂等检查必须先于任何删除操作执行：连续两次运行时，第二次要因
//    「输入未变」直接跳过（任务 0.3），不能先毁掉 staging 产物。
// ---------------------------------------------------------------------------
const vendorPackages = [
  'dsh-desktop-client-ui',
  'dsh-desktop-hmr-fallback',
  'dsh-desktop-market-installer',
  'dsh-desktop-preset-transfer',
  'dshmarket'
]

const dependencies = {
  '@deepseek-ai/dsh': DSH_VERSION,
  node: NODE_VERSION,
  pnpm: PNPM_VERSION
}
for (const name of vendorPackages) {
  dependencies[name] = `file:${join(vendorDir, name).replace(/\\/g, '/')}`
}

// Pin every patched package to the exact version its patch was made for.
// Without overrides, npm resolves the dsh sub-dependency ranges (e.g.
// ^0.1.2-alpha.4) to newer prereleases such as 0.1.2-rc.1, which the
// tracked patches refuse to apply to.
const overrides = {}
for (const file of readdirSafe(join(projectRoot, 'patches'))) {
  // @deepseek-ai+dsh-client-ui-chat+0.1.2-alpha.4.patch
  const match = file.match(/^(.*)\+(\d+\.\d+\.\d+[^+]*)\.patch$/)
  if (!match) continue
  const packageName = match[1].replace(/\+/g, '/')
  overrides[packageName] = match[2]
}

// A few registry tarballs were republished with content that no longer
// matches the tracked patches (same version string, different bytes). Those
// are vendored as tgz under packages/ and override the registry entirely.
const vendoredDir = join(projectRoot, 'packages')
for (const file of readdirSafe(vendoredDir)) {
  const match = file.match(/^(.*)-(\d+\.\d+\.\d+.*)\.tgz$/)
  if (!match) continue
  const packageName = match[1].replace(/^(deepseek-ai|deepseek)-/, '@deepseek-ai/')
  overrides[packageName] = `file:${join(vendoredDir, file).replace(/\\/g, '/')}`
}
log(`pinning ${Object.keys(overrides).length} patched packages via overrides`)

// staging 的 package.json 与当前输入完全一致 ⇒ 其 lockfile 由同一输入安装
// 产生，可用于快速路径与 lockfileHash 校验。
function stagingInputsMatch() {
  try {
    const stagingPkg = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'))
    return (
      JSON.stringify(stagingPkg.dependencies) === JSON.stringify(dependencies) &&
      JSON.stringify(stagingPkg.overrides) === JSON.stringify(overrides)
    )
  } catch {
    return false
  }
}

// 任务 0.3：MANIFEST 记录组装时间、lockfile hash、锁定版本。运行时在
// src-tauri 侧做 warning 级比对（阶段 7 的 build.rs 不做硬校验）。
//
// `patches` 记录**逐个补丁的真实结果**（applied / skipped / failed + 层名）。
// 此前这里写的是 `patchesApplied: <patches/ 下的文件数>`——那是「存在多少个
// 补丁文件」，不是「应用成功多少个」，名字与语义不符，会掩盖「补丁全部没打上」
// 这类事故。现在两者分开记录，且不再使用误导性的 `patchesApplied` 字段。
function buildManifest(lockfilePath) {
  const patchFiles = readdirSafe(join(staging, 'patches')).length
  return {
    fingerprint,
    generatedAt: new Date().toISOString(),
    lockfileHash: sha256(readFileSync(lockfilePath, 'utf8')),
    versions: {
      dsh: DSH_VERSION,
      node: NODE_VERSION,
      pnpm: PNPM_VERSION
    },
    overrides: Object.keys(overrides).sort(),
    patchFilesPresent: patchFiles,
    patchesStrict: strictPatches,
    patches: patchReport
  }
}

// ---------------------------------------------------------------------------
// 0. 幂等检查：输入指纹未变且产物完整 → 直接复用，保证可复现且不拖慢内环。
// ---------------------------------------------------------------------------
const patchesFingerprint = existsSync(join(projectRoot, 'patches'))
  ? directoryFingerprint(join(projectRoot, 'patches'))
  : 'no-patches'
// `build/` is copied verbatim into resources/ (entry wrapper, guard, patch
// layer, pages) but is not a dependency, so without its own digest an edit
// there leaves the fingerprint unchanged — the fast path then reuses the stale
// copy already in resources/ and the change never ships. That silently dropped
// a generation-projection hook added to harness-node-entry.mjs. (vendor/ needs
// no digest here: those entries are symlinked into resources/ and dereferenced
// at package time, so their content is always current.)
const buildFingerprint = existsSync(buildDir) ? directoryFingerprint(buildDir) : 'no-build'
const fingerprint = sha256(
  JSON.stringify({
    dshVersion: DSH_VERSION,
    nodeVersion: NODE_VERSION,
    pnpmVersion: PNPM_VERSION,
    dependencies,
    overrides,
    patches: patchesFingerprint,
    build: buildFingerprint
  })
)

const nodeBinName = isWindows ? 'node.exe' : 'node'
const manifestPath = join(resources, 'MANIFEST.json')

// tauri.conf.json 的 bundle.resources 逐条列举了打包所需的文件；build.rs 对每个
// glob 做硬校验，缺任何一条都会让 cargo 编译失败。幂等快速路径必须按同一份清单
// 校验，否则残缺的 resources/ 会被当成「完整」复用——实测漏掉 bin/ 与
// plugin-safety-guard.mjs 时打包出来的应用启动即崩（node 入口 import 不到
// guard，harness 根本起不来）。
const REQUIRED_FILES = [
  'harness-node-entry.mjs',
  'windows-child-process-hide.mjs',
  'plugin-safety-guard.mjs',
  'dsh-desktop.patch.yml',
  'dsh-desktop-safe.patch.yml',
  'MANIFEST.json',
  'splash.html',
  'plugin-recovery.html',
  'windows-menu.html',
  'dsh-loader.gif',
  'dsh-loader-dark.gif',
  'app-icon.png'
]
const REQUIRED_DIRS = ['bin', 'node', join('harness', 'node_modules', '@deepseek-ai')]

function resourcesComplete() {
  return (
    REQUIRED_FILES.every((file) => existsSync(join(resources, file))) &&
    REQUIRED_DIRS.every((dir) => existsSync(join(resources, dir))) &&
    existsSync(join(resources, 'node', nodeBinName))
  )
}

/**
 * Copy `build/`'s runtime files into `resources/`.
 *
 * Separate from the main assembly so the fast paths below can refresh them
 * too: these files are inputs to the shipped app, not dependencies, so a
 * change here must land in resources/ even when the install tree is reused.
 * @returns {void}
 */
function copyBuildFiles() {
  // plugin-safety-guard.mjs 是 harness-node-entry.mjs 的**直接**运行时依赖
  // （入口 import 它），必须一起打包。
  //
  // `plugin-worker-host.mjs` 曾在此列表中，2026-09-10 随批次 F「冻结并归档」
  // 移除：它只被同样被移除的 `PluginWorkerClient` spawn，而后者从未接线。
  for (const file of [
    'harness-node-entry.mjs',
    'windows-child-process-hide.mjs',
    'plugin-safety-guard.mjs',
    'dsh-desktop.patch.yml',
    // 安全模式的 --patch 层。缺失会让「Restart in Safe Mode」在启动时
    // 硬失败（C10：安全模式不做静默降级）。
    'dsh-desktop-safe.patch.yml'
  ]) {
    cpSync(join(buildDir, file), join(resources, file))
  }

  // Splash/recovery pages and brand assets served as resources.
  for (const file of [
    'splash.html',
    'plugin-recovery.html',
    'windows-menu.html',
    'dsh-loader.gif',
    'dsh-loader-dark.gif',
    'app-icon.png',
    'logo-light.png',
    'logo-dark.png'
  ]) {
    const source = join(buildDir, file)
    if (existsSync(source)) cpSync(source, join(resources, file))
  }
}

/**
 * Read the per-patch outcome record out of an existing MANIFEST.json.
 *
 * The fast path below reuses an install tree that was *already* patched by an
 * earlier full assembly, so it never calls `applyTieredPatches()`. Without
 * this, `patchReport` would still be its empty default and rebuilding the
 * MANIFEST would silently rewrite a truthful `patches: [...]` into `patches: []`
 * — i.e. the fast path would erase the evidence of which patches landed, which
 * is exactly the accident B1 exists to make visible.
 * @returns {object[]} The prior record, or `[]` when absent/unreadable.
 */
function priorPatchReport() {
  try {
    const prior = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return Array.isArray(prior.patches) ? prior.patches : []
  } catch {
    return []
  }
}

if (!forceRebuild) {
  let manifestMatches = false
  if (resourcesComplete() && existsSync(manifestPath)) {
    try {
      manifestMatches = JSON.parse(readFileSync(manifestPath, 'utf8')).fingerprint === fingerprint
    } catch {
      manifestMatches = false
    }
  }
  if (manifestMatches) {
    log(`输入未变（fingerprint ${fingerprint.slice(0, 12)}…），跳过重新组装（--force 可强制）`)
    process.exit(0)
  }
  // 快速路径：组装产物（resources/）与 staging 的 package.json + lockfile
  // 都完整、且 staging 的 package.json 与当前输入一致时，说明上次运行成功
  // 但 MANIFEST 缺失或过期 —— 仅重建 MANIFEST，避免整轮 npm install
  // （--force 可强制完整重组）。build/ 的产物不参与 install，指纹变化时在此
  // 单独同步，否则对 harness-node-entry.mjs 之类的修改会被快速路径静默丢掉。
  const stagingLockfile = join(staging, 'package-lock.json')
  if (resourcesComplete() && existsSync(stagingLockfile) && stagingInputsMatch()) {
    copyBuildFiles()
    // node_modules 是上次完整组装时打过补丁的，本路径不重新打补丁，
    // 因此继承旧 MANIFEST 的逐补丁记录（而非默认空数组）。
    const inherited = priorPatchReport()
    if (inherited.length > 0) {
      patchReport = inherited
      log(`沿用既有补丁记录（${inherited.length} 条）；如需重新打补丁请加 --force`)
    } else {
      log('既有 MANIFEST 无补丁记录，本次重建的 patches 将为空数组')
    }
    writeFileSync(manifestPath, `${JSON.stringify(buildManifest(stagingLockfile), null, 2)}\n`)
    log(`仅重建 MANIFEST.json 并同步 build/ 产物 → ${manifestPath}（--force 可强制完整重组）`)
    process.exit(0)
  }
  log('输入已变化或产物缺失，重新组装')
}

// ---------------------------------------------------------------------------
// 1. Stage the install directory.
// ---------------------------------------------------------------------------
log('staging install directory')
rmTreeSafe(staging)
mkdirSync(staging, { recursive: true })

writeFileSync(
  join(staging, 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-desktop-harness-deps',
      private: true,
      type: 'module',
      dependencies,
      overrides
    },
    null,
    2
  )}\n`
)

// patch-package reads ./patches relative to the working directory.
cpSync(join(projectRoot, 'patches'), join(staging, 'patches'), { recursive: true })

// ---------------------------------------------------------------------------
// 2. Install the dependency tree from the npm registry.
// ---------------------------------------------------------------------------
log('installing Harness dependency tree (this can take a while)')
run('npm', ['install', '--no-audit', '--no-fund'], staging)

// ---------------------------------------------------------------------------
// 3. Reapply the tracked desktop patches (tiered failure policy).
// ---------------------------------------------------------------------------
log('applying desktop patches')
applyTieredPatches()
assertPickerSurfaceIsHostBacked()

/**
 * Apply every tracked patch individually and decide by layer whether a failure
 * is fatal.
 *
 * `patch-package` is invoked once per patch **file**, each pointed at its own
 * temporary `--patch-dir`, rather than once for the whole tree: only the
 * per-patch form tells us *which* patch broke, and that is what the tiered
 * policy needs to decide between "warn and ship without this enhancement" and
 * "stop the build". See `applySinglePatch()` for why the
 * `patch-package <package>` form must never be used for this.
 *
 * Policies (see `patches/LAYERS.md`, single source of truth in
 * `scripts/patch-layers.mjs`):
 *   - `functional`  → fail the build;
 *   - `brand` / `ui-behavior` → log a warning, record `failed`, continue;
 *   - unregistered   → same as `ui-behavior`, but the report marks it
 *     `unclassified` so it can never drift silently;
 *   - `--strict`     → every layer fails the build.
 *
 * Two guards make the degradation path safe to trust:
 *   1. **Zero-applied is always fatal.** If nothing applied while patches are
 *      present, either the CLI form is wrong or the tree is untouched — shipping
 *      an unpatched Harness would break desktop plugin loading outright.
 *   2. Every outcome is recorded in `MANIFEST.json` and printed, so there is no
 *      "patched but nobody noticed" state.
 *
 * @returns {void}
 */
function applyTieredPatches() {
  const files = listPatchFiles()
  if (files.length === 0) {
    log('patches/ 为空，跳过补丁阶段')
    return
  }

  for (const problem of auditPatchLayers()) {
    // 分级表漂移不阻断组装（CI 的 `--self-test` 才是硬门禁），但必须可见。
    log(`⚠️ 分级表问题：${problem}`)
  }

  const records = []
  for (const file of files) {
    const info = layerOf(file)
    const pkg = packageNameFromPatchFile(file)
    const fatal = strictPatches || info.layer === CRITICAL_LAYER

    if (pkg === null) {
      records.push({
        file,
        package: null,
        layer: info.layer,
        status: 'failed',
        detail: 'cannot derive package name from patch file name'
      })
      if (fatal) throw new Error(`补丁 ${file} 的文件名无法推导包名，且其层为 ${info.layer}`)
      continue
    }

    const result = applySinglePatch(file)
    if (result.ok) {
      records.push({ file, package: pkg, layer: info.layer, status: 'applied', detail: null })
      continue
    }

    const detail = tailLines(result.output, 12)
    records.push({ file, package: pkg, layer: info.layer, status: 'failed', detail })
    if (fatal) {
      throw new Error(
        `补丁应用失败（层 ${info.layer}${info.classified ? '' : '，未登记'}）：${file}\n` +
          `包：${pkg}\n(patch-package --patch-dir <临时目录> --error-on-fail 输出末尾)\n${detail}`
      )
    }
    log(`⚠️ 补丁未应用（层 ${info.layer}，按策略降级继续）：${file}`)
    if (!info.classified) {
      log(`   该补丁未在 scripts/patch-layers.mjs 中登记，请补充分类`)
    }
  }

  const applied = records.filter((record) => record.status === 'applied').length
  patchReport = records
  printPatchReport(records)

  if (applied === 0) {
    throw new Error(
      `${files.length} 个补丁全部未应用。这通常是 patch-package 的调用形式失效` +
        '（必须是「不带包名的应用模式 + --patch-dir」，见 applySinglePatch()），' +
        '或 node_modules 未安装；无论分级如何，交付未打补丁的 Harness 都是不可接受的。'
    )
  }
}

/**
 * Apply exactly one tracked patch through patch-package's **apply** mode.
 *
 * Mechanism: copy the single patch into its own scratch `--patch-dir` inside
 * `staging/` and let patch-package apply that directory. That keeps "which patch
 * broke?" answerable (what the tiered policy needs) while still using the apply
 * code path.
 *
 * **Do not use the `patch-package <package>` form here.** Supplying a package
 * name switches the CLI to **creation** mode: it installs a pristine copy of the
 * package and diffs it against `node_modules` in order to *write* a patch file.
 * A freshly staged tree has nothing applied yet, so it reports
 * "There don't appear to be any changes" and exits non-zero — every patch is
 * then recorded as failed, the `functional` layer throws, and all three platform
 * bundle jobs die with a message about a package that is in fact perfectly fine.
 * (That is exactly what happened between cea57b3 and this fix: the remaining
 * `test` failure masked it, so it only surfaced once the earlier gate went
 * green.)
 *
 * **The `--patch-dir` value must be relative, and the directory has to live under
 * `staging/`.** patch-package only rejects values that start with `/`
 * (`--patch-dir must be a relative path`), so a Windows absolute path (`C:\...`)
 * slips past that guard, gets joined onto the cwd, resolves to a directory that
 * does not exist, and patch-package prints "No patch files found" while
 * **exiting 0**. An absolute path therefore does not fail — it silently applies
 * nothing while this function would record `applied`. Hence: scratch dir inside
 * `staging/`, relative value on the command line, plus an explicit
 * "no patch files found" check because exit code 0 is not trustworthy on its
 * own here.
 *
 * `--error-on-fail` is passed explicitly: patch-package exits 0 on failure when
 * it does not detect CI (a deliberate guard against package.json drifting from
 * node_modules). Without it a local `npm run prepare:harness` would record every
 * broken patch as `applied` — a false green in the very report that exists to be
 * the evidence of what got applied.
 *
 * @param {string} file - Patch file name inside `patches/`.
 * @returns {{ ok: boolean, output: string }} Outcome plus captured output.
 */
function applySinglePatch(file) {
  const patchDir = mkdtempSync(join(staging, '.dsh-patch-'))
  const relativePatchDir = basename(patchDir)
  try {
    copyFileSync(join(PATCHES_DIR, file), join(patchDir, file))
    const result = runCaptured(
      'npx',
      ['patch-package', '--patch-dir', relativePatchDir, '--error-on-fail'],
      staging
    )
    if (result.ok && /no patch files found/i.test(result.output)) {
      // 退出码 0 却一个补丁都没找到 = 静默空操作，与「应用成功」有本质区别。
      // 这类守卫刻意做得很窄：只拦这一种已知的静默形态，不试图解析输出语义。
      return {
        ok: false,
        output:
          `patch-package 未在 --patch-dir ${relativePatchDir} 找到补丁文件，` +
          `补丁实际上没有被应用（退出码却为 0）。\n${result.output}`
      }
    }
    return result
  } finally {
    // 临时目录必须清掉：每个补丁一次，失败路径上尤其容易堆积；
    // 它还会被后续的 resources 拷贝扫到。
    rmTreeSafe(patchDir)
  }
}

/** Print the per-patch outcome table (always, so degradation is never silent). */
function printPatchReport(records) {
  const width = Math.max(...records.map((record) => record.file.length))
  for (const record of records) {
    const flag = record.status === 'applied' ? '✔' : '✘'
    log(`  ${flag} [${record.layer}] ${record.file.padEnd(width)}  ${record.status}`)
  }
  const failed = records.filter((record) => record.status !== 'applied')
  log(
    `补丁结果：${records.length - failed.length}/${records.length} 应用成功` +
      (failed.length > 0 ? `，${failed.length} 未应用（已记入 MANIFEST.json）` : '')
  )
}

/** Last `count` non-empty lines of captured output (for diagnostics). */
function tailLines(output, count) {
  const lines = String(output)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
  return lines.slice(Math.max(0, lines.length - count)).join('\n')
}

/**
 * Run a command and capture its output instead of inheriting stdio.
 *
 * `run()` cannot be used here: `execFileSync` with `stdio: 'inherit'` throws on
 * a non-zero exit, and the tiered policy needs the failure *and* its output so
 * a degraded patch can be reported rather than aborting the process.
 *
 * @param {string} command Executable name.
 * @param {string[]} args Arguments.
 * @param {string} cwd Working directory.
 * @returns {{ ok: boolean, output: string }}
 */
function runCaptured(command, args, cwd) {
  try {
    const output = execFileSync(command, args, {
      cwd,
      shell: isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8'
    })
    return { ok: true, output: output ?? '' }
  } catch (error) {
    const stdout = error?.stdout ?? ''
    const stderr = error?.stderr ?? ''
    return { ok: false, output: `${stdout}${stderr}` || String(error?.message ?? error) }
  }
}

/**
 * The Tauri webview has no preload/initialization script, so a renderer global
 * is never defined for the Harness page. A patch once routed the native
 * directory picker through `window.dshDesktopDirectoryPicker`; that global did
 * not exist anywhere, so every workspace pick failed with "directory picker
 * bridge is unavailable". The stock surface calls the Host seam instead
 * (`ctx.uiWorkspace.pickDirectory()`), which reaches the Win32 chooser without
 * any renderer IPC. Fail the build rather than ship that regression again.
 *
 * @returns {void}
 */
function assertPickerSurfaceIsHostBacked() {
  const clientPath = join(
    staging,
    'node_modules',
    '@deepseek-ai',
    'dsh-client-ui-directory-picker-native',
    'lib',
    'client.js'
  )
  if (!existsSync(clientPath)) {
    throw new Error(`directory-picker client surface missing at ${clientPath}`)
  }
  const source = readFileSync(clientPath, 'utf8')
  const bridge = source.match(/window\.(dshDesktop[A-Za-z]*)/)
  if (bridge !== null) {
    throw new Error(
      `directory-picker client surface references window.${bridge[1]}, which no preload defines; ` +
        'route picks through ctx.uiWorkspace.pickDirectory() instead'
    )
  }
  if (!source.includes('ctx.uiWorkspace.pickDirectory()')) {
    throw new Error(
      `directory-picker client surface no longer calls ctx.uiWorkspace.pickDirectory() at ${clientPath}`
    )
  }
}

// ---------------------------------------------------------------------------
// 4. Inject the brand assets into the Harness web frontend dist.
// ---------------------------------------------------------------------------
log('installing brand assets')
run('node', [join(projectRoot, 'scripts', 'install-brand-assets.mjs'), staging], staging)

// ---------------------------------------------------------------------------
// 5. Assemble src-tauri/resources/.
// ---------------------------------------------------------------------------
log('assembling resources')
rmSync(resources, { recursive: true, force: true })
mkdirSync(resources, { recursive: true })

// Bundled Node.js runtime.
const stagedNodeBin = join(staging, 'node_modules', 'node', 'bin', nodeBinName)
if (!existsSync(stagedNodeBin)) {
  throw new Error(`Bundled Node.js binary not found at ${stagedNodeBin}`)
}
mkdirSync(join(resources, 'node'), { recursive: true })
cpSync(stagedNodeBin, join(resources, 'node', nodeBinName))

// Sidecar binary directory (resources/bin/*)
mkdirSync(join(resources, 'bin'), { recursive: true })
writeFileSync(join(resources, 'bin', '.gitkeep'), '')

// Full dependency tree, minus the node runtime package itself (its binary is
// already extracted above and the package is hundreds of MB of duplicates).
const harnessTree = join(resources, 'harness', 'node_modules')
mkdirSync(harnessTree, { recursive: true })
const stagedModules = join(staging, 'node_modules')
for (const entry of readdirSafe(stagedModules)) {
  if (entry === 'node' || entry === '.bin' || entry === '.package-lock.json') continue
  cpSync(join(stagedModules, entry), join(harnessTree, entry), { recursive: true })
}

// 瘦身优化：清理 node_modules 下开发冗余文件（.d.ts / .map / test / docs / markdown 等），
// 大幅减少 NSIS 需要打包和解压的文件数量（从数万小文件降至核心运行时文件），极大加速安装速度。
log('pruning dev artifacts and non-runtime files from harness node_modules')
pruneNodeModules(harnessTree)

// Wrapper entry, hide patch, and patch layer.
// plugin-safety-guard.mjs 是 harness-node-entry.mjs 的运行时依赖（入口直接
// import 它），必须一起打包。copyBuildFiles 自己维护文件清单。
copyBuildFiles()

// ---------------------------------------------------------------------------
// 6. MANIFEST.json：组装时间、lockfile hash、锁定版本（任务 0.3）。
//    运行时在 src-tauri 侧做 warning 级比对（阶段 7 的 build.rs 不做硬校验）。
// ---------------------------------------------------------------------------
const manifest = buildManifest(join(staging, 'package-lock.json'))
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

log(`manifest → ${manifestPath} (lockfile ${manifest.lockfileHash.slice(0, 12)}…)`)
log('done')

function readdirSafe(directory) {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

function pruneNodeModules(dir) {
  const IGNORED_EXTS = new Set([
    '.d.ts',
    '.d.ts.map',
    '.ts.map',
    '.js.map',
    '.mjs.map',
    '.cjs.map',
    '.md',
    '.markdown',
    '.npmignore',
    '.eslintrc',
    '.prettierrc',
    '.travis.yml',
    '.editorconfig'
  ])

  const IGNORED_DIRS = new Set([
    'test',
    'tests',
    '__tests__',
    'docs',
    'doc',
    'example',
    'examples',
    '.github',
    '.vscode'
  ])

  function scan(currentDir) {
    let entries = []
    try {
      entries = readdirSync(currentDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const ent of entries) {
      const fullPath = join(currentDir, ent.name)
      if (ent.isDirectory()) {
        const lower = ent.name.toLowerCase()
        if (IGNORED_DIRS.has(lower)) {
          rmSync(fullPath, { recursive: true, force: true })
        } else {
          scan(fullPath)
        }
      } else if (ent.isFile()) {
        const name = ent.name.toLowerCase()
        if (
          name.endsWith('.d.ts') ||
          name.endsWith('.d.ts.map') ||
          name.endsWith('.map') ||
          name.endsWith('.md') ||
          name.endsWith('.markdown') ||
          name === 'license' ||
          name === 'licence' ||
          name === 'changelog' ||
          name.startsWith('readme') ||
          IGNORED_EXTS.has(extname(name))
        ) {
          try {
            unlinkSync(fullPath)
          } catch {}
        }
      }
    }
  }

  scan(dir)
}
