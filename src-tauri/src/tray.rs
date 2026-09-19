//! 系统托盘（批次 0.2-B1）。
//!
//! # 为什么需要它
//!
//! 在此之前关掉窗口就是退出应用：Harness 子进程被收走、**LAN 手机桥一并失效**，
//! 而手机桥正是「人在沙发上、Harness 在桌面上跑」这个场景的唯一价值所在。托盘把
//! 「窗口」与「应用」拆成两件事——关窗只是收起界面，Harness 与桥继续活着。
//!
//! # 设计口径
//!
//! | 决策 | 取值 | 理由 |
//! |------|------|------|
//! | 关窗行为 | **隐藏到托盘**（不退出） | 与手机桥 / 长任务配合才成立；退出走托盘「Quit」或应用菜单，语义显式 |
//! | 左键单击（Windows） | 唤回 / 隐藏主窗口 | 托盘最常见的期待；菜单改由右键弹出 |
//! | 菜单内容 | **复用应用菜单的项与 id** | 见 [`crate::menu`] 的 id 常量块：两处各写一遍字符串必然漂移 |
//! | Quit | 先 [`crate::shutdown`] 再 `exit` | 否则 Harness 只能被强杀，见 `lib.rs::shutdown` |
//!
//! # 平台差异（都在代码里显式处理，不做假设）
//!
//! * **Linux 没有托盘点击事件**：`tray_icon` 的 gtk 后端不派发 `TrayIconEvent`
//!   （tauri 文档标注「Linux: Unsupported」）。因此 Linux 上「唤回窗口」只能靠
//!   **菜单**——[`TRAY_SHOW_ID`] 那一项。若照 Windows 那样关掉「左键出菜单」，
//!   Linux 用户会得到一个**点了没反应**的托盘图标。
//! * **macOS 菜单栏图标原生的交互就是「点击即菜单」**，用户不期待单击隐藏窗口，
//!   因此同样保留默认；并且需要**单色模板图**（`icon_as_template`）——彩色方块在
//!   深色菜单栏里会糊成一团。
//! * 两份图标资产由 [`scripts/generate-tray-icons.mjs`] 从品牌源图派生，各自约 1 KB。
//!
//! # 为什么状态行要存句柄（而不是每次重新 `menu.get`）
//!
//! `TrayIcon` **没有** `menu()` 读取器（只有 `set_menu`），所以「取回托盘菜单再按
//! id 定位状态项」这条路走不通。可行的替代是把菜单句柄留在托管状态里，而这里有个
//! 值得写下来的事实：
//!
//! `menu.rs` 的模块文档说「`muda::MenuItem` 是 `Rc`，非 `Send`/`Sync`，不能放进托管
//! 状态」——那句话对 **`muda` 自己的类型**成立，但对 **Tauri 的包装类型不成立**：
//! `tauri::menu::MenuItem<R>` 是 `Arc<MenuItemInner<R>>`，而 `MenuItemInner` 带
//! `unsafe impl Send/Sync`，每次访问都经 `run_on_main_thread` 派发（句柄本身只是
//! 一个「远程控制句柄」）。因此 [`TrayHandles`] 可以安全地托管。

use std::sync::Arc;

use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, Wry};

use crate::menu::{
    MENU_ID_APP_QUIT, MENU_ID_FEEDBACK_OPEN, MENU_ID_HARNESS_EXPORT_DIAGNOSTICS,
    MENU_ID_HARNESS_RESTART, MENU_ID_HARNESS_SAFE_MODE, MENU_ID_HARNESS_VIEW_LOG,
    MENU_ID_MOBILE_PAIR, MENU_ID_MOBILE_STOP, MENU_ID_UPDATES_CHECK, MOBILE_STATUS_ID,
    PHONE_SUBMENU_ID,
};
use crate::state::{AppState, HarnessPhase, STATUS_EVENT};
use crate::window;

/// 托盘图标 id（`tray_by_id` / `TrayIconEvent::id()` 用它定位）。
pub const TRAY_ID: &str = "main-tray";

/// 托盘菜单里「显示主窗口」的 id。
///
/// **托盘专属**（也是 Linux 上唤回窗口的唯一路径）：应用菜单里没有对应项——
/// 窗口已经在眼前时它没有意义。
pub const TRAY_SHOW_ID: &str = "tray-show";

/// 托盘菜单里 Harness 状态信息行的 id（禁用项，只展示）。
pub const TRAY_STATUS_ID: &str = "tray-harness-status";

/// Windows / Linux 托盘图标（32×32 圆角方块）。
#[cfg(not(target_os = "macos"))]
const TRAY_ICON: tauri::image::Image<'static> = tauri::include_image!("icons/tray-32.png");

/// macOS 菜单栏图标（单色模板，见模块文档）。
///
/// 与 [`TRAY_ICON`] 一样按平台 `cfg` 收窄：不是所有平台都要的常量若不加门，
/// 在另一个平台上就是 `dead_code`——而 CI 是 `-D warnings`，那等于构建失败。
#[cfg(target_os = "macos")]
const TRAY_ICON_TEMPLATE: tauri::image::Image<'static> =
    tauri::include_image!("icons/tray-template.png");

/// 托管在应用状态里的托盘句柄（理由见模块文档）。
pub struct TrayHandles {
    /// Harness 状态行（禁用项）。
    status: MenuItem<Wry>,
    /// 手机桥状态行（禁用项）。与应用菜单的 `Phone` 子菜单**各有一份**：
    /// `Menu::get` 只查直接子项，两份菜单互不可见，因此必须分别持有句柄。
    /// 刷新点统一在 [`crate::menu::refresh_bridge_status`]（它同时刷两处，
    /// 避免出现「菜单说已连接、托盘说没连接」的自相矛盾）。
    mobile_status: MenuItem<Wry>,
}

/// 创建系统托盘，并把状态行句柄托管进应用状态。
///
/// 在 `setup` 中调用一次；重复创建会得到两个图标（平台允许，用户会看见两个）。
///
/// # 失败
///
/// 返回 `tauri::Result`，并且**承诺不 panic 出本函数**（Linux 上的成因见下）：
/// 托盘创建失败**不应**中断应用启动——窗口与 Harness 仍然可用。调用方只记日志，
/// 关窗行为会自动退回「关窗即退出」（见 `lib.rs` 的窗口事件处理）。
///
/// ## Linux：`libappindicator` 缺失时**底层会 panic**，必须先探测
///
/// `libappindicator-sys` 把库句柄放在 `Lazy<Library>` 里，两个候选名字
/// （`libayatana-appindicator3.so.1` / `libappindicator3.so.1`）都加载不到时
/// **直接 `panic!`**——而它的 `backcompat` 特性（认无 `.1` 后缀的名字）默认关闭，
/// 所以只探测这两个名字才是准的。
///
/// 这个 panic 发生在 `builder.build()` 内部，会一路穿出 `setup` 把应用**整个**
/// 带崩。对一个「没有托盘就少个便利设施」的功能来说，这是不可接受的代价
/// （改动前那种机器上应用是能正常启动的，等于我们引入了一个启动期回归）。
/// 因此这里先用 `dlopen` 探测同样的两个名字：探不到就直接返回错误，
/// **根本不进入**会 panic 的调用路径。
///
/// [`create`] 外层另有 `catch_unwind` 兜住其它未知 panic——托盘后端的 panic 点
/// 不止一处（临时图标文件写失败也会 `unwrap`），探测只能覆盖已知的那一个。
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "linux")]
    if !appindicator_available() {
        return Err(tauri::Error::AssetNotFound(
            "libayatana-appindicator3.so.1 / libappindicator3.so.1 (system tray backend)".into(),
        ));
    }

    // 托盘后端里有若干 `unwrap` / `panic!`（临时文件、符号解析），单靠上面的
    // 探测盖不全。这里兜住任何逃出来的 panic，把它降级成一次「创建失败」——
    // 明确优于让整个应用起不来。
    //
    // ⚠️ 副作用：全局 panic hook（`lib.rs`）会**照常**往 exe 目录写一行
    // `crash.log`。也就是说 Linux 上后端 panic 时，crash.log 里会出现一条
    // 「DSH Desktop Panic」，而应用仍在运行。这是有意保留的：那确实是一次
    // panic，掩盖它会让排障失去唯一线索；`desktop.log` 里紧跟着的那条
    // 「cannot create the system tray」就是解释它的上下文。
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| create_inner(app)));

    match result {
        Ok(Ok(())) => {
            log::info!("system tray created (id={TRAY_ID})");
            Ok(())
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err(tauri::Error::AssetNotFound(
            "the tray backend panicked while creating the icon".into(),
        )),
    }
}

/// 探测 Linux 托盘后端依赖的共享库是否可加载。
///
/// 名字与 `libappindicator-sys` 的 `Lazy<Library>` 初始化**逐字一致**（含 `.so.1`
/// 后缀、按顺序）——探到一个不同的名字只会给出乐观结论，然后把我们送回 panic
/// 那条路，那就白探了。
#[cfg(target_os = "linux")]
fn appindicator_available() -> bool {
    use std::ffi::CString;

    for name in ["libayatana-appindicator3.so.1", "libappindicator3.so.1"] {
        let Ok(name) = CString::new(name) else {
            continue;
        };
        // SAFETY: `dlopen` 只读一个以 NUL 结尾的 C 字符串；返回的句柄在同一个
        // 函数里立刻 `dlclose`，不跨线程、不逃逸。
        let handle = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_LAZY) };
        if !handle.is_null() {
            unsafe { libc::dlclose(handle) };
            return true;
        }
    }
    false
}

/// 真正的创建流程（被 [`create`] 的 `catch_unwind` 包住）。
fn create_inner(app: &AppHandle) -> tauri::Result<()> {
    let (menu, status, mobile_status) = build_tray_menu(app)?;

    let mut builder = TrayIconBuilder::<Wry>::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("DSH Desktop")
        // 菜单事件走**与应用菜单同一条**分发路径（`crate::menu::handle_menu_event`），
        // 因此托盘菜单的每一项与同名应用菜单项行为逐字一致。
        .on_menu_event(|app, event| {
            crate::menu::handle_menu_event(app, event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            // 只认「左键抬起」：按下事件会与随之而来的菜单/拖拽重复触发，
            // 抬起才是用户意图明确的那一刻。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });

    // 平台分支（理由见模块文档的「平台差异」）：
    // Windows 把左键留给「切换窗口显隐」，菜单走右键；Linux / macOS 保留默认。
    #[cfg(windows)]
    {
        builder = builder.show_menu_on_left_click(false);
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder.icon(TRAY_ICON_TEMPLATE).icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.icon(TRAY_ICON);
    }

    builder.build(app)?;
    app.manage(TrayHandles {
        status,
        mobile_status,
    });
    Ok(())
}

/// 组装托盘菜单，返回（菜单，Harness 状态行句柄，手机桥状态行句柄）。
///
/// 与应用菜单的差异都是**有意的**：
///
/// 1. 首项是 Harness 状态行——窗口藏起来之后，这是唯一能看见进度的落点；
/// 2. 有「Show Window」（[`TRAY_SHOW_ID`]）——窗口藏起来之后才需要它，而且在
///    Linux 上它是**唯一**的唤回入口（那里没有点击事件）；
/// 3. `Phone` 子菜单保留（配对 / 停桥要在窗口藏起来时也能用）。
pub fn build_tray_menu(
    app: &AppHandle,
) -> tauri::Result<(tauri::menu::Menu<Wry>, MenuItem<Wry>, MenuItem<Wry>)> {
    let show = MenuItemBuilder::with_id(TRAY_SHOW_ID, "Show Window").build(app)?;
    let status = MenuItemBuilder::with_id(TRAY_STATUS_ID, status_label_for(&HarnessPhase::Idle))
        .enabled(false)
        .build(app)?;

    let restart =
        MenuItemBuilder::with_id(MENU_ID_HARNESS_RESTART, "Restart Harness").build(app)?;
    let safe_mode =
        MenuItemBuilder::with_id(MENU_ID_HARNESS_SAFE_MODE, "Restart in Safe Mode").build(app)?;
    let view_log = MenuItemBuilder::with_id(MENU_ID_HARNESS_VIEW_LOG, "View Logs…").build(app)?;
    let export_diagnostics =
        MenuItemBuilder::with_id(MENU_ID_HARNESS_EXPORT_DIAGNOSTICS, "Export Diagnostics…")
            .build(app)?;
    let check_updates =
        MenuItemBuilder::with_id(MENU_ID_UPDATES_CHECK, "Check for Updates…").build(app)?;
    let feedback = MenuItemBuilder::with_id(MENU_ID_FEEDBACK_OPEN, "Send Feedback…").build(app)?;
    let mobile_pair =
        MenuItemBuilder::with_id(MENU_ID_MOBILE_PAIR, "Phone Pairing (LAN)…").build(app)?;
    let mobile_stop =
        MenuItemBuilder::with_id(MENU_ID_MOBILE_STOP, "Stop Phone Bridge").build(app)?;
    // 手机桥状态行与应用菜单的 `Phone` 子菜单用**同一个 id**（[`MOBILE_STATUS_ID`]），
    // 但这是**另一份菜单对象**：`Menu::get` 不跨菜单，所以句柄要单独持有并在
    // [`refresh_mobile_status`] 里与应用菜单那处一起刷新。
    let mobile_status = MenuItemBuilder::with_id(
        MOBILE_STATUS_ID,
        crate::mobile_bridge::status_label(
            &crate::mobile_bridge::MobileBridgeSnapshot::default(),
            None,
        ),
    )
    .enabled(false)
    .build(app)?;

    let phone_submenu = SubmenuBuilder::with_id(app, PHONE_SUBMENU_ID, "Phone")
        .item(&mobile_status)
        .separator()
        .item(&mobile_pair)
        .item(&mobile_stop)
        .build()?;

    let quit = MenuItemBuilder::with_id(MENU_ID_APP_QUIT, "Quit DSH Desktop").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&status)
        .separator()
        .item(&show)
        .separator()
        .item(&restart)
        .item(&safe_mode)
        .separator()
        .item(&view_log)
        .item(&export_diagnostics)
        .separator()
        .item(&check_updates)
        .item(&feedback)
        .separator()
        .item(&phone_submenu)
        .separator()
        .item(&quit)
        .build()?;

    Ok((menu, status, mobile_status))
}

/// 把 Harness 相位渲染成托盘状态行文案。
///
/// 纯函数，便于无 GUI 单测（见文件末尾 `tests`）。
///
/// # 为什么只有托盘有状态行
///
/// 应用菜单的 Harness 子菜单**没有**对应项：用户看得见窗口里的界面，状态由界面
/// 本身表达。托盘相反——窗口藏起来时托盘图标是唯一的外在指示，因此它必须自述相位。
/// 两者用的是 `harness://status` 的同一个快照（见 [`listen_for_status`]），不会各有
/// 各的说法。
pub fn status_label_for(phase: &HarnessPhase) -> String {
    match phase {
        HarnessPhase::Idle => "Harness: not running".to_string(),
        HarnessPhase::Preparing => "Harness: preparing…".to_string(),
        HarnessPhase::Starting => "Harness: starting…".to_string(),
        HarnessPhase::ReadyChecking => "Harness: probing…".to_string(),
        HarnessPhase::Ready { .. } => "Harness: ready".to_string(),
        HarnessPhase::Failed { plugin_fault, .. } if *plugin_fault => {
            "Harness: failed (plugin fault)".to_string()
        }
        HarnessPhase::Failed { .. } => "Harness: failed".to_string(),
        HarnessPhase::Stopping => "Harness: stopping…".to_string(),
        HarnessPhase::Stopped => "Harness: stopped".to_string(),
    }
}

/// 刷新托盘状态行。
///
/// 幂等；查不到句柄时静默返回——状态行是**辅助信息**，不该因为刷新失败而中断任何
/// 真实动作（与 [`crate::menu::refresh_bridge_status`] 同一纪律）。
///
/// # 为什么区分「没有托盘」与「托盘在但句柄丢了」
///
/// 两者都表现为「状态行不更新」，但只有后者是缺陷：托盘图标明明在，用户却看到一个
/// 永远停在 `not running` 的菜单项。因此后者记 `warn`、前者静默——否则在 Linux 那种
/// 托盘创建失败的环境里，每个状态事件都会刷一行无意义的告警。
///
/// # 调用约束
///
/// `MenuItem::set_text` 内部经 `run_on_main_thread` 派发：主线程调用时在 Tauri 侧
/// 直接内联执行（`send_user_message` 的 `current_thread().id()` 短路），工作线程
/// 调用则投递事件。两条路都不会死锁，但我们的调用点都在工作线程上。
pub fn refresh_status(app: &AppHandle, phase: &HarnessPhase) {
    if app.tray_by_id(TRAY_ID).is_none() {
        return;
    }
    let label = status_label_for(phase);
    let Some(handles) = app.try_state::<TrayHandles>() else {
        log::warn!("the tray exists but its status handle is not managed; the row will stay stale");
        return;
    };
    if let Err(error) = handles.status.set_text(&label) {
        log::warn!("cannot update the tray status label: {error}");
    }
    // 托盘提示文本同步相位：Windows 上**悬停即可见**，不必展开菜单——窗口收进
    // 托盘之后，「现在到底什么状态」是用户最先提出的问题。
    // （macOS 无 tooltip，Linux 不支持：两处静默无效果，不是失败。）
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Err(error) = tray.set_tooltip(Some(format!("DSH Desktop — {label}"))) {
            log::warn!("cannot update the tray tooltip: {error}");
        }
    }
}

/// 刷新托盘菜单里的手机桥状态行。
///
/// 由 [`crate::menu::refresh_bridge_status`] 与状态行一起调用——两处必须同刷，
/// 否则会出现「菜单说已连接、托盘说未启动」（见那里的模块注释）。
///
/// 幂等；没有托盘时静默跳过（理由同 [`refresh_status`]）。
pub fn refresh_mobile_status<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    let Some(handles) = app.try_state::<TrayHandles>() else {
        return;
    };
    if let Err(error) = handles.mobile_status.set_text(label) {
        log::warn!("cannot update the tray phone status label: {error}");
    }
}

/// 托盘图标点击：在「显示并聚焦」与「隐藏」之间切换。
///
/// 判定用 `is_visible()` 而不是自己记一份布尔值：窗口可见性还有别的改动方
/// （系统最小化、错误页跳转、`reveal_main_window`），自己记的那份必然漂移。
fn toggle_main_window(app: &AppHandle) {
    let Some(webview) = window::main_window(app) else {
        return;
    };
    let visible = webview.is_visible().unwrap_or(true);
    if visible {
        if let Err(error) = webview.hide() {
            log::warn!("cannot hide the main window from the tray: {error}");
        }
    } else {
        window::reveal_main_window(app);
    }
}

/// 订阅 `harness://status`，把相位变化同步到托盘状态行。
///
/// # 为什么复用事件而不是从状态机引一条回调
///
/// 状态机已经有 `emit` 这个唯一出口（`state.rs`），再开一条回调链就多一处可能漏掉
/// 的接点。这里解析载荷的 `phase` tag——它正是 `#[serde(flatten)]` 契约保证平铺在
/// 顶层的那个字段（见 `state.rs::snapshot_json_keeps_the_phase_tag_flat`），
/// [`status_tags_round_trip_from_the_state_machine`] 钉住两端的对应关系。
pub fn listen_for_status(app: &AppHandle) {
    use tauri::Listener;

    let handle = app.clone();
    app.listen(STATUS_EVENT, move |event| {
        let payload = event.payload();
        match serde_json::from_str::<serde_json::Value>(payload) {
            Ok(value) => {
                let Some(tag) = value.get("phase").and_then(|phase| phase.as_str()) else {
                    log::warn!("harness status payload has no `phase`: {payload}");
                    return;
                };
                refresh_status(&handle, &phase_from_tag(tag));
            }
            Err(error) => {
                log::warn!("cannot parse the harness status payload for the tray: {error}");
            }
        }
    });

    // 初值：状态机在 setup **之后**才首次 emit，而托盘可能在那之前就建好了。
    // 不补这一次，托盘状态行会停在 Idle 直到下一次相位变化（可能很久）。
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        refresh_status(app, &state.supervisor.snapshot().phase);
    }
}

/// `harness://status` 载荷里的相位 tag → [`HarnessPhase`]。
///
/// `Failed` / `Ready` 的字段在托盘侧没有用处，刻意丢弃为零值——`status_label_for`
/// 只看 tag 与 `plugin_fault`，而后者写在载荷同级（平铺契约）。
fn phase_from_tag(tag: &str) -> HarnessPhase {
    match tag {
        "preparing" => HarnessPhase::Preparing,
        "starting" => HarnessPhase::Starting,
        "ready_checking" => HarnessPhase::ReadyChecking,
        "ready" => HarnessPhase::Ready { url: String::new() },
        "failed" => HarnessPhase::Failed {
            cause_kind: String::new(),
            cause: String::new(),
            plugin_fault: false,
            retryable: false,
        },
        "stopping" => HarnessPhase::Stopping,
        "stopped" => HarnessPhase::Stopped,
        // 含 `idle` 与一切未知 tag：**不猜**。未知 tag 只可能来自我们自己改了
        // 枚举却忘了同步这里（`status_tags_round_trip_from_the_state_machine`
        // 会抓到），届时显示「not running」而不是编造一个状态。
        _ => HarnessPhase::Idle,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个相位都要有**各自**的文案，且 ready / failed / plugin-fault 三个关键
    /// 状态能被用户认出来。
    ///
    /// 防的是「新增相位后塞进某一臂」：`match` 有穷尽性检查，但如果把新相位并进
    /// `Idle` 那一臂（或改成 `_ =>`），编译器不会报错，托盘会永远显示
    /// 「not running」而 Harness 明明在跑。
    #[test]
    fn every_phase_has_a_distinct_label() {
        let phases = [
            HarnessPhase::Idle,
            HarnessPhase::Preparing,
            HarnessPhase::Starting,
            HarnessPhase::ReadyChecking,
            HarnessPhase::Ready {
                url: "http://127.0.0.1:1/".to_string(),
            },
            HarnessPhase::Failed {
                cause_kind: "port_in_use".to_string(),
                cause: "port busy".to_string(),
                plugin_fault: false,
                retryable: true,
            },
            HarnessPhase::Failed {
                cause_kind: "plugin_fault".to_string(),
                cause: "loader entry failed".to_string(),
                plugin_fault: true,
                retryable: false,
            },
            HarnessPhase::Stopping,
            HarnessPhase::Stopped,
        ];
        let labels: Vec<String> = phases.iter().map(status_label_for).collect();
        for (index, label) in labels.iter().enumerate() {
            assert!(label.starts_with("Harness: "), "{index}: {label}");
        }
        let unique: std::collections::HashSet<&String> = labels.iter().collect();
        assert_eq!(
            unique.len(),
            labels.len(),
            "each phase needs its own wording: {labels:?}"
        );
        assert!(labels[4].contains("ready"), "{}", labels[4]);
        assert!(labels[5].contains("failed"), "{}", labels[5]);
        assert!(
            labels[6].contains("plugin fault"),
            "the plugin-fault variant must be distinguishable: {}",
            labels[6]
        );
    }

    /// 事件 tag ↔ 相位的对应关系必须覆盖 `HarnessPhase` 的每一个 tag。
    ///
    /// 可证伪性：从 `phase_from_tag` 删掉任一分支，对应断言立刻失败（未知 tag 会
    /// 落到 `Idle`，tag 就对不上了）。这是与
    /// `state.rs::snapshot_json_keeps_the_phase_tag_flat` 同一条契约的另一端——
    /// 那里钉「发出的 tag 是平的」，这里钉「收到的 tag 认得出来」。
    #[test]
    fn status_tags_round_trip_from_the_state_machine() {
        let cases = [
            HarnessPhase::Idle,
            HarnessPhase::Preparing,
            HarnessPhase::Starting,
            HarnessPhase::ReadyChecking,
            HarnessPhase::Ready {
                url: "http://127.0.0.1:1/".to_string(),
            },
            HarnessPhase::Stopping,
            HarnessPhase::Stopped,
            HarnessPhase::Failed {
                cause_kind: "x".to_string(),
                cause: "y".to_string(),
                plugin_fault: false,
                retryable: false,
            },
        ];
        for phase in cases {
            let snapshot = crate::state::HarnessSnapshot {
                phase: phase.clone(),
                message: "m".to_string(),
                logs: vec![],
            };
            let json = serde_json::to_value(&snapshot).expect("must serialize");
            let tag = json["phase"]
                .as_str()
                .expect("the phase tag must be a flat string");
            let parsed = serde_json::to_value(phase_from_tag(tag)).expect("must serialize");
            assert_eq!(
                parsed["phase"], json["phase"],
                "phase_from_tag must recognise the tag `{tag}` emitted by state.rs: {json}"
            );
        }
    }

    /// 未知 tag 落到 `Idle`，不编造状态。
    #[test]
    fn unknown_tag_falls_back_to_idle() {
        let json = serde_json::to_value(phase_from_tag("who-knows")).expect("must serialize");
        assert_eq!(json["phase"], serde_json::json!("idle"));
    }
}
