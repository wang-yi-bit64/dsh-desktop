# 0.2 开发计划：分发加固与体验补齐（批次 0.2-A~D）

> 编制日期：2026-09-12 · 依据：同日的项目评估（与社区套壳工具对比 + 官方桌面版前瞻）。
>
> ## 本文件与既有计划的关系（先读这一节）
>
> 仓库现有一套规划层级：[`roadmap.md`](roadmap.md)（**顶层**：定位 / 边界 / 阶段 H0~H3）→
> [`dev-plan-hardening-and-differentiation.md`](dev-plan-hardening-and-differentiation.md)
> （**H0 近端施工**：风险 R1~R9、批次 H~N）→ [`dev-plan-disconnected-points.md`](dev-plan-disconnected-points.md)
> （**已闭环**的 A~G）。**本文件是同日另一份评估（产品/分发视角）的产物，是 H0 的「增补建议」而非第三套并行计划**：
> 批次编号采用 `0.2-x` 命名空间以避免与 H~N 字母冲突；**是否并入 H0、以及下述三处优先级冲突如何裁决，归用户**。
>
> **本文件相对 H0 计划的独有覆盖**（并入时这些项不应丢失）：
> 1. **macOS / Windows 代码签名与公证**——H0 计划与路线图均未在近端处理（路线图把「签名」放在
>    H3-b，第 5~6 个月）；本文件主张提前，理由：0.1.0 已作为桌面安装包发布，未签名意味着
>    macOS Gatekeeper / Windows SmartScreen 劝退，**这是发行硬伤，不随定位收缩而消失**——
>    除非显式决定不再以安装包分发（那本身也是一个待裁决决策）。
> 2. **stable / preview 发布通道约定**——双方计划均未覆盖（路线图 H3 只提签名与 manifest）。
> 3. **用户反馈闭环**（Discussions + 应用内入口）——两套计划均未覆盖；没有它，所有优先级判断
>    （包括路线图 §9 的投入比例）都缺少真实信号。
> 4. **「插件禁用不可行」裁决的重新核验**（0.2-B4）——社区套壳 dataelement 已提供「移除插件」，
>    批次 C 的证据链需要对照当前上游重走。
> 5. 托盘 / 自启动 / 安全模式横幅的**实现级细节**——H0 计划的批次 N3 只把它们列为待裁决选项。
>
> **三处优先级冲突（需用户裁决，非本文件可自行决定）**：
> - **签名时点**：本文件 = P0 立即修；路线图 = H3（第 5~6 个月）。见上文独有覆盖第 1 条的理由。
> - **桌面体验底线（托盘 / 自启动 / 横幅）**：本文件 = P1；路线图 §9 给 Desktop UX 上限 10%
>   并把它们放在批次 N3 待裁决。若路线图决策点 1 采 A（定位收缩为可靠层），本文件 0.2-B 相应降级为按需。
> - **桌面功能面**：本文件与路线图结论一致（不与官方拼功能面），无冲突。
>
> 前提事实修正：官方桌面版「近期将发布」的说法**未获官方声明证实**——经核实，上游 `apps/desktop`
> 有完整 Electron 实现**但未发布**（无公告、无下载端点、无 GA 日期），且**无 Linux**、独占
> `$DSH_HOME/profiles/desktop`（详见路线图附录 A）。规划按「必然发生、时间不定」处理。

---

## 0. 优先级原则

| 级别 | 判据 | 批次 |
|------|------|------|
| P0 | 不修就留不住现有用户 / 新用户根本装不上 | **0.2-A**（分发硬伤）、**0.2-D**（反馈闭环） |
| P1 | 桌面应用的底线体验，缺了就是「半成品」 | **0.2-B**（托盘 / 自启动 / 安全模式可见性） |
| P2 | 不直接产出功能，但决定 6 个月后项目还活不活 | **0.2-C**（上游解耦与贡献；与路线图 H1/P2 互证） |
| — | 有条件才做（预算 / 上游语义 / 用户裁决） | 见 §决策点 |

> 若路线图决策点 1 裁定为 A（定位收缩为「可靠运行时层」），上表 P1 相应降级为按需；
> **但 0.2-A（签名 / 通道）与 0.2-D（反馈闭环）建议在任何定位下都保留**——它们是发行与信号基础设施，
> 与「做不做桌面功能」无关。

---

## 进度快照

> 最后更新：2026-09-12（编制时，全部未开工）· 状态词表见 `AGENTS.md` §7.3

| 批次 | 项 | 状态 | 落地证据（编制时实测） |
|------|----|------|----------------------|
| 0.2-A | A1 macOS 代码签名 + 公证 | ❌ 未开工 | `release.yml` / `tauri.conf.json` grep `APPLE\|signingIdentity\|codesign` 零命中 |
| 0.2-A | A2 Windows 代码签名 | 🕓 决策点 1 | 同上 |
| 0.2-A | A3 发布通道约定（stable / preview） | ❌ 未开工 | 更新端点仅 `releases/latest/download/latest.json` 单条；§8.2 已有 prerelease 约定但未与更新链路打通 |
| 0.2-A | A4 更新私钥运维演练 | ❌ 未开工 | `~/.tauri/backup/` 有备份约定，无恢复演练记录（与 H0 批次 M1 的 runbook 合并执行可省一份） |
| 0.2-B | B1 系统托盘 | ❌ 未开工 | 全仓 grep `tray` 零命中；README 自认 "no system tray yet" |
| 0.2-B | B2 开机自启动（默认关） | ❌ 未开工 | `src-tauri/Cargo.toml` 无 `tauri-plugin-autostart` |
| 0.2-B | B3 Safe Mode 界面横幅 | 🕓 计划中（前置条件已满足，待开工） | 注入机制 `harness_ui.rs::INJECT_SCRIPT` + `verify:harness-inject`（19 项断言 + 可证伪检查）已落地；对应 `AGENTS.md` §7.2「计划中」行 |
| 0.2-B | B4 插件禁用语义**重新核验** | ❌ 未开工 | 批次 C 裁决记录在 `dev-plan-disconnected-points.md` §3/§4 决策点 4 |
| 0.2-C | C1 补丁面审计（上游化候选标记） | ❌ 未开工 | `patches/` 现存 18 个补丁，无上游化标记 |
| 0.2-C | C2 首个上游 PR | ❌ 未开工 | 无 |
| 0.2-C | C3 上游升级演练（实测适配成本） | ❌ 未开工 | `dsh-upgrade-checklist.md` 无演练记录节（与 H0 批次 I2「实跑升级清单」是同一件事，**并入时合并、勿重复立项**） |
| 0.2-D | D1 Discussions + Issue 模板 | ❌ 未开工 | 仓库无 Discussions / 模板 |
| 0.2-D | D2 应用内反馈入口 | ❌ 未开工 | `menu.rs` 菜单树无 Feedback 项 |
| 0.2-D | D3 README 社区入口 | ❌ 未开工 | 无 |

---

## 批次 0.2-A — 分发硬伤（P0，最疼的先修）

> 依据（评估结论）：macOS 未签名/公证意味着 Gatekeeper 直接拦「未知开发者」，这是**劝退级**
> 首启体验；上游 dataelement 版已签名+公证并双通道运营，本仓在这一维度是硬差距。

### A1 macOS 代码签名 + 公证

- **现状**：`release.yml` 与 `tauri.conf.json` 均无任何签名/公证配置（编制时 grep 零命中）。
- **做法**：
  1. 加入 Apple Developer Program（$99/年，**0.2-决策点 1**，A1 的硬前置）；
  2. `release.yml` macOS job 注入 tauri-action 认可的环境变量：
     `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITIES` /
     `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`；
  3. 仿照现有 `TAURI_SIGNING_PRIVATE_KEY` 的**前置存在性检查**（`::error::` 早失败），
     把 `APPLE_*` 检查同样放进 preflight——缺密钥在 expensive build 之前失败；
  4. updater 的 `.sig`（minisign）与系统级签名是两条独立链，互不影响，两者都要验证。
- **验收**：干净 macOS 上双击可开（无右键绕过）；`spctl -a -vv` 判 accepted；
  已装 0.1.0 的用户经 updater 升级到签名版本后自动更新仍正常。
- **注意**：公证首次运行约需 5~15 分钟/包，会拉长 macOS release job，属预期。

### A2 Windows 代码签名（可选）

- **现状**：NSIS 安装包未签名，SmartScreen 对未知发布者拦截。
- **做法**：二选一——Azure Trusted Signing（月费低、CI 集成简单）或 OV 证书。
  与 0.2-决策点 1 一并裁决。**不裁决则本项搁置**，不阻塞批次其余内容。

### A3 发布通道约定（stable / preview）

- **现状**：单一端点 `releases/latest/download/latest.json`；§8.2 已约定 prerelease 打
  `-` 后缀并标 prerelease，但没说清它和更新链路的关系。
- **一个免费的事实（先讲清，避免过度设计）**：GitHub 的 `releases/latest` **天然不含
  prerelease**。也就是说 stable 用户（端点指向 `releases/latest`）现在就**永远收不到**
  prerelease 推送——「双通道」的 stable 侧已经免费成立。
- **首版做法（推荐，零配置改动）**：
  - stable = 现端点，行为不变；
  - preview = 用户手动安装 prerelease 安装包，此后 updater 按版本比较自然升到下一个
    prerelease / release（semver 下 `0.2.0-beta.1 → 0.2.0` 是升级，方向正确）；
  - 把这套约定写进 §8.2 与 README 发布一节，**只写文档，不动配置**。
- **后续可选**（有人实际用 preview 通道再做）：tauri-plugin-updater v2 支持
  `UpdaterBuilder::endpoints()` 运行期换端点，可为 preview 用户切到独立的
  `preview.json` 资产。实现时先验证该 API，再上配置页。
- **门禁**：给 `verify:release-workflow` 新增一条断言——prerelease tag 的 release 运行
  不得把 `latest.json` 上传到 stable 端点语义的位置（防「beta 覆盖 stable 清单」）。
  可证伪：用旧工作流夹具（无此分支）必须变红。

### A4 更新私钥运维演练（轻量；与 H0 批次 M1 合并执行）

- **现状**：私钥三处（本地 `~/.tauri`、CI Secret、离线备份），README 已写明丢失后果。
- **做法**：把「从离线备份恢复私钥并完成一次本地签名构建」写成一节，追加进
  [`dsh-upgrade-checklist.md`](dsh-upgrade-checklist.md)；发布前清单加一行「备份可读」。
  若 H0 批次 M1（签名密钥 runbook）先行，本项并入 M1，不单独执行。
- **验收**：按文档演练一次并记录日期。

---

## 批次 0.2-B — 桌面底线体验（P1；若路线图决策点 1 裁 A 则降为按需）

### B1 系统托盘

- **现状**：全仓无 tray 代码；README 自认 "no system tray yet"。关窗即退，无后台驻留。
- **做法**：
  1. `tauri` crate 开 `tray-icon` feature（Tauri 2 内置，无需新插件）；
  2. 托盘菜单**复用 `menu.rs` 的 id 与事件分发**（`handle_menu_event` 的 match 直接多
     出托盘来源）：显示/隐藏主窗口、Harness 状态信息行（禁用项，复用
     `refresh_bridge_status` 的既有模式）、Restart Harness、Restart in Safe Mode、
     View Logs…、Quit；
  3. ⚠️ 遵守 `menu.rs` 模块文档的既有教训：`muda::MenuItem` 是 `Rc`（非 `Send/Sync`），
     状态刷新走 `AppHandle::menu()` 定位句柄的同一套路，不把句柄塞进托管状态；
  4. 关窗行为依 **0.2-决策点 2**（推荐 A：关窗=隐藏到托盘）。若选 A，需在
     `on_window_event` 拦 `CloseRequested` 并 `prevent_close()` + `hide()`，同时让
     single-instance 的二次启动路径做 `show()` + 前置（现在只 focus，得补 unhide）。
- **验收（诚实声明）**：xvfb 下 L2 冒烟**无法**断言托盘（无系统托盘区），本项无自动
  门禁，走三平台手工验收清单（托盘存在、菜单项与原生菜单行为一致、关窗行为符合
  0.2-决策点 2 的选择、二次启动 unhide）。此项如实记入验收记录。
- **宣称登记**：完成后 `AGENTS.md` §7.2 加行、README / README.zh-CN 的 Features 加行
  （§7.3：先写代码，再补表）。

### B2 开机自启动（默认关）

- **现状**：无 `tauri-plugin-autostart`。
- **做法**：
  1. 引入 `tauri-plugin-autostart`（默认**关闭**，永不默认开启）；
  2. 「DSH Desktop」子菜单加 CheckMenuItem「Launch at Login」，切换经
     `app.autolaunch().enable()/disable()`；
  3. 偏好持久化落 `app_data_dir` 下的小 JSON（遵守 INV-1：可变状态不出 `app_data_dir`；
     不为此引入 store 插件）。
- **验收**：三平台手工验证开/关后系统启动项（注册表 Run 键 / LaunchAgents / XDG
  autostart）真实写入与移除；应用重启后菜单勾选态与系统状态一致。
- **宣称登记**：同 B1。

### B3 Safe Mode 界面横幅（撤销「刻意后置」的原决策）

- **原决策与其依据**：`AGENTS.md` §7.2 登记 🕓 计划中，理由是「等注入机制建在稳定地基上
  再一次性做」。**该前置条件现已满足**：`harness_ui.rs` 的 `INJECT_SCRIPT` 机制、origin
  自我早退、`verify:harness-inject` 的 19 项断言与可证伪检查都已落地并进 CI。本批开工，
  属**按原计划的解除后置**，不是推翻。（H0 计划批次 N3 亦把它列为待裁决选项——两处指向同一工作。）
- **做法（第一版收敛范围）**：
  1. `INJECT_SCRIPT` 扩展：检测「当前 profile 是 `desktop-safe-mode`」的事实来源，
     在 Harness 页顶部注入**只读横幅**；
  2. ⚠️ 横幅**不可点击、不放「退出安全模式」按钮**——按钮要求 Harness 远程 origin
     回连宿主 IPC，违反既定的「注入仅 shell → page 单向」纪律（INV-2 / 手机指示器同例，
     路线图 §10 也重申此禁令）。退出动作走新菜单项「Exit Safe Mode」= 清 safe profile
     标记 + 普通重启，同一批次实现；
  3. 横幅文案在窄屏/深色模式的样式约束写进注入脚本的模块文档。
- **验收**：`verify:harness-inject` 新增断言（安全模式时横幅存在且不渲染为按钮；
  非安全模式不渲染），**必须带可证伪变体**——把脚本回退为无横幅行为，断言必须变红；
  CRLF / LF 检出下表现一致（既有守卫纪律）。
- **宣称登记**：`AGENTS.md` §7.2 该行 🕓 → ✅；README / README.zh-CN 的
  "Planned" 节移除该项并移入 Features。

### B4 插件禁用语义重新核验（先核验，后决策，不直接开发）

- **背景**：批次 C 裁决「只接非破坏性动作」，依据是经代码核验：市场插件**没有**可逆
  解除挂载方式（改名被冷启动投影还原；摘 `desired.json` 条目触发 `sweepRegistry()`
  真删）。但**上游 dataelement 套壳现已在安全模式横幅提供「移除插件」**，说明上游
  Harness 语义自 2026-09-10 以来可能已变化——原裁决的证据链需要重走一遍。
- **做法**：
  1. 对照当前上游 `deepseek-ai/dsh`（market / `desired.json` / `sweepRegistry()` /
     profile 加载器），重走批次 C 的证据链，产出**核验记录**（新事实 vs 旧结论）；
  2. 若上游已提供 disable / quarantine 语义 → 裁决是否开发
     `recovery_action: "disable"` + 恢复页按钮（与 H0 批次 N3 的插件相关项合并考虑）；
  3. 若语义未变 → 在 `dev-plan-disconnected-points.md` 决策点 4 处追加
     「2026-09 重新核验，结论不变」，让 🕓 状态有新鲜证据支撑。
- **验收**：核验记录落档（这是核验任务的产物，不是代码）。

---

## 批次 0.2-C — 上游解耦与贡献（P2，与批次 0.2-B 可并行；与路线图 H1/P2 互证）

> 依据（评估结论）：本仓深度绑定上游内部结构（vendor + patch-package + 冷启动投影），
> 官方明示 preview 期会有破坏性变更，每个上游版本都要付一遍适配税。
> 把通用能力推成上游能力，是把这个负债转成信誉的唯一路径。
> ⚠️ 与 H0 计划的关系：本批次的 C3 与 H0 批次 I2（实跑升级清单）是**同一件事**；
> C1/C2 是 H0 未覆盖的增量。路线图 H1（资产化 `dsh-host`）与 P2（与官方桌面关系维护）
> 是本批次的战略上位——若路线图决策点 1 裁 A，C2 的「贡献」对象与形态按 H1/P2 的口径统一。

### C1 补丁面审计

- **做法**：逐条审 `patches/` 现存 18 个补丁，在
  [`patches/LAYERS.md`](../patches/LAYERS.md) 增补一列「上游化候选」：
  - **可上游化**：修复的是上游缺陷、对所有用户有价值（如纯 bug fix 类）；
  - **品牌层**：永远本地（`brand` 层天然如此）；
  - **行为层**：与上游意图有分歧、需协商或维持本地。
- **与路线图的衔接**：路线图 §5.3 / §7 已把「补丁退役」绑定到定位收缩（3 个 functional
  补丁的 `retireWhen`）；C1 的「上游化候选」列与「retireWhen」是两个正交维度
  （前者=谁该维护，后者=何时不需要），都写进 LAYERS.md，互不替代。
- **验收**：`npm run verify:patches` 仍绿（新列不破坏既有校验）；每条补丁有归类结论。

### C2 首个上游 PR

- **候选（按通用性排序，目标 `deepseek-ai/dsh`）**：
  1. **cold-start 投影接线**：`projectGenerations()` / `sweepRegistry()`「定义了但从未被
     调用」是上游缺陷（本仓在 `build/harness-node-entry.mjs` 修的），对所有 generation
     插件用户都有价值——最佳首发候选；
  2. `plugin-safety-guard` 的 `[dsh-plugin-fault]` 归因格式。
- **纪律**：PR 前先在上游 issue/discussion 提出意图（官方明确征集反馈）；**无论合入或
  被拒都记录在案**——被拒同样是结论（证明该能力必须本地维护，升级税照付）。
- **验收**：PR 链接与结论追加到本文件进度快照。

### C3 上游升级演练（把「税」从感觉变成数字；= H0 批次 I2，勿重复立项）

- **做法**：按 [`dsh-upgrade-checklist.md`](dsh-upgrade-checklist.md) 对**最新**上游版本
  完整跑一遍（补丁重生成 → 断言 → 门禁 → 三平台烟雾 → 体积对比），在该文档新增
  「演练记录」节记录：耗时（小时计）、失败点、补丁重写数。
- **目的**：官方桌面版发布后，这个数字直接决定「继续维护壳」还是「转向无头核心 +
  上游贡献」——没有数字就没有决策依据。目标版本选择遵循 H0 批次 I 的决策点（先
  `0.1.2-rc.1` 稳妥线，再进 `0.1.5-rc.*`）。

---

## 批次 0.2-D — 反馈闭环（成本最低、最优先，当天可完成）

> 依据（评估结论）：v0.1.0 采用为零，没有用户反馈闭环，功能优先级全靠猜。
> 本仓隐私姿态是「Nothing is uploaded anywhere」，因此**不做遥测**，
> 反馈靠显式渠道（与姿态一致）。路线图 §9 的投入比例、H0 的取舍，都缺这个信号源。

- **D1**：开启 GitHub Discussions；Issue 模板（bug 报告模板内嵌两步指引：先用应用内
  「Export Diagnostics…」导出**脱敏**诊断包、再附上——把本仓的隐私卖点变成工作流）。
- **D2**：应用内反馈入口——「DSH Desktop」子菜单加「Feedback / Report Issue…」→
  `opener().open_url()` 指向 Discussions（先例：`mobile-pair` 已用 `open_url` 打开
  系统浏览器；纯菜单项，**不新增 IPC 命令**，`verify:ipc-surface` 无需变更）。
- **D3**：README / README.zh-CN 顶部加社区入口与「非官方、非 DeepSeek 产品」的
  明确标注（社区同类项目均已如此，这是合规与信任成本最低的做法）。
- **验收**：模板生效（开一个测试 issue 验证渲染）；菜单项三平台可点。

---

## 本计划决策点（需用户裁决；编号加 0.2- 前缀，避免与路线图决策点 1~6 混淆）

1. **0.2-决策点 1 — 签名证书预算**（阻塞 A1/A2；与路线图决策点 6「密钥策略」正交——
   那个裁 minisign 双公钥，这个裁 OS 层证书）：Apple Developer Program $99/年是 A1 硬前置；
   Windows 走 Azure Trusted Signing 或 OV 证书与否一并裁。不买则 macOS 劝退级
   体验持续，其余照常推进。
2. **0.2-决策点 2 — 托盘关窗行为**（阻塞 B1 实现；仅在 0.2-B 保持 P1 或按需立项时生效）：
   A 关窗=隐藏到托盘（推荐，与自启动配合是常驻形态）；B 关窗=退出、托盘仅快速入口。
   注意与 single-instance 二次启动的配合需要实现时验证。
3. **0.2-决策点 3 — 插件禁用是否开发**（阻塞于 B4 核验结论）：仅当核验确认上游已提供
   可逆停用语义时立项；否则维持 🕓 并刷新核验日期。
4. **0.2-决策点 4 — 公网隧道（手机桥）**：**明确不排进本计划**。与 local-first 安全姿态
   冲突（自动在公网暴露 Harness 是姿态级让步），登记 🕓 待更充分论证；
   路线图 §10 亦把移动端排除出核心竞争力，两处口径一致。

---

## 明确不做（本计划范围内，防止范围爬升）

- **不做** PPT 模式、Agent 预设管理、模型供应商管理——官方桌面版的主场（两套评估独立得出同一结论，
  路线图 §10 已固化）。
- **不做**遥测 / 使用统计——与「Nothing is uploaded anywhere」姿态冲突；
  采用度用 GitHub releases / stars / issues 作代理信号。
- **不动** 300MB 瘦身主线——已有 [`harness-packaging-and-compatibility.md`](harness-packaging-and-compatibility.md)
  长期方案（路线图把它列为 H2/H3 的打包侧子方案），本计划不重复立项；演练（C3）产出的体积对比数据反哺它。
- **不引入** oRPC/tRPC、不为未来 UI 留死命令等既有裁定，继续有效（见
  `dev-plan-disconnected-points.md` §6）。

---

## 版本推进与发布纪律

- 批次 0.2-B 含多个 `feat`（托盘 / 自启动 / 横幅 / Exit Safe Mode）→ 依 §8.2 auto 判定
  推进 **minor → 0.2.0**；批次 0.2-D 纯 chore/docs 可随任一批；A1 落地需要发一个带签名
  产物的新版本才能被老用户收到。
- 发布纪律不变：**dispatch CI + Smoke 全绿再 tag**（§8.5，2026-09-11 起为必需步骤）。
- 每个批次收尾时更新本文件「进度快照」，并按 §7.3 完成 AGENTS.md §7.2 与
  README / README.zh-CN 的登记（**顺序：先代码，后登记**）。

---

## 施工顺序建议

```text
0.2-D（当天：Discussions + 模板 + 菜单 Feedback 项）
  → 0.2-B1/B2（托盘 + 自启动；等 Apple 证书审批的同时做；受 0.2-决策点 2 约束）
  → 0.2-A3/A4（纯文档 + 门禁断言，随时可插队；A4 优先并入 H0 批次 M1）
  → 0.2-A1（证书到位后：签名 + 公证 + preflight 检查）
  → 0.2-C1/C2/C3（与 0.2-B 并行；C3 = H0 批次 I2，统一执行）
  → 0.2-B3（横幅 + Exit Safe Mode 菜单项）
  → 0.2-B4（核验 → 0.2-决策点 3 裁决 → 视结论决定是否开发）
```

> **与 H0 批次（H~N）的排期关系**：0.2-D 与 H0 的 K（宣称纪律）同为「当天项」，建议同周；
> 0.2-A3~A4 同理。0.2-B 的去留取决于路线图决策点 1；0.2-A1/A2 取决于 0.2-决策点 1。
