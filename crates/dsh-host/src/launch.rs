//! 启动编排：把 spawn → 日志泵 → token 解析 → 就绪探测串成一条可复用链路
//! （契约 C1–C7）。
//!
//! 放在 `dsh-host` 而不是 Tauri 层，是为了不变量 **INV-6（可测试性）**：
//! `dsh-host-cli start` 与 `cargo test -p dsh-host` 都能在没有窗口、没有 GUI
//! 依赖的前提下跑完整条链路。Tauri 侧只把 [`LaunchEvent`] 映射成
//! `HarnessPhase` 并转发给前端。
//!
//! 端口策略（任务 1.3）：
//!
//! * `Reserved`：绑定 `127.0.0.1:0` 预留端口后释放再传给子进程（存在 TOCTOU
//!   窗口，与原仓库一致）；
//! * `Ephemeral`：直接传 `--port 0`，由内核分配、从 stdout URL 回报真实端口
//!   ——彻底消除竞态。是否可用取决于 Harness 是否支持（Spike 结论回填
//!   [`crate::contracts::PORT_ZERO_SUPPORTED`]）。
//!
//! 无论哪种模式，stderr 出现 `EADDRINUSE` 都会触发**快速失败 + 换端口重试**
//! （最多 [`crate::contracts::MAX_PORT_ATTEMPTS`] 次），而不是干等 120s 超时。
//!
//! ## 所有权说明
//!
//! 派生后子进程被移交给一个 exit watcher 任务（[`RunningHarness::exit`]），
//! 启动器只保留 PID 与 Windows Job Object 句柄。这样上层既能用
//! `tokio::select!` 同时监听「就绪」与「运行中崩溃」，又不会因为借用冲突而
//! 无法在失败路径上杀掉子进程。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

use crate::contracts::{MAX_PORT_ATTEMPTS, PATTERN_PORT_IN_USE, PORT_ZERO_SUPPORTED};
use crate::env::{capture_shell_environment, HarnessEnv};
use crate::logs::{extract_failure_cause, FailureCause, LogFile, LogLine, LogRing, LogSource};
use crate::paths::Layout;
use crate::process::{now_seconds, sweep_stale_process, terminate_process_tree, PidRecord};
use crate::readiness::{wait_for_ready, ProbeConfig, ReadinessOutcome};
use crate::token::{parse_launch_line, LaunchEndpoint};
use crate::HostResult;

/// 端口分配策略。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PortMode {
    /// 预留 → 释放 → 传递（默认，与原仓库一致）。
    Reserved,
    /// 传 `--port 0`，由内核分配并从 stdout 回报。
    Ephemeral,
}

/// 启动参数。
#[derive(Clone, Copy, Debug)]
pub struct LauncherConfig {
    /// 就绪探测参数。
    pub probe: ProbeConfig,
    /// 端口分配策略。
    pub port_mode: PortMode,
    /// 端口冲突时的最大尝试次数（含首次）。
    pub max_port_attempts: usize,
}

impl Default for LauncherConfig {
    fn default() -> Self {
        Self {
            probe: ProbeConfig::default(),
            port_mode: if PORT_ZERO_SUPPORTED {
                PortMode::Ephemeral
            } else {
                PortMode::Reserved
            },
            max_port_attempts: MAX_PORT_ATTEMPTS,
        }
    }
}

/// 启动过程中的事件（供上层映射成状态机相位）。
#[derive(Clone, Debug)]
pub enum LaunchEvent {
    /// 准备阶段：资源定位、目录创建、陈旧进程清扫。
    Preparing,
    /// 已派生子进程。
    Spawned { pid: u32, port: u16 },
    /// 已抓到启动 token。
    TokenFound { endpoint: LaunchEndpoint },
    /// 进入就绪探测。
    ReadyChecking { port: u16 },
    /// 就绪。
    Ready { endpoint: LaunchEndpoint },
    /// 失败。
    Failed { cause: FailureCause },
    /// 一条日志（实时透传给上层，便于 splash 页显示进度）。
    Log(LogLine),
}

/// 已就绪的 Harness 实例。
///
/// 持有 Windows Job Object 与 exit watcher 通道：**只要本结构存活，子进程就
/// 属于本次启动**；一旦它被 drop，Job Object 句柄关闭，内核回收整棵进程树
/// （INV-3）。
pub struct RunningHarness {
    /// 已就绪的端点（含 token）。
    pub endpoint: LaunchEndpoint,
    /// 子进程 PID。
    pub pid: u32,
    /// 本次启动的日志。
    pub logs: LogRing,
    /// exit watcher：就绪之后子进程退出会在这里兑现（一次性）。
    exit: Option<oneshot::Receiver<std::io::Result<std::process::ExitStatus>>>,
    #[cfg(windows)]
    _job: Option<win32job::Job>,
}

impl RunningHarness {
    /// 取出 exit watcher 通道（只能取一次；取出后 [`Self::wait_exit`] 不再可用）。
    ///
    /// 上层用 `tokio::select!` 同时监听「退出」与其它事件时使用。
    pub fn take_exit(
        &mut self,
    ) -> Option<oneshot::Receiver<std::io::Result<std::process::ExitStatus>>> {
        self.exit.take()
    }

    /// 等待子进程退出（若通道已被取走则立即返回 `None`）。
    pub async fn wait_exit(&mut self) -> Option<std::io::Result<std::process::ExitStatus>> {
        match self.exit.take() {
            Some(receiver) => receiver.await.ok(),
            None => None,
        }
    }

    /// 平台级终止（不依赖 `Child` 句柄，失败路径亦可调用）。
    pub fn terminate(&self) {
        terminate_process_tree(self.pid);
    }
}

/// 启动结果。
pub enum LaunchOutcome {
    /// 就绪：调用方接管 [`RunningHarness`]（**必须**保管好，Drop 会触发平台回收）。
    Ready(RunningHarness),
    /// 失败。
    Failed {
        /// 归因结果。
        cause: FailureCause,
        /// 日志快照（供错误页展示尾部日志）。
        logs: LogRing,
    },
}

impl LaunchOutcome {
    /// 是否成功。
    pub fn is_ready(&self) -> bool {
        matches!(self, LaunchOutcome::Ready(_))
    }

    /// 就绪时返回端点。
    pub fn endpoint(&self) -> Option<&LaunchEndpoint> {
        match self {
            LaunchOutcome::Ready(running) => Some(&running.endpoint),
            LaunchOutcome::Failed { .. } => None,
        }
    }
}

/// 启动期间在 tokio 任务之间共享的可变状态。
#[derive(Default)]
struct Shared {
    logs: LogRing,
    endpoint: Option<LaunchEndpoint>,
    port_in_use: bool,
}

/// 滚动日志文件在启动器与日志泵之间共享（同步锁，临界区内无 await）。
type SharedLogFile = Arc<std::sync::Mutex<Option<LogFile>>>;

/// Harness 启动器。
pub struct Launcher {
    layout: Layout,
    config: LauncherConfig,
}

impl Launcher {
    /// 创建启动器。
    pub fn new(layout: Layout, config: LauncherConfig) -> Self {
        Self { layout, config }
    }

    /// 目录布局。
    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    /// 完整执行一次启动。
    ///
    /// # 参数
    ///
    /// * `shell` — shell 环境；传 `None` 时内部现场捕获一次。
    /// * `on_event` — 事件回调（同步；上层若要发 IPC 事件请自行 spawn）。
    ///
    /// # 示例
    ///
    /// ```no_run
    /// use dsh_host::launch::{Launcher, LauncherConfig};
    /// use dsh_host::paths::Layout;
    ///
    /// # #[tokio::main]
    /// # async fn main() {
    /// let layout = Layout::resolve("resources", "userdata");
    /// let launcher = Launcher::new(layout, LauncherConfig::default());
    /// let outcome = launcher.launch(None, |_event| {}).await.unwrap();
    /// println!("ready = {}", outcome.is_ready());
    /// # }
    /// ```
    pub async fn launch<E>(
        &self,
        shell: Option<&HarnessEnv>,
        mut on_event: E,
    ) -> HostResult<LaunchOutcome>
    where
        E: FnMut(LaunchEvent),
    {
        on_event(LaunchEvent::Preparing);

        let environment = match shell {
            Some(environment) => environment.clone(),
            None => capture_shell_environment()?,
        };

        self.layout.ensure_dirs()?;
        if let Some((name, path)) = self.layout.missing_resources().into_iter().next() {
            return Ok(self.fail(
                FailureCause::MissingResource {
                    name: name.to_string(),
                    path: path.display().to_string(),
                },
                LogRing::new(),
                &mut on_event,
            ));
        }

        // INV-3 兜底：先清掉上一次崩溃残留的进程。
        if let Ok(Some(pid)) = sweep_stale_process(&self.layout) {
            let line = LogLine::new(
                LogSource::Desktop,
                format!("swept stale harness process {pid}"),
            );
            on_event(LaunchEvent::Log(line));
        }

        let log_file: SharedLogFile = Arc::new(std::sync::Mutex::new(
            LogFile::open(&self.layout.log_path).ok(),
        ));

        let mut attempts = 0usize;
        loop {
            attempts += 1;
            let shared = Arc::new(Mutex::new(Shared::default()));

            let port = match self.config.port_mode {
                PortMode::Reserved => reserve_port().await?,
                PortMode::Ephemeral => 0,
            };

            {
                let mut guard = shared.lock().await;
                guard
                    .logs
                    .push_desktop(format!("starting attempt {attempts} on port {port}"));
            }

            let spawned = match crate::process::spawn(&self.layout, &environment, port) {
                Ok(process) => process,
                Err(error) => {
                    let logs = shared.lock().await.logs.clone();
                    return Ok(self.fail(
                        FailureCause::SpawnFailed {
                            detail: error.to_string(),
                        },
                        logs,
                        &mut on_event,
                    ));
                }
            };

            let pid = spawned.id().unwrap_or(0);
            on_event(LaunchEvent::Spawned { pid, port });

            let _ = crate::process::write_pid_file(
                &self.layout,
                &PidRecord {
                    pid,
                    port,
                    resource_dir: self.layout.resource_dir.clone(),
                    started_at: now_seconds(),
                },
            );

            // 拆开 HarnessProcess：管道交给日志泵，Child 交给 exit watcher，
            // Job Object 留在启动器（决定进程树的生死）。
            let parts = spawned.into_parts();
            let mut child = parts.child;
            let stdout = parts.stdout;
            let stderr = parts.stderr;
            #[cfg(windows)]
            let job = parts.job;

            let exit_flag = Arc::new(AtomicBool::new(false));
            let (exit_tx, exit_rx) = oneshot::channel();
            {
                let exit_flag = Arc::clone(&exit_flag);
                tokio::spawn(async move {
                    let status = child.wait().await;
                    exit_flag.store(true, Ordering::SeqCst);
                    let _ = exit_tx.send(status);
                });
            }

            let stdout_task = spawn_line_pump(
                stdout,
                Arc::clone(&shared),
                LogSource::Stdout,
                true,
                Some(Arc::clone(&log_file)),
            );
            let stderr_task =
                spawn_line_pump(stderr, Arc::clone(&shared), LogSource::Stderr, false, None);

            on_event(LaunchEvent::ReadyChecking { port });

            let outcome = wait_for_ready(
                &self.config.probe,
                {
                    let shared = Arc::clone(&shared);
                    move || {
                        let shared = Arc::clone(&shared);
                        async move {
                            let port = shared
                                .lock()
                                .await
                                .endpoint
                                .as_ref()
                                .map(|endpoint| endpoint.port)
                                .unwrap_or(port);
                            if port == 0 {
                                return None;
                            }
                            crate::readiness::probe_status(
                                crate::contracts::HARNESS_HOST,
                                port,
                                Duration::from_millis(800),
                            )
                            .await
                        }
                    }
                },
                {
                    let exit_flag = Arc::clone(&exit_flag);
                    move || !exit_flag.load(Ordering::SeqCst)
                },
                {
                    let shared = Arc::clone(&shared);
                    move || {
                        shared
                            .try_lock()
                            .map(|guard| guard.endpoint.is_some())
                            .unwrap_or(false)
                    }
                },
                {
                    let shared = Arc::clone(&shared);
                    move || {
                        shared
                            .try_lock()
                            .map(|guard| guard.port_in_use)
                            .unwrap_or(false)
                    }
                },
            )
            .await;

            // 让日志泵把剩余输出收干净，然后收工。
            tokio::time::sleep(Duration::from_millis(50)).await;
            stdout_task.abort();
            stderr_task.abort();

            let logs = shared.lock().await.logs.clone();

            match outcome {
                ReadinessOutcome::Ready => {
                    let endpoint = match shared.lock().await.endpoint.clone() {
                        Some(endpoint) => endpoint,
                        None => {
                            terminate_process_tree(pid);
                            return Ok(self.fail(FailureCause::Unknown, logs, &mut on_event));
                        }
                    };
                    on_event(LaunchEvent::TokenFound {
                        endpoint: endpoint.clone(),
                    });
                    on_event(LaunchEvent::Ready {
                        endpoint: endpoint.clone(),
                    });
                    return Ok(LaunchOutcome::Ready(RunningHarness {
                        endpoint,
                        pid,
                        logs,
                        exit: Some(exit_rx),
                        #[cfg(windows)]
                        _job: job,
                    }));
                }
                ReadinessOutcome::PortInUse if attempts < self.config.max_port_attempts => {
                    on_event(LaunchEvent::Log(LogLine::new(
                        LogSource::Desktop,
                        format!(
                            "port {port} in use, retrying ({attempts}/{})",
                            self.config.max_port_attempts
                        ),
                    )));
                    terminate_process_tree(pid);
                    wait_for_exit(exit_rx, Duration::from_secs(2)).await;
                    continue;
                }
                other => {
                    terminate_process_tree(pid);
                    let status = wait_for_exit(exit_rx, Duration::from_secs(2)).await;
                    let fallback = match other {
                        ReadinessOutcome::Timeout => FailureCause::StartupTimeout {
                            seconds: self.config.probe.total_timeout.as_secs(),
                        },
                        ReadinessOutcome::PortInUse => FailureCause::PortInUse {
                            detail: format!("port {port} is already in use"),
                        },
                        ReadinessOutcome::ProcessExited => FailureCause::UnexpectedExit {
                            code: status
                                .and_then(|status| status.ok())
                                .and_then(|status| status.code()),
                        },
                        ReadinessOutcome::Ready => unreachable!("Ready 已在上面处理"),
                    };
                    let cause = classify(logs.clone(), fallback);
                    return Ok(self.fail(cause, logs, &mut on_event));
                }
            }
        }
    }

    fn fail<E>(&self, cause: FailureCause, logs: LogRing, on_event: &mut E) -> LaunchOutcome
    where
        E: FnMut(LaunchEvent),
    {
        on_event(LaunchEvent::Failed {
            cause: cause.clone(),
        });
        LaunchOutcome::Failed { cause, logs }
    }
}

/// 用日志归因覆盖兜底原因（C7 优先于泛化原因）。
fn classify(logs: LogRing, fallback: FailureCause) -> FailureCause {
    let attempt: Vec<LogLine> = logs.latest_attempt().into_iter().cloned().collect();
    extract_failure_cause(&attempt).unwrap_or(fallback)
}

/// 等待 exit watcher 兑现（超时放弃，避免失败路径卡死）。
async fn wait_for_exit(
    receiver: oneshot::Receiver<std::io::Result<std::process::ExitStatus>>,
    timeout: Duration,
) -> Option<std::io::Result<std::process::ExitStatus>> {
    tokio::time::timeout(timeout, receiver).await.ok()?.ok()
}

/// 启动一条按行读取的日志泵。
fn spawn_line_pump<R>(
    reader: Option<R>,
    shared: Arc<Mutex<Shared>>,
    source: LogSource,
    look_for_token: bool,
    log_file: Option<SharedLogFile>,
) -> tokio::task::JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let Some(mut lines) = reader.map(BufReader::new) else {
            return;
        };
        let mut buffer = Vec::with_capacity(1024);
        loop {
            buffer.clear();
            match lines.read_until(b'\n', &mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }

            let text = crate::logs::sanitize_line(&buffer);
            if text.trim().is_empty() {
                continue;
            }

            let mut guard = shared.lock().await;
            if guard.endpoint.is_none() && look_for_token {
                if let Some(endpoint) = parse_launch_line(&text) {
                    guard.endpoint = Some(endpoint);
                }
            }
            if text.contains(PATTERN_PORT_IN_USE) {
                guard.port_in_use = true;
            }
            let line = LogLine::new(source, text);
            guard.logs.push(line.clone());
            if let Some(file) = log_file.as_ref() {
                if let Ok(mut file) = file.lock() {
                    if let Some(file) = file.as_mut() {
                        let _ = file.append_line(&line.to_string());
                    }
                }
            }
        }
    })
}

/// 预留一个回环端口（绑定 0 后立即释放）。
async fn reserve_port() -> HostResult<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(crate::HostError::Port)?;
    let port = listener
        .local_addr()
        .map_err(crate::HostError::Port)?
        .port();
    drop(listener);
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_follows_port_spike_conclusion() {
        let config = LauncherConfig::default();
        let expected = if PORT_ZERO_SUPPORTED {
            PortMode::Ephemeral
        } else {
            PortMode::Reserved
        };
        assert_eq!(config.port_mode, expected);
        assert_eq!(config.max_port_attempts, MAX_PORT_ATTEMPTS);
    }

    #[test]
    fn classify_prefers_logged_cause_over_fallback() {
        let mut logs = LogRing::new();
        logs.push_desktop("starting attempt 1 on port 4173");
        logs.push(LogLine::new(
            LogSource::Stderr,
            "DSH entry failed: plugin broke",
        ));
        let cause = classify(logs, FailureCause::StartupTimeout { seconds: 45 });
        assert_eq!(cause.kind(), "dsh_entry_failed");
    }

    #[test]
    fn classify_keeps_fallback_when_logs_are_silent() {
        let mut logs = LogRing::new();
        logs.push_desktop("starting attempt 1 on port 4173");
        let cause = classify(logs, FailureCause::StartupTimeout { seconds: 45 });
        assert_eq!(cause.kind(), "startup_timeout");
    }

    #[tokio::test]
    async fn reserve_port_returns_ephemeral_port() {
        let port = reserve_port().await.unwrap();
        assert!(port > 0);
    }

    #[test]
    fn launch_outcome_helpers() {
        let logs = LogRing::new();
        let failed = LaunchOutcome::Failed {
            cause: FailureCause::Unknown,
            logs,
        };
        assert!(!failed.is_ready());
        assert!(failed.endpoint().is_none());
    }

    #[tokio::test]
    async fn missing_resources_fail_fast_without_spawning() {
        let unique = format!("dsh-host-launch-{}-{}", std::process::id(), now_seconds());
        let root = std::env::temp_dir().join(unique);
        let layout = Layout::resolve(root.join("res"), root.join("data"));
        let launcher = Launcher::new(layout, LauncherConfig::default());

        let mut events = Vec::new();
        let outcome = launcher
            .launch(None, |event| events.push(event))
            .await
            .unwrap();

        assert!(!outcome.is_ready());
        assert!(events
            .iter()
            .any(|event| matches!(event, LaunchEvent::Failed { cause } if cause.kind() == "missing_resource")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn token_survives_ansi_wrapped_output() {
        // 端到端最小验证：ANSI 包裹的 URL 行经清洗后仍可被解析。
        let raw = b"\x1b[36mdsh web:\x1b[0m http://127.0.0.1:4173/?token=abc\n";
        let text = crate::logs::sanitize_line(raw);
        let endpoint = parse_launch_line(&text).unwrap();
        assert_eq!(endpoint.token, "abc");
        assert_eq!(endpoint.port, 4173);
    }
}
