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
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const staging = join(projectRoot, 'harness-deps')
const resources = join(projectRoot, 'src-tauri', 'resources')
const buildDir = join(projectRoot, 'build')
const vendorDir = join(projectRoot, 'vendor')

const DSH_VERSION = '0.1.2-alpha.4'
const NODE_VERSION = '24.9.0'
const PNPM_VERSION = '10.34.5'

const isWindows = process.platform === 'win32'

function log(message) {
  console.log(`[prepare-harness] ${message}`)
}

function run(command, args, cwd) {
  log(`$ ${command} ${args.join(' ')} (in ${cwd})`)
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: isWindows })
}

// ---------------------------------------------------------------------------
// 1. Stage the install directory.
// ---------------------------------------------------------------------------
log('staging install directory')
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

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
const nodeBinName = isWindows ? 'node.exe' : 'node'
const stagedNodeBin = join(staging, 'node_modules', 'node', 'bin', nodeBinName)
if (!existsSync(stagedNodeBin)) {
  throw new Error(`Bundled Node.js binary not found at ${stagedNodeBin}`)
}
mkdirSync(join(resources, 'node'), { recursive: true })
cpSync(stagedNodeBin, join(resources, 'node', nodeBinName))

// Full dependency tree, minus the node runtime package itself (its binary is
// already extracted above and the package is hundreds of MB of duplicates).
const harnessTree = join(resources, 'harness', 'node_modules')
mkdirSync(harnessTree, { recursive: true })
const stagedModules = join(staging, 'node_modules')
for (const entry of readdirSafe(stagedModules)) {
  if (entry === 'node' || entry === '.bin' || entry === '.package-lock.json') continue
  cpSync(join(stagedModules, entry), join(harnessTree, entry), { recursive: true })
}

// Wrapper entry, hide patch, and patch layer.
cpSync(join(buildDir, 'harness-node-entry.mjs'), join(resources, 'harness-node-entry.mjs'))
cpSync(
  join(buildDir, 'windows-child-process-hide.mjs'),
  join(resources, 'windows-child-process-hide.mjs')
)
cpSync(join(buildDir, 'dsh-desktop.patch.yml'), join(resources, 'dsh-desktop.patch.yml'))

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

log('done')

function readdirSafe(directory) {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}
