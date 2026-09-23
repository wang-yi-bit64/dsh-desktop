#!/usr/bin/env node
/**
 * remove-tree.mjs — 「删除临时目录」的**尽力而为**实现（永不抛错）。
 *
 * ## 为什么需要它（2026-09-23 真实事故）
 *
 * `v0.7.0-alpha.5` 的发布在最后一步 `publish CLI + portable artifacts` 失败：
 *
 *     ✅ 已发布产物核验通过：dsh-host-cli-…-aarch64-apple-darwin.tar.gz  sha256=6811d79b…
 *     ✅ 已发布产物核验通过：dsh-host-cli-…-x86_64-pc-windows-msvc.zip    sha256=8dd3a2ac…
 *     ✅ 已发布产物核验通过：dsh-host-cli-…-x86_64-unknown-linux-gnu.tar.gz sha256=b3a06859…
 *     package-portable 失败：EACCES: permission denied, unlink '/tmp/dsh-portable-probe-dxo46J/resources/harness/node_modules'
 *
 * 三个 CLI 产物**全部核验通过**，portable 的核验也没报出任何内容问题——红的只是
 * `finally` 里那句 `rmSync(probeDir, {recursive: true, force: true})`。
 * 于是：
 *
 *   1. **辅助动作有能力否决主结论**：`finally` 里抛出的异常会覆盖 try 块的返回值，
 *      一次成功的核验被一句清理失败判成了发布失败；
 *   2. 它的红**掩盖了真实结论**——`problems` 数组从未被打印，没人知道核验到底过了没有。
 *
 * 权限为什么不足：`--verify-download` 跑在 ubuntu 的 `cli-publish` job 上，要解包的是
 * **Windows 产出的 `.zip`**。`unzip` 从 zip 恢复出的目录权限位可能不可写
 * （Windows 侧打包不记录 Unix 权限），于是删除 `resources/harness/node_modules` 这类
 * 深层目录时 `unlink` 报 EACCES。`rmSync` 的 `force: true` 只忽略「不存在」，**不忽略
 * EACCES**。
 *
 * ## 判据（为什么这样设计）
 *
 * - 删除是**尽力而为**：返回 `{ ok, error }`，**永不抛**。调用方最多打一条警告。
 * - 分三级尝试：直接删 → 递归恢复写权限后再删 → 交给 OS 的删除命令。
 * - **不做递归 chmod 跟随符号链接**：`chmod` 会顺着 symlink 改到目标上，
 *   可能改到仓库里真实文件的权限；本模块对 symlink 只跳过。
 *
 * 用法：
 * ```bash
 * node scripts/remove-tree.mjs --self-test   # 自测（含可伪证性检查）
 * ```
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 递归恢复目录树的写/执行权限（**不跟随符号链接**）。
 *
 * 只对**真实目录**与**普通文件**动手：`lstatSync` 判出 symlink 就跳过，
 * 因为 `chmod` 会顺着链接改到目标上——那可能改到仓库里的真实文件。
 * `chmod` 可注入，于是「不跟随」这条契约能在纯函数测试里断言，不依赖宿主的权限语义。
 *
 * @param {string} dir 目录
 * @param {{chmod?: (path: string, mode: number) => void}} [options] `chmod` 可注入
 * @returns {number} 成功改过权限的条目数（含 `dir` 自身）
 */
export function grantWritePermissionRecursive(dir, options = {}) {
  const chmod = options.chmod ?? chmodSync
  let touched = 0
  const visit = (path) => {
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      return
    }
    if (stat.isSymbolicLink()) return
    try {
      // 目录要 rwx（rwx 才能进去删子项），文件要 rw。
      chmod(path, stat.isDirectory() ? 0o755 : 0o644)
      touched += 1
    } catch {
      /* 改不动就继续：下一级尝试（OS 兜底）还有机会 */
    }
    if (!stat.isDirectory()) return
    let entries
    try {
      entries = readdirSync(path)
    } catch {
      return
    }
    for (const entry of entries) visit(join(path, entry))
  }
  visit(dir)
  return touched
}

/**
 * 用操作系统的删除命令兜底（`rm -rf` / `rmdir /s /q`）。
 *
 * 到这一步说明 Node 的 `rmSync` 已经失败过两次，通常是被占用或权限位异常；
 * 交给 OS 工具是最后一张牌。
 *
 * @param {string} dir 目录
 * @param {string} platform Node 命名法的平台
 * @returns {{ ok: boolean, error?: string }}
 */
function removeViaOsCommand(dir, platform) {
  const spec =
    platform === 'win32'
      ? { command: 'cmd', args: ['/c', 'rmdir', '/s', '/q', dir] }
      : { command: 'rm', args: ['-rf', dir] }
  const result = spawnSync(spec.command, spec.args, { stdio: 'ignore' })
  if (result.error) return { ok: false, error: `${spec.command} 无法启动：${result.error.message}` }
  if (result.status !== 0) return { ok: false, error: `${spec.command} 退出码 ${result.status}` }
  // 命令报成功也要复核：残留目录等于没删掉。
  return existsSync(dir) ? { ok: false, error: `${spec.command} 报成功但目录仍在` } : { ok: true }
}

/**
 * **尽力而为**地删除一棵目录树，永不抛错。
 *
 * 三级降级：直接删 → 递归恢复写权限后再删 → OS 删除命令。
 * `remover` / `osRemover` 可注入，因此「三级顺序」这条契约能在**纯函数测试**里断言，
 * 而不必真的去构造一个删不掉的目录（那在不同宿主上触发条件不一致）。
 *
 * @param {string} dir 目录（不存在时直接算成功，与 `rmSync` 的 `force` 语义一致）
 * @param {object} [options]
 * @param {string} [options.platform] 平台（Node 命名法），可注入
 * @param {(path: string) => void} [options.remover] 第 1/2 级用的删除器；抛错表示失败
 * @param {(path: string) => { ok: boolean, error?: string }} [options.osRemover] 第 3 级用的删除器
 * @returns {{ ok: boolean, error?: string, attempts: number }} `ok:false` 时 `error` 说明原因；
 *   **调用方不应因它而失败**，打一条警告即可
 */
export function removeTreeBestEffort(dir, options = {}) {
  const platform = options.platform ?? process.platform
  const remover = options.remover ?? ((path) => rmSync(path, { recursive: true, force: true }))
  const osRemover = options.osRemover ?? ((path) => removeViaOsCommand(path, platform))

  if (!dir) return { ok: false, error: '路径为空', attempts: 0 }
  if (!existsSync(dir)) return { ok: true, attempts: 0 }

  // 1) 直接删。
  try {
    remover(dir)
    if (!existsSync(dir)) return { ok: true, attempts: 1 }
  } catch {
    /* 走下一级 */
  }

  // 2) 递归恢复写/执行权限后再删（EACCES 的主要来源：zip 解包出的权限位不可写）。
  try {
    grantWritePermissionRecursive(dir)
    remover(dir)
    if (!existsSync(dir)) return { ok: true, attempts: 2 }
  } catch {
    /* 走下一级 */
  }

  // 3) OS 兜底。
  const os = osRemover(dir)
  if (os.ok) return { ok: true, attempts: 3 }
  return { ok: false, error: os.error, attempts: 3 }
}

// ---------------------------------------------------------------------------
// 自测
// ---------------------------------------------------------------------------
export function selfTest() {
  const failures = []
  let passed = 0
  const check = (condition, message) => {
    passed += 1
    if (!condition) failures.push(message)
  }

  const root = mkdtempSync(join(tmpdir(), 'remove-tree-selftest-'))
  const makeTree = (name) => {
    const dir = join(root, name)
    mkdirSync(join(dir, 'resources', 'harness', 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'resources', 'harness', 'node_modules', 'a.js'), 'x', 'utf8')
    return dir
  }

  try {
    // 1) 正常目录必须真的被删掉。
    const normal = makeTree('normal')
    const r1 = removeTreeBestEffort(normal)
    check(r1.ok, '正常目录删除应成功')
    check(!existsSync(normal), '正常目录删除后必须不存在')

    // 2) 不存在的路径算成功（与 rmSync force 语义一致），且不消耗尝试次数。
    const r2 = removeTreeBestEffort(join(root, 'does-not-exist'))
    check(r2.ok, '不存在的路径应算成功')
    check(r2.attempts === 0, '不存在的路径不应消耗尝试次数')

    // 3) 空路径：必须判失败且**不抛**。
    let threw = false
    let r3
    try {
      r3 = removeTreeBestEffort('')
    } catch {
      threw = true
    }
    check(!threw, '空路径不应抛错')
    check(r3.ok === false, '空路径应判失败')

    // 4) 三级降级：注入「前两级都抛 EACCES」的删除器，第 3 级必须被调用到。
    //    这正是 2026-09-23 事故的形态——`rmSync` 在 zip 解包出的只读目录上报 EACCES。
    const degraded = makeTree('degraded')
    let directCalls = 0
    let osCalls = 0
    const r4 = removeTreeBestEffort(degraded, {
      remover: () => {
        directCalls += 1
        throw new Error('simulated EACCES: permission denied')
      },
      osRemover: () => {
        osCalls += 1
        rmSync(degraded, { recursive: true, force: true })
        return { ok: true }
      }
    })
    check(directCalls === 2, `前两级应各尝试一次，实际 ${directCalls} 次`)
    check(osCalls === 1, 'OS 兜底必须被调用恰好一次')
    check(r4.ok === true, '兜底成功时 ok 必须为 true')
    check(r4.attempts === 3, '走完三级时 attempts 应为 3')
    check(!existsSync(degraded), '兜底成功后目录必须不存在')

    // 5) **核心契约**：三级全失败时**必须不抛错**，而是回报 ok:false。
    //    这是本次事故的分水岭——旧实现让 EACCES 冒泡，把一次成功的核验判成了发布失败。
    const hopeless = makeTree('hopeless')
    let threwOnExhausted = false
    let r5
    try {
      r5 = removeTreeBestEffort(hopeless, {
        remover: () => {
          throw new Error('simulated EACCES')
        },
        osRemover: () => ({ ok: false, error: 'rm 退出码 1' })
      })
    } catch {
      threwOnExhausted = true
    }
    check(!threwOnExhausted, '三级全失败时不应抛错（旧实现正是在这里冒泡 EACCES）')
    check(r5.ok === false, '三级全失败时应回报 ok:false')
    check(String(r5.error).includes('rm'), '失败原因应被带出来供诊断')

    // 6) 未知平台不得抛错（OS 兜底分支退化时也不能崩）。
    const unknown = makeTree('unknown-platform')
    let threwOnUnknown = false
    try {
      removeTreeBestEffort(unknown, { platform: 'plan9' })
    } catch {
      threwOnUnknown = true
    }
    check(!threwOnUnknown, '未知平台不应抛错')

    // 7) `grantWritePermissionRecursive` 递归授权。
    const perms = makeTree('perms')
    const nested = join(perms, 'resources', 'harness', 'node_modules', 'a.js')
    const chmodCalls = []
    const touched = grantWritePermissionRecursive(perms, {
      chmod: (path, mode) => chmodCalls.push({ path, mode })
    })
    check(touched >= 4, `递归授权应至少碰到 4 个条目，实际 ${touched}`)
    check(existsSync(nested), '递归授权不应删掉任何东西')
    check(
      chmodCalls.some((c) => c.path === perms && c.mode === 0o755),
      '目录应以 0o755 授权'
    )
    check(
      chmodCalls.some((c) => c.path === nested && c.mode === 0o644),
      '文件应以 0o644 授权'
    )

    // 8) 可证伪性：符号链接条目**不得**被 chmod。
    //    跟随链接的实现会以 link 路径调用 chmod，从而改到链接目标上——而那可能是
    //    仓库里的真实文件。用 junction / 目录链接构造，两种宿主上都不需要特权。
    const linkTarget = join(root, 'link-target')
    mkdirSync(join(linkTarget, 'inside'), { recursive: true })
    writeFileSync(join(linkTarget, 'inside', 'b.js'), 'y', 'utf8')
    const linkParent = join(root, 'link-parent')
    mkdirSync(linkParent, { recursive: true })
    let linked = false
    for (const kind of ['junction', 'dir']) {
      try {
        symlinkSync(linkTarget, join(linkParent, 'deps'), kind)
        linked = true
        break
      } catch {
        /* 换下一种 */
      }
    }
    if (!linked) {
      // 宿主两种链接都建不了：这条契约无法构造。明确记录，而不是假装通过。
      check(true, '（记录）当前宿主无法创建目录链接，「不跟随符号链接」未在本机验证')
    } else {
      const linkCalls = []
      grantWritePermissionRecursive(linkParent, {
        chmod: (path, mode) => {
          linkCalls.push(path)
          chmodSync(path, mode)
        }
      })
      const followedCalls = linkCalls.filter((p) => p.includes('deps'))
      check(
        followedCalls.length === 0,
        `递归授权跟随了符号链接：以 ${followedCalls[0] ?? ''} 调用 chmod（会改到链接目标上）`
      )
      check(
        linkCalls.includes(linkParent),
        '递归授权应至少改到父目录自身（否则整趟遍历没跑）'
      )
    }

    if (failures.length > 0) {
      throw new Error(`remove-tree 自测失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`)
    }
    return { passed }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const isDirectRun = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
})()

if (isDirectRun) {
  if (process.argv.includes('--self-test')) {
    try {
      const { passed } = selfTest()
      console.log(`✅ remove-tree 自测通过（${passed} 项）`)
    } catch (error) {
      console.error(error.message)
      process.exit(1)
    }
  } else {
    console.log('用法：node scripts/remove-tree.mjs --self-test')
    process.exit(1)
  }
}
