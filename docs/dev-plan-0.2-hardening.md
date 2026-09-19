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

> 最后更新：2026-09-18（0.2-B1 + 0.2-D2 已收尾）· 状态词表见 `AGENTS.md` §7.3

| 批次 | 项 | 状态 | 落地证据 |
|------|----|------|----------------------|
| 0.2-A | A1 macOS 代码签名 + 公证 | ❌ 未开工 | `release.yml` / `tauri.conf.json` grep `APPLE\|signingIdentity\|codesign` 零命中 |
| 0.2-A | A2 Windows 代码签名 | 🕓 决策点 1 | 同上 |
| 0.2-A | A3 发布通道约定（stable / preview） | ❌ 未开工 | 更新端点仅 `releases/latest/download/latest.json` 单条；§8.2 已有 prerelease 约定但未与更新链路打通。**注**：双上游通道（§8.6）已先一步落地，「通道」一词现在有两个含义（上游运行时线 vs 用户可见发布通道），A3 指的是后者 |
| 0.2-A | A4 更新私钥运维演练 | ❌ 未开工 | `~/.tauri/backup/` 有备份约定，无恢复演练记录（与 H0 批次 M1 的 runbook 合并执行可省一份） |
| 0.2-B | B1 系统托盘 | ✅ **已完成（2026-09-18）** | `src-tauri/src/tray.rs`（图标 / 菜单 / 事件 / 状态行 + 平台分支）、`window.rs::reveal_main_window`、`on_window_event` 的关窗改隐藏、`lib.rs::shutdown`（退出前优雅停机）、`scripts/generate-tray-icons.mjs` + 两份入库图标资产。**决策点 2 采用 A（关窗=隐藏到托盘）**，见下文 B1 执行记录 |
| 0.2-B | B2 开机自启动（默认关） | ❌ 未开工 | `src-tauri/Cargo.toml` 无 `tauri-plugin-autostart`。**与 B1 的联动**：托盘已让应用具备常驻形态，自启动现在是「锦上添花」而非前置 |
| 0.2-B | B3 Safe Mode 界面横幅 | 🕓 计划中（前置条件已满足，待开工） | 注入机制 `harness_ui.rs::INJECT_SCRIPT` + `verify:harness-inject`（19 项断言 + 可证伪检查）已落地；对应 `AGENTS.md` §7.2「计划中」行 |
| 0.2-B | B4 插件禁用语义**重新核验** | ❌ 未开工 | 批次 C 裁决记录在 `dev-plan-disconnected-points.md` §3/§4 决策点 4 |
| 0.2-C | C1 补丁面审计（上游化候选标记） | ❌ 未开工 | `patches/` 现存 13 个（alpha 线；next 线 14 个），无上游化标记 |
| 0.2-C | C2 首个上游 PR | ❌ 未开工 | 无。**注**：alpha.2 升级时上游反向采纳了本仓的键盘导航修复（见 §8.6），属事实上的上游化，但未走 PR 流程 |
| 0.2-C | C3 上游升级演练（实测适配成本） | ❌ 未开工 | `dsh-upgrade-checklist.md` 无演练记录节（与 H0 批次 I2「实跑升级清单」是同一件事，**并入时合并、勿重复立项**） |
| 0.2-D | D1 Discussions + Issue 模板 | ✅ **已完成（2026-09-12）** | Discussions 已开启（GraphQL `hasDiscussionsEnabled: true`，六个默认分类）；`.github/ISSUE_TEMPLATE/` 下 `bug_report.yml`（内嵌脱敏诊断包两步指引）、`feature_request.yml`、`config.yml`（关闭空白 issue + Discussions 联系入口） |
| 0.2-D | D2 应用内反馈入口 | ✅ **已完成（2026-09-18）** | `src-tauri/src/feedback.rs` + `frontend/feedback.html` + 3 条命令（`feedback_context` / `feedback_open` / `feedback_channel_open`）+ CX-13 四个渠道常量 + `crates/dsh-host/src/runtime_manifest.rs`；入口在「DSH Desktop」菜单、托盘菜单与错误页三处。**比原计划（纯 `open_url` 链接）多做了一步**，理由见 D2 执行记录 |
| 0.2-D | D3 README 社区入口 | ❌ 未开工 | 无 |

---

## 批次 0.2-B1 执行记录（2026-09-18）

**范围**：托盘图标 + 菜单 + 关窗驻留 + 退出语义。**决策点 2 采用 A**（关窗=隐藏到托盘），
理由是它与手机桥的存在意义直接绑定：桥的价值在于「人在别处、Harness 在跑」，而旧行为
（关窗即退出）恰好把这一刻销毁。B2 自启动仍未做，托盘不依赖它。

**实现要点（每条都对应一个会被踩的坑）**：

1. **托盘菜单与应用菜单共用 id，而不是各写一份**：`menu.rs` 把 11 个菜单 id 提成
   `pub const`，两个菜单都引用同一批常量、事件都汇进 `menu::handle_menu_event`。
   各写一遍字符串的话，「托盘里的重启忘了走安全模式 profile 落盘」不会有任何编译错误。
2. **平台分支是必需的，不是优化**：Linux **没有**托盘点击事件（`libappindicator` 后端
   不派发 `TrayIconEvent`），若照 Windows 那样关掉「左键出菜单」，Linux 用户会得到一个
   **点了没反应**的图标——因此 Linux 保留左键菜单、靠菜单项唤回窗口；macOS 的菜单栏图标
   原生就是「点击即菜单」，另需单色模板图（彩色方块在深色菜单栏里糊成一团）。
3. **关窗拦截必须能自证「托盘真的在」**：`CloseRequested` 里先查 `tray_by_id`，查不到就
   **不隐藏**、退回旧语义（关窗即退出）。否则托盘创建失败的环境（无 AppIndicator 的
   Linux）会得到一个既没有窗口、也没有托盘入口的进程，用户只能去任务管理器结束它。
4. **退出必须先优雅停机**：`app.exit()` **不经过** `CloseRequested`，托盘把唯一的停机点
   改掉之后，不显式停机就只能由 JobObject / PDEATHSIG **强杀** Harness（来不及落盘收尾）。
   因此 `lib.rs::shutdown` 成为所有 Quit 路径的必经点。
5. **Linux 的 `libappindicator` 缺失会让应用 panic 退出**（实测读源码确认）：
   `libappindicator-sys` 用 `Lazy<Library>` 加载 `libayatana-appindicator3.so.1` /
   `libappindicator3.so.1`，两个都失败时**直接 `panic!`**（`backcompat` 特性认无 `.1`
   后缀的名字，但默认关闭）。该 panic 从 `builder.build()` 穿出 `setup` 会把**整个应用**
   带崩——对一个「没有托盘就少个便利设施」的功能来说不可接受。修法：先 `dlopen` 探测同样
   两个名字（探不到就返回错误，不进会 panic 的路径），外加 `catch_unwind` 兜住其它 panic。

**验收（如实记录）**：**本项无自动门禁**——CI 容器里没有系统托盘区，托盘的存在与交互
**测不了**。已验证的部分与未验证的部分必须分开写：

| 项 | 状态 | 证据 |
|---|---|---|
| 托盘创建、图标渲染 | ✅ 实测（Windows） | 交互式跑 debug 构建：`desktop.log` 有 `system tray created (id=main-tray)`，通知区可见图标 |
| 关窗→隐藏、进程存活 | ✅ 实测（Windows） | 点关闭按钮后日志出现 `main window hidden to the tray; Harness keeps running`，进程仍在（`tasklist` 命中） |
| 唤回窗口 | ✅ 实测（Windows） | 二次启动触发 single-instance 回调（与托盘点击共用 `reveal_main_window`），窗口从隐藏态回到前台 |
| 反馈页与渠道外链 | ✅ 实测（Windows） | 错误页「报告问题…」→ 页面渲染出真实版本 / 通道 / 路径；点「Bug 报告」后日志 `feedback channel opened: bug (…bug_report.yml)`，系统浏览器打开预填表单 |
| **托盘菜单展开与各项点击** | ⚠️ **未实测** | 自动化工具拒绝向系统 shell 区域派发原始输入；**待三平台手工验收**（展开菜单、逐项点击、核对与菜单栏同名项行为一致） |
| **Linux / macOS 的托盘行为** | ⚠️ **未实测** | 本机只有 Windows。**待三平台手工验收**，重点：Linux 用菜单「Show Window」唤回（无点击事件）、macOS 模板图标在浅/深色菜单栏下都清晰 |

> 手工验收清单（发给测试者）：① 托盘图标存在且清晰；② 右键（Linux/macOS 为左键）展开菜单，
> 11 项文案正确；③ 点「Show Window」→ 窗口出现；④ 关窗 → 图标仍在、进程仍在、Harness 未重启
> （端口不变）；⑤ 菜单「Restart Harness」→ 真的重启（端口变化）；⑥ 「Quit DSH Desktop」→
> 进程退出且**没有**残留 node 子进程；⑦ 断网或删掉 `libappindicator` 后启动 → 应用**仍能起来**、
> 关窗即退出。

## 批次 0.2-D2 执行记录（2026-09-18）

**范围**：应用内反馈入口。原计划是一条纯 `open_url` 的菜单项（D2 原文：「纯菜单项，
**不新增 IPC 命令**，`verify:ipc-surface` 无需变更」）；实际做成**一个应用内页面 + 3 条命令**。
**这是一处有意的范围扩张**，判据如下——若认定不该扩张，回退成本是一条菜单项，因此把理由写全：
1. **原方案的断点**：直接 `open_url` 到 issue 模板，用户落地时看到的是「请先导出诊断包、
   附上版本与平台」的指引——而他此刻**已经离开了应用**，想照做还得切回来找菜单。模板写得
   再清楚，也改变不了「指引与执行不在同一处」。
2. **双通道让「版本号」不再自述运行时**（§8.6）：`next` 与 `alpha` 线共用同一批桌面版本号，
   光看版本号推不出内置的是哪条上游线。反馈页把 `MANIFEST.json` 的 `target` / `versions.dsh` /
   `patches[]` 直接读出来，**这是壳自己才有的信息**，用户复制粘贴即可。
3. **隐私姿态不变**：页面只读本机信息、只调 `opener` 打开浏览器，**不上传任何内容**。
   三个外链出口走**白名单**（`Channel` 四值），拒绝任意 URL——否则本地页等价于获得了一个
   「以宿主身份打开任意链接」的能力。
4. 新增的 `runtime_manifest.rs` 落在 `dsh-host`（无头 crate）而非 `src-tauri`：它是纯读文件 +
   解析，**能不能在没有窗口系统的机器上被测试**的判据指向无头侧（§3 第 1 条），且已有
   5 条单测（含桩清单 / 损坏清单 / 未知 outcome 三组边界）。

**验收**：`feedback_context` 返回值与 `MANIFEST.json` 实际内容一致（实测：桩清单下正确显示
`unknown`）；`feedback_channel_open` 的四个渠道实测打开到正确地址；白名单越界返回 `E7002`
（单测钉住，含 `""` / `BUG` / `javascript:` 三个负例）。

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

> ✅ **已于 2026-09-18 交付**。执行记录（含实测 / 未实测的分界与手工验收清单）见文首
> 「批次 0.2-B1 执行记录」。下面保留的是**原计划原文**，其中第 3 条的前提已被证伪、
> 第 4 条已按决策点 2 = A 落地——两处都在执行记录里写明了实际做法。

- **现状（编制时）**：全仓无 tray 代码；README 自认 "no system tray yet"。关窗即退，无后台驻留。
  → **现已不成立**：见本文件「批次 0.2-B1 执行记录」。
- **做法**：
  1. `tauri` crate 开 `tray-icon` feature（Tauri 2 内置，无需新插件）；
  2. 托盘菜单**复用 `menu.rs` 的 id 与事件分发**（`handle_menu_event` 的 match 直接多
     出托盘来源）：显示/隐藏主窗口、Harness 状态信息行（禁用项，复用
     `refresh_bridge_status` 的既有模式）、Restart Harness、Restart in Safe Mode、
     View Logs…、Quit；
  3. ⚠️ ~~遵守 `menu.rs` 模块文档的既有教训：`muda::MenuItem` 是 `Rc`（非 `Send/Sync`），
     状态刷新走 `AppHandle::menu()` 定位句柄的同一套路，不把句柄塞进托管状态~~。
     **该前提在执行时被证伪**：那句话对 **`muda` 自己的类型**成立，对 **Tauri 的包装类型
     不成立**（`tauri::menu::MenuItem<R>` 是 `Arc<MenuItemInner<R>>`，后者带
     `unsafe impl Send/Sync` 且每次访问都经 `run_on_main_thread` 派发）。更关键的是
     **托盘没有 `menu()` 读取器**（只有 `set_menu`），所以「重新定位句柄」这条路根本走不通。
     实际做法：`TrayHandles { status, mobile_status }` 托管在应用状态里。
  4. 关窗行为依 **0.2-决策点 2**，**实际采用 A**（关窗=隐藏到托盘）：`on_window_event` 拦
     `CloseRequested` → `prevent_close()` + `hide()`；single-instance 二次启动改调
     `window::reveal_main_window`（show → unminimize → focus 三步，缺一步就是「点了没反应」）。
     另补一处计划里没有的：**所有 Quit 路径先 `shutdown()` 再 `exit()`**——`app.exit()` 不经过
     `CloseRequested`，不补就会让 Harness 只能被强杀。
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

- **做法**：逐条审 `patches/` 现存 14 个补丁，在
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
- **D2**：应用内反馈入口。**原计划**：「DSH Desktop」子菜单加「Feedback / Report Issue…」→
  `opener().open_url()` 直接指向 Discussions（纯菜单项，不新增 IPC 命令）。
  **实际交付（2026-09-18）**：改为打开**应用内反馈页**，即上面那条只保留了「外链出口」
  这一半；执行记录与范围扩张判据见本文件「批次 0.2-D2 执行记录」一节（在进度快照之后）。
- **D3**：README / README.zh-CN 顶部加社区入口与「非官方、非 DeepSeek 产品」的
  明确标注（社区同类项目均已如此，这是合规与信任成本最低的做法）。
- **验收**：模板生效（开一个测试 issue 验证渲染）；菜单项三平台可点。

### D1 执行记录（2026-09-12）

- **Discussions**：经 GitHub API 开启（`PATCH /repos/wang-yi-bit64/dsh-desktop {"has_discussions": true}`），
  GraphQL 复核 `hasDiscussionsEnabled: true`；默认六个分类（Announcements / General / Ideas /
  Polls / Q&A / Show and tell）原样保留，未另建自定义分类。
- **模板**：`.github/ISSUE_TEMPLATE/` 下三个文件——
  - `bug_report.yml`：12 个条目。正文内嵌**两步指引**（① 菜单「Harness → Export Diagnostics…」
    导出脱敏包；② 建完 issue 后把 `.zip` 拖进评论区——GitHub 只允许对已创建的 issue 挂附件），
    并给出「应用起不来、菜单点不到」时按平台取 `desktop.log` / `harness.log` 的路径表，
    同时**显式警告原始日志未脱敏**（`harness.log` 含明文 launch token 与 `dsh-auth-*` cookie）。
  - `feature_request.yml`：明确本仓是套壳，Harness 侧功能应提给上游 `deepseek-ai/dsh`。
  - `config.yml`：`blank_issues_enabled: false`（关闭空白 issue，强制走模板）+ Discussions 联系入口。
- **校验方式**：模板结构按 GitHub 官方 issue-form JSON Schema
  （`json.schemastore.org/github-issue-forms.json`）逐条核对。该 Schema 明确 **`checkboxes`
  不接受 `validations`**——勾选项的「必填」只能写在 option 的 `required` 上；首版误把 `required`
  写在 attributes 层，已按 Schema 修正。这类错误不会让文件变成非法 YAML，只会让表单在 GitHub
  侧渲染异常，因此不能靠「YAML 能解析」当通过判据。
- **未纳入本项**：D2（应用内 Feedback 菜单项）、D3（README 社区入口 + 「非官方」标注）保持
  ❌ 未开工。本项只交付 Discussions 与 issue 模板；发现渠道的**入口**（菜单 / README 顶部）
  属 D2/D3，尚未落地。

---

## 本计划决策点（需用户裁决；编号加 0.2- 前缀，避免与路线图决策点 1~6 混淆）

1. **0.2-决策点 1 — 签名证书预算**（阻塞 A1/A2；与路线图决策点 6「密钥策略」正交——
   那个裁 minisign 双公钥，这个裁 OS 层证书）：Apple Developer Program $99/年是 A1 硬前置；
   Windows 走 Azure Trusted Signing 或 OV 证书与否一并裁。不买则 macOS 劝退级
   体验持续，其余照常推进。
2. **0.2-决策点 2 — 托盘关窗行为**（阻塞 B1 实现；仅在 0.2-B 保持 P1 或按需立项时生效）：
   A 关窗=隐藏到托盘（推荐，与自启动配合是常驻形态）；B 关窗=退出、托盘仅快速入口。
   注意与 single-instance 二次启动的配合需要实现时验证。
   ✅ **2026-09-18 已按 A 实现**（`on_window_event` 拦 `CloseRequested` → `prevent_close` +
   `hide`；二次启动与托盘点击共用 `reveal_main_window`）。补充一条实现时才暴露的约束：
   **托盘创建失败的环境必须回退到 B**（关窗即退出）——隐藏一个没有托盘入口可唤回的窗口，
   等于让进程无从触达；判据是 `tray_by_id(TRAY_ID).is_some()`。
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

**已完成**：0.2-D1（2026-09-12）、**0.2-B1 + 0.2-D2（2026-09-18）**。
B1 与 D2 同日做是有理由的：托盘的「常驻 + 菜单复用」让反馈入口多了一个落点
（窗口藏起来时用户仍需能报问题），而 D2 的页面又依赖 B1 建立的
`window::reveal_main_window`（否则从托盘点菜单打开页面时窗口不会出现）。

> **与 H0 批次（H~N）的排期关系**：0.2-D 与 H0 的 K（宣称纪律）同为「当天项」，建议同周；
> 0.2-A3~A4 同理。0.2-B 的去留取决于路线图决策点 1；0.2-A1/A2 取决于 0.2-决策点 1。
