//! Harness 状态机（§3.2）与共享应用状态。
//!
//! ```text
//!   Idle ──start──▶ Preparing ──▶ Starting ──▶ ReadyChecking ──▶ Ready { url }
//!                     │               │              │                │
//!                     ▼               ▼              ▼                │ (exit watcher:
//!                   Failed ◀──────────┴──────────────┘                │  非零/任意退出)
//!                     ▲                                               ▼
//!                     └───────────────────────────────────────────── Failed
//!   Stopping ──▶ Stopped ──(菜单「重启」)──▶ Preparing（新端口新 token，重新导航）
//! ```
//!
//! 对照原仓库 `RuntimePhase`，语义对齐但补上了 **Ready 后崩溃** 路径。
//!
//! 事件驱动源：launch 事件、exit watcher、IPC 命令、菜单事件。
//! 每次状态变化都会 `app.emit("harness://status", snapshot)`——只有本地
//! 静态页能收到（远程 harness 页没有 remote capability，任务 1.4）。

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use dsh_host::contracts::{AUTH_COOKIE_PREFIX, WINDOWS_QUERY_MODE, WINDOWS_QUERY_PLATFORM};
use dsh_host::launch::{LaunchEvent, LaunchOutcome, Launcher, LauncherConfig, RunningHarness};
use dsh_host::logs::{FailureCause, LogLine, LogRing, LogSource};
use dsh_host::paths::Layout;
use dsh_host::token::LaunchEndpoint;

use crate::window;

/// 状态变化事件名（前端 `listen` 用）。
pub const STATUS_EVENT: &str = "harness://status";

/// Harness 状态机相位（§3.2）。
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum HarnessPhase {
    /// 尚未启动 / 已停止后的静止态。
    Idle,
    /// 资源定位、env 解析、launch-root 清扫。
    Preparing,
    /// 已 spawn，等待 stdout token 行。
    Starting,
    /// token 已知，就绪探测中。
    ReadyChecking,
    /// 已就绪（即将 / 已经导航到 harness UI）。
    Ready { url: String },
    /// 任意阶段失败（含 Ready 后 crash 退回）。
    Failed {
        /// 结构化归因类别（`FailureCause::kind()`）。
        cause_kind: String,
        /// 人类可读归因。
        cause: String,
        /// 是否疑似第三方插件故障（阶段 5 据此给安全模式入口）。
        plugin_fault: bool,
        /// 是否值得自动换端口重试。
        retryable: bool,
    },
    /// SIGTERM → 4s → SIGKILL 停止中。
    Stopping,
    /// 子进程已完全退出。
    Stopped,
}

/// 推送给前端的完整快照。
///
/// `HarnessPhase` 是 tagged enum，序列化后与 `message` / `logs` 平铺在同一层。
#[derive(Clone, Debug, Serialize)]
pub struct HarnessSnapshot {
    /// 当前相位。
    pub phase: HarnessPhase,
    /// 人类可读的进度描述。
    pub message: String,
    /// 环形日志尾部。
    pub logs: Vec<String>,
}

struct SupervisorInner {
    phase: HarnessPhase,
    message: String,
    logs: LogRing,
    running: Option<RunningHarness>,
}

impl Default for SupervisorInner {
    fn default() -> Self {
        Self {
            phase: HarnessPhase::Idle,
            message: "Harness is not running.".to_string(),
            logs: LogRing::new(),
            running: None,
        }
    }
}

/// Harness 生命周期监督者。
///
/// 持有 [`RunningHarness`]（内含 Windows Job Object）：只要监督者存活，
/// 「父死子亡」的内核守护就一直在线。
pub struct HarnessSupervisor {
    app: AppHandle,
    layout: Layout,
    config: LauncherConfig,
    inner: Mutex<SupervisorInner>,
}

impl HarnessSupervisor {
    /// 创建监督者（不启动）。
    pub fn new(app: AppHandle, layout: Layout, config: LauncherConfig) -> Self {
        Self {
            app,
            layout,
            config,
            inner: Mutex::new(SupervisorInner::default()),
        }
    }

    /// 只读布局（命令层打开日志等用）。
    #[allow(dead_code)] // 命令层直接读 state.layout 字段；此访问器留给后续阶段。
    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    /// 当前快照。
    pub fn snapshot(&self) -> HarnessSnapshot {
        let inner = self.inner.lock().unwrap();
        HarnessSnapshot {
            phase: inner.phase.clone(),
            message: inner.message.clone(),
            logs: inner.logs.tail(200),
        }
    }

    /// 是否处于 Ready。
    #[allow(dead_code)] // 阶段 3 UI 逻辑预留。
    pub fn is_ready(&self) -> bool {
        matches!(self.inner.lock().unwrap().phase, HarnessPhase::Ready { .. })
    }

    /// 当前 harness 实例端口（导航白名单据此放行）。
    ///
    /// 只有 `Ready` 相位才返回端口——旧实例的 URL 不能靠残留状态放行。
    pub fn harness_port(&self) -> Option<u16> {
        let inner = self.inner.lock().unwrap();
        match &inner.phase {
            HarnessPhase::Ready { url } => {
                url::Url::parse(url).ok().and_then(|parsed| parsed.port())
            }
            _ => None,
        }
    }

    /// 启动 Harness（若已有实例先停止）。
    pub async fn start(self: &Arc<Self>) {
        self.stop().await;

        let launcher = Launcher::new(self.layout.clone(), self.config);
        let supervisor = Arc::clone(self);
        let outcome = launcher
            .launch(None, move |event| supervisor.apply_launch_event(event))
            .await;

        match outcome {
            Ok(LaunchOutcome::Ready(mut running)) => {
                // exit watcher：Ready 之后子进程退出 → Failed → 错误页。
                let exit = running.take_exit();
                {
                    let mut inner = self.inner.lock().unwrap();
                    inner.running = Some(running);
                }
                if let Some(exit) = exit {
                    let supervisor = Arc::clone(self);
                    tauri::async_runtime::spawn(async move {
                        let status = exit.await.ok();
                        supervisor.handle_post_ready_exit(status);
                    });
                }
            }
            Ok(LaunchOutcome::Failed { .. }) | Err(_) => {
                // apply_launch_event 已经处理过 Failed（导航 + 事件）。
            }
        }
    }

    /// 停止 Harness（SIGTERM → 4s → SIGKILL，Windows 走 taskkill /T /F）。
    pub async fn stop(&self) {
        let mut running = {
            let mut inner = self.inner.lock().unwrap();
            inner.running.take()
        };
        let Some(mut running) = running.take() else {
            let mut inner = self.inner.lock().unwrap();
            if matches!(inner.phase, HarnessPhase::Failed { .. }) {
                inner.message = "Harness is not running.".to_string();
            } else {
                inner.phase = HarnessPhase::Idle;
                inner.message = "Harness is not running.".to_string();
            }
            self.emit();
            return;
        };

        {
            let mut inner = self.inner.lock().unwrap();
            inner.phase = HarnessPhase::Stopping;
            inner.message = "Stopping Harness…".to_string();
            inner.push_desktop("stopping harness".to_string());
        }
        self.emit();

        running.terminate();
        let exit = running.wait_exit().await;

        let mut inner = self.inner.lock().unwrap();
        inner.phase = HarnessPhase::Stopped;
        inner.message = "Harness stopped.".to_string();
        match exit {
            Some(Ok(status)) => inner.push_desktop(format!(
                "harness stopped (exit code {})",
                status.code().unwrap_or(-1)
            )),
            Some(Err(error)) => inner.push_desktop(format!("harness stop failed: {error}")),
            None => {}
        }
        drop(inner);
        self.emit();
    }

    /// 重启（菜单 / 错误页「重试」）。
    pub async fn restart(self: &Arc<Self>) {
        self.start().await;
    }

    /// 取最近 `count` 行日志。
    pub fn logs_tail(&self, count: usize) -> Vec<String> {
        self.inner.lock().unwrap().logs.tail(count)
    }

    /// 清空日志（重启前调用，避免上一次的日志混进本次归因）。
    #[allow(dead_code)] // 重启路径当前走状态机内部清理；此方法留给后续阶段。
    pub fn clear_logs(&self) {
        self.inner.lock().unwrap().logs.clear();
    }

    // ------------------------------------------------------------------
    // 内部
    // ------------------------------------------------------------------

    /// 把 launch 事件映射为状态机迁移（同步回调，全部走 try_lock）。
    fn apply_launch_event(&self, event: LaunchEvent) {
        match event {
            LaunchEvent::Log(line) => {
                let mut inner = match self.inner.try_lock() {
                    Ok(inner) => inner,
                    Err(_) => return,
                };
                inner.logs.push(line);
                return;
            }
            LaunchEvent::Preparing => self.transition(
                HarnessPhase::Preparing,
                "Preparing to start DeepSeek Harness…",
            ),
            LaunchEvent::Spawned { pid, port } => self.transition(
                HarnessPhase::Starting,
                &format!("Harness process spawned (pid {pid}, port {port})"),
            ),
            LaunchEvent::TokenFound { .. } => {
                let mut inner = match self.inner.try_lock() {
                    Ok(inner) => inner,
                    Err(_) => return,
                };
                inner.message = "Launch token acquired.".to_string();
                inner.push_desktop("launch token acquired".to_string());
                return;
            }
            LaunchEvent::ReadyChecking { port } => self.transition(
                HarnessPhase::ReadyChecking,
                &format!("Probing 127.0.0.1:{port} …"),
            ),
            LaunchEvent::Ready { endpoint } => self.on_ready(endpoint),
            LaunchEvent::Failed { cause } => self.on_failed(cause),
        }
        self.emit();
    }

    fn on_ready(&self, endpoint: LaunchEndpoint) {
        // C12：Windows 追加桌面模式参数；titlebar-inset 留待阶段 2 决策。
        let extra: &[(&str, &str)] = if cfg!(windows) {
            &[WINDOWS_QUERY_MODE, WINDOWS_QUERY_PLATFORM]
        } else {
            &[]
        };
        let url = endpoint.navigate_url(extra);

        {
            let mut inner = self.inner.lock().unwrap();
            inner.phase = HarnessPhase::Ready {
                url: url.to_string(),
            };
            inner.message = "Harness is ready.".to_string();
            inner.push_desktop(format!("ready → {url}"));
        }

        // 任务 1.5：导航前清掉陈旧的 dsh-auth-* cookie（HTTP 431 防护）。
        if let Some(webview) = window::main_window(&self.app) {
            let removed = crate::cookies::clear_auth_cookies(&webview, AUTH_COOKIE_PREFIX);
            if let Ok(removed) = removed {
                if removed.removed > 0 {
                    self.inner.lock().unwrap().push_desktop(format!(
                        "cleared {} stale {AUTH_COOKIE_PREFIX}* cookies",
                        removed.removed
                    ));
                }
            }
            let _ = webview.navigate(url.clone());
        }
        self.emit();
    }

    fn on_failed(&self, cause: FailureCause) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.phase = HarnessPhase::Failed {
                cause_kind: cause.kind().to_string(),
                cause: cause.to_string(),
                plugin_fault: cause.is_plugin_fault(),
                retryable: cause.is_retryable(),
            };
            inner.message = cause.to_string();
            inner.push_desktop(format!("failed: {cause}"));
        }
        window::show_error_page(&self.app);
    }

    /// exit watcher 兑现：Ready 之后子进程退出（无论码值）→ Failed。
    fn handle_post_ready_exit(&self, status: Option<std::io::Result<std::process::ExitStatus>>) {
        let is_ready = {
            let inner = self.inner.lock().unwrap();
            matches!(inner.phase, HarnessPhase::Ready { .. })
        };
        if !is_ready {
            // 已被 stop() 收走或已进入失败态，不再覆盖。
            return;
        }

        let code = status
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .and_then(|exit| exit.code());
        {
            let mut inner = self.inner.lock().unwrap();
            inner.running = None;
            inner.push_desktop(match code {
                Some(code) => format!("harness exited after ready (exit code {code})"),
                None => "harness exited after ready".to_string(),
            });
        }
        let fallback = FailureCause::UnexpectedExit { code };
        let cause = {
            let inner = self.inner.lock().unwrap();
            let attempt: Vec<LogLine> = inner.logs.latest_attempt().into_iter().cloned().collect();
            dsh_host::logs::extract_failure_cause(&attempt).unwrap_or(fallback)
        };
        self.on_failed(cause);
        self.emit();
    }

    fn transition(&self, phase: HarnessPhase, message: &str) {
        let mut inner = match self.inner.try_lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        inner.phase = phase;
        inner.message = message.to_string();
        inner.push_desktop(message.to_string());
    }

    fn emit(&self) {
        let _ = self.app.emit(STATUS_EVENT, self.snapshot());
    }
}

impl SupervisorInner {
    fn push_desktop(&mut self, text: String) {
        self.logs.push(LogLine::new(LogSource::Desktop, text));
    }
}

/// 供 `tauri::Builder::manage` 使用的应用状态。
pub struct AppState {
    /// Harness 监督者。
    pub supervisor: Arc<HarnessSupervisor>,
    /// 目录布局（只读）。
    pub layout: Layout,
    /// 手机桥接（阶段 4 完整接线）。
    pub mobile: Arc<crate::mobile_bridge::MobileBridge>,
    /// 更新管理器（阶段 6 完整接线）。
    pub updates: Arc<tokio::sync::Mutex<Option<Arc<crate::update::UpdateManager>>>>,
    /// 窗口当前是否在展示 harness UI。
    #[allow(dead_code)] // 前端 show/hide 逻辑接线时启用（阶段 3）。
    pub harness_loaded: tokio::sync::Mutex<bool>,
}

impl AppState {
    /// 组装应用状态。
    pub fn new(
        supervisor: Arc<HarnessSupervisor>,
        layout: Layout,
        mobile: Arc<crate::mobile_bridge::MobileBridge>,
    ) -> Self {
        Self {
            supervisor,
            layout,
            mobile,
            updates: Arc::new(tokio::sync::Mutex::new(None)),
            harness_loaded: tokio::sync::Mutex::new(false),
        }
    }

    /// 从 Tauri 状态取回（供命令守卫后的各命令使用）。
    #[allow(dead_code)] // 阶段 3 命令面扩展预留。
    pub fn from_app<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<Self>> {
        app.try_state::<Arc<AppState>>()
            .map(|state| Arc::clone(&state))
    }
}
