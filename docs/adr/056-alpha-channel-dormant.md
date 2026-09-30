# ADR-056 — alpha 线休眠（部分修订 ADR-052）

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-30 |
| 唯一产地 | scripts/dsh-targets.mjs（目标表 `status` 字段） |
| 修订 | ~~ADR-052 决策 1~~（本 ADR 已被 [ADR-057](057-alpha-channel-restored-and-dual-promotion.md) 修订：alpha 线于同日应维护者指令复役并推进至上游 0.1.7-alpha.2；下文表述为历史记录，现行为 ADR-057） |

## 背景

ADR-052 恢复双通道时接受的代价是「维护工序翻倍」。通道化首发（v0.7.1-rc.1，2026-09-30）把这条代价的实际形态摆上了台面：

1. alpha 线自恢复「在役」以来**零投递**：最后一次 alpha 发布（v0.7.0-alpha.8）早于端点通道化（ADR-053），`updater-alpha` 滚动 Release 从未创建——所谓在役，对 alpha 用户没有任何可感知的交付。
2. 引导 alpha 需要一次完整发布周期（CI + 双 Smoke full + release），且版本号受跨通道单调守卫约束：下一条 alpha 必须严格大于当时最高的 rc tag（当前即 ≥ `0.7.2-alpha.1`）。
3. 维护者单人、零现金预算（ADR-047）。next 线自身落后上游一个 minor（`0.1.5-rc.3` vs 上游 `0.2.0-rc.2`，含上游重构的移植批次已排期——缺陷治理计划决策点 C8：S0~S6 全部退出后启动），把人力花在 alpha 线的例行维护上，会直接推迟 next 线的追赶。

## 决策

1. **alpha 目标休眠**：不发布、不做漂移追赶、不维护补丁。`patches/alpha/`、`packages/alpha/`、`harness-deps/alpha`、逐目标 lockfile **原样冻结保留**——恢复时不需要重建，只需要解冻。
2. 状态的**唯一产地是目标表的 `status` 字段**（`active` / `dormant`）：哨兵与发布链路读表，不在任何调用方另写一份休眠名单。
3. 休眠的守卫表现：
   - `verify:update-channel` 与 drift 哨兵对休眠目标**跳过并显式说明**（不是静默消失）；
   - release preflight 的 `--channel-of` 对休眠目标**直接失败**——给休眠通道打 tag 在组装 300MB 之前就被拦下；
   - 每日 drift 的红灯只剩 next 线（那是真实且已排期的信号）。
4. alpha 后缀（publishChannel）仍可解析：目标定义没有被删除。删除目标是 ADR-022 意义上的收敂，那是另一个决策。

## 备选方案与取舍

- **引导 alpha（发一次 0.7.2-alpha.1）**：否决。一次完整发布周期的成本买不来任何用户可感知价值——alpha 线的差异化是「下一 minor 预览」，而 next 线还停在上游两个版本之前，预览无从谈起。
- **删除 alpha 目标（再次收敂）**：否决。ADR-052 刚裁定过「机制已建成、重建成本接近零」；删除是 C8 移植完成后的另一个决策，现在删等于把未来的选项提前卖掉。
- **维持「在役」口径不动**：否决。那是 ADR-048 点名的最坏形态的变体——守卫把 alpha 当在役通道核对（每天红），而维护动作永远不会来。红噪音训练人无视红灯。

## 后果

- 每日 drift 只对 next 线负责；alpha 的「落后」不再产生信号（它本就不打算追）。
- S5 的补丁减法只作用于 next 线；alpha 的 13 个补丁冻结，不增不减。
- **恢复前提**（满足其一即可解冻）：① C8 的 next 线移植完成、有余力；② 出现第一个需要 alpha 线的真实消费者或需求。恢复时必须：修订本 ADR、目标表 `status` 改回 `active`、发布一条**严格大于当时最高 rc tag** 的 alpha（单调守卫跨通道生效）。
- ADR-052 的其余决定（机制保留、成本分析、retireWhen 配套）不受影响；其「维护工序翻倍」的代价陈述自本 ADR 起按「仅 next 线在役」计。

## 守卫与证据

- `npm run verify:targets` —— `status` 枚举、「alpha 休眠」「默认目标必须在役」断言（39 项）。
- `npm run verify:update-channel` / `npm run verify:drift` —— 休眠目标显式跳过；零在役目标时必须报错，不得 vacuous 通过。
- release preflight 的 `--channel-of` —— 对休眠目标直接失败（实测 `--channel-of 0.8.0-alpha.1` 退出码 1）。
