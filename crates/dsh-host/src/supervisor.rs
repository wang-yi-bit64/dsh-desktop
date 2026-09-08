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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{broadcast, Mutex as AsyncMutex};
use tokio::task::JoinHandle;

use crate::contracts::{
    SUPERVISOR_BACKOFF_INITIAL, SUPERVISOR_BACKOFF_MAX, SUPERVISOR_BACKOFF_MULTIPLIER,
    SUPERVISOR_CHANNEL_CAPACITY, SUPERVISOR_STABLE_UPTIME,
};
use crate::diagnostics::{DiagnosticReport, DiagnosticsAnalyzer};
use crate::launch::{LaunchEvent, LaunchOutcome, Launcher, LauncherConfig, RunningHarness};
use crate::logs::LogRing;
use crate::paths::Layout;
use crate::token::LaunchEndpoint;

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
    /// 附加用户 argv 参数。
    pub extra_args: Vec<String>,
    /// 附加环境变量。
    pub extra_envs: Vec<(String, String)>,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            launcher_config: LauncherConfig::default(),
            max_restarts: 5,
            initial_backoff: SUPERVISOR_BACKOFF_INITIAL,
            max_backoff: SUPERVISOR_BACKOFF_MAX,
            backoff_multiplier: SUPERVISOR_BACKOFF_MULTIPLIER,
            stable_uptime: SUPERVISOR_STABLE_UPTIME,
            host: None,
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
        if task_guard.is_some() {
            // 已在运行
            return;
        }

        self.is_stopping.store(false, Ordering::SeqCst);

        let layout = self.layout.clone();
        let config = self.config.clone();
        let state_tx = self.state_tx.clone();
        let is_stopping = Arc::clone(&self.is_stopping);
        let active_instance = Arc::clone(&self.active_instance);

        let handle = tokio::spawn(async move {
            let mut restart_count = 0usize;
            let mut current_backoff = config.initial_backoff;

            while !is_stopping.load(Ordering::SeqCst) {
                let _ = state_tx.send(SupervisorState::Starting {
                    attempt: restart_count + 1,
                });

                let mut launcher = Launcher::new(layout.clone(), config.launcher_config)
                    .with_extra(config.extra_args.clone());
                if let Some(h) = &config.host {
                    launcher = launcher.with_host(h.clone());
                }

                let outcome = launcher
                    .launch(None, |evt| {
                        let _ = state_tx.send(SupervisorState::LaunchProgress(evt));
                    })
                    .await;

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

                        // 判断是否为稳定运行后崩溃
                        let uptime = started_at.elapsed();
                        if uptime >= config.stable_uptime {
                            restart_count = 0;
                            current_backoff = config.initial_backoff;
                        }

                        // 构建崩溃诊断
                        let diag = DiagnosticsAnalyzer::analyze_log_ring(&live_logs_snapshot);

                        restart_count += 1;
                        let will_restart = restart_count <= config.max_restarts;

                        if will_restart {
                            let _ = state_tx.send(SupervisorState::Crashed {
                                diagnostics: diag,
                                restart_count,
                                will_restart: true,
                                next_backoff: Some(current_backoff),
                            });

                            tokio::time::sleep(current_backoff).await;
                            current_backoff = std::cmp::min(
                                config.max_backoff,
                                Duration::from_secs_f64(
                                    current_backoff.as_secs_f64() * config.backoff_multiplier,
                                ),
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
                        let will_restart = restart_count <= config.max_restarts;

                        if will_restart {
                            let _ = state_tx.send(SupervisorState::Crashed {
                                diagnostics: diag,
                                restart_count,
                                will_restart: true,
                                next_backoff: Some(current_backoff),
                            });

                            tokio::time::sleep(current_backoff).await;
                            current_backoff = std::cmp::min(
                                config.max_backoff,
                                Duration::from_secs_f64(
                                    current_backoff.as_secs_f64() * config.backoff_multiplier,
                                ),
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

        // 终止当前活跃子进程
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

    #[tokio::test]
    async fn test_supervisor_config_and_state_channel() {
        let temp = std::env::temp_dir().join("dsh-supervisor-test");
        let layout = Layout::resolve(temp.join("res"), temp.join("user"));

        let supervisor = Supervisor::new(layout, SupervisorConfig::default());
        let mut rx = supervisor.subscribe();

        assert!(!supervisor.is_running().await);
        let _ = supervisor.state_tx.send(SupervisorState::Idle);

        let received = rx.recv().await.unwrap();
        assert!(matches!(received, SupervisorState::Idle));
    }
}
