# ADR-058 — 停用 Pullfrog：删除工作流文件，AI 评审收敛到 PR Agent（修订 ADR-054 决策 2）

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-30 |
| 唯一产地 | `.github/workflows/` 目录内容——pullfrog.yml 缺席即停用；在役 AI 评审的唯一一份是 `.github/workflows/pr-agent.yml`（其文件头注释） |
| 修订 | ~~ADR-054 决策 2（pullfrog.yml 保留在 workflows/ 一并接上）~~（本 ADR 修订之：pullfrog.yml 于同日删除，AI 评审只保留 pr-agent.yml） |
| 关联 | ADR-054（AI 评审工作流准入）；ADR-005（准入纪律）；docs/dev-plan-defect-remediation.md S0-3 / S3-4；SECURITY.md「CI 密钥暴露面」表 |

## 背景

维护者 2026-09-30 下达指令：**停用 pullfrog，启用 pr-agent**。指令附带一个必须先回答的语义问题——「删除 pullfrog.yml 是否意味着停用 pullfrog」？

答案是**是**，且这是仓库侧唯一的停用形态：

1. GitHub Actions 只从 `.github/workflows/` 加载工作流（ADR-054 背景段的同一事实，当初让 `.github/pr-agent.yml` 成为死配置）。文件不在该目录，工作流就不存在——既不会自动跑，也不能被 `gh workflow run` / Actions 页手动触发，更不会出现在 Actions 标签页里。
2. GitHub UI 的「Disable workflow」开关是**服务器端状态**，不是仓库内容：新克隆、CI、其他维护者都看不见它，也无法被任何门禁检查。把它当作停用手段，等于把裁决写在一个进不了 git 的地方（同 ADR-007 的口径：进不了仓库的状态不配称作本仓的决策）。
3. pullfrog.yml 的文件头注释（删除前第 8 行）写明的删除判据正是「不再使用该 agent 时删除本文件，而不是留着当摆设」——本次是执行那条判据，不是新立规矩。

pullfrog 的实况：厂商模板原样入库，仅 `workflow_dispatch` 手动触发，没有任何自动化触发面；它在 SECURITY.md「工作流 → secrets」表里挂着 13 个 provider key 的暴露面。ADR-054 决策 2 当时保留它的理由是「可用的按需 agent 值得留下」，本次维护者指令构成对该理由的修订。

## 决策

1. **删除 `.github/workflows/pullfrog.yml`**。停用的判据以本 ADR 为唯一产地；恢复 = 从 git 历史（commit `574f61e`）取回文件并重新过 ADR-054 的准入（钉 SHA + 文件头注释），不是「取消禁用」某个开关。
2. **AI 评审只保留 pr-agent.yml**。它按 ADR-054 决策 1 / 3 / 4 / 5 已在 `.github/workflows/` 下接线（`pull_request` 三类型 + PR 内 OWNER/MEMBER/COLLABORATOR 评论），**本次零改动即处于启用状态**——「启用」是被验证的事实（actionlint 通过、守卫全绿），不是又一处待接线的宣称。
3. **不引入任何仓库内「停用开关」**：没有删除文件却保留某种禁用标记的中间态。停用与启用的唯一判据是 `.github/workflows/` 里有没有这个文件。
4. **secrets 处置分离**：pullfrog 模板声明的 13 个模型 key（`ANTHROPIC_API_KEY` 等）在仓库内从此没有消费方，SECURITY.md 的暴露面表随之删除该行。仓库设置里这些 secret 的删除是 GitHub 侧手工操作——本仓不持有、也不代理任何 GitHub 凭据，agent 不代做；删除它们不影响任何工作流（无引用即无消费）。

## 备选方案与取舍

- **保留文件、注释掉 `on:` 或加永假 `if:`**：否决。GitHub 不加载没有 `on:` 的工作流，但文件还在、下一个人还要解释它；「停用」状态只存在于某台机器的一次编辑里，不可检索、不可复现，正是 ADR-005 要消灭的形态。
- **只依赖 GitHub UI 的 Disable workflow**：否决。服务器端开关不在仓库里（见背景第 2 条）；且 pullfrog 仅有手动触发面，禁用它省不下任何自动运行成本，收益为零而代价是裁决失所。
- **两份都停用**：否决。pr-agent 提供每次 PR 的自动描述与评审（`auto_describe` / `auto_review` 已开），是 ADR-054 决策 1 接线后真正在用的能力；停用它属于把已兑现的能力退回死配置。
- **改 pr-agent 的触发面来「补偿」pullfrog 的按需能力**：否决。两者形态不同（PR 自动评审 vs 手动 agent 任务），用 PR 触发器模仿按需 agent 只会得到畸形配置；需要按需 agent 时按决策 1 恢复 pullfrog 或另立 ADR。

## 后果

- PR AI 评审能力不变（pr-agent.yml 一个字节未动）；仓库里少一份厂商模板、少一处 SHA 同步义务。
- secrets 暴露面收缩：`ANTHROPIC_API_KEY` 等 13 个 key 不再被任何工作流引用（SECURITY.md 表已删该行）。仓库设置里的同名 secret 建议由维护者择期删除——不删也不会被消费，属卫生而非风险。
- `verify:github-config` 的扫描基数变为「9 个 YAML / 5 个工作流 / 31 个 uses / 错放 0」（删除前同一守卫在计划 §11 执行记录里的快照是 6 个工作流；uses 计数不可直接相减——S3-3 等后续批次也改过它）。该守卫**不依赖具体数量**——只有「扫出 0 个」才报红（AGENTS.md §7.3 纪律），因此删除不会让它误红，新增浮动 ref 仍会报红。
- ADR-054 的决策 2 被修订，其余决策（1 / 3 / 4 / 5 / 6）全部继续有效；ADR-054 原文按库内惯例保留供追溯，不删改。

## 守卫与证据

- `npm run verify:github-config`：删除后实跑「扫描 9 个 YAML：工作流形态 5 个 · uses 引用 31 个 · 错放 0 个」，自检 12 项通过（含「扫出 0 个工作流 / 0 个 uses 必须报错」的可证伪夹具）。
- actionlint v1.7.7（官方 checksums.txt 校验 SHA-256 一致）：`.github/workflows/*.yml` 全部 exit 0——pr-agent.yml 的表达式（`if:` 内含 `#` 与冒号，已按双引号包裹）、`concurrency`、触发面全部通过 Actions 层校验，不是仅 YAML 可解析。
- pr-agent 触发面收紧（issue_comment 只接受 PR + 本仓成员）无法静态守卫（平台语义），判据在文件头注释 + ADR-054 决策 4——本条不因 pullfrog 停用而改变。
