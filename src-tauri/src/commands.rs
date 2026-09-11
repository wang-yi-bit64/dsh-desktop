//! IPC 命令面 + 命令守卫。
//!
//! **命令守卫（纵深防御）**：所有命令都注入 `webview` 参数并校验其 origin
//! 属于本地页集合。即使未来 remote capability 配错，非本地页（harness 页
//! 及其插件——第三方代码）也调不动宿主命令（INV-2）。
//!
//! # 返回形态：统一封套，不是裸 `Result`
//!
//! 每个命令返回 [`CommandResult<T>`]，即 `Result<IpcEnvelope<T>, String>`。
//!
//! * **内层封套**承载全部语义：[`IpcEnvelope`] 把「成败 / 数据 / 错误」分开，
//!   失败时前端拿到稳定的 `error.code`（[`dsh_host::contracts::codes`]）与
//!   `error.category`，而不是一个只能做字符串匹配的文案。理由见
//!   `dsh_contracts::ipc` 模块文档。
//! * **外层 `Result` 恒为 `Ok`**：它是 Tauri 的硬性要求（带引用的 `async`
//!   命令必须返回 `Result`，否则编译不过），**不是**错误通道。永远不要在这里
//!   返回 `Err`——那会让 `invoke` 直接 reject，错误随即丢掉 `code` / `category`，
//!   页面又退回「只能读字符串」的起点。`tests` 里钉住了这条约定。
//!
//! # 命令面的准入纪律
//!
//! 每个 `#[tauri::command]` 都是对本地页开放的攻击面，因此**只保留有真实
//! 调用方**的命令。曾被删除的两项及理由：
//!
//! * `open_in_finder` — 与 [`open_logs`] 功能重叠（同走 `reveal_path`），
//!   且其注释声称的「恢复页 / 安全模式页使用」从未成立（那两页当时零调用）。
//! * `directory_picker_open` — 用 `tauri_plugin_dialog` 另开一条目录选择
//!   路径，与 `AGENTS.md` 记载的**唯一正确路径**冲突：Harness 页的目录选择
//!   必须走进程内 host seam（`ctx.uiWorkspace.pickDirectory()` → Win32
//!   `IFileOpenDialog`），不经 Tauri 命令。该命令是那套错误方案的残留，
//!   删除后 `tauri-plugin-dialog` 亦失去唯一使用者，已从依赖中摘除。
//!
//! 手机桥状态**故意没有命令**：状态展示落在原生菜单上（见 `menu.rs` 的
//! [`crate::menu::refresh_bridge_status`]），Rust 侧直接读 `MobileBridge`
//! 状态，无需跨 IPC。
//!
//! 一致性由 `scripts/verify-ipc-surface.mjs` 在 CI 守护（定义 ↔ 注册 ↔ 前端
//! `invoke` ↔ `local_page` 目标）。

use std::sync::Arc;

use dsh_host::contracts::{codes, ErrorCategory, IpcEnvelope};
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::navigation::is_local_page;
use crate::state::{AppState, HarnessSnapshot};
use crate::window;

/// 命令返回形态（见模块文档：外层 `Result` 恒为 `Ok`，语义全在封套里）。
pub type CommandResult<T> = Result<IpcEnvelope<T>, String>;

/// 包装成功值。
fn ok<T>(data: T) -> CommandResult<T> {
    Ok(IpcEnvelope::ok(data))
}

/// 把失败封套变成任意命令的返回形态。
fn failed<T>(error: IpcEnvelope<()>) -> CommandResult<T> {
    Ok(error.into_failure())
}

/// 校验调用方是本地静态页；非本地 origin 一律拒绝（INV-2）。
///
/// 失败形态统一为 `E4002` / `authentication`（见 [`IpcEnvelope::denied`]）。
///
/// # 为什么 `Err` 要 `Box`
///
/// [`IpcEnvelope`] 是「把数据带在身上的值类型」：`AppError` 内含两个 `String`、
/// 一个可选 `String` 与一个 `serde_json::Value`，于是
/// `size_of::<IpcEnvelope<()>>()` = **128 字节**。它出现在 `Err` 位置会触发
/// `clippy::result_large_err`——按值返回的 `Result` 每穿一层调用就要搬这 128 字节。
/// 守卫又是**每个命令**的第一件事，所以这里 `Box` 掉：正常（放行）路径保持零开销，
/// 只有真的被拒绝时才多一次分配。
///
/// 为什么不动共享契约：`CommandResult<T> = Result<IpcEnvelope<T>, String>` 把封套
/// 放在 **`Ok`** 位置（`Err` 是 24 字节的 `String`），lint 不管。也就是说
/// 「把 `AppError` 拆箱」这类改法会让**所有**错误构造都多一次分配，却只能修掉
/// 下面这一处——成本与收益不成比例。
///
/// 为什么不用 `#[allow(clippy::result_large_err)]` 压下去：本仓库的口径是能修根因
/// 就不压制，而 `Box` 正是 clippy 自己给的两条建议之一。
fn ensure_local_origin(webview: &WebviewWindow) -> Result<(), Box<IpcEnvelope<()>>> {
    let url = webview
        .url()
        .map_err(|error| Box::new(internal(format!("cannot read the caller url: {error}"))))?;
    if is_local_page(&url) {
        Ok(())
    } else {
        Err(Box::new(IpcEnvelope::denied(url)))
    }
}

/// `E7xxx`：未归类的内部错误。
fn internal(message: impl Into<String>) -> IpcEnvelope<()> {
    IpcEnvelope::failure(codes::INTERNAL, ErrorCategory::Internal, message)
}

/// `E1xxx`：资源 / 环境类错误。
fn environment(code: &str, message: impl Into<String>) -> IpcEnvelope<()> {
    IpcEnvelope::failure(code, ErrorCategory::Environment, message)
}

/// 守卫 + 早退。
///
/// 每个命令的第一件事都是同一段守卫；手写十几遍既啰嗦又容易漏——漏一个就是
/// 一个不校验 origin 的攻击面（INV-2）。宏只做这一件事，不做别的。
macro_rules! guard {
    ($webview:expr) => {
        if let Err(error) = ensure_local_origin(&$webview) {
            // 守卫的 `Err` 是 `Box<IpcEnvelope<()>>`（理由见 `ensure_local_origin`）。
            return failed(*error);
        }
    };
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

/// 当前 Harness 状态快照。
#[tauri::command]
pub async fn harness_status(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<HarnessSnapshot> {
    guard!(webview);
    ok(state.supervisor.snapshot())
}

/// 重启 Harness（新端口新 token，重新导航）。
#[tauri::command]
pub async fn harness_restart(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<()> {
    guard!(webview);
    let supervisor = Arc::clone(&state.supervisor);
    window::show_splash(webview.app_handle());
    // 状态机保证：先 Stopping → Stopped，再 Preparing。
    supervisor.restart().await;
    ok(())
}

/// 回到 Harness 界面（壳内页面 → Harness）。
///
/// 存在的理由：更新页 / 日志页占用了主窗口，返回 Harness 的**唯一**路径原本
/// 只有原生菜单里的「Restart Harness」——那会真的重启 Harness 进程（新端口、
/// 新 token、会话中断），拿它当「返回」用是错误的语义。
///
/// 语义是**重放**状态机记下的那个 URL（见 `HarnessSupervisor::ready_url`），
/// 不是重新启动。未就绪时返回 `E3003`（`not_ready`）——那是正常状态而非故障，
/// 但页面必须能区分「返回了」与「没返回」，所以不返回裸 `false`。
#[tauri::command]
pub async fn harness_open(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<()> {
    guard!(webview);
    let Some(url) = state.supervisor.ready_url() else {
        return failed(
            IpcEnvelope::failure(
                codes::NOT_READY,
                ErrorCategory::ProcessLifecycle,
                "Harness is not ready yet, so there is no page to return to.",
            )
            .with_action("Wait for the startup to finish, or restart Harness from the menu."),
        );
    };
    match url::Url::parse(&url) {
        Ok(parsed) => match webview.navigate(parsed) {
            Ok(()) => ok(()),
            Err(error) => failed(internal(format!(
                "cannot navigate back to Harness: {error}"
            ))),
        },
        Err(error) => failed(internal(format!(
            "the recorded Harness url is invalid: {error}"
        ))),
    }
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

/// 取最近 `count` 行 harness 日志（错误页 / 恢复页展示尾部日志用）。
#[tauri::command]
pub async fn harness_logs_tail(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    count: Option<usize>,
) -> CommandResult<Vec<String>> {
    guard!(webview);
    ok(state.supervisor.logs_tail(count.unwrap_or(30)))
}

/// 读取某个日志文件的尾部若干行（应用内日志查看器，批次 D10）。
///
/// 与 [`harness_logs_tail`] 的分工：后者读**内存环形缓冲**（当前实例的
/// Harness 输出，进程重启即清空）；本命令读**已落盘的文件**，因此能看到
/// 上一次启动留下的记录。三个来源见 [`dsh_host::logs_view::LogFile`]。
#[tauri::command]
pub async fn logs_read(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    source: String,
    count: Option<usize>,
) -> CommandResult<dsh_host::logs_view::LogSlice> {
    guard!(webview);
    match dsh_host::logs_view::read(&state.layout, &source, count.unwrap_or(400)) {
        Ok(slice) => ok(slice),
        Err(error) => failed(environment(codes::RESOURCE_UNREADABLE, error.to_string())),
    }
}

/// 用系统文件管理器打开日志目录。
#[tauri::command]
pub async fn open_logs(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<()> {
    guard!(webview);
    let dir = state
        .layout
        .log_path
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| state.layout.app_data_dir.clone());
    reveal_path(webview.app_handle(), &dir)
}

/// 用系统文件管理器打开一个目录。
fn reveal_path(app: &tauri::AppHandle, path: &std::path::Path) -> CommandResult<()> {
    match app
        .opener()
        .open_path(path.display().to_string(), None::<&str>)
    {
        Ok(()) => ok(()),
        Err(error) => failed(internal(format!(
            "cannot reveal {}: {error}",
            path.display()
        ))),
    }
}

/// 退出应用。
#[tauri::command]
pub async fn app_quit(webview: WebviewWindow, app: tauri::AppHandle) -> CommandResult<()> {
    guard!(webview);
    app.exit(0);
    ok(())
}

// ---------------------------------------------------------------------------
// 恢复流程（批次 C）
// ---------------------------------------------------------------------------

/// 恢复页需要的全部数据。
#[derive(Debug, Clone, serde::Serialize)]
pub struct RecoveryStatus {
    /// 当前相位快照（页面据此实时反映恢复进度，D11）。
    pub snapshot: HarnessSnapshot,
    /// `DiagnosticsAnalyzer` 的归因结论（文本形式）。
    pub report: String,
    /// 从日志里提取出的嫌疑插件（去重）。
    pub plugins: Vec<String>,
    /// 是否疑似第三方插件故障。
    pub plugin_fault: bool,
}

/// 取恢复页数据（嫌疑插件 + 归因结论 + 实时快照）。
///
/// 数据来源：`state.supervisor` 的日志环形缓冲 → `dsh_host::diagnostics`
/// 的归因分析。这条链此前**没有任何消费者**——`recovery.rs` 整模块带
/// `#[allow(dead_code)]`，`plugin-recovery.html` 调用的是一个不存在的
/// `window.dshRecovery` 桥。本命令是那条链的真实消费方。
#[tauri::command]
pub async fn recovery_status(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<RecoveryStatus> {
    guard!(webview);
    let snapshot = state.supervisor.snapshot();
    let lines = state.supervisor.logs_tail(200);
    let plugin_fault = matches!(
        &snapshot.phase,
        crate::state::HarnessPhase::Failed {
            plugin_fault: true,
            ..
        }
    );
    let report = dsh_host::diagnostics::DiagnosticsAnalyzer::analyze_lines(&lines);
    ok(RecoveryStatus {
        snapshot,
        report: report.format_text(),
        plugins: report.offending_plugins,
        plugin_fault,
    })
}

/// 打开插件恢复页（错误页的「插件恢复…」按钮）。
///
/// 刻意**不**把插件故障自动路由到恢复页（`state.rs::on_failed` 仍一律先给
/// 错误页）：错误页的「疑似插件故障 → 进入安全模式」分支是 2026-09-10 刚修好
/// 的（snapshot 形状 bug），若把插件故障从这个页面挪走，那条分支会立刻变成
/// 新的死 UI——一个刚修的 bug 会以另一种形式复活。
#[tauri::command]
pub async fn recovery_open(webview: WebviewWindow) -> CommandResult<()> {
    guard!(webview);
    window::show_recovery_page(webview.app_handle());
    ok(())
}

/// 恢复动作（恢复页按钮）。
///
/// # 支持的动作
///
/// | `action` | 语义 | 可逆 |
/// |----------|------|------|
/// | `restart` | 正常重启 Harness | 是 |
/// | `safe-mode` | 以 `desktop-safe-mode` profile 启动（隔离第三方插件） | 是 |
/// | `show-log` | 用系统文件管理器打开日志目录 | 是 |
/// | `quit` | 退出应用 | 是 |
///
/// 未知动作返回 `E7002`——**不再**静默返回 `false`。此前恢复页的四个按钮
/// （含 `uninstall`）全部落在 `_ => Ok(false)` 上，而页面不检查返回值，于是
/// 「点了没反应」；静默的 `false` 正是那句谎话的载体。
///
/// # 为什么没有「卸载 / 禁用插件」
///
/// 恢复页原有的主按钮是卸载插件。**未实现，且不是遗忘**：
///
/// 1. 卸载是破坏性、不可逆操作（删用户磁盘上的插件数据）——本仓库对不可逆
///    操作的原则是不自行实现；
/// 2. 计划里推荐的替代方案「把插件目录改名为 `<name>.disabled`（可逆）」经
///    代码核验**并不成立**：市场安装的插件（generation 形态）由
///    `$DSH_HOME/profiles/.generations/desired.json` 单一权威描述，冷启动时
///    `generations/projection.mjs::projectGenerations()` 会按它重建
///    `node_modules/<name>` 链接与 `dsh.profile.bundles`——手工改名的结果会在
///    下一次冷启动被**静默还原**；而若改为从 `desired.json` 里摘除，同一文件
///    的 `sweepRegistry()` 会 `rm -rf` 掉该 generation 目录，同样不可逆。
///    即：存在一条「看着可逆、实际会被还原」的假路和一条「真删除」的路，
///    没有真正的可逆解除挂载。
///
/// 因此本命令只提供**非破坏性**动作；插件卸载/禁用记为 🕓 计划中，等待上游
/// 提供「停用」语义（`AGENTS.md` §7.2 已登记）。
#[tauri::command]
pub async fn recovery_action(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    action: String,
) -> CommandResult<()> {
    guard!(webview);
    match action.as_str() {
        "restart" => {
            window::show_splash(&app);
            state.supervisor.restart().await;
            ok(())
        }
        "safe-mode" => match crate::safe_mode::ensure_safe_mode_profile(&state.layout.dsh_home) {
            Ok(_) => {
                window::show_splash(&app);
                state.supervisor.restart_in_safe_mode().await;
                ok(())
            }
            Err(error) => failed(environment(
                codes::RESOURCE_UNREADABLE,
                format!("cannot materialise the safe-mode profile: {error}"),
            )),
        },
        "show-log" => {
            let dir = state
                .layout
                .log_path
                .parent()
                .map(std::path::Path::to_path_buf)
                .unwrap_or_else(|| state.layout.app_data_dir.clone());
            reveal_path(&app, &dir)
        }
        "quit" => {
            app.exit(0);
            ok(())
        }
        other => failed(IpcEnvelope::unknown_action(other)),
    }
}

/// 安全模式动作（错误页的「进入安全模式」按钮）。
#[tauri::command]
pub async fn safe_mode_action(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    action: String,
) -> CommandResult<()> {
    guard!(webview);
    match action.as_str() {
        "restart" => {
            // 错误页的「安全模式」按钮：profile 落盘 → 以该 profile 启动。
            //
            // 此前这里写了 profile 却调 `restart()`（永远 `web` profile +
            // 普通 patch），于是按钮的实际效果是「照常重启」——安全模式没有
            // 生效，而用户以为进去了。
            match crate::safe_mode::ensure_safe_mode_profile(&state.layout.dsh_home) {
                Ok(_) => {
                    window::show_splash(&app);
                    state.supervisor.restart_in_safe_mode().await;
                    ok(())
                }
                Err(error) => failed(environment(
                    codes::RESOURCE_UNREADABLE,
                    format!("cannot materialise the safe-mode profile: {error}"),
                )),
            }
        }
        "quit" => {
            app.exit(0);
            ok(())
        }
        other => failed(IpcEnvelope::unknown_action(other)),
    }
}

// ---------------------------------------------------------------------------
// 诊断导出（批次 D）
// ---------------------------------------------------------------------------

/// 一键导出脱敏诊断包。
///
/// 产物是 `app_data_dir/exports/diagnostics-<时间戳>.zip`。**脱敏是硬要求**：
/// launch token、`dsh-auth-*` cookie、绝对路径里的用户名段、常见 API key 形态
/// 都在打包前替换（规则与正反用例见 [`dsh_host::diagnostics_export`]）。
///
/// 返回导出摘要（含路径）供页面显示——「包在哪」必须由界面明确回答，否则
/// 用户找不到刚导出的东西。
#[tauri::command]
pub async fn diagnostics_export(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<dsh_host::diagnostics_export::ExportSummary> {
    guard!(webview);
    match dsh_host::diagnostics_export::export(&state.layout, &state.supervisor.logs_tail(500)) {
        Ok(summary) => ok(summary),
        Err(error) => failed(environment(codes::RESOURCE_UNREADABLE, error.to_string())),
    }
}

// ---------------------------------------------------------------------------
// 更新
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn updates_status(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<serde_json::Value> {
    guard!(webview);
    let guard = state.updates.lock().await;
    match guard.as_ref() {
        Some(manager) => match serde_json::to_value(manager.status().await) {
            Ok(value) => ok(value),
            Err(error) => failed(internal(format!(
                "cannot serialise the update status: {error}"
            ))),
        },
        None => ok(serde_json::json!({ "phase": "idle" })),
    }
}

#[tauri::command]
pub async fn updates_check(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<()> {
    guard!(webview);
    let manager = state.updates.lock().await.clone();
    if let Some(manager) = manager {
        manager.check(true).await;
    }
    ok(())
}

#[tauri::command]
pub async fn updates_download(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<()> {
    guard!(webview);
    let manager = state.updates.lock().await.clone();
    match manager {
        Some(manager) => Ok(manager.download().await),
        None => failed(updater_unavailable()),
    }
}

#[tauri::command]
pub async fn updates_install(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<()> {
    guard!(webview);
    let manager = state.updates.lock().await.clone();
    match manager {
        Some(manager) => Ok(manager.install().await),
        None => failed(updater_unavailable()),
    }
}

#[tauri::command]
pub async fn updates_skip(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    version: String,
) -> CommandResult<()> {
    guard!(webview);
    let manager = state.updates.lock().await.clone();
    if let Some(manager) = manager {
        manager.skip(version).await;
    }
    ok(())
}

/// 更新器不可用：`E1003`（环境类，不是网络类）。
fn updater_unavailable() -> IpcEnvelope<()> {
    environment(
        codes::UPDATER_UNAVAILABLE,
        "the updater is not available in this session",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 守卫拒绝的封套必须带可编程的错误码与类别：页面据此区分「权限」与
    /// 「其他失败」。改 `denied` 的实现会在这里断掉。
    #[test]
    fn guard_denial_is_classified_as_authentication() {
        let denial = IpcEnvelope::denied("https://evil.example/");
        let error = denial.error.expect("denial must carry a cause");
        assert_eq!(error.code, codes::PERMISSION_DENIED);
        assert_eq!(error.category, ErrorCategory::Authentication);
        assert!(
            error.suggested_action.is_some(),
            "拒绝类错误必须给出可执行的下一步"
        );
    }

    /// 失败封套转成某个命令的返回类型后，`success` / `error` 都不丢。
    #[test]
    fn failure_envelopes_survive_conversion() {
        let envelope: IpcEnvelope<HarnessSnapshot> =
            IpcEnvelope::denied("http://127.0.0.1:9/").into_failure();
        assert!(!envelope.success);
        assert!(envelope.data.is_none());
        let error = envelope.error.expect("must keep the cause");
        assert_eq!(error.code, codes::PERMISSION_DENIED);
    }

    /// 未知动作不能被静默吞掉——它必须是一个可辨识的错误。
    #[test]
    fn unknown_action_is_reported_not_swallowed() {
        let envelope = IpcEnvelope::unknown_action("uninstall");
        assert!(!envelope.success);
        assert_eq!(
            envelope.error.expect("must carry a cause").code,
            codes::UNKNOWN_ACTION
        );
    }
}
