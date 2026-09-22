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
//! # 托盘复用了这个模块的 id 与分发（2026-09-18 批次 0.2-B1）
//!
//! 系统托盘（[`crate::tray`]）有自己的菜单对象，但**菜单项 id 与事件处理是共用**的：
//! id 提成了下文那批 `pub const MENU_ID_*`，两个菜单都引用它们，事件都汇进
//! [`handle_menu_event`]。这样「托盘里的重启」与「菜单栏里的重启」不可能行为不同
//! ——它们本来就是同一行代码。`npm run verify:ipc-surface` 的 E7 守着这条对应关系。
//!
//! # 句柄定位：两条曾经写错的前提（勿再照抄）
//!
//! 本模块原先写着「`muda::MenuItem` 是 `Rc`，既非 `Send` 也非 `Sync`，无法放进 Tauri
//! 托管状态；因此改为经 `AppHandle::menu()` 逐层定位句柄」。**前一句对 `muda` 成立的
//! 说法并不能推出后一句**，托盘批次实测推翻了它：
//!
//! 1. **Tauri 的包装类型可以托管**：`tauri::menu::MenuItem<R>` 是 `Arc<MenuItemInner<R>>`，
//!    而 `MenuItemInner` 由 `gen_wrappers!` 宏带着 `unsafe impl Send/Sync` 生成（每次访问
//!    都经 `run_on_main_thread` 派发，句柄本身只是「远程控制句柄」）。
//! 2. **托盘上「重新定位句柄」根本走不通**：`TrayIcon` 只有 `set_menu`，**没有
//!    `menu()` 读取器**。托盘的 Harness 状态行与手机桥状态行因此托管为
//!    [`crate::tray::TrayHandles`]。
//!
//! 另外 `Menu::get` / `Submenu::get` **只查直接子项、且不跨菜单**：应用菜单的 `Phone`
//! 子菜单与托盘里的同名项是两份独立对象，所以 [`refresh_bridge_status`] 必须**同刷两处**
//! （否则会出现「菜单说已连接、托盘说未启动」）。
//!
//! 这些 API 内部都经 `run_on_main_thread` 派发，工作线程调用时**阻塞等待**结果；
//! 从主线程调用时 Tauri 侧会内联执行（`send_user_message` 的 `current_thread().id()`
//! 短路），不会自锁。我们的调用点都在 `tauri::async_runtime::spawn` 出的任务里。

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

// ---------------------------------------------------------------------------
// 菜单项 id（**唯一产地**）
// ---------------------------------------------------------------------------
//
// 这些 id 有两个消费面：应用菜单（本模块）与**系统托盘菜单**（`crate::tray`）。
// 托盘刻意复用同一批 id，这样「重启 Harness」「导出诊断包」在菜单栏与托盘里
// 走的是**同一段实现**（[`handle_menu_event`]），不会出现「托盘里的重启忘了
// 走安全模式 profile 落盘」这类双实现漂移。
//
// 因此它们是常量而不是字面量：两处各写一遍字符串时，改一处忘另一处**不会**
// 有任何编译错误或告警，只会让托盘上那个菜单项静默失效。

/// 重启 Harness。
pub const MENU_ID_HARNESS_RESTART: &str = "harness-restart";
/// 以安全模式重启 Harness（隔离第三方插件）。
pub const MENU_ID_HARNESS_SAFE_MODE: &str = "harness-safe-mode";
/// 以**普通模式**重启 Harness，并清除安全模式标记。
pub const MENU_ID_HARNESS_NORMAL_MODE: &str = "harness-normal-mode";
/// 打开应用内日志页。
pub const MENU_ID_HARNESS_VIEW_LOG: &str = "harness-view-log";
/// 在文件管理器中打开日志目录（次入口）。
pub const MENU_ID_HARNESS_REVEAL_LOGS: &str = "harness-reveal-logs";
/// 导出脱敏诊断包。
pub const MENU_ID_HARNESS_EXPORT_DIAGNOSTICS: &str = "harness-export-diagnostics";
/// 启动 LAN 手机桥并打开配对页。
pub const MENU_ID_MOBILE_PAIR: &str = "mobile-pair";
/// 停止手机桥。
pub const MENU_ID_MOBILE_STOP: &str = "mobile-stop";
/// 打开更新页并立即检查更新。
pub const MENU_ID_UPDATES_CHECK: &str = "updates-check";
/// 打开应用内反馈页（问题反馈 / 功能建议入口，批次 0.2-D2）。
pub const MENU_ID_FEEDBACK_OPEN: &str = "feedback-open";
/// 退出应用。
pub const MENU_ID_APP_QUIT: &str = "app-quit";

/// 构建应用菜单。
pub fn build_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let restart =
        MenuItemBuilder::with_id(MENU_ID_HARNESS_RESTART, "Restart Harness").build(app)?;
    let safe_mode =
        MenuItemBuilder::with_id(MENU_ID_HARNESS_SAFE_MODE, "Restart in Safe Mode").build(app)?;
    // 安全模式现在是**持久化**的（`<dsh_home>/.safe-mode`），因此必须有一个
    // 对称的出口。否则用户进了安全模式就出不来了——下一次启动还会读见标记、
    // 再进一次，看起来像「卡在恢复模式」。
    //
    // 与「Restart Harness」的区别只在**语义与附带动作**：那条是无条件普通启动，
    // 但**不清标记**，因此重启后仍会回到安全模式；这条清标记后再普通启动。
    // 两条都留着是有意的：前者用于「想让 Harness 重来一次、但仍在安全模式下」。
    let normal_mode =
        MenuItemBuilder::with_id(MENU_ID_HARNESS_NORMAL_MODE, "Restart in Normal Mode")
            .build(app)?;
    // 「View Harness Log」打开**应用内日志页**（批次 D3/D10）。此前它只调
    // `opener` 打开系统文件管理器——在「应用起不来 / 界面卡住」时那条路径
    // 恰好最没用：用户要的是能看到日志，而不是被丢进一个文件夹自己找。
    let view_log = MenuItemBuilder::with_id(MENU_ID_HARNESS_VIEW_LOG, "View Logs…").build(app)?;
    let export_diagnostics =
        MenuItemBuilder::with_id(MENU_ID_HARNESS_EXPORT_DIAGNOSTICS, "Export Diagnostics…")
            .build(app)?;
    // 保留「在文件管理器中打开」为**次**入口（仍有用途：用户要把整个目录
    // 拷走，或日志页本身打不开时）。
    let reveal_logs =
        MenuItemBuilder::with_id(MENU_ID_HARNESS_REVEAL_LOGS, "Reveal Log Folder").build(app)?;
    // LAN 手机桥是显式动作：菜单点击才监听，避免每次启动都在局域网暴露端口。
    let mobile_pair =
        MenuItemBuilder::with_id(MENU_ID_MOBILE_PAIR, "Phone Pairing (LAN)…").build(app)?;
    let mobile_stop =
        MenuItemBuilder::with_id(MENU_ID_MOBILE_STOP, "Stop Phone Bridge").build(app)?;
    // 状态行：初始即「未启动」（桥从不自动监听，见 mobile_bridge 模块文档），
    // 无需异步查询，因此 setup 阶段可以同步建好。
    let mobile_status = MenuItemBuilder::with_id(
        MOBILE_STATUS_ID,
        mobile_bridge::status_label(&MobileBridgeSnapshot::default(), None),
    )
    .enabled(false)
    .build(app)?;
    let check_updates =
        MenuItemBuilder::with_id(MENU_ID_UPDATES_CHECK, "Check for Updates…").build(app)?;
    // 反馈入口（批次 0.2-D2）：打开**应用内反馈页**而不是直接把用户丢到浏览器。
    // 页面里先给出「报告要附的版本/通道信息」与一键导出诊断包，再给三个外链出口
    // ——把本仓「脱敏诊断包 + 隐私姿态」的工作流前移一步，用户不需要先读完
    // issue 模板才知道该带什么。
    let feedback = MenuItemBuilder::with_id(MENU_ID_FEEDBACK_OPEN, "Send Feedback…").build(app)?;
    let quit = MenuItemBuilder::with_id(MENU_ID_APP_QUIT, "Quit DSH Desktop").build(app)?;

    let harness_submenu = SubmenuBuilder::new(app, "Harness")
        .item(&restart)
        .item(&safe_mode)
        .item(&normal_mode)
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
        .item(&feedback)
        .separator()
        .item(&quit)
        .build()?;

    MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&harness_submenu)
        .item(&mobile_submenu)
        .build()
}

/// 刷新**两处**手机桥状态文案：应用菜单的 `Phone` 子菜单，以及托盘菜单里的同名项。
///
/// 幂等；任一环节查不到（菜单未设置、托盘未创建、平台未支持）时跳过那一处——
/// 状态行是**辅助信息**，不该因为刷新失败而中断配对/停止流程。
///
/// # 为什么是两处
///
/// 自批次 0.2-B1 起托盘有自己的 `Phone` 子菜单（窗口藏起来时用户只能看那一份）。
/// 两份菜单是**各自独立的 `Menu` 对象**，`Menu::get` 只查直接子项、更不会跨菜单，
/// 因此刷一处不会顺带刷另一处。只刷应用菜单的话，会出现「菜单说已连接、托盘说
/// 未启动」这种同一份状态的两种说法——而用户最可能看的正是托盘那一份。
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
    refresh_mobile_status_in_app_menu(app, &label);
    crate::tray::refresh_mobile_status(app, &label);
}

/// 刷新应用菜单 `Phone` 子菜单里的状态行。
fn refresh_mobile_status_in_app_menu<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) {
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
    if let Err(error) = item.set_text(label) {
        log::warn!("cannot update phone bridge menu label: {error}");
    }
}

/// 菜单事件分发。
///
/// # 两个来源，一段实现
///
/// 应用菜单与**系统托盘菜单**（[`crate::tray`]）的事件都汇到这里：托盘菜单项
/// 刻意复用同一批 id（见上文 id 常量块）。因此「托盘里的导出诊断包」与「菜单栏
/// 里的导出诊断包」不可能出现行为差异——它们本来就是同一行代码。
///
/// 唯一的托盘专属 id 是 [`crate::tray::TRAY_SHOW_ID`]（唤回主窗口），因为
/// 「显示窗口」这件事只在窗口被藏起来时才有意义。
pub fn handle_menu_event<R: Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        // `tray-show` 不依赖应用状态：窗口可能在任何相位被藏起来，用户点它就是
        // 想看见窗口。放在 state 早退之前，避免「状态未就绪时托盘点击无反应」。
        if id == crate::tray::TRAY_SHOW_ID {
            crate::window::reveal_main_window(&app);
            return;
        }
        let Some(state) = app.try_state::<std::sync::Arc<AppState>>() else {
            return;
        };
        match id.as_str() {
            MENU_ID_HARNESS_RESTART => {
                crate::window::show_splash(&app);
                state.supervisor.restart().await;
            }
            MENU_ID_HARNESS_SAFE_MODE => {
                // 顺序不能反：profile 目录先落盘，再以该 profile 启动。
                // `restart_in_safe_mode` 会传 `--profile desktop-safe-mode`
                // 并把 `--patch` 换成 dsh-desktop-safe.patch.yml（C10）。
                if let Err(error) =
                    crate::safe_mode::ensure_safe_mode_profile(&state.layout.dsh_home)
                {
                    log::error!("cannot materialise the safe-mode profile: {error}");
                    return;
                }
                // 持久化选择：`restart_in_safe_mode()` 只影响**本次**派生的子进程，
                // 它不写任何跨进程状态。因此不落这个标记的话，下次冷启动
                // （`lib.rs` 的启动分支）读不到任何「用户要安全模式」的证据，
                // 又回默认 profile——表现就是「点了安全模式，重启后还是坏的」。
                // 标记的判据与读写实现见 `dsh_host::safe_mode`。
                if let Err(error) =
                    dsh_host::safe_mode::persist_safe_mode_request(&state.layout.dsh_home)
                {
                    // 落盘失败**不中断**：本次安全模式启动仍然有效（子进程已经
                    // 带上了 `--profile desktop-safe-mode`），只是不跨重启。
                    // 恢复路径宁可多给一次机会，也不该因为写标注文件失败就把
                    // 用户挡在恢复流程之外。
                    log::error!(
                        "cannot persist safe-mode request; this restart is safe-mode but the next cold start will not be: {error}"
                    );
                }
                crate::window::show_splash(&app);
                state.supervisor.restart_in_safe_mode().await;
                log::info!(
                    "harness restarting in safe mode (request persisted for next cold start)"
                );
            }
            MENU_ID_HARNESS_NORMAL_MODE => {
                // 安全模式标记的**唯一出口**。少了它，进安全模式就是单向的：
                // 标记留着 → 每次冷启动都再进一次 → 看起来像「卡在恢复模式」。
                //
                // 清除是**幂等**的（本来就没有标记时返回 `Ok(false)`），因为
                // 「已经在普通模式、再点一次普通模式」是完全正常的用法。
                match dsh_host::safe_mode::clear_safe_mode_request(&state.layout.dsh_home) {
                    Ok(removed) => {
                        if removed {
                            log::info!(
                                "safe-mode request cleared; next start uses the default profile"
                            );
                        } else {
                            log::info!("no safe-mode request to clear; already in normal mode");
                        }
                    }
                    // 清不掉就**停手**，不要把用户导向「以为出来了、其实没有」：
                    // 标记仍在，下一次冷启动还会进安全模式。这条必须让用户看见。
                    Err(error) => {
                        log::error!(
                            "cannot clear the safe-mode request; the next cold start will still use safe mode: {error}"
                        );
                        return;
                    }
                }
                crate::window::show_splash(&app);
                state.supervisor.restart().await;
                log::info!("harness restarting in normal mode");
            }
            MENU_ID_HARNESS_VIEW_LOG => {
                // 应用内日志页：能选来源、刷新、导出诊断包，并且**在应用起不来
                // 时也打不开**——那种情况下的入口是错误页的「查看日志」与
                // 「导出诊断包」按钮。
                crate::window::show_logs_page(&app);
            }
            // 「在文件管理器中打开」：次入口，保留给「要把整个目录拷走」以及
            // 「日志页本身加载不出来」两种场景。
            MENU_ID_HARNESS_REVEAL_LOGS => {
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
            MENU_ID_HARNESS_EXPORT_DIAGNOSTICS => {
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
            MENU_ID_MOBILE_PAIR => {
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
            MENU_ID_MOBILE_STOP => {
                state.mobile.stop().await;
                log::info!("mobile bridge stopped");
                refresh_bridge_status(&app, &state.mobile.snapshot().await);
            }
            // 打开更新页并立即触发一次手动检查：菜单项叫「Check for
            // Updates…」，用户的期望就是「点了就开始查」，而不是「点了给我
            // 一个还得再点一次的页面」。页面进入时自会拉取最新快照，
            // 因此这里不必关心检查是否已经跑完。
            MENU_ID_UPDATES_CHECK => {
                crate::window::show_updates_page(&app);
                let manager = state.updates.lock().await.clone();
                if let Some(manager) = manager {
                    manager.check(true).await;
                } else {
                    log::warn!("updater is not available; update page opened without a check");
                }
            }
            // 反馈入口（批次 0.2-D2）：打开应用内反馈页，而不是把用户直接丢给
            // 浏览器。理由见 `menu.rs` 建菜单处的注释与 `frontend/feedback.html`
            // 的文件头：报告「该带什么」（版本 / 通道 / 诊断包）由壳自己答，
            // 用户不该先读完 issue 模板才知道。
            MENU_ID_FEEDBACK_OPEN => {
                crate::window::show_feedback_page(&app);
            }
            MENU_ID_APP_QUIT => {
                // 先优雅停机再退出：`app.exit(0)` 不经过 `CloseRequested`，
                // 若直接调用，Harness 只能被 JobObject 强杀（见 `lib.rs::shutdown`）。
                crate::shutdown(&app).await;
                app.exit(0);
            }
            // `mobile-status` 是 `enabled(false)` 的信息项，点击不会产生事件；
            // 其余未知 id 一并忽略。
            _ => {}
        }
    });
}
