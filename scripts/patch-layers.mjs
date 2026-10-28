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
 * ## 三个机器可读字段（`layer` / `why` / `retireWhen` + `regressionTest`）
 *
 * | 字段 | 谁读 | 判据 |
 * |---|---|---|
 * | `layer` | `prepare-harness.mjs` | 必须属于 {@link LAYERS} |
 * | `why` | 人 | 非空；写清「缺失会怎样」 |
 * | `retireWhen` | 人 + 本模块审计 | **非空**（V6 起由 `auditPatchLayers` 强制；此前只有散文纪律，**零门禁**） |
 * | `regressionTest` | 本模块审计 + `verify-patch-layers.mjs` | 固定格式，见下 |
 *
 * ### `regressionTest` 的两种合法形态（V6）
 *
 * 背景（`docs/dev-plan-external-assessment-response.md` §3 V6）：补丁改了**运行时行为**
 * 时，此前没有任何「移除补丁即红」的回归测试指向——一个在解冲突时被**改回上游写法**
 * 的补丁仍能通过组装与分级门禁，因为 applicable ≠ 语义还在。本字段把这件事变成
 * 可机器校验的一条。
 *
 * ```
 * regressionTest: 'scripts/<file>.mjs::<symbol>'   // 指向：路径必须存在，符号必须在该文件里可解
 * regressionTest: 'none: <理由>'                    // 无载体：显式声明 + 点名为什么 + 销账批次
 * ```
 *
 * **写成独立字段而不是塞进 `why` 末尾**（计划文档 §3 V6 动作 1 的原话是「写在 why 末尾」）：
 * `why` 是给人读的散文，往里嵌机器可解析的尾巴，等于把「扫出数为 0 时先怀疑扫描器」
 * 那条教训再犯一次——散文一改（换行、加句号）解析就静默归零。字段形态让「格式漂了」
 * 只能表现为**字段缺失/非法**，而那是判红。
 *
 * **`none:` 不是豁免后门**：它要求非空理由，且 `verify-patch-layers.mjs` 每次运行都
 * 把「无载体」清单打印出来（§7.1 规则 3：允许降级，但降级必须留痕）。`functional`
 * 层缺该字段**直接判红**——那一层的定义就是「缺失即起不来」，连一条回归指向都没有
 * 等于在替一个没人验过的 fail-fast 主张背书。
 *
 * 用法：
 *   node scripts/patch-layers.mjs --self-test [--dsh-target=<name>]  # 校验分级表
 *   node scripts/patch-layers.mjs --list [--dsh-target=<name>]       # 打印当前分级
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { argv, exit } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_TARGET, patchesDirFor, resolveDshTargetArg, resolveTarget } from './dsh-targets.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
    why: '把 dsh-desktop-client-ui / hmr-fallback / market-installer 三个桌面插件包声明为 dsh 的依赖（第四个 preset-transfer 已于 2026-09-30 整链退役）。缺失则 build/dsh-desktop.patch.yml 的 `insert: name` 解析不到包，profile 启动即失败。',
    retireWhen: '官方 dsh 提供声明式扩展点（无需改 package.json 即可挂载外部插件）时。',
    // 三面契约：本补丁的 `+` 依赖行 ↔ patch.yml 的 insert `name:` ↔ vendor/<name> 目录。
    // 删补丁 / 少一行 / patch.yml 加一行而补丁没跟 ⇒ 审计当场红（不需要上游代码，纯静态）。
    regressionTest: 'scripts/verify-patch-layers.mjs::checkDesktopDependencyDeclaration'
  },
  '@deepseek-ai/cordis-plugin-loader': {
    layer: 'functional',
    why: '插件 loader 的裸 specifier import 失败时回退到 createRequire 解析（基于 ctx.baseUrl）。桌面插件包位于 node_modules 而非相对路径，缺失则插件 import 失败。**2026-10-10（B4）同一补丁还修掉「入口被交成绝对 `file://` URL、且该文件并不存在」**：那是一条死路——`require.resolve` 不收 URL，URL 也从不走包解析，于是热挂载无声失败并回落重启（用户看到的是「点了插件没反应」）。补丁在解析前把失效的 `file://` URL 修成其 owning package 的裸名（按 `/node_modules/` 取**最内层**，覆盖作用域包与 pnpm 虚拟 store 形态），并留一条 warn 使这次替换可见。',
    retireWhen: '官方 loader 支持从 baseUrl 解析裸包名，**且**上游解析器不再把绝对入口 URL 交给 loader 时。',
    regressionTest:
      'none: 行为在 `EntryTree.import` 内部（需真实上游模块 + stub ctx 才能构造 `file://` 失效入口）；本机只有 gitignored 的 `harness-deps/`，CI 无组装树 ⇒ 离线没有诚实载体（B4 的夹具留在工作区外、未入仓）。销账批次：V6-B。'
  },
  '@deepseek-ai/dsh-client-modules': {
    layer: 'functional',
    why: 'ClientModuleRegistry 解析 `${expectedPackageName}/package.json` 以定位插件模块。渲染侧插件装载的最后一段依赖，缺失则桌面 UI 插件挂不上。',
    retireWhen: '官方 registry 自带 createRequire 解析时。',
    regressionTest:
      'none: 解析回退发生在 `ClientModuleRegistry` 的私有方法里，需真实上游类 + node_modules 布局；离线只能验「我们抄的那段副本」而不是落盘后的代码 ⇒ 那正是本仓反对的造假测试。销账批次：V6-B。'
  },
  '@deepseek-ai/dsh-typert-loader': {
    layer: 'functional',
    why: '上游把**启动路径**上「任一 contributor 注册失败」升级成 AggregateError 并在 `apply()` 尾部抛出，而 typert-loader 是 profile 里的一个 loader entry ⇒ 一个插件的 typert 声明有问题就让**整棵插件树**加载失败（`dsh: plugin tree failed to load`，实测三次启动中断，见 0.2.x 启动缺陷诊断 §3.1）。同一份代码在**动态路径**（后挂载的 entry）上却只 `logger.error` 不抛——启动路径缺的正是这个降级。补丁把启动路径的失败也降级为带 entry 名的 logged error（并保留 AggregateError 作为结构化载荷），使不兼容插件不再阻断启动。缺失该补丁 ⇒ 回到「一个坏插件 = 全树起不来」。',
    retireWhen: '官方把 contributor 注册失败降级为非致命（或按 entry 隔离、不再整树原子）时。',
    regressionTest:
      'none: 判据要真跑 `apply()`（依赖上游 loader/ctx 与 Cordis fiber 的时序）；B2 的桩 ctx 夹具在工作区外未入仓，本批不补造。销账批次：V6-B。'
  },
  '@deepseek-ai/dsh-client-file-upload': {
    layer: 'functional',
    why: '`registerAgentResolver` 在「已注册」时抛错，而 Cordis `Fiber._reload()` 是**先重跑 apply、后处置上一轮 effects** ⇒ 任何对该 entry 的重放（插件管理器 live-apply 热重放、热挂载 bundle 重列核心行）都会命中守卫，抛错让 session-controller 整个 fiber 回滚；回滚连带摘掉它注册的 `typert.lookups.configure("agent"/"session")` 与 `contexts.configureHost("agent")`，`LookupStore.get` 回落到声明解析器 ⇒ 冷会话切模式报 `lookup provider "agent" did not resolve the requested identity`（即「装完切不到其他模式」）。补丁把守卫改为**接管 + warn**（旧 disposer 的 `=== resolve` 比较保证它不会清掉新注册者）。缺失该补丁 ⇒ 首次启用的插件市场重放核心行即回滚。',
    retireWhen: '官方把该注册改为幂等（或 reload 前先处置旧注册）时。',
    regressionTest:
      'none: 接管语义依赖 `Fiber._reload()` 的重放时序（先重跑 apply、后处置旧 effects），需真实 Cordis fiber 才能构造；T2 的夹具未入仓 ⇒ 离线无诚实载体。销账批次：V6-B。'
  },

  // ---- ui-behavior：视觉 / 文案 / 产品增强，缺失可用 -------------------------
  // 📌 `@deepseek-ai/dsh-typert-registry`（2026-10-14 新增）与 B2 的两个补丁同源，
  //    但**刻意不归 functional**：LAYERS.md §4 规则 3 明定「functional 只收『缺失即起不来』」。
  //    本机真机 Cordis 夹具**未构造出可达路径**——同插件双挂载会先撞上 Cordis 自身的同名
  //    服务守卫（`service "sessionController" has been registered at <…>`），且首次 apply
  //    抛错后 `resolvers` 归空、无残留键 ⇒「缺失即起不来」不成立。判据与证据见 LAYERS.md
  //    的「typert lookup 守卫」节。真正可达的那条（apply 后段、无 Cordis 保护的
  //    `registerAgentResolver`）由同批的 `@deepseek-ai/dsh-client-file-upload` 负责。
  '@deepseek-ai/dsh-typert-registry': {
    layer: 'ui-behavior',
    why: 'lookup 族三处注册器在「键已在册」时同步抛错，抛点在 `ctx.effect(...)` **之前**（apply 期）：`LookupStore.configure`、`LookupStore.register`、`ContextStore.configureHost`。⚠️ **上游自 alpha `0.2.1-alpha.5` / next `0.2.1-rc.2` 起把 `lib/client.js` 拆成 `client.browser.js` / `client.node.js` / `index.js`**，同一段代码三份并存 ⇒ 两线补丁自本轮起**同时覆盖三个文件**（每份 6 处改动：3 处 throw→接管 + 3 处 disposer 注释订正），只改其中一份会让「浏览器 / Node / 汇总入口」三个消费者行为分裂。上游三处注释写「duplicate configuration is rejected, so this effect remains the key\'s unique owner」并配 `v8 ignore`——**该前提是错的**：键在册也可能是上一轮**尚未处置**的 effect，而非冲突；此时抛错会让 owner fiber 回滚。补丁照 B2 先例改为**接管 + warn**，并把错注释与 `v8 ignore` 一并订正为「该分支可达」。**只动 lookup 族这 3 个方法**：同文件另 6 处 `is already registered`（`validate` / Remote package `register` / `registerProvider` / `validatePackage` / `validateSchemas`）是**真冲突检测器**，接管会吞掉真错，不动；`register` 里那条「wire 声明不得中途改变」校验同样保留。旧 effect 的 disposer 本就有 entry 身份比较（`if (resolvers.get(key) !== entry) return`），说明作者本就预期多 owner 并存，故接管不会误删新 entry。**缺失该补丁的影响**：仅少一层纵深防御（该路径尚未被构造出可达），应用整体可用——这正是它不归 functional 的理由。',
    retireWhen: '官方把 lookup 族注册改为幂等（或 reload 前先处置旧 effect、不再假定「重复配置不可能」）时。'
  },
  // `dsh-client-ui-layout` 已于 2026-09-30 在 next 线退役（上游 0.2.0 的
  // computeColumns(…, collapsedWidth) + data-platform 推导覆盖了本补丁的全部意图；
  // alpha 线已于 2026-09-16 退役）——两线均无该补丁，分级表条目随之删除。
  '@deepseek-ai/dsh-client-ui-sidebar': {
    layer: 'ui-behavior',
    why: '侧栏 padding 与 data-dsh-sidebar-* 标记，纯样式。',
    retireWhen: '官方侧栏自带等效留白时。'
  },
  // `dsh-client-ui-workspace` 已于 2026-09-30 双线退役（上游 0.2.0/0.1.7 线原生
  // completionUnread + SessionStatusDots/StateDot 未读指示与完整会话行样式，
  // retireWhen 满足）；「手动标记未读」如需恢复须在新行结构上另立批次。
  // `dsh-client-ui-agent-preset` 已于 2026-09-30 双线退役（上游重写为卡片式
  // 预设管理 UI，旧菜单/对话框锚点整体消失——「上游重构使补丁前提失效」）；**整条预设
  // 传递链路同轮退役**：插件 dsh-desktop-preset-transfer 依赖的
  // `@deepseek-ai/dsh-agent-presets`（roots/scanRoot 文件模型）被上游重命名并重铸为
  // `@deepseek-ai/dsh-agent-preset` + agentPresets 注册模型，四个导入符号整体消失，
  // 插件无法移植；vendor 源码已删、dsh 补丁的依赖声明与 patch.yml 的 insert 行同步移除。
  // 恢复前提：上游重新暴露文件系统预设根，或有新 UI 消费方重建导入/导出。
  // ⚠️ `dsh-client-ui-settings-models` 已于 2026-10-18 **双线退役**（alpha 随锚点
  // 0.2.1-alpha.5、next 随锚点 0.2.1-rc.2）：上游自 0.2.1-alpha.4 起原生提供
  // 「自定义模型 API 的每模型推理等级」（`reasoningLevels` prop、`ModelReasoningEfforts`
  // 组件、`modelReasoning*` 中英文案，含「API 参数值 / Off 语义 / 空值校验」），能力
  // 严格强于本补丁的 `advancedExtra` 插槽 + 逗号分隔字符串 ⇒ retireWhen 成立，属
  // 「上游追上我们」而非能力回退（与 2026-10-07 退役 `model-selection` 同类型）。
  // 补丁文件已删、本表条目同步移除；两线均无补丁引用它，故不能再留条目。
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
    why: '交付物中的 Codex 风格本地路径引用解析，以及 paths 为 null 时的空数组兜底（旧行为是直接不渲染）。⚠️ 兜底只在 `matches.size === 0`（确实未命中）时生效：`size > 1` 是歧义引用，必须保持惰性，否则 `index.js` 这类 token 会被解析成同名相对路径并打开错误目标——alpha 线自始带此守卫，next 线 2026-10-18 迁移时一度丢失，已补回。',
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
 * @returns {{ layer: string, why: string, retireWhen: string | null, regressionTest?: string, classified: boolean }}
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
 * `regressionTest` 两种合法形态的分隔符 / 前缀（见模块文档）。
 */
export const POINTER_SEPARATOR = '::'
export const NONE_PREFIX = 'none:'

/** `none:` 理由的最小长度：短于此等于没写。 */
export const MIN_REGRESSION_REASON_LENGTH = 10

/**
 * 解析 `regressionTest` 字段值。
 *
 * 只认两种形态；**其余一律 invalid**（而不是回退成 absent）——「写错格式」与
 * 「没写」必须分开报：前者是 `functional` 层漏填的伪装形态。
 *
 * @param {unknown} value 字段原值
 * @returns {{kind:'absent'}|{kind:'none', reason:string}|{kind:'pointer', path:string, symbol:string}|{kind:'invalid', raw:string}}
 */
export function parseRegressionTest(value) {
  if (value === undefined || value === null) return { kind: 'absent' }
  const raw = String(value).trim()
  if (raw === '') return { kind: 'absent' }
  if (raw.startsWith(NONE_PREFIX)) {
    return { kind: 'none', reason: raw.slice(NONE_PREFIX.length).trim() }
  }
  const at = raw.indexOf(POINTER_SEPARATOR)
  if (at > 0) {
    const path = raw.slice(0, at).trim()
    const symbol = raw.slice(at + POINTER_SEPARATOR.length).trim()
    if (path !== '' && symbol !== '') return { kind: 'pointer', path, symbol }
  }
  return { kind: 'invalid', raw }
}

/**
 * 判断某个符号是否在源码文本里**可解**（声明形态：`[export] function|const|let|var|class <符号>`）。
 *
 * 只认声明而不是「文件里出现过这个字符串」——后者会让 `// 见 foo()` 这类注释
 * 把一条失效指向判成可解（同 `verify-gates.mjs` M3 的教训：注释里的 `--self-test`
 * 不算自检模式）。
 *
 * @param {string} text 文件内容
 * @param {string} symbol 符号名
 * @returns {boolean}
 */
export function hasSymbol(text, symbol) {
  const escaped = String(symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `(?:^|[^\\w$.])(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|const|let|var|class)\\s+${escaped}\\b`,
    'm'
  ).test(String(text ?? ''))
}

/**
 * 校验一条登记项的 `regressionTest`。
 *
 * 纯函数（文件内容由 `readText` 注入），便于自检用夹具覆盖四种形态。
 *
 * @param {{ layer: string, regressionTest?: string }} entry 登记项
 * @param {(relPath: string) => string | null} readText 按仓库相对路径读文本；读不到返回 null
 * @param {string} [label] 报错前缀（通常是补丁文件名）
 * @returns {string[]} 问题清单
 */
export function checkRegressionTest(entry, readText, label = '') {
  const problems = []
  const where = label === '' ? '' : `${label}：`
  const parsed = parseRegressionTest(entry?.regressionTest)

  if (parsed.kind === 'invalid') {
    problems.push(
      `${where}regressionTest 格式非法（只认 \`scripts/x.mjs::symbol\` 或 \`none: <理由>\`）：${parsed.raw}`
    )
    return problems
  }
  if (parsed.kind === 'absent') {
    if (entry?.layer === CRITICAL_LAYER) {
      problems.push(
        `${where}functional 层补丁缺 regressionTest —— 这一层的定义是「缺失即起不来」，` +
          '没有一条「移除补丁即红」的指向等于替一个没人验过的主张背书（写 `路径::符号` 或 `none: <理由 + 销账批次>`）'
      )
    }
    return problems
  }
  if (parsed.kind === 'none') {
    if (parsed.reason.length < MIN_REGRESSION_REASON_LENGTH) {
      problems.push(
        `${where}regressionTest 的 none 理由太短（<${MIN_REGRESSION_REASON_LENGTH} 字）：` +
          '必须点名「为什么没有离线载体」与销账批次，否则它与「忘了填」同形'
      )
    }
    return problems
  }
  const text = readText(parsed.path)
  if (text === null) {
    problems.push(`${where}回归测试指向的路径不存在：${parsed.path}（指向失效 = 这条判据其实没跑）`)
    return problems
  }
  if (!hasSymbol(text, parsed.symbol)) {
    problems.push(
      `${where}回归测试指向的符号 \`${parsed.symbol}\` 在 ${parsed.path} 里找不到（改名后必须同步指向）`
    )
  }
  return problems
}

/** 默认的文件读取器：仓库相对路径 → 文本；读不到返回 null。 */
function readRepoText(relPath) {
  try {
    return readFileSync(resolve(projectRoot, relPath), 'utf8')
  } catch {
    return null
  }
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
 * **退役复核 / 回归指向的扫描入口**：为每个补丁文件产出一行（**不过滤**）。
 *
 * 为什么单独成函数：`verify-patch-layers.mjs` 要断言「扫出的行数 == 补丁文件数」
 * （AGENTS §7.3 E5-空）。若把过滤（例如只留 `functional`）写在调用点，计数断言就
 * 看不出「被过滤掉的那部分」——本仓踩过的正是这一形态（`verify-harness-entry` 在
 * **零个受检模块**下全绿）。所以「枚举全部补丁」这件事只有这一个产地。
 *
 * @param {string} [target] 目标名。
 * @returns {{file:string, pkg:string|null, layer:string, classified:boolean, retireWhen:string|null, regressionTest:string|undefined}[]}
 */
export function retirementRows(target = DEFAULT_TARGET) {
  return listPatchFiles(target).map((file) => {
    const pkg = packageNameFromPatchFile(file)
    const entry = pkg === null ? undefined : PATCH_LAYERS[pkg]
    return {
      file,
      pkg,
      layer: entry?.layer ?? DEFAULT_LAYER,
      classified: entry !== undefined,
      retireWhen: typeof entry?.retireWhen === 'string' ? entry.retireWhen : null,
      regressionTest: entry?.regressionTest
    }
  })
}

/**
 * 分级完整性检查（供 `--self-test` 与 CI 使用）。
 *
 * 除「目录 ↔ 登记表」一致外，还校验：
 * · 补丁文件名里的版本段与该目标的 `dshVersion` 一致——DSH 家族的包必须跟目标版本走，
 *   落下一个旧版本串会被 `overrides` 钉到错误的版本上（`prepare-harness.mjs` 靠文件名推导 override）；
 * · **`retireWhen` 非空**（V6 补的缺口：此前只有散文纪律与 LAYERS.md 的列，**零门禁**——
 *   计划文档 §3 V6 的「⚠️ 更正」段称「`auditPatchLayers` 强制非空」，那是**错的**，
 *   本函数此前只校验 `why`）；
 * · **`regressionTest` 可解**（见 {@link checkRegressionTest}）。
 *
 * @param {string} [target] 目标名。
 * @param {(relPath: string) => string | null} [readText] 文件读取器（自检注入夹具）
 * @returns {string[]} 问题列表；空数组表示一致。
 */
export function auditPatchLayers(target = DEFAULT_TARGET, readText = readRepoText) {
  const problems = []
  const files = listPatchFiles(target)
  const targetB = resolveTarget(target)

  if (files.length === 0) {
    problems.push(`目标 ${target} 下没有任何补丁（${patchesDirFor(target)}）`)
  }

  // 行数与文件数必须相等：`retirementRows` 是「枚举全部补丁」的唯一产地，
  // 一旦它开始过滤，这条断言会把「少扫了一部分」当场变红。
  const rows = retirementRows(target)
  if (rows.length !== files.length) {
    problems.push(
      `退役复核扫描出 ${rows.length} 行，但目录里有 ${files.length} 个补丁——扫描端被过滤了（E5-空：少扫不得冒充通过）`
    )
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
    if (typeof entry.retireWhen !== 'string' || entry.retireWhen.trim().length === 0) {
      problems.push(
        `${file} 缺少 retireWhen 退役条件——「什么时候能删」没有判据的补丁只增不减；` +
          '写清「上游做到什么时退役」，并由上游变更触发复核'
      )
    }
    problems.push(...checkRegressionTest(entry, readText, file))
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

/**
 * `regressionTest` 判据的自检夹具（纯内存，不读仓库）。
 *
 * 每条判据都配正反例——尤其 `hasSymbol` 那条：**注释里出现符号名不算可解**，
 * 否则一条指向失效的回归测试会因为注释里还留着旧名字而继续判绿。
 *
 * @returns {string[]} 失败项；空数组表示自检通过
 */
export function selfTestRegressionTest() {
  const failures = []
  let checks = 0
  const check = (label, actual, expected) => {
    checks += 1
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
    }
  }
  const readText = (relPath) =>
    relPath === 'scripts/target.mjs' ? 'export function realCase() {}\n// checkOther() 只在注释里\n' : null

  check('解析：none 形态', parseRegressionTest('none: 需要真上游模块，另立 V6-B').kind, 'none')
  check('解析：pointer 形态', parseRegressionTest('scripts/target.mjs::realCase').symbol, 'realCase')
  check('解析：空值 ⇒ absent', parseRegressionTest('').kind, 'absent')
  check('解析：undefined ⇒ absent', parseRegressionTest(undefined).kind, 'absent')
  check('解析：缺符号 ⇒ invalid（不回落成 absent）', parseRegressionTest('scripts/target.mjs').kind, 'invalid')
  check('解析：缺路径 ⇒ invalid', parseRegressionTest('::realCase').kind, 'invalid')

  check('符号：声明形态可解', hasSymbol('export function realCase() {}', 'realCase'), true)
  check('符号：const 箭头函数可解', hasSymbol('const realCase = () => {}', 'realCase'), true)
  check('符号：只在注释里出现 ⇒ 不可解', hasSymbol('// realCase()\nexport const other = 1', 'realCase'), false)
  check('符号：前缀相同的标识符不算', hasSymbol('function realCaseExtra() {}', 'realCase'), false)

  const functional = { layer: CRITICAL_LAYER }
  const downgradable = { layer: 'ui-behavior' }
  check('functional 缺字段 ⇒ 判红', checkRegressionTest(functional, readText).length, 1)
  check('ui-behavior 缺字段 ⇒ 放行', checkRegressionTest(downgradable, readText).length, 0)
  check(
    '指向不存在的路径 ⇒ 判红',
    checkRegressionTest({ ...functional, regressionTest: 'scripts/nope.mjs::x' }, readText).length,
    1
  )
  check(
    '指向不存在的符号 ⇒ 判红',
    checkRegressionTest({ ...functional, regressionTest: 'scripts/target.mjs::missing' }, readText).length,
    1
  )
  check(
    '指向注释里的符号 ⇒ 判红（可解 = 有声明，不是「出现过」）',
    checkRegressionTest({ ...functional, regressionTest: 'scripts/target.mjs::checkOther' }, readText).length,
    1
  )
  check(
    '指向可解的符号 ⇒ 放行',
    checkRegressionTest({ ...functional, regressionTest: 'scripts/target.mjs::realCase' }, readText),
    []
  )
  check('none 理由太短 ⇒ 判红', checkRegressionTest({ ...functional, regressionTest: 'none: 缺' }, readText).length, 1)
  check(
    'none 理由充分 ⇒ 放行',
    checkRegressionTest({ ...functional, regressionTest: 'none: 需要真上游模块，另立 V6-B' }, readText),
    []
  )
  check(
    '格式非法 ⇒ 判红（写错格式不得伪装成 absent）',
    checkRegressionTest({ ...functional, regressionTest: 'scripts/target.mjs' }, readText).length,
    1
  )

  if (failures.length === 0) console.log(`[patch-layers] regressionTest 判据自检：${checks} 项通过`)
  return failures
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
      const reg = parseRegressionTest(info.regressionTest)
      const regLabel =
        reg.kind === 'pointer'
          ? `  ↳ 回归指向 ${reg.path}::${reg.symbol}`
          : reg.kind === 'none'
            ? '  ↳ 回归载体：无（none: 见理由）'
            : ''
      console.log(`${flag} [${info.layer.padEnd(11)}] ${file}${regLabel}`)
    }
    console.log('\n* = 未登记（按默认层处理）')
    return
  }
  if (args.includes('--self-test')) {
    // 先验**判定函数本身**，再验真实目录——顺序与 `gates.mjs` 一致：
    // 判据坏了必须能被看见，否则「真实目录通过」可能只是一条恒绿的空转断言。
    const fixtureProblems = selfTestRegressionTest()
    if (fixtureProblems.length > 0) {
      console.error('[patch-layers] regressionTest 判据自检失败：')
      for (const problem of fixtureProblems) console.error(`  - ${problem}`)
      process.exitCode = 1
      return
    }
    const problems = auditPatchLayers(target)
    if (problems.length > 0) {
      console.error(`[patch-layers] 目标 ${target}：分级表与 patches/ 目录不一致：`)
      for (const problem of problems) console.error(`  - ${problem}`)
      process.exitCode = 1
      return
    }
    const rows = retirementRows(target)
    const pointers = rows.filter((row) => parseRegressionTest(row.regressionTest).kind === 'pointer').length
    const carriers = rows.filter((row) => parseRegressionTest(row.regressionTest).kind === 'none').length
    const functional = rows.filter((row) => row.layer === CRITICAL_LAYER).length
    console.log(
      `[patch-layers] OK：目标 ${target} 的 ${rows.length} 个补丁全部分级、包名可推导、` +
        `retireWhen 非空；functional ${functional} 个中 回归指向 ${pointers} / 显式无载体 ${carriers}`
    )
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
