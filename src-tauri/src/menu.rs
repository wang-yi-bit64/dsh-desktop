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
    // LAN 手机桥是显式动作：菜单点击才监听，避免每次启动都在局域网暴露端口。
    let mobile_pair = MenuItemBuilder::with_id("mobile-pair", "Phone Pairing (LAN)…").build(app)?;
    let mobile_stop = MenuItemBuilder::with_id("mobile-stop", "Stop Phone Bridge").build(app)?;
    let check_updates =
        MenuItemBuilder::with_id("updates-check", "Check for Updates…").build(app)?;
    let quit = MenuItemBuilder::with_id("app-quit", "Quit DSH Desktop").build(app)?;

    let harness_submenu = SubmenuBuilder::new(app, "Harness")
        .item(&restart)
        .item(&safe_mode)
        .separator()
        .item(&view_log)
        .build()?;

    let mobile_submenu = SubmenuBuilder::new(app, "Phone")
        .item(&mobile_pair)
        .item(&mobile_stop)
        .build()?;

    let app_submenu = SubmenuBuilder::new(app, "DSH Desktop")
        .item(&check_updates)
        .separator()
        .item(&quit)
        .build()?;

    MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&harness_submenu)
        .item(&mobile_submenu)
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
            // 启动 LAN 桥并在系统浏览器打开配对页（桌面端显示二维码供手机扫描）。
            // 二维码由配对页渲染，见 mobile_bridge::pair_page。
            "mobile-pair" => {
                // 配对页本身不依赖 Harness；但目标未注入时 /api/rpc 必然失败，
                // 提前告警，避免用户把「Harness 未就绪」误判成配对故障。
                if !state.mobile.has_target().await {
                    log::warn!("mobile bridge has no Harness target; RPC forwarding will fail");
                }
                match state.mobile.start(None).await {
                    Ok(snapshot) => {
                        log::info!(
                            "mobile bridge listening port={:?} authenticated={}",
                            snapshot.port,
                            snapshot.authenticated
                        );
                        if !snapshot.authenticated {
                            log::warn!(
                            "mobile bridge has no Harness auth cookie yet; /api/rpc will retry the handshake"
                        );
                        }
                        match snapshot.pairing_url {
                            Some(url) => {
                                if let Err(error) = app.opener().open_url(url, None::<&str>) {
                                    log::error!("cannot open pairing page: {error}");
                                }
                            }
                            None => log::warn!("mobile bridge started without a pairing URL"),
                        }
                    }
                    Err(error) => log::error!("mobile bridge failed to start: {error}"),
                }
            }
            "mobile-stop" => {
                state.mobile.stop().await;
                log::info!("mobile bridge stopped");
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
