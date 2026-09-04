//! Cookie 清理（任务 1.5，对齐原仓库 `window-navigation.ts` 的 431 防护）。
//!
//! 问题：harness 的 `dsh-auth-*` cookie 按 `127.0.0.1` 域存储（端口无关），
//! 每次重启换端口就多一枚，最终请求头膨胀到 Node 返回 **HTTP 431**。
//! 原仓库在每次重启导航前主动清理陈旧 cookie。
//!
//! Tauri 侧没有现成的跨平台 cookie API，按计划 R-4 的分级实现：
//!
//! * **Windows（主路径）**：`ICoreWebView2CookieManager::GetCookies` 枚举
//!   `http://127.0.0.1` 域下的 cookie，逐个删除 `dsh-auth-*` 前缀。
//! * **macOS / Linux（降级路径）**：暂无平台桥接，记录日志并放行；风险登记册
//!   R-4 观察，兜底入口是错误页「重置会话登录」（阶段 2 的窗口任务补齐）。

use serde::Serialize;
use tauri::{Runtime, WebviewWindow};

/// 清理结果（记日志用）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct CookieCleanup {
    /// 实际删除的 cookie 数。
    pub removed: usize,
    /// 本次运行是否使用了平台桥接（false = 降级路径，未真正清理）。
    pub bridged: bool,
}

/// 清理 `127.0.0.1` 域下所有 `prefix*` cookie（在导航到 harness 之前调用）。
///
/// # 参数
///
/// * `webview` — 主窗口。
/// * `prefix` — cookie 名前缀（契约上为 `dsh-auth-`）。
pub fn clear_auth_cookies<R: Runtime>(
    webview: &WebviewWindow<R>,
    prefix: &str,
) -> Result<CookieCleanup, String> {
    #[cfg(windows)]
    {
        clear_auth_cookies_windows(webview, prefix)
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, prefix);
        // R-4 降级：非 Windows 平台暂不清理，靠「重启换端口 + token 首航换新
        // cookie」把 431 概率压低；同域累积问题的根治留待平台桥接。
        Ok(CookieCleanup {
            removed: 0,
            bridged: false,
        })
    }
}

#[cfg(windows)]
fn clear_auth_cookies_windows<R: Runtime>(
    webview: &WebviewWindow<R>,
    prefix: &str,
) -> Result<CookieCleanup, String> {
    use std::sync::mpsc;

    let prefix = prefix.to_string();
    let (tx, rx) = mpsc::channel::<Result<CookieCleanup, String>>();

    // with_webview 的闭包运行在主线程；用 channel 把结果带回来。
    webview
        .with_webview(move |platform_webview| {
            let _ = tx.send(clear_cookies_sync(&platform_webview, &prefix));
        })
        .map_err(|error| format!("with_webview failed: {error}"))?;

    rx.recv()
        .map_err(|_| "cookie cleanup did not report back".to_string())?
}

/// 在 WebView2 控制器上执行枚举 + 精确删除（只动 `dsh-auth-*`）。
#[cfg(windows)]
fn clear_cookies_sync(
    platform_webview: &tauri::webview::PlatformWebview,
    prefix: &str,
) -> Result<CookieCleanup, String> {
    use std::sync::mpsc;

    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CookieList;
    use webview2_com::{take_pwstr, CoTaskMemPWSTR, GetCookiesCompletedHandler};

    let controller = platform_webview.controller();
    let core = unsafe { controller.CoreWebView2() }
        .map_err(|error| format!("CoreWebView2 unavailable: {error}"))?;
    let manager = unsafe { core.CookieManager() }
        .map_err(|error| format!("CookieManager unavailable: {error}"))?;

    // GetCookies 是异步 COM 调用；webview2-com 的 completed-callback 封装会在
    // 主线程泵消息直到完成回调兑现。
    let (result_tx, result_rx) = mpsc::channel::<Option<ICoreWebView2CookieList>>();
    let uri = CoTaskMemPWSTR::from("http://127.0.0.1");
    unsafe {
        GetCookiesCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| {
                manager
                    .GetCookies(*uri.as_ref().as_pcwstr(), &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |error_code, cookie_list| {
                let _ = result_tx.send(if error_code.is_ok() {
                    cookie_list
                } else {
                    None
                });
                Ok(())
            }),
        )
        .map_err(|error| format!("GetCookies failed: {error}"))?;
    }

    let cookies = result_rx
        .recv()
        .map_err(|_| "cookie list was not delivered".to_string())?
        .ok_or_else(|| "GetCookies reported a failure".to_string())?;
    let count = unsafe { cookies.Count() }
        .map_err(|error| format!("could not read cookie count: {error}"))?;

    let mut removed = 0usize;
    for index in 0..count {
        let Ok(cookie) = (unsafe { cookies.GetValueAtIndex(index) }) else {
            continue;
        };
        let name = unsafe { cookie.Name() }.map(take_pwstr).unwrap_or_default();
        if name.starts_with(prefix) {
            if unsafe { manager.DeleteCookie(&cookie) }.is_ok() {
                removed += 1;
            }
        }
    }

    Ok(CookieCleanup {
        removed,
        bridged: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_report_serializes() {
        let report = CookieCleanup {
            removed: 3,
            bridged: true,
        };
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["removed"], 3);
        assert_eq!(json["bridged"], true);
    }
}
