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
    let prefix = prefix.to_string();

    // with_webview 调度到 UI 线程，发起纯异步非阻塞删除，绝不阻塞 UI 消息循环
    webview
        .with_webview(move |platform_webview| {
            clear_cookies_async(&platform_webview, &prefix);
        })
        .map_err(|error| format!("with_webview failed: {error}"))?;

    Ok(CookieCleanup {
        removed: 0,
        bridged: true,
    })
}

/// 在 WebView2 控制器上发起异步枚举与清理，绝不调用阻塞的 wait_for_async_operation。
#[cfg(windows)]
fn clear_cookies_async(platform_webview: &tauri::webview::PlatformWebview, prefix: &str) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_19;
    use webview2_com::{take_pwstr, CoTaskMemPWSTR, GetCookiesCompletedHandler};
    use windows::core::{Interface as _, PWSTR};

    let controller = platform_webview.controller();
    let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
        return;
    };
    let Ok(core): Result<ICoreWebView2_19, _> = core.cast() else {
        return;
    };
    let Ok(manager) = (unsafe { core.CookieManager() }) else {
        return;
    };

    let uri = CoTaskMemPWSTR::from("http://127.0.0.1");
    let delete_manager = manager.clone();
    let prefix_str = prefix.to_string();

    let handler = GetCookiesCompletedHandler::create(Box::new(move |error_code, cookie_list| {
        if error_code.is_err() {
            return Ok(());
        }
        let Some(cookies) = cookie_list else {
            return Ok(());
        };
        let mut count = 0u32;
        if unsafe { cookies.Count(&mut count) }.is_err() {
            return Ok(());
        }
        for index in 0..count {
            let Ok(cookie) = (unsafe { cookies.GetValueAtIndex(index) }) else {
                continue;
            };
            let mut name_buf = PWSTR::null();
            if unsafe { cookie.Name(&mut name_buf) }.is_err() {
                continue;
            }
            let name = take_pwstr(name_buf);
            if name.starts_with(&prefix_str) {
                let _ = unsafe { delete_manager.DeleteCookie(&cookie) };
            }
        }
        Ok(())
    }));

    let _ = unsafe { manager.GetCookies(*uri.as_ref().as_pcwstr(), &handler) };
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
        let json = serde_json::to_value(report).unwrap();
        assert_eq!(json["removed"], 3);
        assert_eq!(json["bridged"], true);
    }
}
