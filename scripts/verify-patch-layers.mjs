#!/usr/bin/env node
/**
 * verify-patch-layers.mjs — 对**每一个** DSH 构建目标跑补丁分级自检。
 *
 * ## 为什么不是直接调 `patch-layers.mjs --self-test`
 *
 * 双通道（`next` / `alpha`）各有自己的一套 `patches/<target>/`。只验默认目标
 * 意味着另一条线的补丁可以整目录漏登记、或版本串停在旧值而无人发现——
 * 而那条线**同样会发布给用户**。分级表的唯一性是按目标成立的，检查就必须
 * 逐目标跑一遍。
 *
 * 每个目标的检查项见 `patch-layers.mjs::auditPatchLayers`：包名可推导、
 * 在分级表里登记过、层名合法、DSH 家族的文件名版本段与目标版本一致。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-patch-layers.mjs              # 全部目标
 * node scripts/verify-patch-layers.mjs --dsh-target=alpha
 * ```
 *
 * 退出码：`0` 全部通过 · `1` 任一目标不一致 · `2` 参数错误。
 */

import { argv, exit } from 'node:process'

import { auditPatchLayers, listPatchFiles } from './patch-layers.mjs'
import { listTargetNames, resolveDshTargetArg, resolveTarget } from './dsh-targets.mjs'

function main() {
  const args = argv.slice(2)
  let targets
  if (args.some((arg) => arg.startsWith('--dsh-target='))) {
    try {
      targets = [resolveDshTargetArg(args)]
    } catch (error) {
      console.error(`[verify:patches] ${error.message}`)
      exit(2)
    }
  } else {
    targets = listTargetNames()
  }

  let failed = 0
  for (const target of targets) {
    const problems = auditPatchLayers(target)
    const count = listPatchFiles(target).length
    if (problems.length === 0) {
      console.log(
        `✅ 目标 ${target}（DSH ${resolveTarget(target).dshVersion}）：${count} 个补丁全部分级且包名/版本一致`
      )
      continue
    }
    failed += 1
    console.error(`❌ 目标 ${target}（DSH ${resolveTarget(target).dshVersion}）：`)
    for (const problem of problems) console.error(`   - ${problem}`)
  }

  if (failed > 0) {
    console.error(`\n${failed}/${targets.length} 个目标的补丁分级表不一致`)
    exit(1)
  }
  console.log(`\n全部 ${targets.length} 个目标通过`)
}

main()
