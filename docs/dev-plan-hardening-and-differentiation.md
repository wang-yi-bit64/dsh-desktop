# dsh-desktop 加固与差异化开发计划

> 本计划的输入是 2026-09-12 的一次全面评估（代码审计 + 外部生态调研）。它不替代
> [`dev-plan-disconnected-points.md`](dev-plan-disconnected-points.md)（断线点施工计划 A~G，已收尾），
> 而是承接其后的第二阶段：**A~G 解决的是「宣称与代码不符」；本计划解决的是「项目本身的存续风险与产品定位」。**
>
> ⚠️ **长期定位与阶段序列以 [`roadmap.md`](roadmap.md) 为准**——本计划是本文件在路线图中的 **H0 阶段（近端 2~4 周）**；
> 两份文档若有冲突，定位/裁决以 `roadmap.md` §8 为准，施工细节以本文件为准。
>
> 状态词表沿用 [`AGENTS.md` §7.3](../AGENTS.md)：✅ 已接线 / ⚠️ 未接线 / ❌ 未实现 / 🕓 计划中 / 🗄️ 已归档。
> **本计划目前处于「计划中」——下表所有批次均未开工，无任何代码改动。**
>
> ⚠️ 本计划含**外部事实**（上游 / 竞品），已标注核实时间与来源；外部事实会过期，执行前请复核。

---

## 0. 输入：本次评估发现的不足（R1~R9）

判据来源：本仓代码实测 + 公开检索（截至 2026-09-12）。每条给出「证据位置」，便于证伪。

| 编号 | 不足 | 严重度 | 证据位置 |
|------|------|--------|----------|
| **R1** | 上游补丁脆弱性：`patch-package` 补丁钉在上游版本上，上游一改行就冲突 | ✅ **已缓解（2026-09-12）**：基线从 `0.1.2-alpha.4` 推进到 `0.1.5-rc.1`；补丁数由 18 减到 14（会话删除 4 条随重构移除）。上游仍会继续迭代（`next` 已到 `0.1.5-rc.2`），故列为**长期**风险 | `scripts/prepare-harness.mjs`（`DSH_VERSION`）；`patches/LAYERS.md` |
| **R2** | 官方桌面版的定向挤压：上游 `apps/desktop`（Electron）已实现未发布，支持 mac/win、**无 Linux**，且**独占 `$DSH_HOME/profiles/desktop`（含大小写变体）** | 🔴 高 | 上游 `apps/desktop/*`、`.agents/notes/implemented/architecture/2026-09-09-desktop-in-place-profile.md` |
| **R3** | README 过度宣称：写「一个插件无法拖垮整个 Harness」，与本仓 §7.3 明令禁止的口径冲突 | 🟠 中（纪律） | `README.md:24` vs `README.md:39`、`AGENTS.md` §7.3 |
| **R4** | 「绿色」假设被自己削弱：`ci.yml` 不监听 push、冒烟改手动、release preflight 看不见运行时行为 | 🟠 中 | `.github/workflows/ci.yml:23-27`；`AGENTS.md` §8.4 |
| **R5** | 软门禁：L2 GUI 冒烟 `continue-on-error`、fault-inject 仅 Windows 硬门禁——**POSIX 孤儿防护无阻塞性自动化门禁** | 🟠 中 | `.github/workflows/smoke.yml`（GUI 作业与 fault-inject 平台判定） |
| **R6** | 单点故障：一个 minisign 私钥丢失即对已安装用户永久断更；单维护人；更新源单一仓库 | 🟠 中 | `README.md` §Auto-update；`AGENTS.md` §7.2 更新源行 |
| **R7** | 构建可达性与配置卫生：提交了 rsproxy.cn 镜像给所有 checkout；README Node 口径 `v18+` 与实际 `MIN_NODE_MAJOR=20` 不一致；全新 checkout 无一行 bootstrap；`build/` 与 `resources/` 存在重复资产 | 🟡 低 | `src-tauri/.cargo/config.toml`（已入库）；`README.md:46`；`build/plugin-recovery.html` 469 行 vs `src-tauri/frontend/plugin-recovery.html` 628 行 |
| **R8** | 产品缺口（相对社区基线）：无系统托盘、安全模式生效时界面**无任何提示**、无插件市场 UI、无 `.dshpreset` 导入导出、无 CLI shim | 🟡 低（体验） | `AGENTS.md` §7.2「计划中」两行；`README.md:28` 自述「无系统托盘」 |
| **R9** | 定位/差异化：本质是 `dataelement/dsh-desktop` 的再实现，无独立主张；社区红海，采纳度接近零 | 🟠 中（战略） | `README.md:7`；外部竞品调研（见附录 A） |

> **重复资产的一处实测结论（可直接执行）**：`local_page()` 经 `frontendDist: ./frontend` 解析，
> `window.rs:56` 导航的是 `frontend/plugin-recovery.html`（628 行）；而 `build/plugin-recovery.html`（469 行）
> 被 `prepare-harness.mjs`（`REQUIRED_FILES` / 拷贝清单）与 `tauri.conf.json:52`（`bundle.resources`）
> 一并打包进 `resources/`，**运行时无任何加载路径**。它是死资产，且两页并存是漂移隐患。

---

## 1. 优先级矩阵

| 优先级 | 批次 | 主题 | 是否阻塞其他工作 |
|--------|------|------|------------------|
| 🔴 P0 | H | 风险哨兵（上游漂移 + profile 保留名） | 否，但 H1 是 I 的前置观测手段 |
| 🔴 P0 | I | 上游版本推进与补丁基线 | 是——不推进则一切产品工作都在旧基线上做 |
| 🟠 P1 | J | 门禁可信度（把「绿色」假设补回来） | 否 |
| 🟠 P1 | K | 宣称纪律回归（README/AGENTS 一致性） | 否 |
| 🟠 P1 | L | 构建可达性与配置卫生 | 否 |
| 🟠 P1 | M | 运维韧性（密钥 / bus factor / 更新源） | 否 |
| 🔵 P2 | N | 差异化与产品基线（**需先过决策点 1**） | 是——依赖战略裁决 |

**建议的最小起步集**（若只做一件事）：**批次 K + 批次 H**。两者成本最低、当天可完成，且直接消掉
一个纪律违规（R3）与两个最高风险（R1 的观测、R2 的守卫）。

---

## 2. 施工批次

### 批次 H — 风险哨兵 · ✅ 已完成（2026-09-12）· 🔴 P0

**目标**：把「上游一变更就打脸」从被动挨打变成提前预警；把官方桌面的两个硬约束变成会失败的检查。

**先例**：本批次的两条守卫按 `verify-ipc-surface.mjs` / `verify-harness-inject.mjs` 的模式写，
**必须带可证伪性检查**（把被守护的行为打回旧写法，断言必须变红）。

- **H1 — 上游版本漂移哨兵**
  - 新增 `scripts/verify-upstream-drift.mjs`：读 `DSH_VERSION`（单一产地 `scripts/prepare-harness.mjs`），
    对比 npm `@deepseek-ai/dsh` 的 `latest` / `next` dist-tag。判据：落后 ≥1 个 minor 或出现新 rc 线时非零退出；
    网络不可达时按「跳过而非静默通过」处理（打印 SKIP 并退出 0，与集成测试的 Node 缺失同策略）。
  - 入口 `npm run verify:drift`；`--self-test` 覆盖「落后 / 持平 / 领先 / 无网络」四态；
    可选接入一个 `schedule:` nightly job。
  - 现状（2026-09-12 复核）：基线已推进到 `0.1.5-rc.1`，与 npm `latest` 持平 → 哨兵**通过**；
    `next` 已到 `0.1.5-rc.2`，后续会再次报落后，属预期行为（它就是要提醒升级）。
- **H2 — profile 保留名守卫**
  - 新增静态检查（并入 `scripts/verify-ipc-surface.mjs` 或独立 `verify-profile-names.mjs`）：
    仓库内**任何** profile 字面量不得等于 `desktop`（ASCII 大小写任意组合）；断言
    `SAFE_MODE_PROFILE = "desktop-safe-mode"`，默认 profile 为裸子命令（不等同保留名）。
  - 现状实测：本仓**未**使用保留名 `desktop`（`crates/dsh-host/src/safe_mode.rs:17` = `desktop-safe-mode`），
    因此这是**守卫**而非修复。可证伪性检查：把 `SAFE_MODE_PROFILE` 改为 `"desktop"` 必须变红。
- **H3 — 文档化官方桌面约束**
  - 在 `docs/dsh-upgrade-checklist.md` 增加「官方桌面版约束」节：独占 `$DSH_HOME/profiles/desktop`
    （含大小写变体）、仅 mac/win、私有 `dsh-app://` 预载（无 `window.dshDesktop`），
    作为升级清单的**强制核对项**。

**验收判据**
- `npm run verify:drift` 在落后时非零退出；`verify:drift --self-test` 通过。
- profile 保留名守卫有可证伪性检查（改回 `desktop` 必红）。
- 升级清单含官方桌面约束节。

**依赖**：无。**预估**：1 天。

---

### 批次 I — 上游版本推进与补丁基线 · ✅ 已完成（2026-09-12）· 🔴 P0

**目标**：把补丁基线从 `0.1.2-alpha.4` 推进到当前 rc 线，并让「补丁健康度」成为可见报告。

> ⚠️ 这是**最高风险**也**最高价值**的一批：上游明确声明会有破坏性变更，本仓已落后若干个预发布版本。
> 不推进，则后续所有产品工作都建在一条早晚要断的基线上。

**2026-09-12 执行结果**：基线**已推进到 `0.1.5-rc.1`**（跨 4 个中间版本）。

- **I1-pre — 补丁适用性预检工具** ✅ `npm run check:patch-applicability -- --target=<版本>`：
  只下载被补丁触及的十几个包（~4MB）到内存做干跑匹配，几秒给出「干净 / 冲突（第几段 hunk）」。
  全流程零外部二进制（Node `fetch` + `zlib` + 自带 tar 读取器 + 自带 diff 匹配），
  规避了 MSYS `/tmp` 与 Node 路径翻译不一致的坑。带纯逻辑自检（含上下文漂移可证伪性）。
- **I1 — 推进 `DSH_VERSION` 并重生成补丁** ✅ **已完成**。做法不是 `patch-package` 重新生成，而是
  **三路合并移植**：以 pristine alpha.4 为共同祖先，把 rc.1 的变化叠到「alpha.4 + 补丁」的意图状态上，
  冲突逐条按语义裁定（CSS 类名 hash 改名取上游、类名映射/函数签名并集）。
- **I1-实测** ✅ 最终结果：**14 个补丁在 `0.1.5-rc.1` 上全部干净可用**（clean 14 / conflict 0）。
- **I3 — 补丁健康度报告** ✅ `npm run report:patches`（`--markdown` 写 `$GITHUB_STEP_SUMMARY`）：
  合并 `patch-layers.mjs` 的层/退役条件与 `MANIFEST.json` 的实际结果。缺记录时**不伪造 applied**。
- **I2 — 实跑升级清单全流程** 🟡 **部分**：静态部分全绿（`verify:patches`、`check:patch-applicability`、
  12 项静态门禁、`verify:drift` 转通过）；**真实组装与三平台烟雾待执行**（见验收判据）。

**⚠️ 本次升级移除了「会话永久删除」特性**：rc.1 删除了承载该逻辑的 `PersistenceCoordinator` 类
（`dsh-session-persistence/lib/index.js` 1594 → 267 行），改为 handle 模型，4 个纯删除后端补丁 +
`client-ui-workspace` 里的删除 UI 无法机械移植，只能重写。按用户裁决**移除而非盲写**：
这是**本仓自加功能的降级，不是上游能力回退**（0.1.5-rc.1 本身也没有该特性），
且属 `ui-behavior` 层允许的降级。完整记录见 [`patches/LAYERS.md`](../patches/LAYERS.md)。

**验收判据**
- `npm run verify:patches` 通过（14 个全部分级）；`check:patch-applicability --target=0.1.5-rc.1` 报全部干净。✅
- ⏳ **待补**：`npm run prepare:harness -- --force` 真实组装 + `verify:harness-tree` 通过；
  三平台 `smoke.yml -f scope=full` 全绿；`MANIFEST.json:patches[]` 无 `failed`；体积对比无异常膨胀。
  > 这几项**必须由 CI 跑**（本机无 macOS/Linux，也无真实 Harness 冒烟条件），
  > 是本次升级**尚未取得**的运行证据——在拿到之前不得声称「升级已验证」。

**依赖**：H1（已交付）。

---

### 批次 J — 门禁可信度 · ✅ 已完成（2026-09-12）· 🟠 P1

**目标**：把「tag 提交一定绿过」这个已被自己摘掉的假设补回来，且不引入不可接受的 CI 成本。

- **J1 — L2 GUI 冒烟转硬门禁**。当前 `continue-on-error`。先解决 xvfb / 窗口启动的稳定性，
  再改为硬门禁（可先 mac/win 硬、Linux 软，逐步收紧）。
- **J2 — POSIX 孤儿防护进硬门禁**。`fault-inject` 目前仅 Windows 硬门禁；把 mac/linux 也纳入阻塞。
  这是 INV-3 在非 Windows 平台唯一的运行时证据，不应是软的。
- **J3 — 发版前置的秒级运行时保障**。在 `release.yml` 的 `preflight` 增加一次
  `cargo test -p dsh-host`（无 GUI、秒级），作为「组装 300MB 之前」的最低运行时防线；
  或增加一个 `schedule:` nightly 跑静态+单测，避免完全依赖人工 dispatch。

**验收判据**
- 故意注入一个孤儿进程缺陷，三平台 `fault-inject` 必须变红。
- 一条变体回退检查证明「软→硬」确实抬高了门禁（旧配置下断言为绿、新配置下为红）。

**依赖**：无（但 J1 可能需要先修 CI 环境）。**预估**：2~3 天。

---

### 批次 K — 宣称纪律回归 · ✅ 已完成（2026-09-12）· 🟠 P1（成本最低）

**目标**：消掉 README 与 AGENTS 的口径冲突，并让这类冲突以后**不可能**再出现。

- **K1 — 修 `README.md:24`**：删除/改写「one plugin cannot take down the whole Harness」，
  与 `README.md:39` 及 `AGENTS.md` §7.3 的「同进程插件崩溃仍可能带走 Harness」对齐。
- **K2 — 新增 `npm run verify:claims`**：交叉检查 README 状态图例与 `AGENTS.md` §7.2 表——
  同一能力在两侧必须状态词一致；并禁止 README 出现 §7.2 明令禁止的表述
  （如「插件崩溃不拖垮主程序」）。带可证伪性检查（注入旧 README 文本必须变红）。
- **K3 — 把 §7.3 的自查命令自动化**：`grep -rn "⚠️ 未接线\|未实现" AGENTS.md README.md docs/`
  进 CI，且区分「预期内命中」（词表/历史盘点/规范文档）与「真实欠债」。

**验收判据**
- `verify:claims` 在注入旧 README 文本时必须变红。
- `README` 与 `AGENTS` 的状态词逐行一致。

**依赖**：无。**预估**：0.5~1 天。

---

### 批次 L — 构建可达性与配置卫生 · 🕓 计划中 · 🟠 P1

**目标**：让「全新 clone → 能编译」是一条命令；去掉对本机与特定区域的隐式绑定。

- **L1 — 区域镜像去隐式化**：`src-tauri/.cargo/config.toml` 的 `rsproxy.cn` 不应强制所有
  checkout（含海外 / CI）走镜像。改为不提交 + 提供 `config.toml.example`，或在文档里显式说明并允许覆盖。
- **L2 — Node 版本口径统一**：`README.md:46` 的 `v18+` 改为与 `MIN_NODE_MAJOR`（20）一致，
  并加断言（新脚本或并入 `verify:target`）防止再次漂移。
- **L3 — 一行 bootstrap**：`npm run bootstrap`（`stub-tauri-resources` + `cargo check`），
  写进 README「fresh checkout」段。
- **L4 — 清理重复资产**：确认 `resources/plugin-recovery.html` 无加载路径后，删除
  `build/plugin-recovery.html` 并从 `prepare-harness.mjs`（`REQUIRED_FILES` / 拷贝清单）、
  `stub-tauri-resources.mjs`、`tauri.conf.json:bundle.resources` 三处移除对应条目；
  加一条检查，确保 `bundle.resources` 里每个页面都存在运行时加载路径。

**验收判据**
- 干净 clone 到 `cargo check` 只需一条命令；README 不再出现 `v18`。
- `resources/` 中无「被打包但无加载路径」的页面；该检查可证伪。

**依赖**：无。**预估**：1 天。

---

### 批次 M — 运维韧性 · 🕓 计划中 · 🟠 P1

**目标**：降低单点故障（R6）的实际杀伤力；把关键运维步骤变成「第二个人也能执行」。

- **M1 — 签名密钥 runbook**：写一个备份校验脚本（公钥与 `~/.tauri/backup/*.pub` 逐字节比对），
  以及「私钥丢失后」的用户沟通与迁移预案（是否引入双公钥过渡，见决策点 4）。
- **M2 — 更新源故障演练**：验证 `latest.json` 缺失 / 端点不可达时客户端的可辨识行为
  （应报错而非静默认为「无更新」，与 §7 的两条纪律一致）。
- **M3 — bus factor runbook**：`docs/runbook/` 收录「发布一个 patch」「轮换密钥」「上游升级」
  三个可被未参与开发者照做的流程。

**验收判据**
- 备份脚本能在密钥丢失前检测出缺失/不匹配。
- 按 runbook 能让一个未参与开发的人独立发布一个 patch 版本。

**依赖**：无。**预估**：1~2 天。

---

### 批次 N — 差异化与产品基线 · 🕓 计划中 · 🔵 P2（**阻塞于决策点 1**）

**目标**：回答「用户为什么要选它」。**本批次的取舍完全取决于决策点 1 的裁决，未裁决前不动手。**

- **N1 — Linux 优先定位**（推荐主线）：官方桌面**明确不支持 Linux**，这是本仓最清晰的可辩护空白。
  把 Linux 出包提升为一等公民（CI 必过、README 首屏标注 Linux 支持），补齐 Wayland / AppImage
  已知问题的用户文档。实测证据：本仓已有 deb/AppImage 与 linuxdeploy 剪纸经验。
- **N2 — 把已埋着的核心能力做成「可运维」标签**：`crates/dsh-host` 的 supervisor / 孤儿防护 /
  诊断归因 / 脱敏导出，深度强于多数竞品且无 GUI 依赖（INV-6）。可选动作：
  把 `dsh-host` 作为独立可复用 crate / CLI 对外提供（`dsh-host doctor` 已存在），
  或**向上游 Electron 项目（`dataelement/dsh-desktop`）贡献这套 Rust 核心**——见决策点 1。
- **N3 — 补齐用户预期基线（择一或按反馈）**：系统托盘、安全模式可见性横幅
  （`AGENTS.md` §7.2 两个「计划中」项可提前）、插件市场 UI、`.dshpreset` 导入导出、CLI shim。
- **N4 — 明确不做**：皮肤 / 桌面宠物 / SSH 面板等「花活」交给对手，不构成差异化。

**验收判据**
- N1：Linux 安装包在干净 Ubuntu 22.04 / 24.04（Wayland 与 X11）上冒烟通过。
- N3：每个补上的能力都必须进 `AGENTS.md` §7.2 表并带运行时调用方（§7 顺序不可颠倒）。

**依赖**：**决策点 1**。**预估**：视裁决而定（3 天 ~ 2 周）。

---

## 3. 需要你裁决的决策点

> 与上一份计划（A~G）一样，决策点只需给字母，不必展开。

### 决策点 1 — 项目战略定位（阻塞批次 N）
评估给出的建议是 **A**，但这是**产品方向**问题，只有你能定：
- **A（推荐）— Linux-first 独立产品**：吃官方不做的 Linux 空白 + 把「可运维性」做成标签。
- **B — 融入上游**：把 Rust 核心 / 无头 host 贡献给 `dataelement/dsh-desktop`（或上游），
  本仓转为技术验证 / 核心库提供方。**不与红海争壳，让投入产生实际影响。**
- **C — 维持自用**：不追用户，只做防御性批次（H/I/J/K/L/M），跳过 N。

### 决策点 2 — 上游推进目标版本（阻塞批次 I1）
- **A（推荐）— 稳妥**：先到 `0.1.2-rc.1`（与 docs 已记录漂移一致），验证流程后再进 `0.1.5-rc.*`。
- **B — 激进**：直接追最新 `0.1.5-rc.*`，一次到位但补丁冲突风险集中释放。

### 决策点 3 — 门禁强度与 CI 成本（阻塞批次 J）
是否接受把 L2 GUI 冒烟与 POSIX fault-inject 转为硬门禁所带来的 CI 时长与 flaky 成本？
（可折中：mac/win 硬、Linux 软。）

### 决策点 4 — 签名密钥迁移策略（阻塞批次 M1）
私钥丢失对已安装用户不可恢复。是否引入「双公钥过渡」机制（代价：发布流程复杂化），
还是维持单密钥 + runbook + 沟通预案？

### 决策点 5 — 是否补产品基线（批次 N3）
托盘 / 安全模式横幅 / 插件市场 / `.dshpreset` / CLI shim——哪几个必须有，哪些明确不做？

---

## 4. 明确不做的项

- **不重写 Harness UI**：本仓是壳，UI 归上游 / 官方。
- **不为 Harness 远程 origin 开反向 IPC**：注入只做壳 → 页面单向（INV-2），不因产品需求破例。
- **不做皮肤 / 桌面宠物 / SSH 面板**：非差异化，且与「可运维 / 可信赖」定位相悖。
- **不在 `push` 上恢复全量 CI**：日常提交要的是快反馈；成本高的动作走手动 / nightly（J3 是替代路径）。

---

## 5. 顺带修正（低成本，可并入任一批次）

| 项 | 位置 | 处理 |
|----|------|------|
| README Node 版本口径 | `README.md:46` | 改 `v18+` → 与 `MIN_NODE_MAJOR=20` 一致（并入 L2） |
| 重复恢复页 | `build/plugin-recovery.html` | 确认无加载路径后删除（并入 L4） |
| 本机绝对路径配置 | `.cargo/config.toml`（根，已 gitignore） | 不影响 CI，但应在 README 记一句「本机开发环境专用」 |

---

## 附录 A — 外部事实（核实于 2026-09-12，会过期，执行前复核）

- **官方 DSH**：`github.com/deepseek-ai/deepseek-harness`，npm `@deepseek-ai/dsh`，基于 **Cordis** 插件框架，
  `npx @deepseek-ai/dsh web`（默认 `127.0.0.1:3080`）。处于 **developer preview**，明确声明破坏性变更。
  dist-tags（2026-09-11）：`latest=0.1.5-rc.1`、`next=0.1.5-rc.2`。
- **官方桌面版**：上游 `apps/desktop` 有**完整实现但未发布**（设计笔记原文 “Desktop has not been released”），
  **Electron** 架构、版本与 dsh 锁死、内置 Node+pnpm、私有 `@deepseek-ai/dsh-desktop-host`、
  **仅 mac-arm64/x64 + win-x64，无 Linux**、独占 `profiles/desktop`。**无公开公告、无下载端点、无 GA 日期。**
  > ⚠️ 用户「官方近期发布桌面版」的判断与代码状态一致，但**未获官方声明证实**——不宜对外当作既成事实。
- **社区套壳（星数为 GitHub API 读数，疑似偏高，仅作方向参考）**：
  `anywhere-labs/dsh-desktop`（最热门）、`dataelement/dsh-desktop`（**本仓上游**，Electron）、
  `dsh-tauri-desk/deepseek-harness-desktop`（**最直接的 Tauri 对标**）、
  `zouyuxuan122/DSH-Desktop-EAC`（Tauri）。共性卖点：插件市场、`.dshpreset`、皮肤、手机远程、CLI shim。
  **本仓在工程深度上领先，在采纳度上垫底。**

---

## 6. 执行顺序建议

```
批次 K（0.5~1d，消纪律违规）
   └─ 批次 H（1d，上哨兵）
         └─ 批次 I（2~4d，推进上游基线）★ 最高风险
               └─ 批次 M（1~2d，运维韧性）
批次 J（2~3d，门禁可信度）—— 与上并行
批次 L（1d，构建卫生）—— 与上并行
        └─ [决策点 1 裁决] ──> 批次 N（3d~2w，差异化）
```

**当前状态（2026-09-12）**：按用户指定顺序 **H → I → J → K** 执行了一轮。结果如下：

| 批次 | 状态 | 交付 |
|------|------|------|
| **H** 风险哨兵 | ✅ 完成 | `verify:drift`（上游漂移哨兵，含自检）/ `verify:profile-names`（profile 保留名守卫，含可证伪性）/ 升级清单新增「官方桌面版约束」节；三者已进 CI，真检查进 `drift.yml` nightly |
| **J** 门禁可信度 | ✅ 完成 | `smoke.yml`：故障注入转**三平台硬门禁**、L2 在 win/mac 转硬门禁（Linux 保留信息性）；`ci.yml` 增设**每日定时**以补偿「日常零自动化」 |
| **K** 宣称纪律 | ✅ 完成 | 修正两份 README 的「插件无法拖垮 Harness」过度宣称；`verify:claims`（含 C1~C4 + 可证伪性自检）把 README↔AGENTS 一致性变成会失败的检查，已进 CI 与 release preflight |
| **I** 上游推进 | 🟡 部分完成 | 交付预检工具 `check:patch-applicability` + 报告 `report:patches` + 实测结论（**15 干净 / 3 冲突**）；**版本号推进本身未执行**（需 3 个补丁语义重做 + 三平台验证窗口，理由见批次 I 节） |

已通过验证：全部 17 个既有门禁 + 4 个新守卫自检全绿；无头 cargo 门禁 `cargo test -p dsh-contracts -p dsh-host -p dsh-host-cli` 全绿（0 失败）；四个工作流 YAML 均可解析。

**下一步建议**：① 执行批次 I 的版本推进（升级清单 Step 1~2 已备好）；② 裁决路线图 §8 决策点 1（战略定位，解锁批次 N）；③ 批次 L（构建卫生，一天）与 M（运维韧性）。
