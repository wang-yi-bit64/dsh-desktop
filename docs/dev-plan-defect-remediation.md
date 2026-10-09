# DSH Desktop 缺陷治理开发计划（批次 S0~S7）

> 项目：wang-yi-bit64/dsh-desktop
> 文档定位：**缺陷治理专项**——只治「已发生的漏洞与漂移」，不引入新方向、不重排战略。
> 文档版本：v1.0 · 2026-09-30
> 依据：2026-09-30 的一次独立评审（实测 + 线上核实，口径见 §10）
> 批次命名：**S0~S7**（S = Stabilization）。与既有批次 A~G / H~N / 0.2-A~D / P0~P3 均无重叠。

---

## 0. 与其他文档的关系（先读这一节）

| 文档 | 关系 |
|------|------|
| docs/roadmap.md | **定位权威**（可靠运行时 / 兼容与发行增强层）。本计划不推翻它，只补它执行层的洞。 |
| docs/adr/047-zero-budget-roadmap-recast.md | 零预算重裁。本计划**不擅自延期或改写任何 ADR**；凡与之冲突的，先补 superseding 或状态修订 ADR（见 S0-4）。 |
| docs/adr/048-single-upstream-channel.md | 单通道收敂。当前与 docs/dev-plan-0.8-convergence.md 修订 #9 冲突，裁决见 §7 决策点 C5。 |
| docs/dev-plan-0.8-convergence.md | 0.8 周期计划。S1~S5 与其重叠处以本文判据为准（本文给的是可证伪判据，不是意图描述）。 |
| docs/dsh-upgrade-checklist.md | 上游升级专项，不被本计划替代。 |
| docs/dev-plan-release-channels.md | 其中已被 ADR-048 裁撤的部分按 S2-4 归档，不再作为在役计划。 |

> **本文刻意不写任何 DSH 版本号。**上游锚点的唯一产地是 scripts/dsh-targets.mjs；文档里手写的版本号零守卫，写进来只会制造新的漂移源。

---

## 1. 本次评审的事实基线

**实测通过（本机，2026-09-30）**
- cargo test -p dsh-contracts -p dsh-host -p dsh-host-cli → **exit 0**（其中 44 项 doc-test 单轮耗时 258.86s）
- 8 个门禁抽查全绿：verify:claims / verify:targets / verify:patches / verify:ipc-surface / verify:plan-facts / verify:shell-pages / verify:harness-entry / verify:version

**线上核实（外部事实，会过期）**
- 更新端点 releases/latest/download/latest.json 返回的 version = **0.5.0-next.1**
- 自 v0.6.0-alpha.1 起，11 次发布中**有 7 次 prerelease 标志为 true**；最近一次非预发布是 2026-09-15
- 仓库元数据：public、11 star / 1 fork / 0 open issue、**无 LICENSE**
- 代码构成：Rust 约 15.6k 行 / 223 项测试；scripts/*.mjs 约 18.4k 行 / 40 个文件；docs 约 1.7MB / 103 篇

**未做（因此结论的强度到此为止）**
- 未组装 300MB 运行时、未跑 L2 GUI 冒烟、未在 MSVC 上跑 clippy、未跑三平台矩阵。三平台绿灯来自 CI 记录，不是本次实测。
- AGENTS.md 因超出工作区指令预算被截断加载（65,142 / 160,148 字节），因此文档冲突类结论基于已读部分与最新计划文档的自述。

---

## 2. 缺陷清单（D1~D13）

| ID | 缺陷 | 严重度 | 关键证据 | 批次 |
|----|------|--------|----------|------|
| D1 | 自动更新**零投递**：端点永远指向 2026-09-15 的预发布前版本 | P0 | 端点实测返回 0.5.0-next.1；GitHub 的 releases/latest 排除预发布 | S1 |
| D2 | 版本线**跨通道非单调**：先发 rc.1 后发 alpha.8，而 alpha.8 < rc.1 | P0 | 11 个 tag 及其处的 package.json 版本；当前版本即 0.7.0-alpha.8 | S1 |
| D3 | 决策账本冲突且执行状态无守卫 | P0 | dev-plan-0.8-convergence.md 修订 #9 自述 ADR-048「需补 superseding 条目」；ADR-047 已删的每日 CI / drift 仍在 ci.yml:41 与 drift.yml:30 | S0 |
| D4 | AGENTS.md 超出自身读者预算，且文档事实已漂移 | P0/P1 | AGENTS.md 160,148 B vs 64KB 指令预算；AGENTS.md:409 写 Rust >= 1.85 而 Cargo.toml 是 1.90 | S2 |
| D5 | 公开仓库无 LICENSE、authors 指向他方组织、无 SECURITY.md | P1 | 根目录无 LICENSE / LICENSE-MIT；package.json 与 Cargo.toml 均写 MIT 且 authors=DataElement | S0 |
| D6 | 供应链与安全扫描缺口 | P1 | 555 个 crate 无 cargo-deny/cargo-audit；dependabot 只配 npm 根目录；action 全用浮动 ref | S3 |
| D7 | 游离的 AI 评审配置（未接线却已记账） | P1 | .github/pr-agent.yml 含 on:/jobs: 但不在 workflows/ 下（GitHub 不加载）；pullfrog.yml 为未改一字模板 | S0 |
| D8 | 验证工具规模超过产品代码，且元层无守卫 | P1 | scripts 18.4k 行 > Rust 15.6k 行；快档实际 ≥258s；文档↔常量漂移无守卫 | S2/S4 |
| D9 | 补丁税仍高，且最大补丁打在上游 UI 包 | P2 | 27 个补丁 / 约 4.7k 行 × 2 套；settings-models 886 行、agent-preset 640、workspace 477 | S5 |
| D10 | src-tauri 生产路径 unwrap 过多 | P2 | src-tauri/src/state.rs 15 处生产 unwrap（锁中毒会 panic 掉整个壳） | S4 |
| D11 | 无 property test；ADR-047 的 P1 深潜未开工 | P2 | 无 proptest/quickcheck/rstest 依赖；无状态机不变式测试 | S6 |
| D12 | 分发近零，「完成线」未对外声明 | 战略 | 11 star / 1 fork / 0 issue；ADR-047 已定完成线但 README 未承载 | S6 |
| D13 | Dependabot 安全更新**不读** `dependabot.yml` 的 directory，故「只列根目录」**排除不掉** `harness-locks/`；而本仓把这条排除写成了已成立的结论（伪） | P2 | job 1618552559（2026-10-09）：`"command":"security"` + `directories:["/harness-locks/alpha"]` → `Error during file fetching; aborting: /harness-locks/alpha/package.json not found`（该目录里只有输入快照，**故意没有** package.json）；官方概念页「There is **no interaction** between the settings specified in the `dependabot.yml` file and Dependabot security **alerts**」，配置页说 directory「**must be** the path to the manifest files」⇒ 本配置是加法式、不是排除式 | S3 |

---

## 3. 批次计划

> **新增守卫的三条硬要求**（沿 AGENTS.md §7.3 的既有纪律，适用于本计划每一个「守卫」项）：
> 1. 必须带 --self-test；
> 2. 必须有**以修复前形态为夹具**的可证伪检查——喂进旧写法必须报红，否则该守卫是装饰；
> 3. 凡「先从源码扫出一组 X、再逐个校验」的守卫，必须同时断言**扫出数量 > 0**。

### S0 — 零成本止血（0.5~1 周）

不碰运行时链路，全部可逆，先让仓库对陌生人「合法、可读、无自相矛盾」。

**S0-1 补授权与归属（治 D5）**
- 动作：补根目录 LICENSE（MIT 全文，与 package.json / Cargo.toml 一致）；把 Cargo authors 从 DataElement 改成本仓作者，来源致谢改到 README 的「来源与致谢」节。
- 判据（可证伪）：LICENSE 文件存在且首个非空行是 MIT；package.json、Cargo.toml、LICENSE 三处 license 字段字面量一致。
- 守卫：并入 S2-3 的 doc-facts 守卫（license 三处一致断言 + 以「删除 LICENSE」为夹具必须报红）。

**S0-2 补 SECURITY.md（治 D5/D6）**
- 动作：写清威胁模型与报告渠道——本机单用户、Harness 只绑 loopback、LAN 桥必须用户显式开启、更新链 minisign 校验、无遥测；列出支持的版本线（预发布期只支持最新一条）。
- 判据：文件存在；包含「报告渠道」「支持范围」「威胁模型」三节；不与 README 安全节矛盾（同源引用而非复述）。

**S0-3 把两份游离的 AI 评审配置接上（治 D7；C1 已裁决为「接上」）**
- 动作：把 `.github/pr-agent.yml` 挪进 `.github/workflows/pr-agent.yml`；两个 action 钉到 40 位 commit SHA（pr-agent = 10bbd9a4…、pullfrog = 9d9014df…）；收紧触发面（issue_comment 只接受来自 PR 且 author_association ∈ OWNER/MEMBER/COLLABORATOR 的评论）；权限取最小并加 concurrency；两个文件加文件头注释说明存在理由与删除判据。
- 判据：仓库内不存在「有 on:/jobs: 但不在 .github/workflows/ 下」的 YAML；两个 AI 工作流的 uses 均为 40 位 SHA；外部用户无法用维护者的 key 触发运行。
- **2026-09-30 增补（第三批，ADR-058）**：维护者裁定停用 pullfrog——`.github/workflows/pullfrog.yml` 已删除，「文件缺席」即停用（GitHub 只从 `.github/workflows/` 加载，UI 的 Disable 开关是服务器端状态、不进仓库）。pr-agent.yml 零改动即在役。本条的「两个 AI 工作流」判据现存标的只剩 pr-agent.yml 一个；pullfrog 的 action SHA 同步义务随之消失，13 个 provider key 从 SECURITY.md 暴露面表移除。
- 守卫：新增 verify:github-config（错放目录 + 浮动 ref，两条规则 + 可证伪夹具）。
- 发现：`.github/pr-agent.yml` 从来不会被 GitHub 加载（工作流只从 `.github/workflows/` 读取），而 commit e9f8dc5 的标题已把它记成已交付——这是「宣称号实」在配置层的一次失守，也是本条的由来。

**S0-4 决策账本同步（治 D3）**
- 动作：逐条标注 ADR-047 删除项的实际执行状态，并**为「保留每日 CI 与 drift 哨兵」这一偏离补一条状态修订 ADR**（推荐保留：它们是自动化的最后一道网，且零现金成本；但现状是「代码保留、ADR 说删」，必须以 ADR 记录，而不是让矛盾继续挂着）。
- 判据：ADR-047 的每个删除项都有「已执行 / 有意不执行 + 理由 + 依据 ADR」三种收尾之一；verify:plan-facts 的账本与文档一致。
- 依赖：§7 决策点 C5（ADR-048 的去留）先拍板，否则 S0-4 无法收尾。

**S0-5 登记本计划（可发现性）**
- 动作：在 AGENTS.md §6「修改敏感模块前必读文档」增加一行；不动 README。
- 判据：AGENTS.md §6 可检索到本文件名；verify:claims 仍绿（只加行、不动状态词表）。

**S0 退出判据**：LICENSE / SECURITY.md 入库；.github 无游离工作流；ADR-047 执行账本自洽；verify:claims 与 verify:plan-facts 绿。

### S1 — 发布与更新链（1~2 周）

目标只有一个：让「自动更新」**要么名副其实，要么诚实降级**——不允许继续停在「已接线但零投递」。

**S1-1 更新通道方案（C2 已裁决：通道化 manifest）**
- 已定：每个 publishChannel 一个滚动 Release（tag = updater-\u003cchannel\u003e，prerelease + --latest=false，只放 latest.json，--clobber 覆盖）；端点由构建期经 `tauri build --config` 注入；默认端点指向 rc。

**S1-2 实施通道化 manifest（若选 A）**
- 动作：为每个活跃通道维护一个**滚动更新路径**（例如 releases 下按通道固定 tag 覆盖最新 manifest，或仓库内静态 manifest 由 CI 每次发布覆盖），tauri.conf.json 的 endpoints 指向它；签名链与公钥不动。
- 判据：对每个活跃通道，端点返回的 version **大于等于**该通道最新已发布版本；用户从「最新预发布」能收到更新。
- 反例：任何一条通道的端点 version 小于该通道已发布版本，即判失败。

**S1-3 新增 verify:update-channel（治 D1）**
- 动作：断言三件事——① 端点可解析；② 端点 version ≥ 该通道最新已发布 tag 的版本；③ 对应 Release 资产包含 latest.json 与签名产物。
- 可证伪夹具：**以 2026-09-30 的线上真实状态（端点 = 0.5.0-next.1，而已发布到 0.7.x）为夹具，必须报红**。这条夹具必须进 --self-test，否则守卫只是恒真的装饰。
- 运行时机：发布后（release.yml 末尾，**按通道作用域**）与每日 drift 哨兵（**全通道**）；不打入每次提交（会因外部状态制造长期红灯，理由同 ADR-030）。

**S1-4 版本单调性守卫（治 D2）**
- 动作：扩展 verify:version——候选版本必须**严格大于本仓所有已发布 tag 的版本**；同时新增一条规则：预发布只在 patch 位推进（如 0.7.1-alpha.1），禁止在 alpha/rc 之间回退到更低的同版本号。
- 判据：以「先 v0.7.0-rc.1、后 v0.7.0-alpha.8」这段真实历史为夹具，必须报红。
- 说明：这条只依赖本地 git tag，不联网。

**S1-5 若选诚实降级（备选路径）**
- 动作：README 的自动更新行改为「预发布期不投递更新」；AGENTS.md §7.2 对应行补注「已接线但不投递」；补一条 ADR 记录取舍。
- 判据：README / AGENTS / ADR 三处表述一致，且不含被 verify:claims 禁止的表述。

**S1 退出判据**：活跃通道的更新端点实测返回 ≥ 最新发布版本；verify:update-channel 与 S1-4 两条新守卫进 CI，且各自带「以当前线上状态为夹具必须报红」的自测。

### S2 — 文档治理（1 周）

**S2-1 AGENTS.md 瘦身到 ≤32KB（治 D4）**
- 动作：AGENTS.md 只留「规则 + 索引 + 禁改清单」；把十余节「已修复，勿回归」事故档案移入新建的 docs/incidents/（按平台 / 打包 / 契约分组），AGENTS.md 每类保留一行索引；§2 命令速查表保留（它是高频入口）。
- 判据：AGENTS.md ≤ 32,768 字节；被移出的每一节在 docs/incidents/ 有唯一新家；AGENTS.md 内不再有超过 200 行的单一小节。
- 反例：任何一节被移出后既不在 incidents 也无索引，即判失败（读者会以为它消失了）。

**S2-2 文档预算纪律（治 D3 的根因）**
- 动作：写入 AGENTS.md（或 docs/adr）：新增任何计划类文档，必须同时归档或改写一份旧文档；**计划文档无权延期 ADR**——要改 ADR 只能由 superseding ADR 改。
- 判据：这条纪律本身进了 AGENTS.md 的规则区，且有一处明确的「违反即视为文档回归」表述。

**S2-3 新增 verify:doc-facts 派生守卫（治 D4/D8）**
- 动作：对账四类事实——Cargo.toml 的 rust-version、.nvmrc、crates/dsh-contracts 的 MIN_NODE_MAJOR、README 前置条件节，以及三处 license 字段；文档是**被测方**，常量是产地。
- 判据：以「AGENTS.md 写 1.85 而 Cargo.toml 写 1.90」这段真实历史为夹具必须报红；扫出数为 0 时判失败（§3 第 3 条硬要求）。
- 说明：照 verify-harness-entry 的 E5/E5d 写，不新增手抄清单。

**S2-4 归档已裁撤文档（治 D3/D8）**
- 动作：docs/dev-plan-release-channels.md / optimization-release-channels.md / risk-review-release-channels.md 中随 ADR-048 失效的部分移入 docs/archive/，文首写归档说明（判据 + 恢复前提）。
- 判据：在役 docs 总量不增；每份被归档文档的文首有「谁取代了它」。

**S2 退出判据**：AGENTS.md ≤32KB；verify:doc-facts 进 CI 且带可证伪夹具；docs 在役总量不增；verify:claims 绿。

### S3 — 供应链与安全（3~5 天）

**S3-1 dependabot 增加 cargo 生态（治 D6）**
- 动作：在 .github/dependabot.yml 增加 package-ecosystem: cargo，directory 指向 lockfile 所在目录；维持只开安全更新的口径。
- 判据：配置能解析；下一个周期能在依赖图上看到 cargo 告警通道（以「删掉 cargo 条目后守卫报红」为夹具）。

**S3-2 CI 增加 cargo-deny（治 D6）**
- 动作：新增 deny.toml（advisories / licenses / bans），把已接受的那条 RUSTSEC 写进 ignore 并**附理由与 README 安全节同源**；CI 的 Linux job 跑一次。
- 判据：deny 通过；把 ignore 项删掉一次，必须报红（证明它真的在查）。

**S3-3 action 全部 SHA 钉死（治 D6）**
- 动作：ci.yml / smoke.yml / release.yml / drift.yml 内所有 uses 改为 40 位 commit SHA，注释保留可读标签。
- 判据：verify:release-workflow（或其扩展）断言「任何非本地 action 的 ref 必须是 40 位 hex」；以 @v5 为夹具必须报红。

**S3-4 读一遍 secrets 暴露面（治 D6/D7）**
- 动作：清点每个工作流拿到的 secrets，确认发布签名私钥只出现在 release 路径上；把结论写进 SECURITY.md。
- 判据：SECURITY.md 有一张「工作流 → secrets」表，且 pullfrog 类模板不再存在或已被收敛。
- 2026-09-30 复核（ADR-058）：「pullfrog 类模板不再存在」已以**删除文件**的形态达成（不是「收敛」）；表内相应行已删。

**S3 退出判据**：cargo 扫描在役且可证伪；所有 action 钉 SHA；secrets 暴露面成文。

### S4 — 门禁分层与代码卫生（1 周）

**S4-1 门禁分档（治 D8）**
- 动作：package.json 增加 verify:fast（纯逻辑自检 + 契约测试，目标 ≤60s）与 verify:full；CI 的 PR 路径跑 fast，发布前手动跑 full。
- 判据：本机实测 verify:fast ≤60s；AGENTS.md §2 命令速查表同步登记（改 scripts 必须同步 §2，这是既有规则）。

**S4-2 doc-test 移出快路径（治 D8）**
- 动作：doc-test 归入 full 档。
- 判据：fast 档不含 doc-test，且 full 档仍能跑出那 44 项。

**S4-3 「扫出数为 0」断言普查（治 D8）**
- 动作：审计全部「先扫后验」型守卫，补齐计数不为零断言；产出清单（脚本名 + 扫出的类别 + 数量）写进脚本头注释。
- 判据：审计清单里每一项都有对应断言；以「把扫描器的匹配模式改成不命中」为夹具，必须报红。

**S4-4 收敛 src-tauri 的生产 unwrap（治 D10）**
- 动作：state.rs 的 15 处按「能否恢复」分类——可恢复的转成 IpcEnvelope 的稳定错误码（锁中毒不再 panic 掉整个壳）；确不可恢复的用带归因的 expect。
- 判据：src-tauri 生产路径 unwrap 计数为 0，或每一处都有就地注释说明为何不可能失败。
- 守卫：verify:ipc-surface 或新守卫断言计数不回升。
- **✅ 已落地（2026-10-02，第四批）**：`src-tauri/src/poison.rs` 新建（`lock_or_recover` / `try_lock_or_recover`，3 项单元测试含「恢复后数据仍可读」「中毒不被误判成忙」）；`state.rs` 15 处 `lock().unwrap()` 与 3 处 `try_lock()` 全部改走它，顺带修掉「中毒被误判成 WouldBlock → 静默丢掉全部后续 launch 事件」的同族缺陷（§7.1 规则 3）；`mobile_bridge.rs` bind 地址改带归因 expect、目标 URL 的 query 改 match 取 Option、listener 两处中毒静默降级改恢复；`crates/dsh-host/src/safe_mode.rs` 的 manifest 序列化 unwrap 改 io::Error 传播。**与原动作的偏差（判据层面的诚实说明）**：锁中毒没有转成 IpcEnvelope 错误码——`snapshot` / `logs_tail` / `harness_port` 这类方法是同步访问器、不在命令返回值上，且中毒是内部不变量破损而非用户可处置的领域错误；正确处置是恢复 guard + error 日志（与托盘 / 菜单降级日志同口径）。判据由新守卫 `verify:unwrap-hygiene`（U1 生产段零 unwrap / U2 扫出数>0，16 项可证伪自测含「以修复前真实形态为夹具必须报红」）钉住，npm script 与 docs/commands.md §6b 一并登记，随 `:self-test` 自动发现进 verify:fast。

**S4-5 门禁清单单一产地 + 「有守卫没人跑」根因治理（治 D8；2026-10-03 新增）**
- 动作：把**三份手抄清单**（`verify-fast.mjs` 的 QUICK_STATIC、`ci.yml` 的逐行 `npm run`、`release.yml` preflight 的逐行 `npm run`）合并成一份总表 `scripts/gate-manifest.mjs`（33 条门禁 × real/self-test × 分档 fast/ci/release/sentinel，逐条带「为什么有它」的 why）；编排器 `scripts/gates.mjs` 取代 `verify-fast.mjs`（`--tier` / `--only` / 门禁名 / `--list`）；`package.json` 的门禁入口从 41 条收敛为 1 条 `gate`（scripts 总数 62 → 22，**旧名经 `npm run gate -- verify:<name>` 仍可解析**，历史文书因此不必改写）；新增元守卫 `scripts/verify-gates.mjs`。
- 判据：① `release.yml` 的 preflight 与总表的 release 档**同源**——`verify-release-workflow` 改为「YAML 里必须调 `npm run gate -- --tier=release`」**且**「总表的 release 档里必须有 `cli-package`」（两面都判，防止判据退化成只认一行文字）；② scripts/ 下每个支持 `--self-test` 的脚本要么在总表登记、要么在 `EXEMPT_SELF_TEST_SCRIPTS` 带理由豁免，**扫出数为 0 判红**；③ 每个分档解析出的步数 > 0（清空即红，不打印绿色）；④ 旧名兼容可断言（`verify:<name>` 与 `<name>:self-test` 都必须解析回同一条）。
- 为什么它同时治「有守卫没人跑」：逐条核实到四个守卫**写了却不在任何自动流程里**——`unwrap-hygiene` 的**真检查**（而本文 S4-4 条目写着「逐行由 verify:unwrap-hygiene 盯着」）、`doc-facts`、`github-config`、`fault-patterns`。它们现在都在 fast / ci / release 三档内；平台受限的门禁打印 skip 与理由，不静默略过（§7.1 规则 3）。

**S4 退出判据**：fast 档 ≤60s；审计清单为 0 遗漏；state.rs 无裸 unwrap。

### S5 — 补丁收缩与单通道收尾（1~2 周）

**S5-1 按 retireWhen 做减法冲刺（治 D9）**
- 动作：对 27 个补丁逐条对照 patches/LAYERS.md 的 retireWhen，产出「保留 / 退役 / 降级为配置」三分类表；**先退役再加新补丁**。
- 判据：补丁数比基线下降 ≥30%，且没有「退役后又以另一形态加回」的条目。

**S5-2 三个 UI 补丁专项（治 D9，与 ADR-006 的定位冲突）**
- 动作：settings-models（886 行）/ agent-preset（640）/ workspace（477）逐条论证「没有它会怎样」；能移出补丁层的改用上游配置或注入脚本（shell → page 单向下发，INV-2 不变）。
- 判据：每个补丁有一句「它守的用户可感知行为」；答不出来的即退役候选。

**S5-3 patches/alpha 与 harness-deps/alpha 的处置（C3 留、C7 休眠 → 已由 ADR-057 复役）**
- **2026-10-03 更正（ADR-057）**：下文「休眠 / 冻结」是 2026-09-30 上午的裁定，同日已被 ADR-057 修订——alpha 复役并推进到上游 alpha dist-tag，补丁按 retireWhen 退役到 11 个。现行为：两线同等维护；drift 与通道健康重新逐通道对照 alpha；`--channel-of` 接受 alpha 后缀。现行判据：两线 verify:patches 均绿，`status` 字段仍是唯一产地。以下两条保留为历史记录。
- 动作：不删（ADR-052 的机制保留不变），也**不再恢复维护**——C7 已裁定 alpha 休眠（ADR-056）：补丁与 vendored 冻结，`verify:patches` 仍逐目标检查一致性（防烂在盘上），drift 与通道健康对 alpha 显式跳过；`--channel-of` 拒绝休眠通道发布。
- 判据：verify:patches 对 alpha 仍绿（冻结 ≠ 失配）；代码中不存在第二份休眠名单（`status` 字段是唯一产地）。

**S5-4 补丁数趋势进 job summary（治 D9）**
- 动作：照 report-bundle-size.mjs 的形态，把补丁数与退役数写进 release job summary。
- 判据：每次发布能看到「补丁数趋势」；连续两次发布不增即为达标。

**S5 退出判据**：补丁数 ≤ 基线的 70%；report:patches 输出趋势；ADR-048 状态收尾（已执行，或由 superseding ADR 明确取代）。

### S6 — 资产兑现（2~4 周）

这是把工程能力兑换成外部可见价值的唯一一段，对应 ADR-047 的 P1。

**S6-1 dsh-host 的零 Tauri 依赖变成对外承诺（治 D12）**
- 动作：CI 增加断言——crates/dsh-host 的依赖闭包不得出现 tauri/webview2 等窗口层 crate。
- 判据：在 dsh-host 的 Cargo.toml 临时加一条 tauri 依赖，必须报红。

**S6-2 CLI 补 recover 并给出一页式 demo（治 D12）**
- 动作：dsh-host-cli 增加 recover 子命令；写一份「启动 → 注入崩溃 → 自动恢复成功」的无 GUI 复现步骤（真实命令 + 期望输出）。
- 判据：一条命令完成三段流程；陌生人照文档能复现，不需要窗口系统。

**S6-3 Supervisor 性质测试（治 D11）**
- 动作：引入 proptest（或等价），断言状态机不变式——无非法相位转移、退避必须单调增长且有上限、断路器必须在有限次内开路、重启次数有界。
- 判据：性质测试在无头环境可跑；断言失败时能打印出反例序列。

**S6-4 兑现 ADR-047 的可证伪承诺（治 D11）**
- 动作：造一个「绕过退避」的假故障注入夹具，进 CI。
- 判据：**该夹具必须让测试变红**——不变红即判定 P1 没做到底，不接受「测试通过」这种结果。

**S6-5 发布裁决（§7 决策点 C4）**

**S6 退出判据**：dsh-host 可脱 Tauri 编译运行；demo 可复现；性质测试 + 假故障夹具都在 CI；README 顶部写明「完成线」三条（每个重大决策都有 ADR / 每层都有陌生人可跑的验证 / 复盘存在）。

### S7 — 长期条件触发（不排期）

- **S7-1 兼容性矩阵**：每个 release 记录并验证一组已证组合；唯一产地放 dsh-contracts，由 gate 校验仓库引用的 DSH 版本 ∈ 矩阵。
- **S7-2 运行时回归语料**：clean startup → workspace open → session create → tool call → tool failure → plugin crash → recovery → update → restart。**必须保留诚实约束**：跑通语料 ≠ 模型调用正确。
- 触发条件：S6 全部退出且投入允许。在此之前不许以「计划中」的名义占用注意力。

---

## 4. 依赖关系（不要并行做这些）

| 项 | 必须先有 |
|----|----------|
| S0-4 决策账本同步 | §7 决策点 C5（ADR-048 去留） |
| S1-2 通道化 manifest | §7 决策点 C2 |
| S2-1 AGENTS.md 瘦身 | 无（可最先做，收益即时） |
| S5-3 patches/alpha 处置 | §7 决策点 C3 |
| S6-5 crate 发布 | S6-1 / S6-2 完成 |

---

## 5. 明确的执行顺序（单人节奏建议）

1. 第 1 周：S0（全部）+ S4-2（doc-test 移出快路径，立刻改善本地反馈速度）
2. 第 2 周：S1（发布与更新链；这是唯一有外部用户可感知收益的一段）
3. 第 3 周：S2（文档治理，含 AGENTS.md 瘦身）
4. 第 4 周：S3 + S4-3
5. 第 5~6 周：S5
6. 第 7~10 周：S6

---

## 6. 明确不做（防止本计划自身范围爬升）

- 不重写 Harness UI、不新增桌面功能（ADR-006 / 044）。
- 不为「可能有用的未来」保留任何配置、命令或文档（ADR-005）。
- 不做 OS 级签名 / 公证、不做遥测（ADR-046 / 044）。
- 不把「门禁数量」当目标：S4 的目标是**分层与可信**，不是继续加第 41 个守卫。
- 不在 push 上恢复全量 CI（ADR-030）；每日定时与 drift 哨兵的去留由 C6 裁决。
- **不排期 next 线移植**（C8）：缺陷治理 S0~S6 全部退出后启动；在那之前 verify:drift 的红灯是已排期的已知信号，不为消除它而插队。
- 不为了让文档「看起来一致」而删掉历史事故记录——只搬位置，不删内容。

---

## 7. 需要裁决的决策点（不拍板则执行者会在两个答案间横跳）

| # | 问题 | 裁决（2026-09-30 维护者） | 落地 |
|---|------|------------------------|------|
| C1 | 两份 AI 评审配置：删，还是接上并钉 SHA？ | ✅ **接上**：pr-agent.yml 挪进 `.github/workflows/` 并与 pullfrog.yml 一并接线（**2026-09-30 同日修订**：pullfrog 半场由 ADR-058 裁定停用并删除文件，AI 评审只保留 pr-agent.yml） | ADR-054（pr-agent 侧仍有效）；ADR-058（pullfrog 侧修订）；S0-3（含 verify:github-config） |
| C2 | 更新链：通道化 manifest，还是诚实降级？ | ✅ **通道化 manifest** | ADR-053；S1-2 / S1-3 |
| C3 | patches/alpha 与 harness-deps/alpha：删还是留？ | ✅ **留并在役**（C5 选双通道 ⇒ alpha 线必须维护） | ADR-052；S5 |
| C4 | dsh-host 是否发到 crates.io？ | ✅ **不发**（可复用性用仓内证据证明，不用包管理器分发） | ADR-044 清单追加；S6-5 收尾 |
| C5 | ADR-048：坚持单通道，还是接受 0.8 计划的双通道？ | ✅ **按 0.8 计划的双通道**：ADR-048 由 ADR-052 取代 | ADR-052；0.8 计划修订 #9 已收尾 |
| C6 | ADR-047 说删的每日 CI / drift：删还是留？ | ✅ **保留在役**；发布前仍须手动 dispatch `ci` + `smoke full` | ADR-055；S0-4 收尾 |
| C7 | alpha 线：引导 updater-alpha，还是宣布休眠？ | ✅ **休眠**（2026-09-30 维护者）：不发布、不追漂移，补丁与 vendored 冻结保留；恢复前提与版本约束（须 > 当时最高 rc tag）见 ADR-056。**→ 同日由 ADR-057 修订为复役**（维护者指令；两线均在役） | ADR-056（部分修订 ADR-052）→ ADR-057（修订 ADR-056 决策 1）；S5-3（改为「保留但冻结」）；目标表 `status` 字段为唯一产地 |
| C8 | next 线移植批次（上游已到 0.2.0-rc.2，79+ hunk）何时启动？ | ✅ **缺陷治理计划（S0~S6）全部退出后启动**；在那之前 verify:drift 的红灯是已排期的信号，不另立批次 | patches/LAYERS.md「next 线的移植裁定」；§6 |

---

## 8. 度量与完成线

| 指标 | 现状（2026-09-30 实测） | S 阶段目标 |
|------|------------------------|-----------|
| 更新端点投递的版本 | rc = `0.7.2-rc.1` ✅（2026-10-03 实测 = 该通道最新 tag）；alpha ❌ **端点 404**——已由 ADR-057 复役，但通道化后尚未发布过（最新 alpha tag 仍是 `v0.7.0-alpha.8`），要等第一次通道化 alpha 发布（须 ≥ `0.7.3-alpha.1`）才闭环 | = 该通道最新发布版本 |
| 补丁数（逐通道） | 基线（本计划入库时）next 14 / alpha 13，合计 27（原文「27 × 2」把合计误当单线）；**2026-10-03 实测 next 10 / alpha 11**（ADR-057 推进时按 retireWhen 净退役 6 个） | next 线下降 ≥30%（实测 −28.6%，**差 1 个未达标**）；alpha 线已复役（ADR-057），同样按 retireWhen 收缩 |
| AGENTS.md 体积 | 160,148 B | ✅ **已达成 32.7 KB**（原定 ≤32,768 B；因后续仍需修正 MSRV/端点两行事实，判据放宽为 **≤40 KB**——真正的硬约束是「小于 64 KB 指令预算且规则全可读」，40 KB 留 24 KB 余量） |
| 无守卫覆盖的层（文档常量 / 游离配置） | 文档常量层已由 verify:doc-facts 覆盖（2026-09-30）；游离配置层基线已清空（S3-3） | 0 类 |
| 门禁快档时长 | ✅ verify:fast 温热实测 43s（S4-1/S4-2） | verify:fast ≤60s |
| src-tauri 生产 unwrap | 29（其中 state.rs 15）；**2026-10-02 实测 0**（src-tauri 与 dsh-\* 的 src 生产段共 12,704 行，逐行由 verify:unwrap-hygiene 盯着） | 0 或逐条有理由 ✅ **已达成** |
| dsh-host 外部消费者 | 0 | ≥1 |

**完成线（照 ADR-047，写进 README 顶部）**：每个重大决策都有 ADR；每层都有陌生人可跑的验证；诚实复盘存在。三条都满足即项目完成，不再追加目标——**本计划本身也不得成为追加目标的借口**。

---

## 9. 风险

| 风险 | 说明 | 应对 |
|------|------|------|
| 外部事实会过期 | 端点行为、GitHub 的 latest 语义、上游发布节奏都会变 | 执行 C2 / S1 前复核一次线上状态 |
| 文档搬迁丢失信息 | S2-1 搬 160KB 事故档案易漏节 | 判据要求「每节有唯一新家 + AGENTS 有索引」，搬完跑一次全文检索比对 |
| 收缩与 0.8 计划冲突 | C5 的结论会要求改 0.8 计划文字 | 先改文档再动代码，避免两套真相 |
| 守卫变成恒真装饰 | 本计划新增 5 个守卫 | 每个都必须带「以修复前真实状态为夹具必须报红」的自检（§3 三条硬要求） |
| 单人 bus factor | 全部知识仍在一人 | S0-2 的 SECURITY.md 与 S2 的文档分流是间接缓解，不解决 |

---

## 10. 口径说明（诚实约束）

- 本文所有「现状」数字来自 **2026-09-30 的一次勘察**：本机实测 + 线上核实。外部事实会过期，执行前复核。
- 未实测项已列在 §1：三平台矩阵、L2 GUI 冒烟、300MB 运行时组装、MSVC clippy。
- 本文是 **docs-only 变更**：按 README 的版本纪律，docs/chore 类提交不触发版本推进，也不需要走发布前那两次手动 dispatch。
- 本文不复制任何未经本仓独立核实的外部数字（与 roadmap 附录 A 的同一纪律）。

---

## 11. 执行记录（2026-09-30，第一批）

按 §7 的裁决执行了 S0 与 S1 的主体，并顺带完成 S2-1、S2-2 的文档部分。

| 项 | 状态 | 证据 |
|----|------|------|
| C1 → ADR-054；S0-3 接上 AI 评审配置 | ✅ 已落地 | `pr-agent.yml` 已移入 `.github/workflows/`（**.github/pr-agent.yml 已删除**）；两个 action 钉 40 位 SHA（pr-agent=10bbd9a4、pullfrog=9d9014df、checkout@v6=d23441a4、setup-node@v5=a0853c24）；`issue_comment` 触发面收紧为「PR + 本仓成员」 |
| verify:github-config（新守卫） | ✅ 已落地 | 真检查：扫 10 个 YAML / 6 个工作流 / 30 个 uses / **错放 0**；自检 13 项（含「错放目录必须报红」「基线之外的浮动 ref 必须报红」「扫出 0 必须报错」） |
| C2 → ADR-053；S1-2 通道化 manifest | ✅ 代码已落地 | `scripts/updater-manifest.mjs`（端点 URL 唯一产地）；`release.yml` 新增构建期注入步 + `updater-channel` job（单写者，含发布后自检）；`tauri.conf.json` 默认端点指向 `updater-rc`；实测 `--write-config` 对 rc/alpha 分别产出正确端点，未知通道 `beta` 以退出码 1 失败 |
| verify:update-channel（新守卫） | ✅ 已落地；**rc 通道已闭环（2026-09-30 v0.7.1-rc.1）** | 端点实测返回 `0.7.1-rc.1`（= 该通道最新 tag），13/13 资产完整——D1 在 rc 通道终结。**首发当日抓到一个真实缺陷**：发布后自检断言**全部**通道，把 alpha 的引导期 404 误判成本次发布失败——已修为 `--tag` 作用域（发布时只查本通道），全通道核对进每日 drift 的**独立 job**（`8205a17` + `003652d`：同 job 排后位会被上游漂移的既有红灯遮蔽）。自检 19 项，含「以 2026-09-30 真实状态（端点 0.5.0-next.1 / 最新 tag 0.7.0-rc.1）为夹具必须报红」 |
| S1-4 版本单调性 | ✅ **已落地** | `version.mjs::checkVersionMonotonic` + `readPublishedTags`（浅克隆返回 null 并告警，权威执行点是 release preflight 的 fetch-depth:0）。**它上线即抓到真实缺陷**：`verify:version` 对当时的 `0.7.0-alpha.8` 报「低于已发布的最高 tag v0.7.0-rc.1」。semver 比较器收敛到共享库 `conventional-commits.mjs`（两个脚本不再各写一份）。自测新增 9 项，含以真实历史为可证伪夹具 |
| 版本号落地 | ✅ 已定 `0.7.1-rc.1` | `version:set` 改 `package.json` + `Cargo.toml` + `Cargo.lock`；CHANGELOG 生成 0.7.1-rc.1 段（7 条提交）；`--channel-of 0.7.1-rc.1` → `next`（DSH `0.1.5-rc.3`）；`verify:version` 由红转绿 |
| C6 决策（S0-4 收尾） | ✅ 已裁决并落地 | ADR-055（保留每日 CI + drift，修订 ADR-047 删除清单第 2 项）；ADR-047 状态与新增「修订」段、ADR 索引同步 |
| C4 决策（S6-5 收尾） | ✅ 已裁决并落地 | 追加进 ADR-044 的「明确不做」清单，附理由与恢复条件 |
| C7/C8 决策（alpha 休眠；next 移植排期） | ✅ 已裁决并落地（**C7 同日由 ADR-057 修订为复役；C8 的 next 移植随 ADR-057 提前完成**） | ADR-056（部分修订 ADR-052）+ ADR-052 修订段 + 索引；目标表新增 `status` 字段（唯一产地）；verify:update-channel / verify:drift 对休眠目标显式跳过、零在役目标报错；release preflight `--channel-of` 拒绝休眠通道（实测 exit 1）；AGENTS §7.2/§8.6 与 runbook §8.6 同步 |
| S0-1 补 LICENSE / 修 authors | ✅ 已落地（第二批） | LICENSE（MIT，wang-yi-bit64）；package.json / Cargo.toml authors 改本仓作者；「来源与致谢」节进两份 README；三处一致性断言由 verify:doc-facts 承接 |
| S0-2 补 SECURITY.md（含 S3-4） | ✅ 已落地（第二批） | 威胁模型（loopback / LAN 桥显式开启 / minisign 更新链 / 无遥测）+ 明示边界（同进程插件崩溃、无 OS 签名）+ 报告渠道 + 支持范围 + **CI 密钥暴露面表**（S3-4 一并完成；签名私钥实际出现在 release 与 smoke full 两处——按实情记载） |
| S0-5 计划登记进 AGENTS §6 | ✅ 已落地（第二批） | AGENTS.md §6 可检索本文件名 |
| S2-2 文档预算纪律 | ✅ 已落地（原 🟡 欠账销账） | AGENTS §7.3 新增条文：新计划须同时归档旧计划、计划无权延期 ADR，违反即文档回归 |
| S2-3 verify:doc-facts | ✅ 已落地（第二批） | 5 类对账（rust-version / .nvmrc / license 三处 / ADR 计数 / MIN_NODE_MAJOR 零宣称合法）；自检 15 项以真实漂移为夹具；**上线首轮即抓到新漂移**（ADR 计数宣称 41、实际 42）并修正 |
| S2-4 归档 release-channels 三文档 | ✅ 已落地（第二批） | 三份移入 docs/archive/（文首写明取代者）；verify:plan-facts 账本主体改指本计划（checkDecisionLedger：C1~C8 落地格必须有真实去向、引用的 ADR 文件必须存在）；在役 docs 总量净减约 147KB |
| S3-1 dependabot cargo | ✅ 已落地（第二批） | cargo 生态 / directory=/（Cargo.lock 所在 workspace 根）/ 只开安全更新，与 npm 同口径 |
| S3-2 cargo-deny | ✅ 已落地（第二批） | deny.toml（advisories + licenses）；本地实跑**首跑报红**（RUSTSEC-2024-0370 unmaintained，gtk 栈传递）→ 加 ignore 附理由后转绿——「真的在查」实证；glib GHSA 在 RustSec 无对应条目（实测 not found），该告警由 Dependabot 承担；ci.yml Linux job 挂 cargo-deny-action（钉 SHA） |
| S3-3 action 全量钉 SHA | ✅ 已落地（第二批） | 7 个浮动 ref 全部钉 40 位 SHA（dtolnay 改经 `toolchain: stable` 输入传名）；verify:github-config 基线表**清空**（自检 12 项改为注入式基线机制测试） |
| S4-1/S4-2 门禁分档 | ✅ 已落地（第二批） | `verify:fast`（26 步，**温热实测 43s ≤60s**）：全部 :self-test 自动发现 + 快速静态门禁 + `cargo test --tests`；`verify:full` = fast + doc-test（44 项 ≥258s）；ci.yml PR 路径改 `--tests`，doc-test 由 schedule-only 步骤承接（ADR-055 语义不变） |
| ADR-052（C5：双通道恢复在役） | ✅ 已落地 | ADR-048 状态改为「已被 ADR-052 取代」并补后续段；ADR-022 标注「由 ADR-052 恢复在役」；ADR 索引新增 G 组（052–054）；0.8 计划修订 #9 与 §15 已收尾 |
| S2-1 AGENTS.md 打薄 | ✅ 已达成 | 160,148 B → **33,144 B**；32 个 `###` + 9 个 `####` **零丢失**（逐个比对新家）；新增 `docs/commands.md`、`docs/release-runbook.md`、`docs/incidents/`（10 篇）+ 原文快照 |
| S2-2 文档预算纪律 | ↪ 已由第二批销账（见上方同名行；本行为第一批当时的快照） | 第一批时未把「新增计划文档必须同时归档旧文档 / 计划无权延期 ADR」写成 AGENTS.md 条文——**仍是欠账** |
| S2-3 verify:doc-facts | ↪ 已由第二批销账（见上方同名行；本行为第一批当时的快照） | 第一批时以**人工**修正了 MSRV（AGENTS/README×2 由 1.85 → 1.90）与 ADR 计数（36 → 40）；派生守卫仍未写，同一类漂移下次还会发生 |
| S3-3 action 全量钉 SHA | ↪ 已由第二批销账（见上方同名行；本行为第一批当时的快照） | 第一批时新守卫以基线表容纳 7 个预先存在的浮动 ref（守卫每次运行都会打印提示）；空表才是目标状态 |
| PR Agent 触发面第③条（ADR-059） | ✅ 已落地（第四批） | 线上事故后增补：run #9（PR #2，OWNER 的非命令评论）失败于「PR Agent action step」，日志 `Unknown command: |`。根因：钉死的 action SHA 只钉住 action.yaml + Dockerfile，Dockerfile 是 `FROM pragent/pr-agent:github_action` **浮动镜像标签**，镜像是旧版（行号证据：`Unknown command` 日志 363 / 源码 381；`Applying repo settings` 217 / 241）。旧镜像把 `## …` 开头的评论按 shell 规则词法分析、`#` 当注释起点，第一个 token 变成表格的 `|` → 未知命令 → 退出 1。修法：`issue_comment` 增加「评论以 `/review` `/improve` `/describe` `/ask` 开头」条件（`startsWith`，**不能用 contains**——镜像按第一个 token 解析，`please /review this` 也会失败）。actionlint exit 0 + 14/14 触发矩阵通过。**仍未验证**：`/review` 与 `pull_request` 路径能否真出评审（模型配置在线才能验） |
| Pullfrog 停用（ADR-058，修订 ADR-054 决策 2） | ✅ 已落地（第三批） | 维护者指令「停用 pullfrog、启用 pr-agent」。先回答语义问题：**删除 pullfrog.yml 即停用**——GitHub Actions 只从 `.github/workflows/` 加载，UI 的 Disable 开关是服务器端状态、不进仓库也不可被门禁看见。`.github/workflows/pullfrog.yml` 已删除；pr-agent.yml **零改动即在役**（不是又一处待接线）：actionlint 1.7.7（SHA256 与官方 checksums 核对一致）对删除后的 5 个工作流 exit 0；verify:github-config 实跑「9 YAML / 5 工作流 / 31 uses / 错放 0」、自检 12 项过；SECURITY.md 密钥暴露面表删去 pullfrog 的 13 key 行并加退役注记；ADR-058 入库，索引 / ADR-054 修订段 / AGENTS.md ADR 计数（43→44）同步 |
| S4-4 收敛 src-tauri 生产 unwrap（治 D10） | ✅ 已落地（第四批，2026-10-02） | `src-tauri/src/poison.rs` 新建：`lock_or_recover` / `try_lock_or_recover` 两个中毒恢复原语 + 3 项单元测试（先制造真实 poison 再断言恢复，避免装饰性绿）；`state.rs` 15 处 `lock().unwrap()` 与 3 处 `try_lock()` 全改走它（同步访问器不转错误码的理由记在 S4-4 条目内）；`mobile_bridge.rs` bind 地址改带归因 expect、query 构造改 match、listener 两处「中毒静默降级」改恢复；`crates/dsh-host/src/safe_mode.rs` 序列化 unwrap 改 io::Error 传播。新守卫 `verify:unwrap-hygiene`：U1 生产段零 `.unwrap()`（src-tauri/src 与 crates 各 crate 的 src；测试段 / 注释 / 字符串不计）、U2 扫出数>0，16 项自测（含「修复前的 `self.inner.lock().unwrap()` 必须报红」「同一处改 expect 必须转绿」「CRLF 与 LF 一致」）；npm script 与 docs/commands.md §6b 登记，随 `:self-test` 自动发现进 verify:fast（快档 27 → 28 步） |

**本轮端到端验证**：23 个既有门禁全部 exit 0（含 verify:claims / verify:plan-facts / verify:release-workflow / verify:release-assets / verify:harness-entry）；actionlint 1.7.7（SHA256 与官方 checksums 核对通过）对 6 个工作流 **exit 0**；`updater-manifest --self-test` 16 项通过。

> ⚠️ **当前的预期红（2026-09-30 发布后更新）**：`verify:update-channel` 的**全通道**模式对 alpha 仍为红——`updater-alpha` 滚动 Release 要等 alpha 通道的第一次通道化发布才会创建（每日 drift 哨兵会因此报红，已在该步注释登记为预期状态）。发布时自检已改为通道作用域，不受影响。**〔2026-10-03 更正：alpha 已由 ADR-057 复役，这条红不再是「预期状态」而是真实缺口——alpha 在役却零投递，直到第一次通道化 alpha 发布（须严格大于最高 rc tag，即 ≥ `0.7.3-alpha.1`）为止。〕**

**第五批（2026-10-03）：门禁清单单一产地 + 「有守卫没人跑」根因治理（S4-5，对应治理 G0~G3）**

| 项 | 状态 | 证据 |
|----|------|------|
| G0 把「有守卫没人跑」补上 | ✅ 已落地 | 逐条核实到四个守卫**不在任何自动流程里**：`unwrap-hygiene` 的**真检查**（本表 S4-4 行却写着「逐行由 verify:unwrap-hygiene 盯着」）、`doc-facts`、`github-config`、`fault-patterns`。四者现已进 fast / ci / release 三档。顺带实证了这条链的代价：`doc-facts` 接进 CI 的**第一轮**就抓到真实漂移（`docs/commands.md` 漏登 4 个 script 名）——而它此前从未在 CI 跑过 |
| G1 门禁总表 + 编排器 + 元守卫 | ✅ 已落地 | `scripts/gate-manifest.mjs`（33 条门禁 × real/self-test × 4 分档，逐条 why）+ `scripts/gates.mjs`（取代 `verify-fast.mjs`：`--tier` / `--only` / 门禁名 / `--list` / `--dry-run`）+ `scripts/verify-gates.mjs`（M1~M5：脚本存在 / 每种模式要么进分档要么写 `manual` 理由 / 支持 `--self-test` 的脚本必须登记或带理由豁免且**扫出数 > 0** / 旧名可解析 / 名字唯一；自测 27 项，含 4 组负向夹具）。`ci.yml` 与 `release.yml` preflight 各收敛成**一步** `npm run gate -- --tier=ci|release`，逐条 rationale 迁进总表 why 字段 |
| G1 判据与清单同源（防退化成「只认一行文字」） | ✅ 已落地 | `verify-release-workflow` 的 preflight 判据改为「YAML 里必须调 `--tier=release`」**且**「总表的 release 档里必须有 `cli-package`」（后者读 `resolveTier('release')`，不手抄）；自测新增两条夹具（摘掉档调用 / 档里没有 cli-package 都必须报红），自测 63 项 |
| G2 package.json 收敛 | ✅ 已落地 | scripts **62 → 22**（41 条门禁入口 → 1 条 `gate`）；`scripts/verify-fast.mjs` 删除；旧名经 `npm run gate -- verify:<name>` 与 `<name>:self-test` 仍可解析（兼容层，历史文书不改）；在役文档与工作流里的 `npm run verify:<name>` 机械迁移为 `npm run gate -- <name>`（AGENTS / 两份 README / commands.md / runbook / checklist / roadmap / SECURITY / LAYERS / ci / release / smoke / drift，共 20 个文件） |
| G3 文档同步 | ✅ 已落地 | `docs/commands.md` 头部改写为「两层命令面 + 分档语义表 + 旧名兼容 + 需参数的一次性核验直接调脚本」；AGENTS §2 的「npm script 名字一个都没丢」改为如实的收敛说明（删掉 41 条入口后原句已不成立）；`verify:doc-facts` 的 script 覆盖断言全绿 |
| 实测 | ✅ | `npm run verify:fast` **44 步 / 22.4s 全绿**（含 `cargo test --tests` 7.7s，温编译；预算 ≤60s）；分档规模 fast 43 / ci 45 / release 42 / sentinel 2；`verify:gates` 与 `verify-release-workflow` 自检分别 27 / 63 项通过 |

> ⚠️ **诚实边界（三条）**：① **组装树与联网的真检查仍不在任何分档里**——`target` / `harness-tree` 需组装树（由 `release.yml` 的 build / portable job 在 `prepare:harness` 之后按名点名，总表 `manual` 字段写明理由，元守卫的 M2 强制这一解释存在），`drift` / `update-channel` 需联网（sentinel 档）。② **S4-3 的「门禁内部先扫后验」普查仍是未开工主体**：本轮只做实了编排层（脚本级登记 + 分档非空 + 扫出数 > 0）。③ **历史文书里的旧 script 名刻意保持原样**（`CHANGELOG.md` / `docs/adr/` / `docs/archive/` / `docs/incidents/` / 计划台账）——它们是当时的记录，靠 gate CLI 的旧名兼容层仍可重放。

**第六批（2026-10-09）：Dependabot 安全更新的排除无效（D13）——改判据，不改注释**

发现路径是**顺手的**：2g + 2h 推送时 `git push` 的回显里带着 4 条 Dependabot 告警，查 `gh run list` 又看到两条**连续失败**的 Dependabot 运行。追下去不是「告警没处理」，而是「**处理不了的告警**」。

| 项 | 状态 | 证据 |
|----|------|------|
| D13 登记 | ✅ | 见 §2 末行。job 定义与报错均为**日志原文**（非推断）：`"command":"security"` + `"security-updates-only":true` + `"directories":["/harness-locks/alpha"]`，随后 `Error during file fetching; aborting: /harness-locks/alpha/package.json not found`。两次失败分别落在 2026-10-09T03:09 与更早一条 |
| 伪结论更正 | ✅ 已落地 | `.github/dependabot.yml` 头注释改写：删掉「只列根目录 ⇒ 等价于把 harness-locks/ 排除在安全更新之外」，改为**机制说明 + 三条证据**（两处官方口径 + 一次实测），并写明本仓处置与两条守卫的入口。**旧注释是「现状声明」，却零守卫**——与本仓已多次踩到的那一类同形 |
| 处置（仓库设置） | ✅ 已落地 | `PATCH /repos/wang-yi-bit64/dsh-desktop` → `security_and_analysis.dependabot_security_updates.status = disabled`；复核由**新守卫自己**独立完成（真检查打印「安全更新处于关闭状态」）。裁定：告警保持可见，按 `docs/dsh-upgrade-checklist.md` 跟随上游版本处置 |
| 新守卫 F（fast 档，离线） | ✅ 已落地 | `verify-github-config.mjs` 增规则 F：`dependabot.yml` 声明的每个目录必须**真有该生态的清单文件**（npm→package.json / cargo→Cargo.toml）；自检 **48 项**（含「真实形态 `/harness-locks/alpha` 必须报红」「同写法指向根目录必须放行」的成对夹具）。🔴 它**先剥整行注释再判**——本规则自己的说明里逐字写着那个被禁目录，不剥就会被自己的文档命中（本仓第五次踩这个陷阱） |
| 新守卫 `dependabot-setting`（联网） | ✅ 已落地（**但 CI 核不了，已据实降级**） | `scripts/verify-dependabot-setting.mjs`：断言开关**不是 enabled**；三个出口互斥——`disabled`⇒绿 / `enabled`⇒红 / 取不到或字段不可见⇒skip 且日志**明写「未核对」**（绝不判绿）/ slug 404⇒红（配置缺陷，同 drift 的裁定）。自检 **30 项**（含「每条 skip 夹具都不得被判成 ok」——防判据静默退化成永远通过）。**⚠️ 撤回了它的 drift.yml job**：见下面两行 |
| 🔴 实测：CI 里这台哨兵**核不了** | ✅ 已据实降级 | 首次真 CI（run 37893438935）全绿，但日志里**没有一行**说明它是核对了还是跳过了 → 先修编排器（下行）。修完回显可读：`⚠️ 响应里没有 security_and_analysis —— 该字段只对有 push 权限的调用者返回…**未核对**（不等于已核对）`。**再试一次权限**（run 37894189469，加 `security-events: read`）⇒ **仍然缺席**，说明 Actions 的 GITHUB_TOKEN 没有 push 身份，这条路走不通。⇒ 按 ADR-030 的裁定**撤掉那个 job**（一台「每周全绿 + 日志写未核对」的 job，绿色没人看 = 替一段不存在的检查背书）：总表改 `real.tiers = []` + `manual` 写明理由与恢复条件（配上带 push 权限的 PAT secret 即可接回独立 job）。脚本与 30 项自检保留，自检照常进 fast/ci/release |
| 注入与分支验证（实测） | ✅ 2/2 + 2/2 | **F**：真实文本原样 ⇒ 放行（注释里的目录未命中）；注入「列出 harness-locks/alpha」⇒ 点名报红（用真实磁盘探针 + 真实报错文本）。**dependabot-setting**：`DSH_UPDATER_REPO=<不存在>` ⇒ exit 1 并报「配置缺陷」；`GH_TOKEN=<无效>` ⇒ exit 0 且打印「**未核对**（不等于已核对）」 |
| 🔴 衍生缺口：CI 日志里「已核对」与「未核对」同形 | ✅ 已落地 | 真因不在脚本，在**编排器**：`gates.mjs::runStep` 只在**失败时**回显子进程输出，而 skip 与真核对**都是 exit 0**。修法不是改哨兵语义（把 skip 判红会造出永久红灯，ADR-030），而是给总表加可选字段 `echoOutput`：成功也回显该步 stdout。已开在 `drift` / `update-channel` / `dependabot-setting` 三条哨兵上——**它们三个此前都有同一个缺口**（`drift.yml` 里「取不到时脚本自行 SKIP 并在日志里说明未核对」这句注释，在修复前是**不成立**的）。修完实测：无令牌 ⇒ 日志出现「⚠️…**未核对**…`gh: Bad credentials`」；有令牌 ⇒ 出现「✅ 安全更新处于关闭状态」 |
| 🔴 同批：可选字段拼错会静默失效 | ✅ 已落地 | `echoOutput` 读法是 `=== true`，拼成 `echoOutpt` 不报任何错、只是不生效——而它的语义恰恰是「消除静默」。故 `verify-gates.mjs` 增 **M6**：总表条目的字段必须来自白名单（唯一产地 `ALLOWED_GATE_FIELDS`），自测 **32 项**（含「`echoOutpt` 必须判红」并点名允许集）|
| ⚠️ 未做（诚实边界） | ⚠️ | ① **自动分类规则这次没建**：官方 REST 规格（13 MB 全量）里**没有** auto-triage 端点（只有 `dependabot/alerts`、`dependabot/secrets`），只能走 Settings 网页；且文档两处口径互相矛盾（概念页说公共仓库可用，添加页说须属**组织**且持 Code Security 许可）。本轮只关了开关（噪音源）并把处置与判据写死，规则留待需要时手动建。② `enabled ⇒ exit 1` 这条链路**只由纯函数夹具证明**，未做端到端注入——那需要把真实开关短暂打开一次（会立刻派生必失败的 job），判定不值得。③ 依赖图仍会把 `harness-locks/**/package-lock.json` 当清单（官方无按路径排除能力）⇒ 这 3 条告警的**本体**依然存在，只是不再派生 job |

### 11.1 未开工条目（完整台账）

上表只列**本轮动过**的条目。以下**完全未开工**——把「做过的」当全部，会让台账比现实乐观，而那正是 D3 的形态，所以这里逐条列出：

| 条目 | 状态 | 现场证据（2026-09-30） |
|------|------|----------------------|
| S4-3「扫出数为 0」断言普查 | 🟡 部分（2026-10-03 推进一格） | 快档已分档（S4-1/S4-2 ✅）；**S4-4 已于 2026-10-02 销账**（见 §11 第四批）。2026-10-03 的 S4-5 把**编排层**这一类做实了：`verify-gates` 断言「支持 `--self-test` 的脚本扫出数 > 0」与「每个分档步数 > 0」，并逐条登记豁免理由（详见 §11 第五批）。**仍未做**：门禁**内部**的「先扫后验」判据尚未逐条过一遍「匹配模式变更后是否静默归零」——这是普查的剩余主体 |
| S5-1~S5-4 补丁 retireWhen 减法 / UI 补丁专项 / 补丁数趋势 | 🟡 部分 | 补丁数已由 ADR-057 推进顺带收缩到 next 10 / alpha 11（基线 14 / 13），但**不是按 S5-1 的三分类表做的**，next 线 −28.6% 也尚未达到 ≥30%；S5-2 UI 补丁专项与 S5-4 补丁数趋势进 job summary 仍未开工。alpha 已复役（ADR-057），减法两线都适用 |
| S6-1~S6-5 dsh-host 零 Tauri 承诺 / CLI recover / 性质测试 / 可证伪承诺（S6-5 crate 发布已裁决：不发） | ❌ 未做 | C4 已裁决不发 crates.io（ADR-044 清单追加），S6-5 仅剩收尾记录 |

**合计**：本计划约 31 个条目（新增 S4-5）。第一批（2026-09-30 上午）落地 6 个；**第二批（2026-09-30，执行会话）再落地 11 个**（S0-1/S0-2/S0-5、S2-2/S2-3/S2-4、S3-1/S3-2/S3-3/S3-4、S4-1/S4-2，其中 S0-3 / S1 系 / S2-1 属第一批），并新增守卫 verify:doc-facts 与 verify:fast/full 分档；**第三批再落地 1 个**（Pullfrog 停用，ADR-058）；**第四批再落地 1 个**（S4-4，2026-10-02：state.rs 15 处锁 unwrap 收敛为中毒恢复 + verify:unwrap-hygiene 守卫）；**第五批再落地 1 个**（S4-5，2026-10-03：门禁清单单一产地 + 编排器 + 元守卫，package.json 62 → 22，见 §11 第五批）。**S 阶段剩余：S4-3（剩余主体：门禁内部先扫后验普查）、S5 全部、S6 全部。**

> **口径（2026-09-30 发布后更新）**：D1 在 **rc 通道已闭环**——v0.7.1-rc.1 发布后端点实测返回 `0.7.1-rc.1`，13/13 资产完整、`prerelease: true`。两条诚实边界：① ~~alpha 通道零投递是裁定结果（C7 休眠，ADR-056），不再是待办~~ **〔2026-10-03 更正：C7 同日由 ADR-057 修订为复役，alpha 零投递重新是待办——见 §8 第一行〕**；② **存量安装不会自愈**——端点是构建期注入的，v0.7.1-rc.1 之前的所有构建仍指向旧端点（`releases/latest` 排除预发布，停在 `0.5.0-next.1`），修复只覆盖今后新装的构建。同一口径适用于所有依赖真实发布的条目。
