//! 原生菜单（阶段 3 任务 1 的 MVP 版本）。
//!
//! 菜单事件全部走状态机：「重启 Harness」必须先 `Stopping → Stopped` 再
//! `Preparing`（新端口新 token → 重新导航，旧页面自然失效）。

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

/// 构建应用菜单。
pub fn build_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let restart = MenuItemBuilder::with_id("harness-restart", "Restart Harness").build(app)?;
    let safe_mode =
        MenuItemBuilder::with_id("harness-safe-mode", "Restart in Safe Mode").build(app)?;
    let view_log = MenuItemBuilder::with_id("harness-view-log", "View Harness Log").build(app)?;
    let check_updates =
        MenuItemBuilder::with_id("updates-check", "Check for Updates…").build(app)?;
    let quit = MenuItemBuilder::with_id("app-quit", "Quit DSH Desktop").build(app)?;

    let harness_submenu = SubmenuBuilder::new(app, "Harness")
        .item(&restart)
        .item(&safe_mode)
        .separator()
        .item(&view_log)
        .build()?;

    let app_submenu = SubmenuBuilder::new(app, "DSH Desktop")
        .item(&check_updates)
        .separator()
        .item(&quit)
        .build()?;

    MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&harness_submenu)
        .build()
}

/// 菜单事件分发。
pub fn handle_menu_event<R: Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<std::sync::Arc<AppState>>() else {
            return;
        };
        match id.as_str() {
            "harness-restart" => {
                crate::window::show_splash(&app);
                state.supervisor.restart().await;
            }
            "harness-safe-mode" => {
                let _ = crate::safe_mode::ensure_safe_mode_profile(&state.layout.dsh_home);
                crate::window::show_splash(&app);
                state.supervisor.restart().await;
            }
            "harness-view-log" => {
                if let Some(dir) = state.layout.log_path.parent() {
                    let _ = app
                        .opener()
                        .open_path(dir.display().to_string(), None::<&str>);
                }
            }
            "updates-check" => {
                let manager = state.updates.lock().await.clone();
                if let Some(manager) = manager {
                    manager.check(true).await;
                }
            }
            "app-quit" => app.exit(0),
            _ => {}
        }
    });
}
