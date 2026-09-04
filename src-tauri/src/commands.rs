//! IPC commands exposed to the frontend.
//!
//! These mirror the Electron `ipcRenderer.invoke` surface: harness control,
//! log viewing, the native directory picker, external links and the
//! recovery/safe-mode/update actions.

use std::sync::Arc;

use tauri::{Manager, State};

use crate::harness_runtime::RuntimeSnapshot;
use crate::state::AppState;

#[tauri::command]
pub async fn harness_status(state: State<'_, Arc<AppState>>) -> Result<RuntimeSnapshot, String> {
    Ok(state.runtime.snapshot().await)
}

#[tauri::command]
pub async fn harness_restart(state: State<'_, Arc<AppState>>, app: tauri::AppHandle) -> Result<(), String> {
    crate::window::show_splash(&app);
    state.runtime.start().await;
    Ok(())
}

#[tauri::command]
pub async fn open_logs(state: State<'_, Arc<AppState>>, app: tauri::AppHandle) -> Result<(), String> {
    let snapshot = state.runtime.snapshot().await;
    let _ = snapshot;
    let log_path = crate::paths::harness_log_path(
        &app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?,
    );
    open_path(&log_path)
}

#[tauri::command]
pub async fn open_in_finder(path: String) -> Result<(), String> {
    open_path(std::path::Path::new(&path))
}

fn open_path(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
pub async fn directory_picker_open(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .pick_folder(move |selection| {
            let path = selection.map(|p| p.to_string());
            let _ = tx.send(path);
        });
    rx.recv().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    // Only hand genuinely external http(s) links to the system browser.
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("refusing to open non-http link".into());
    }
    if parsed.host_str() == Some("127.0.0.1") || parsed.host_str() == Some("localhost") {
        return Err("refusing to open loopback link externally".into());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
pub async fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub async fn recovery_action(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    action: String,
) -> Result<bool, String> {
    match action.as_str() {
        "restart" => {
            crate::window::show_splash(&app);
            state.runtime.start().await;
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
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    action: String,
) -> Result<bool, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dsh_home = crate::paths::dsh_home(&data_dir);
    match action.as_str() {
        "restart" => {
            crate::safe_mode::ensure_safe_mode_profile(&dsh_home).map_err(|e| e.to_string())?;
            crate::window::show_splash(&app);
            state.runtime.start().await;
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
pub async fn updates_status(state: State<'_, Arc<AppState>>) -> Result<serde_json::Value, String> {
    let guard = state.updates.lock().await;
    match guard.as_ref() {
        Some(manager) => Ok(serde_json::to_value(manager.status().await).unwrap()),
        None => Ok(serde_json::json!({"phase": "idle"})),
    }
}

#[tauri::command]
pub async fn updates_check(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let manager = state.updates.lock().await.clone();
    if let Some(manager) = manager {
        manager.check(true).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn updates_download(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let manager = state.updates.lock().await.clone();
    match manager {
        Some(manager) => manager.download().await,
        None => Err("updater not available".into()),
    }
}

#[tauri::command]
pub async fn updates_install(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let manager = state.updates.lock().await.clone();
    match manager {
        Some(manager) => manager.install().await,
        None => Err("updater not available".into()),
    }
}

#[tauri::command]
pub async fn updates_skip(state: State<'_, Arc<AppState>>, version: String) -> Result<(), String> {
    let manager = state.updates.lock().await.clone();
    if let Some(manager) = manager {
        manager.skip(version).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn mobile_status(state: State<'_, Arc<AppState>>) -> Result<serde_json::Value, String> {
    serde_json::to_value(state.mobile.snapshot().await).map_err(|e| e.to_string())
}
