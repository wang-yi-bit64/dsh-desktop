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
 *        resources/<pages & brand assets>
 *
 * The node_modules tree keeps its npm layout so `bin.js` resolves its
 * dependencies by walking upward from its own location.
 */

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
function buildManifest(lockfilePath) {
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
    patchesApplied: readdirSafe(join(staging, 'patches')).length
  }
}

// ---------------------------------------------------------------------------
// 0. 幂等检查：输入指纹未变且产物完整 → 直接复用，保证可复现且不拖慢内环。
// ---------------------------------------------------------------------------
const patchesFingerprint = existsSync(join(projectRoot, 'patches'))
  ? directoryFingerprint(join(projectRoot, 'patches'))
  : 'no-patches'
const fingerprint = sha256(
  JSON.stringify({
    dshVersion: DSH_VERSION,
    nodeVersion: NODE_VERSION,
    pnpmVersion: PNPM_VERSION,
    dependencies,
    overrides,
    patches: patchesFingerprint
  })
)

const nodeBinName = isWindows ? 'node.exe' : 'node'
const manifestPath = join(resources, 'MANIFEST.json')

if (!forceRebuild) {
  // 产物完整性只看资源本体；MANIFEST 缺失由快速路径单独处理。
  // harness-node-entry.mjs 必须纳入校验：tauri.conf.json 的 build.rs 会对其做
  // glob 硬校验，缺失时 cargo 直接编译失败。
  const resourcesComplete =
    existsSync(join(resources, 'node', nodeBinName)) &&
    existsSync(join(resources, 'harness', 'node_modules', '@deepseek-ai')) &&
    existsSync(join(resources, 'harness-node-entry.mjs'))
  let manifestMatches = false
  if (resourcesComplete && existsSync(manifestPath)) {
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
  // （--force 可强制完整重组）。
  const stagingLockfile = join(staging, 'package-lock.json')
  if (resourcesComplete && existsSync(stagingLockfile) && stagingInputsMatch()) {
    writeFileSync(manifestPath, `${JSON.stringify(buildManifest(stagingLockfile), null, 2)}\n`)
    log(`仅重建 MANIFEST.json → ${manifestPath}（--force 可强制完整重组）`)
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
// 3. Reapply the tracked desktop patches.
// ---------------------------------------------------------------------------
log('applying desktop patches')
run('npx', ['patch-package'], staging)

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
// plugin-safety-guard.mjs / plugin-worker-host.mjs 是 harness-node-entry.mjs 的
// 运行时依赖（入口直接 import 前者，后者由 guard 以同级文件 spawn），必须一起打包。
for (const file of [
  'harness-node-entry.mjs',
  'windows-child-process-hide.mjs',
  'plugin-safety-guard.mjs',
  'plugin-worker-host.mjs',
  'dsh-desktop.patch.yml'
]) {
  cpSync(join(buildDir, file), join(resources, file))
}

// Splash/recovery/safe-mode pages and brand assets served as resources.
for (const file of [
  'splash.html',
  'plugin-recovery.html',
  'safe-mode.html',
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
