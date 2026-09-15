#!/usr/bin/env node
/**
 * patch-layers.mjs — `patches/<target>/` 的**唯一分级事实源**。
 *
 * 背景：`patches/<target>/*.patch` 是 `patch-package` 的行级 diff，锁定在各自的
 * `DSH_VERSION`（见 `scripts/dsh-targets.mjs`）。上游哪怕只改一个空行，补丁就会
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
 * ## 登记表按**包名**索引，不按文件名
 *
 * 双通道（`next` / `alpha`）各有自己的一套补丁文件，同一个包在两个目标下的补丁
 * **做的是同一件事**，只是行号与上下文随上游版本变化。因此分级表以包名为键：
 * 新增一个目标**不需要**动本文件——否则每加一条上游线就要复制一遍全部 `why` 文案，
 * 而那份复制迟早会与原件漂移（本仓的 `why` 是给人读的判据，不是装饰）。
 *
 * 文件名到包名的推导见 {@link packageNameFromPatchFile}。
 *
 * **默认层是 `ui-behavior`**：新增补丁若未登记，会被视为可降级并在报告中显式
 * 标为 `unclassified`，绝不静默当成 critical，也绝不静默放行而不报。
 *
 * 分类判据（逐个人工确认，2026-09-10；alpha 线复核 2026-09-15）与退役条件见
 * `patches/LAYERS.md`。
 *
 * 用法：
 *   node scripts/patch-layers.mjs --self-test [--dsh-target=<name>]  # 校验分级表
 *   node scripts/patch-layers.mjs --list [--dsh-target=<name>]       # 打印当前分级
 */

import { existsSync, readdirSync } from 'node:fs'
import { argv, exit } from 'node:process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_TARGET, patchesDirFor, resolveDshTargetArg, resolveTarget } from './dsh-targets.mjs'

/** 合法层名。 */
export const LAYERS = ['brand', 'ui-behavior', 'functional']

/** 未登记补丁的默认层（可降级 + 报告中标记）。 */
export const DEFAULT_LAYER = 'ui-behavior'

/** 必须 fail-fast 的层。 */
export const CRITICAL_LAYER = 'functional'

/**
 * 分级表：**npm 包名** → `{ layer, why, retireWhen }`。
 *
 * 键是包名而非文件名：同一补丁在两个上游目标下是同一件事（见模块文档）。
 * `--self-test` 会检查「每个目标目录下的补丁都能查到」与「表里没有多余条目」。
 */
export const PATCH_LAYERS = {
  // ---- functional：缺失即无法加载桌面插件 / 启动不了 -------------------------
  '@deepseek-ai/dsh': {
    layer: 'functional',
    why: '把 dsh-desktop-client-ui / hmr-fallback / market-installer / preset-transfer 四个桌面插件包声明为 dsh 的依赖。缺失则 build/dsh-desktop.patch.yml 的 `insert: name` 解析不到包，profile 启动即失败。',
    retireWhen: '官方 dsh 提供声明式扩展点（无需改 package.json 即可挂载外部插件）时。'
  },
  '@deepseek-ai/cordis-plugin-loader': {
    layer: 'functional',
    why: '插件 loader 的裸 specifier import 失败时回退到 createRequire 解析（基于 ctx.baseUrl）。桌面插件包位于 node_modules 而非相对路径，缺失则插件 import 失败。',
    retireWhen: '官方 loader 支持从 baseUrl 解析裸包名时。'
  },
  '@deepseek-ai/dsh-client-modules': {
    layer: 'functional',
    why: 'ClientModuleRegistry 解析 `${expectedPackageName}/package.json` 以定位插件模块。渲染侧插件装载的最后一段依赖，缺失则桌面 UI 插件挂不上。',
    retireWhen: '官方 registry 自带 createRequire 解析时。'
  },

  // ---- ui-behavior：视觉 / 文案 / 产品增强，缺失可用 -------------------------
  '@deepseek-ai/dsh-client-ui-layout': {
    layer: 'ui-behavior',
    why: '折叠侧栏宽度按平台区分（macOS 80 / 其他 56），纯几何。',
    retireWhen: '官方区分平台侧栏宽度时。'
  },
  '@deepseek-ai/dsh-client-ui-sidebar': {
    layer: 'ui-behavior',
    why: '侧栏 padding 与 data-dsh-sidebar-* 标记，纯样式。',
    retireWhen: '官方侧栏自带等效留白时。'
  },
  '@deepseek-ai/dsh-client-ui-workspace': {
    layer: 'ui-behavior',
    why: '工作区/会话行的样式、未读标记与搜索行渲染增强（会话永久删除 UI 已随 0.1.5-rc.1 升级移除；「在 Finder 中打开」菜单项在 0.1.6-alpha.1 线未再移植，理由见 patches/LAYERS.md）。',
    retireWhen: '官方工作区列表补齐未读与会话行样式时。'
  },
  '@deepseek-ai/dsh-client-ui-settings-models': {
    layer: 'ui-behavior',
    why: '模型设置页的 Provider 选择器、模态切换与目录 UX（含内联 CSS 注入）。',
    retireWhen: '官方设置页提供 Provider 选择与模态切换时。'
  },
  '@deepseek-ai/dsh-client-ui-model-selection': {
    layer: 'ui-behavior',
    why: '模型选择弹层的搜索框与样式。',
    retireWhen: '官方模型选择器自带搜索时。'
  },
  '@deepseek-ai/dsh-client-ui-agent-preset': {
    layer: 'ui-behavior',
    why: '预设导入/导出与 Awesome Preset 浏览的文案与界面。',
    retireWhen: '官方提供预设包导入导出时（可同时撤掉 dsh-desktop-preset-transfer 插件）。'
  },
  '@deepseek-ai/dsh-client-ui-chat': {
    layer: 'ui-behavior',
    why: '会话内 QUOTA / FORBIDDEN 错误文案。缺失时退回原始错误文本。',
    retireWhen: '官方补齐这两种错误码的文案时。'
  },
  '@deepseek-ai/dsh-client-ui-trajectory': {
    layer: 'ui-behavior',
    why: '轨迹页 QUOTA / FORBIDDEN 错误文案。',
    retireWhen: '官方补齐这两种错误码的文案时。'
  },
  '@deepseek-ai/dsh-client-ui-deliverables': {
    layer: 'ui-behavior',
    why: '交付物中的 Codex 风格本地路径引用解析，以及 paths 为 null 时的空数组兜底（旧行为是直接不渲染）。',
    retireWhen: '官方支持本地路径引用解析时。'
  },
  '@deepseek-ai/dsh-llm-deepseek': {
    layer: 'ui-behavior',
    why: '把 HTTP 403 从 AUTH 拆成独立 FORBIDDEN 错误码。缺失时 403 显示为鉴权错误（文案不准，不影响运行）。',
    retireWhen: '官方错误码分类包含 FORBIDDEN 时。'
  },
  '@deepseek-ai/dsh-llm-pi-ai': {
    layer: 'ui-behavior',
    why: '同上：消息文本中的 403 归类为 FORBIDDEN。',
    retireWhen: '官方错误码分类包含 FORBIDDEN 时。'
  }
}

/** 当前默认目标名（供不带 `--dsh-target` 的调用方沿用旧行为）。 */
export const DEFAULT_PATCHES_TARGET = DEFAULT_TARGET

/**
 * 从补丁文件名推导 npm 包名。
 *
 * `patch-package` 的命名规则是 `name+version.patch`，作用域包用 `+` 代替 `/`：
 * `@deepseek-ai+dsh-client-ui-chat+0.1.5-rc.2.patch` → `@deepseek-ai/dsh-client-ui-chat`
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
 * 从补丁文件名提取其锁定的包版本（文件名末段）。
 *
 * @param {string} file 补丁文件名。
 * @returns {string|null} 版本串；无法解析时为 `null`。
 */
export function versionFromPatchFile(file) {
  const parts = file.replace(/\.patch$/, '').split('+')
  return parts.length < 2 ? null : parts[parts.length - 1] || null
}

/**
 * 查询补丁的失败策略（按包名登记，与上游目标无关）。
 *
 * @param {string} file 补丁文件名。
 * @returns {{ layer: string, why: string, retireWhen: string | null, classified: boolean }}
 */
export function layerOf(file) {
  const pkg = packageNameFromPatchFile(file)
  const entry = pkg === null ? undefined : PATCH_LAYERS[pkg]
  if (entry === undefined) {
    return {
      layer: DEFAULT_LAYER,
      why: `未登记（包 ${pkg ?? '(无法推导)'}）：按默认层处理，请在 patches/LAYERS.md 中补充分类。`,
      retireWhen: null,
      classified: false
    }
  }
  return { ...entry, classified: true }
}

/**
 * 列出某个目标下 `patches/<target>/` 的补丁文件名（目录不存在时返回空数组）。
 *
 * @param {string} [target] 目标名（默认 {@link DEFAULT_TARGET}）。
 * @returns {string[]} 排序后的文件名。
 */
export function listPatchFiles(target = DEFAULT_TARGET) {
  const dir = patchesDirFor(resolveTarget(target).name)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.patch'))
    .sort()
}

/**
 * 分级完整性检查（供 `--self-test` 与 CI 使用）。
 *
 * 除「目录 ↔ 登记表」一致外，还校验补丁文件名里的版本段与该目标的
 * `dshVersion` 一致——DSH 家族的包必须跟目标版本走，落下一个旧版本串会被
 * `overrides` 钉到错误的版本上（`prepare-harness.mjs` 靠文件名推导 override）。
 *
 * @param {string} [target] 目标名。
 * @returns {string[]} 问题列表；空数组表示一致。
 */
export function auditPatchLayers(target = DEFAULT_TARGET) {
  const problems = []
  const files = listPatchFiles(target)
  const targetB = resolveTarget(target)

  if (files.length === 0) {
    problems.push(`目标 ${target} 下没有任何补丁（${patchesDirFor(target)}）`)
  }

  for (const file of files) {
    const pkg = packageNameFromPatchFile(file)
    if (pkg === null) {
      problems.push(`${file}：无法推导包名`)
      continue
    }
    const entry = PATCH_LAYERS[pkg]
    if (entry === undefined) {
      problems.push(`未登记的补丁：${file}（包 ${pkg}；会落到默认层 ${DEFAULT_LAYER}，请在 LAYERS.md 中分类）`)
      continue
    }
    if (!LAYERS.includes(entry.layer)) {
      problems.push(`${file} 的 layer "${entry.layer}" 不在 ${LAYERS.join(' / ')} 之内`)
    }
    if (typeof entry.why !== 'string' || entry.why.length === 0) {
      problems.push(`${file} 缺少 why 说明`)
    }
    // DSH 家族的包版本必须等于目标版本；独立版本号的包（cordis-plugin-loader）跳过。
    const version = versionFromPatchFile(file)
    if (version !== null && version.includes('-') && /^\d+\.\d+\.\d+-/.test(version) && version !== targetB.dshVersion) {
      const isDshFamily = pkg.startsWith('@deepseek-ai/dsh')
      if (isDshFamily) {
        problems.push(
          `${file}：文件名版本段 ${version} 与目标 ${target} 的 DSH ${targetB.dshVersion} 不一致` +
            `（重命名或同步 dsh-targets.mjs）`
        )
      }
    }
  }
  return problems
}

function main() {
  const args = argv.slice(2)
  let target
  try {
    target = resolveDshTargetArg(args)
  } catch (error) {
    console.error(`[patch-layers] ${error.message}`)
    exit(2)
  }

  if (args.includes('--list')) {
    console.log(`目标 ${target}（DSH ${resolveTarget(target).dshVersion}）：`)
    for (const file of listPatchFiles(target)) {
      const info = layerOf(file)
      const flag = info.classified ? ' ' : '*'
      console.log(`${flag} [${info.layer.padEnd(11)}] ${file}`)
    }
    console.log('\n* = 未登记（按默认层处理）')
    return
  }
  if (args.includes('--self-test')) {
    const problems = auditPatchLayers(target)
    if (problems.length > 0) {
      console.error(`[patch-layers] 目标 ${target}：分级表与 patches/ 目录不一致：`)
      for (const problem of problems) console.error(`  - ${problem}`)
      process.exitCode = 1
      return
    }
    console.log(`[patch-layers] OK：目标 ${target} 的 ${listPatchFiles(target).length} 个补丁全部分级且包名可推导`)
    return
  }
  console.error('用法：node scripts/patch-layers.mjs [--self-test | --list] [--dsh-target=<name>]')
  process.exitCode = 1
}

const isDirectRun = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(argv[1] ?? '')
  } catch {
    return false
  }
})()

if (isDirectRun) main()
