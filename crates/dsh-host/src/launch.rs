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
//! ## 双轨结果 API
//!
//! * [`Launcher::launch`] — GUI / 既有调用点：可预期失败折叠成
//!   `Ok(LaunchOutcome::Failed)`，宿主自身故障（目录创建 / 端口预留）才是 `Err`。
//! * [`Launcher::run`] — CLI / 测试：成功即 `Ok(RunningHarness)`，一切失败即 `Err`。
//!
//! 两者共享同一个内部实现 [`Launcher::execute`]，`launch()` 只是折叠层——
//! 单一实现源，避免两条编排路径漂移。
//!
//! ## 所有权说明
//!
//! 派生后子进程被移交给一个 exit watcher 任务（[`RunningHarness::take_exit`]），
//! 启动器只保留 PID 与 Windows Job Object 句柄。这样上层既能用
//! `tokio::select!` 同时监听「就绪」与「运行中崩溃」，又不会因为借用冲突而
//! 无法在失败路径上杀掉子进程。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use crate::args::HarnessArgs;
use crate::contracts::{
    EXIT_REAP_TIMEOUT, LOG_PUMP_DRAIN_DELAY, MAX_PORT_ATTEMPTS, PATTERN_PORT_IN_USE,
    PORT_RETRY_BACKOFF, PORT_ZERO_SUPPORTED,
};
use crate::env::{capture_shell_environment, HarnessEnv};
use crate::logs::{
    extract_failure_cause, FailureCause, LogFile, LogLevel, LogLine, LogRing, LogSource,
};
use crate::paths::Layout;
use crate::process::{now_seconds, sweep_stale_process, terminate_process_tree, PidRecord};
use crate::readiness::{describe_port_mismatch, wait_for_ready, ProbeConfig, ReadinessOutcome};
use crate::token::{parse_launch_line, LaunchEndpoint};
use crate::{HostError, HostResult};

/// 端口分配策略。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PortMode {
    /// 预留 → 释放 → 传递（默认，与原仓库一致）。
    Reserved,
    /// 传 `--port 0`，由内核分配并从 stdout 回报。
    Ephemeral,
    /// 使用调用方指定的固定端口（CLI `--port N`）。
    Fixed(u16),
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
    /// 就绪时刻的日志快照（不再增长；实时日志见 [`Self::live_logs`]）。
    pub logs: LogRing,
    /// **持续追加**的实时日志环形缓冲（日志泵在就绪后继续运行）。
    ///
    /// 就绪后的 harness 输出（模型流式进度、插件诊断）此前会被丢弃，
    /// 排障时完全看不到；本字段补上这一环。
    pub live_logs: Arc<Mutex<LogRing>>,
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

    /// 实时日志的最近 `n` 行（同步接口，GUI / CLI 均可调用）。
    ///
    /// # 示例
    ///
    /// ```
    /// use dsh_host::logs::LogRing;
    /// use std::sync::{Arc, Mutex};
    ///
    /// let live = Arc::new(Mutex::new(LogRing::new()));
    /// live.lock().unwrap().push_desktop("ready");
    /// ```
    pub fn live_tail(&self, count: usize) -> Vec<String> {
        match self.live_logs.lock() {
            Ok(ring) => ring.tail(count),
            Err(_) => Vec::new(),
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

/// 内部执行结果：把「失败 + 日志」打包在一起，让 `launch()` 能折叠成
/// `LaunchOutcome::Failed`、`run()` 能折叠成 `Err`。
enum Execution {
    Ready(RunningHarness),
    Failed { error: HostError, logs: LogRing },
}

/// 启动期间在 tokio 任务之间共享的可变状态。
struct Shared {
    /// 日志缓冲（快照 + live 双消费者，见 [`Launcher::execute`]）。
    logs: LogRing,
    endpoint: Option<LaunchEndpoint>,
}

/// 滚动日志文件在启动器与日志泵之间共享（同步锁，临界区内无 await）。
type SharedLogFile = Arc<Mutex<Option<LogFile>>>;

/// Harness 启动器。
pub struct Launcher {
    layout: Layout,
    config: LauncherConfig,
    /// 监听地址覆盖；`None` 用契约默认 [`crate::contracts::HARNESS_HOST`]。
    host: Option<String>,
    /// 是否禁止 dsh 打开系统浏览器；默认 `true`（C1）。
    no_open: bool,
    /// 用户透传段（`--` 之后的原始参数），追加在契约参数之后。
    extra: Vec<String>,
}

impl Launcher {
    /// 创建启动器。
    pub fn new(layout: Layout, config: LauncherConfig) -> Self {
        Self {
            layout,
            config,
            host: None,
            no_open: true,
            extra: Vec::new(),
        }
    }

    /// 覆盖监听地址（CLI `--host`）。
    pub fn with_host(mut self, host: String) -> Self {
        self.host = Some(host);
        self
    }

    /// 覆盖「禁止打开浏览器」语义（CLI `--open` 时传 `false`）。
    pub fn with_no_open(mut self, no_open: bool) -> Self {
        self.no_open = no_open;
        self
    }

    /// 附加用户透传参数（builder 风格）。
    ///
    /// 不放进 [`LauncherConfig`]：它是 `Copy`，塞 `Vec` 会破坏既有调用点。
    ///
    /// # 示例
    ///
    /// ```
    /// use std::path::Path;
    /// use dsh_host::launch::{Launcher, LauncherConfig};
    /// use dsh_host::paths::Layout;
    ///
    /// let layout = Layout::resolve(Path::new("/res"), Path::new("/data"));
    /// let launcher = Launcher::new(layout, LauncherConfig::default())
    ///     .with_extra(vec!["--profile".into(), "work".into()]);
    /// ```
    pub fn with_extra(mut self, extra: Vec<String>) -> Self {
        self.extra = extra;
        self
    }

    /// 目录布局。
    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    /// 构造某次启动尝试的 argv 集合。
    ///
    /// **argv 的唯一产地**：`execute()` 派生子进程用它，CLI 的 `--print-argv`
    /// 快照也用它，保证「打印出来的」与「真正传下去的」逐字节一致。
    ///
    /// # 示例
    ///
    /// ```
    /// use std::path::Path;
    /// use dsh_host::launch::{Launcher, LauncherConfig};
    /// use dsh_host::paths::Layout;
    ///
    /// let layout = Layout::resolve(Path::new("/res"), Path::new("/data"));
    /// let launcher = Launcher::new(layout, LauncherConfig::default());
    /// let args = launcher.build_args(4173);
    /// assert_eq!(args.dsh_arguments().last().map(String::as_str), Some("4173"));
    /// ```
    pub fn build_args(&self, port: u16) -> HarnessArgs {
        HarnessArgs {
            layout: self.layout.clone(),
            port,
            host: self
                .host
                .clone()
                .unwrap_or_else(|| crate::contracts::HARNESS_HOST.to_string()),
            no_open: self.no_open,
            extra: self.extra.clone(),
        }
    }

    /// 完整执行一次启动（GUI 语义：失败折叠成 `Ok(LaunchOutcome::Failed)`）。
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
        match self.execute(shell, &mut on_event).await? {
            Execution::Ready(running) => Ok(LaunchOutcome::Ready(running)),
            Execution::Failed { error, logs } => {
                Ok(self.fail(error.to_failure_cause(), logs, &mut on_event))
            }
        }
    }

    /// 完整执行一次启动（CLI / 测试语义：成功即 Ready，失败即 `Err`）。
    ///
    /// # 参数
    ///
    /// * `shell` — shell 环境；传 `None` 时内部现场捕获一次。
    /// * `on_event` — 事件回调（同步）。
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
    /// let running = launcher.run(None, |_event| {}).await.unwrap();
    /// println!("listening on {}", running.endpoint.url);
    /// # }
    /// ```
    pub async fn run<E>(
        &self,
        shell: Option<&HarnessEnv>,
        mut on_event: E,
    ) -> HostResult<RunningHarness>
    where
        E: FnMut(LaunchEvent),
    {
        match self.execute(shell, &mut on_event).await? {
            Execution::Ready(running) => Ok(running),
            Execution::Failed { error, .. } => Err(error),
        }
    }

    /// 单一实现源：`launch()` 与 `run()` 都委托到这里。
    async fn execute<E>(
        &self,
        shell: Option<&HarnessEnv>,
        on_event: &mut E,
    ) -> HostResult<Execution>
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
            return Ok(Execution::Failed {
                error: HostError::missing(name, path),
                logs: LogRing::new(),
            });
        }

        // INV-3 兜底：先清掉上一次崩溃残留的进程。
        if let Ok(Some(pid)) = sweep_stale_process(&self.layout) {
            let line = LogLine::new(
                LogSource::Desktop,
                format!("swept stale harness process {pid}"),
            );
            on_event(LaunchEvent::Log(line));
        }

        // stderr 与 stdout 共享同一个滚动文件：排障最关键的错误行此前根本
        // 不落盘，`tail` 读不到（C1 缺陷）。
        let log_file: SharedLogFile =
            Arc::new(Mutex::new(LogFile::open(&self.layout.log_path).ok()));

        let mut attempts = 0usize;
        loop {
            attempts += 1;
            let shared = Arc::new(AsyncMutex::new(Shared {
                logs: LogRing::new(),
                endpoint: None,
            }));
            // D1 修复：闭包是同步 `Fn`，此前用 `try_lock`，锁竞争时把
            // 「token 已抓到」误判成「未知」，无谓推迟就绪。改用原子快照。
            let token_known = Arc::new(AtomicBool::new(false));
            let port_in_use = Arc::new(AtomicBool::new(false));
            // live 日志：就绪后日志泵继续往里写（C5 修复）。
            let live: Arc<Mutex<LogRing>> = Arc::new(Mutex::new(LogRing::new()));

            let port = match self.config.port_mode {
                PortMode::Reserved => reserve_port().await?,
                PortMode::Ephemeral => 0,
                PortMode::Fixed(fixed) => fixed,
            };

            {
                let mut guard = shared.lock().await;
                guard
                    .logs
                    .push_desktop(format!("starting attempt {attempts} on port {port}"));
            }
            push_live(
                &live,
                &LogLine::new(
                    LogSource::Desktop,
                    format!("starting attempt {attempts} on port {port}"),
                ),
            );

            let args = self.build_args(port);
            let spawned = match crate::process::spawn_with_args(&self.layout, &environment, &args) {
                Ok(process) => process,
                // spawn_with_args 返回 HostResult，错误已是 HostError，直接透传。
                Err(error) => {
                    let logs = shared.lock().await.logs.clone();
                    return Ok(Execution::Failed { error, logs });
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
                Arc::clone(&token_known),
                Arc::clone(&port_in_use),
                Arc::clone(&live),
                LogSource::Stdout,
                true,
                Some(Arc::clone(&log_file)),
            );
            let stderr_task = spawn_line_pump(
                stderr,
                Arc::clone(&shared),
                Arc::clone(&token_known),
                Arc::clone(&port_in_use),
                Arc::clone(&live),
                LogSource::Stderr,
                false,
                Some(Arc::clone(&log_file)),
            );

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
                            // B6 修复：单次探测超时来自配置，而不是硬编码。
                            crate::readiness::probe_status(
                                crate::contracts::HARNESS_HOST,
                                port,
                                self.config.probe.probe_timeout,
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
                    let token_known = Arc::clone(&token_known);
                    move || token_known.load(Ordering::SeqCst)
                },
                {
                    let port_in_use = Arc::clone(&port_in_use);
                    move || port_in_use.load(Ordering::SeqCst)
                },
            )
            .await;

            match outcome {
                ReadinessOutcome::Ready => {
                    // C5 修复：就绪后**不** abort 日志泵，让它们随
                    // RunningHarness 生命周期继续运行。
                    let logs = shared.lock().await.logs.clone();
                    let endpoint = match shared.lock().await.endpoint.clone() {
                        Some(endpoint) => endpoint,
                        None => {
                            terminate_process_tree(pid);
                            abort_pumps(&stdout_task, &stderr_task).await;
                            return Ok(Execution::Failed {
                                error: HostError::HarnessFailed(FailureCause::Unknown),
                                logs,
                            });
                        }
                    };

                    // D3 修复：dsh 自行换端口时记 warn（以 stdout 为准，不失败）。
                    // 预留与固定端口两种模式下宿主都声明过端口，才谈得上「不一致」。
                    let port_declared = matches!(
                        self.config.port_mode,
                        PortMode::Reserved | PortMode::Fixed(_)
                    );
                    if port_declared && endpoint.port != port {
                        let warning = describe_port_mismatch(port, endpoint.port);
                        push_live(&live, &LogLine::new(LogSource::Desktop, warning.clone()));
                        record_level(&shared, LogLevel::Warn, &warning).await;
                    }

                    on_event(LaunchEvent::TokenFound {
                        endpoint: endpoint.clone(),
                    });
                    on_event(LaunchEvent::Ready {
                        endpoint: endpoint.clone(),
                    });
                    return Ok(Execution::Ready(RunningHarness {
                        endpoint,
                        pid,
                        logs,
                        live_logs: Arc::clone(&live),
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
                    wait_for_exit(exit_rx, EXIT_REAP_TIMEOUT).await;
                    abort_pumps(&stdout_task, &stderr_task).await;
                    // D2 修复：背靠背重试会在同一瞬间抢占同一端口，退避后再试。
                    tokio::time::sleep(PORT_RETRY_BACKOFF).await;
                    continue;
                }
                other => {
                    terminate_process_tree(pid);
                    let status = wait_for_exit(exit_rx, EXIT_REAP_TIMEOUT).await;
                    abort_pumps(&stdout_task, &stderr_task).await;
                    let logs = shared.lock().await.logs.clone();
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
                    let cause = classify(logs.clone(), fallback.clone());
                    // 归因与兜底同类时用具体错误变体（退出码更精确）；
                    // 否则说明日志里挖出了更细的 Harness 侧原因。
                    let error = if cause.kind() == fallback.kind() {
                        match other {
                            ReadinessOutcome::Timeout => HostError::ReadyTimeout {
                                seconds: self.config.probe.total_timeout.as_secs(),
                            },
                            ReadinessOutcome::PortInUse => HostError::PortInUse { port, attempts },
                            ReadinessOutcome::ProcessExited => HostError::ProcessExited {
                                code: fallback_code(&fallback),
                            },
                            ReadinessOutcome::Ready => unreachable!("Ready 已在上面处理"),
                        }
                    } else {
                        HostError::HarnessFailed(cause)
                    };
                    return Ok(Execution::Failed { error, logs });
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

/// 从兜底归因里提取退出码（仅 `UnexpectedExit` 有）。
fn fallback_code(cause: &FailureCause) -> Option<i32> {
    match cause {
        FailureCause::UnexpectedExit { code } => *code,
        _ => None,
    }
}

/// 等日志泵收尾后中止它们（失败路径专用；就绪路径不再 abort）。
async fn abort_pumps(stdout: &tokio::task::JoinHandle<()>, stderr: &tokio::task::JoinHandle<()>) {
    tokio::time::sleep(LOG_PUMP_DRAIN_DELAY).await;
    stdout.abort();
    stderr.abort();
}

/// 往 live 环形缓冲追加一行（锁中毒时静默丢弃，日志不是关键路径）。
fn push_live(live: &Mutex<LogRing>, line: &LogLine) {
    if let Ok(mut ring) = live.lock() {
        ring.push(line.clone());
    }
}

/// 往共享日志缓冲写一条带级别的宿主诊断行。
async fn record_level(shared: &AsyncMutex<Shared>, level: LogLevel, text: &str) {
    let mut guard = shared.lock().await;
    guard.logs.push_desktop_with(level, text);
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
///
/// 同时写三处：
///
/// 1. `shared.logs` — 启动器的快照缓冲（失败归因 / `LaunchOutcome::Failed.logs`）；
/// 2. `live` — 实时环形缓冲（就绪后继续增长）；
/// 3. `log_file` — 滚动落盘（stdout 与 stderr **都**落盘）。
#[allow(clippy::too_many_arguments)]
fn spawn_line_pump<R>(
    reader: Option<R>,
    shared: Arc<AsyncMutex<Shared>>,
    token_known: Arc<AtomicBool>,
    port_in_use: Arc<AtomicBool>,
    live: Arc<Mutex<LogRing>>,
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
                    token_known.store(true, Ordering::SeqCst);
                }
            }
            if text.contains(PATTERN_PORT_IN_USE) {
                port_in_use.store(true, Ordering::SeqCst);
            }
            let line = LogLine::new(source, text);
            guard.logs.push(line.clone());
            drop(guard);
            push_live(&live, &line);
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
        .map_err(HostError::Port)?;
    let port = listener.local_addr().map_err(HostError::Port)?.port();
    drop(listener);
    Ok(port)
}

/// 公开的端口预留入口（CLI `--print-argv` dry-run 需要展示具体端口）。
///
/// 与 [`PortMode::Reserved`] 的语义一致：绑定 `127.0.0.1:0` 后立即释放，
/// 存在 TOCTOU 窗口（计划 R-2），仅供展示与测试使用。
///
/// # 示例
///
/// ```no_run
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// let port = dsh_host::launch::reserve_ephemeral_port().await.unwrap();
/// assert!(port > 0);
/// # }
/// ```
pub async fn reserve_ephemeral_port() -> HostResult<u16> {
    reserve_port().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::PROBE_TIMEOUT;

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

    /// B6 修复的回归护栏：默认探测超时来自契约常量，不再是死字段。
    #[test]
    fn probe_timeout_comes_from_config() {
        assert_eq!(ProbeConfig::default().probe_timeout, PROBE_TIMEOUT);
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

    /// C3 修复的回归护栏：起始标记必须来自契约常量。
    #[test]
    fn latest_attempt_uses_contract_marker() {
        let mut logs = LogRing::new();
        logs.push(LogLine::new(LogSource::Stderr, "old failure from last run"));
        logs.push_desktop("starting attempt 2 on port 4173");
        logs.push(LogLine::new(LogSource::Stderr, "new failure"));

        let attempt: Vec<String> = logs
            .latest_attempt()
            .into_iter()
            .map(|line| line.text.clone())
            .collect();
        assert_eq!(attempt, vec!["new failure"]);
    }

    #[test]
    fn running_harness_live_tail_reads_ring() {
        let live = Arc::new(Mutex::new(LogRing::new()));
        live.lock().unwrap().push_desktop("ready line");
        let running = RunningHarness {
            endpoint: LaunchEndpoint {
                url: "http://127.0.0.1:4173/?token=t".parse().unwrap(),
                token: "t".to_string(),
                host: "127.0.0.1".to_string(),
                port: 4173,
            },
            pid: 1,
            logs: LogRing::new(),
            live_logs: Arc::clone(&live),
            exit: None,
            #[cfg(windows)]
            _job: None,
        };
        assert_eq!(running.live_tail(10), vec!["[desktop] ready line"]);
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
    async fn missing_resources_surface_as_err_in_run() {
        let unique = format!(
            "dsh-host-launch-run-{}-{}",
            std::process::id(),
            now_seconds()
        );
        let root = std::env::temp_dir().join(unique);
        let layout = Layout::resolve(root.join("res"), root.join("data"));
        let launcher = Launcher::new(layout, LauncherConfig::default());

        // RunningHarness 不派生 Debug（含 OS 句柄），用 match 代替 unwrap_err。
        let error = match launcher.run(None, |_| {}).await {
            Ok(_) => panic!("expected missing-resource error, got Ok"),
            Err(error) => error,
        };
        assert_eq!(error.exit_code(), crate::contracts::EXIT_MISSING_RESOURCE);
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

    #[tokio::test]
    async fn with_extra_passes_args_through_to_argv() {
        // 不派生进程：missing_resources 会先失败，但 argv 已经由
        // HarnessArgs 构造，这里验证 builder 的透传链路连通。
        let unique = format!("dsh-host-extra-{}-{}", std::process::id(), now_seconds());
        let root = std::env::temp_dir().join(unique);
        let layout = Layout::resolve(root.join("res"), root.join("data"));
        let launcher = Launcher::new(layout, LauncherConfig::default())
            .with_extra(vec!["--fail".into(), "startup".into()]);

        let outcome = launcher.launch(None, |_| {}).await.unwrap();
        assert!(!outcome.is_ready());
        let _ = std::fs::remove_dir_all(&root);
    }
}
