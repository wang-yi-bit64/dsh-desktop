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

原则：每个工作流的 `permissions` 取最小（`contents: read` 为基线，发布路径才 `contents: write`）；所有第三方 action 钉 40 位 commit SHA（`npm run gate -- github-config` 守着，基线表已于 2026-09-30 S3-3 清空——此后任何浮动 ref 一律报红）。

> 2026-09-30：`pullfrog.yml` 已按 [ADR-058](docs/adr/058-retire-pullfrog-agent.md) 删除（停用），其上表曾有的一行（`ANTHROPIC_API_KEY` 等 13 个模型 key）随之移除——这些 key 在仓库内已无消费方。仓库 Settings 里的同名 secret 建议维护者择期删除：不删也不会被任何工作流读取，属卫生而非风险；删除它们的操作在 GitHub 侧，本仓不代理。
>
> ⚠️ 2026-10-09 补：该移除**不可恢复、禁止重新启用**（[ADR-062](docs/adr/062-pullfrog-removal-irreversible.md)）。禁令已写死为机器判据——`scripts/verify-github-config.mjs` 的 `RETIRED_WORKFLOWS` 登记了该路径，文件重新出现即让 `verify:github-config` 报红。因此上表**不得**为它重新加回任何一行。
>
> ⚠️ 2026-10-15：`STEPFUN_API_KEY` 行**已删除**——`pr-agent.yml` 按 [ADR-065](docs/adr/065-retire-pr-agent-local-cli-review.md) 永久退役，该 key 在仓库内从此**零消费方**（AI 评审改走本地 CLI，凭据只存在于各人机器的 `~/.gito/.env`，**不进仓库、不进 CI**）。同样地：仓库 Settings 里该 secret 的删除是 GitHub 侧手工操作，本仓不代理；`pr-agent.yml` 已登记进同一张 `RETIRED_WORKFLOWS` 禁令表，重现即报红。
>
> 🔴 2026-10-15 补（同日）：上面那句「**不进仓库**」原本只是**约定**，而约定不是判据——`gito setup` 会落到 `<repo>/.gito/.env`，而本仓 `.gito/` 是**入库目录** ⇒ 一次误跑 `git add .gito/` 就是**明文密钥入库**（那个文件对 Gito **完全无用**：它只读 `$HOME/.gito/.env`，且把路径**显式**交给 `load_dotenv`，不在 cwd 搜）。现改为**强制执行**：新增嵌套 `.gito/.gitignore`（一行 `.env`），**刻意不编辑根 `.gitignore`**（根那份是 CRLF blob，编辑它必带 53 行纯 EOL 差异；嵌套文件是新文件、纯 LF ⇒ 同一保护、0 行噪音）。
> 复核判据（应打印 `.gito/.gitignore:23:.env`、退出码 0）：
>
> ```bash
> git check-ignore -v .gito/.env
> ```
>
> 反向对照（移开该文件后 `?? .gito/.env` 必须立刻出现）证明起效者唯一，不是别的全局规则。

### ⚠️ 本表**不覆盖**的两类暴露面（刻意写明，不冒充完备）

上表按标题所述只答「**哪个工作流读了哪个 secret**」。以下两类本仓已知的暴露面**不在它的范围内**，不要因为「表在这里且看起来完整」而以为它们被覆盖了：

1. **外部 GitHub App 的仓库读取面**。装在仓库上的托管 App 能读 diff / 代码而不经过任何 workflow，因此**不会让任何 secret 出现**，也就不会在本表里留下痕迹。实测（2026-10-15）：`coderabbitai[bot]` 与 `qodo-code-review[bot]` 均在本仓 PR 上产出过评审，两者在仓内**零配置**（配置在各自面板）；`gh api repos/.../installation` 需 App JWT，仓库侧读不到安装清单（实测 401）。
2. **应用自身的出网面**。产品侧的口径在「威胁模型」段（无遥测、Harness 仅 loopback、LAN 桥默认关闭），与本节说的是不同的事。

📌 第 1 条的登记方式尚未确定（需要一张新表 + 一条清单判据）；`ADR-065` 的「未闭合项」已如实登记，**不假装它已解决**。
