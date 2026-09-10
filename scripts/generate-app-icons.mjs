#!/usr/bin/env node
/**
 * generate-app-icons.mjs — 从 `build/app-icon.png` 生成 `build/icon.icns` 与
 * `build/icon.ico`。
 *
 * ## 这是 macOS 手工工具，**刻意没有自动化入口**
 *
 * * 依赖 macOS 自带的 `sips` 与 `iconutil`，在 Windows / Linux 上必然失败；
 * * 输入是**不常变的品牌源图**（`build/app-icon.png`），产物是入库的静态资产，
 *   没有「每次构建都该重算」的必要。
 *
 * 一个只在 macOS 上有意义、且产物本已入库的脚本，如果接进 `prepare:harness`
 * 或 CI，只会让另外两个平台的流水线多一个必然跳过或必然报错的门禁——那是噪声，
 * 不是守护。因此这里明确标注它的定位，而不是给它硬塞一个入口。
 *
 * 产物去向（注意区分，容易混淆）：
 *
 * | 产物 | 位置 | 是否入库 | 说明 |
 * |------|------|---------|------|
 * | 本脚本产出的 icns | `build/icon.icns` | ❌ 未入库 | macOS 图标源 |
 * | 本脚本产出的 ico | `build/icon.ico` | ✅ 已入库 | Windows 图标源 |
 * | 打包实际消费的图标 | `src-tauri/icons/*` | ✅ 已入库 | 见 `tauri.conf.json` → `bundle.icon` |
 *
 * 用法（仅 macOS）：
 *   node scripts/generate-app-icons.mjs
 * 随后按需把结果同步到 `src-tauri/icons/` 并提交。
 */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDirectory = path.join(projectRoot, 'build')
const source = path.join(buildDirectory, 'app-icon.png')
const iconsetDirectory = path.join(buildDirectory, 'app-icon.iconset')
const icnsDestination = path.join(buildDirectory, 'icon.icns')
const icoDestination = path.join(buildDirectory, 'icon.ico')

await rm(iconsetDirectory, { recursive: true, force: true })
await mkdir(iconsetDirectory, { recursive: true })

for (const size of [16, 32, 128, 256, 512]) {
  execFileSync('sips', [
    '-z',
    String(size),
    String(size),
    source,
    '--out',
    path.join(iconsetDirectory, `icon_${size}x${size}.png`)
  ])
  execFileSync('sips', [
    '-z',
    String(size * 2),
    String(size * 2),
    source,
    '--out',
    path.join(iconsetDirectory, `icon_${size}x${size}@2x.png`)
  ])
}

execFileSync('iconutil', ['-c', 'icns', iconsetDirectory, '-o', icnsDestination])

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icoDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-icons-'))
const icoImages = []
for (const size of icoSizes) {
  const destination = path.join(icoDirectory, `icon-${size}.png`)
  execFileSync('sips', [
    '-z',
    String(size),
    String(size),
    source,
    '--out',
    destination
  ])
  icoImages.push(await readFile(destination))
}
const header = Buffer.alloc(6 + icoImages.length * 16)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(icoImages.length, 4)

let offset = header.length
for (let index = 0; index < icoImages.length; index += 1) {
  const size = icoSizes[index]
  const entry = 6 + index * 16
  header.writeUInt8(size === 256 ? 0 : size, entry)
  header.writeUInt8(size === 256 ? 0 : size, entry + 1)
  header.writeUInt8(0, entry + 2)
  header.writeUInt8(0, entry + 3)
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(icoImages[index].length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += icoImages[index].length
}

await writeFile(icoDestination, Buffer.concat([header, ...icoImages]))
await rm(icoDirectory, { recursive: true, force: true })

const icon = await readFile(source)
console.log(`Generated app icons from ${path.relative(projectRoot, source)} (${icon.length} bytes PNG).`)
