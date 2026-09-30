# ADR-054 — AI 评审工作流准入：接上而不是删除，SHA 钉死 + 触发面收紧

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-30 |
| 唯一产地 | .github/workflows/pr-agent.yml 的文件头注释（pullfrog.yml 已于 2026-09-30 删除，见「修订」行） |
| 修订 | ~~决策 2（pullfrog.yml 保留在 workflows/、一并接上）~~（已被 [ADR-058](058-retire-pullfrog-agent.md) 修订：pullfrog.yml 删除、停用，AI 评审只保留 pr-agent.yml；本 ADR 其余决策继续有效） |
| 关联 | ADR-005（配置/命令面准入纪律）；docs/dev-plan-defect-remediation.md S0-3、S3-3 |

## 背景

2026-09-29 的提交 e9f8dc5 标题是「Add Qodo AI PR Agent workflow」，但该提交把**工作流文件放在了 .github/pr-agent.yml**，而不是 .github/workflows/。GitHub Actions 只加载 .github/workflows/ 下的文件，于是这是一份**从不运行**的配置：commit 记的是一个能力，实际得到的是一条死配置，且文件里还留着「换成你实际可用的模型 ID」这类未替换的模板注释。

同仓另有 .github/workflows/pullfrog.yml（2026-09-15 加入），是厂商模板原样入库、仅 workflow_dispatch 触发。

按本仓 ADR-005 的准入纪律（只保留有真实调用方的东西，死配置要么接上要么删掉），这两份配置属于典型的「游离配置」。维护者 2026-09-30 裁定：**接上**，而不是删除。

## 决策

1. .github/pr-agent.yml 挪到 .github/workflows/pr-agent.yml，真正接线。
2. pullfrog.yml 保持在工作流目录，一并接上（保持其 dispatch 触发形态）。
3. **所有第三方 action 钉到 40 位 commit SHA**，注释保留可读标签：qodo-ai/pr-agent 钉 10bbd9a41061605e18ac8bab94d49a2d12a1f3a5；pullfrog/pullfrog 钉 9d9014dffa1bc03e4f77b7a3474c5c6aa9a9602f。
4. **收紧触发面**：issue_comment 路径只在 ① 事件来自 PR、且 ② 评论者的 author_association 属于 OWNER / MEMBER / COLLABORATOR 时才运行。否则公开仓库上任何外部用户都可以用维护者的模型 API key 触发一次运行。
5. 权限保持最小（contents: read + PR/issue 评论写），并加 concurrency 防止重复运行。
6. 两份文件必须有文件头注释说明它是什么、为什么存在、什么条件下删除——游离配置的判定依据由此可检索，而不是再次靠人记得。

## 备选方案与取舍

- **删除两份配置**（原推荐）：维护者否决。可用的 PR 辅助值得保留；删除会丢掉能力而收益只是少两个文件。
- **保留但不动**：否决。这正是 ADR-005 禁止的「为可能的未来预留的死配置」，且第一份根本不会加载——留着的唯一作用是让人以为它有在工作。
- **接上但不钉 SHA、不收紧触发面**：否决。公开仓库 + 第三方可变 ref + 持有发布签名私钥的同一套 secrets，是本仓安全姿态里最不该有的组合。

## 后果

- 公开仓库上每个 PR 与（受限的）评论都会触发自动评审：会消耗模型额度，这是新增的运行成本。
- 厂商模板升级需要人工同步 SHA（Dependabot 不覆盖 action 的 SHA，除非单独配置）。
- 两份工作流从此属于「已接线」：如果哪天不再使用，应删除而不是留在仓库里当摆设（判据见文件头注释）。

## 守卫与证据

- npm run verify:github-config（新增）——① .github/ 下**非 workflows 目录**不得出现工作流形态的 YAML（含 on: 与 jobs:）；② .github/workflows/ 下每个非本地 uses 必须是 40 位 SHA。可证伪夹具：把放错目录的 pr-agent.yml 与写 @v5 的 action 喂进判定必须报红。
- 触发面的收紧无法静态守卫（属平台语义），因此写进文件头注释并以本 ADR 为唯一产地。
