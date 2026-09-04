//! 窗口导航白名单（任务 1.4，安全第一天就位）。
//!
//! 规则（对齐原仓库 `will-navigate` / `setWindowOpenHandler`）：
//!
//! | 目标 | 处置 |
//! |---|---|
//! | 本地静态页（`tauri://localhost`、`http(s)://tauri.localhost`、`http://ipc.localhost`） | 放行 |
//! | `http(s)://127.0.0.1:<当前实例端口>` | 放行（当前 harness 实例） |
//! | 其余 http(s) | 转交系统浏览器（opener），窗口不放行 |
//! | 其它 scheme | 拦截 |
//!
//! 决策逻辑抽成纯函数 [`decide_navigation`]，可无 GUI 单测。

use serde::Serialize;
use url::Url;

/// 本地静态页可能出现的 origin（`local_page` 的取值集合）。
pub const LOCAL_PAGE_HOSTS: [&str; 3] = ["tauri.localhost", "ipc.localhost", "localhost"];

/// 导航处置结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NavigationDecision {
    /// 允许在窗口内导航。
    Allow,
    /// 转交系统浏览器打开，窗口不放行。
    External,
    /// 直接拦截（非 http(s) 的未知 scheme、`file:` 等）。
    Block,
}

/// 判定一个导航目标应当如何处置。
///
/// # 参数
///
/// * `url` — 导航目标。
/// * `harness_port` — 当前 harness 实例的端口；`None` 表示尚无实例（此时
///   一律不放行回环地址，防止旧实例的 URL 残留）。
///
/// # 示例
///
/// ```
/// use url::Url;
/// use dsh_desktop_lib::navigation::{decide_navigation, NavigationDecision};
///
/// let harness = Url::parse("http://127.0.0.1:4173/?token=x").unwrap();
/// assert_eq!(decide_navigation(&harness, Some(4173)), NavigationDecision::Allow);
/// // 端口不匹配的旧实例 URL：不放行。
/// assert_eq!(decide_navigation(&harness, Some(4180)), NavigationDecision::External);
/// // 外链：转交系统浏览器。
/// let external = Url::parse("https://example.com").unwrap();
/// assert_eq!(decide_navigation(&external, Some(4173)), NavigationDecision::External);
/// // 本地静态页：放行。
/// let local = Url::parse("http://tauri.localhost/error.html").unwrap();
/// assert_eq!(decide_navigation(&local, None), NavigationDecision::Allow);
/// ```
pub fn decide_navigation(url: &Url, harness_port: Option<u16>) -> NavigationDecision {
    // 本地静态页 origin。
    if is_local_page(url) {
        return NavigationDecision::Allow;
    }

    match url.scheme() {
        "http" | "https" => {
            if url.host_str() == Some("127.0.0.1") {
                match harness_port {
                    // 当前实例：放行。
                    Some(port) if url.port() == Some(port) => NavigationDecision::Allow,
                    // 旧实例 / 未知端口：不能放行（token 只属于本次启动）。
                    _ => NavigationDecision::External,
                }
            } else {
                // 非可信 http(s)：转交系统浏览器。
                NavigationDecision::External
            }
        }
        _ => NavigationDecision::Block,
    }
}

/// URL 是否指向本地静态页（splash / error / recovery / safe-mode）。
pub fn is_local_page(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => LOCAL_PAGE_HOSTS.contains(&url.host_str().unwrap_or("")),
        _ => false,
    }
}

/// 外链是否值得交给系统浏览器（放行前再校验一次 scheme）。
pub fn is_openable_external(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str() != Some("127.0.0.1")
        && url.host_str() != Some("localhost")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &str) -> Url {
        Url::parse(input).unwrap()
    }

    #[test]
    fn allows_current_harness_instance_only() {
        assert_eq!(
            decide_navigation(&parse("http://127.0.0.1:4173/"), Some(4173)),
            NavigationDecision::Allow
        );
        assert_eq!(
            decide_navigation(&parse("http://127.0.0.1:4173/x?y=z"), Some(4173)),
            NavigationDecision::Allow
        );
    }

    #[test]
    fn rejects_stale_instance_ports() {
        assert_eq!(
            decide_navigation(&parse("http://127.0.0.1:4173/"), Some(4180)),
            NavigationDecision::External
        );
        assert_eq!(
            decide_navigation(&parse("http://127.0.0.1:4173/"), None),
            NavigationDecision::External
        );
    }

    #[test]
    fn sends_external_links_to_browser() {
        assert_eq!(
            decide_navigation(&parse("https://example.com/docs"), Some(4173)),
            NavigationDecision::External
        );
        assert_eq!(
            decide_navigation(&parse("http://192.168.1.1/"), Some(4173)),
            NavigationDecision::External
        );
    }

    #[test]
    fn allows_local_shell_pages() {
        assert_eq!(
            decide_navigation(&parse("tauri://localhost/error.html"), Some(4173)),
            NavigationDecision::Allow
        );
        assert_eq!(
            decide_navigation(&parse("http://tauri.localhost/splash.html"), Some(4173)),
            NavigationDecision::Allow
        );
        assert_eq!(
            decide_navigation(&parse("http://ipc.localhost/x"), Some(4173)),
            NavigationDecision::Allow
        );
    }

    #[test]
    fn blocks_unknown_schemes() {
        assert_eq!(
            decide_navigation(&parse("file:///C:/Windows/system32"), Some(4173)),
            NavigationDecision::Block
        );
        assert_eq!(
            decide_navigation(&parse("ws://127.0.0.1:4173/"), Some(4173)),
            NavigationDecision::Block
        );
        assert_eq!(
            decide_navigation(&parse("javascript:alert(1)"), Some(4173)),
            NavigationDecision::Block
        );
    }

    #[test]
    fn localhost_is_a_local_page_host() {
        assert!(is_local_page(&parse("http://localhost:5173/index.html")));
        assert!(is_local_page(&parse("https://tauri.localhost/")));
        assert!(!is_local_page(&parse("http://127.0.0.1:4173/")));
    }

    #[test]
    fn external_openability() {
        assert!(is_openable_external(&parse("https://example.com")));
        assert!(!is_openable_external(&parse("http://127.0.0.1:4173/")));
        assert!(!is_openable_external(&parse("http://localhost:1/")));
        assert!(!is_openable_external(&parse("file:///etc/passwd")));
    }
}
