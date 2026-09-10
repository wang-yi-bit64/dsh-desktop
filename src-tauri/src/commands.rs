//! IPC 命令面 + 命令守卫（任务 1.4）。
//!
//! **命令守卫（纵深防御）**：所有命令都注入 `webview` 参数并校验其 origin
//! 属于本地页集合。即使未来 remote capability 配错，非本地页（harness 页
//! 及其插件——第三方代码）也调不动宿主命令（INV-2）。
//!
//! # 命令面的准入纪律（2026-09-10 补）
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
//! 手机桥状态**故意没有命令**：壳内页面（splash / error / recovery /
//! safe-mode）都不展示桥状态，状态展示落在原生菜单上（见 `menu.rs` 的
//! [`crate::menu::refresh_bridge_status`]），Rust 侧直接读 `MobileBridge`
//! 状态，无需跨 IPC。若将来确有页面要展示，再加命令——不要为「可能有用」
//! 预留。

use std::sync::Arc;

use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::navigation::is_local_page;
use crate::state::{AppState, HarnessSnapshot};
use crate::window;

/// 校验调用方是本地静态页；非本地 origin 一律拒绝（INV-2）。
fn ensure_local_origin(webview: &WebviewWindow) -> Result<(), String> {
    let url = webview.url().map_err(|error| error.to_string())?;
    if is_local_page(&url) {
        Ok(())
    } else {
        Err(format!(
            "permission denied: remote page ({url}) may not invoke host commands"
        ))
    }
}

/// 当前 Harness 状态快照。
#[tauri::command]
pub async fn harness_status(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> Result<HarnessSnapshot, String> {
    ensure_local_origin(&webview)?;
    Ok(state.supervisor.snapshot())
}

/// 重启 Harness（新端口新 token，重新导航）。
#[tauri::command]
pub async fn harness_restart(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    ensure_local_origin(&webview)?;
    let supervisor = Arc::clone(&state.supervisor);
    window::show_splash(webview.app_handle());
    // 状态机保证：先 Stopping → Stopped，再 Preparing。
    supervisor.restart().await;
    Ok(())
}

/// 取最近 `count` 行 harness 日志（错误页展示尾部日志用）。
#[tauri::command]
pub async fn harness_logs_tail(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    count: Option<usize>,
) -> Result<Vec<String>, String> {
    ensure_local_origin(&webview)?;
    Ok(state.supervisor.logs_tail(count.unwrap_or(30)))
}

/// 用系统文件管理器打开日志目录。
#[tauri::command]
pub async fn open_logs(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    ensure_local_origin(&webview)?;
    let dir = state
        .layout
        .log_path
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| state.layout.app_data_dir.clone());
    reveal_path(webview.app_handle(), &dir)
}

fn reveal_path(app: &tauri::AppHandle, path: &std::path::Path) -> Result<(), String> {
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|error| error.to_string())
}

/// 外链转交系统浏览器（opener 接线，替代 v1 的 shell 方案）。
#[tauri::command]
pub async fn open_external(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    url: String,
) -> Result<(), String> {
    ensure_local_origin(&webview)?;
    // 只放行真正的外部 http(s) 链接。
    let parsed = url::Url::parse(&url).map_err(|error| error.to_string())?;
    if !crate::navigation::is_openable_external(&parsed) {
        return Err("refusing to open non-external link".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn app_quit(webview: WebviewWindow, app: tauri::AppHandle) {
    let _ = ensure_local_origin(&webview);
    app.exit(0);
}

#[tauri::command]
pub async fn recovery_action(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    action: String,
) -> Result<bool, String> {
    ensure_local_origin(&webview)?;
    match action.as_str() {
        "restart" => {
            window::show_splash(&app);
            state.supervisor.restart().await;
            Ok(true)
        }
        "quit" => {
            app.exit(0);
            Ok(true)
        }
        _ => Ok(false),
    }
}

#[tauri::command]
pub async fn safe_mode_action(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    action: String,
) -> Result<bool, String> {
    ensure_local_origin(&webview)?;
    let dsh_home = state.layout.dsh_home.clone();
    match action.as_str() {
        "restart" => {
            // 错误页的「安全模式」按钮：profile 落盘 → 以该 profile 启动。
            //
            // 此前这里写了 profile 却调 `restart()`（永远 `web` profile +
            // 普通 patch），于是按钮的实际效果是「照常重启」——安全模式没有
            // 生效，而用户以为进去了。
            crate::safe_mode::ensure_safe_mode_profile(&dsh_home).map_err(|e| e.to_string())?;
            window::show_splash(&app);
            state.supervisor.restart_in_safe_mode().await;
            Ok(true)
        }
        "quit" => {
            app.exit(0);
            Ok(true)
        }
        _ => Ok(false),
    }
}

#[tauri::command]
pub async fn updates_status(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, String> {
    ensure_local_origin(&webview)?;
    let guard = state.updates.lock().await;
    match guard.as_ref() {
        Some(manager) => serde_json::to_value(manager.status().await).map_err(|e| e.to_string()),
        None => Ok(serde_json::json!({ "phase": "idle" })),
    }
}

#[tauri::command]
pub async fn updates_check(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    ensure_local_origin(&webview)?;
    let manager = state.updates.lock().await.clone();
    if let Some(manager) = manager {
        manager.check(true).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn updates_download(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    ensure_local_origin(&webview)?;
    let manager = state.updates.lock().await.clone();
    match manager {
        Some(manager) => manager.download().await,
        None => Err("updater not available".into()),
    }
}

#[tauri::command]
pub async fn updates_install(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    ensure_local_origin(&webview)?;
    let manager = state.updates.lock().await.clone();
    match manager {
        Some(manager) => manager.install().await,
        None => Err("updater not available".into()),
    }
}

#[tauri::command]
pub async fn updates_skip(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    version: String,
) -> Result<(), String> {
    ensure_local_origin(&webview)?;
    let manager = state.updates.lock().await.clone();
    if let Some(manager) = manager {
        manager.skip(version).await;
    }
    Ok(())
}
