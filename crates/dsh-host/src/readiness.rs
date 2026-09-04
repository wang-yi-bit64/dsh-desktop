//! 就绪探测（契约 C4）。
//!
//! 手写 HTTP/1.0 探测（`tokio::net::TcpStream`），不引入 reqwest / hyper：
//! 这里只需要「一个状态码」，依赖越少越好（INV-5 离线可用 + 编译时间）。
//!
//! 就绪语义（对齐原仓库 `harness-runtime.ts`）：
//!
//! * 健康 = **token 已知** 且 `200 ≤ status < 500`（`GET /` 不带 token 返回 401
//!   属正常，所以区间下界不能是 200 的「成功」语义，而是「服务已起」）；
//! * 需要连续 **500ms 稳定窗**，避免瞬时通过后又崩；
//! * 轮询间隔 100ms；总超时 Windows 120s、其它平台 45s。

use std::future::Future;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::contracts::{HEALTHY_STATUS_MAX, HEALTHY_STATUS_MIN};

/// 就绪探测参数。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProbeConfig {
    /// 轮询间隔（默认 100ms）。
    pub interval: Duration,
    /// 稳定窗：连续健康多久才算就绪（默认 500ms）。
    pub stable_window: Duration,
    /// 单次探测超时（默认 2s）。
    pub probe_timeout: Duration,
    /// 总超时（默认取 [`crate::contracts::startup_timeout`]）。
    pub total_timeout: Duration,
}

impl Default for ProbeConfig {
    fn default() -> Self {
        Self {
            interval: Duration::from_millis(100),
            stable_window: Duration::from_millis(500),
            probe_timeout: Duration::from_secs(2),
            total_timeout: crate::contracts::startup_timeout(),
        }
    }
}

impl ProbeConfig {
    /// 测试用：把间隔与稳定窗压到毫秒级，总超时显式给定。
    pub fn fast(total_timeout: Duration) -> Self {
        Self {
            interval: Duration::from_millis(1),
            stable_window: Duration::from_millis(5),
            probe_timeout: Duration::from_millis(50),
            total_timeout,
        }
    }
}

/// 就绪等待结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessOutcome {
    /// 已就绪（连续稳定窗内健康）。
    Ready,
    /// 超过总超时。
    Timeout,
    /// 探测期间检测到端口冲突（stderr 出现 `EADDRINUSE`）：立即换端口重试，
    /// 不干等 120s（任务 1.3 的 TOCTOU 缓解）。
    PortInUse,
    /// 子进程在就绪前退出。
    ProcessExited,
}

impl ReadinessOutcome {
    /// 是否算启动成功。
    pub fn is_ready(self) -> bool {
        matches!(self, ReadinessOutcome::Ready)
    }
}

/// C4 的健康判据（纯函数，单测直接覆盖）。
///
/// # 示例
///
/// ```
/// use dsh_host::readiness::is_healthy;
/// assert!(is_healthy(Some(401), true));   // token 已知，401 说明服务已起
/// assert!(!is_healthy(Some(401), false)); // token 未知，不能放行
/// assert!(!is_healthy(Some(500), true));  // 5xx 不健康
/// assert!(!is_healthy(None, true));       // 连不上
/// ```
pub fn is_healthy(status: Option<u16>, token_known: bool) -> bool {
    match status {
        Some(status) => token_known && (HEALTHY_STATUS_MIN..HEALTHY_STATUS_MAX).contains(&status),
        None => false,
    }
}

/// 手写 HTTP/1.0 探测：返回状态码，连不上或解析失败返回 `None`。
///
/// # 参数
///
/// * `host` — 主机（契约上恒为 `127.0.0.1`）。
/// * `port` — 端口。
/// * `timeout` — 连接 + 读取的整体超时。
pub async fn probe_status(host: &str, port: u16, timeout: Duration) -> Option<u16> {
    let address = format!("{host}:{port}");
    let mut stream = tokio::time::timeout(timeout, TcpStream::connect(&address))
        .await
        .ok()?
        .ok()?;

    // HTTP/1.0 + Connection: close —— 不需要处理分块编码与 keep-alive。
    let request = format!("GET / HTTP/1.0\r\nHost: {address}\r\nConnection: close\r\n\r\n");
    tokio::time::timeout(timeout, stream.write_all(request.as_bytes()))
        .await
        .ok()?
        .ok()?;

    let mut buffer = Vec::with_capacity(512);
    let mut chunk = [0u8; 512];

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        // 只要拿到状态行就可以收工，不必读完整响应头。
        if let Some(status) = parse_status_line(&buffer) {
            return Some(status);
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        let read = tokio::time::timeout(
            deadline.saturating_duration_since(tokio::time::Instant::now()),
            stream.read(&mut chunk),
        )
        .await
        .ok()?
        .ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > 64 * 1024 {
            break;
        }
    }

    parse_status_line(&buffer)
}

/// 从响应字节中解析状态行里的状态码。
///
/// # 示例
///
/// ```
/// use dsh_host::readiness::parse_status_line;
/// assert_eq!(parse_status_line(b"HTTP/1.1 401 Unauthorized\r\n"), Some(401));
/// ```
pub fn parse_status_line(response: &[u8]) -> Option<u16> {
    let text = std::str::from_utf8(response).ok()?;
    let first_line = text.lines().next()?;
    // "HTTP/1.1 401 Unauthorized"
    first_line.split_whitespace().nth(1)?.parse::<u16>().ok()
}

/// 等待就绪的主循环。
///
/// 探测与「token 是否已知 / 进程是否存活 / 是否端口冲突」全部由调用方以闭包
/// 注入，因此单测无需网络、无需真实子进程。
///
/// # 参数
///
/// * `config` — 轮询参数。
/// * `probe` — 执行一次探测，返回状态码。
/// * `alive` — 子进程是否仍在运行。
/// * `token_known` — 是否已从 stdout 抓到 token。
/// * `port_in_use` — 是否已检测到 `EADDRINUSE`。
///
/// # 示例
///
/// ```
/// use std::time::Duration;
/// use dsh_host::readiness::{wait_for_ready, ProbeConfig, ReadinessOutcome};
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// let outcome = wait_for_ready(
///     &ProbeConfig::fast(Duration::from_secs(1)),
///     || async { Some(401) },
///     || true,
///     || true,
///     || false,
/// ).await;
/// assert_eq!(outcome, ReadinessOutcome::Ready);
/// # }
/// ```
pub async fn wait_for_ready<F, Fut, A, T, P>(
    config: &ProbeConfig,
    mut probe: F,
    mut alive: A,
    mut token_known: T,
    mut port_in_use: P,
) -> ReadinessOutcome
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<u16>>,
    A: FnMut() -> bool,
    T: FnMut() -> bool,
    P: FnMut() -> bool,
{
    let started = tokio::time::Instant::now();
    let deadline = started + config.total_timeout;
    let mut healthy_since: Option<tokio::time::Instant> = None;

    while tokio::time::Instant::now() < deadline {
        if !alive() {
            return ReadinessOutcome::ProcessExited;
        }
        if port_in_use() {
            return ReadinessOutcome::PortInUse;
        }

        let status = probe().await;
        let now = tokio::time::Instant::now();

        if is_healthy(status, token_known()) {
            let since = *healthy_since.get_or_insert(now);
            if now.duration_since(since) >= config.stable_window {
                return ReadinessOutcome::Ready;
            }
        } else {
            healthy_since = None;
        }

        tokio::time::sleep(config.interval).await;
    }

    ReadinessOutcome::Timeout
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn healthy_requires_token_and_service_up() {
        assert!(is_healthy(Some(200), true));
        assert!(is_healthy(Some(401), true));
        assert!(is_healthy(Some(404), true));
        assert!(!is_healthy(Some(401), false));
        assert!(!is_healthy(Some(500), true));
        assert!(!is_healthy(Some(502), true));
        assert!(!is_healthy(None, true));
        assert!(!is_healthy(None, false));
    }

    #[test]
    fn parses_status_line_variants() {
        assert_eq!(parse_status_line(b"HTTP/1.0 200 OK\r\n\r\n"), Some(200));
        assert_eq!(
            parse_status_line(b"HTTP/1.1 401 Unauthorized\r\n"),
            Some(401)
        );
        assert_eq!(
            parse_status_line(b"HTTP/1.1 502 Bad Gateway\r\n"),
            Some(502)
        );
        assert!(parse_status_line(b"not http").is_none());
        assert!(parse_status_line(b"HTTP/1.1 abc Oops\r\n").is_none());
    }

    #[test]
    fn default_config_matches_contract_c4() {
        let config = ProbeConfig::default();
        assert_eq!(config.interval, Duration::from_millis(100));
        assert_eq!(config.stable_window, Duration::from_millis(500));
        assert_eq!(config.total_timeout, crate::contracts::startup_timeout());
    }

    #[tokio::test]
    async fn ready_once_token_known_and_status_in_range() {
        let outcome = wait_for_ready(
            &ProbeConfig::fast(Duration::from_secs(2)),
            || async { Some(401) },
            || true,
            || true,
            || false,
        )
        .await;
        assert_eq!(outcome, ReadinessOutcome::Ready);
    }

    #[tokio::test]
    async fn never_ready_while_token_unknown() {
        let outcome = wait_for_ready(
            &ProbeConfig::fast(Duration::from_millis(120)),
            || async { Some(200) },
            || true,
            || false,
            || false,
        )
        .await;
        assert_eq!(outcome, ReadinessOutcome::Timeout);
    }

    #[tokio::test]
    async fn five_hundred_is_not_healthy_and_times_out() {
        let outcome = wait_for_ready(
            &ProbeConfig::fast(Duration::from_millis(120)),
            || async { Some(500) },
            || true,
            || true,
            || false,
        )
        .await;
        assert_eq!(outcome, ReadinessOutcome::Timeout);
    }

    #[tokio::test]
    async fn process_exit_aborts_immediately() {
        let outcome = wait_for_ready(
            &ProbeConfig::fast(Duration::from_secs(5)),
            || async { Some(200) },
            || false,
            || true,
            || false,
        )
        .await;
        assert_eq!(outcome, ReadinessOutcome::ProcessExited);
    }

    #[tokio::test]
    async fn port_in_use_aborts_immediately() {
        let outcome = wait_for_ready(
            &ProbeConfig::fast(Duration::from_secs(5)),
            || async { None },
            || true,
            || true,
            || true,
        )
        .await;
        assert_eq!(outcome, ReadinessOutcome::PortInUse);
    }

    #[tokio::test]
    async fn stable_window_requires_persistence() {
        // 健康一拍、不健康一拍 → 稳定窗永远凑不满 → 超时。
        let tick = Arc::new(AtomicUsize::new(0));
        let outcome = wait_for_ready(
            &ProbeConfig::fast(Duration::from_millis(120)),
            || {
                let tick = Arc::clone(&tick);
                async move {
                    if tick.fetch_add(1, Ordering::SeqCst) % 2 == 0 {
                        Some(200)
                    } else {
                        None
                    }
                }
            },
            || true,
            || true,
            || false,
        )
        .await;
        assert_eq!(outcome, ReadinessOutcome::Timeout);
    }

    #[tokio::test]
    async fn token_arriving_late_still_becomes_ready() {
        let tick = Arc::new(AtomicUsize::new(0));
        let outcome = wait_for_ready(
            &ProbeConfig::fast(Duration::from_secs(2)),
            || async { Some(401) },
            || true,
            {
                let tick = Arc::clone(&tick);
                move || tick.fetch_add(1, Ordering::SeqCst) > 5
            },
            || false,
        )
        .await;
        assert_eq!(outcome, ReadinessOutcome::Ready);
    }
}
