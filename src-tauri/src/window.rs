//! 本地静态页与 harness UI 之间的窗口导航辅助。
//!
//! 导航白名单本身在 [`crate::navigation`]（挂在 WebviewWindowBuilder 上），
//! 这里只提供「跳到某一页」的薄封装。跳 harness 页由状态机在 `Ready` 时
//! 直接执行（含 C12 参数与 cookie 清理），不经过本模块。

use tauri::{Manager, Runtime, WebviewWindow};

pub const MAIN_WINDOW: &str = "main";

/// 主窗口句柄。
pub fn main_window<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN_WINDOW)
}

/// 显示并聚焦主窗口（托盘点击 / 二次启动 / 「显示窗口」菜单项）。
///
/// # 为什么不是简单的 `set_focus()`
///
/// 自批次 0.2-B1 起关窗不再退出应用，而是**把窗口藏起来**（见
/// [`crate::tray`]）。藏起来的窗口 `set_focus()` 是无效动作——它在任务栏上
/// 不存在，系统不接受把焦点给一个不可见窗口。因此「唤回」必须拆成三步：
/// `show()` → 解除最小化 → `set_focus()`，少任何一步都会表现为「点了没反应」。
///
/// 幂等：窗口本来就在最前面时，这三步是空操作。
pub fn reveal_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(webview) = main_window(app) else {
        return;
    };
    if let Err(error) = webview.show() {
        log::warn!("cannot show the main window: {error}");
    }
    // 从托盘唤回时窗口通常是最小化状态（Windows 上 hide() 会保留最小化标志，
    // 直接 show() 出来的仍是看不见的一小条），必须显式解除。
    if let Err(error) = webview.unminimize() {
        log::warn!("cannot unminimize the main window: {error}");
    }
    if let Err(error) = webview.set_focus() {
        log::warn!("cannot focus the main window: {error}");
    }
}

/// 为打包在前端的本地页面构造绝对 URL。Tauri 按平台使用不同 origin
/// （Windows：`http://tauri.localhost`；其它：`tauri://localhost`），
/// `navigate` 拒绝相对地址。
fn local_page(page: &str) -> tauri::Url {
    #[cfg(windows)]
    const ORIGIN: &str = "http://tauri.localhost/";
    #[cfg(not(windows))]
    const ORIGIN: &str = "tauri://localhost/";
    url::Url::parse(ORIGIN)
        .and_then(|base| base.join(page))
        .expect("bundled page url must be valid")
}

/// 跳到一个已构造好的本地页 URL，并**确保窗口是可见的**。
///
/// 自批次 0.2-B1 起窗口可能被藏进托盘（见 [`reveal_main_window`]），而
/// `navigate` 只换内容、不会让窗口出现——于是「菜单点了没反应」会以另一种形式
/// 复活：页面其实已经切过去了，只是没人看得见。所有**用户显式发起**的页面跳转
/// 都经这个函数。
///
/// 刻意不用于 [`show_splash`]：splash 是状态机重启路径的一部分（可能由托盘菜单
/// 触发），此时把窗口弹出来打断用户手上的事并不合适。
///
/// # 为什么参数是 `Url` 而不是页名字符串
///
/// 让页名字面量留在各个 `show_*` 函数里（它们都在 `local_page(...)` 调用里）。
/// `verify-ipc-surface` 的 E5 / W2（页面可达性）按那个**字面量**判定——把页名
/// 收进一个中间函数会让它看见零个可达页面（曾实测：一次这样的重构让 W2 对五个
/// 页面同时报错，而 E5 还会把本注释里举例的假文件名当成真目标）。
/// 守卫的假阳性与假阴性一样有害，这里因此选择多写几个字。
fn navigate_visible<R: Runtime>(app: &tauri::AppHandle<R>, url: tauri::Url) {
    reveal_main_window(app);
    let Some(webview) = main_window(app) else {
        return;
    };
    let _ = webview.navigate(url);
}

/// 显示 splash（`index.html`）。
pub fn show_splash<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(webview) = main_window(app) else {
        return;
    };
    let _ = webview.navigate(local_page("index.html"));
}

/// 显示错误页。
///
/// 用 [`navigate_visible`]：Harness 崩溃是需要用户处理的事件，窗口藏在托盘里
/// 会让它彻底静默（用户只看到托盘状态行变红，却不知道该怎么办）。
pub fn show_error_page<R: Runtime>(app: &tauri::AppHandle<R>) {
    navigate_visible(app, local_page("error.html"));
}

/// 显示插件恢复页（批次 C1 接线）。
///
/// 由 `commands::recovery_open` 指向——错误页的「插件恢复…」按钮。
///
/// 刻意**不接收**插件列表参数（页面改用 `recovery_status` 命令取数）：经 URL
/// 传参既受长度限制、又要自己写百分号编码（原实现就为此带了一个 `urlencoding`
/// 函数），而这些数据本来就必须经命令面校验 origin，绕一道路没有收益。
pub fn show_recovery_page<R: Runtime>(app: &tauri::AppHandle<R>) {
    navigate_visible(app, local_page("plugin-recovery.html"));
}

/// 显示更新页（批次 B2）。
///
/// 由菜单「Check for Updates…」指向：更新流程（检查 → 下载 → 重启安装）需要
/// 一个能持续展示进度与失败原因的落点，原生菜单项做不到这件事。
pub fn show_updates_page<R: Runtime>(app: &tauri::AppHandle<R>) {
    navigate_visible(app, local_page("updates.html"));
}

/// 显示日志页（批次 D3 / D10）。
pub fn show_logs_page<R: Runtime>(app: &tauri::AppHandle<R>) {
    navigate_visible(app, local_page("logs.html"));
}

/// 显示反馈页（批次 0.2-D2）。
///
/// 由菜单 / 托盘「Send Feedback…」指向。页面先给出**报告该带的信息**（版本、
/// 运行时通道、DSH 版本、补丁统计）与诊断包导出按钮，再给三个外链出口；
/// 见 `frontend/feedback.html` 的文件头。
pub fn show_feedback_page<R: Runtime>(app: &tauri::AppHandle<R>) {
    navigate_visible(app, local_page("feedback.html"));
}
