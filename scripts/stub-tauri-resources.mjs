#!/usr/bin/env node
// Stub src-tauri/resources/ for CI jobs that must COMPILE src-tauri (cargo
// test/clippy --workspace) but must NOT assemble the 300MB Harness runtime.
//
// tauri-build copies every `bundle.resources` glob into the target dir during
// build.rs, and fails when any glob matches nothing. `src-tauri/resources/` is
// gitignored because it normally holds the full assembled runtime produced by
// `prepare:harness` (bundled node + harness/node_modules). In a clean CI
// checkout none of it exists, so compiling src-tauri fails.
//
// This script mirrors ONLY the git-tracked static assets from build/ (splash /
// recovery / safe-mode pages, brand gifs, wrapper entries, patch layer) plus
// empty node/ and harness/node_modules/ dirs and a stub MANIFEST.json — enough
// for tauri-build's resource globs to resolve and the crate to compile. It is
// intentionally NOT the real runtime; `prepare:harness` still produces that for
// bundling (CI build job) and for real `npm run dev/build` runs.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
const resources = join(root, 'src-tauri', 'resources')

rmSync(resources, { recursive: true, force: true })
mkdirSync(join(resources, 'node'), { recursive: true })
mkdirSync(join(resources, 'bin'), { recursive: true })
mkdirSync(join(resources, 'harness', 'node_modules'), { recursive: true })

// tauri-build resolves each bundle.resources glob and fails when a glob
// matches nothing; empty dirs are ignored by glob, so drop a placeholder file
// in each of the runtime dirs (node/, bin/, harness/node_modules/) that would
// otherwise stay empty in a compile-only stub.
writeFileSync(join(resources, 'node', '.gitkeep'), '')
writeFileSync(join(resources, 'bin', '.gitkeep'), '')
writeFileSync(join(resources, 'harness', 'node_modules', '.gitkeep'), '')

// Git-tracked static assets (see git ls-files build/). prepare:harness copies
// exactly these from build/ into resources/ for bundling; mirror the same set.
const assets = [
  'harness-node-entry.mjs',
  'windows-child-process-hide.mjs',
  'plugin-safety-guard.mjs',
  'plugin-worker-host.mjs',
  'dsh-desktop.patch.yml',
  'dsh-desktop-safe.patch.yml',
  'splash.html',
  'plugin-recovery.html',
  'safe-mode.html',
  'windows-menu.html',
  'dsh-loader.gif',
  'dsh-loader-dark.gif',
  'app-icon.png',
  'logo-light.png',
  'logo-dark.png',
]
for (const file of assets) {
  const source = join(buildDir, file)
  if (existsSync(source)) cpSync(source, join(resources, file))
}

// tauri-build only checks glob match; a stub manifest is enough to compile.
writeFileSync(
  join(resources, 'MANIFEST.json'),
  JSON.stringify({ assembledAt: 'ci-stub', lockfileHash: 'ci-stub', pinned: {} }, null, 2) + '\n',
)
