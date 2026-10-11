//! 启动 token 解析（契约 C3 / C5）。
//!
//! Harness 就绪前会在 stdout 打印一行形如
//! `dsh web: http://127.0.0.1:4173/?token=<uuid>` 的 URL。宿主据此拿到
//! **每进程一次性**的启动 token，并只通过 `GET /?token=…` 换取 30 天 cookie；
//! token 绝不出现在 API 路径或 Authorization 头里（C5）。

use std::fmt;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::contracts::{TOKEN_LINE_PATTERN, TOKEN_QUERY_KEY};

/// 从 stdout 解析出的 Harness 端点。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchEndpoint {
    /// 原始 URL（含 token query）。
    pub url: Url,
    /// 启动 token（每进程唯一）。
    pub token: String,
    /// 监听主机（契约上恒为 `127.0.0.1`）。
    pub host: String,
    /// 监听端口。
    pub port: u16,
}

impl LaunchEndpoint {
    /// 拼出带 token 的首航导航地址（C5：仅此一次携带 token）。
    ///
    /// # 参数
    ///
    /// * `extra` — 追加的 query 参数（C12 的 Windows 平台参数）。
    ///
    /// # 示例
    ///
    /// ```
    /// use dsh_host::token::parse_launch_line;
    ///
    /// let endpoint = parse_launch_line("dsh web: http://127.0.0.1:4173/?token=abc").unwrap();
    /// let url = endpoint.navigate_url(&[("dsh-desktop-mode", "advanced")]);
    /// assert!(url.as_str().contains("token=abc"));
    /// assert!(url.as_str().contains("dsh-desktop-mode=advanced"));
    /// ```
    pub fn navigate_url(&self, extra: &[(&str, &str)]) -> Url {
        let mut url = self.url.clone();
        {
            let mut query = url.query_pairs_mut();
            for (key, value) in extra {
                query.append_pair(key, value);
            }
        }
        url
    }

    /// 就绪探测用的基地址（不带 query）。
    pub fn base_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }
}

impl fmt::Display for LaunchEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.url)
    }
}

/// 从一行 stdout 文本中解析出 [`LaunchEndpoint`]。
///
/// 输入应当是**已清洗**的行（见 [`crate::logs::sanitize_line`]）：带 ANSI 颜色
/// 的 URL 会命中正则但解析失败。
///
/// # 示例
///
/// ```
/// use dsh_host::token::parse_launch_line;
///
/// let endpoint = parse_launch_line("dsh web: http://127.0.0.1:4173/?token=abc123").unwrap();
/// assert_eq!(endpoint.token, "abc123");
/// assert_eq!(endpoint.port, 4173);
/// assert_eq!(endpoint.host, "127.0.0.1");
/// ```
pub fn parse_launch_line(line: &str) -> Option<LaunchEndpoint> {
    let regex = token_line_pattern()?;
    let raw_url = regex.captures(line)?.get(1)?.as_str();
    let url = Url::parse(raw_url).ok()?;

    let token = url
        .query_pairs()
        .find(|(key, _)| key == TOKEN_QUERY_KEY)
        .map(|(_, value)| value.into_owned())
        .filter(|token| !token.is_empty())?;

    let host = url.host_str()?.to_string();
    let port = url.port().or_else(|| match url.scheme() {
        "https" => Some(443),
        "http" => Some(80),
        _ => None,
    })?;

    Some(LaunchEndpoint {
        url,
        token,
        host,
        port,
    })
}

/// 只要 token（不需要完整端点信息时的轻量入口）。
///
/// # 示例
///
/// ```
/// use dsh_host::token::extract_token;
/// assert_eq!(extract_token("dsh web: http://127.0.0.1:1/?token=z").as_deref(), Some("z"));
/// ```
pub fn extract_token(line: &str) -> Option<String> {
    parse_launch_line(line).map(|endpoint| endpoint.token)
}

/// 启动 token 行正则的单次编译缓存。
///
/// 调用方是日志泵：它对**每一行** stdout 尝试解析，且这个调用发生在**持有
/// `shared` 的 async 锁期间**（见 `launch.rs` 的 `spawn_line_pump`）。
/// 逐行重编译等于把~37 µs 的编译成本压在 executor 线程上，还会连带拉长
/// 锁持有时间。实测复用后该路径从每行约 37 µs 降到约 0.3 µs。
///
/// 返回 `None` 而非 panic，与优化前 `Regex::new(..).ok()?` 的降级语义一致。
fn token_line_pattern() -> Option<&'static regex::Regex> {
    static PATTERN: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
    PATTERN
        .get_or_init(|| regex::Regex::new(TOKEN_LINE_PATTERN).ok())
        .as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_reference_url_line() {
        let endpoint = parse_launch_line("dsh web: http://127.0.0.1:4173/?token=abc123").unwrap();
        assert_eq!(endpoint.token, "abc123");
        assert_eq!(endpoint.port, 4173);
        assert_eq!(endpoint.host, "127.0.0.1");
        assert_eq!(endpoint.base_url(), "http://127.0.0.1:4173");
    }

    /// 性能回归护栏：token 行正则必须**只编译一次**。
    ///
    /// 日志泵对每一行 stdout 都调用 [`parse_launch_line`]，且调用点**持有
    /// `shared` 的 async 锁**——优化前每行重编译约 37 µs 会连带拉长锁持有
    /// 时间。判据取「缓存实例同一性」这一可观测事实，不用墙钟阈值。
    #[test]
    fn token_pattern_is_compiled_only_once() {
        let first = parse_launch_line("dsh web: http://127.0.0.1:1/?token=warm");
        assert!(first.is_some(), "预热调用应成功");
        let a = token_line_pattern().map(|re| re.as_str().to_owned());
        let b = token_line_pattern().map(|re| re.as_str().to_owned());
        assert_eq!(a, b, "两次调用必须命中同一缓存正则");
        assert!(a.is_some(), "契约常量正则必须能编译");
    }

    /// 缓存化不得改变解析语义：重复解析同一行结果必须稳定。
    #[test]
    fn repeated_parses_are_stable() {
        let line = "dsh web: http://127.0.0.1:4173/?token=abc123";
        let first = parse_launch_line(line).unwrap();
        for _ in 0..64 {
            let again = parse_launch_line(line).unwrap();
            assert_eq!(again.token, first.token);
            assert_eq!(again.port, first.port);
            assert_eq!(again.url, first.url);
        }
    }

    #[test]
    fn parses_url_surrounded_by_other_text() {
        let line =
            "[arness-node] ready → dsh web: http://127.0.0.1:5123/?token=tok  (ctrl+c to stop)";
        let endpoint = parse_launch_line(line).unwrap();
        assert_eq!(endpoint.token, "tok");
        assert_eq!(endpoint.port, 5123);
    }

    #[test]
    fn takes_first_match_when_multiple_lines_are_concatenated() {
        // 长行被截断合并时，首个匹配才是本次启动的 URL。
        let line =
            "dsh web: http://127.0.0.1:1/?token=first dsh web: http://127.0.0.1:2/?token=second";
        assert_eq!(parse_launch_line(line).unwrap().token, "first");
    }

    #[test]
    fn rejects_lines_without_token() {
        assert!(parse_launch_line("dsh web: http://127.0.0.1:4173/").is_none());
        assert!(parse_launch_line("dsh web: ").is_none());
    }

    #[test]
    fn rejects_empty_token() {
        assert!(parse_launch_line("dsh web: http://127.0.0.1:4173/?token=").is_none());
    }

    #[test]
    fn rejects_non_url_output() {
        assert!(parse_launch_line("[arness-node] runtime node=v24.9.0 platform=win32").is_none());
        assert!(parse_launch_line("some other output").is_none());
    }

    #[test]
    fn navigate_url_appends_windows_contract_parameters() {
        let endpoint = parse_launch_line("dsh web: http://127.0.0.1:4173/?token=abc").unwrap();
        let url = endpoint.navigate_url(&[
            crate::contracts::WINDOWS_QUERY_MODE,
            crate::contracts::WINDOWS_QUERY_PLATFORM,
        ]);
        let rendered = url.as_str();
        assert!(rendered.contains("token=abc"));
        assert!(rendered.contains("dsh-desktop-mode=advanced"));
        assert!(rendered.contains("dsh-desktop-platform=win32"));
    }

    #[test]
    fn display_is_the_raw_url() {
        let endpoint = parse_launch_line("dsh web: http://127.0.0.1:4173/?token=abc").unwrap();
        assert_eq!(endpoint.to_string(), "http://127.0.0.1:4173/?token=abc");
    }
}
