# dsh-desktop 断线点施工计划

> 盘点日期：2026-09-10 · 方法：全仓静态证据核验（定义点 ↔ 调用方 ↔ 注册点 ↔ UI 调用面 ↔ CI 入口），**不采信文档自述**
> 关联：上一轮的「优化执行」记录（批次 1 + 批次 3）——该文件为**本地工件**，位于 `.workbuddy/artifacts/dsh-desktop-optimization-execution.md`，**未入库**（`.workbuddy/` 见 `.gitignore`）。
>
> 📂 **本文件已入库**（`docs/`）。同批产出的若干报告（`overview.md`、`batch-b-updater-closure.md`、`phone-indicator-and-snapshot-contract.md`）仍留在 `.workbuddy/artifacts/` 作为本地工件；本文件若引用它们会显式标注「本地工件」。

---

## 进度快照

> 最后更新：2026-09-10（批次 C/D/E/F/G 施工完成） · 状态词表见本文件 §3 与 `AGENTS.md` §7.3

| 批次 | 覆盖断线点 | 状态 | 落地证据 |
|------|-----------|------|---------|
| **A** 止血与死代码处置 | D6、D8、D9、D1(部分) | ✅ **已完成** | 5 个提交 `c99a401` → `45611f9`；命令面 16 → 13；3 个孤儿脚本接线并进 CI |
| **B** 更新链路闭环 | D2 | ✅ **已完成**（B1 + B2 同批） | `60682ac`(B1) · `7a3ca73`(B2) · `8694eb0`(文档)；`updates://status` 监听方 0 → 1 |
| **C** 恢复流程闭环 | D7、D11 | ✅ **已完成** | `476a056` 快照契约修复；恢复页重写并接线（`recovery_action` / `recovery_status` / `recovery_open`）；`safe-mode.html` 删除（不可信实现，见 §3 批次 C）；命令面 17/17 全接线 |
| **D** 诊断能力 | D3、D10 | ✅ **已完成** | `dsh-host::diagnostics_export`（脱敏 + zip，5 类规则、正反用例）、`dsh-host::logs_view`、`frontend/logs.html`；`diagnostics_export` / `logs_read` 命令接线；错误页与菜单双入口 |
| **E** `IpcEnvelope<T>` 收敛 | D1 | ✅ **已完成** | `E1xxx`~`E7xxx` 错误码表 + `AppError` 成为封套载荷；17 个命令全部返回 `CommandResult<T>`；三个页面解包 `success` |
| **F** 插件隔离 / 模型网关 | D4、D5 | ✅ **已完成**（按裁定「冻结并归档」） | `plugin_worker.rs`、`plugin-worker-host.mjs`、`PluginWorkerClient`、`crates/dsh-model-gateway/**` 全部删除；两份设计文档移入 `docs/archive/` |
| **G** 剩余清理 | D8 尾项 | ✅ **已完成** | `open_external` 删除（与导航白名单重复）；`is_openable_external` 随之移除；`ALLOW_UNUSED_COMMANDS` / `ALLOW_DEAD_CODE_ALLOW` 清空 |

**另有本轮追加的两项**（来自用户追加要求，不在原盘点范围内）：

| 项 | 状态 | 落地证据 |
|----|------|---------|
| Harness 页注入机制 + 页内手机状态指示器 | ✅ 已完成 | `18e26f5`(功能) · `6319994`(门禁) · `d6b7fb0`(文档)；**并更正了「Tauri webview 无 preload / 初始化脚本」这一错误前提** |
| 安全模式界面指示器登记为「计划中」 | ✅ 已完成 | `58ce571`；AGENTS.md §7.3 新增四状态词表（✅/⚠️/❌/🕓） |

> ✅ **推送状态**：批次 A/B 的提交已推送到远端 `origin/main`（`8641966..476a056`）。
> **批次 C~G 尚未提交**（工作区改动）。
> 推送时 GitHub 提示默认分支有 1 个 **moderate** 级别的 Dependabot 告警（`security/dependabot/2`），与本批改动无关，待单独处理。
>
> 📌 **归属**：本文件位于 `docs/`，**随仓库入库**，与 `docs/dsh-desktop-redesign-architecture-and-plan.md` 同级。
> 之所以从 `.workbuddy/artifacts/` 移到这里：`.workbuddy/` 被 `.gitignore` 第 28 行忽略（本地 AI 工具工件），
> 导致这份**主计划**不随仓库走（CI、其他机器、协作者都看不到）、没有 diff 历史，裁决记录只存在于单机——
> 换机即失。仓库既有惯例本就是「计划类文档放 `docs/`」，此处只是回归惯例。

---

## 0. 盘点方法与判据

「断线」在本轮定义为**代码存在、契约存在，但没有任何运行时消费方**。判定必须落到具体证据，四类核验：

| 核验 | 手段 | 本次结论 |
|------|------|---------|
| IPC 命令定义 ↔ 注册 | 枚举 `commands.rs` 的 `fn` vs `generate_handler!` | ✅ 16/16 一致，无遗漏注册 |
| IPC 命令 ↔ UI 调用面 | 枚举 `frontend/**` 的 `invoke()` vs 已注册命令 | ❌ **16 个命令里 11 个零调用** |
| 事件发出 ↔ 事件监听 | Rust `emit` 常量 vs 页面 `listen()` | ❌ 发出 2 个事件，只有 1 个被监听 |
| 脚本 ↔ 入口 | 枚举 `scripts/*.mjs` vs `package.json` + `ci.yml` + 互相引用 | ❌ **3 个脚本无任何入口** |

> 这类断线之所以危险，是因为它们在 `cargo clippy -D warnings` 下**完全不可见**：`src-tauri` 是 `rlib`，`pub` 项被视为可达，不会被 `dead_code` 标记。上一轮我在 §7 表格里把 `IpcEnvelope<T>` 标成「已接线」，就是被这一点骗了——**本轮已修正**（见 §5）。

---

## 1. 断线点清单（D1~D11）

### D1 — `IpcEnvelope<T>` 契约零消费方 · 🟠 中

- **契约**：`crates/dsh-contracts/src/ipc.rs:7` 定义了 `IpcEnvelope<T>`（含 `ok` / `err` 构造器）。
- **实际**：`src-tauri/src/commands.rs` 的 16 个命令**全部**返回 `Result<T, String>`。
- **后果**：错误面丢失分类。契约里那套 `E1001`~`E4002` 错误码体系在前端拿不到——前端只能拿到一个人类可读字符串，无法编程化区分「端口占用」与「插件入口失败」。
- **注**：这也是我上一轮文档写错的一项，已更正。

### D2 — 自动更新链路五重断链 · 🔴 高

`UpdateManager` 已构造（`lib.rs:145`）、5 个命令已注册，看起来是「已接线」。逐层核验后是**五处同时断**：

1. `tauri.conf.json` → `plugins.updater.endpoints` 指向**上游** `github.com/dataelement/dsh-desktop`
2. `pubkey` 是**上游的** minisign 公钥
3. `bundle.createUpdaterArtifacts` **未开启** → 构建不产出 `latest.json` 与 `.sig`
4. CI **未注入** `TAURI_SIGNING_PRIVATE_KEY`
5. **没有 UI**：`updates_status/check/download/install/skip` 5 个命令零调用；Rust 发出的 `updates://status` 事件在 4 个页面中**零监听**

- **后果**：即使只修 1+2（原 A1 的范围），用户依然永远收不到更新；而在修好之前，产物会去**检查另一个项目的发布物**。
- **判断**：D2 必须整条闭环才算完成，只改 endpoint 是假完成。

### D3 — 一键脱敏诊断包未实现 · 🟠 中

- `crates/dsh-host/src/diagnostics.rs` 有 `DiagnosticReport` / `DiagnosticsAnalyzer`，产出的是**文本**报告。
- 全仓 grep `zip` / `redact` / `export` 零命中。
- `menu.rs` 的 `harness-view-log` 只是调用 `opener` 打开日志目录。
- **后果**：现场排障只能「让用户去那个文件夹，自己把日志发给我」——既不方便，也**没有脱敏**，用户手动发送容易连 token 一起发出去。

### D4 — 插件分级隔离两端未接线 · 🟠 中

- Rust：`plugin_worker.rs::call_tool` 现返回 `ISOLATION_NOT_WIRED`（上一轮改为如实拒绝）。
- Node：`plugin-safety-guard.mjs:PluginWorkerClient` 无消费者。
- **后果**：README 说的「插件崩溃不拖垮主程序」目前**只有进程内守护**，同进程崩溃仍能带走 Harness。
- **关键未知**：真实插件挂载发生在 Harness 进程内的官方 Cordis 体系里，Rust 侧 `PluginIsolationManager` 到底该拦什么，尚未定义。**这不是接线工作量问题，而是需求未定义**。

### D5 — 多模型工具网关未接线 · 🟡 低

- `crates/dsh-model-gateway` 无消费方，上一轮已从 `src-tauri` 依赖移除。
- `docs/model_gateway_design.md` 已写退出条件，但没有执行裁定。

### D6 — 错误页「安全模式」按钮静默失效 · 🔴 高（静默 Bug）

- `src-tauri/frontend/error.html:109`：`invoke('harness_start_safe_mode')`
- 实际注册名：`commands::safe_mode_action`（`lib.rs:101`）
- **命令 `harness_start_safe_mode` 根本不存在**。
- 失败被 `.catch(console.error)` 吞掉 → 用户点按钮**没有任何反应，也没有报错**。
- **后果**：README 宣称的「错误页支持安全模式切换」实际不可用。这是本轮发现的最严重的单点问题——因为它是**静默**的。

### D7 — 两个恢复页完全静态 · 🟠 中

- `plugin-recovery.html` / `safe-mode.html`：零 `invoke`、零 `listen`。
- 而 `recovery_action` / `safe_mode_action`（各支持 `restart` / `quit`）已定义、已注册、**零调用方**。
- **后果**：恢复流程只有「壳」，没有可操作的「面板」。命令是照着一个不存在的 UI 写的。

### D8 — `mobile_status` / `open_in_finder` / `directory_picker_open` 无调用方 · 🟡 低

- `mobile_status`：手机桥已接线，但 UI 上看不到运行状态（配对页是浏览器页面，不在壳内）。
- `open_in_finder` 与 `open_logs` 功能重叠（都走 `reveal_path`），后者在用。
- `directory_picker_open` 用 `tauri_plugin_dialog` 选目录——**与 AGENTS.md 记载的正确路径冲突**：Harness 页的正确选择器是进程内 host seam（`ctx.uiWorkspace.pickDirectory()` → Win32 `IFileOpenDialog`），不经 Tauri 命令。该命令很可能是那次错误方案的残留。

### D9 — 三个脚本无入口 · 🟠 中

| 脚本 | 用途 | 入口 |
|------|------|------|
| `verify-target.mjs` | 打包守卫：校验构建主机与目标平台一致 | ❌ 无 |
| `fault-inject.mjs` | 孤儿进程清理 + 退出码归因验证（6 类故障场景） | ❌ 无 npm 入口、不在 CI |
| `generate-app-icons.mjs` | macOS 图标生成（依赖 `sips`） | ❌ 无（手工工具） |

- 其中 `fault-inject.mjs` 最刺眼：`AGENTS.md` §2 把它**写成既有能力**，但它没有任何入口，实际从不执行。
- `verify-target.mjs` 同理——一个专门防跨平台打包事故的守卫，自己从不运行。

### D10 — 无应用内日志查看器 · 🟡 低

- 无 `frontend/logs.html`；`harness-view-log` 只打开系统文件管理器。
- 好消息：`navigation.rs:18` 的 `LOCAL_PAGE_HOSTS` 已自动放行 `frontend/` 下新增静态页，接入无需改白名单；`harness_logs_tail` 命令已被 `error.html` 使用，可直接复用。

### D11 — `error.html` 之外的页面无任何 `harness://status` 反馈 · 🟡 低

- `index.html`（启动屏）监听 `harness://status` ✅
- `plugin-recovery.html` / `safe-mode.html` **不监听**，因此这两页无法反映恢复进度。

---

## 2. 严重度与优先级矩阵

| 级别 | 断线点 | 判据 |
|------|-------|------|
| 🔴 高 | **D6**（静默失效）、**D2**（五重断链 + 指向别项目） | 用户可见的功能实际不可用 / 静默失败 |
| 🟠 中 | D1、D3、D4、D7、D9 | 宣称与实现落差，或验证能力缺失 |
| 🟡 低 | D5、D8、D10、D11 | 冗余、死代码或体验优化 |

---

## 3. 施工批次

批次按「**先修静默 Bug，再补验证能力，最后做能力建设**」排序。理由：D6/D2 是失效，D9 是「你根本不知道有没有坏」，能力建设排在最后。

### 批次 A — 止血与死代码处置 · ✅ 已完成（2026-09-10）

| 项 | 改动 | 影响范围 | 验证 |
|----|------|---------|------|
| A1 (D6) | 对齐命令名：`error.html` 改调 `safe_mode_action`（传 `action: "restart"`）；同时把 `.catch(console.error)` 改为**可见失败**（页面提示 + 按钮禁用/恢复），杜绝再次静默 | `src-tauri/frontend/error.html` | 静态：命令名与注册名一致（A2 脚本守）；GUI 手工验收待跑 |
| A2 (D6) | 「命令面 ↔ UI 面」一致性静态检查 `scripts/verify-ipc-surface.mjs`（E1~E6 + W1/W2），进 CI `test` job 最前面 | `scripts/`、`package.json`、`ci.yml` | ✅ **已实证能捕获 D6**：临时把 `error.html` 改回 `invoke('harness_start_safe_mode')` → 脚本报 `E3 … 会静默失败` 且退出码 1；还原后恢复 |
| A3 (D8) | 死 IPC 面处置：`open_in_finder` 删除（被 `open_logs` 覆盖）；`directory_picker_open` 删除（与 host seam 重复）；`tauri-plugin-dialog` 随之摘除（唯一使用者消失）；`state.rs` 5 项死代码与未用 import 一并清理 | `commands.rs`、`lib.rs`、两处 `Cargo.toml`、`state.rs` | ✅ 命令 16 → 13；`cargo check --workspace --all-targets` 零 warning；`verify-ipc-surface` 仅剩 1 处 ❌（属批次 C） |
| A4 (D8) | 手机桥状态可见：`Phone` 子菜单加**禁用状态行**，文案由 `mobile_bridge::status_label` 生成、经 `menu::refresh_bridge_status` 在配对成功/失败与停止时刷新 | `menu.rs`、`mobile_bridge.rs` | ✅ `status_label` 四态单测（CI MSVC 执行）；GUI 手工验收待跑 |
| A5 (D9) | 孤儿脚本接入：`verify-target.mjs` 重写为模块 + `--self-test`，进 CI build job 组装前校验，并支持 `prepare:harness --target=<platform>/<arch>` 前置守卫；`fault-inject.mjs` 加 `npm run fault-inject` 并进 CI（Windows 硬门禁、其余平台信息性）；`generate-app-icons.mjs` 头部标注「macOS 手工工具，刻意无入口」 | `package.json`、`prepare-harness.mjs`、`ci.yml`、`verify-target.mjs`、`generate-app-icons.mjs` | ✅ `fault-inject` 本地 **10/10 全绿**；`verify-target --self-test` 12/12；四条分支（一致 / 架构不符 / 平台不符 / 无法判定）逐一验证 |
| A6 (D1) | §7 表格与两版 README 的 `IpcEnvelope` 状态更正；另修正 README 的「系统托盘」虚假宣称（实际是应用菜单，无托盘） | 文档 | ✅ 本轮完成 |

**批次 A 完成判据核对**：

- ✅ 错误页安全模式按钮不再静默（命令名对齐 + 失败可见）
- ✅ 三向一致性测试进 CI，且**已实证能捕获 D6 这类改动**
- ✅ 三个孤儿脚本都有明确处置结论（两个接线并进 CI，一个标注为手工工具）

#### 批次 A 执行中的三处**计划偏差**（显式说明）

1. **A4 的落点从「托盘」改为「应用菜单」**。计划原文写「手机桥状态上托盘」，但全仓 `grep -n TrayIcon` **零命中**——托盘属于阶段化的 GUI 计划（原 `docs/dev-plan-gui.md`，已在 `cb47591` 清理过期文档时删除）里的后续阶段目标，**尚未实现**。按原文字面执行会写出调用不存在 API 的死代码。改为落在既有应用菜单的 `Phone` 子菜单。
2. **A3 中 `mobile_status` 从「保留」改为「删除」**（计划原文：保留并接入 UI）。理由：A4 的落点在 Rust 侧（菜单），状态直接读 `MobileBridge::snapshot()`，**不需要跨 IPC**；壳内四个页面（splash / error / recovery / safe-mode）无一展示桥状态。按本计划 §6 自定的规矩「不为可能有用的未来 UI 保留死命令」，保留它反而违背本批次的原则。将来确有页面需要时，重新加一个 6 行命令即可。
3. **A2 的检查脚本比计划范围更宽**。计划只要求比对 `invoke` ↔ 注册名，实际实现为 E1~E6 + W1/W2：额外覆盖**事件发出 ↔ 监听**、**页面可达性**、**`#[allow(dead_code)]` 登记**。原因是盘点中发现这三类断线同样真实存在（对应 D7 / D10 / D11 与 `window.rs` 死代码），只查 `invoke` 会漏掉它们。

### 批次 B — 更新链路闭环（D2） · ✅ **已完成（2026-09-10）**

分两步，因为第 1 步原计划需要你提供密钥材料，第 2 步是纯代码。**两步同批完成**（计划里那句「B1 与 B2 必须同批完成」已遵守）。

**B1 — 签名与发布源 · ✅ 完成（提交 `60682ac`）**

| 计划项 | 实际结果 |
|--------|---------|
| 生成自有 minisign 密钥对 | ✅ **无需生成——密钥早已存在且就是本仓自有**（见下方更正） |
| endpoint 改指本仓库 | ✅ `wang-yi-bit64/dsh-desktop/releases/latest/download/latest.json` |
| pubkey 换自有 | ✅ 经**逐字节比对**确认配置里的 pubkey 与 `~/.tauri/dsh-desktop.key.pub` 完全一致，无需改动 |
| `bundle.createUpdaterArtifacts: true` | ✅ 已开启（此前未开 ⇒ `tauri build` 根本不产出 `latest.json` 与 `.sig`） |
| CI 注入签名密钥 | ✅ Secret `TAURI_SIGNING_PRIVATE_KEY` 已登记（**无口令**，故未设 `_PASSWORD`）；并新增**前置校验步骤**，缺密钥时立即 `::error::` 退出，不让 300MB 组装白跑一轮。密钥用 `env:` 传值而非插进 run 字符串，防私钥进构建日志 |

> **❗ 一处必须记录的更正**：原计划与两份文档都写「`pubkey` 是**上游的** minisign 公钥」。**这个判断是错的**——上游 `dataelement/dsh-desktop` 是 **Electron** 项目，**根本没有 `tauri.conf.json`**，不存在可被沿用的 pubkey。实测配置里的 pubkey 与 `~/.tauri/dsh-desktop.key.pub` 逐字节一致，即**本仓自有密钥**。私钥空口令验签通过，离线备份在 `~/.tauri/backup/dsh-desktop.key.20260910-163228`（含配对 `.pub`）。
> 教训：**「某个值不属于我们」这类判断必须实测**（逐字节比对），不能从「endpoint 指向上游」顺推。

**B2 — 更新 UI · ✅ 完成（提交 `7a3ca73`，文档 `8694eb0`）**

| 计划项 | 实际结果 |
|--------|---------|
| 新增 `frontend/updates.html` | ✅ 新建；监听 `updates://status` **且**进页面拉一次 `updates_status` 快照（只靠事件不够：周期检查间隔 6 小时，冷启动会长时间空白） |
| 接线 `updates_check / download / install / skip` | ✅ 4 个按钮全接线，另有 `harness_open` 返回 Harness |
| 加一致性测试：`updates://status` 必须有 ≥1 个监听方 | ✅ `ALLOW_UNLISTENED_EVENTS` 从「有豁免」清空为**空表**；同时**销账** `ALLOW_UNUSED_COMMANDS` 里 5 个 `updates_*` 与 `safe_mode_action`（已接线的条目留在清单里就是一句过期谎话） |
| —（计划外补充） | ✅ 新增 `commands::harness_open`：更新页占用了主窗口，原返回路径只有菜单「Restart Harness」——那会**真的重启进程**（新端口 / 新 token / 会话中断），语义错误。改为**重放** `HarnessSupervisor::ready_url` 记下的 URL |

**批次 B 完成判据核对**：

- ✅ 五处断链全部闭环：endpoint 归属、pubkey 归属、`createUpdaterArtifacts`、CI 签名密钥、**UI**
- ✅ 命令面 `定义 14 · 注册 14 · 被前端调用 12`（新增 `harness_open`）；事件 `发出 2 · 监听 2`
- ⏳ **未做（需要真实发布）**：打 tag 走一次 CI release，确认产出含 `latest.json` + `.sig`，并用旧版本客户端实测一次升级。**该项依赖代码先推送**，当前被网络阻塞

### 批次 C — 恢复流程闭环（D7、D11） · ✅ **已完成（2026-09-10）**

**C0（计划外，已完成 — 提交 `476a056`）：先修数据形状，因为它才是「插件故障分支从未生效」的根因**

计划把批次 C 描述为「两个恢复页没接线」。实际挖下去发现**更靠前的一层坏了**：

`error.html` 的「疑似插件故障 → 建议进入安全模式」分支判据是 `snapshot.phase === 'failed' && snapshot.plugin_fault`，**从未生效过**。根因是 `HarnessSnapshot.phase` 的文档注释写着「与 `message` / `logs` 平铺」，但字段上**漏了 `#[serde(flatten)]`**，实际发出：

```json
{"phase":{"phase":"failed","cause_kind":"…","plugin_fault":true},"message":"…","logs":["…"]}
```

页面读到对象 ⇒ `=== 'failed'` 恒为 **false**、`snapshot.plugin_fault` 恒为 **undefined** ⇒ 安全模式按钮从未露面。

定位方式：写 **serde 探针**（同款属性组合的小程序）`cargo run` 打印真实 JSON。这类错误的特点是**两侧各自都没错，错在中间的形状**——Rust 侧序列化成功、HTML 侧逻辑正确，编译器和类型系统都看不见。

修复内容：`#[serde(flatten)]`（顺带**恢复与上游 `contracts.ts` 的 `RuntimeStatus` 一致**，页面本就是照那个形状写的）+ 3 个契约测试（CI 运行）+ `error.html` 注释指认该跨语言依赖 + `AGENTS.md` 新增「已修复，勿回归」小节。

**C1（已完成）**

| 计划项 | 实际结果 |
|--------|---------|
| `plugin-recovery.html` 重写数据接入 | ✅ `window.dshRecovery.action(…)`（不存在的桥）→ `invoke('recovery_action', …)` / `invoke('recovery_status')`；**并检查封套返回值的 `success`**（计划里专门点了这一条：只看 promise 是否 reject 会把业务失败当成功） |
| `show_recovery_page` 接线 | ✅ 改由 `commands::recovery_open` 指向（错误页新增「插件恢复…」按钮，仅插件故障时露出）。**不做自动路由**：详见下方设计说明 |
| `safe-mode.html` 处置 | ✅ **删除**（页面 + 资源 + 配置项），理由见下 |
| `recovery.rs` 模块级 `#[allow(dead_code)]` | ✅ 整个模块删除，改由 `commands::recovery_status` 直接消费 `dsh_host::diagnostics`（模块只剩 re-export 一层，去掉即零成本） |
| D11（恢复页无状态反馈） | ✅ 恢复页监听 `harness://status`，展示相位并在 Harness 就绪时自动返回界面 |
| 计划外补充 | ✅ 恢复页展示 `DiagnosticsAnalyzer` 的**完整归因报告**与嫌疑插件清单——原页面只有一个空的插件列表，数据来源从未存在过 |

**🔴 决策点 4 的处置：A 方案（只接非破坏性动作），但理由与计划建议不同**

计划建议 B「把卸载改为**禁用**（目录重命名为 `<name>.disabled`），可逆」，我**核验后否决了它**：那条路**不可逆，只是看起来像**。

证据（`$DSH_HOME/profiles/.generations/` 的代码是唯一权威）：

1. 市场安装的插件以 **generation** 形态存在，其启用集合由单一权威文件
   `profiles/.generations/desired.json` 描述；
2. 冷启动时 `generations/projection.mjs::projectGenerations()` **按 `desired.json`
   重建** `profiles/web/node_modules/<name>` 链接与 `dsh.profile.bundles` 列表——
   手工把目录改名，下一次冷启动会把链接**重新建出来**，禁用被静默撤销；
3. 若改为从 `desired.json` 里摘除该条目（唯一真正生效的「禁用」写法），同一文件的
   `registry.mjs::sweepRegistry()` 会 `rm -rf` 掉对应 generation 目录——**真删除**。

于是只剩两条路：「假装禁用（会被还原）」与「真删除」。前者是会让用户以为问题解决了
的谎话（比不做更坏），后者是计划明确要避免的不可逆操作。**结论：本仓不实现插件
卸载/禁用**，恢复页只提供 `safe-mode` / `restart` / `show-log` / `quit` 四个非破坏性
动作；卸载能力记为 🕓 计划中，依据是**上游是否提供停用（disable）语义**。

**顺带的诚实修正**：原页面的主按钮文案是「卸载插件」，四个动作（`uninstall` /
`safe-mode` / `show-log` / `quit`）全部落在 Rust 侧 `_ => Ok(false)` 上且页面不检查
返回值——即「按钮全是谎话」。现在未知动作返回显式错误 `E7002`，不再静默。

**`safe-mode.html` 为什么删除而不是接线**

该页（469 行）的每一处交互都要求插件移除后端：`apply`（有选择地禁用插件）、
`agent`（交给 agent 处理）、`recovery-open`。而那套后端正是上文裁定不实现的。
把它接上「安全模式」一个按钮，等于交出一个**其余按钮仍读空气**的页面——正是这一轮
在清理的东西。逐条比对后确认它的**唯一独有能力**（启动安全模式）已由三处覆盖：

- 错误页「进入安全模式」（`safe_mode_action`，批次 A 修好）；
- 恢复页主按钮（新增 `recovery_action` 的 `safe-mode`）；
- 原生菜单「Restart in Safe Mode」。

因此删除，并把 `show_safe_mode_page` 一并删除（它随之成为死函数）。

### 批次 D — 诊断能力（D3、D10） · ✅ **已完成（2026-09-10）**

**D-1 脱敏与打包（`dsh-host` 侧，无 GUI）**

| 计划项 | 实际结果 |
|--------|---------|
| `diagnostics::export` 收集日志 + 归因 + 环境快照 | ✅ 新增 `crates/dsh-host/src/diagnostics_export.rs`；按 `Layout` 收集 `harness.log` / `app.log` / `desktop.log` / 内存环形缓冲尾部 / 归因报告 / `environment.json` / `MANIFEST.json` |
| **脱敏规则** | ✅ 5 类：`launch_token`、`auth_cookie`、`path_username`、`api_key`（三种形态）、`proxy_password`。逐条有**正反用例**：正例断言原文不残留，反例断言产品版本号 / 端口 / `E` 码 / 包名**不被误伤** |
| 打包为 zip 写入 `app_data_dir/exports/` | ✅ `zip` crate（`default-features=false` + `deflate`，纯 Rust，不引 C 依赖）；新增 `EXPORTS_DIR_NAME` / `DIAGNOSTICS_PREFIX` 契约常量 |
| 单测：每条规则必须有正反用例 | ✅ 另有端到端测试 `bundle_contains_no_plaintext_secret`：**读回产物**逐条目断言无 token/cookie/key/用户名残留——判据是产物本身，不是「导出函数自称脱敏了」 |
| —（计划外，测试抓到的问题） | ✅ 首轮测试即抓到 `path_username` 漏掉 **JSON 转义形态**（`C:\\Users\\name`）——`environment.json` 里的路径正是那个形状。规则改为 `[\\/]+` 匹配连续分隔符；用例已补 |

**禁止无声降级（§7.1 规则 3）**：每次替换都计数，逐规则写入 `ExportSummary::redactions`
并随包落一份 `README.txt`。命中数写在产物里，因此「脱敏过没有」是可核对的事实。

**D-2 入口**

| 计划项 | 实际结果 |
|--------|---------|
| 新命令 `diagnostics_export` → 返回导出路径 | ✅ 返回 `ExportSummary`（路径 / 体积 / 条目 / 脱敏统计） |
| 错误页 + 托盘菜单各加一个入口 | ✅ 错误页「导出诊断包」按钮（含路径回执）；菜单「Harness → Export Diagnostics…」（成功后打开 exports 目录）。⚠️ **托盘不存在**（同批次 A4 的偏差），落点是既有应用菜单 |
| **验收**：导出包内 grep 不到任何 token/cookie 原文 | ✅ 端到端测试逐条目断言 |

**D-3 日志查看器（D10）**

- ✅ `crates/dsh-host/src/logs_view.rs`（三个来源、尾部读取、**截断如实上报**）
  + `frontend/logs.html` + `commands::logs_read`。
- ✅ 菜单「View Logs…」打开应用内页面；**保留**「Reveal Log Folder」为次入口。
- 与 `harness_logs_tail` 的分工写进了代码注释：前者读内存环形缓冲（当前实例），
  后者读落盘文件（能看到上一次启动）。

### 批次 E — `IpcEnvelope<T>` 收敛（D1） · ✅ **已完成（2026-09-10）**

- ✅ **错误码表落地**：`crates/dsh-contracts/src/errors.rs` 新增 `codes` 模块，
  `E1xxx` 环境 / `E2xxx` 网络 / `E3xxx` 进程 / `E4xxx` 鉴权 / `E5xxx` 插件 /
  `E6xxx` 模型网关 / `E7xxx` 内部。**此前 `E1001`~`E4002` 只存在于文档**——
  AGENTS.md 与两版 README 都把它当作既有能力写着，代码里其实一个都没有。
  本轮把文档里的宣称变成真实定义（这是本计划反复出现的模式：**宣称先于实现**）。
- ✅ **`AppError` 被真正用起来**：它此前是零消费方的死类型，且与
  `IpcErrorPayload` 字段重复。现在 `IpcEnvelope.error` 直接是 `AppError`，
  删掉重复类型。跨语言的字段形状由 `dsh-contracts` 的封套测试钉住。
- ✅ **17 个命令全部改返回 `CommandResult<T>`**（`Result<IpcEnvelope<T>, String>`）。
  外层 `Result` **恒为 `Ok`**，只为满足 Tauri 对 async 命令的编译要求；语义全在内层
  封套。这条约定写在 `commands.rs` 模块文档里并有测试守着。
- ✅ **页面同步适配**：`error.html` / `plugin-recovery.html` / `logs.html` /
  `updates.html` 都改成**解包 `success`**（业务失败是成功返回，只看 reject 会漏）。
- ⚠️ **计划里「13 个命令」的数字已过期**：命令面在批次 B~D 期间增长到 17 个
  （新增 `harness_open` / `recovery_*` / `logs_read` / `diagnostics_export`）。
- 🐛 **本批的真正风险点：改返回形态会静默打断所有页面**。批次 E 落地后，
  `updates.html` **整页失效**——它写的是 `invoke('updates_status').then(apply)`，
  而 `apply` 第一行是 `if (!snapshot || !snapshot.phase) return`。加封套之前它拿到
  的是快照，加之后拿到的是封套，于是 `snapshot.phase` 恒为 `undefined`，
  **函数每次都静默早退，页面再也不渲染**（不抛错、不报错、按钮也不会亮）。
  同一批里 `run()` 还漏判了 `success`，把「没有可用更新」这类业务失败当成成功。
  两处都由新建的 `verify-shell-pages.mjs` 抓到（见下），**不是靠人工目视**。
  教训：把「成功返回」改成「带成功标记的返回」是一次**跨语言破坏性变更**，
  它不会编译失败、不会抛异常，只会让页面安静地不工作——必须有守卫。

### 批次 F — 插件隔离 / 模型网关的接线或冻结（D4、D5） · ✅ **已完成：按 (b) 冻结并归档**

| 删除项 | 依据 |
|--------|------|
| `crates/dsh-host/src/plugin_worker.rs` | 从未接线；`call_tool` 一律返回 `ISOLATION_NOT_WIRED`；且它**不在插件挂载路径上**（真实挂载在 Harness 进程内的官方 Cordis 体系） |
| `build/plugin-worker-host.mjs` | 只被 `PluginWorkerClient` spawn，后者从未接线 |
| `build/plugin-safety-guard.mjs::PluginWorkerClient` | 同上；文件现在**只导出 `formatFaultDetails`** |
| `crates/dsh-model-gateway/**` | 零运行时消费者，已从 workspace 移除（members + `[workspace.dependencies]`） |
| `docs/plugin_isolation_architecture.md`、`docs/model_gateway_design.md` | 移入 `docs/archive/`，并在文首加归档说明（保留设计意图可追溯） |

**为什么是删而不是留**：不在 workspace 里的 crate 既不会被编译也不会被测试；进程外
RPC 协议必须与 `dsh-contracts` 的 JSON-RPC 契约同步演进，没有消费者时**无人会发现它
已经漂移**。「代码写得不错，先留着」正是这一轮在清理的欠债本身。

**当前生效的插件防护只剩一条**：`formatFaultDetails` 的**进程内**归因。
因此 `AGENTS.md` §7.2 与两版 README 里「插件崩溃不拖垮主程序」的表述**必须继续
标注为不成立**——本轮删掉的是一个**从未生效**的宣称载体，不是删掉了能力。

### 批次 G — 剩余清理（D8 尾项） · ✅ **已完成（2026-09-10）**

- `open_external` **删除**（不是接线）：它的职责已由导航白名单在 Rust 侧完成——
  `lib.rs` 的 `on_navigation` / `on_new_window` 命中 `NavigationDecision::External`
  时直接 `opener.open_url`。命令面再留一个入口，等于同一能力开两条路、两套放行规则
  各自维护（`is_openable_external` vs `decide_navigation`）。
- `navigation::is_openable_external` 随 `open_external` 一起删除（失去唯一使用者，
  留着会以 `-D warnings` 打红 CI）。
- `verify-ipc-surface.mjs` 的 `ALLOW_UNUSED_COMMANDS` 与 `ALLOW_DEAD_CODE_ALLOW`
  **清空**——它们现在是空的，这就是目标状态。

**计划外新增的守卫：`scripts/verify-shell-pages.mjs`（壳内页面运行时冒烟）**

本轮重写了恢复页与错误页、新增了日志页，而这三页**没有任何自动化覆盖**：`verify-ipc-surface`
只比对命令名，不知道页面跑不跑得起来。改版页面最典型的两种病正好落在它的盲区：

1. `getElementById` 拿到 `null`（id 拼错 / 节点被删）→ 脚本**自上而下**执行，一抛就停，
   **整页监听全部失效**，用户看到的是「页面正常显示但点什么都没反应」；
2. HTML 里留了按钮、脚本里忘了绑监听 → 页面**看上去完全正常**，那个按钮是死的。

新守卫把每个页面的内联脚本放进最小 DOM 桩里真跑一遍，并**逐个点一遍按钮**（页面命令面的
实际调用点几乎都在监听器里，不点就走不到），检查 P1~P6：引用可解析、脚本不抛错、
命令已注册、**按钮都挂上了监听**、模板字面量 id 前缀可解析、**命令结果被解包了封套**。

它**当场抓到了批次 E 自己引入的两处缺陷**（`updates.html` 整页不渲染 + 漏判业务失败），
这比任何「事后补测试」的论证都有力——守卫是先于缺陷存在的，缺陷是它发现的。

**六条检查都做过可证伪性演练**：把命令名改错 → P3 红；把监听删掉 → P4 红；
把 id 改错 → P1 + P2 红；把 `success` 判定去掉 → P6 红。每条都确认了守卫会变红
**且给出可读原因**（只说「失败」的守卫等于没说）。

它**不**替代视觉验收——不渲染、不布局、不跑 CSS，也不检查命令参数形状。
已进 npm scripts 与 CI `test` job。

**计划外但必须记录的守卫修复**：本批把 `verify-ipc-surface.mjs` 的两处**假阳性**修掉了，
否则它会误报本轮刚接好的命令（守卫的误报和漏报一样有害——都会让人不再看输出）：

1. **包装函数体截断**：原来用正则 `\{([\s\S]*?)\n\s*\}` 抓函数体，遇到
   `function run(…) { if (!invoke) { return } … invoke(…) … }` 这种**以带花括号的
   `if` 开头**的包装器会在第一个内层 `}` 处截断，于是"函数体里没有 invoke(" ⇒
   包装器识别失败 ⇒ 它调用的所有命令被判成无调用方。真实地把 `logs_read` /
   `recovery_action` / `recovery_status` 三个**已接线**命令报成断线。已改为花括号配对。
2. **注释里的属性被当成真属性**：`parseDeadCodeAllows` 不排除 `//` 开头的行，而
   `commands.rs` 的文档注释里正好引用了 `#[allow(dead_code)]` 这个词（解释恢复页
   旧实现为何带着它躺了半年），于是守卫把一个已销账的文件报成未登记断线。已排除注释行。

**另一处环境缺陷（与断线点无关但会误伤门禁）**：`verify-harness-inject.mjs` 的
「可证伪性检查」靠字面量替换定位实现里的两行锚点，而锚点写作 `'…\n'`。本机
`core.autocrlf=true` 让工作区文件是 CRLF，两处锚点全部匹配不上，脚本以退出码 1
结束并报「脚本文本已变」——**看起来像断言坏了，实际是守卫自己的文本匹配依赖了检出
配置**。已改为读入时统一行尾（`\r\n` → `\n`）。这样的守卫必须在任何检出配置下
表现一致。

---

## 4. 需要你裁决的决策点

### 决策点 1 — 更新签名密钥归属（阻塞批次 B1）· ✅ 已裁决：**A**

| 选项 | 含义 | 代价 |
|------|------|------|
| **A** ← 已选 | 生成自有密钥对，私钥放 GitHub Secrets，我改配置 + CI | 私钥一旦丢失后续版本无法自动升级，需妥善保管 |
| **B** | 先只改 endpoint 指向本仓库，签名留空（不开启 `createUpdaterArtifacts`） | 更新链路仍不可用，但不再检查上游发布物（**消除安全风险**） |
| **C** | 暂不碰，先把 updater 整体禁用（移除插件注册 + 命令 + 菜单） | 消除「检查别项目」风险且不引入半成品，但功能归零 |

> 我的建议是 **A**。若你暂时不想管密钥，**C 比 B 好**——B 留下一个永远不工作的链路，正是我们这一轮在清理的东西。
>
> **执行提示（B1 开工前必读）**：`tauri signer generate` 产出的私钥需要落到 GitHub Secrets
> （`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）。**私钥丢失 = 再也无法向已发布版本推送自动更新**，
> 因此生成后必须同时留一份离线备份（口令管理器 / 加密介质）。B1 与 B2 必须同批完成，只做其一是假完成。

### 决策点 2 — 批次顺序与范围 · ✅ 已裁决：**批次 A → E**

- 批次 A 已完成（见 §3）。
- 批次 B/C/D/E 按序推进；F 单独定性。

### 决策点 3 — 插件隔离 / 模型网关的方向（批次 F）· ✅ 已裁决：**冻结并归档**（**已执行**）

按 (b) 执行，且**已在本轮完成**：删 `crates/dsh-host/src/plugin_worker.rs`、
`build/plugin-worker-host.mjs`，注销 `PluginWorkerClient`；从 workspace 移除
`dsh-model-gateway`（目录 + members + `[workspace.dependencies]`）；两份设计文档
（`plugin_isolation_architecture.md`、`model_gateway_design.md`）移入 `docs/archive/`
并在文首加归档说明；README / AGENTS.md §7 的相应表述已收敛为「已归档」。
执行清单与理由见 §3 批次 F。

### 决策点 4 — 恢复页的「卸载插件」按钮（曾阻塞批次 C1）· ✅ 已裁决：**A（只接非破坏性动作）**

**原计划建议 B**（目录改名 `<name>.disabled`，可逆）。**核验后否决**：那条路会被
冷启动投影静默还原，而唯一真正生效的「禁用」写法（从 `desired.json` 摘除条目）会
触发 `sweepRegistry()` **真删除**该 generation 目录。即只剩「假装禁用（会被还原）」
与「真删除」两条路，没有真正的可逆解除挂载。完整证据链见 §3 批次 C。

**本次裁决：A** —— 只接 `safe-mode` / `restart` / `show-log` / `quit` 四个非破坏性
动作，卸载按钮从页面移除，卸载能力记为 🕓 计划中（依据是上游是否提供停用语义）。
撤销 A 的前提：上游提供插件 disable / quarantine 语义，届时按 A→B 转换。

| 选项 | 含义 | 代价 / 风险 |
|------|------|------|
| **A** ← 已选 | 只接**非破坏性**动作；**卸载按钮从页面移除** | 最小可信面；卸载能力记为 🕓 计划中 |
| ~~B~~ | ~~把「卸载」改为「禁用」：目录重命名~~ | ❌ **经代码核验不成立**：冷启动投影会还原链接；从 `desired.json` 摘除则真删 generation |
| C | 完整实现卸载：`recovery_action` 增 `uninstall` + UI 二次确认 | 不可逆操作，且要在**恢复态**（UI 可能不完整）下做安全确认，风险最高 |
| D | 恢复页整体下线：删 `plugin-recovery.html` + `show_recovery_page` | 面最小、零谎言；但放弃上游已有的诊断交互，属功能回退 |

**C1 必须一并做的三件事（否则仍是谎言）—— 均已落地**

1. ✅ `plugin-recovery.html`：`window.dshRecovery.action(…)` → `invoke(…)`，并**检查封套返回值**，失败显式提示；
2. ✅ 页面的数据来源改为 `recovery_status` 命令（**不走 URL 传参**：原先为此带的 `urlencoding` 函数一并删除——数据本来就要经命令面校验 origin，绕一道路没有收益）；
3. ✅ 「跳恢复页」由错误页按钮触发（`recovery_open`），**不做** `state.rs::on_failed` 自动路由——理由见下。

**为什么不做自动路由（计划原文的 C1 第 3 项）**：计划写「`on_failed` 判 `plugin_fault`
→ `show_recovery_page`」。执行时**刻意不采纳**：错误页的「疑似插件故障 → 进入安全
模式」分支是 2026-09-10 刚修好的（C0 的 snapshot 形状 bug），如果插件故障不再走
错误页，那条分支会**立刻变成新的死 UI**——一个刚修的 bug 以另一种形式复活。
改法是：错误页仍是第一落点，其上增加「插件恢复…」按钮通往恢复页。两页职责分明
（错误页=出了什么事 + 一键救命；恢复页=细节 + 多种处置），且两页的按钮都可达。

---

## 5. 本轮顺带修正的事项

我在上一轮 C2 的 §7 表格里把 `IpcEnvelope<T>` 标成「✅ 已接线」，**这是错的**——契约已定义但零消费方。已修正：

- `AGENTS.md` §5 P4 状态行
- `AGENTS.md` §7 表格（补 5 行：`IpcEnvelope`、自动更新链路、日志查看器、错误页安全模式按钮、恢复页交互）
- `README.md` / `README.zh-CN.md` 的 P4 状态行

**这条错误的成因值得记下来**：`src-tauri` 是 `rlib`，`pub` 项在 clippy 看来都是可达的，因此「未接线的 pub 函数」**不会**被 `dead_code` 捕获。判据只能是「有没有调用方」，而这需要跨文件、跨语言（Rust ↔ HTML ↔ mjs）核验——正是本计划批次 A2 要固化成自动化测试的原因。

---

## 6. 明确不做的项

- 不引入 oRPC / tRPC（上一轮已论证，对端是 Rust，TS 类型推导收益失效）。
- 不为「可能有用的未来 UI」保留死命令——死代码要么接上，要么删掉。
  （本轮实践：`open_external` 属「以为将来有用」，核验后发现职责已被导航白名单
  完整覆盖，**删除**；`safe-mode.html` 同理，属「有意为之但接不上」，**删除**。）
- 不在批次 F 定性前动 `plugin_worker.rs` 与 `dsh-model-gateway`——**批次 F 已定性
  （冻结并归档）并已执行**，故本约束已履行完毕。
- **不实现插件卸载 / 禁用**（决策点 4 的 A 方案）。不是偷懒：经代码核验，市场上
  安装的插件没有真正的可逆解除挂载方式（见 §3 批次 C）。待上游提供停用语义再议。
- **不把插件故障自动路由到恢复页**（计划 C1 第 3 项刻意不采纳）。理由见 §4 决策点 4。
- 不改 `docs/dsh-desktop-redesign-architecture-and-plan.md` 的历史规划快照。
- 不给 `IpcEnvelope` 的 async 命令返回 `Err`。外层 `Result` 只为满足 Tauri 的编译
  要求存在；一旦返回 `Err`，封套（含错误码与类别）就丢了，页面退回读字符串。
