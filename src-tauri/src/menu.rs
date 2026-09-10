//! 原生菜单（阶段 3 任务 1 的 MVP 版本）。
//!
//! 菜单事件全部走状态机：「重启 Harness」必须先 `Stopping → Stopped` 再
//! `Preparing`（新端口新 token → 重新导航，旧页面自然失效）。
//!
//! # `Phone` 子菜单的状态行（2026-09-10 接入）
//!
//! 菜单第一项是**禁用**的信息项，文案由 [`refresh_bridge_status`] 在桥状态
//! 变化时刷新。有四处调用：
//!
//! 1. 启动建菜单（同步，初值 `off`）；
//! 2. 菜单发起配对成功 / 失败（`mobile-pair`）；
//! 3. 菜单停止桥（`mobile-stop`）；
//! 4. **手机侧配对成功**——经 `MobileBridge::on_connected_change` 回调
//!    （在 `lib.rs` setup 注册）。这一条容易漏：`POST /pair` 发生在手机的
//!    浏览器里，宿主没有本地事件可挂钩，所以只能靠桥回调通知。
//!
//! 上游对应物是 `onConnectedChange → broadcastMobileStatus`，但它广播进的
//! 是 Harness 网页（preload 注入的侧栏浮动按钮），本仓无 preload 通道，
//! 因此落点换成原生菜单。差别见 `mobile_bridge` 模块文档的「展示面」一节。
//!
//! 为什么不做成「重建整个菜单」或「把句柄存进托管状态」：
//!
//! * `muda::MenuItem` 内部是 `Rc`，**既非 `Send` 也非 `Sync`**，无法放进
//!   Tauri 托管状态（`manage` 要求 `Send + Sync + 'static`）；
//! * 因此改为经 `AppHandle::menu()` 取回已设置的菜单，再按 id 逐层定位句柄。
//!   注意 `Menu::get` / `Submenu::get` **只查直接子项、不递归**，所以必须先进
//!   `Phone` 子菜单（[`PHONE_SUBMENU_ID`]）再取状态项。
//!
//! 这些 API 内部都经 `run_on_main_thread` 派发并**阻塞等待**结果，所以只能在
//! 工作线程调用；从主线程调用会自锁（我们的调用点都在
//! `tauri::async_runtime::spawn` 出的任务里）。

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::mobile_bridge::{self, MobileBridgeSnapshot};
use crate::state::AppState;

/// `Phone` 子菜单的 id。
///
/// `Menu::get` 只查直接子项，定位状态项必须先经该 id 拿到子菜单句柄。
pub const PHONE_SUBMENU_ID: &str = "phone";

/// 手机桥状态信息项的 id（禁用项，只展示不可点击）。
pub const MOBILE_STATUS_ID: &str = "mobile-status";

/// 构建应用菜单。
pub fn build_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let restart = MenuItemBuilder::with_id("harness-restart", "Restart Harness").build(app)?;
    let safe_mode =
        MenuItemBuilder::with_id("harness-safe-mode", "Restart in Safe Mode").build(app)?;
    // 「View Harness Log」打开**应用内日志页**（批次 D3/D10）。此前它只调
    // `opener` 打开系统文件管理器——在「应用起不来 / 界面卡住」时那条路径
    // 恰好最没用：用户要的是能看到日志，而不是被丢进一个文件夹自己找。
    let view_log = MenuItemBuilder::with_id("harness-view-log", "View Logs…").build(app)?;
    let export_diagnostics =
        MenuItemBuilder::with_id("harness-export-diagnostics", "Export Diagnostics…").build(app)?;
    // 保留「在文件管理器中打开」为**次**入口（仍有用途：用户要把整个目录
    // 拷走，或日志页本身打不开时）。
    let reveal_logs =
        MenuItemBuilder::with_id("harness-reveal-logs", "Reveal Log Folder").build(app)?;
    // LAN 手机桥是显式动作：菜单点击才监听，避免每次启动都在局域网暴露端口。
    let mobile_pair = MenuItemBuilder::with_id("mobile-pair", "Phone Pairing (LAN)…").build(app)?;
    let mobile_stop = MenuItemBuilder::with_id("mobile-stop", "Stop Phone Bridge").build(app)?;
    // 状态行：初始即「未启动」（桥从不自动监听，见 mobile_bridge 模块文档），
    // 无需异步查询，因此 setup 阶段可以同步建好。
    let mobile_status = MenuItemBuilder::with_id(
        MOBILE_STATUS_ID,
        mobile_bridge::status_label(&MobileBridgeSnapshot::default(), None),
    )
    .enabled(false)
    .build(app)?;
    let check_updates =
        MenuItemBuilder::with_id("updates-check", "Check for Updates…").build(app)?;
    let quit = MenuItemBuilder::with_id("app-quit", "Quit DSH Desktop").build(app)?;

    let harness_submenu = SubmenuBuilder::new(app, "Harness")
        .item(&restart)
        .item(&safe_mode)
        .separator()
        .item(&view_log)
        .item(&reveal_logs)
        .item(&export_diagnostics)
        .build()?;

    let mobile_submenu = SubmenuBuilder::with_id(app, PHONE_SUBMENU_ID, "Phone")
        .item(&mobile_status)
        .separator()
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

/// 刷新 `Phone` 子菜单里的桥状态文案。
///
/// 幂等；任一环节查不到（菜单未设置、平台未支持）时静默返回——状态行是
/// **辅助信息**，不该因为刷新失败而中断配对/停止流程。
///
/// # 参数
///
/// * `app` — 应用句柄，需已 `set_menu` 过 [`build_menu`] 的产物。
/// * `snapshot` — 桥状态快照，通常来自 `MobileBridge::snapshot()`。
///
/// # 调用约束
///
/// 内部经 `run_on_main_thread` 同步派发，**必须从工作线程调用**（主线程调用
/// 会自锁）。
pub fn refresh_bridge_status<R: Runtime>(
    app: &tauri::AppHandle<R>,
    snapshot: &MobileBridgeSnapshot,
) {
    let label = mobile_bridge::status_label(snapshot, mobile_bridge::lan_ipv4().as_deref());

    let Some(menu) = app.menu() else {
        return;
    };
    // 逐层定位：`Menu::get` / `Submenu::get` 都不递归，必须显式进 `Phone` 子菜单。
    let Some(submenu) = menu.get(PHONE_SUBMENU_ID) else {
        log::warn!("menu submenu `{PHONE_SUBMENU_ID}` not found; bridge status row not updated");
        return;
    };
    let Some(submenu) = submenu.as_submenu() else {
        return;
    };
    let Some(item) = submenu.get(MOBILE_STATUS_ID) else {
        return;
    };
    let Some(item) = item.as_menuitem() else {
        return;
    };
    if let Err(error) = item.set_text(&label) {
        log::warn!("cannot update phone bridge menu label: {error}");
    }
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
                // 顺序不能反：profile 目录先落盘，再以该 profile 启动。
                // `restart_in_safe_mode` 会传 `--profile desktop-safe-mode`
                // 并把 `--patch` 换成 dsh-desktop-safe.patch.yml（C10）。
                if let Err(error) =
                    crate::safe_mode::ensure_safe_mode_profile(&state.layout.dsh_home)
                {
                    log::error!("cannot materialise the safe-mode profile: {error}");
                    return;
                }
                crate::window::show_splash(&app);
                state.supervisor.restart_in_safe_mode().await;
                log::info!("harness restarting in safe mode");
            }
            "harness-view-log" => {
                // 应用内日志页：能选来源、刷新、导出诊断包，并且**在应用起不来
                // 时也打不开**——那种情况下的入口是错误页的「查看日志」与
                // 「导出诊断包」按钮。
                crate::window::show_logs_page(&app);
            }
            // 「在文件管理器中打开」：次入口，保留给「要把整个目录拷走」以及
            // 「日志页本身加载不出来」两种场景。
            "harness-reveal-logs" => {
                if let Some(dir) = state.layout.log_path.parent() {
                    let _ = app
                        .opener()
                        .open_path(dir.display().to_string(), None::<&str>);
                }
            }
            // 导出脱敏诊断包：菜单入口（错误页另有同功能按钮）。
            //
            // 结果要**可见**：导出是显式用户动作，失败不能表现成「点了没反应」。
            // 这里用日志与错误页按钮之外的最轻回执——导出成功后打开 exports
            // 目录，用户立刻看到产物；失败则记 error 日志。
            "harness-export-diagnostics" => {
                match dsh_host::diagnostics_export::export(
                    &state.layout,
                    &state.supervisor.logs_tail(500),
                ) {
                    Ok(summary) => {
                        log::info!(
                            "diagnostics bundle exported: {} ({} bytes, {} redaction rule(s) fired)",
                            summary.path,
                            summary.bytes,
                            summary.redactions.len()
                        );
                        if let Some(dir) = std::path::Path::new(&summary.path).parent() {
                            let _ = app
                                .opener()
                                .open_path(dir.display().to_string(), None::<&str>);
                        }
                    }
                    Err(error) => log::error!("diagnostics export failed: {error}"),
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
                        match &snapshot.pairing_url {
                            Some(url) => {
                                if let Err(error) = app.opener().open_url(url.clone(), None::<&str>)
                                {
                                    log::error!("cannot open pairing page: {error}");
                                }
                            }
                            None => log::warn!("mobile bridge started without a pairing URL"),
                        }
                        // 状态行必须在配对页打开**之前或之后都行**，但必须在 start
                        // 返回后：此时 port 才非空，否则状态行会停在 off。
                        refresh_bridge_status(&app, &snapshot);
                    }
                    Err(error) => {
                        log::error!("mobile bridge failed to start: {error}");
                        // 绑定失败（端口被占等）时窗口不会监听，状态行必须回到
                        // 真实状态，不能停留在上一次的 listening。
                        refresh_bridge_status(&app, &state.mobile.snapshot().await);
                    }
                }
            }
            "mobile-stop" => {
                state.mobile.stop().await;
                log::info!("mobile bridge stopped");
                refresh_bridge_status(&app, &state.mobile.snapshot().await);
            }
            // 打开更新页并立即触发一次手动检查：菜单项叫「Check for
            // Updates…」，用户的期望就是「点了就开始查」，而不是「点了给我
            // 一个还得再点一次的页面」。页面进入时自会拉取最新快照，
            // 因此这里不必关心检查是否已经跑完。
            "updates-check" => {
                crate::window::show_updates_page(&app);
                let manager = state.updates.lock().await.clone();
                if let Some(manager) = manager {
                    manager.check(true).await;
                } else {
                    log::warn!("updater is not available; update page opened without a check");
                }
            }
            "app-quit" => app.exit(0),
            // `mobile-status` 是 `enabled(false)` 的信息项，点击不会产生事件；
            // 其余未知 id 一并忽略。
            _ => {}
        }
    });
}
