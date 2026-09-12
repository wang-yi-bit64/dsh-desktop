#!/usr/bin/env node
/**
 * patch-layers.mjs — `patches/` 的**唯一分级事实源**。
 *
 * 背景：`patches/*.patch` 是 `patch-package` 的行级 diff，全部锁定在
 * `DSH_VERSION`（见 `prepare-harness.mjs`）。上游哪怕只改一个空行，补丁就会
 * 冲突。此前 `prepare-harness.mjs` 对补丁只有「全成 / 中断」两种结果，于是
 * 一次纯视觉补丁的冲突就能阻断整条打包链路。
 *
 * 本模块给每个补丁一个**失败策略**（layer），由 `prepare-harness.mjs` 消费：
 *
 * | layer | 含义 | 补丁失败时 |
 * |---|---|---|
 * | `brand` | 品牌资源 / 身份（图标、名称、品牌位） | 记 Warn 并继续；产物退回原生品牌 |
 * | `ui-behavior` | 视觉、文案与产品增强 | 记 Warn 并继续；该项增强缺失，应用仍可用 |
 * | `functional` | 缺失会让补丁体系或桌面插件加载失效（**启动相关**） | 立即中断构建（fail-fast） |
 *
 * `--strict`（`prepare-harness.mjs`）会让所有层都按 `functional` 处理。
 *
 * **默认层是 `ui-behavior`**：新增补丁若未登记，会被视为可降级并在报告中显式
 * 标为 `unclassified`，绝不静默当成 critical，也绝不静默放行而不报。
 *
 * 分类判据（逐个人工确认，2026-09-10）与退役条件见 `patches/LAYERS.md`。
 *
 * 用法：
 *   node scripts/patch-layers.mjs --self-test   # 无需 node_modules，校验分级表
 *   node scripts/patch-layers.mjs --list        # 打印当前分级
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 合法层名。 */
export const LAYERS = ['brand', 'ui-behavior', 'functional']

/** 未登记补丁的默认层（可降级 + 报告中标记）。 */
export const DEFAULT_LAYER = 'ui-behavior'

/** 必须 fail-fast 的层。 */
export const CRITICAL_LAYER = 'functional'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 补丁文件所在目录（绝对路径）。
 *
 * 导出而非各处自行拼接：`prepare-harness.mjs` 需要把**单个**补丁文件复制到临时
 * patch-dir，若两边各写一遍 `join(root, 'patches')`，改目录名时必然漏改一处。
 */
export const PATCHES_DIR = join(projectRoot, 'patches')
const patchesDir = PATCHES_DIR

/**
 * 分级表：补丁文件名 → `{ layer, why, retireWhen }`。
 *
 * 文件名必须是 `patches/` 下的真实文件名（用于 `--self-test` 检测漂移）。
 */
export const PATCH_LAYERS = {
  // ---- functional：缺失即无法加载桌面插件 / 启动不了 -------------------------
  '@deepseek-ai+dsh+0.1.5-rc.1.patch': {
    layer: 'functional',
    why: '把 dsh-desktop-client-ui / hmr-fallback / market-installer / preset-transfer 四个桌面插件包声明为 dsh 的依赖。缺失则 build/dsh-desktop.patch.yml 的 `insert: name` 解析不到包，profile 启动即失败。',
    retireWhen: '官方 dsh 提供声明式扩展点（无需改 package.json 即可挂载外部插件）时。'
  },
  '@deepseek-ai+cordis-plugin-loader+1.0.3.patch': {
    layer: 'functional',
    why: '插件 loader 的裸 specifier import 失败时回退到 createRequire 解析（基于 ctx.baseUrl）。桌面插件包位于 node_modules 而非相对路径，缺失则插件 import 失败。',
    retireWhen: '官方 loader 支持从 baseUrl 解析裸包名时。'
  },
  '@deepseek-ai+dsh-client-modules+0.1.5-rc.1.patch': {
    layer: 'functional',
    why: 'ClientModuleRegistry 解析 `${expectedPackageName}/package.json` 以定位插件模块。渲染侧插件装载的最后一段依赖，缺失则桌面 UI 插件挂不上。',
    retireWhen: '官方 registry 自带 createRequire 解析时。'
  },

  // ---- ui-behavior：视觉 / 文案 / 产品增强，缺失可用 -------------------------
  '@deepseek-ai+dsh-client-ui-layout+0.1.5-rc.1.patch': {
    layer: 'ui-behavior',
    why: '折叠侧栏宽度按平台区分（macOS 80 / 其他 56），纯几何。',
    retireWhen: '官方区分平台侧栏宽度时。'
  },
  '@deepseek-ai+dsh-client-ui-sidebar+0.1.5-rc.1.patch': {
    layer: 'ui-behavior',
    why: '侧栏 padding 与 data-dsh-sidebar-* 标记，纯样式。',
    retireWhen: '官方侧栏自带等效留白时。'
  },
  '@deepseek-ai+dsh-client-ui-workspace+0.1.5-rc.1.patch': {
    layer: 'ui-behavior',
    why: '工作区/会话行的样式、未读标记与搜索行渲染增强（会话永久删除 UI 已随 0.1.5-rc.1 升级移除，见 patches/LAYERS.md）。',
    retireWhen: '官方工作区列表补齐未读与会话行样式时。'
  },
  '@deepseek-ai+dsh-client-ui-settings-models+0.1.5-rc.1.patch': {
    layer: 'ui-behavior',
    why: '模型设置页的 Provider 选择器、模态切换与目录 UX（含内联 CSS 注入）。',
    retireWhen: '官方设置页提供 Provider 选择与模态切换时。'
  },
  '@deepseek-ai+dsh-client-ui-model-selection+0.1.5-rc.1.patch': {
    layer: 'ui-behavior',
    why: '模型选择弹层的搜索框与样式。',
    retireWhen: '官方模型选择器自带搜索时。'
  },
  '@deepseek-ai+dsh-client-ui-agent-preset+0.1.5-rc.1.patch': {
    layer: 'ui-behavior',
    why: '预设导入/导出与 Awesome Preset 浏览的文案与界面。',
    retireWhen: '官方提供预设包导入导出时（可同时撤掉 dsh-desktop-preset-transfer 插件）。'
  },
  '@deepseek-ai+dsh-client-ui-chat+0.1.5-rc.1.patch': {
    layer: 'ui-behavior',
    why: '会话内 QUOTA / FORBIDDEN 错误文案。缺失时退回原始错误文本。',
    retireWhen: '官方补齐这两种错误码的文案时。'
  },
  '@deepseek-ai+dsh-client-ui-trajectory+0.1.5-rc.1.patch': {
    layer: 'ui-behavior',
    why: '轨迹页 QUOTA / FORBIDDEN 错误文案。',
    retireWhen: '官方补齐这两种错误码的文案时。'
  },
  '@deepseek-ai+dsh-client-ui-deliverables+0.1.5-rc.1.patch': {
    layer: 'ui-behavior',
    why: '交付物中的 Codex 风格本地路径引用解析，以及 paths 为 null 时的空数组兜底（旧行为是直接不渲染）。',
    retireWhen: '官方支持本地路径引用解析时。'
  },
  '@deepseek-ai+dsh-llm-deepseek+0.1.5-rc.1.patch': {
    layer: 'ui-behavior',
    why: '把 HTTP 403 从 AUTH 拆成独立 FORBIDDEN 错误码。缺失时 403 显示为鉴权错误（文案不准，不影响运行）。',
    retireWhen: '官方错误码分类包含 FORBIDDEN 时。'
  },
  '@deepseek-ai+dsh-llm-pi-ai+0.1.5-rc.1.patch': {
    layer: 'ui-behavior',
    why: '同上：消息文本中的 403 归类为 FORBIDDEN。',
    retireWhen: '官方错误码分类包含 FORBIDDEN 时。'
  }
}

/**
 * 从补丁文件名推导 npm 包名。
 *
 * `patch-package` 的命名规则是 `name+version.patch`，作用域包用 `+` 代替 `/`：
 * `@deepseek-ai+dsh-client-ui-chat+0.1.5-rc.1.patch` → `@deepseek-ai/dsh-client-ui-chat`
 *
 * @param {string} file 补丁文件名（含或不含 `.patch` 后缀）。
 * @returns {string | null} 包名；无法解析（段数不足或版本段为空）时返回 `null`。
 */
export function packageNameFromPatchFile(file) {
  const base = file.replace(/\.patch$/, '')
  const parts = base.split('+')
  if (parts.length < 2) return null
  // 末段是版本号；其余段拼回包名（作用域包首段以 @ 开头）。
  const version = parts[parts.length - 1]
  if (version.length === 0) return null
  const nameParts = parts.slice(0, -1)
  if (nameParts.length === 0 || nameParts.some((part) => part.length === 0)) return null
  return nameParts.join('/')
}

/**
 * 查询补丁的失败策略。
 *
 * @param {string} file 补丁文件名。
 * @returns {{ layer: string, why: string, retireWhen: string | null, classified: boolean }}
 */
export function layerOf(file) {
  const entry = PATCH_LAYERS[file]
  if (entry === undefined) {
    return {
      layer: DEFAULT_LAYER,
      why: '未登记：按默认层处理，请在 patches/LAYERS.md 中补充分类。',
      retireWhen: null,
      classified: false
    }
  }
  return { ...entry, classified: true }
}

/** 列出 `patches/` 下的补丁文件名（目录不存在时返回空数组）。 */
export function listPatchFiles() {
  if (!existsSync(patchesDir)) return []
  return readdirSync(patchesDir)
    .filter((file) => file.endsWith('.patch'))
    .sort()
}

/**
 * 分级完整性检查（供 `--self-test` 与 CI 使用）。
 *
 * @returns {string[]} 问题列表；空数组表示分级表与目录一致。
 */
export function auditPatchLayers() {
  const problems = []
  const files = listPatchFiles()

  for (const file of files) {
    if (PATCH_LAYERS[file] === undefined) {
      problems.push(`未登记的补丁：${file}（会落到默认层 ${DEFAULT_LAYER}，请在 LAYERS.md 中分类）`)
    }
  }
  for (const file of Object.keys(PATCH_LAYERS)) {
    if (!files.includes(file)) {
      problems.push(`分级表引用了不存在的补丁：${file}`)
    }
  }
  for (const [file, entry] of Object.entries(PATCH_LAYERS)) {
    if (!LAYERS.includes(entry.layer)) {
      problems.push(`${file} 的 layer "${entry.layer}" 不在 ${LAYERS.join(' / ')} 之内`)
    }
    if (typeof entry.why !== 'string' || entry.why.length === 0) {
      problems.push(`${file} 缺少 why 说明`)
    }
    if (packageNameFromPatchFile(file) === null) {
      problems.push(`${file} 无法推导包名`)
    }
  }
  return problems
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--list')) {
    for (const file of listPatchFiles()) {
      const info = layerOf(file)
      const flag = info.classified ? ' ' : '*'
      console.log(`${flag} [${info.layer.padEnd(11)}] ${file}`)
    }
    console.log('\n* = 未登记（按默认层处理）')
    return
  }
  if (args.includes('--self-test')) {
    const problems = auditPatchLayers()
    if (problems.length > 0) {
      console.error('[patch-layers] 分级表与 patches/ 目录不一致：')
      for (const problem of problems) console.error(`  - ${problem}`)
      process.exitCode = 1
      return
    }
    console.log(`[patch-layers] OK：${listPatchFiles().length} 个补丁全部分级且包名可推导`)
    return
  }
  console.error('用法：node scripts/patch-layers.mjs [--self-test | --list]')
  process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main()
}
