# ADR-048 — 收敂为单一上游通道

| | |
|---|---|
| 状态 | 已接受，执行中（工程收尾随 P0/P1 排期） |
| 日期 | 2026-09-20 |
| 唯一产地 | `scripts/dsh-targets.mjs`（收敂后仅剩 `next` 推导）、`AGENTS.md` §8.6 |

## 背景

双上游通道（ADR-022，2026-09-15）解决了「版本号说 alpha、运行时是 next」类错配，
但每条线各持一套补丁、一套升级流程、一套 drift 对照。学费已经付过：
补丁行号漂移（135 / 369 行）、两条线的补丁数差、逐通道 drift——**维护成本
真实存在且没有第二个消费者**。在零预算重裁（ADR-047）下，分流发需求消失，
成本结构里只剩成本。

## 决策

收敂回**单一 `next` 通道**：

1. `dsh-targets.mjs` 保留目标表与推导逻辑（重建底座成本低），但**只有一个活跃目标**。
2. `release.yml` preflight 的 `--channel-of` 链路退役（不再需要从 tag 反推通道）。
3. `smoke.yml` 的 `dsh_target` 输入退役；`verify:drift` 只对照 `next` dist-tag。
4. `patches/alpha/`、`packages/alpha/`、`harness-deps/alpha/` 停止维护
   （保留或删除随执行时点裁定；若删，删除动作与理由写入 CHANGELOG）。
5. `AGENTS.md` §8.6 的双通道表改写为单通道，并保留一节说明「曾有两个通道、
   为什么收敂」——防止未来有人「恢复」它时不知道代价。

## 备选方案与取舍

- **保留双通道但只维护 next**：否决。半保留状态最坏：补丁目录、dist-tag、
  预发布后缀全都要继续回答「alpha 还算不算数」。
- **干脆删掉 `dsh-targets.mjs` 的抽象、写死版本**：否决。抽象本身便宜，
  且重开第二通道时（若真有第二个消费者）直接可用；删抽象只省下读一个文件的成本。

## 后果

- 升级工序少一半；`verify:patches` / `verify:targets` / drift 各只跑一个目标。
- 若将来出现第二个真实消费者，按 ADR-022 的判据重建（而不是「恢复历史」）。

## 守卫与证据

- `npm run verify:targets`（目标表自检：未知通道必须失败不得回退——
  收敂后这条依然有效，防回退默认目标）。
- `verify:release-workflow` 的 `checkDualChannelShape` 相应改写为单通道形状
  （执行时同步）。
