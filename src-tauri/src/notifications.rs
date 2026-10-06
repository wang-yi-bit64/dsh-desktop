//! 系统通知（当前唯一用途：更新就绪提醒）。
//!
//! # 为什么需要通知
//!
//! 关窗即隐藏意味着**窗口可能根本不在屏幕上**，而更新就绪是个事件——用户此刻
//! 没有理由盯着更新页。上游桌面端在窗口失焦时用 `flashFrame` / `dock.bounce` /
//! 静默通知；本仓的可移植等价物是托盘状态行 + 一条系统通知。
//!
//! # 边界
//!
//! * **只有一条真实用途**：`notify_update_ready`。它不是通用通知中心，也没有
//!   「通知设置」这种东西——本仓不设开关，因为这条通知完全跟着用户的显式行动
//!   （点了下载）产生。
//! * **失败一律静默**：通知权限被拒、平台不支持，都只记 `log::debug`。通知是
//!   **附加**回执；真正判定的回执是更新页的状态机（`updates://status`），看不到
//!   通知不会让用户漏掉更新。
//! * **文案不含隐私**：只含版本号（用户在自己机器上点过一次下载，版本号不是
//!   新信息）。

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// 弹一条「更新已就绪」的系统通知。
///
/// `body` 含版本号，由调用方给出（[`crate::update::UpdateManager::announce_ready`]）。
///
/// # 错误
///
/// 错误类型就是插件自己的 `Error`（`tauri::Error` 未实现 `From` 转换）。
/// 调用方按「通知失败」降级处理（只记 debug），不把它当更新失败上报。
pub fn notify_update_ready<R: tauri::Runtime>(
    app: &AppHandle<R>,
    body: &str,
) -> Result<(), tauri_plugin_notification::Error> {
    app.notification()
        .builder()
        .title("Update ready")
        .body(body)
        .show()
}
