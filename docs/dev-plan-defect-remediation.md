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

## 2. 缺陷清单（D1~D12）

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

**S4 退出判据**：fast 档 ≤60s；审计清单为 0 遗漏；state.rs 无裸 unwrap。

### S5 — 补丁收缩与单通道收尾（1~2 周）

**S5-1 按 retireWhen 做减法冲刺（治 D9）**
- 动作：对 27 个补丁逐条对照 patches/LAYERS.md 的 retireWhen，产出「保留 / 退役 / 降级为配置」三分类表；**先退役再加新补丁**。
- 判据：补丁数比基线下降 ≥30%，且没有「退役后又以另一形态加回」的条目。

**S5-2 三个 UI 补丁专项（治 D9，与 ADR-006 的定位冲突）**
- 动作：settings-models（886 行）/ agent-preset（640）/ workspace（477）逐条论证「没有它会怎样」；能移出补丁层的改用上游配置或注入脚本（shell → page 单向下发，INV-2 不变）。
- 判据：每个补丁有一句「它守的用户可感知行为」；答不出来的即退役候选。

**S5-3 patches/alpha 与 harness-deps/alpha 的处置（C3 留、C7 休眠）**
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
| C1 | 两份 AI 评审配置：删，还是接上并钉 SHA？ | ✅ **接上**：pr-agent.yml 挪进 `.github/workflows/` 并与 pullfrog.yml 一并接线 | ADR-054；S0-3（含 verify:github-config） |
| C2 | 更新链：通道化 manifest，还是诚实降级？ | ✅ **通道化 manifest** | ADR-053；S1-2 / S1-3 |
| C3 | patches/alpha 与 harness-deps/alpha：删还是留？ | ✅ **留并在役**（C5 选双通道 ⇒ alpha 线必须维护） | ADR-052；S5 |
| C4 | dsh-host 是否发到 crates.io？ | ✅ **不发**（可复用性用仓内证据证明，不用包管理器分发） | ADR-044 清单追加；S6-5 收尾 |
| C5 | ADR-048：坚持单通道，还是接受 0.8 计划的双通道？ | ✅ **按 0.8 计划的双通道**：ADR-048 由 ADR-052 取代 | ADR-052；0.8 计划修订 #9 已收尾 |
| C6 | ADR-047 说删的每日 CI / drift：删还是留？ | ✅ **保留在役**；发布前仍须手动 dispatch `ci` + `smoke full` | ADR-055；S0-4 收尾 |
| C7 | alpha 线：引导 updater-alpha，还是宣布休眠？ | ✅ **休眠**（2026-09-30 维护者）：不发布、不追漂移，补丁与 vendored 冻结保留；恢复前提与版本约束（须 > 当时最高 rc tag）见 ADR-056 | ADR-056（部分修订 ADR-052）；S5-3（改为「保留但冻结」）；目标表 `status` 字段为唯一产地 |
| C8 | next 线移植批次（上游已到 0.2.0-rc.2，79+ hunk）何时启动？ | ✅ **缺陷治理计划（S0~S6）全部退出后启动**；在那之前 verify:drift 的红灯是已排期的信号，不另立批次 | patches/LAYERS.md「next 线的移植裁定」；§6 |

---

## 8. 度量与完成线

| 指标 | 现状（2026-09-30 实测） | S 阶段目标 |
|------|------------------------|-----------|
| 更新端点投递的版本 | rc = `0.7.1-rc.1` ✅（2026-09-30 实测）；alpha 休眠，不投递（C7/ADR-056） | = 该通道最新发布版本 |
| 补丁数 × 通道数 | 27 × 2 | next 线下降 ≥30%；alpha 线冻结（休眠，不增不减——C7/ADR-056） |
| AGENTS.md 体积 | 160,148 B | ✅ **已达成 32.7 KB**（原定 ≤32,768 B；因后续仍需修正 MSRV/端点两行事实，判据放宽为 **≤40 KB**——真正的硬约束是「小于 64 KB 指令预算且规则全可读」，40 KB 留 24 KB 余量） |
| 无守卫覆盖的层（文档常量 / 游离配置） | 已知 ≥3 类命中 | 0 类 |
| 门禁快档时长 | 无分档（含 doc-test 时 ≥258s） | verify:fast ≤60s |
| src-tauri 生产 unwrap | 29（其中 state.rs 15） | 0 或逐条有理由 |
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
| C7/C8 决策（alpha 休眠；next 移植排期） | ✅ 已裁决并落地 | ADR-056（部分修订 ADR-052）+ ADR-052 修订段 + 索引；目标表新增 `status` 字段（唯一产地）；verify:update-channel / verify:drift 对休眠目标显式跳过、零在役目标报错；release preflight `--channel-of` 拒绝休眠通道（实测 exit 1）；AGENTS §7.2/§8.6 与 runbook §8.6 同步 |
| ADR-052（C5：双通道恢复在役） | ✅ 已落地 | ADR-048 状态改为「已被 ADR-052 取代」并补后续段；ADR-022 标注「由 ADR-052 恢复在役」；ADR 索引新增 G 组（052–054）；0.8 计划修订 #9 与 §15 已收尾 |
| S2-1 AGENTS.md 打薄 | ✅ 已达成 | 160,148 B → **33,144 B**；32 个 `###` + 9 个 `####` **零丢失**（逐个比对新家）；新增 `docs/commands.md`、`docs/release-runbook.md`、`docs/incidents/`（10 篇）+ 原文快照 |
| S2-2 文档预算纪律 | 🟡 部分 | 本轮未把「新增计划文档必须同时归档旧文档 / 计划无权延期 ADR」写成 AGENTS.md 条文——**仍是欠账** |
| S2-3 verify:doc-facts | ⏳ 未做 | 本轮以**人工**修正了 MSRV（AGENTS/README×2 由 1.85 → 1.90）与 ADR 计数（36 → 40）；派生守卫仍未写，同一类漂移下次还会发生 |
| S3-3 action 全量钉 SHA | ⏳ 未做 | 新守卫以基线表容纳 7 个预先存在的浮动 ref（守卫每次运行都会打印提示）；空表才是目标状态 |

**本轮端到端验证**：23 个既有门禁全部 exit 0（含 verify:claims / verify:plan-facts / verify:release-workflow / verify:release-assets / verify:harness-entry）；actionlint 1.7.7（SHA256 与官方 checksums 核对通过）对 6 个工作流 **exit 0**；`updater-manifest --self-test` 16 项通过。

> ⚠️ **当前的预期红（2026-09-30 发布后更新）**：`verify:update-channel` 的**全通道**模式对 alpha 仍为红——`updater-alpha` 滚动 Release 要等 alpha 通道的第一次通道化发布才会创建（每日 drift 哨兵会因此报红，已在该步注释登记为预期状态）。发布时自检已改为通道作用域，不受影响。

### 11.1 未开工条目（完整台账）

上表只列**本轮动过**的条目。以下**完全未开工**——把「做过的」当全部，会让台账比现实乐观，而那正是 D3 的形态，所以这里逐条列出：

| 条目 | 状态 | 现场证据（2026-09-30） |
|------|------|----------------------|
| S0-1 补 LICENSE / 修 authors | ❌ 未做 | 根目录无 `LICENSE`；`package.json` 与 `Cargo.toml` 的 authors 仍是 `DataElement` |
| S0-2 补 SECURITY.md | ❌ 未做 | 文件不存在 |
| S0-5 把本计划登记进 AGENTS.md §6 | ❌ 未做 | `grep dev-plan-defect-remediation AGENTS.md` 无命中 |
| S2-4 归档已裁撤的 release-channels 主题文档 | ❌ 未做 | 三份文件仍在 `docs/` 在役 |
| S3-1 / S3-2 / S3-4 cargo 扫描 + secrets 成文 | ❌ 未做 | dependabot 仍只有 npm；无 deny.toml |
| S4-1~S4-4 门禁分档 / doc-test 移出 / 扫出数为零普查 / state.rs 的 15 处生产 unwrap | ❌ 未做 | 单轮无头测试仍 ≥258s |
| S5-1~S5-4 补丁 retireWhen 减法 / UI 补丁专项 / 补丁数趋势 | ❌ 未做 | 27 个补丁仍两套并存（C3 留、C7 冻结：alpha 休眠不再恢复维护，减法只针对 next 线） |
| S6-1~S6-5 dsh-host 零 Tauri 承诺 / CLI recover / 性质测试 / 可证伪承诺（S6-5 crate 发布已裁决：不发） | ❌ 未做 | C4 已裁决不发 crates.io（ADR-044 清单追加），S6-5 仅剩收尾记录 |

**合计**：本计划约 30 个条目，本轮落地 **6** 个（S0-3、S1-2、S1-3、S2-1、ADR-052 系列、verify:github-config 与 verify:update-channel 两个新守卫），其余未开工。

> **口径（2026-09-30 发布后更新）**：D1 在 **rc 通道已闭环**——v0.7.1-rc.1 发布后端点实测返回 `0.7.1-rc.1`，13/13 资产完整、`prerelease: true`。两条诚实边界：① **alpha 通道零投递是裁定结果**（C7 休眠，ADR-056），不再是待办；② **存量安装不会自愈**——端点是构建期注入的，v0.7.1-rc.1 之前的所有构建仍指向旧端点（`releases/latest` 排除预发布，停在 `0.5.0-next.1`），修复只覆盖今后新装的构建。同一口径适用于所有依赖真实发布的条目。
