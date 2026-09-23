#!/usr/bin/env node
/**
 * harness-lockfile.mjs — 内置 Harness 依赖树的**提交式 lockfile**纯逻辑层。
 *
 * ## 为什么要把 lockfile 提交进仓库（2026-09-23 的真实事故）
 *
 * `prepare-harness` 的 `npm install` 要靠 arborist **在线解析**这棵 600+ 包的依赖树。
 * 上游 `@deepseek-ai/dsh` 的子包用 `^0.1.5-rc.2` 这类**浮动范围**互相引用，上游一发布
 * 新预发布版本（rc.3），未钉死的子包就整体漂走，形成混血树——解析堆占用从 ~2GB 涨到
 * **>4GB 且 30 分钟不收敛**（smoke `35814756095` / `35824813835` 三平台全灭于
 * `FATAL ERROR: Ineffective mark-compacts near heap limit`）。给子进程抬堆只能续命，
 * 根治办法是**跳过解析**：把解析结果（package-lock.json）按目标提交进
 * `harness-locks/<target>/`，组装时用 `npm ci` 照单安装——零解析、零漂移、可复现。
 *
 * 分工：本模块只放**纯逻辑**（路径推导、输入一致性校验、家族钉死推导），必须能独立
 * 跑断言；I/O 与 npm 调用留在 `prepare-harness.mjs`。
 *
 * ## inputs.json —— lockfile 的「输入快照」
 *
 * npm 的 lockfile **不记录 overrides**（根节点只有 name/dependencies），所以
 * 「这份 lockfile 是用哪些 overrides 生成的」无法从 lockfile 本身读出。生成时把最终的
 * `dependencies` + `overrides` 快照存进同目录 `inputs.json`，组装时逐一比对：
 * dependencies 或任一 override 变了（典型：DSH 版本升级、补丁增删）就判定失配，
 * CI 上**硬失败**并提示重新生成——绝不允许拿旧 lockfile 静默装出一棵与输入不符的树。
 *
 * ## 家族钉死（family pins）
 *
 * 上游主包 `@deepseek-ai/dsh@X` 的 dependencies 里有几十个同版本发布的 `@deepseek-ai/dsh-*`
 * 子包。**生成** lockfile 时必须把它们全部钉到 X（否则解析不收敛，实测 >1h 无解）；
 * **组装**（npm ci）时不解析、本不需要钉，但 staging 的 package.json 必须与生成时的
 * 输入**逐字节一致**（inputs.json 校验），所以从 inputs.json 里把「补丁/vendored 解释不了的
 * 多余条目」推导出来补回去。多余的条目若撞上当前某个补丁包名，说明补丁被删过而 lockfile
 * 没重新生成——判失配（见 `lockInputsMatch` 规则 3）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/harness-lockfile.mjs --self-test   # 纯逻辑自检（不联网不读盘）
 * ```
 *
 * 退出码：`0` 自检通过 · `1` 自检失败。
 */

import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import { argv, exit } from 'node:process'

/**
 * 目标名 → 提交式 lockfile 目录（`harness-locks/<target>/`）。
 *
 * @param {string} projectRoot 仓库根绝对路径。
 * @param {string} target DSH 目标名（`next` / `alpha`）。
 * @returns {string} 目录绝对路径。
 */
export function harnessLockDirFor(projectRoot, target) {
  return joinPaths(projectRoot, 'harness-locks', target)
}

/**
 * 目标名 → 提交式 lockfile 文件路径。
 *
 * @param {string} projectRoot 仓库根绝对路径。
 * @param {string} target DSH 目标名。
 * @returns {string} `harness-locks/<target>/package-lock.json` 绝对路径。
 */
export function harnessLockPathFor(projectRoot, target) {
  return joinPaths(harnessLockDirFor(projectRoot, target), 'package-lock.json')
}

/**
 * 目标名 → lockfile 输入快照路径（`harness-locks/<target>/inputs.json`）。
 *
 * @param {string} projectRoot 仓库根绝对路径。
 * @param {string} target DSH 目标名。
 * @returns {string} inputs.json 绝对路径。
 */
export function harnessLockInputsPathFor(projectRoot, target) {
  return joinPaths(harnessLockDirFor(projectRoot, target), 'inputs.json')
}

/** 与 `node:path` 解耦的极简 join（模块保持纯逻辑，便于在任意宿主上断言）。 */
function joinPaths(...parts) {
  return parts.join('/').replace(/\/{2,}/g, '/')
}

/**
 * 规范化 JSON：键按字典序深排，消除键序差异带来的假阳性比对。
 *
 * @param {unknown} value 任意可 JSON 序列化的值。
 * @returns {string} 键序稳定的 JSON 字符串。
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * 从 inputs 快照的 overrides 里推导「家族钉死」：补丁与 vendored tgz 解释不了的
 * 多余条目（生成时由 registry 家族名单注入）。
 *
 * @param {Record<string, string>} storedOverrides inputs.json 里记录的完整 overrides。
 * @param {Record<string, string>} currentBaseOverrides 当前输入推导出的基础 overrides
 *   （补丁文件名 + vendored tgz 文件名）。
 * @returns {Record<string, string>} 家族钉死条目（可能为空对象）。
 */
export function deriveFamilyPins(storedOverrides, currentBaseOverrides) {
  const pins = {}
  for (const [name, spec] of Object.entries(storedOverrides ?? {})) {
    if (!(name in (currentBaseOverrides ?? {}))) {
      pins[name] = spec
    }
  }
  return pins
}

/**
 * 校验提交的 inputs 快照与当前组装输入是否一致。
 *
 * 规则：
 *   1. `dependencies` 必须逐键一致（DSH 版本 / node / pnpm / vendor `file:` 路径）；
 *   2. 当前基础 overrides 的**每一条**都必须在快照里出现且值相同——快照里多出来的
 *      条目按家族钉死处理（`deriveFamilyPins`），少一条或值不同即失配；
 *   3. 快照里多出来的条目**不得**撞上当前任何补丁/vendored 包名——撞上说明对应补丁
 *      或 vendored 包被删除后没有重新生成 lockfile，那条「钉死」是陈旧残留。
 *
 * @param {object} stored inputs.json 的解析结果（`{ dependencies, overrides }`）。
 * @param {object} current 当前输入。
 * @param {Record<string, string>} current.dependencies 组装将写入 staging 的 dependencies。
 * @param {Record<string, string>} current.overrides 当前基础 overrides（补丁 + vendored）。
 * @param {string[]} current.pinnedPackageNames 当前补丁 + vendored 推导出的**全部**包名
 *   （用于规则 3 的陈旧残留检测）。
 * @returns {{ ok: boolean, reasons: string[] }} `ok` 为 false 时 `reasons` 逐条说明。
 */
export function lockInputsMatch(stored, { dependencies, overrides, pinnedPackageNames }) {
  const reasons = []
  const storedDeps = stored?.dependencies ?? null
  if (canonicalJson(storedDeps) !== canonicalJson(dependencies ?? null)) {
    reasons.push(
      `dependencies 不一致：\n    lockfile 生成时：${canonicalJson(storedDeps)}\n    当前输入：      ${canonicalJson(dependencies)}`
    )
  }
  const storedOverrides = stored?.overrides ?? {}
  for (const [name, spec] of Object.entries(overrides ?? {})) {
    if (!(name in storedOverrides)) {
      reasons.push(`override ${name}=${spec} 在 lockfile 输入快照中不存在（lockfile 先于该输入生成）`)
    } else if (storedOverrides[name] !== spec) {
      reasons.push(
        `override ${name} 值不一致：lockfile 生成时 ${storedOverrides[name]}，当前 ${spec}`
      )
    }
  }
  const pinned = new Set(pinnedPackageNames ?? [])
  for (const name of Object.keys(deriveFamilyPins(storedOverrides, overrides))) {
    if (pinned.has(name)) {
      reasons.push(
        `家族钉死条目 ${name} 撞上当前补丁/vendored 包名——该输入被删除后 lockfile 未重新生成`
      )
    }
  }
  return { ok: reasons.length === 0, reasons }
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------
export function selfTest() {
  const failures = []
  let passed = 0
  const eq = (label, got, want) => {
    passed += 1
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`${label}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
    }
  }

  // --- 路径推导：不依赖平台 path 模块，斜杠统一 ---
  eq('lock 目录', harnessLockDirFor('/repo', 'next'), '/repo/harness-locks/next')
  eq('lock 文件', harnessLockPathFor('/repo', 'alpha'), '/repo/harness-locks/alpha/package-lock.json')
  eq('inputs 文件', harnessLockInputsPathFor('/repo', 'next'), '/repo/harness-locks/next/inputs.json')

  // --- canonicalJson：键序不影响比对 ---
  eq('canonical：键序无关', canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
  eq('canonical：嵌套键序无关', canonicalJson({ x: { d: 1, c: 2 } }), canonicalJson({ x: { c: 2, d: 1 } }))
  eq('canonical：数组保序（顺序是语义）', canonicalJson([1, 2]), '[1,2]')
  eq('canonical：数组乱序不相等', canonicalJson([1, 2]) === canonicalJson([2, 1]), false)

  // --- deriveFamilyPins：补丁/vendored 解释不了的条目才是家族钉死 ---
  const stored = {
    '@deepseek-ai/dsh-client-ui-chat': '0.1.5-rc.2', // 补丁解释（也在 base 里）
    '@deepseek-ai/dsh-base': '0.1.5-rc.2' // 家族钉死（不在 base 里）
  }
  const base = { '@deepseek-ai/dsh-client-ui-chat': '0.1.5-rc.2' }
  eq('家族钉死推导', deriveFamilyPins(stored, base), { '@deepseek-ai/dsh-base': '0.1.5-rc.2' })
  eq('空快照 → 空钉死', deriveFamilyPins({}, base), {})
  eq('null 快照 → 空钉死', deriveFamilyPins(null, base), {})

  // --- lockInputsMatch：三条规则 ---
  const deps = { '@deepseek-ai/dsh': '0.1.5-rc.2', node: '24.9.0' }
  const storedInputs = {
    dependencies: { ...deps, dshmarket: 'file:../../vendor/dshmarket' },
    overrides: { '@deepseek-ai/dsh-client-ui-chat': '0.1.5-rc.2', '@deepseek-ai/dsh-base': '0.1.5-rc.2' }
  }
  const current = {
    dependencies: { ...deps, dshmarket: 'file:../../vendor/dshmarket' },
    overrides: { '@deepseek-ai/dsh-client-ui-chat': '0.1.5-rc.2' },
    pinnedPackageNames: ['@deepseek-ai/dsh-client-ui-chat']
  }
  eq('规则全过 → ok', lockInputsMatch(storedInputs, current).ok, true)

  eq(
    '规则1：dependencies 变更 → 失配',
    lockInputsMatch(storedInputs, { ...current, dependencies: { ...deps } }).ok,
    false
  )
  const rule2 = lockInputsMatch(storedInputs, {
    ...current,
    overrides: { '@deepseek-ai/dsh-client-ui-chat': '0.1.5-rc.3' }
  })
  eq('规则2：override 值变更 → 失配', rule2.ok, false)
  eq('规则2 失配说明点名包', rule2.reasons.join(' ').includes('dsh-client-ui-chat'), true)
  const rule2b = lockInputsMatch(storedInputs, { ...current, overrides: {} })
  eq('规则2：新增 override 未进快照 → 失配', rule2b.ok, false)

  const rule3 = lockInputsMatch(storedInputs, {
    ...current,
    pinnedPackageNames: ['@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-base']
  })
  eq('规则3：家族钉死撞补丁名（补丁被删未重生成）→ 失配', rule3.ok, false)
  eq('规则3 失配说明点名包', rule3.reasons.join(' ').includes('dsh-base'), true)

  // 可证伪性：规则 3 的包名名单**不含**家族钉死名时必须放行——
  // 否则任何一次正常命中都会被误判（对称失效的教训见 AGENTS.md WebView2 一节）。
  eq('规则3：名单不含钉死名 → 放行', lockInputsMatch(storedInputs, current).ok, true)

  if (failures.length > 0) {
    throw new Error(`harness-lockfile 自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`)
  }
  return { passed }
}

function main() {
  const args = argv.slice(2)
  if (args.includes('--self-test')) {
    try {
      const { passed } = selfTest()
      console.log(`✅ harness-lockfile 自测通过（${passed} 项）`)
      exit(0)
    } catch (error) {
      console.error(error.message)
      exit(1)
    }
  }
  console.error('用法：node scripts/harness-lockfile.mjs --self-test')
  exit(2)
}

const isDirectRun = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolvePath(argv[1] ?? '')
  } catch {
    return false
  }
})()

if (isDirectRun) main()
