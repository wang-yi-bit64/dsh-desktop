//! DSH Desktop — a Rust + Tauri 2.0 desktop shell for DeepSeek Harness.
//!
//! The app bundles a Node.js runtime and the full `@deepseek-ai/dsh`
//! dependency tree, launches Harness on a random loopback port, waits for the
//! per-process launch token and HTTP readiness, then loads the web UI into the
//! main window. Profiles, plugins and sessions live in the app data directory
//! so upgrades never remove user data.

mod commands;
mod harness_runtime;
mod menu;
mod mobile_bridge;
mod paths;
mod recovery;
mod resources;
mod safe_mode;
mod shell_env;
mod state;
mod update;
mod window;

use std::sync::Arc;

use harness_runtime::{HarnessRuntime, RuntimePhase, STATUS_EVENT};
use state::AppState;
use tauri::{Listener, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Focus the existing window instead of launching a second copy.
            if let Some(window) = window::main_window(app) {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Application-owned data directories.
            let data_dir = handle
                .path()
                .app_data_dir()
                .expect("app data dir must resolve");
            paths::ensure_data_dirs(&data_dir)
                .expect("data directories must be creatable");

            // Runtime paths resolved from bundled resources.
            let runtime_paths = resources::runtime_paths(&handle);

            let runtime = Arc::new(HarnessRuntime::new(handle.clone(), runtime_paths));
            let mobile = Arc::new(mobile_bridge::MobileBridge::new());
            let app_state = Arc::new(AppState::new(Arc::clone(&runtime), Arc::clone(&mobile)));
            app.manage(app_state.clone());

            // Menu.
            let menu = menu::build_menu(&handle)?;
            handle.set_menu(menu)?;
            let menu_handle = handle.clone();
            handle.on_menu_event(move |_app, event| {
                menu::handle_menu_event(&menu_handle, event.id().as_ref());
            });

            // Drive window navigation from runtime status events.
            let nav_handle = handle.clone();
            let runtime_for_events = Arc::clone(&runtime);
            let mobile_for_events = Arc::clone(&mobile);
            handle.listen(STATUS_EVENT, move |event| {
                let snapshot: harness_runtime::RuntimeSnapshot =
                    match serde_json::from_str(event.payload()) {
                        Ok(snapshot) => snapshot,
                        Err(_) => return,
                    };
                let phase = snapshot.phase;
                let url = snapshot.url.clone();
                let token = snapshot.auth_token.clone();

                let nav_handle = nav_handle.clone();
                let runtime_for_events = Arc::clone(&runtime_for_events);
                let mobile_for_events = Arc::clone(&mobile_for_events);
                tauri::async_runtime::spawn(async move {
                    window::apply_phase(
                        &nav_handle,
                        phase,
                        url.as_deref(),
                        token.as_deref(),
                    );
                    if phase == RuntimePhase::Ready {
                        mobile_for_events.set_harness_target(url).await;
                    }
                    let _ = runtime_for_events;
                });
            });

            // Update manager.
            let update_manager = Arc::new(update::UpdateManager::new(handle.clone()));
            {
                let app_state = app_state.clone();
                let manager = Arc::clone(&update_manager);
                tauri::async_runtime::spawn(async move {
                    *app_state.updates.lock().await = Some(manager.clone());
                    manager.start();
                });
            }

            // Launch Harness once the window is up.
            let start_runtime = Arc::clone(&runtime);
            tauri::async_runtime::spawn(async move {
                start_runtime.start().await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Gracefully stop Harness when the main window closes.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == window::MAIN_WINDOW {
                    let app = window.app_handle();
                    if let Some(state) = app.try_state::<Arc<AppState>>() {
                        let runtime = Arc::clone(&state.runtime);
                        let mobile = Arc::clone(&state.mobile);
                        // Block briefly so the child process is reaped before
                        // the desktop app exits; SIGTERM→4s→SIGKILL on POSIX,
                        // taskkill /T on Windows.
                        tauri::async_runtime::block_on(async move {
                            mobile.stop().await;
                            runtime.stop().await;
                        });
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::harness_status,
            commands::harness_restart,
            commands::open_logs,
            commands::open_in_finder,
            commands::directory_picker_open,
            commands::open_external,
            commands::app_quit,
            commands::recovery_action,
            commands::safe_mode_action,
            commands::updates_status,
            commands::updates_check,
            commands::updates_download,
            commands::updates_install,
            commands::updates_skip,
            commands::mobile_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running DSH Desktop");
}
