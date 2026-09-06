//! DSH Desktop — Rust + Tauri 2.0 的 DeepSeek Harness 桌面壳。
//!
//! GUI 层只做壳与事件接线（ADR-3）：
//!
//! * 主链路（spawn → 就绪 → 导航 → 退出清理）全部在 `dsh-host` 库 crate 中，
//!   可单测、可 CLI 排障（INV-6）；
//! * 本模块负责：窗口创建与**导航白名单**（任务 1.4）、状态机事件转发、
//!   菜单、单实例、IPC 命令（含命令守卫）；
//! * 安全边界（INV-2）：harness 页面没有 remote capability，调用不了任何
//!   宿主命令；本地静态页的命令也有 origin 守卫双重校验。

mod commands;
mod cookies;
mod layout;
mod menu;
mod mobile_bridge;
mod navigation;
mod recovery;
mod safe_mode;
mod state;
mod update;
mod window;

use std::sync::Arc;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use navigation::{decide_navigation, NavigationDecision};
use state::{AppState, HarnessSupervisor};

use dsh_host::launch::LauncherConfig;

/// 应用入口。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 二次启动 → 聚焦既有窗口，而不是再开一份。
            if let Some(webview) = window::main_window(app) {
                let _ = webview.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // 只读资源 + 可写 userData 布局（INV-1 的唯一落点）。
            let layout = layout::resolve_layout(&handle)?;
            layout.ensure_dirs()?;

            let supervisor = Arc::new(HarnessSupervisor::new(
                handle.clone(),
                layout.clone(),
                LauncherConfig::default(),
            ));
            let mobile = Arc::new(mobile_bridge::MobileBridge::new());
            app.manage(Arc::new(AppState::new(
                Arc::clone(&supervisor),
                layout.clone(),
                Arc::clone(&mobile),
            )));

            // 菜单。
            let menu = menu::build_menu(&handle)?;
            handle.set_menu(menu)?;
            let menu_handle = handle.clone();
            handle.on_menu_event(move |_app, event| {
                menu::handle_menu_event(&menu_handle, event.id().as_ref());
            });

            // 主窗口：代码创建，以便挂导航白名单（配置文件创建的窗口无法补挂）。
            WebviewWindowBuilder::new(
                &handle,
                window::MAIN_WINDOW,
                WebviewUrl::App("index.html".into()),
            )
            .title("DSH Desktop")
            .inner_size(1280.0, 800.0)
            .min_inner_size(900.0, 600.0)
            .center()
            .resizable(true)
            // 任务 1.4：导航白名单——只放行本地静态页与当前 harness 实例。
            .on_navigation({
                let nav_handle = handle.clone();
                move |url| {
                    let port = nav_handle
                        .try_state::<Arc<AppState>>()
                        .and_then(|state| state.supervisor.harness_port());
                    match decide_navigation(url, port) {
                        NavigationDecision::Allow => true,
                        NavigationDecision::External => {
                            // 非可信 http(s)：转交系统浏览器，窗口不放行。
                            let opener = nav_handle.opener();
                            let _ = opener.open_url(url.to_string(), None::<&str>);
                            false
                        }
                        NavigationDecision::Block => false,
                    }
                }
            })
            // §2.2 非目标：不做多窗口。window.open / target=_blank 一律拦截，
            // 外部链接交给系统浏览器。
            .on_new_window({
                let nav_handle = handle.clone();
                move |url, _features| {
                    let port = nav_handle
                        .try_state::<Arc<AppState>>()
                        .and_then(|state| state.supervisor.harness_port());
                    if decide_navigation(&url, port) == NavigationDecision::External {
                        let opener = nav_handle.opener();
                        let _ = opener.open_url(url.to_string(), None::<&str>);
                    }
                    tauri::webview::NewWindowResponse::Deny
                }
            })
            .build()?;

            // 更新管理器（阶段 6 完整接线；当前为启动 + 6h 轮询）。
            let update_manager = Arc::new(update::UpdateManager::new(handle.clone()));
            {
                let app_handle = handle.clone();
                let manager = Arc::clone(&update_manager);
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                        *state.updates.lock().await = Some(manager.clone());
                    }
                    manager.start();
                });
            }

            // 窗口就绪后启动 Harness（splash → … → harness UI）。
            let start_supervisor = Arc::clone(&supervisor);
            tauri::async_runtime::spawn(async move {
                start_supervisor.start().await;
            });

            Ok(())
        })
        .on_window_event(|webview_window, event| {
            // 关窗 → 停止子进程（SIGTERM → 4s → SIGKILL / taskkill /T）。
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if webview_window.label() == window::MAIN_WINDOW {
                    let app = webview_window.app_handle();
                    if let Some(state) = app.try_state::<Arc<AppState>>() {
                        let mobile = Arc::clone(&state.mobile);
                        let supervisor = Arc::clone(&state.supervisor);
                        // 阻塞一小段时间，确保子进程在应用退出前被回收（INV-3）。
                        tauri::async_runtime::block_on(async move {
                            mobile.stop().await;
                            supervisor.stop().await;
                        });
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::harness_status,
            commands::harness_restart,
            commands::harness_logs_tail,
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
