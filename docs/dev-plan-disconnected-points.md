# dsh-desktop 断线点施工计划

> 盘点日期：2026-09-10 · 方法：全仓静态证据核验（定义点 ↔ 调用方 ↔ 注册点 ↔ UI 调用面 ↔ CI 入口），**不采信文档自述**
> 关联：上一轮的「优化执行」记录（批次 1 + 批次 3）——该文件为**本地工件**，位于 `.workbuddy/artifacts/dsh-desktop-optimization-execution.md`，**未入库**（`.workbuddy/` 见 `.gitignore`）。
>
> 📂 **本文件已入库**（`docs/`）。同批产出的若干报告（`overview.md`、`batch-b-updater-closure.md`、`phone-indicator-and-snapshot-contract.md`）仍留在 `.workbuddy/artifacts/` 作为本地工件；本文件若引用它们会显式标注「本地工件」。

---

## 进度快照

> 最后更新：2026-09-10 18:26 · 状态词表见本文件 §3 与 `AGENTS.md` §7.3

| 批次 | 覆盖断线点 | 状态 | 落地证据 |
|------|-----------|------|---------|
| **A** 止血与死代码处置 | D6、D8、D9、D1(部分) | ✅ **已完成** | 5 个提交 `c99a401` → `45611f9`；命令面 16 → 13；3 个孤儿脚本接线并进 CI |
| **B** 更新链路闭环 | D2 | ✅ **已完成**（B1 + B2 同批） | `60682ac`(B1) · `7a3ca73`(B2) · `8694eb0`(文档)；`updates://status` 监听方 0 → 1 |
| **C** 恢复流程闭环 | D7、D11 | 🔵 **进行中**（C0 已完成，C1 剩 4 项，**1 项待裁决**） | `476a056` 快照契约修复（插件故障分支此前恒为 false）；详见 §3 批次 C；**阻塞项见 §4 决策点 4（卸载插件按钮）** |
| **D** 诊断能力 | D3、D10 | ⬜ 未开工 | — |
| **E** `IpcEnvelope<T>` 收敛 | D1 | ⬜ 未开工 | — |
| **F** 插件隔离 / 模型网关 | D4、D5 | ⬜ 未开工（方向已裁定「冻结并归档」，见 §4 决策点 3） | — |
| **G** 剩余清理 | D8 尾项 | ⬜ 未开工 | — |

**另有本轮追加的两项**（来自用户追加要求，不在原盘点范围内）：

| 项 | 状态 | 落地证据 |
|----|------|---------|
| Harness 页注入机制 + 页内手机状态指示器 | ✅ 已完成 | `18e26f5`(功能) · `6319994`(门禁) · `d6b7fb0`(文档)；**并更正了「Tauri webview 无 preload / 初始化脚本」这一错误前提** |
| 安全模式界面指示器登记为「计划中」 | ✅ 已完成 | `58ce571`；AGENTS.md §7.3 新增四状态词表（✅/⚠️/❌/🕓） |

> ✅ **推送状态**：以上提交**已全部推送到远端** `origin/main`（`8641966..476a056`，25 个提交）。
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

### 批次 C — 恢复流程闭环（D7、D11） · 🔵 **进行中**

**C0（计划外，已完成 — 提交 `476a056`）：先修数据形状，因为它才是「插件故障分支从未生效」的根因**

计划把批次 C 描述为「两个恢复页没接线」。实际挖下去发现**更靠前的一层坏了**：

`error.html` 的「疑似插件故障 → 建议进入安全模式」分支判据是 `snapshot.phase === 'failed' && snapshot.plugin_fault`，**从未生效过**。根因是 `HarnessSnapshot.phase` 的文档注释写着「与 `message` / `logs` 平铺」，但字段上**漏了 `#[serde(flatten)]`**，实际发出：

```json
{"phase":{"phase":"failed","cause_kind":"…","plugin_fault":true},"message":"…","logs":["…"]}
```

页面读到对象 ⇒ `=== 'failed'` 恒为 **false**、`snapshot.plugin_fault` 恒为 **undefined** ⇒ 安全模式按钮从未露面。

定位方式：写 **serde 探针**（同款属性组合的小程序）`cargo run` 打印真实 JSON。这类错误的特点是**两侧各自都没错，错在中间的形状**——Rust 侧序列化成功、HTML 侧逻辑正确，编译器和类型系统都看不见。

修复内容：`#[serde(flatten)]`（顺带**恢复与上游 `contracts.ts` 的 `RuntimeStatus` 一致**，页面本就是照那个形状写的）+ 3 个契约测试（CI 运行）+ `error.html` 注释指认该跨语言依赖 + `AGENTS.md` 新增「已修复，勿回归」小节。

**用户可见行为改变（朝正确方向）**：插件故障导致的启动失败，错误页现在会真的提示「疑似第三方插件故障」并露出「进入安全模式」按钮——该按钮的**实际调用**早在批次 A 已修好（`restart_in_safe_mode`），此前只是永远显示不出来。

**C1（剩余项）**

- `state.rs::on_failed` 路由：`plugin_fault = true` → `show_recovery_page`（信号 `cause.is_plugin_fault()` 已存在，改动小）
- `plugin-recovery.html`：**必须重写数据接入方式**，现状比「没接线」更糟（见下）
- `safe-mode.html`：同样不可达，`show_safe_mode_page` 仍在 `#[allow(dead_code)]` 清单
- 销账 `recovery.rs` 模块级 `#[allow(dead_code)]`（接线后自然消失）

**⚠️ 恢复页的真实状况（比计划假设的严重）**

1. 页面调用的 `window.dshRecovery.action()` 是**一个不存在的桥**——与「目录选择器全局」属同一类 bug；
2. 退化路径 `location.href = 'dsh-recovery://…'` 会被**导航白名单**（`navigation.rs`）拦截；
3. ⇒ 页面上四个按钮**完全没反应**；
4. 且 `recovery_action` 命令**只实现了 `restart` / `quit`**，而页面要的是 `uninstall` / `safe-mode` / `show-log` ⇒ 即便把桥换成 `invoke`，三个动作仍会静默返回 `false`，而页面不检查返回值 ⇒ **依然是一句谎话**。

**🔴 待裁决（阻塞 C1 的一部分）**：插件**卸载**是破坏性、不可逆操作（删除用户插件数据），不自行实现。选项见 §4 决策点 4。

**批次 C 验收判据（计划原文）**：制造 `--fail startup` 类故障 → 错误页 → 进 Safe Mode → 恢复页可操作且状态实时。**当前完成度**：链路前两段已可用（故障归因 → 错误页 → 安全模式按钮可见且真实生效），**第三段（恢复页）待 C1**。

### 批次 D — 诊断能力（D3、D10）

**D-1 脱敏与打包（`dsh-host` 侧，无 GUI）**

- `diagnostics::export`：收集 `desktop.log` + `harness.log` + `app.log` + 归因结论 + 环境快照（版本 / 平台 / `MANIFEST.json`）
- **脱敏规则**（这是重点，不是附带）：launch token、`dsh-auth-*` cookie、绝对路径中的用户名段、可能的 API key 模式
- 打包为 zip 写入 `app_data_dir/exports/`
- 单测：**每条脱敏规则必须有正反用例**（脱敏后不得残留原值、不得误伤产品版本号）

**D-2 入口**

- 新命令 `diagnostics_export` → 返回导出路径
- 错误页 + 托盘菜单各加一个入口
- **验收**：导出包内 grep 不到任何 token/cookie 原文

**D-3 日志查看器（D10，可选）**

- `frontend/logs.html`：复用 `harness_logs_tail` + `open_logs`；`harness-view-log` 菜单项改为打开应用内页面（保留「在文件管理器中打开」为次按钮）

### 批次 E — `IpcEnvelope<T>` 收敛（D1）

- 13 个命令返回值改 `IpcEnvelope<T>`；`String` 错误改契约错误码（`E1001`~`E4002`）
- 前端 `error.html` 同步适配（唯一的调用方，改动面小）
- 加测试：封套序列化形状 + 错误码可编程判别
- ⚠️ **破坏性改动**。建议在批次 A 的一致性测试落地后做——那时「命令面 ↔ UI 面」已有守护，改起来不怕漏。**前提已满足（A2 已进 CI）。**

### 批次 F — 插件隔离 / 模型网关的接线或冻结（D4、D5）

**这两项的性质与其他批次不同：不是「没接线」，而是「接什么没定义」。**

- **F1 插件隔离（D4）**：先回答一个前置问题——Harness 官方 Cordis 体系已提供插件加载与故障隔离，Rust 侧再拦一层要解决什么具体问题？可能结论：
  - (a) **接线**：需先定义拦截点（插件工具调用？插件加载？）与失败语义
  - (b) **冻结**：删 `plugin_worker.rs` + `build/plugin-worker-host.mjs`，`docs/plugin_isolation_architecture.md` 归档，README 移除相关表述
  - ⚠️ 在 (a)/(b) 定论前**不要动代码**——现状（如实拒绝 + 文档标注未接线）已是可接受状态。
- **F2 模型网关（D5）**：`docs/model_gateway_design.md` 已写退出条件，直接裁定接线或冻结即可。若冻结则从 workspace 移除并归档文档。

### 批次 G — 剩余清理（D8 尾项）

- `mobile_status` 若 A4 未接则一并处置；`harness_view_log` 与 D-3 的关系收口。

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

### 决策点 3 — 插件隔离 / 模型网关的方向（批次 F）· ✅ 已裁决：**冻结并归档**

按 (b) 执行：删 `crates/dsh-host/src/plugin_worker.rs`、`build/plugin-worker-host.mjs`，注销
`PluginWorkerClient`；从 workspace 移除 `dsh-model-gateway`；两份设计文档（`docs/plugin_isolation_architecture.md`、
`docs/model_gateway_design.md`）移入归档；同步收敛 README / AGENTS.md §7 的相应表述。

### 决策点 4 — 恢复页的「卸载插件」按钮（阻塞批次 C1 的一部分）· 🔴 **待裁决**

**为什么必须由你裁决**：恢复页现有 4 个按钮，其中**卸载插件是破坏性、不可逆操作**（删除用户磁盘上的插件数据，无回收站）。
本仓库此前的原则是「不可逆操作不自行实现」，所以我停在决策点。

**背景事实（决定了选项的可行性）**

| 事实 | 证据 |
|------|------|
| 页面桥 `window.dshRecovery` **不存在** | `plugin-recovery.html` 调用的是空气 |
| 退化路径被导航白名单拦截 | `dsh-recovery://` 不在 `navigation.rs` 白名单 |
| `recovery_action` **只实现 `restart` / `quit`** | `commands.rs` 的 match 分支 |
| ⇒ 四个按钮**全部无反应**；即便换成 `invoke`，三个动作仍静默返回 `false` 而页面不检查 | 需同时补「返回值校验」 |

| 选项 | 含义 | 代价 / 风险 |
|------|------|------|
| **A** | 只接**非破坏性**动作：`safe-mode` / `show-log` / `restart`；**卸载按钮从页面移除** | 最小可信面；卸载能力记为 🕓 计划中。缺点：诊断出「某插件致故障」的用户仍需手动去目录删 |
| **B** ← 建议 | 把「卸载」改为**「禁用」**：插件目录重命名为 `<name>.disabled`（**可逆**），页面文案与结果提示同步改为「已禁用，可恢复」 | 覆盖恢复场景的真实诉求（先能进得去）；可逆 ⇒ 符合本仓库「不可逆操作先备份」的既有做法。缺点：与上游页面语义有偏差，需在 README 说明 |
| **C** | 完整实现卸载：`recovery_action` 增 `uninstall` + UI 二次确认（列出将删除的路径与大小） | 功能最全；但仍是不可逆操作，且要在**恢复态**（UI 可能不完整）下做安全确认，风险最高 |
| **D** | 恢复页**整体下线**：删 `plugin-recovery.html` + `show_recovery_page`，只保留「错误页 → 安全模式」一条路径 | 面最小、零谎言；但放弃上游已有的诊断交互，属功能回退 |

> **我的建议是 B**。理由：恢复态用户要的是「把可疑插件拿开、让应用能起来」，而不是「永久销毁」；
> 可逆的禁用既满足诉求，又不触发本仓库对不可逆操作的自我约束，还顺带让「恢复页可操作」这条验收判据能真正闭环。

**无论选哪个，C1 都必须一并做（否则仍是谎言）**

1. `plugin-recovery.html`：`window.dshRecovery.action(...)` → `invoke('recovery_action', {...})`，并**检查返回值**，失败要显式提示；
2. `show_recovery_page` 命令增加 `?plugins=` 参数（页面目前没有任何数据来源）；
3. `state.rs::on_failed`：`plugin_fault = true` → `show_recovery_page`（信号 `cause.is_plugin_fault()` 已存在）。

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
- 不在批次 F 定性前动 `plugin_worker.rs` 与 `dsh-model-gateway`（现状是如实降级，属可接受状态）。
- 不改 `docs/dsh-desktop-redesign-architecture-and-plan.md` 的历史规划快照。
