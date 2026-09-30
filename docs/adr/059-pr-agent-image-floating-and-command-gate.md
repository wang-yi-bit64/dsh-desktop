# ADR-059 — action SHA 钉不死 Docker 镜像：PR Agent 触发面增补「命令开头」条件（ADR-054 决策 3 的边界）

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-30 |
| 唯一产地 | .github/workflows/pr-agent.yml 文件头「线上事故」段与 `if:` 触发面第③条 |
| 关联 | ADR-054（决策 3 SHA 钉死 / 决策 4 触发面收紧）；docs/dev-plan-defect-remediation.md S0-3 |

## 背景

2026-09-30 PR Agent 首次真跑（PR #2，run #9，评论者 = 仓库 OWNER）**失败**于「PR Agent action step」，
日志最后一行 `Unknown command: |`。评论正文是一份发布门禁证据表，以 `## …` 开头——不含任何 pr-agent 命令。

根因链条（三条证据都来自线上，不是推测）：

1. **行为**：旧镜像把任意评论按 shell 规则词法分析，`#` 是注释起点 → 标题行整行被吃掉 → 第一个 token
   变成 Markdown 表格的 `|` → 未知命令 → `handle_request` 返回 False → action 退出 1 → 红叉。
2. **镜像落后于钉死的 commit**：日志行号系统性地小于 action 钉死的 10bbd9a4 源码——
   `Unknown command` 日志 363 / 源码 381；`Applying repo settings` 日志 217 / 源码 241；
   `Settings file not found` 日志 65 / 源码 67。而该 commit 里**本来就有**两道修法：
   runner.py「注释不以 `/` 开头就忽略」、pr_agent.py「`#` 按普通字符处理」。
3. **为什么钉死了还落后**：`qodo-ai/pr-agent@10bbd9a4` 是 **Docker action**，其 Dockerfile 只有一行
   `FROM pragent/pr-agent:github_action`——**浮动镜像标签**。40 位 SHA 钉住的只是 action.yaml 与
   Dockerfile 本身；真正执行的 pr-agent 代码由 Docker Hub 上那个 tag 决定，**不在本仓任何钉死机制范围内**。

后果：任何非命令评论（本仓维护者发发布说明、贴证据表的场景）都会把 action 打成红叉。PR Agent 上线至今
10 次运行里 8 次是机器人评论被 `if:` 门正确跳过，唯一放行的 OWNER 评论即失败——**评审路径一次都没成功过**。

## 决策

1. **触发面增补第③条**：`issue_comment` 还要求评论**以 pr-agent 命令开头**
   （`/review` `/improve` `/describe` `/ask` 四个，用 `startsWith` 判定）。非命令评论不再启动 runner——
   没有红叉、不烧 runner 分钟，与上游自己的 webhook 守卫同形，只是提前到 workflow 层。
2. **必须 `startsWith`，禁止 `contains`**：旧镜像按**第一个 token** 解析，`please /review this` 的 action 是
   `please` → 未知命令 → 失败。`contains` 会放进这类评论制造红叉，`startsWith` 只会误拦（「没触发」）。
   误放是假警报，误拦是无事件——取误拦。
3. **登记边界，不假装钉死**：本 ADR 是 ADR-054 决策 3（SHA 钉死）的边界登记——它管得住 action 仓库，
   管不住 action 拉起的 Docker 镜像。补偿控制就是第 1 条的门，而非「换一个 SHA」。
4. **不改 `pull_request` 路径**：auto_review / auto_describe 不解析评论正文，不受本事故影响；
   但镜像落后意味着其他修复也可能缺失，**该路径仍属未验证状态**（见后果）。

## 备选方案与取舍

- **升级 action 的钉死 SHA 到更新 commit**：否决。镜像标签浮动，换 SHA 不改变「跑的是旧代码」这一事实；
  且 10bbd9a4 本身已包含所需守卫，问题不在 SHA 新旧。
- **在 action 里传 `config.*` 关掉评论解析**：否决。pr-agent 没有「忽略未知命令」的配置项，
  失败语义内置于 runner（该 commit 的标题就是「fail closed on three silent fallbacks」——它有意如此）。
- **接受红叉，每次手动重跑**：否决。红叉是假警报，会训练维护者忽略 Actions 页——比浪费几分钟更贵。
- **改用 qodo 托管 App（PR #2 上那两条评审的来源）**：否决。托管 App 不在本仓任何控制与审计范围内，
  而本仓要的是「配置即代码、可门禁、可追溯」的自托管路径。

## 后果

- 非命令评论：不产生 run（静默）；`/review` 等命令评论：正常触发，且评论者仍限本仓成员。
- **仍未验证**：`/review` 命令路径与 `pull_request` 路径能否真正产出评审，取决于模型配置
  （`STEPFUN_API_KEY` / `step-5-preview` / `custom_model_max_tokens`）在旧镜像里是否被接受——
  这需要一次真实的 `/review` 评论在线验证，本地无凭据不可测。本 ADR 不宣称它已工作。
- 镜像标签 `pragent/pr-agent:github_action` 更新到含守卫的版本后，第③条依旧正确（幂等），不会变成阻碍。
- 若上游把镜像改为按 commit 构建（或提供 digest 标签），本条边界随之关闭；恢复判据写在这里备查。

## 守卫与证据

- 触发面第③条可静态验证：`if:` 表达式内含四个 `startsWith(github.event.comment.body, '/…')`，
  actionlint v1.7.7（SHA-256 与官方 checksums 核对）对全部 5 个工作流 exit 0。
- 表达式语义用「真实事件载荷矩阵」推演：14/14 通过（含事故原文 `## …` 表格评论 → 不触发；
  `please /review this` → 不触发；外部 CONTRIBUTOR 的 `/review` → 不触发）。
- 线上行为基线（2026-09-30 实测）：机器人评论 ×8 全部 skipped；OWNER 非命令评论 ×1 failure——
  与矩阵推演一致。本条 ADR 落地后，前者不变，后者应变为「无 run」。
- 镜像落后的事实无静态守卫（Docker Hub 标签内容不在本仓）；判据是本 ADR 背景段的三个行号差值，
  复现方式：重跑一次 `/review` 评论并比对日志行号。
