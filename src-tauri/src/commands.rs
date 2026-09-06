//! IPC 命令面 + 命令守卫（任务 1.4）。
//!
//! **命令守卫（纵深防御）**：所有命令都注入 `webview` 参数并校验其 origin
//! 属于本地页集合。即使未来 remote capability 配错，非本地页（harness 页
//! 及其插件——第三方代码）也调不动宿主命令（INV-2）。

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

/// 打开任意本地路径（恢复页 / 安全模式页使用）。
#[tauri::command]
pub async fn open_in_finder(webview: WebviewWindow, path: String) -> Result<(), String> {
    ensure_local_origin(&webview)?;
    reveal_path(webview.app_handle(), std::path::Path::new(&path))
}

fn reveal_path(app: &tauri::AppHandle, path: &std::path::Path) -> Result<(), String> {
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|error| error.to_string())
}

/// 原生目录选择器（阶段 3 会改为 remote capability 直通，见 ADR-4）。
#[tauri::command]
pub async fn directory_picker_open(
    webview: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    ensure_local_origin(&webview)?;
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |selection| {
        let path = selection.map(|p| p.to_string());
        let _ = tx.send(path);
    });
    rx.recv().map_err(|error| error.to_string())
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
            crate::safe_mode::ensure_safe_mode_profile(&dsh_home).map_err(|e| e.to_string())?;
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

#[tauri::command]
pub async fn mobile_status(
    webview: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, String> {
    ensure_local_origin(&webview)?;
    serde_json::to_value(state.mobile.snapshot().await).map_err(|e| e.to_string())
}
