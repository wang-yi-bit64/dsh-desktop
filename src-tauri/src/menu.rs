//! Application menu: restart Harness, safe mode, view log, check updates.

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Manager, Runtime};

use crate::state::AppState;

pub fn build_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let restart = MenuItemBuilder::with_id("harness-restart", "Restart Harness").build(app)?;
    let safe_mode = MenuItemBuilder::with_id("harness-safe-mode", "Restart in Safe Mode").build(app)?;
    let view_log = MenuItemBuilder::with_id("harness-view-log", "View Harness Log").build(app)?;
    let check_updates = MenuItemBuilder::with_id("updates-check", "Check for Updates…").build(app)?;
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
                state.runtime.start().await;
            }
            "harness-safe-mode" => {
                if let Ok(data_dir) = app.path().app_data_dir() {
                    let dsh_home = crate::paths::dsh_home(&data_dir);
                    let _ = crate::safe_mode::ensure_safe_mode_profile(&dsh_home);
                }
                crate::window::show_splash(&app);
                state.runtime.start().await;
            }
            "harness-view-log" => {
                if let Ok(data_dir) = app.path().app_data_dir() {
                    let log_path = crate::paths::harness_log_path(&data_dir);
                    let _ = crate::commands::open_in_finder(log_path.display().to_string()).await;
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
