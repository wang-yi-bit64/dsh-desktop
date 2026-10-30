//! 就绪探测（契约 C4）。
//!
//! 手写 HTTP/1.0 探测（`tokio::net::TcpStream`），不引入 reqwest / hyper：
//! 这里只需要「一个状态码」，依赖越少越好（INV-5 离线可用 + 编译时间）。
//!
//! 就绪语义（对齐原仓库 `harness-runtime.ts`；2026-09-30 修订稳定窗条款）：
//!
//! * 健康 = **token 已知** 且 `200 ≤ status < 500`（`GET /` 不带 token 返回 401
//!   属正常，所以区间下界不能是 200 的「成功」语义，而是「服务已起」）；
//! * token 只会出现在上游自报的 URL 行上（`dsh web: http://…/?token=…`），而上游
//!   只有真正开始监听并完成鉴权初始化才会打印该行。因此「一次探测健康 + token 已知」
//!   已经是**两次独立确认**（上游自报 + 本端 HTTP 确认），不再额外要求稳定窗。
//!   取代旧条款「连续 500ms 稳定窗」的理由：它让**每一次**启动都固定多等 500ms，
//!   却防不住「第 501ms 才崩」——真崩了由 Supervisor 与错误页兜底，不该让全体用户
//!   为一个低频尾部风险买单（2026-09-30 启动耗时优化的实测结论）。
//! * 轮询间隔 50ms；总超时 Windows 120s、其它平台 45s。
//!
//! ## 判据顺序：端口冲突 > 存亡（2026-10-12 修订）
//!
//! 「子进程因 `EADDRINUSE` 退出」与「子进程因别的原因退出」在**观测层面**几乎
//! 无法区分，只能靠日志泵把 `port_in_use` 置位。而「置位」与「`child.wait()`
//! 返回」是两个独立的异步事实，谁先被看到不确定：
//!
//! ```text
//!   子进程：stderr 写 EADDRINUSE ──▶ exit()
//!              │                      │
//!        日志泵读管道            exit watcher 的 wait() 返回
//!              │                      │
//!        置位 port_in_use        置位 exit_flag        ← 两者竞速
//! ```
//!
//! 若先看 `alive()`，一次**本可换端口重试**的冲突就被判成不可重试的
//! [`ReadinessOutcome::ProcessExited`]——用户看到「启动失败」而不是「重试」（C1）。
//! 因此本模块的判据顺序是：
//!
//! 1. `port_in_use()` 为真 ⇒ `PortInUse`（最先，且每轮都先查）；
//! 2. `!alive()` ⇒ 先等一个**日志泵排空宽限**（[`LOG_PUMP_DRAIN_DELAY`]）再复查
//!    `port_in_use()`，仍为假才返回 `ProcessExited`。
//!
//! 第 2 步的宽限是本修订的**关键**：只把 `port_in_use()` 提前到 `alive()` 之前
//! 是无效的——两者读的是同一瞬间的同一个原子量，冲突行还在管道里时依然读不到。
//! 宽限只在「就绪前退出」这条失败路径上付出（生产 50ms），换来归因正确。

use std::future::Future;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::contracts::{
    HEALTHY_STATUS_MAX, HEALTHY_STATUS_MIN, LOG_PUMP_DRAIN_DELAY, PROBE_TIMEOUT,
};

/// 就绪探测参数。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProbeConfig {
    /// 轮询间隔（默认 50ms；回环上 connect-refused 几乎零成本）。
    pub interval: Duration,
    /// 单次探测超时（默认取 [`crate::contracts::PROBE_TIMEOUT`]，800ms）。
    pub probe_timeout: Duration,
    /// 总超时（默认取 [`crate::contracts::startup_timeout`]）。
    pub total_timeout: Duration,
}

impl Default for ProbeConfig {
    fn default() -> Self {
        Self {
            interval: Duration::from_millis(50),
            probe_timeout: PROBE_TIMEOUT,
            total_timeout: crate::contracts::startup_timeout(),
        }
    }
}

impl ProbeConfig {
    /// 测试用：把间隔压到毫秒级，总超时显式给定。
    pub fn fast(total_timeout: Duration) -> Self {
        Self {
            interval: Duration::from_millis(1),
            probe_timeout: Duration::from_millis(50),
            total_timeout,
        }
    }
}

/// 描述「预留端口与 dsh 自报端口不一致」这一异常（C1 端口策略）。
///
/// `Reserved` 模式下我们绑定 `127.0.0.1:0` 预留一个端口再传给 dsh，但 dsh
/// 有可能自己换了端口并在 stdout 的 URL 里回报。此时**以 stdout 为准**
/// （那是 dsh 自报的事实），同时记一条 warn 供排障。
///
/// # 示例
///
/// ```
/// use dsh_host::readiness::describe_port_mismatch;
///
/// let message = describe_port_mismatch(4173, 5000);
/// assert!(message.contains("4173"));
/// assert!(message.contains("5000"));
/// ```
pub fn describe_port_mismatch(reserved: u16, reported: u16) -> String {
    format!("port mismatch: reserved {reserved}, reported {reported}")
}

/// 就绪等待结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessOutcome {
    /// 已就绪（探测健康且 token 已知——上游自报 + HTTP 双确认）。
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
/// 就绪判据是**双确认**：探测健康（`200 ≤ status < 500`）且 token 已知。token
/// 只会出现在上游自报的 URL 行上（见模块文档），所以健康本身已隐含「上游自报」
/// ——首次双确认即刻就绪，不再叠加稳定窗。
///
/// 失败判据的**顺序**有讲究：`port_in_use` 先于 `alive`，且判定 `ProcessExited`
/// 之前有一次性排空宽限（见模块文档「判据顺序」）。这两点是 C1「换端口重试」
/// 能真正生效的前提，不是可以随手调换的实现细节。
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

    // 就绪前退出后的宽限：让日志泵有机会把管道里剩余的 `EADDRINUSE` 行读出来
    // 并置位。取 `max(interval, LOG_PUMP_DRAIN_DELAY)`：生产是 50ms；测试用的
    // `ProbeConfig::fast` 间隔 1ms 时也不会退化成「几乎不宽限」。
    let exit_grace = config.interval.max(LOG_PUMP_DRAIN_DELAY);

    while tokio::time::Instant::now() < deadline {
        // ① 端口冲突优先（判据顺序见模块文档）。子进程因 EADDRINUSE 退出时，
        // 「日志泵置位」与「exit watcher 观测到退出」在竞速，先看 alive() 会把
        // 一次可重试的冲突判成不可重试的 ProcessExited。
        if port_in_use() {
            return ReadinessOutcome::PortInUse;
        }
        if !alive() {
            // ② 进程已死，但那一行冲突可能还在管道里。给日志泵一个排空窗口
            // 再复查一次——这一步只在失败路径上付出，最多 `exit_grace`。
            // 单纯的「调换检查顺序」在这里无效：两者读的是同一瞬间的原子量。
            tokio::time::sleep(exit_grace).await;
            return if port_in_use() {
                ReadinessOutcome::PortInUse
            } else {
                ReadinessOutcome::ProcessExited
            };
        }

        let status = probe().await;

        if is_healthy(status, token_known()) {
            return ReadinessOutcome::Ready;
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
        assert_eq!(config.interval, Duration::from_millis(50));
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

    /// 进程退出且**始终没有**冲突标志 ⇒ 才是 `ProcessExited`。
    ///
    /// 这是 [`dead_process_with_port_in_use_flag_is_port_in_use`] 的反方向：
    /// 修「冲突被误判成退出」时不得把「退出」也一并误判成冲突。
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

    /// **端口冲突优先于存亡判定**：进程已死 + 标志已置 ⇒ 必须报 `PortInUse`，
    /// 且**不再**付出排空宽限（标志已在手，没有理由再等）。
    ///
    /// 钉住的是 C1 的真实后果：真实 harness 打印 `EADDRINUSE` 后**立刻**退出
    /// （不像 mock 会保活 2s）。若此时先看 `alive()`，这次冲突会被归因成
    /// `UnexpectedExit`——不可重试——于是本该「换端口再试 2 次」的启动直接失败。
    #[tokio::test]
    async fn dead_process_with_port_in_use_flag_is_port_in_use() {
        let started = tokio::time::Instant::now();
        let outcome = wait_for_ready(
            &ProbeConfig::fast(Duration::from_secs(5)),
            || async { None },
            || false, // 进程已死
            || false,
            || true, // 但冲突标志已置
        )
        .await;
        let elapsed = started.elapsed();

        assert_eq!(
            outcome,
            ReadinessOutcome::PortInUse,
            "进程已死但端口冲突标志已置 ⇒ 应报 PortInUse（可重试），\
             而不是不可重试的 ProcessExited"
        );
        assert!(
            elapsed < LOG_PUMP_DRAIN_DELAY,
            "标志已置时不应再等排空宽限（耗时 {elapsed:?}）——\
             说明 `port_in_use()` 没有排在 `alive()` 之前"
        );
    }

    /// **排在管道里的冲突行不得丢失**：标志在「观测到退出之后」才置位，仍须报
    /// `PortInUse`。
    ///
    /// 只调换 `port_in_use()` 与 `alive()` 的先后是**无效修复**——两者读同一瞬间
    /// 的同一个原子量，冲突行还在管道里时照样读不到。真正的修复是给日志泵一个
    /// 排空窗口。本用例用「第一次读到假、之后读到真」的假标志模拟该时间差：
    ///
    /// * 删掉宽限复查 ⇒ 第二次读永远不会发生 ⇒ 退回 `ProcessExited`；
    /// * 删掉循环头的 `port_in_use()` ⇒ 宽限里那一次读拿到的是 `false` ⇒ 同上。
    #[tokio::test]
    async fn port_in_use_set_after_exit_is_not_lost() {
        let reads = Arc::new(AtomicUsize::new(0));
        let outcome = wait_for_ready(
            &ProbeConfig::fast(Duration::from_secs(5)),
            || async { None },
            || false,
            || false,
            {
                let reads = Arc::clone(&reads);
                move || reads.fetch_add(1, Ordering::SeqCst) > 0
            },
        )
        .await;

        assert_eq!(
            outcome,
            ReadinessOutcome::PortInUse,
            "冲突行在观测到退出之后才被日志泵读到，仍必须归因为 PortInUse\
             （实际读了 {} 次标志）",
            reads.load(Ordering::SeqCst)
        );
        assert!(
            reads.load(Ordering::SeqCst) >= 2,
            "必须发生第二次读（宽限复查），实际只读了 {} 次",
            reads.load(Ordering::SeqCst)
        );
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
    async fn announced_single_healthy_probe_is_ready() {
        // 旧「稳定窗」语义下这个场景会超时（健康一拍、不健康一拍凑不满窗）；
        // 新语义下「上游已自报 + 一次 HTTP 确认」即可就绪。此测试钉住该语义变化：
        // 稳定窗已废除，若有人把它加回来（针对已自报的上游），本测试会变红。
        // 第一次探测返回健康，之后全部失败——就绪判定不再依赖持续采样。
        let tick = Arc::new(AtomicUsize::new(0));
        let outcome = wait_for_ready(
            &ProbeConfig::fast(Duration::from_secs(2)),
            || {
                let tick = Arc::clone(&tick);
                async move {
                    if tick.fetch_add(1, Ordering::SeqCst) == 0 {
                        Some(401)
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
        assert_eq!(outcome, ReadinessOutcome::Ready);
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
