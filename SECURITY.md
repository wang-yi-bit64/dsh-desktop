# 安全策略（Security Policy）

> 本文件面向两类读者：想**报告安全问题**的人，以及想**评估本软件适不适合自己**的人。
> 后者请重点读「威胁模型」——它写明这套软件**防什么、不防什么**，不夸大也不隐瞒。

## 报告渠道（How to report）

- **GitHub 私有漏洞报告**：仓库页 → Security → [Report a vulnerability](https://github.com/wang-yi-bit64/dsh-desktop/security/advisories/new)。这是唯一首选渠道——**私有**、不公开、可来回讨论。
- **不要**把漏洞细节发到公开 Issue / Release 评论：公开渠道会放大暴露面。
- 本项目由单人零预算维护（见 ADR-047），没有 SLA；但报告会得到人工回复，确认属实的修复会进下一条发布线。

## 支持范围（Supported versions）

本项目处于预发布期，**只支持最新一条发布线**（当前：`rc` 后缀线，见 `AGENTS.md` §8.6 的通道表；alpha 线已由 ADR-057 复役，但通道化后尚未发布过版本，暂不在支持范围内）。旧版本不接收安全修复，升级到最新版是唯一的受支持路径。

## 威胁模型（Threat model）

**这是什么**：一台**单用户、本机**桌面工具——它在本机起一个 Node 进程承载 DeepSeek Harness（产品本体），壳层只管窗口、生命周期与崩溃自愈。设计前提是「用户对本机已有控制权」，不是「对抗本机上的攻击者」。

**已有的防线**（都有代码证据，宣称纪律见 `AGENTS.md` §7）：

| 面 | 现状 |
|----|------|
| Harness 网络绑定 | 仅 loopback——Harness 只监听本机回环地址 |
| LAN 手机桥 | **默认关闭**；必须用户显式开启，配对需扫码 + cookie 握手，状态在原生菜单可见 |
| 自动更新链 | minisign 签名校验（tauri updater + 构建期注入的通道化端点，ADR-053）；端点 URL 唯一产地 `scripts/updater-manifest.mjs` |
| 诊断包 | 写入前过五条脱敏规则（launch token / `dsh-auth-*` cookie / 路径用户名段 / API key 形态 / 代理口令），命中计数如实上报；产物不上传 |
| 遥测 | **无**——应用自身不外发任何数据 |
| 进程清理 | Windows JobObject / POSIX 进程组 + macOS 父死看门狗，主程序退出不留孤儿进程 |

**明示的边界（不是防线，不要误信）**：

1. **同进程插件崩溃可以带走 Harness**——插件运行在 Harness 进程内的官方 Cordis 体系，本壳够不着那个挂载点（ADR-051 登记的已知缺口；曾实现的进程外隔离已按 ADR-040 归档删除）。
2. **Windows 产物未做 OS 级代码签名**——首次运行可能触发 SmartScreen / Gatekeeper 警告；这是零预算下的既定取舍（ADR-046/044），不是疏忽。用户应从本仓库的 Release 页自行校验下载来源。
3. **LAN 桥开启后**，配对设备能在配对有效期内与 Harness 交互——不要在不受信任的局域网里开启它。

## CI 密钥暴露面（Workflow → secrets）

| Secret | 用在哪 | 为什么需要 |
|--------|--------|-----------|
| `TAURI_SIGNING_PRIVATE_KEY`（+ `_PASSWORD`） | `release.yml`（build / portable / updater-channel）、`smoke.yml`（仅 `scope=full` 的打包步） | `bundle.createUpdaterArtifacts` 开启后，任何真实打包都需要签名私钥——smoke full 要复现发布形态，因此同样需要。私钥**不在** PR CI（ci.yml）与 drift 路径上 |
| `STEPFUN_API_KEY` | `pr-agent.yml` | PR AI 评审的模型调用；触发面已收紧为「PR + 本仓成员」（ADR-054） |

原则：每个工作流的 `permissions` 取最小（`contents: read` 为基线，发布路径才 `contents: write`）；所有第三方 action 钉 40 位 commit SHA（`npm run gate -- github-config` 守着，基线表已于 2026-09-30 S3-3 清空——此后任何浮动 ref 一律报红）。

> 2026-09-30：`pullfrog.yml` 已按 [ADR-058](docs/adr/058-retire-pullfrog-agent.md) 删除（停用），其上表曾有的一行（`ANTHROPIC_API_KEY` 等 13 个模型 key）随之移除——这些 key 在仓库内已无消费方。仓库 Settings 里的同名 secret 建议维护者择期删除：不删也不会被任何工作流读取，属卫生而非风险；删除它们的操作在 GitHub 侧，本仓不代理。
>
> ⚠️ 2026-10-09 补：该移除**不可恢复、禁止重新启用**（[ADR-062](docs/adr/062-pullfrog-removal-irreversible.md)）。禁令已写死为机器判据——`scripts/verify-github-config.mjs` 的 `RETIRED_WORKFLOWS` 登记了该路径，文件重新出现即让 `verify:github-config` 报红。因此上表**不得**为它重新加回任何一行。
