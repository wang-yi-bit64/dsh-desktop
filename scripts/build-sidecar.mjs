#!/usr/bin/env node
// Helper / documentation script for building DSH Node Single Executable Application (SEA) / Sidecar.
//
// Workflow:
// 1. Bundle DSH code & entry into a single cjs bundle: dist/dsh-bundle.cjs
// 2. Prepare sea-config.json:
//    {
//      "main": "dist/dsh-bundle.cjs",
//      "output": "dist/sea-prep.blob"
//    }
// 3. Generate sea blob:
//    node --experimental-sea-config sea-config.json
// 4. Inject blob into standalone node binary (using postject):
//    cp $(node -e "console.log(process.execPath)") src-tauri/resources/bin/dsh-sidecar.exe
//    npx postject src-tauri/resources/bin/dsh-sidecar.exe NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const binDir = join(root, 'src-tauri', 'resources', 'bin')

if (!existsSync(binDir)) {
  mkdirSync(binDir, { recursive: true })
}

console.log('[build-sidecar] DSH Sidecar layout initialized at:', binDir)
