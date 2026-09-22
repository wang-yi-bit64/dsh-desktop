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
mod feedback;
mod harness_ui;
mod layout;
mod logging;
mod menu;
mod mobile_bridge;
mod navigation;
mod safe_mode;
mod state;
mod tray;
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
    // 注册崩溃日志钩子，确保 Release .exe 在无控制台环境下也能捕获 panic 根因。
    // 双通道：stderr（开发态可见）+ crash.log（发布态唯一线索）。此处刻意不依赖
    // 日志插件——panic hook 可能在插件初始化完成之前就触发。
    std::panic::set_hook(Box::new(|panic_info| {
        let msg = format!("DSH Desktop Panic: {panic_info}\n");
        eprintln!("{msg}");
        if let Ok(mut log_path) = std::env::current_exe() {
            log_path.pop();
            log_path.push("crash.log");
            let _ = std::fs::write(log_path, msg);
        }
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 二次启动 → 把既有窗口带回来并聚焦，而不是再开一份。
            //
            // 自批次 0.2-B1 起窗口可能被藏进托盘，此时 `set_focus()` 完全无效
            // （不可见窗口拿不到焦点），必须走 `reveal_main_window` 的
            // show → unminimize → focus 三步。
            window::reveal_main_window(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // 只读资源 + 可写 userData 布局（INV-1 的唯一落点）。
            let layout = layout::resolve_layout(&handle)?;
            layout.ensure_dirs()?;

            // 壳层结构化日志：目录取自 layout.app_data_dir（INV-1），
            // 必须在布局解析之后注册（见 logging.rs 模块文档）。
            logging::init(&handle, &layout.app_data_dir)?;
            log::info!(
                "desktop shell starting: app_data_dir={} resource_dir={}",
                layout.app_data_dir.display(),
                layout.resource_dir.display()
            );

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

            // 配对状态变化 → 原生菜单状态行（镜像上游 `onConnectedChange`）。
            //
            // 上游把该状态广播进 Harness 网页（preload 注入侧栏浮动按钮），
            // 本仓没有 preload 通道（见 `AGENTS.md`），等价展示面是原生
            // `Phone` 子菜单首行的实时状态文本。
            //
            // 回调里**只派生任务**：`refresh_bridge_status` 需要一份异步快照，
            // 且内部经 `run_on_main_thread` 阻塞等待——两件事都不适合在触发
            // 线程（axum 的配对处理器）上同步做。
            {
                let listener_handle = handle.clone();
                mobile.on_connected_change(move |connected| {
                    let app = listener_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let Some(state) = app.try_state::<Arc<AppState>>() else {
                            return;
                        };
                        // 一个状态翻转要同时刷新**两个**用户可见面：原生菜单的状态
                        // 行，以及 Harness 侧边栏里的页内指示器。少刷一个就会出现
                        // 「菜单说已连接、页面说没连接」的自相矛盾。
                        harness_ui::push_phone_status(&app, connected);
                        let snapshot = state.mobile.snapshot().await;
                        menu::refresh_bridge_status(&app, &snapshot);
                    });
                });
            }

            // 菜单。
            let menu = menu::build_menu(&handle)?;
            handle.set_menu(menu)?;
            let menu_handle = handle.clone();
            handle.on_menu_event(move |_app, event| {
                menu::handle_menu_event(&menu_handle, event.id().as_ref());
            });

            // 系统托盘（批次 0.2-B1）：关窗不再退出应用，而是把窗口藏起来，
            // Harness 与 LAN 手机桥继续活着。创建失败**不阻断启动**——托盘是
            // 便利设施，缺了它窗口与 Harness 仍然可用（Linux 上缺
            // libappindicator 时就是这种情形）。
            if let Err(error) = tray::create(&handle) {
                log::error!("cannot create the system tray (continuing without it): {error}");
            } else {
                // 托盘状态行跟随 `harness://status`（窗口藏起来后它是唯一的外在
                // 指示）。订阅点放在这里而不是 `tray::create` 内部：创建失败时
                // 不该留下一个监听器。
                tray::listen_for_status(&handle);
            }

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
            // Harness 页的壳层 UI 注入（「preload 等价物」，见 `harness_ui`）。
            //
            // `initialization_script` 在**每一次顶层文档导航**之前执行，因此页面
            // 刷新、导航到 Harness、Harness 自身跳转后脚本都还在。脚本头部按
            // origin 自我早退，本地页（splash / error / updates）不受影响。
            .initialization_script(harness_ui::INJECT_SCRIPT)
            // 推送的另一半：`eval` 只作用于**当前文档**，页面一导航上一次推的状态
            // 就没了，因此每次加载完成补推一次当前桥状态（见 `harness_ui` 模块文档）。
            .on_page_load({
                let page_handle = handle.clone();
                move |_window, payload| {
                    if payload.event() != tauri::webview::PageLoadEvent::Finished {
                        return;
                    }
                    let app = page_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let Some(state) = app.try_state::<Arc<AppState>>() else {
                            return;
                        };
                        let snapshot = state.mobile.snapshot().await;
                        harness_ui::push_phone_status(&app, snapshot.connected);
                    });
                }
            })
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
            //
            // # 为什么这里要读一个标记文件（2026-09-22）
            //
            // 此前这一行恒为 `start()`=`start_with_profile(None)`，即默认 `web`
            // profile + 普通 patch。安全模式的选择只活在 `Launcher` 的 builder
            // 参数里，随进程一起消失——于是「关掉应用再打开」必然退回普通模式、
            // 全量加载第三方插件。用户点了 4 次安全模式，每次整机重启都被静默
            // 撤销（证据：`desktop.log` 里 `restarting in safe mode` 与
            // `desktop shell starting` 交替出现）。
            //
            // 现在按 `<dsh_home>/.safe-mode` 是否存在决定走哪条路径。这个标记由
            // 进入安全模式的各个入口写入（菜单项 / 恢复页 / 错误页），由
            // 「Restart in Normal Mode」清除。
            //
            // **标记缺失或不可读 → 普通模式**：安全模式是恢复路径，不能因为
            // 一个标记文件读不动就让应用起不来。这个取向与 `safe_mode_requested`
            // 的「只看存在性」是同一件事的两面。
            let start_supervisor = Arc::clone(&supervisor);
            let start_layout = layout.clone();
            tauri::async_runtime::spawn(async move {
                if dsh_host::safe_mode::safe_mode_requested(&start_layout.dsh_home) {
                    log::info!(
                        "safe-mode marker present at {} — starting Harness with profile '{}'",
                        dsh_host::safe_mode::safe_mode_marker_path(&start_layout.dsh_home)
                            .display(),
                        dsh_host::safe_mode::SAFE_MODE_PROFILE
                    );
                    start_supervisor.start_in_safe_mode().await;
                } else {
                    start_supervisor.start().await;
                }
            });

            Ok(())
        })
        .on_window_event(|webview_window, event| {
            // 关窗 → **隐藏到托盘**，不退出（批次 0.2-B1）。
            //
            // 这是本批次的语义核心：关掉窗口不再等于「结束会话」。Harness 子进程
            // 与 LAN 手机桥都继续运行——手机桥正是「人在别处、机器在跑」这个场景
            // 的唯一价值所在，把它随窗口一起收掉会让托盘失去意义。
            //
            // 退出改由显式动作触发：托盘菜单 / 应用菜单的「Quit DSH Desktop」
            // （`app.exit(0)`）与错误页的「Quit」按钮。`app.exit()` 走的是
            // `RunEvent::ExitRequested` 而**不是** `CloseRequested`，因此下面这
            // 段拦截不会挡住真正的退出——这正是它安全的原因。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if webview_window.label() == window::MAIN_WINDOW {
                    // 托盘创建失败时**不能**隐藏：那会让应用变成一个既没有窗口、
                    // 也没有托盘入口的进程，用户只能去任务管理器结束它。
                    // `tray_by_id` 是「托盘真的存在」的唯一权威判据。
                    if webview_window
                        .app_handle()
                        .tray_by_id(tray::TRAY_ID)
                        .is_some()
                    {
                        api.prevent_close();
                        if let Err(error) = webview_window.hide() {
                            log::warn!("cannot hide the main window to the tray: {error}");
                        } else {
                            log::info!("main window hidden to the tray; Harness keeps running");
                        }
                    } else {
                        // 无托盘 → 维持旧语义（关窗即退出），并且照常停子进程。
                        log::warn!("no tray icon available; closing the window quits DSH Desktop");
                        spawn_shutdown(webview_window.app_handle());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::harness_status,
            commands::harness_restart,
            commands::harness_logs_tail,
            commands::logs_read,
            commands::open_logs,
            commands::app_quit,
            commands::recovery_status,
            commands::recovery_open,
            commands::recovery_action,
            commands::safe_mode_action,
            commands::harness_open,
            commands::diagnostics_export,
            commands::updates_status,
            commands::updates_check,
            commands::updates_download,
            commands::updates_install,
            commands::updates_skip,
            commands::portable_mode,
            commands::feedback_context,
            commands::feedback_open,
            commands::feedback_channel_open
        ])
        .run(tauri::generate_context!())
        .expect("error while running DSH Desktop");
}

/// 优雅停机：先停 LAN 手机桥，再停 Harness 子进程。
///
/// # 为什么需要它（自批次 0.2-B1 起）
///
/// 在此之前唯一的停机点是关窗。托盘把关窗改成「隐藏」之后，退出改走
/// `app.exit(0)`——那**不会**经过 `CloseRequested`，于是子进程只能靠
/// JobObject / PDEATHSIG 被**强杀**：Harness 来不及收尾（落盘、插件卸载钩子、
/// 会话状态写回），`harness.log` 的尾部也可能丢。
///
/// 因此所有主动退出路径（托盘 / 菜单 / 错误页的 Quit）都先 await 这个函数再
/// `exit`。最坏情况延迟由 `dsh_host` 的停止语义给出上限（SIGTERM → 4s →
/// SIGKILL），不会挂住界面。
///
/// ⚠️ 它**不是**退出路径的唯一保险：`app.exit()` 之外还有系统关机、任务管理器
/// 结束进程等我们收不到通知的路径，那条底线仍由 INV-3 的内核级守护兜着。
///
/// 泛型化是为了让 `menu.rs` / `commands.rs` 的调用方不必各自实例化到具体
/// runtime——它们都还是泛型上下文。
pub(crate) async fn shutdown<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    state.mobile.stop().await;
    state.supervisor.stop().await;
    log::info!("harness and mobile bridge stopped");
}

/// 异步触发停机（供无法 await 的回调使用）。
///
/// # 为什么是异步触发
///
/// 主 UI 线程上 `block_on` 会让操作系统判定窗口「未响应」。
fn spawn_shutdown<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        shutdown(&handle).await;
    });
}
