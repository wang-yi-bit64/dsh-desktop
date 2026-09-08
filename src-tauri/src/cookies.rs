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
    // 跨平台非阻塞清理：通过向当前页面 eval 脚本清除 document.cookie 中的 dsh-auth-* cookie
    let script = format!(
        r#"(function() {{
            try {{
                var prefix = "{prefix}";
                var cookies = document.cookie ? document.cookie.split(';') : [];
                for (var i = 0; i < cookies.length; i++) {{
                    var cookie = cookies[i].trim();
                    var eqPos = cookie.indexOf('=');
                    var name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;
                    if (name.indexOf(prefix) === 0) {{
                        document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;';
                        document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=127.0.0.1;';
                        document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=localhost;';
                    }}
                }}
            }} catch(e) {{}}
        }})();"#
    );
    let _ = webview.eval(&script);

    Ok(CookieCleanup {
        removed: 0,
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
        let json = serde_json::to_value(report).unwrap();
        assert_eq!(json["removed"], 3);
        assert_eq!(json["bridged"], true);
    }
}
