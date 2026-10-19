# ADR-065 — 退役 PR-Agent，AI 评审改走**本地 CLI**（Gito）；禁令写死为机器判据

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-15 |
| 唯一产地 | `.github/workflows/` 目录内容（`pr-agent.yml` 缺席即退役）+ `scripts/verify-github-config.mjs` 的 `RETIRED_WORKFLOWS`（禁令表，含 pr-agent 条目）+ `.gito/config.toml`（本地评审配置） |
| 修订 | ~~[ADR-054](054-ai-review-workflows-admission.md) 决策 1 / 4 / 5~~（本 ADR 修订之：`pr-agent.yml` 退役 ⇒ 那三条决策失去标的；决策 3 / 6 的**规则仍在役**，由 `gate -- github-config` 规则 B 与 ADR-005 承载）；~~[ADR-059](059-pr-agent-image-floating-and-command-gate.md) 全部决策~~（其标的即 `pr-agent.yml` 的触发面，随文件退役而闭合） |
| 关联 | [ADR-058](058-retire-pullfrog-agent.md)（停用 = 删除文件的判据来源）；[ADR-062](062-pullfrog-removal-irreversible.md)（禁令写死为机器判据的范式）；ADR-005（准入纪律：死配置要么接上要么删掉）；ADR-007（进不了仓库的状态不配称作决策）；ADR-030（日常零自动化的取舍形态）；`SECURITY.md`「CI 密钥暴露面」；`docs/dev-plan-defect-remediation.md` C1 / S0-3 |

## 背景

2026-10-15 维护者下达三条指令，其共同点是把 AI 评审从「仓库外/CI 内」收到「本机」：

1. **为本仓实现 Gito 本地 CLI 运行模式**——在本地命令行完成代码审查，不依赖远程服务；
2. **关闭 Qodo 的 PR 审核功能**——该 bot 存在调用次数限制；
3. **`pr-agent` 不予恢复接线**——它必须使用固定的供应商、无法自定义配置。

第 3 条是对 2026-10-15 同一日「先修 pr-agent 的 concurrency」这一建议的**显式否决**。因此本 ADR 不是「修一个坏工作流」，而是「把一条选错了的路线收掉」。

### 逼出这个决定的实测事实（全部为 `gh` 取证，非推测）

**一、`pr-agent.yml` 的自动评审在本仓从未成功过一次。**

`gh run list --workflow pr-agent.yml`（全量）：`pull_request` 事件 **8 次运行 = 7 cancelled + 1 failure，成功 0 次**；`issue_comment` 事件绝大多数 `skipped`（ADR-054 决策 4 的「sender 非 Bot」守卫**是对的、生效了**），另有 1 次 failure。

两个**相互独立**的缺陷：

| 缺陷 | 机制 | 实证 |
|---|---|---|
| A —— `concurrency` 自己吞掉自己 | `concurrency.group: pr-agent-${{ pull_request.number \|\| issue.number }}` 把 `pull_request` 与 `issue_comment` 归入**同一组**，配 `cancel-in-progress: true` ⇒ **第三方评审机器人发的 bot 评论会取消 pr-agent 自己的自动评审运行** | PR #9：run `38688040949` / job `116267321292` —— `started 05:40:24 → cancelled 05:40:27`，唯一一步 `Set up job` **未跑完即 cancelled**；而 qodo 的 bot 评论落 `05:40:23`、其触发的 `issue_comment` run 落 `05:40:25`（同组）。两个 `issue_comment` run 随后被 job 级 `if:` 判 `skipped` ⇒ **净结果：PR #9 零 pr-agent 评审** |
| B —— action step 失败 | 与 ADR-059 记录的同一形态（Docker action 的浮动镜像标签，SHA 钉不住真正执行的代码） | run `38406308031`（2026-10-13, PR #7）的步骤链：`Set up job` ✅ → `Build qodo-ai/pr-agent@10bbd9a4…` ✅ → **`PR Agent action step` ❌** → `Complete job` ✅ |

**二、真正在产出评审的两个机器人都不在仓库里。**

| 机器人 | 证据 | 配额状态 |
|---|---|---|
| `coderabbitai[bot]`（托管 GitHub App） | PR #8 多条 `COMMENTED`；PR #9 整篇 walkthrough + Pre-merge checks(5 passed) + Merge Risk；check 名 `CodeRabbit` 在 PR #9 为 `pass` | 「up to 1 included review per hour; **0 remain after this review**」；Autofix 需额外额度 |
| `qodo-code-review[bot]`（托管 GitHub App） | PR #8 多条 `COMMENTED`；PR #9 评论「**Qodo reviews are paused for this user.**」 | 已暂停 |

两者在仓内**零配置**（Glob `{.coderabbit*,.pr_agent*,.qodo*}` 无命中；CodeRabbit 自陈 `Configuration used: Repository UI`）。

⚠️ 这与 ADR-059 的「备选方案」直接冲突：该 ADR 明确**否决**过「改用 qodo 托管 App」，理据是「托管 App 不在本仓任何控制与审计范围内」——而它此后**被安装并产出了评审**。**裁决与现实脱节本身**就是本 ADR 要记下的事实之一。

**三、`SECURITY.md` 的暴露面表覆盖不到上面这一层。** 那张表只登记「Workflow → secrets」（当时 2 行：签名私钥 + `STEPFUN_API_KEY`），**不登记「哪些外部 App 能读本仓 diff」**。实测结果是两个 SaaS 在读 `patches/**`——即桌面定制对上游包的具体改法。

## 决策

1. **AI 评审改走本地 CLI（Gito），且不进 CI。**
   配置唯一产地：`.gito/config.toml`（**入库**，随仓库共享）；凭据唯一产地：`~/.gito/.env`（**机器本地，绝不入库**）。
   🔴 **「凭据在仓库外」此前只是约定，不是判据**——本轮补上强制面：Gito 只读 `$HOME/.gito/.env`（`constants.py:13`，且 `bootstrap.py:71` 把路径**显式**交给 `load_dotenv` ⇒ **不在 cwd 搜**），但 `gito setup` 在多处会落到 `<repo>/.gito/.env`，而本仓 `.gito/` 是**入库目录** ⇒ 一次误跑 + 一次 `git add .gito/` 即**明文密钥入库**，且那个文件**对 Gito 完全无用**。
   ⇒ 新增**嵌套 `.gito/.gitignore`**（只有一条规则 `.env`，位于该文件第 23 行）。**刻意不编辑根 `.gitignore`**：根那份是 CRLF blob，编辑器把整份文件重写成 LF 时必带 50 行纯 EOL 差异（见「已登记的仓库异常」）；嵌套文件是新文件、纯 LF ⇒ **同一个保护，0 行噪音**。
   取证（成对）：`git check-ignore -v .gito/.env` ⇒ `.gito/.gitignore:23:.env`（exit 0）；真实放入含哨兵值的 `.gito/.env` 后 `git status -uall` **不列它**、而 `config.toml` 仍被列（保护未过度）；**反向对照**：移开该文件 ⇒ `?? .gito/.env` **立刻出现** ⇒ 起效者唯一。
   判据进入模型的通道**只有一个**：`[prompt_vars].requirements`——本仓判据（唯一产地 / 禁止硬编码 / 协议类型 / INV-6 / 禁止伪造成功 / 禁止无声降级 / 「配置看着在、实际不生效」/ 门禁文档一致 / 版本号纪律）的**手工节选**，产地标注在段内。
   `exclude_files` 分两组：**A 组真实命中**（实测 86 个已跟踪文件，`vendor/**/lib/**` 占 80）+ **B 组纵深防御**（实测 0 命中，理由见「守卫与证据」）。
   使用入口登记在 `docs/commands.md` §28。

2. **删除 `.github/workflows/pr-agent.yml`。** 退役判据与 ADR-058 同构：**文件缺席即退役**（GitHub 只从 `.github/workflows/` 加载；UI 的 Disable 开关是服务器端状态、不进仓库、不可被门禁看见）。

3. **禁令写死成机器判据**（ADR-062 范式）：`RETIRED_WORKFLOWS` 新增 pr-agent 条目，**文件重新出现 ⇒ `npm run gate -- github-config` 报红**。正当出路是**另立新工作流**（新文件名 + 新 ADR），不是复活这个文件。

4. **顺带修掉通用函数里的条目专属事实。** `checkRetiredWorkflows` 的报错文本曾把 `13 个 provider key`（pullfrog 专属）**硬编码在通用函数里**——加第二条就必然**对着 pr-agent 说出一个假数字**。现改为逐条目字段 `exposure`。这不是顺手美化：它是「通用函数内嵌某一个条目的具体事实」这一类缺陷的样板，与本仓 `SECURITY.md` 按行记载、`dependabot.yml` 头注释与守卫分工是同一条纪律。

5. **`STEPFUN_API_KEY` 在仓库内从此零消费方** ⇒ `SECURITY.md` 暴露面表删除该行。仓库 Settings 里该 secret 的删除是 **GitHub 侧手工操作**，本仓不持有、也不代理任何 GitHub 凭据，agent 不代做（同 ADR-058 决策 4）。

6. **Qodo 托管 App 的关闭同样是 GitHub 侧操作**，本仓不代理。本 ADR 只负责把仓库侧的证据与口径写清楚；**不得**因为「已经决定了」而把服务器端状态记成仓库内事实（ADR-007）。
   **已核实的定位信息**（`gh api apps/<slug>` 是公开端点，不需要 App JWT —— 这正好补上「安装清单读不到」的缺口里**能读的那一半**）：
   | App | slug | 官方名 | owner | 页面 |
   |---|---|---|---|---|
   | Qodo | `qodo-code-review` | **Qodo Code Review** | `qodo-ai` | https://github.com/apps/qodo-code-review |
   | CodeRabbit | `coderabbitai` | `coderabbitai` | `coderabbitai` | https://github.com/apps/coderabbitai |
   ⚠️ 注意 App 的**展示名是「Qodo Code Review」**（不是 Qodo Merge、不是 Qodo）⇒ 在 `Settings → Applications → Installed GitHub Apps` 里按这个名字找；处置是 **Configure → Uninstall**（或只把本仓从授权仓库里摘掉）。**读得到的是「App 是什么」，读不到的仍是「它被装到了哪里」**——后者要 App JWT（`gh api repos/.../installation` 实测 401），所以第 3 条未闭合项仍然成立。

7. **ADR-054 与 ADR-059 被修订**，原文按库内惯例保留供追溯、不删改。

8. **不配 `aux_files`——它在 `gito review` 路径上不生效（源码级证伪）。**
   这是本 ADR 里**唯一一条把「看起来最像对的写法」判红的决策**，故单列。
   `aux_files` 在 Gito 文档与它自己仓库的配置里都存在，读起来就是「把仓库纪律喂给评审器」；实测**接不上**：
   - `gito/core.py::review()`（463–580）只有两处渲染提示词——499 行 `cfg.prompt`，以及 573 行**调用**的 `make_cr_summary()`（定义于 293–320，其 298 行渲染 `cfg.summary_prompt`）；两处变量表都只有 `**cfg.prompt_vars`，**没有 `aux_files`**（行号 2026-10-19 按本机 4.5.0 wheel 复核）；
   - 读 `aux_files` 的代码在 `core.py::answer()`（617–620），那是 `gito answer` / PR 评论问答这**另一条**路径；
   - 模板侧同证：`gito/tpl/partial/aux_files.j2` 只被 `answer.j2` 与 `questions/{release_notes,test_cases}.j2` include，**默认评审提示词不 include 它**。
   ⇒ 它**没有**任何配置层解法（连自定义 `prompt` 也不行——变量压根没进渲染上下文）。
   按 ADR-005 的准入纪律**不留死配置**：留着它会让人以为判据已经喂进去了，而模型一个字都没看到——这正是本仓最忌的形态。所以这里**不是「先配上、以后再说」，而是「配了就是缺陷」**。
   代价如实记账：`requirements` 里那份判据成了**重复产地**（手工节选 `AGENTS.md` §3/§7 与 `docs/version-policy.md`），没有门禁能盯住它漂移 ⇒ 登记为下方「未闭合项 4」。

9. **报告输出一律带 `--out .workbuddy/tmp`，并据此**不动** `.gitignore`。**
   `out_folder` 缺省是 `repo.working_tree_dir`（core.py:553）⇒ 报告的 `code-review-report.md` / `.json` 默认落在**仓库根**。本仓**没有**为它们加 ignore 规则，原因是踩到了一个更值得记的坑（见下「已登记的仓库异常」）：`.gitignore` 的 HEAD blob 是 **CRLF**，在 `core.autocrlf=true` 下**编辑器把整份文件重写成 LF 时**会带出 **50 行**纯 EOL 差异（原地保留 CRLF 追加 = `5 0` 零噪音，2026-10-19 受控复测；实测 `--numstat` `55 50`，`-w` 忽略空白后只剩 **5 行**真改动）。
   ⇒ 处置：用 `--out` 把报告导进**早已被忽略**的暂存目录（`.gitignore:28` 的 `/.workbuddy/`），**不新增任何 ignore 规则**；`exclude_files` 里那两条则降级为「忘了带 `--out` 又手一抖 commit 了」的保险。
   这条同时是一个**取舍记录**：本可以为两个报告文件去改 `.gitignore`，但那样会让 50 行 EOL 噪音混进一个无关变更——本仓刚在 PR #9 上以 hunk 为单位审查过提交，这个代价不值。

### 已登记的仓库异常（本轮发现，**未修**，等维护者裁定）

`.gitignore` 在 HEAD 里的 blob 带 **50 个 CR**（CRLF），而本仓**其余所有**跟踪文件都是 LF blob（同批实测：`AGENTS.md` / `SECURITY.md` / `docs/commands.md` / `scripts/verify-github-config.mjs` 的 HEAD blob 全为 0 CR）。在 `core.autocrlf=true` 下，这意味着**编辑器把整份文件重写成 LF 时**才会在提交里带出 **50 行**纯 EOL 差异（50 = 55−5 的纯 EOL 对；**原地保留 CRLF 追加 = `5 0` 零噪音**——噪音**有条件**，取决于编辑器是否整份回写）——判据：

```bash
git cat-file -p HEAD:.gitignore | tr -cd '\r' | wc -c   # 50（其余文件皆为 0）
git add .gitignore && git diff --cached --numstat .gitignore   # 55  50
git diff --cached -w .gitignore                                  # 只看真改动：5 insertions
```

⚠️ 注意**换行符匹配陷阱**：`grep -c $'\r'` 会退化成匹配空模式（恒等于行数），判 EOL 必须用 `tr -cd '\r' | wc -c`。
两条出路都成立，但必须有记录：**①** 一次性 `git add --renormalize .gitignore`（50 行差异只出现这一次，之后永不复现）；**②** 不动它，整份重写式编辑都要重新解释一遍那 50 行。本轮选了**绕开**（决策 9），把选择权留给维护者。

### 已登记的本机环境异常（本轮发现，**根因已定位到行**）

**本机 `pip` 的任何安装/下载命令都会静默卡死**——表现是「什么都没发生」，因此极易被误读成「还在下载」：

- **必要条件**：本机 `rustc` 由 **mise shim** 提供（`%LOCALAPPDATA%\mise\shims\rustc.EXE`，实测启动 **2.47 s**）；而 pip 每条安装/下载命令都会构造 `PipSession`，其 `user_agent()`（`pip/_internal/network/session.py:179-192`）在 `shutil.which("rustc")` 命中时执行 `subprocess.check_output(["rustc", "--version"], timeout=0.5)` ⇒ **必然** `TimeoutExpired`。
- **充分条件**：Windows 分支在超时后的清理里**再调一次** `process.communicate()`（`subprocess.py:565` → `_communicate` → `join`）；mise shim 是转发进程，shim 被 kill 后其派生出的**孙进程仍持有继承来的 stdout 写端** ⇒ 读线程永不 EOF ⇒ 永久阻塞。
- **反证（证明「慢」单独不成立）**：`~/.cargo/bin/rustc.exe` 实测 **0.70 s**，同样 > 0.5 s、同样走超时分支，但**不死锁**（它自身持有写端，kill 即释放）⇒ 充分条件落在 shim 的**进程转发结构**上。
- **取证**：`faulthandler.dump_traceback_later(25)` 抓到的栈逐帧为 `user_agent → check_output → run → communicate → _communicate → join`（+ `_readerthread`）；15 行最小复现（纯 stdlib）`check_output(["rustc", "--version"], timeout=0.5)` **卡死**，同调用 `timeout=10` 在 2.1 s **返回 OK**。
- **另一条独立硬证据（意外收获）**：先前被中断的一次 `pip install gito.bot` 其实**没有被真正终止**，其 `python.exe` 子进程作为孤儿持续存在 —— 复核时它已连续运行 **1 h 16 min**，日志**恒为 122 字节**（只有 `Using pip 26.1.2 …` 一行），**零推进**；杀掉子进程后父 shell 才拿到退出码。⇒ 与「永久阻塞」一致，且说明**掐断外层任务不会回收卡死的子进程**（排查残留时勿把它误当成活跃安装）。
- **同命令红→绿**（只差 PATH 里的一个目录）：

  ```bash
  pip install -v --no-index --no-deps --dry-run <whl>
  #   含 mise shims   → 卡死（exit 124，只打印 pip 横幅）
  #   剔除 mise shims → exit 0（正常三行输出）
  ```

- **处置**（本轮采用）：pip 命令前把 mise shims 从 PATH **摘掉**——不要整体替换 PATH，那会连带干掉 Git Bash 的 coreutils（`ls` / `rm` / `command` 全变 `command not found`）：

  ```bash
  export PATH="${PATH//\/c\/Users\/Administrator\/AppData\/Local\/mise\/shims:/}"
  ```

- ⚠️ **另一个陷阱**：pip 的输出重定向到文件时是**块缓冲**的 ⇒ **日志 0 字节能被误读成「下载中」**，别据此判断「在跑」。
- 📌 **本 ADR 先后写过两条错误结论，在此一并纠正**：① 「出口代理慢」——证伪（`--noproxy` 无效；`mirrors.aliyun.com` 的索引页实测 0.4 s 可达）；② 「判别变量是详细度（`-v`）」——证伪（当时那次 `-v` 成功，只因那个 shell 的 PATH 恰不含 mise shims；含 mise 时 `-v` 同样卡死，已复现）。

---

**② 本机（Windows）上 `gito` 的过滤器**不能按常规写法传**——**Click 会把整个 argv 做 glob 展开**（不是 gito，也不是 bash）：

- **根因定位到行**：`click/core.py:1535–1539`——取 `sys.argv` 时，若 `os.name == "nt" and windows_expand_args`（默认 `True`）就调 `_expand_args()`；而 `_expand_args`（`click/utils.py:649–666`）对**每一个** token 依次做 `os.path.expanduser` → `os.path.expandvars` → `glob.glob(token, recursive=True)`，**命中就替换成匹配到的真实路径列表，不命中才保留字面量**。Click 这么做是因为 Windows 的 shell 不做展开，它代为补偿——**对「值恰好是模式」的选项是致命的**。
- **症状**：`gito files -f 'scripts/**'` ⇒ `exit 2` + `Got unexpected extra arguments (scripts\changelog.mjs scripts\check-patch-applicability.mjs …)`（54 项）。`-f` 只吃掉第一个，其余全变成多余位置参数。
- **可用形态**：`--filter=scripts/**`（**单 token 带 `=`**）。理由：`glob.glob('--filter=scripts/**')` 匹配不到任何路径 ⇒ 原样保留 ⇒ gito 才真拿到模式。实测 `--filter=scripts/**` ⇒ `2 file(s)`、`--filter=docs/**` ⇒ `5 file(s)`、`--filter=scripts/**,AGENTS.md` ⇒ `3 file(s)`。
- 🔴 **短选项带 `=` 是坏的**：`-f=scripts/**` 传给 gito 的值是 `=scripts/**`（含那个 `=`）⇒ 实测 `filtered by =scripts/** --> 0 file(s)`。所以本机用过滤器**只能写长名** `--filter=` / `--filters=`。
- **红→绿成对取证**（同命令、同树，**只差走不走 argv 展开** ⇒ 据此排除「模式本身写错」这个替代解释）：

  ```bash
  gito files -f 'scripts/**'                                     # exit 2（Got unexpected extra arguments）
  python -c "import sys; from gito.cli import app; app(sys.argv[1:])" files -f 'scripts/**'
                                                                 # exit 0，filtered by scripts/** --> 2 file(s)
  ```

  第二条把 `args` **显式**传给 Click ⇒ 走 `core.py:1540` 的 `args is not None` 分支 ⇒ 跳过展开 ⇒ 模式生效。**同一模式在两种入口下给出不同结果，唯一变量就是 `_expand_args`**。
- ⚠️ 派生影响：**任何 argv token 里的 `$VAR` / `~` 在本机也会被展开**（`expandvars` / `expanduser`）；`--out .workbuddy/tmp` 之所以一直没事，只是因为该目录**恰好已存在**（glob 命中后替换回等值字符串）。
- 📌 **本条的教训与 pip 那条同形**：一次「红」被记成了工具缺陷，真因是**本机宿主层**（mise shim / Click 的 Windows 补偿）——而两者都**只在 Windows 成立**，Linux/CI 上不出现。这正是本 ADR 把本机异常单列成节的原因：**它们不是 Gito 的性质，不能写进「Gito 已知限制」去向上游报。**

## 备选方案与取舍

- **修 pr-agent 的 `concurrency`（一行改动）+ 查 3 秒失败**：**维护者否决**。修好也只是把一个**锁死单一模型供应商、评审配置不可自定义**的形态接回来，而本仓刚刚决定不要那个形态。技术上可行不等于值得做——这是本 ADR 唯一需要显式记账的取舍。
- **保留文件、注释掉 `on:` 或加永假 `if:`**：否决。GitHub 不加载没有 `on:` 的工作流，但文件还在、下一个人还要解释它；「停用」状态只存在于某台机器的一次编辑里，不可检索、不可复现（ADR-058 已就 pullfrog 否决过同一形态）。
- **只依赖 GitHub UI 的 Disable workflow / 直接删 secret**：否决。服务器端状态进不了 git，新克隆、CI、其他协作者都看不见（ADR-007）。
- **把 Gito 接成 `pull_request` 工作流**：否决，三条理由。① 新增三处 SHA 钉死义务（`checkout` / `setup-python` / `upload-artifact`，`PRE_EXISTING_FLOATING` 为空表 ⇒ 浮动 ref 一律报红）；② 新增一条 CI secret 暴露面并要在 `SECURITY.md` 登记；③ **Gito 自述它在响应 PR 评论时无法修改 `.github/workflows/` 下的文件**（GitHub 安全限制，官方明确不建议用 PAT 绕过）——而本仓的 PR 高频就是改 `workflows/` 与 `patches/`。收益只是「把本地就能跑的事搬到 CI 上跑」。
- **在 `.gito/config.toml` 里自定义整个 `prompt`，以便 include `tpl:partial/aux_files.j2`**：否决，**做不到**。`review()` 的渲染调用（498–506）根本没有把 `aux_files` 放进变量表，模板里 `{% if aux_files %}` 恒为假；要让它生效必须改 Gito 源码（上游可修：`review()` 应当像 `answer()` 那样读并传入）。另有一层独立代价：整份 `prompt` 抄进仓库会把提示词**按版本冻住**（Gito 明示全量副本后上游的提示词改进不再到达），而这份副本**没有任何门禁能发现它漂移**——用一个新缺陷换一个旧缺陷。
- **把 `aux_files` 配上「反正没坏处」**：否决。它不报错、不影响运行，**只是永远不生效**——这正是本仓 §7.1/决策 7 反复治的「配置看着在、实际不生效」。它会对着下一个读配置的人陈述一件假事。
- **改 `.gitignore` 加两行，把两个报告文件忽略掉**：否决（本轮）。功能上等价，代价是把 **50 行纯 EOL 差异**混进一个与它无关的变更里——本仓刚在 PR #9 上按 hunk 审查过提交，这么做的比值不划算。改用 `--out`（决策 9），零新增规则、零 EOL 噪音。
- **改用托管 SaaS 评审（CodeRabbit / Qodo 等）**：否决。ADR-059 已登记理据（不在本仓控制与审计范围内），且**实测两者都撞上配额**——CodeRabbit「0 remain」、Qodo「paused」。把评审能力建在一个会因额度而静默消失的外部依赖上，正是本仓最忌的形态。
- **两份 Qodo 面只关一半（只删托管 App、保留仓内 action）**：否决。维护者指令针对的是「Qodo 的 PR 审核功能」整体；且仓内那份**成功率为 0**，保留它只能得到持续的红 check。

## 后果

- **PR 上不再有仓内 AI 评审**：`pr_agent_job` 不再出现在任何 check 列表里，也不再亮出必然红/被取消的 check。评审能力移到本机。
- **评审不进 CI ⇒ 不影响任何发布门禁**（`ci.yml` / `smoke.yml` / `release.yml` 与 4 道 preflight 的判据一条未动）。
- **已登记的代价（不粉饰）**：本地 CLI 模式的**可追溯性弱于 PR 评论**——「审了什么、什么时候审的」只留在本机，PR 上没有记录，也没有任何门禁强制它在推之前被跑过一次。本仓接受这个代价，因为换取的是「不引入新的托管面与新的 secret」。这一取舍与 ADR-030「日常提交零自动化」同形：把成本换成「靠人记得」+ 一条明确的补偿动作。
- **`SECURITY.md` 暴露面表从 2 行回到 1 行**（只剩签名私钥）。⚠️ 但**识别出的缺口未闭合**：那张表依然不覆盖「哪些外部 App 能读本仓 diff」，而 `coderabbitai[bot]` 仍在读。本 ADR **不假装它已被解决**——它是一个待登记项，见下方「守卫与证据」末段。
- ADR-054 的决策 1/4/5 与 ADR-059 的全部决策失去标的，状态改为被本 ADR 修订（决策 3/6 的**规则仍在役**，由 `gate -- github-config` 规则 B 与 ADR-005 承载）；ADR-054 与 ADR-059 的原文保留。
- `verify-github-config` 的扫描基数变为「8 个 YAML / **4 个工作流** / 34 个 uses / 错放 0」。⚠️ **uses 计数不得与 ADR-058/062 记录的历史值直接相减**（那是本仓记录在案的同一条教训：2026-10-09 之后其它批次也改过它）。该守卫不依赖具体数量——只有「扫出 0 个」才报红。

- **评审范围被收窄到 457 个文件**（实测时 543 已跟踪 − 86 被排除；2026-10-19 复核 545 个，A 组仍 86），且**收窄的是「非本仓写的」那一部分**：上游编译产物 80、提交式 lockfile 2、根锁文件 2、历史 CHANGELOG 1、sourcemap 1。⚠️ **`harness-locks/**` 曾整目录排除，本轮改为只排 `harness-locks/*/package-lock.json`**——因为该目录里另有**发布台账 `dsh-releases.json`** 与**本仓自己钉的 `inputs.json`**，它们是判据产地，排除掉正好漏在本仓缺陷最密的地方（版本对齐）。这是一次**对首稿的自我纠错**，不是新增决定。
- **判据通道只剩一条**：`[prompt_vars].requirements`。所以它的内容质量直接等于评审质量；它**不是**权威产地（权威是 `AGENTS.md` / `version-policy.md`），见未闭合项 4。

## 守卫与证据

**真检查（成对取证，同命令同树、只差被测变量）**

| 状态 | 命令 | 输出 | 退出码 |
|---|---|---|---|
| 文件缺席（目标状态） | `node scripts/verify-github-config.mjs` | `退役工作流禁令：2 项在册 · 复活 0 项` | **0** |
| 文件被放回（注入缺陷） | 同上（`git checkout HEAD -- .github/workflows/pr-agent.yml` 后） | `复活 **1** 项` + `❌ .github/workflows/pr-agent.yml 又出现了` | **1** |

**自检**：`node scripts/verify-github-config.mjs --self-test` → **55 项通过**（2026-10-19 二审后 +1：报红必须**逐字**带回条目自己的 `exposure`——旧「配对反证」匹配的短语在 `why` 里也有，钉不住 `exposure`）。2026-10-15 那轮新增 6 项，其中三条是可伪证的：

- 「pr-agent.yml 重新出现必须报红」（假想分支，已如实标注——见下）
- 「报红必须点名**该条目自己**的 ADR 与日期（pr-agent ⇒ ADR-065 / 2026-10-15）」——实测通过，报错文本里**没有**出现 pullfrog 的「13 个 provider key」。**可伪证方式**：把 `item.exposure` 改回一句写死的话，本条与「不得串条目」必须变红。
- 「禁令表形状：每条必须自带非空 `exposure`」——钉住决策 4 的修法不退化。

⚠️ **如实分类一条夹具**：pullfrog 的夹具取自**真实历史**（它确实复活过一次，commit `d286f44`）；而「pr-agent.yml 重新出现」对 pr-agent 是**假想分支**——它从未复活过。本仓反对把假想分支当历史证据，故此说明写在脚本自检段与这里两处。它守的不是历史事件，而是**一个真实存在过的缺陷**（决策 4 的硬编码暴露面文本）。

**仓库侧证据**：`gh run list --workflow pr-agent.yml`（8 × `pull_request` = 7 cancelled + 1 failure）、`gh pr checks 9`（`pr_agent_job fail 3s`）、job `116267321292` 步骤表（仅 `Set up job` → cancelled）、run `38406308031` 步骤表（`PR Agent action step` failure）。

**Gito 配置面的取证（2026-10-15，**不需要模型 key**，故属「已验证」而非「待自证」）**

📌 **取证取自被测版本本身**：下列源码事实逐条在 **PyPI 已发布的 `gito_bot-4.5.0-py3-none-any.whl`**（93,947 B，解包 65 项）里复核，行号与 `main` 分支一致；`dist-info/entry_points.txt` 确认控制台命令为 `gito` / `gito.bot`。不拿开发分支的代码当被测版本的证据。

| 命题 | 判据 | 实测结果 |
|---|---|---|
| `exclude_files` 真的在评审路径上 | `review()` → `_prepare()`（392）→ `get_target_diff()`（335–353）→ `filter_diff(diff, config.exclude_files, exclude=True)` | ✅ 在路径上；且**过宽会响**（全部变更被排除时抛 `AllChangesExcludedError`，打印 `All changes belong to excluded files, nothing to review.`）——不是静默空报告 |
| 模式语义（`fnmatch`，不是 glob） | `filter_diff` 逐条调 `fnmatch.fnmatch(file.path, pattern)` | ✅ `**` 与 `*` **等价**（都跨 `/`）；**不含 `/` 的模式只匹配根目录同名文件**。⚠️ 直接证据是 `fnmatch.translate('docs/*') == translate('docs/**') == '(?s:docs/.*)\Z'` **逐字相同**——注入试验只能证明「`**` 跨 `/`」，**区分不了** `fnmatch` 与 glob（glob 的 `*` 也跨吗？在这种写法下不成立，故不能靠它下结论） |
| 🔴 `fnmatch` **两平台不等价** | `fnmatch.fnmatch` 内部先 `os.path.normcase`（win32 转小写 + `/`→`\`；POSIX 恒等） | 实测 `'SRC-TAURI/RESOURCES/x.txt'` vs `'src-tauri/resources/**'`：Windows **True** / POSIX **False** ⇒ 同一份模式在两平台结论不同，失效方向是**静默多排除**（本机少审文件）。本仓 `exclude_files` 模式与其命中路径**大小写逐字一致**（`CHANGELOG.md` 即含大写、模式为同一串）⇒ 现状不受影响，但这是「本机绿 ≠ CI 绿」的一个潜在产地 |
| `--filter` 的语义与可用形态 | `get_target_diff`：`filter_diff(diff, filters)`（345）**先** → `filter_diff(config.exclude_files, exclude=True)`（348）**后**；别名见 `cli_base.py:96–106` | ✅ **叠加而非覆盖**（同时命中两者仍被排除）；逗号分隔多模式（`core.py:229`）；全被排掉抛 `AllChangesExcludedError` 而非空报告。🔴 **Windows 上只有 `--filter=模式` 可用**，分开传的 `-f 模式` 会 exit 2（见「已登记的本机环境异常」②） |
| A 组命中数（对 `git ls-files` 实测，当时 **543** 个；2026-10-19 复核 545 个） | 逐条算命中 | `vendor/**/lib/**` **80** · `harness-locks/*/package-lock.json` **2** · `vendor/**/client/*.js.map` 1 · `package-lock.json` 1 · `Cargo.lock` 1 · `CHANGELOG.md` 1 ⇒ **合计 86** |
| **可伪证**：每条模式独立有效 | 去掉 `vendor/**/lib/**` 重算 | 总数 **86 → 6**，差值 **80** = 该模式命中数 ⇒ 不是「靠别的模式碰巧命中」 |
| B 组（8 个被 ignore 的目录 + 4 个临时目录） | `git ls-files` + `git check-ignore -v` | **命中 0**：这些路径 `.gitignore` 全部覆盖（`harness-deps/` `.gitignore:3`、`node_modules/` `:2`、`/target/` `:23`、`src-tauri/target/` `:7`、`src-tauri/resources/` `:8`、`src-tauri/gen/` `:9`、`dist/` `:12`、`out/` `:13`）⇒ branch diff **看不到**它们。⚠️ 故这一组**不是省 token 的手段**，只是防 `git add -f` / ignore 规则变更的保险。盘上实况：`target/` 68,877 文件 · `harness-deps/` 25,555 · `src-tauri/resources/` 13,815 · `node_modules/` 873，合计约 **10.9 万** |
| 另 2 条（`code-review-report.{md,json}`）**不属上表** | `out_folder` 缺省 = `repo.working_tree_dir`（core.py:553） | ⚠️ 这两个文件**默认落在仓库根、且未被 `.gitignore` 覆盖**（`git check-ignore` 实测对两者均无命中，**退出码 1**）⇒ 当时「命中 0」只是因为**还没跑过**。📌 **2026-10-15 已跑过，但该预测仍未被观察**：两次运行都带了 `--out`，仓库根至今**没有**这两个文件（`ls code-review-report.*` 为空）⇒ 仍属**源码级证据**，不是实测事实。处置见决策 9 |
| 🔴 `aux_files` 在 `gito review` 上失效 | 源码 + 模板 + CLI 三证（见决策 8） | ✅ 确认失效 ⇒ 本仓**不配**它 |

⚠️ **本条同时纠正了本 ADR 首稿的一处错误声明**：首稿写「`aux_files` 喂本仓纪律」「`exclude_files` 不排除会把整棵上游依赖树送进模型」。**第一句被源码证伪**；**第二句的理据被实测证伪**（那棵依赖树被 `.gitignore` 挡住，本来就不进 diff）。两句都已按实测改写——留着它们就是本仓 §7.1 要治的「声明与代码现实不一致」。

**未闭合项（刻意登记，不冒充已解决）**

1. `SECURITY.md`「CI 密钥暴露面」表**不覆盖外部 App 读取面**，而 `coderabbitai[bot]` 仍在读本仓 diff。要闭合需新增一张表 + 一条清单判据；本 ADR 不代做。
2. ~~Gito 的**模型调用路径从未在本仓跑通过**~~ ✅ **本轮已闭合**（2026-10-15）：按本机 DSH 用户层 `profiles/web/cordis.patch.yml` 的 `stepfun` provider（`displayName: 跃阶星辰`）生成 `~/.gito/.env` 后，`step-5-preview` 经 `https://api.stepfun.com/step_plan/v1` 真实返回 **`'OK'`**；并已跑成**第一次真实评审**——`gito review --out .workbuddy/tmp --filter=scripts/**` ⇒ `exit 0`、**0 次 429**、`**⚠️ 2 issues found** across 2 files`（**2/2 全覆盖、无跳过**）、231 s，抓出 **2 条三道相关门禁全部漏过的真缺陷**（`scripts/verify-github-config.mjs` 文件头规则计数与实际不符、`:973` 自检把「快照」当不变式；均已修）。
    ⚠️ **但仍不得把 `.gito/config.toml` 引用为「已接线能力」**（AGENTS.md §7.2）：2026-10-15 那次是 2 文件的部分覆盖；**2026-10-19 已补第一次全量评审**（PR #12：`--what 54baac0 --against e66f04c`，12 文件 / 19m6s / `processing_warnings=[]` 零跳过），但按本 ADR 决策它**不进任何 CI 档位**——「跑过」与「已接线」不是同一件事。
    📌 顺带登记一条**降级预警**：运行日志会刷 `WARNING: Can't resolve tiktoken encoding for 'step-5-preview'` ⇒ 该模型名不在 tiktoken 词表内、**token 计数走回落编码** ⇒ 与 `max_code_tokens` 有关的预算只是近似值（当前路径不传 `max_tokens`，故不影响评审结论）。
   **本轮补充的实测事实（顺带纠正了本 ADR 与 `docs/commands.md §28` 初版的一处说法）**：`gito review` 的**任何**形态——`--help` / `-h` / `help review` / 裸 `review`——都在打印帮助**之前**先校验凭据，无 key 时一律 **`rc=2`** + `LLM configuration error: LLM_API_KEY is absent.`。初版把 `gito review --help` 写成「不需要 key 的核对步骤」，**该说法是错的**（已改为 `gito files`）。免 key 的只有顶层 `gito --help` 与 `gito files`。
3. 两个托管 App 的**安装清单**在仓库内不可读（`gh api repos/.../installation` 实测返回 401，需 App JWT）⇒ 本 ADR 对其状态只能给行为证据，不能给配置事实。
4. **`[prompt_vars].requirements` 是登记在案的重复产地**：它是 `AGENTS.md` §3/§7 与 `docs/version-policy.md` 的手工节选，**没有任何门禁能发现它漂移**（Gito 是可选的本机工具，不在任何 CI 档位里）。当前只靠段内的一条注记与本节维持。要真正闭合，需要一条不依赖 Python 的离线判据（例如对 `requirements` 里出现的判据编号/关键词与那两份文件做交叉核对），本轮**未做**。
5. ✅ **`exclude_files` 的端到端取证——本轮已闭合**（原文为「本轮没做」）。原先的缺口是：本 ADR 只用「自己按 `fnmatch` 复算」证明模式语义与命中数，**比较器是我写的，不是被测对象**。闭合用的正是 Gito 自带的 `gito files`（`cli.py:302`，标了 `@runs_without_llm`，帮助文本原文 *Might be useful to check what will be reviewed if run `gito review`*）——它在**不接模型**的情况下打印本次会审的文件集。
   **实测**（基线 `Changed files: INDEX vs origin/main --> 15 file(s).`；同命令、同树、只差配置里插入的一行）：

   - 注入 `'AGENTS.md'` ⇒ **14** 个，`AGENTS.md` 消失，其余**逐字不变**；
   - 注入 `'docs/**'` ⇒ **10** 个，5 个 `docs/*` 全消失，`AGENTS.md` 仍在 ⇒ 顺带**端到端证实通配 `**` 跨 `/`**（与 `filter_diff` 的 `fnmatch` 语义一致）；
   - 两次注入后 `.gito/config.toml` `sha256[:16] = de90fa4e5a1b72fe` **字节级复原**。

   ⚠️ **夹具缺陷也做了成对取证**：首版夹具用 `ln[2:]` 直接解析，而 gito 在 stdout 上带 ANSI 颜色码（`- \x1b[34mAGENTS.md\x1b[39m`）⇒ 断言「含 AGENTS.md」**静默返回 False**（漏报，而不是报错）；加剥色后全绿。**「断言恒为假」比抛异常更难发现，所以这类夹具缺陷必须留证。**
   装机阻塞（当时被我误记为网络/代理问题）的真因见上方「已登记的本机环境异常」；`gito.bot-4.5.0` 已装成，`gito --help` 与 `gito files` 均实跑通过。
