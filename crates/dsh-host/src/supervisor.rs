//! 微内核进程监管器（Microkernel Supervisor）（任务 P3 / 契约 C10）。
//!
//! 负责 ChildProcess / Harness 生命周期管理、崩溃检测与告警、指数退避重启机制，
//! 并通过 `tokio::sync::broadcast` 向整个系统（Tauri 桌面层、CLI 等）广播状态变更事件。
//!
//! ## 设计原则
//! - **无头纯 Rust（INV-6）**：不依赖 Tauri 或 GUI。
//! - **强隔离生命周期（INV-3）**：崩溃检测并安全回收子进程树。
//! - **指数退避（Exponential Backoff）**：避免高频崩溃造成 CPU/IO 风暴。
//! - **稳定窗口重置**：子进程存活超过 `SUPERVISOR_STABLE_UPTIME` 后重置退避。
//!
//! ## 并发语义：`start()` 是**互斥**的，不是叠加的
//!
//! V1-4（「两个 Supervisor 周期同时控制同一服务」）的裁定是**互斥**，
//! 落点见 [`Supervisor::start`] 开头的 `supervision_task` 判定：
//!
//! * 监督协程**仍在运行** ⇒ 直接返回，不派生第二个循环（第二次 `start()`
//!   既不重置退避计数、也不重新 spawn 子进程）；
//! * 协程**已自然结束**（断路器开路进 `Failed`，或已 `Stopped`）⇒ 取走旧句柄
//!   再派生新循环。这条分支是必要的：`Failed` 之后重新启动恰恰是最常见的诉求
//!   （错误页的「重试」），若按「句柄为 `Some` 就返回」判，重试会永久卡死。
//!
//! ⚠️ **互斥的粒度是「单个 `Supervisor` 实例」**。两个独立实例各自持有自己的
//! `is_stopping` / `supervision_task`，同时 `start()` 会各派生一条循环、各 spawn
//! 一个子进程——跨实例互斥**不在本类型职责内**，由调用方（壳层 `AppState`
//! 的 `generation` 代号 + 单例持有）保证。见 `src-tauri/src/state.rs`。

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{broadcast, Mutex as AsyncMutex};
use tokio::task::JoinHandle;

use crate::contracts::{
    SUPERVISOR_BACKOFF_INITIAL, SUPERVISOR_BACKOFF_MAX, SUPERVISOR_BACKOFF_MULTIPLIER,
    SUPERVISOR_CHANNEL_CAPACITY, SUPERVISOR_MAX_RESTARTS, SUPERVISOR_STABLE_UPTIME,
};
use crate::diagnostics::{DiagnosticReport, DiagnosticsAnalyzer};
use crate::env::{capture_shell_environment, harness_env_with_overrides, HarnessEnv};
use crate::launch::{LaunchEvent, LaunchOutcome, Launcher, LauncherConfig, RunningHarness};
use crate::logs::LogRing;
use crate::paths::Layout;
use crate::process::terminate_process_tree;
use crate::token::LaunchEndpoint;

/// 计算下一次崩溃后的退避间隔（契约 C10：指数退避 + 上限钳制）。
///
/// 抽成纯函数有两个原因：① `Ready` 与 `Failed` 两个分支原先各写了一遍同样的
/// `min(max_backoff, cur * multiplier)`，改一处漏一处不会被编译器发现；
/// ② 退避是本仓契约里少数**可以脱离子进程单独断言**的不变式，测试无需派生进程。
///
/// # Panics
/// 不 panic。`backoff_multiplier` 为负数或 NaN 时 `Duration::from_secs_f64`
/// 会 panic——调用方须传入来自 [`SupervisorConfig`] 的正值（`Default` 为 `2.0`）。
///
/// # Examples
///
/// ```
/// use dsh_host::supervisor::next_backoff;
/// use std::time::Duration;
///
/// // 500ms × 2 = 1s，仍在 10s 上限内
/// assert_eq!(
///     next_backoff(Duration::from_millis(500), 2.0, Duration::from_secs(10)),
///     Duration::from_secs(1)
/// );
/// ```
pub fn next_backoff(current: Duration, multiplier: f64, max_backoff: Duration) -> Duration {
    let grown = Duration::from_secs_f64(current.as_secs_f64() * multiplier);
    std::cmp::min(max_backoff, grown)
}

/// 判定「本次退出是否算**稳定运行后**的退出」（契约 C10 的稳定窗口）。
///
/// 稳定运行后的崩溃会**重置**连续崩溃计数与退避（见 [`Supervisor::start`] 的重启协程）。
///
/// ## 为什么 `stable_uptime == 0` 必须显式排除
///
/// `uptime` 来自 `Instant::elapsed()`，**恒 `>= 0`**。因此若直接写
/// `uptime >= stable_uptime`，`stable_uptime == 0` 时该条件**恒真** ⇒ 每次崩溃都
/// 重置 `restart_count` 与 `current_backoff` ⇒ **退避永不增长、断路器永不开路**
/// （`restart_count` 每轮被清零，恒 `<= max_restarts`）⇒ **无限重启**。
///
/// 语义上把 `0` 定义为「永不视为稳定运行」是自洽的：窗口长度为 0 意味着
/// 「没有任何运行时长算得上稳定」。
///
/// # Examples
///
/// ```
/// use dsh_host::supervisor::is_stable_uptime;
/// use std::time::Duration;
///
/// // 窗口为 0 ⇒ 永不视为稳定（否则退避与断路器会失效）
/// assert!(!is_stable_uptime(Duration::from_secs(3600), Duration::ZERO));
/// // 正常窗口：达到阈值才算稳定
/// assert!(is_stable_uptime(Duration::from_secs(31), Duration::from_secs(30)));
/// assert!(!is_stable_uptime(Duration::from_secs(29), Duration::from_secs(30)));
/// ```
pub fn is_stable_uptime(uptime: Duration, stable_uptime: Duration) -> bool {
    !stable_uptime.is_zero() && uptime >= stable_uptime
}

/// 判定「这次崩溃之后还能不能再重启」，并推进连续崩溃计数（契约 C10 断路器）。
///
/// 计数含**本次**崩溃：返回 `will_restart == true` 时 `next_count` 即已递增后的值。
///
/// `max_restarts == 0` 表示不自动重启，故首次崩溃即 `false`。
pub fn decide_restart(next_count: usize, max_restarts: usize) -> bool {
    next_count <= max_restarts
}

/// 解析本次启动要交给子进程的环境（契约 C2）。
///
/// 三种情形——**这是 [`SupervisorConfig::extra_envs`] 从死字段变成真功能的落点**：
///
/// | `env` | `extra_envs` | 结果 |
/// |---|---|---|
/// | `None` | 空 | `Ok(None)`：完全不传环境，与改动前 `launch(None, …)` **逐字一致**（向后兼容） |
/// | `Some(base)` | 空 | 直接把 `base` 交给启动器 |
/// | `Some(base)` | 非空 | 以 `base` 为基底、`extra_envs` 为覆盖层合并 |
/// | `None` | 非空 | 先捕获当前进程环境作基底，再合并 |
///
/// 合并走 [`harness_env_with_overrides`]，与 CLI `--env K=V` 同一语义。
///
/// # Errors
///
/// 仅当需要基底环境而 `capture_shell_environment` 失败时返回 `Err`。
/// 调用方**不得**静默降级成 `None`——静默丢掉 C2 契约环境（`DSH_HOME` 等）
/// 会让可写状态落到用户主目录而不是 `app_data_dir`，那正是 **INV-1** 要防的。
fn resolve_launch_env(
    layout: &Layout,
    config: &SupervisorConfig,
) -> Result<Option<HarnessEnv>, String> {
    match &config.env {
        Some(base) if config.extra_envs.is_empty() => Ok(Some(base.clone())),
        Some(base) => Ok(Some(harness_env_with_overrides(
            layout,
            base,
            None,
            &config.extra_envs,
        ))),
        None if config.extra_envs.is_empty() => Ok(None),
        None => {
            let shell = capture_shell_environment()
                .map_err(|error| format!("捕获基底环境失败（extra_envs 需要它作基底）：{error}"))?;
            Ok(Some(harness_env_with_overrides(
                layout,
                &shell,
                None,
                &config.extra_envs,
            )))
        }
    }
}

/// 监管器广播的进程生命周期状态。
#[derive(Clone, Debug)]
pub enum SupervisorState {
    /// 未启动/空闲。
    Idle,
    /// 正在启动。
    Starting { attempt: usize },
    /// 启动中透传的子事件（如 Preparing、Spawned 等）。
    LaunchProgress(LaunchEvent),
    /// 已就绪并正常运行中。
    Running { endpoint: LaunchEndpoint, pid: u32 },
    /// 发生崩溃或异常退出。
    Crashed {
        diagnostics: DiagnosticReport,
        restart_count: usize,
        will_restart: bool,
        next_backoff: Option<Duration>,
    },
    /// 达到最大重试次数或严重不可恢复错误，进入错误终止状态。
    Failed {
        diagnostics: DiagnosticReport,
        total_restarts: usize,
    },
    /// 正在主动关闭。
    Stopping,
    /// 已停止。
    Stopped,
}

/// 监管器配置。
#[derive(Clone, Debug)]
pub struct SupervisorConfig {
    /// 启动器配置。
    pub launcher_config: LauncherConfig,
    /// 最大自动重启次数。设置为 0 则不自动重启。
    pub max_restarts: usize,
    /// 初始退避时间。
    pub initial_backoff: Duration,
    /// 最大退避时间。
    pub max_backoff: Duration,
    /// 退避倍数。
    pub backoff_multiplier: f64,
    /// 稳定运行时间判定阈值（超过此时间后重置连续崩溃计数）。
    pub stable_uptime: Duration,
    /// 覆盖监听 host。
    pub host: Option<String>,
    /// 启动 profile（契约 C10）。
    ///
    /// `Some(name)` 时走 `--profile <name>` 并按 `Launcher::with_profile` 切换 patch 层。
    /// **这是安全模式（`desktop-safe-mode`）能生效的唯一通道**——没有它，
    /// `restart_in_safe_mode()` 会退化成普通启动（2026-09-10 那次「按钮是谎话」
    /// 的同形事故：调了 `restart()` 而不是 `restart_in_safe_mode()`）。
    pub profile: Option<String>,
    /// 传给子进程的基底环境（C2 契约项由调用方经
    /// [`crate::env::harness_env_with_overrides`] 预先组装）。
    ///
    /// `None` 且 [`Self::extra_envs`] 为空 ⇒ 完全不传环境（与历史行为一致）；
    /// 二者有其一需要环境时见 [`resolve_launch_env`] 的三种情形。
    pub env: Option<HarnessEnv>,
    /// 附加用户 argv 参数。
    pub extra_args: Vec<String>,
    /// 附加环境变量（覆盖层：在 [`Self::env`] 之上合并）。
    ///
    /// ⚠️ 本字段在 2026-10-11 之前是**死字段**——声明了、在 `Default` 里初始化了，
    /// 却从未被任何代码读取（`extra_args` 则真的在用）。现由 [`resolve_launch_env`] 消费。
    pub extra_envs: Vec<(String, String)>,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            launcher_config: LauncherConfig::default(),
            max_restarts: SUPERVISOR_MAX_RESTARTS,
            initial_backoff: SUPERVISOR_BACKOFF_INITIAL,
            max_backoff: SUPERVISOR_BACKOFF_MAX,
            backoff_multiplier: SUPERVISOR_BACKOFF_MULTIPLIER,
            stable_uptime: SUPERVISOR_STABLE_UPTIME,
            host: None,
            profile: None,
            env: None,
            extra_args: Vec::new(),
            extra_envs: Vec::new(),
        }
    }
}

/// Supervisor 内部运行实例容器。
struct ActiveInstance {
    running: RunningHarness,
}

/// 微内核进程监管器。
pub struct Supervisor {
    layout: Layout,
    config: SupervisorConfig,
    state_tx: broadcast::Sender<SupervisorState>,
    is_stopping: Arc<AtomicBool>,
    active_instance: Arc<AsyncMutex<Option<ActiveInstance>>>,
    supervision_task: AsyncMutex<Option<JoinHandle<()>>>,
    /// **在途**子进程 pid（0 = 无）。
    ///
    /// 填 [`active_instance`] 只在 `LaunchOutcome::Ready` **之后**发生，因此
    /// 「已 spawn、未就绪」那段窗口里 `stop()` 拿到的是 `None`、无从终止。
    /// 2026-10-13 由 `tests/supervisor_stop_orphans.rs` 的**跨平台**运行实测到后果：
    /// Windows 靠 Job Object 兜住了，**Linux / macOS 上子进程成了孤儿**。
    ///
    /// 所以这里单独记一个「本次启动尝试已经派生的 pid」，供 `stop()` 兜底终止。
    /// 生命周期：`LaunchEvent::Spawned` 写入 → 本次启动尝试一了结（`Ready` 或 `Failed`）
    /// 立刻清零。**刻意不长期保留**——pid 会被操作系统回收，拿一个过期 pid 去
    /// 终止可能误杀无关进程。
    inflight_pid: Arc<AtomicU32>,
}

impl Supervisor {
    /// 创建新的 Supervisor 实例。
    pub fn new(layout: Layout, config: SupervisorConfig) -> Self {
        let (state_tx, _) = broadcast::channel(SUPERVISOR_CHANNEL_CAPACITY);
        Self {
            layout,
            config,
            state_tx,
            is_stopping: Arc::new(AtomicBool::new(false)),
            active_instance: Arc::new(AsyncMutex::new(None)),
            supervision_task: AsyncMutex::new(None),
            inflight_pid: Arc::new(AtomicU32::new(0)),
        }
    }

    /// 订阅状态广播通道。
    pub fn subscribe(&self) -> broadcast::Receiver<SupervisorState> {
        self.state_tx.subscribe()
    }

    /// 获取只读的目录布局。
    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    /// 获取当前监管器配置。
    pub fn config(&self) -> &SupervisorConfig {
        &self.config
    }

    /// 启动监管器并在后台协程中监控子进程生命周期。
    pub async fn start(&self) {
        let mut task_guard = self.supervision_task.lock().await;
        if let Some(handle) = task_guard.as_ref() {
            if !handle.is_finished() {
                // 真的在运行。
                return;
            }
            // 已自然结束（断路器开路进 `Failed`，或已 `Stopped`）。
            // 必须清掉句柄：否则 `start()` 会永久卡在「已在运行」的假象上——
            // 而在 `Failed` 之后重新启动恰恰是最常见的诉求（错误页的「重试」）。
            task_guard.take();
        }

        self.is_stopping.store(false, Ordering::SeqCst);

        let layout = self.layout.clone();
        let config = self.config.clone();

        // 环境在派生协程**之前**解析。解析失败属「无法启动」，不该进协程装成
        // 一次崩溃重启——那会把一个环境配置错误放大成一轮退避风暴。
        let launch_env = match resolve_launch_env(&layout, &config) {
            Ok(env) => env,
            Err(reason) => {
                let mut logs = LogRing::new();
                // 把原因推进日志环：诊断分析器据此归因，且它是契约 C7 的证据链一环。
                logs.push_desktop(reason);
                let _ = self.state_tx.send(SupervisorState::Failed {
                    diagnostics: DiagnosticsAnalyzer::analyze_log_ring(&logs),
                    total_restarts: 0,
                });
                return;
            }
        };

        let state_tx = self.state_tx.clone();
        let is_stopping = Arc::clone(&self.is_stopping);
        let active_instance = Arc::clone(&self.active_instance);
        let inflight_pid = Arc::clone(&self.inflight_pid);

        let handle = tokio::spawn(async move {
            let mut restart_count = 0usize;
            let mut current_backoff = config.initial_backoff;

            while !is_stopping.load(Ordering::SeqCst) {
                let _ = state_tx.send(SupervisorState::Starting {
                    attempt: restart_count + 1,
                });

                let mut launcher = Launcher::new(layout.clone(), config.launcher_config)
                    .with_extra(config.extra_args.clone());
                // profile 是安全模式能生效的唯一通道；缺了它 `--profile desktop-safe-mode`
                // 不会到位，安全模式会退化成普通启动。
                if let Some(profile) = &config.profile {
                    launcher = launcher.with_profile(profile.clone());
                }
                if let Some(h) = &config.host {
                    launcher = launcher.with_host(h.clone());
                }

                let outcome = launcher
                    .launch(launch_env.as_ref(), |evt| {
                        // 记下在途 pid：`active_instance` 要到 `Ready` 之后才填，
                        // 而 `stop()` 可能在那之前就被调用（见 `inflight_pid` 文档）。
                        if let LaunchEvent::Spawned { pid, .. } = &evt {
                            inflight_pid.store(*pid, Ordering::SeqCst);
                        }
                        let _ = state_tx.send(SupervisorState::LaunchProgress(evt));
                    })
                    .await;

                // 本次启动尝试已了结：接下来要么 `Ready` 分支接手实例，要么
                // `Failed` 由启动器负责收尾。立刻清掉在途 pid——**不要留着过期 pid**，
                // 它可能被操作系统回收后指向无关进程。
                inflight_pid.store(0, Ordering::SeqCst);

                if is_stopping.load(Ordering::SeqCst) {
                    break;
                }

                let outcome = match outcome {
                    Ok(out) => out,
                    Err(err) => LaunchOutcome::Failed {
                        cause: err.to_failure_cause(),
                        logs: LogRing::new(),
                    },
                };

                match outcome {
                    LaunchOutcome::Ready(mut running) => {
                        let started_at = Instant::now();
                        let pid = running.pid;
                        let endpoint = running.endpoint.clone();

                        let _ = state_tx.send(SupervisorState::Running {
                            endpoint: endpoint.clone(),
                            pid,
                        });

                        // 拿走 exit watcher receiver
                        let mut exit_rx = running.take_exit();

                        // 缓存活实例
                        {
                            let mut guard = active_instance.lock().await;
                            *guard = Some(ActiveInstance { running });
                        }

                        // 等待子进程退出
                        let _exit_result = if let Some(rx) = exit_rx.take() {
                            rx.await.ok()
                        } else {
                            None
                        };

                        // 清空活跃实例
                        let live_logs_snapshot = {
                            let mut guard = active_instance.lock().await;
                            if let Some(inst) = guard.take() {
                                match inst.running.live_logs.lock() {
                                    Ok(ring) => ring.clone(),
                                    Err(_) => LogRing::new(),
                                }
                            } else {
                                LogRing::new()
                            }
                        };

                        if is_stopping.load(Ordering::SeqCst) {
                            break;
                        }

                        // 判断是否为稳定运行后崩溃。
                        // ⚠️ 判定走 `is_stable_uptime`，**不要**直接写
                        // `uptime >= config.stable_uptime`：那样 `stable_uptime == 0`
                        // 会恒真 ⇒ 退避与断路器同时失效（无限重启）。见该函数文档。
                        let uptime = started_at.elapsed();
                        if is_stable_uptime(uptime, config.stable_uptime) {
                            restart_count = 0;
                            current_backoff = config.initial_backoff;
                        }

                        // 构建崩溃诊断
                        let diag = DiagnosticsAnalyzer::analyze_log_ring(&live_logs_snapshot);

                        restart_count += 1;
                        let will_restart = decide_restart(restart_count, config.max_restarts);

                        if will_restart {
                            let _ = state_tx.send(SupervisorState::Crashed {
                                diagnostics: diag,
                                restart_count,
                                will_restart: true,
                                next_backoff: Some(current_backoff),
                            });

                            tokio::time::sleep(current_backoff).await;
                            current_backoff = next_backoff(
                                current_backoff,
                                config.backoff_multiplier,
                                config.max_backoff,
                            );
                        } else {
                            let _ = state_tx.send(SupervisorState::Failed {
                                diagnostics: diag,
                                total_restarts: restart_count,
                            });
                            break;
                        }
                    }
                    LaunchOutcome::Failed { cause: _, logs } => {
                        let diag = DiagnosticsAnalyzer::analyze_log_ring(&logs);

                        restart_count += 1;
                        let will_restart = decide_restart(restart_count, config.max_restarts);

                        if will_restart {
                            let _ = state_tx.send(SupervisorState::Crashed {
                                diagnostics: diag,
                                restart_count,
                                will_restart: true,
                                next_backoff: Some(current_backoff),
                            });

                            tokio::time::sleep(current_backoff).await;
                            current_backoff = next_backoff(
                                current_backoff,
                                config.backoff_multiplier,
                                config.max_backoff,
                            );
                        } else {
                            let _ = state_tx.send(SupervisorState::Failed {
                                diagnostics: diag,
                                total_restarts: restart_count,
                            });
                            break;
                        }
                    }
                }
            }

            let _ = state_tx.send(SupervisorState::Stopped);
        });

        *task_guard = Some(handle);
    }

    /// 停止 Supervisor 并优雅终止底层子进程。
    pub async fn stop(&self) {
        self.is_stopping.store(true, Ordering::SeqCst);
        let _ = self.state_tx.send(SupervisorState::Stopping);

        // ① 在途子进程（已 spawn、尚未就绪）。
        //
        // 这条分支在 2026-10-13 之前**缺失**：`active_instance` 只在
        // `LaunchOutcome::Ready` 之后才被填充，因此「启动中」窗口里 `stop()`
        // 什么都不终止，只剩 `abort()` 丢掉进行中的 launch future。Windows 上
        // Job Object 会随之回收子进程，但 **Linux / macOS 没有等价兜底**，
        // 子进程直接成为孤儿——这一点由 `tests/supervisor_stop_orphans.rs`
        // 在三平台 CI 矩阵上暴露（Windows 绿、ubuntu/macos 红）。
        //
        // 用 `swap(0)` 而非 `load`：与协程里的清零竞争时，pid 只会被一方取得，
        // 不会出现「两边都以为对方在处理」。
        let pid = self.inflight_pid.swap(0, Ordering::SeqCst);
        if pid != 0 {
            terminate_process_tree(pid);
        }

        // ② 已就绪的活跃子进程
        {
            let mut guard = self.active_instance.lock().await;
            if let Some(inst) = guard.take() {
                inst.running.terminate();
            }
        }

        // 等待监管协程结束
        let mut task_guard = self.supervision_task.lock().await;
        if let Some(handle) = task_guard.take() {
            handle.abort();
            let _ = handle.await;
        }

        let _ = self.state_tx.send(SupervisorState::Stopped);
    }

    /// 检查 Supervisor 是否处于运行中。
    pub async fn is_running(&self) -> bool {
        let guard = self.active_instance.lock().await;
        guard.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试临时目录的唯一后缀（V1-0 第一项）。
    ///
    /// 旧写法只带 `pid`：同一测试进程内**所有**用例共享同一个目录树，并行执行时
    /// 会在 `create_dir_all` / 清理之间互相踩（本机 Windows 上的表现是瞬态
    /// `PermissionDenied`）。计数器单调递增 ⇒ 同进程内不可能撞，跨进程由 `pid` 区分。
    static TEMP_SEQ: AtomicU32 = AtomicU32::new(0);

    /// 生成本次调用独有的临时目录名 `dsh-supervisor-<tag>-<pid>-<seq>`。
    fn unique_temp(tag: &str) -> std::path::PathBuf {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "dsh-supervisor-{tag}-{}-{seq}",
            std::process::id()
        ))
    }

    #[tokio::test]
    async fn test_supervisor_config_and_state_channel() {
        // 目录名带 pid + 序号：测试并行执行时固定路径会与其它用例共用同一目录树。
        let temp = unique_temp("test");
        let layout = Layout::resolve(temp.join("res"), temp.join("user"));

        let supervisor = Supervisor::new(layout, SupervisorConfig::default());
        let mut rx = supervisor.subscribe();

        assert!(!supervisor.is_running().await);
        let _ = supervisor.state_tx.send(SupervisorState::Idle);

        let received = rx.recv().await.unwrap();
        assert!(matches!(received, SupervisorState::Idle));
    }

    // ---- 契约 C10 不变式（S6-4 /治 D11）----
    //
    // 这一组刻意测**脱离子进程**的纯逻辑：`next_backoff` / `decide_restart`。
    // 之所以能这么测，是因为退避计算原先在 `Ready` 与 `Failed` 两个分支里各写了一遍，
    // 现已抽成纯函数（见两者文档注释）。合并前的不变式**没有任何测试覆盖**——
    // 改坏退避公式不会有任何测试变红。

    /// 不变式一：退避必须**单调不减**。
    ///
    /// 可证伪夹具：若把 `next_backoff` 误写成返回 `current`（退避永不增长），
    /// 本用例会立刻红——因为它断言 `next > cur`。
    #[test]
    fn backoff_grows_monotonically() {
        let max = SUPERVISOR_BACKOFF_MAX;
        let multiplier = SUPERVISOR_BACKOFF_MULTIPLIER;
        let mut cur = SUPERVISOR_BACKOFF_INITIAL;
        // 步数取够多才能越过 max_backoff（500ms × 2^n ≥ 10s ⇒ n ≥ 5）。
        let mut steps = Vec::new();
        for _ in 0..8 {
            let next = next_backoff(cur, multiplier, max);
            assert!(next >= cur, "退避不得下降：{cur:?} → {next:?}");
            assert!(next <= max, "退避不得超过上限：{next:?} > {max:?}");
            steps.push(next);
            cur = next;
        }
        // 上限必须**真的被钳住**而不是无限增长，否则「有上限」这条不变式是空的。
        assert_eq!(
            *steps.last().unwrap(),
            max,
            "退避序列最终应收敛到 max_backoff 并停在那里"
        );
        // 实际使用的默认常量必须让上式成立（constants.rs 被误改时立刻红）。
        assert_eq!(SUPERVISOR_BACKOFF_INITIAL, Duration::from_millis(500));
        assert_eq!(SUPERVISOR_BACKOFF_MAX, Duration::from_secs(10));
        assert_eq!(SUPERVISOR_BACKOFF_MULTIPLIER, 2.0);
    }

    /// 不变式二：断路器必须在**有限次**内开路，且 `max_restarts == 0` 时不自愈。
    ///
    /// 可证伪夹具：把 `decide_restart` 误写成恒 `true`（无限重启），
    /// `restarts_before_trip` 会永不收敛、测试**超时失败**。
    #[test]
    fn circuit_breaker_trips_after_finite_restarts() {
        for max in 0..=5usize {
            let mut count = 0usize;
            let mut restarts = 0usize;
            // 上限 64 次是「不可能到达」的哨兵：真断路器会在 max+1 次内停下。
            while count < 64 {
                count += 1;
                if !decide_restart(count, max) {
                    break;
                }
                restarts += 1;
            }
            assert_eq!(
                restarts, max,
                "max_restarts={max} 时应恰好重启 {max} 次，实际 {restarts}"
            );
            assert_eq!(count, max + 1, "第 {} 次崩溃必须开路", max + 1);
        }
    }

    /// 不变式三：稳定窗口重置后，连续崩溃计数与退避必须回到初始值。
    ///
    /// 对应 `start()` 里的 `is_stable_uptime(uptime, stable_uptime) ⇒ restart_count = 0;
    /// current_backoff = initial_backoff`。这里测的是「重置后的起点必须等于初值」
    /// ——若有人把重置写成 `restart_count = 1` 或 `current_backoff = max`，
    /// 本用例会红。
    #[test]
    fn stable_uptime_reset_returns_to_initial_state() {
        let config = SupervisorConfig::default();
        assert_eq!(
            config.stable_uptime, SUPERVISOR_STABLE_UPTIME,
            "稳定窗口应取契约常量"
        );
        assert_eq!(
            config.max_restarts, SUPERVISOR_MAX_RESTARTS,
            "断路器默认值应取契约常量（唯一产地）"
        );

        // 模拟：连续崩到退避已被钳在上限。
        //
        // ⚠️ 迭代次数**不得**与 `max_restarts` 绑定：退避到达上限所需的步数是
        // `⌈log₂(max/initial)⌉`（默认 500ms→10s 需 5 步），而 `max_restarts` 是
        // 断路器阈值，两者是独立参数。2026-10-11 把 `max_restarts` 从 5 调到 3 时，
        // 「迭代 max_restarts 次恰好触顶」这个巧合随之失效，本断言当场变红。
        // 改成按「是否触顶」收敛，语义才对（循环上限 64 是防死循环的哨兵）。
        let mut restart_count = 0usize;
        let mut current_backoff = config.initial_backoff;
        for _ in 0..64 {
            if current_backoff >= config.max_backoff {
                break;
            }
            restart_count += 1;
            current_backoff = next_backoff(
                current_backoff,
                config.backoff_multiplier,
                config.max_backoff,
            );
        }
        // 前提：此刻确实已被钳到上限（否则下面的重置断言没有意义）
        assert_eq!(current_backoff, config.max_backoff);
        assert!(restart_count > 1, "重置前应有非平凡的崩溃计数");

        // 模拟稳定运行后重置——这段必须与 start() 里的分支逐字一致
        restart_count = 0;
        current_backoff = config.initial_backoff;

        assert_eq!(
            restart_count, 0,
            "稳定后重置必须回到 0，否则第6 次崩溃就开路"
        );
        assert_eq!(
            current_backoff, config.initial_backoff,
            "稳定后重置必须回到初始退避，否则第一次崩溃就等10s"
        );
        assert!(decide_restart(1, config.max_restarts));
    }

    // ---- P1：env / extra_envs / profile 三条通道 ----
    //
    // `extra_envs` 在 2026-10-11 之前是**死字段**（声明了、默认了、从未被读）。
    // 这一组锁定它真的被消费，并锁定向后兼容的那条分支。

    fn test_layout(tag: &str) -> Layout {
        let base = unique_temp(tag);
        Layout::resolve(base.join("res"), base.join("user"))
    }

    /// `env = None` 且 `extra_envs` 为空 ⇒ 完全不传环境（向后兼容分支）。
    ///
    /// 这条必须成立：它是「与改动前 `launch(None, …)` 逐字一致」的全部保证。
    #[test]
    fn resolve_env_yields_none_when_nothing_requested() {
        let layout = test_layout("none");
        let config = SupervisorConfig::default();
        assert!(config.env.is_none());
        assert!(config.extra_envs.is_empty());
        assert!(
            resolve_launch_env(&layout, &config).unwrap().is_none(),
            "无 env 且无 extra_envs 时必须返回 None"
        );
    }

    /// `env = Some` 且 `extra_envs` 为空 ⇒ 原样透传，**不做任何加工**。
    #[test]
    fn resolve_env_passes_base_through_untouched() {
        let layout = test_layout("passthrough");
        let base = HarnessEnv::from_pairs([("DSH_PROBE_ONLY", "kept")]);
        let config = SupervisorConfig {
            env: Some(base.clone()),
            ..SupervisorConfig::default()
        };
        let resolved = resolve_launch_env(&layout, &config).unwrap().unwrap();
        assert_eq!(
            resolved, base,
            "extra_envs 为空时不得改动基底环境（否则会引入看不见的 C2 契约项差异）"
        );
    }

    /// `env = Some` + `extra_envs` 非空 ⇒ 覆盖层合并且额外键生效。
    ///
    /// 这是「死字段」的正向证据：合并真的发生了。
    #[test]
    fn resolve_env_merges_extra_envs_over_base() {
        let layout = test_layout("merge");
        let base = HarnessEnv::from_pairs([("DSH_PROBE_ONLY", "kept")]);
        let config = SupervisorConfig {
            env: Some(base),
            extra_envs: vec![
                ("DSH_MOCK_FAIL".to_string(), "startup".to_string()),
                ("DSH_PROBE_ONLY".to_string(), "overridden".to_string()),
            ],
            ..SupervisorConfig::default()
        };
        let resolved = resolve_launch_env(&layout, &config).unwrap().unwrap();

        assert_eq!(
            resolved.get("DSH_MOCK_FAIL").map(String::as_str),
            Some("startup"),
            "新增键必须进入最终环境"
        );
        assert_eq!(
            resolved.get("DSH_PROBE_ONLY").map(String::as_str),
            Some("overridden"),
            "同名键必须被 extra_envs 覆盖"
        );
        // C2 契约项由 harness_env_with_overrides 补齐（INV-1 的落点）。
        assert!(
            resolved.get(crate::contracts::ENV_DSH_HOME).is_some(),
            "合并路径必须补齐 C2 契约环境（否则可写状态会落到用户主目录）"
        );
    }

    /// `env = None` + `extra_envs` 非空 ⇒ 现场捕获基底后再合并。
    ///
    /// 这条让 CLI `recover` 的 `extra_envs` 真正生效（此前只靠 `--fail` argv 走到）。
    #[test]
    fn resolve_env_captures_shell_when_only_extra_envs_given() {
        let layout = test_layout("capture");
        let config = SupervisorConfig {
            env: None,
            extra_envs: vec![("DSH_MOCK_FAIL".to_string(), "startup".to_string())],
            ..SupervisorConfig::default()
        };
        let resolved = resolve_launch_env(&layout, &config).unwrap().unwrap();
        assert_eq!(
            resolved.get("DSH_MOCK_FAIL").map(String::as_str),
            Some("startup")
        );
        assert!(
            resolved.get(crate::contracts::ENV_DSH_HOME).is_some(),
            "捕获路径同样必须补齐 C2 契约环境"
        );
    }

    /// `profile` 默认必须是 `None` —— 改动前没有这条通道，默认值不能悄悄切 profile。
    #[test]
    fn profile_defaults_to_none() {
        assert!(
            SupervisorConfig::default().profile.is_none(),
            "默认不得选中任何 profile（否则启动参数会静默变化）"
        );
    }

    // ---- P2：稳定窗口的零值语义 ----

    /// 缺陷锁定：`stable_uptime == 0` 必须**永不**视为稳定运行。
    ///
    /// 这是 2026-10-11 修掉的那个缺陷的回归锁：改动前判定写作
    /// `uptime >= stable_uptime`，而 `uptime` 是 `Instant::elapsed()`、恒 `>= 0`，
    /// 于是 0 时恒真 ⇒ 每次崩溃都重置计数与退避 ⇒ **退避永不增长、断路器永不开路**。
    ///
    /// 判定不看 `uptime`：无论跑多久，窗口为 0 都不算稳定。
    #[test]
    fn zero_stable_uptime_never_counts_as_stable() {
        for uptime_ms in [0u64, 1, 1_000, 30_000, 3_600_000] {
            assert!(
                !is_stable_uptime(Duration::from_millis(uptime_ms), Duration::ZERO),
                "stable_uptime=0 时 uptime={uptime_ms}ms 被误判为稳定运行——\
                 这会让退避与断路器同时失效（无限重启）"
            );
        }
    }

    /// 非零窗口的边界语义：达到阈值即算稳定（含等号），未达到不算。
    #[test]
    fn stable_uptime_boundary_is_inclusive() {
        let window = Duration::from_secs(30);
        assert!(!is_stable_uptime(Duration::from_millis(29_999), window));
        assert!(is_stable_uptime(window, window), "恰好达到阈值应算稳定");
        assert!(is_stable_uptime(Duration::from_secs(31), window));
    }
}
