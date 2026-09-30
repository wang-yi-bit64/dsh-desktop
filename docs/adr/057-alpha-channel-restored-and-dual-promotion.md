# ADR-057 — alpha 线复役与双通道同步推进至 0.2.0-rc.2 / 0.1.7-alpha.2（修订 ADR-056）

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-30 |
| 唯一产地 | scripts/dsh-targets.mjs（目标表 `status` / `dshVersion` 字段） |
| 修订 | ADR-056 决策 1（「alpha 目标休眠」→ alpha 恢复在役并推进到上游 0.1.7-alpha.2） |

## 背景

2026-09-30 当日先后发生两件事：

1. **ADR-056 裁定 alpha 休眠**（维护者单人、零现金预算，next 线自身落后一个 minor，
   两条线例行维护会推迟 next 追赶）。
2. **用户当日下达推进指令**：next → `0.2.0-rc.2`、alpha → `0.1.7-alpha.2`，并要求先完成
   五项前置改进（scripts 瘦身 / Windows 启动耗时 / 官方功能对比 / UI 风格对齐 / 文档优化），
   完成后经 PR 发布。

ADR-056 的「恢复前提」写的是「① C8 的 next 线移植完成、有余力；② 出现第一个需要 alpha 线的
真实消费者或需求」。本次的形态是**②的等价物**：用户以明确指令同时驱动两条线，且下一版本
（0.7.2）要做 alpha 线自己的推进——alpha 恢复在役有了直接的、来自维护者本人的需求。

## 决策

1. **alpha 目标复役**：`status` 由 `dormant` 改回 `active`（唯一产地仍是目标表），
   锚点由 `0.1.6-alpha.2` 推进到上游 `alpha` dist-tag 当前的 **`0.1.7-alpha.2`**。
2. **next 目标同步推进**：锚点由 `0.1.5-rc.3` 推进到 `0.2.0-rc.2`（跨两个 minor，
   含上游重构——预检 clean 2 / conflict 12，经三路合并 + 逐补丁语义裁定后 10 个补丁全部
   clean 落盘）。ADR-056 背景里的「C8 移植批次」因本次推进而**提前完成**。
3. **补丁按 retireWhen 净退役 6 个**（两线合计）：`ui-layout`（上游平台化宽度，两线）、
   `ui-workspace`（上游原生 `completionUnread` + 未读行样式，两线）、
   `ui-model-selection`（上游自带搜索 + 键盘导航，next 线）、
   `ui-agent-preset`（上游重写卡片式预设管理，锚结构性失效，两线）。
   补丁数 next 14 → 10、alpha 13 → 11。
4. **休眠的守卫表现随状态翻转**：`verify:drift` / `verify:update-channel` 重新把 alpha 纳入
   逐通道对照；release preflight 的 `--channel-of` 重新接受 alpha 后缀发布。

## 备选方案与取舍

- **只推进 next、alpha 继续休眠**：否决——与用户指令直接冲突；指令本身也是 alpha 恢复的
  需求依据（恢复前提 ② 的等价形态）。
- **删除 alpha 目标**：再次否决。ADR-056 已论证「机制已建成、重建成本接近零」，且本次
  复役的零额外成本也再次印证了这一点（补丁退役 + 三路合并全部在一个工作日内完成）。
- **维持休眠口径不动、只推进 next**：即前述否决项。ADR-056 担心的「红噪音训练人无视
   红灯」在复役后不成立——两条线都在维护日程内，drift 红灯重新是真实信号。

## 后果

- alpha 通道恢复发布：下一条 alpha 版本必须**严格大于当时最高 rc tag**（跨通道单调守卫，
  ADR-052/056 的既有规则不变）。当前 rc 线最高为 `0.7.1-rc.1`，故下一条 alpha 至少为
  `0.7.2-alpha.x`。
- `verify:targets` 自测的休眠断言改为复役断言（如保留休眠断言，复役后自测会一直红——
  那属于把决策写死进守卫，与「唯一产地是状态字段」的机制相悖）。
- ADR-056 的其余结论（机制保留、成本分析、发布单调守卫）不受影响；本文只修订其决策 1。
- **已知代价（如实记录）**：本次 next 线推进**早于**现役计划
  （`docs/dev-plan-0.8-convergence.md` §6）为切 0.2.0 设定的四项放行条件中的前两项——
  ① 上游 0.2.0-rc.2 发布仅 1 天（要求 7~14 天）；② 六个相关上游讨论（#8166 / #8140 /
  #8183 / #7903 / #7828 / #7908）均未关闭，且其中 #8166（peer gate 静默禁用 storage）与
  #8140（升级到 0.2.0-rc.1 后工作区被清）属**数据丢失类**。推进由用户明确指令驱动，
  风险缓释见 `docs/dsh-upgrade-checklist.md` 的本次记录：组装前对 #8166 做显式检查
  （组装后 fixture profile 的工作区/会话列表非空），冒烟覆盖启动/停止/重启/会话可见性。
  **这不是「改判」——放行条件本身未被修订，本次是例外放行，理由与用户指令一并记录在案。**

## 守卫与证据

- `npm run verify:targets` —— alpha 复役断言、默认目标在役断言（39 项）。
- `npm run verify:drift` / `verify:update-channel` —— 两线重新逐通道对照，均不落后。
- release preflight 的 `--channel-of` —— alpha 后缀恢复可发布（`0.7.2-alpha.1` 类 tag）。
- `npm run verify:patches` —— 两线补丁数（next 10 / alpha 11）与补丁文件名版本段一致。
- 三路合并产物：`scripts/merge-migrate-patches.mjs`（本次新增的移植辅助工具），
  逐补丁裁定记录在 `patches/LAYERS.md`。
