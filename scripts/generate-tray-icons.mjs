#!/usr/bin/env node
/**
 * generate-tray-icons.mjs — 从品牌源图派生**系统托盘**图标（手工工具，产物入库）。
 *
 * ## 为什么单独生成，而不是复用 `app.default_window_icon()`
 *
 * 托盘图标与窗口图标的要求不同，直接复用会得到「能显示但难看」的图标：
 *
 * | 平台 | 复用 `default_window_icon()` 的实际结果 | 托盘要的是 |
 * |------|------------------------------------------|------------|
 * | Windows | 取 `icons/icon.ico` 的**第一个**条目（256×256），`CreateIcon` 造出超大 HICON 再被外壳缩到 16×16 | 32×32（缩到 16 不糊） |
 * | macOS | 32×32 彩色方块（非 template） | 单色 template（自动适配浅/深色菜单栏） |
 * | Linux | 32×32，勉强可用 | 同上，尺寸合适即可 |
 *
 * 本脚本因此生成两份资产（**产物入库，与 `generate-app-icons.mjs` 同一约定**）：
 *
 * | 产物 | 用途 | 来源 |
 * |------|------|------|
 * | `src-tauri/icons/tray-32.png` | Windows / Linux 托盘 | `build/app-icon.png` 的**圆角方块**，缩放并留 2px 透明边 |
 * | `src-tauri/icons/tray-template.png` | macOS 菜单栏（`icon_as_template(true)`） | 同一张源图的**字形**（按亮度提取成遮罩，RGB 置黑、alpha 取字形覆盖度） |
 *
 * macOS 之所以要单独提取：菜单栏 template 图只看 **alpha 通道**。若直接把方块图标
 * 当 template，屏幕上就是一个实心圆角方块（方块内部不透明），字形完全看不见；
 * 直接拿 `build/logo-*.png` 也不行——那两张是**带底色的横幅**，alpha 铺满整幅画面。
 *
 * ## 为什么自带 PNG 编解码
 *
 * 仓库里没有图像依赖（`scripts/generate-app-icons.mjs` 依赖 macOS 的 `sips`，
 * 只在本机能跑）。托盘图标需要在**任何**开发机上可再生成，而 Node 自带
 * `zlib`，实现「解 PNG → 面积平均缩放 → 重编码 PNG」不到 200 行，
 * 比引入 `sharp` / `pngjs` 这类依赖更划算（本仓库对运行时依赖面是有纪律的）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/generate-tray-icons.mjs            # 生成两份托盘资产
 * node scripts/generate-tray-icons.mjs --report    # 只打印源图/产物的尺寸与 alpha 包围盒
 * ```
 *
 * ⚠️ 刻意**无 npm 入口、不进 CI**（与 `generate-app-icons.mjs` 一致）：产物已入库，
 * 只有在品牌源图变化时才需要重跑。运行后请目视确认两份 PNG 的观感，再提交。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

/** 托盘图标尺寸（Windows/Linux）。 */
const TRAY_SIZE = 32
/** 方块在 32×32 里占的边长：留 2px 透明边，避免图标贴到面板边缘。 */
const TRAY_CONTENT = 28

/**
 * macOS template 画布与字形尺寸。
 *
 * `tray-icon` 在 macOS 上**固定把图标高度设为 18pt**、按比例算宽度
 * （`platform_impl/macos/mod.rs` 的 `set_icon_for_ns_status_item_button`），
 * 所以「图标看起来多大」完全由画布的宽高比决定：画布 72×48 → 18pt 高、27pt 宽，
 * 字形（40px 高）落在其中约 15pt 高。给 2x 像素是为了 Retina 清晰。
 */
const TEMPLATE_CANVAS = { width: 72, height: 48 }
const TEMPLATE_GLYPH_HEIGHT = 40

// ---------------------------------------------------------------------------
// PNG 解码 / 编码（仅覆盖本脚本需要的形态：非隔行、8/16bit、灰度/RGB/调色板/RGBA）
//
// 16bit 支持不是摆设：品牌源图 `build/app-icon.png` 正是 16bit/通道，
// 解不了它就得退回一张已经缩小过的中间产物当母版。
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 解码 PNG 为 RGBA8。
 * @param {Buffer} data 文件字节
 * @param {string} label 出错信息里显示的文件名
 * @returns {{width: number, height: number, rgba: Buffer}}
 */
function decodePng(data, label) {
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${label}: 不是 PNG`)
  let offset = 8
  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let palette = null
  let transparency = null
  const idat = []
  while (offset < data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('latin1', offset + 4, offset + 8)
    const body = data.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      depth = body[8]
      colorType = body[9]
      if (body[12] !== 0) throw new Error(`${label}: 不支持隔行 PNG`)
      if (depth !== 8 && depth !== 16) throw new Error(`${label}: 只支持 8/16bit 通道（实际 ${depth}）`)
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'PLTE') {
      palette = body
    } else if (type === 'tRNS') {
      transparency = body
    } else if (type === 'IEND') {
      break
    }
    offset += length + 12
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`${label}: 不支持的颜色类型 ${colorType}`)
  const bytesPerSample = depth / 8
  // 行滤波的「左像素」偏移按**字节**算（PNG 规范里的 bpp）。
  const bytesPerPixel = channels * bytesPerSample
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bytesPerPixel
  const filtered = Buffer.alloc(width * height * bytesPerPixel)
  let previous = Buffer.alloc(stride)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    const line = Buffer.from(raw.subarray(cursor, cursor + stride))
    cursor += stride
    if (filter === 1) {
      for (let i = bytesPerPixel; i < stride; i += 1) {
        line[i] = (line[i] + line[i - bytesPerPixel]) & 0xff
      }
    } else if (filter === 2) {
      for (let i = 0; i < stride; i += 1) line[i] = (line[i] + previous[i]) & 0xff
    } else if (filter === 3) {
      for (let i = 0; i < stride; i += 1) {
        const left = i >= bytesPerPixel ? line[i - bytesPerPixel] : 0
        line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xff
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i += 1) {
        const a = i >= bytesPerPixel ? line[i - bytesPerPixel] : 0
        const b = previous[i]
        const c = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        line[i] = (line[i] + predictor) & 0xff
      }
    } else if (filter !== 0) {
      throw new Error(`${label}: 未知行滤波 ${filter}`)
    }
    line.copy(filtered, y * stride)
    previous = line
  }

  // 16bit 取高位字节（这些图标最终会缩到 ≤128px，低位对结果没有可见影响）。
  const sample = (index) => filtered[index * bytesPerSample]

  const rgba = Buffer.alloc(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const out = pixel * 4
    if (colorType === 6) {
      rgba[out] = sample(pixel * 4)
      rgba[out + 1] = sample(pixel * 4 + 1)
      rgba[out + 2] = sample(pixel * 4 + 2)
      rgba[out + 3] = sample(pixel * 4 + 3)
    } else if (colorType === 2) {
      rgba[out] = sample(pixel * 3)
      rgba[out + 1] = sample(pixel * 3 + 1)
      rgba[out + 2] = sample(pixel * 3 + 2)
      rgba[out + 3] = 255
    } else if (colorType === 0) {
      const value = sample(pixel)
      rgba[out] = value
      rgba[out + 1] = value
      rgba[out + 2] = value
      rgba[out + 3] = 255
    } else if (colorType === 4) {
      const value = sample(pixel * 2)
      rgba[out] = value
      rgba[out + 1] = value
      rgba[out + 2] = value
      rgba[out + 3] = sample(pixel * 2 + 1)
    } else if (colorType === 3) {
      const index = filtered[pixel]
      rgba[out] = palette[index * 3]
      rgba[out + 1] = palette[index * 3 + 1]
      rgba[out + 2] = palette[index * 3 + 2]
      rgba[out + 3] = transparency && index < transparency.length ? transparency[index] : 255
    }
  }
  return { width, height, rgba }
}

/** CRC32（PNG 分块校验）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, body) {
  const out = Buffer.alloc(body.length + 12)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 'latin1')
  body.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
  return out
}

/**
 * 编码 RGBA8 为 PNG（行滤波一律 0：这些图很小，压不压缩无所谓，可读性优先）。
 * @param {number} width 宽
 * @param {number} height 高
 * @param {Buffer} rgba 像素
 * @returns {Buffer}
 */
function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------------------
// 图像操作
// ---------------------------------------------------------------------------

/**
 * alpha > 阈值的像素包围盒（含端点）。
 * @returns {{x0: number, y0: number, x1: number, y1: number, pixels: number}}
 */
function alphaBounds(image, threshold = 8) {
  let x0 = image.width
  let y0 = image.height
  let x1 = -1
  let y1 = -1
  let pixels = 0
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.rgba[(y * image.width + x) * 4 + 3] > threshold) {
        pixels += 1
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
      }
    }
  }
  return { x0, y0, x1, y1, pixels }
}

/**
 * 面积平均（box filter）缩放，**按预乘 alpha 采样**——否则透明像素的黑色
 * 会渗进边缘，形成一圈暗边（托盘图标画在面板上时非常明显）。
 * @param {{width:number,height:number,rgba:Buffer}} source 源图
 * @param {number} width 目标宽
 * @param {number} height 目标高
 * @returns {{width:number,height:number,rgba:Buffer}}
 */
function resizeArea(source, width, height) {
  const out = Buffer.alloc(width * height * 4)
  for (let dy = 0; dy < height; dy += 1) {
    const sy0 = (dy * source.height) / height
    const sy1 = ((dy + 1) * source.height) / height
    for (let dx = 0; dx < width; dx += 1) {
      const sx0 = (dx * source.width) / width
      const sx1 = ((dx + 1) * source.width) / width
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let area = 0
      for (let sy = Math.floor(sy0); sy < Math.min(source.height, Math.ceil(sy1)); sy += 1) {
        const fy = Math.min(sy + 1, sy1) - Math.max(sy, sy0)
        if (fy <= 0) continue
        for (let sx = Math.floor(sx0); sx < Math.min(source.width, Math.ceil(sx1)); sx += 1) {
          const fx = Math.min(sx + 1, sx1) - Math.max(sx, sx0)
          if (fx <= 0) continue
          const weight = fx * fy
          area += weight
          const index = (sy * source.width + sx) * 4
          const alpha = source.rgba[index + 3] / 255
          r += source.rgba[index] * alpha * weight
          g += source.rgba[index + 1] * alpha * weight
          b += source.rgba[index + 2] * alpha * weight
          a += alpha * weight
        }
      }
      const out_index = (dy * width + dx) * 4
      if (area <= 0 || a <= 0) continue
      out[out_index] = Math.round(r / a)
      out[out_index + 1] = Math.round(g / a)
      out[out_index + 2] = Math.round(b / a)
      out[out_index + 3] = Math.round((a / area) * 255)
    }
  }
  return { width, height, rgba: out }
}

/** 裁出一块子图。 */
function crop(image, x0, y0, width, height) {
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    image.rgba.copy(out, y * width * 4, ((y0 + y) * image.width + x0) * 4, ((y0 + y) * image.width + x0 + width) * 4)
  }
  return { width, height, rgba: out }
}

/** 把子图贴到透明画布中央（可指定落点）。 */
function pasteCentered(canvas, image, offsetX = null, offsetY = null) {
  const left = offsetX ?? Math.round((canvas.width - image.width) / 2)
  const top = offsetY ?? Math.round((canvas.height - image.height) / 2)
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const source = (y * image.width + x) * 4
      const target = ((top + y) * canvas.width + left + x) * 4
      if (target < 0 || target >= canvas.rgba.length) continue
      image.rgba.copy(canvas.rgba, target, source, source + 4)
    }
  }
  return canvas
}

/** 生成 macOS template：RGB 全黑、alpha 取源 alpha（菜单栏按 alpha 上色）。 */
function toTemplate(image) {
  const out = Buffer.from(image.rgba)
  for (let pixel = 0; pixel < out.length; pixel += 4) {
    out[pixel] = 0
    out[pixel + 1] = 0
    out[pixel + 2] = 0
  }
  return { width: image.width, height: image.height, rgba: out }
}

/**
 * 方块亮度阈值（0~255）。
 *
 * 方块底色约 #101014（亮度 ≈ 16），字形是白色描边，其中还夹着一层柔和阴影。
 * 低于该值的像素视为「底板」→ alpha 0；高于它的按比例映射，保留描边的抗锯齿过渡。
 */
const TEMPLATE_LUMA_FLOOR = 56

/**
 * 从方块图标里提取**字形遮罩**，作为 macOS template 的 alpha。
 *
 * 判据是亮度：底色接近黑，字形接近白。alpha 同时乘以源图自身的 alpha，
 * 于是圆角之外的透明区仍然是透明的。
 * @param {{width:number,height:number,rgba:Buffer}} image 方块图标（已裁到内容）
 * @returns {{width:number,height:number,rgba:Buffer}}
 */
function glyphMaskFromTile(image) {
  const out = Buffer.alloc(image.width * image.height * 4)
  const range = 255 - TEMPLATE_LUMA_FLOOR
  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    const index = pixel * 4
    const luma =
      0.2126 * image.rgba[index] + 0.7152 * image.rgba[index + 1] + 0.0722 * image.rgba[index + 2]
    const coverage = Math.max(0, Math.min(1, (luma - TEMPLATE_LUMA_FLOOR) / range))
    out[index] = 0
    out[index + 1] = 0
    out[index + 2] = 0
    out[index + 3] = Math.round(coverage * (image.rgba[index + 3] / 255) * 255)
  }
  return { width: image.width, height: image.height, rgba: out }
}

/** 空 RGBA 画布。 */
function blankCanvas(width, height) {
  return { width, height, rgba: Buffer.alloc(width * height * 4) }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const sources = {
  tile: join(projectRoot, 'build', 'app-icon.png')
}

function loadSource(path, label) {
  try {
    return decodePng(readFileSync(path), label)
  } catch (error) {
    throw new Error(`读取 ${label}（${path}）失败：${error.message}`)
  }
}

function generate({ report }) {
  const tile = loadSource(sources.tile, 'build/app-icon.png')
  const tileBounds = alphaBounds(tile)
  if (tileBounds.pixels === 0) throw new Error('build/app-icon.png 全透明——没有可用的图形')

  const lines = [
    `源图 app-icon.png：${tile.width}×${tile.height}，alpha 包围盒 ` +
      `(${tileBounds.x0},${tileBounds.y0})-(${tileBounds.x1},${tileBounds.y1})`
  ]

  // 1) Windows / Linux：方块缩到 28×28，居中放进 32×32（四周留 2px 透明边）。
  const tileCrop = crop(
    tile,
    tileBounds.x0,
    tileBounds.y0,
    tileBounds.x1 - tileBounds.x0 + 1,
    tileBounds.y1 - tileBounds.y0 + 1
  )
  const tray = pasteCentered(
    blankCanvas(TRAY_SIZE, TRAY_SIZE),
    resizeArea(tileCrop, TRAY_CONTENT, TRAY_CONTENT)
  )

  // 2) macOS template：同源图提字形遮罩，按高度 40px 缩放，落在 72×48 画布中央。
  const glyphMask = glyphMaskFromTile(tileCrop)
  const glyphBounds = alphaBounds(glyphMask)
  if (glyphBounds.pixels === 0) {
    throw new Error(
      `字形遮罩为空（亮度阈值 ${TEMPLATE_LUMA_FLOOR} 可能高于源图字形亮度）——` +
        `请核对 build/app-icon.png 是否仍是「深色方块 + 浅色字形」`
    )
  }
  const glyphCrop = crop(
    glyphMask,
    glyphBounds.x0,
    glyphBounds.y0,
    glyphBounds.x1 - glyphBounds.x0 + 1,
    glyphBounds.y1 - glyphBounds.y0 + 1
  )
  const glyphWidth = Math.round((TEMPLATE_GLYPH_HEIGHT * glyphCrop.width) / glyphCrop.height)
  const template = pasteCentered(
    blankCanvas(TEMPLATE_CANVAS.width, TEMPLATE_CANVAS.height),
    resizeArea(glyphCrop, glyphWidth, TEMPLATE_GLYPH_HEIGHT)
  )
  lines.push(
    `字形遮罩：源包围盒 (${glyphBounds.x0},${glyphBounds.y0})-(${glyphBounds.x1},${glyphBounds.y1})，` +
      `缩放到 ${glyphWidth}×${TEMPLATE_GLYPH_HEIGHT}`
  )

  const outputs = [
    { path: join(projectRoot, 'src-tauri', 'icons', 'tray-32.png'), image: tray, note: 'Windows / Linux' },
    {
      path: join(projectRoot, 'src-tauri', 'icons', 'tray-template.png'),
      image: template,
      note: 'macOS template（18pt 高 → 27pt 宽）'
    }
  ]

  if (report) {
    for (const line of lines) console.log(line)
    for (const output of outputs) {
      const bounds = alphaBounds(output.image)
      console.log(
        `${output.note} → ${output.path.slice(projectRoot.length + 1)}：` +
          `${output.image.width}×${output.image.height}，内容包围盒 ` +
          `(${bounds.x0},${bounds.y0})-(${bounds.x1},${bounds.y1})`
      )
    }
    return
  }

  for (const output of outputs) {
    writeFileSync(output.path, encodePng(output.image.width, output.image.height, output.image.rgba))
    console.log(
      `[tray-icons] ${output.note} → ${output.path.slice(projectRoot.length + 1)} ` +
        `(${output.image.width}×${output.image.height})`
    )
  }
  console.log('[tray-icons] 生成完毕；产物入库，请目视确认后提交')
}

generate({ report: argv.includes('--report') })
