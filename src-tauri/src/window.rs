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

/// 显示 splash（`index.html`）。
pub fn show_splash<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(webview) = main_window(app) else {
        return;
    };
    let _ = webview.navigate(local_page("index.html"));
}

/// 显示错误页。
pub fn show_error_page<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(webview) = main_window(app) else {
        return;
    };
    let _ = webview.navigate(local_page("error.html"));
}

/// 显示插件恢复页（批次 C1 接线）。
///
/// 由 `commands::recovery_open` 指向——错误页的「插件恢复…」按钮。
///
/// 刻意**不接收**插件列表参数（页面改用 `recovery_status` 命令取数）：经 URL
/// 传参既受长度限制、又要自己写百分号编码（原实现就为此带了一个 `urlencoding`
/// 函数），而这些数据本来就必须经命令面校验 origin，绕一道路没有收益。
pub fn show_recovery_page<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(webview) = main_window(app) else {
        return;
    };
    let _ = webview.navigate(local_page("plugin-recovery.html"));
}

/// 显示更新页（批次 B2）。
///
/// 由菜单「Check for Updates…」指向：更新流程（检查 → 下载 → 重启安装）需要
/// 一个能持续展示进度与失败原因的落点，原生菜单项做不到这件事。
pub fn show_updates_page<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(webview) = main_window(app) else {
        return;
    };
    let _ = webview.navigate(local_page("updates.html"));
}

/// 显示日志页（批次 D3 / D10）。
pub fn show_logs_page<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(webview) = main_window(app) else {
        return;
    };
    let _ = webview.navigate(local_page("logs.html"));
}
