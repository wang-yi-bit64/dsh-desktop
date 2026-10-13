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

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use dsh_host::contracts::{
    AUTH_COOKIE_PREFIX, SUPERVISOR_BACKOFF_INITIAL, SUPERVISOR_BACKOFF_MAX,
    SUPERVISOR_BACKOFF_MULTIPLIER, SUPERVISOR_MAX_RESTARTS, SUPERVISOR_STABLE_UPTIME,
    WINDOWS_QUERY_MODE, WINDOWS_QUERY_PLATFORM,
};
use dsh_host::launch::{LaunchEvent, LauncherConfig};
use dsh_host::logs::{FailureCause, LogLine, LogRing, LogSource};
use dsh_host::paths::Layout;
use dsh_host::supervisor::{Supervisor, SupervisorConfig, SupervisorState};
use dsh_host::token::LaunchEndpoint;

use crate::poison;
use crate::window;

/// 状态变化事件名（前端 `listen` 用）。
pub const STATUS_EVENT: &str = "harness://status";

/// Harness 状态机相位（§3.2）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
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

/// 状态桥对一条 L2 状态要做的事（**纯决策**，不含任何副作用）。
///
/// ## 为什么把决策单独抽出来
///
/// `HarnessSupervisor` 需要真实 `AppHandle` 才能构造，因此「映射对不对」这件事
/// 在单元测试里**够不到**（`state.rs` 原有的测试只能测序列化）。把决策抽成不依赖
/// Tauri 的纯函数后，最容易错、且错了**编译不会报错**的两条就能被断言钉住：
///
///   · 崩溃**重试期间不得进错误页**（否则退避重试时错误页会反复闪现）；
///   · `Stopped`/`Stopping` 桥**不得处理**（否则与用户点「停止」互相覆盖）。
#[derive(Debug, PartialEq, Eq)]
enum StateAction {
    /// 迁移到该相位并设置文案。
    Transition(HarnessPhase, String),
    /// 相位不动，只更新文案（例如「崩溃 #2，500ms 后重试」）。
    Message(String),
    /// 交给 `LaunchEvent` 分支处理（日志 / Ready / ReadyChecking / 启动失败）。
    ViaLaunchEvent,
    /// 终态：进错误页。
    Terminal,
    /// 桥不处理（`stop()` 自己拥有，或已由 `Ready` 事件覆盖）。
    Ignore,
}

/// 把一条 L2 状态分类成 [`StateAction`]（纯函数，可单测）。
fn classify_state(state: &SupervisorState) -> StateAction {
    match state {
        SupervisorState::Starting { attempt } => {
            if *attempt <= 1 {
                StateAction::Transition(
                    HarnessPhase::Preparing,
                    "Preparing to start DeepSeek Harness…".to_string(),
                )
            } else {
                StateAction::Transition(
                    HarnessPhase::Starting,
                    format!("Restarting Harness (attempt {attempt})…"),
                )
            }
        }
        SupervisorState::LaunchProgress(_) => StateAction::ViaLaunchEvent,
        // `Running` 的端点已由 `LaunchEvent::Ready` 写入；再处理一次会重复执行
        // `on_ready` 的导航副作用。
        SupervisorState::Running { .. } => StateAction::Ignore,
        SupervisorState::Crashed {
            restart_count,
            will_restart,
            next_backoff,
            diagnostics,
            ..
        } => {
            if *will_restart {
                let delay = next_backoff
                    .map(|d| format!("{}ms", d.as_millis()))
                    .unwrap_or_else(|| "…".to_string());
                StateAction::Message(format!(
                    "Harness crashed (#{restart_count}); retrying in {delay}"
                ))
            } else {
                // 下一次状态就是终态 `Failed`；这里只留证据，**不进错误页**。
                StateAction::Message(format!(
                    "crash budget exhausted at #{restart_count}: {}",
                    diagnostics.summary
                ))
            }
        }
        SupervisorState::Failed { .. } => StateAction::Terminal,
        // 由 `stop()` 拥有，桥不参与（见 `StateAction` 文档）。
        SupervisorState::Idle | SupervisorState::Stopping | SupervisorState::Stopped => {
            StateAction::Ignore
        }
    }
}

/// 推送给前端的完整快照。
///
/// # 为什么 `phase` 必须带 `#[serde(flatten)]`
///
/// 这是一个**契约**：`phase` 的 tag 与 `message` / `logs` 平铺在同一层，即
/// `{"phase":"failed","cause_kind":…,"plugin_fault":true,"message":…}`，与上游
/// `RuntimeStatus`（`contracts.ts`：`phase` 是一个同级字符串字段）一致。
///
/// 此前本文件**写了这句话但漏了属性**，于是 `HarnessPhase` 被当作普通字段嵌套，
/// 实际发出的是 `{"phase":{"phase":"failed",…}}`。后果不是格式难看，而是
/// `frontend/error.html` 的判据 `snapshot.phase === 'failed'` **恒为 false**：
/// 「疑似插件故障 → 建议进入安全模式」那条分支从未生效，安全模式按钮也从未露面。
/// 2026-09-10 由 serde 探针实测确认（`cargo run` 打印真实 JSON）并修复。
///
/// 改动这一行之前请先读 `snapshot_json_keeps_the_phase_tag_flat` 测试。
#[derive(Clone, Debug, Serialize)]
pub struct HarnessSnapshot {
    /// 当前相位。**必须 flattened**——理由见上。
    #[serde(flatten)]
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
    /// 最近一次就绪的端点（退出检查用：拿 host/port/首航 token）。
    ///
    /// `on_ready` 写入，停止时清空。**不**从
    /// `HarnessPhase::Ready { url }` 反推——那个 URL 是给 webview 导航用的
    /// （带 C12 参数与可能已被消费的 token），不含原始 token。
    ///
    /// 注：子进程实例本身归 **L2**（`dsh_host::Supervisor`）持有，壳层不再保存
    /// `RunningHarness`——2026-10-11 的 L1→L2 接线把「持有实例 + 自己终止」
    /// 整件事交给了 `Supervisor::stop()`。
    endpoint: Option<LaunchEndpoint>,
}

impl Default for SupervisorInner {
    fn default() -> Self {
        Self {
            phase: HarnessPhase::Idle,
            message: "Harness is not running.".to_string(),
            logs: LogRing::new(),
            endpoint: None,
        }
    }
}

/// Harness 生命周期监督者。
///
/// ## L1 → L2 接线（2026-10-11）
///
/// 本类型是 **L2（[`dsh_host::Supervisor`]）的适配器**，不是它的替代品：
/// 「派生子进程 + 就绪探测 + 崩溃自愈（退避 / 断路器 / 有界重启）」全部由 L2 负责，
/// 本类型只负责**面向 UI 的那一层**——相位、日志环形缓冲、`harness://status`
/// 广播、导航、错误页、托盘与退出守卫。
///
/// 为什么是适配器而不是替换：`HarnessPhase` 承载的信息比 `SupervisorState`
/// **更多**（`plugin_fault` / `retryable` / `Ready { url }`），替换会把这些
/// 错误页与托盘状态行的输入丢掉。分层职责见
/// `docs/dev-plan-supervisor-shell-wiring.md` §2.2。
///
/// 公开方法面**保持不变**——`commands.rs` / `menu.rs` / `quit_guard.rs` 零改动。
pub struct HarnessSupervisor {
    app: AppHandle,
    layout: Layout,
    config: LauncherConfig,
    inner: Mutex<SupervisorInner>,
    /// 当前 L2 监管器；`None` 表示尚未启动或已停止。
    ///
    /// 用 `tokio::sync::Mutex` 而非 `std::sync::Mutex`：`stop()` 需要在 `await`
    /// 期间持有它（`take` 出来再 await 结束 L2），跨 await 持有同步锁是明确禁止的。
    supervisor: tokio::sync::Mutex<Option<Arc<Supervisor>>>,
    /// 状态桥的**代号**。每次启动自增；桥接任务只在代号与自己相符时应用状态。
    ///
    /// 防的是这类竞态：上一轮运行的桥在读到通道 `Closed` 之前，可能已经投递了
    /// 一两个迟到状态（例如 `Stopped`），把**新一轮**的相位改掉。代号让迟到的
    /// 状态直接作废，而不是靠「桥退出得够快」这种时序假设。
    generation: AtomicU64,
}

impl HarnessSupervisor {
    /// 创建监督者（不启动）。
    pub fn new(app: AppHandle, layout: Layout, config: LauncherConfig) -> Self {
        Self {
            app,
            layout,
            config,
            inner: Mutex::new(SupervisorInner::default()),
            supervisor: tokio::sync::Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }

    /// 加锁；锁中毒时恢复 guard 而不是 panic（D10 / S4-4，见 [`crate::poison`]）。
    ///
    /// 这里**不能**用 `lock().unwrap()`：poison 会让本结构此后每一次加锁都
    /// panic，而每个 IPC 命令都要经过这些方法——一次事故会升级成整个壳瘫痪。
    fn lock_inner(&self) -> MutexGuard<'_, SupervisorInner> {
        poison::lock_or_recover(&self.inner)
    }

    /// [`Self::lock_inner`] 的非阻塞版本：忙则放弃本次事件，中毒则恢复后照常处理。
    fn try_lock_inner(&self) -> Option<MutexGuard<'_, SupervisorInner>> {
        poison::try_lock_or_recover(&self.inner)
    }

    /// 当前快照。
    pub fn snapshot(&self) -> HarnessSnapshot {
        let inner = self.lock_inner();
        HarnessSnapshot {
            phase: inner.phase.clone(),
            message: inner.message.clone(),
            logs: inner.logs.tail(200),
        }
    }

    /// 最近一次就绪的 Harness 端点（Harness 没在跑时为 `None`）。
    ///
    /// 退出前的「有没有会话在跑」检查靠它拿 `host` / `port` / 首航 token
    /// （见 [`crate::quit_guard`]）。刻意不复用 [`Self::ready_url`]：那个 URL 是
    /// 给 webview 导航用的，带 C12 参数且 token 可能已被消费，不含原始 token。
    pub fn launch_endpoint(&self) -> Option<LaunchEndpoint> {
        let inner = self.lock_inner();
        inner.endpoint.clone()
    }

    /// 当前 harness 实例端口（导航白名单据此放行）。
    ///
    /// 只有 `Ready` 相位才返回端口——旧实例的 URL 不能靠残留状态放行。
    pub fn harness_port(&self) -> Option<u16> {
        let inner = self.lock_inner();
        match &inner.phase {
            HarnessPhase::Ready { url } => {
                url::Url::parse(url).ok().and_then(|parsed| parsed.port())
            }
            _ => None,
        }
    }

    /// 就绪时导航用过的完整 URL（含 C12 的 Windows 平台参数与首航 token）。
    ///
    /// 供「从壳内页面返回 Harness 界面」使用（`commands::harness_open`）。
    /// 刻意复用状态机**自身记下的那一个 URL**，而不是重新拼一个：C12 的
    /// query 参数只有 `on_ready` 知道，重新拼就会漂移成「非桌面模式」的界面。
    ///
    /// 注意语义：这是**重放**同一个 URL，其中的首航 token 可能已被 Harness
    /// 消费（契约 C5：token 只在首次 `GET /?token=` 出现）。稳态鉴权走
    /// `dsh-auth-*` cookie，因此正常情况下重放可用；若 Harness 侧已使该
    /// token 失效，本方法不负责补救——用户仍可通过原生菜单重启或退出。
    pub fn ready_url(&self) -> Option<String> {
        let inner = self.lock_inner();
        match &inner.phase {
            HarnessPhase::Ready { url } => Some(url.clone()),
            _ => None,
        }
    }

    /// 启动 Harness（若已有实例先停止）。
    pub async fn start(self: &Arc<Self>) {
        self.start_with_profile(None).await;
    }

    /// 以**安全模式**启动：隔离 profile + 隔离 patch 层（契约 C10）。
    ///
    /// 与 [`HarnessSupervisor::start`] 的唯一差别是启动器多带了
    /// `--profile desktop-safe-mode`，并因此改用 `dsh-desktop-safe.patch.yml`。
    /// profile 目录本体由 `safe_mode::ensure_safe_mode_profile` 事先落盘。
    pub async fn start_in_safe_mode(self: &Arc<Self>) {
        self.start_with_profile(Some(dsh_host::safe_mode::SAFE_MODE_PROFILE))
            .await;
    }

    /// 启动的单一实现源：`start` 与 `start_in_safe_mode` 只差一个 profile。
    ///
    /// # 参数
    ///
    /// * `profile` — `None` 用契约默认 profile（`web`）；`Some(name)` 走
    ///   `--profile <name>` 并切换到对应的 patch 层。
    async fn start_with_profile(self: &Arc<Self>, profile: Option<&str>) {
        self.stop().await;

        // L2 配置。退避/断路器常量取自契约（INV-4：计数与阈值集中在 dsh-contracts）。
        let config = SupervisorConfig {
            launcher_config: self.config,
            max_restarts: SUPERVISOR_MAX_RESTARTS,
            initial_backoff: SUPERVISOR_BACKOFF_INITIAL,
            max_backoff: SUPERVISOR_BACKOFF_MAX,
            backoff_multiplier: SUPERVISOR_BACKOFF_MULTIPLIER,
            stable_uptime: SUPERVISOR_STABLE_UPTIME,
            host: None,
            // 安全模式靠这条通道生效；缺了它 `restart_in_safe_mode()` 会静默降级成普通启动。
            profile: profile.map(str::to_string),
            // `None` + 空 `extra_envs` ⇒ 启动器自行捕获 shell 环境并补齐 C2 契约项
            // （`DSH_HOME` 等）。这与接线前 `launch(None, …)` 的行为**逐字一致**，
            // 因此这次改造不改变环境语义（INV-1 不受影响）。
            env: None,
            extra_args: Vec::new(),
            extra_envs: Vec::new(),
        };

        let supervisor = Arc::new(Supervisor::new(self.layout.clone(), config));

        // 先订阅再启动：否则会错过 `start()` 期间同步发出的早期状态。
        let mut rx = supervisor.subscribe();

        // 代号自增 ⇒ 上一轮的桥立即失效（见 `generation` 字段文档）。
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;

        {
            let mut inner = self.lock_inner();
            inner.phase = HarnessPhase::Preparing;
            inner.message = "Preparing to start DeepSeek Harness…".to_string();
            inner.endpoint = None;
            inner.push_desktop("starting via dsh_host::Supervisor".to_string());
        }
        self.emit();

        supervisor.start().await;

        // 状态桥：把 L2 的生命周期状态映射进壳层相位与日志。
        //
        // 不做 `JoinHandle` 管理：桥在通道 `Closed` 时自然退出，而 `stop()` 会丢弃
        // 最后一个 `Arc<Supervisor>`（连同监管协程里的 sender）从而关闭通道。
        // 少一个生命周期对象要维护，也少一处「忘了 abort」的泄漏面。
        let bridge = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut pending_cause: Option<FailureCause> = None;
            loop {
                match rx.recv().await {
                    Ok(state) => {
                        if bridge.generation.load(Ordering::SeqCst) != generation {
                            // 上一轮的迟到状态：丢弃，别覆盖新一轮的相位。
                            continue;
                        }
                        bridge.apply_supervisor_state(state, &mut pending_cause);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        *self.supervisor.lock().await = Some(supervisor);
    }

    /// 停止 Harness（SIGTERM → 4s → SIGKILL，Windows 走 taskkill /T /F）。
    ///
    /// 终止动作本身由 L2 的 [`Supervisor::stop`] 负责；本方法负责相位、
    /// 代号失效与桥的收尾。
    pub async fn stop(&self) {
        // 先自增代号：让上一轮的桥立刻失效，不再应用任何迟到状态。
        // 必须在取走 supervisor **之前**做，否则桥可能在新代号生效前抢跑。
        self.generation.fetch_add(1, Ordering::SeqCst);

        let supervisor = self.supervisor.lock().await.take();

        // 分流依据用「**是否有活跃子进程实例**」，不是「字段是否为 Some」。
        // 两者的差别正是这里最容易踩的坑：终态 `Failed` 之后字段仍是 `Some`
        // （L2 对象还在，只是监督协程已 `break`），若按字段判就会把错误页的
        // `Failed` 相位改成 `Stopped`，错误页可能随之消失——那是对既有行为的回归。
        // `is_running()` 反映的是实例是否活着：运行中为真；退避等待中与终态失败
        // 都为假（实例在子进程退出时已被 L2 取走）。
        let running = match &supervisor {
            Some(active) => active.is_running().await,
            None => false,
        };

        if !running {
            // 与接线前的「没有实例」分支同语义：错误页保持 `Failed`，其余置 `Idle`。
            {
                let mut inner = self.lock_inner();
                if matches!(inner.phase, HarnessPhase::Failed { .. }) {
                    inner.message = "Harness is not running.".to_string();
                } else {
                    inner.phase = HarnessPhase::Idle;
                    inner.message = "Harness is not running.".to_string();
                }
            }
            // 仍要收尾 L2（若存在）：结束监督协程并释放 sender，桥才能读到 Closed
            // 而自然退出。否则每轮重启都会遗留一个桥接任务。
            if let Some(active) = supervisor {
                active.stop().await;
                drop(active);
            }
            self.emit();
            return;
        }

        // 走到这里说明 `running == true`，而它只在 `supervisor` 为 `Some` 时成立；
        // 解包是安全的（`None` 分支已在上面 return）。
        let Some(supervisor) = supervisor else {
            return;
        };

        {
            let mut inner = self.lock_inner();
            inner.phase = HarnessPhase::Stopping;
            inner.message = "Stopping Harness…".to_string();
            inner.push_desktop("stopping harness".to_string());
        }
        self.emit();

        // L2 负责终止子进程树（Job Object / PDEATHSIG 兜底）并结束重启协程。
        supervisor.stop().await;

        // 丢弃最后一个 sender ⇒ 桥接任务读到 `Closed` 后自然退出。
        drop(supervisor);

        {
            let mut inner = self.lock_inner();
            inner.phase = HarnessPhase::Stopped;
            inner.message = "Harness stopped.".to_string();
            // 端点随实例一起失效：留着会让退出检查去问一个已经不在监听的端口。
            inner.endpoint = None;
            inner.push_desktop("harness stopped".to_string());
        }
        self.emit();
    }

    /// 重启（菜单 / 错误页「重试」）。
    pub async fn restart(self: &Arc<Self>) {
        self.start().await;
    }

    /// 重启进安全模式（菜单「Restart in Safe Mode」/ 错误页「安全模式」）。
    ///
    /// 调用方须**先**确保 profile 文件已落盘（见
    /// `crate::safe_mode::ensure_safe_mode_profile`）：本方法只负责「以该
    /// profile 启动」，不负责生成它——两件事都放在这里会让「启动」隐式写盘。
    pub async fn restart_in_safe_mode(self: &Arc<Self>) {
        self.start_in_safe_mode().await;
    }

    /// 取最近 `count` 行日志。
    pub fn logs_tail(&self, count: usize) -> Vec<String> {
        self.lock_inner().logs.tail(count)
    }

    // 原 `clear_logs()` 已移除（2026-09-10）：重启路径由状态机内部完成清理，
    // 该方法是冗余入口，此前靠一个 dead-code 抑制属性挂着等「后续阶段」。
    // 若将来真需要对外暴露清理能力，由状态机自身提供，不在此另开入口。

    // ------------------------------------------------------------------
    // 内部
    // ------------------------------------------------------------------

    /// **状态桥的唯一映射点**：把 L2 的 `SupervisorState` 映射为壳层相位。
    ///
    /// 完整映射表见 `docs/dev-plan-supervisor-shell-wiring.md` §3.2。三条要点：
    ///
    /// 1. `Stopping` / `Stopped` **不在这里处理**——它们由 [`Self::stop`] 自己拥有。
    ///    否则用户点「停止」时两边会互相覆盖，且带竞态。
    /// 2. `LaunchEvent::Failed` **不立刻进错误页**：这次启动失败可能马上被重启救回来。
    ///    立刻置 `Failed` 会让错误页在退避重试期间反复闪现。归因先记下来，
    ///    等**终态** `Failed` 再用。
    /// 3. `Crashed { will_restart: true }` 同理——只更新提示文案（「X ms 后重试」），
    ///    相位保持不动。
    ///
    /// 决策本身在纯函数 [`classify_state`] 里（那里附了「为什么要抽出来」的说明）；
    /// 本方法只负责执行副作用（改相位 / 写日志 / 导航 / 抛事件）。
    fn apply_supervisor_state(
        &self,
        state: SupervisorState,
        pending_cause: &mut Option<FailureCause>,
    ) {
        match classify_state(&state) {
            StateAction::Transition(phase, message) => self.transition(phase, &message),
            StateAction::Message(message) => {
                // `try_lock`：桥是异步任务，但这里沿用与 launch 回调一致的
                // 「忙则放弃」策略代价太高（会丢重试提示），故用 lock_inner——
                // 它内部走中毒恢复，不会 panic。
                let mut inner = self.lock_inner();
                inner.message = message.clone();
                inner.push_desktop(message);
            }
            StateAction::ViaLaunchEvent => {
                if let SupervisorState::LaunchProgress(event) = state {
                    self.apply_launch_event(event, pending_cause);
                }
            }
            StateAction::Terminal => {
                let (total_restarts, summary) = match &state {
                    SupervisorState::Failed {
                        total_restarts,
                        diagnostics,
                    } => (*total_restarts, diagnostics.summary.clone()),
                    _ => (0, String::new()),
                };
                // 归因三级回退（顺序即优先级）：
                //   ① 启动期捕获的 `FailureCause`——结构化最完整（kind / plugin_fault /
                //      retryable 都在），适用于「启动一直失败」的路径；
                //   ② 从日志环里现捞——适用于「Ready 之后崩溃」，那条路径上**没有**
                //      `LaunchEvent::Failed`，`pending_cause` 必为 `None`；
                //   ③ `UnexpectedExit`——最后的兜底。
                let cause = {
                    let mut inner = self.lock_inner();
                    inner.push_desktop(format!(
                        "supervisor gave up after {total_restarts} crash(es): {summary}"
                    ));
                    pending_cause.take().or_else(|| {
                        let attempt: Vec<LogLine> =
                            inner.logs.latest_attempt().into_iter().cloned().collect();
                        dsh_host::logs::extract_failure_cause(&attempt)
                    })
                }
                .unwrap_or(FailureCause::UnexpectedExit { code: None });
                self.on_failed(cause);
            }
            StateAction::Ignore => {}
        }
        self.emit();
    }

    /// 把 launch 事件映射为状态机迁移（同步回调，全部走 try_lock）。
    fn apply_launch_event(&self, event: LaunchEvent, pending_cause: &mut Option<FailureCause>) {
        match event {
            LaunchEvent::Log(line) => {
                // try_lock：忙则放弃（同步回调不阻塞启动链路），中毒则恢复——
                // 把中毒误判成「忙」会让状态机静默丢掉全部后续事件（§7.1 规则 3）。
                let Some(mut inner) = self.try_lock_inner() else {
                    return;
                };
                inner.logs.push(line);
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
                let Some(mut inner) = self.try_lock_inner() else {
                    return;
                };
                inner.message = "Launch token acquired.".to_string();
                inner.push_desktop("launch token acquired".to_string());
            }
            LaunchEvent::ReadyChecking { port } => self.transition(
                HarnessPhase::ReadyChecking,
                &format!("Probing 127.0.0.1:{port} …"),
            ),
            LaunchEvent::Ready { endpoint } => self.on_ready(endpoint),
            LaunchEvent::Failed { cause } => {
                // 只记录归因，**不**进错误页：这次失败可能马上被重启救回来
                // （见 `apply_supervisor_state` 文档第 2 条）。
                let Some(mut inner) = self.try_lock_inner() else {
                    return;
                };
                inner.push_desktop(format!("launch attempt failed: {cause}"));
                *pending_cause = Some(cause);
            }
        }
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
            let mut inner = self.lock_inner();
            inner.phase = HarnessPhase::Ready {
                url: url.to_string(),
            };
            inner.message = "Harness is ready.".to_string();
            inner.endpoint = Some(endpoint.clone());
            inner.push_desktop(format!("ready → {url}"));
        }

        // 任务 1.5：导航前清掉陈旧的 dsh-auth-* cookie（HTTP 431 防护）。
        if let Some(webview) = window::main_window(&self.app) {
            let removed = crate::cookies::clear_auth_cookies(&webview, AUTH_COOKIE_PREFIX);
            if let Ok(removed) = removed {
                if removed.removed > 0 {
                    self.lock_inner().push_desktop(format!(
                        "cleared {} stale {AUTH_COOKIE_PREFIX}* cookies",
                        removed.removed
                    ));
                }
            }
            let _ = webview.navigate(url.clone());
        }

        // LAN 手机桥：注入转发目标 + 首航 token（**不**启动监听——监听是显式
        // 的用户动作，见 mobile_bridge 模块文档的安全语义）。
        self.sync_mobile_target(Some(&endpoint));
        self.emit();
    }

    fn on_failed(&self, cause: FailureCause) {
        // Harness 已不可用：清空桥的目标，避免把手机请求转发到死端口。
        self.sync_mobile_target(None);
        {
            let mut inner = self.lock_inner();
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

    /// 把 Harness 端点同步给 LAN 手机桥（`None` = 清空）。
    ///
    /// 状态机回调里不能 await，因此只做一次性派生；`AppState` 由 `setup`
    /// 提前 manage，此处 `try_state` 必命中（未命中则静默跳过，不影响主链路）。
    fn sync_mobile_target(&self, endpoint: Option<&LaunchEndpoint>) {
        let target = endpoint.map(|endpoint| crate::mobile_bridge::HarnessTarget {
            base_url: endpoint.base_url(),
            launch_token: Some(endpoint.token.clone()),
        });
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let Some(state) = app.try_state::<Arc<AppState>>() else {
                return;
            };
            state.mobile.set_harness_target(target).await;
        });
    }

    // 原 `handle_post_ready_exit()` 已移除（2026-10-11，L1→L2 接线）：
    // 它原本靠壳层自己 spawn 的 exit watcher 把「Ready 之后退出」直接判成 `Failed`。
    // 接线后这条路径由 L2 统一处理——`Supervisor` 的重启协程拿 `take_exit()` 的
    // receiver，退出即产出 `Crashed`（还有重启额度）或 `Failed`（额度用尽），
    // 经状态桥映射进相位。**行为上唯一的差别是这里本来就要改的那一条**：
    // 崩溃不再立刻进错误页，而是先退避重启至多 `SUPERVISOR_MAX_RESTARTS` 次
    // （见 `docs/dev-plan-supervisor-shell-wiring.md` §5.2）。
    //
    // 「从日志环推导归因」的能力没有丢——它随 `Failed` 分支的三级回退一起搬到了
    // `apply_supervisor_state`（那里注释了为什么 Ready 后崩溃必须走日志推导）。

    fn transition(&self, phase: HarnessPhase, message: &str) {
        let Some(mut inner) = self.try_lock_inner() else {
            return;
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
    /// 更新管理器（运行期由 `lib.rs` 注入）。
    pub updates: Arc<tokio::sync::Mutex<Option<Arc<crate::update::UpdateManager>>>>,
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
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 快照契约：`phase` 的 tag 必须与 `message` / `logs` **平铺**，不得嵌套。
    ///
    /// 这条断言的唯一存在理由是它**曾经不成立**：字段缺 `#[serde(flatten)]`，
    /// 实际发出 `{"phase":{"phase":"failed",…}}`，于是 `frontend/error.html` 的
    /// `snapshot.phase === 'failed'` 恒为 false，「疑似插件故障 → 建议进入安全模式」
    /// 分支静默失效。跨语言（Rust → HTML）的契约错误编译器看不见，只能这样钉住。
    #[test]
    fn snapshot_json_keeps_the_phase_tag_flat() {
        let snapshot = HarnessSnapshot {
            phase: HarnessPhase::Failed {
                cause_kind: "plugin_fault".to_string(),
                cause: "loader entry failed (my-plugin)".to_string(),
                plugin_fault: true,
                retryable: false,
            },
            message: "failed".to_string(),
            logs: vec!["[desktop] failed".to_string()],
        };
        let json = serde_json::to_value(&snapshot).expect("snapshot must serialize");
        assert_eq!(
            json["phase"],
            serde_json::json!("failed"),
            "phase tag must be flat, not nested: {json}"
        );
        assert_eq!(
            json["plugin_fault"],
            serde_json::json!(true),
            "variant fields must be flat too, otherwise the page cannot read them: {json}"
        );
        assert_eq!(
            json["cause_kind"],
            serde_json::json!("plugin_fault"),
            "{json}"
        );
        assert_eq!(json["message"], serde_json::json!("failed"), "{json}");
        assert!(json.get("logs").is_some(), "{json}");
    }

    #[test]
    fn unit_phase_serializes_to_a_flat_string() {
        let snapshot = HarnessSnapshot {
            phase: HarnessPhase::Idle,
            message: "Harness is not running.".to_string(),
            logs: vec![],
        };
        let json = serde_json::to_value(&snapshot).expect("snapshot must serialize");
        assert_eq!(json["phase"], serde_json::json!("idle"), "{json}");
    }

    #[test]
    fn ready_phase_exposes_its_url_flat() {
        let snapshot = HarnessSnapshot {
            phase: HarnessPhase::Ready {
                url: "http://127.0.0.1:1234/?token=x".to_string(),
            },
            message: "Harness is ready.".to_string(),
            logs: vec![],
        };
        let json = serde_json::to_value(&snapshot).expect("snapshot must serialize");
        assert_eq!(json["phase"], serde_json::json!("ready"), "{json}");
        assert_eq!(
            json["url"],
            serde_json::json!("http://127.0.0.1:1234/?token=x"),
            "{json}"
        );
    }

    // ---- 状态桥映射（L1→L2 接线，2026-10-11）----
    //
    // 这一组测的是 `classify_state` 这个纯函数，不是 `HarnessSupervisor` 本身——
    // 后者需要真实 `AppHandle` 才能构造，单测里够不到。而映射里最容易错的两条
    // （重试期间不得进错误页、`Stopped` 桥不得处理）恰好都是**纯决策**，
    // 所以把它们抽出来钉住，是这一层唯一能拿到的确定性。

    /// 造一个用于测试的诊断报告（内容不重要，只有 `summary` 会被写进提示）。
    fn sample_diagnostics() -> dsh_host::diagnostics::DiagnosticReport {
        dsh_host::diagnostics::DiagnosticsAnalyzer::analyze_log_ring(&LogRing::new())
    }

    /// **重试期间不得进错误页。**
    ///
    /// 若这条映射被写成 `Terminal`，退避重试的每一轮都会把错误页推上前台
    /// （然后下一轮又被拉回来），用户看到的是闪烁的错误页——而编译完全正常。
    #[test]
    fn crashed_with_retry_budget_stays_out_of_error_page() {
        let state = SupervisorState::Crashed {
            diagnostics: sample_diagnostics(),
            restart_count: 2,
            will_restart: true,
            next_backoff: Some(std::time::Duration::from_millis(1000)),
        };
        match classify_state(&state) {
            StateAction::Message(message) => {
                assert!(message.contains("#2"), "提示里应含本次崩溃序号：{message}");
                assert!(message.contains("1000ms"), "提示里应含退避时长：{message}");
            }
            other => panic!("重试中的崩溃应只更新提示，实际分类为 {other:?}"),
        }
    }

    /// 额度用尽那一次也**不是** `Terminal`——它只是留证据，
    /// 紧随其后的 `Failed` 才是终态。否则会重复触发错误页。
    #[test]
    fn crashed_without_retry_budget_is_still_not_terminal() {
        let state = SupervisorState::Crashed {
            diagnostics: sample_diagnostics(),
            restart_count: 4,
            will_restart: false,
            next_backoff: None,
        };
        match classify_state(&state) {
            // 文案依赖 diagnostics.summary，故只断言类别。
            StateAction::Message(_) => {}
            other => {
                panic!("额度用尽的崩溃不应直接进错误页（紧随的 Failed 才是终态），实际 {other:?}")
            }
        }
    }

    /// **`Stopping` / `Stopped` 必须被桥忽略**：它们由 `HarnessSupervisor::stop()`
    /// 自己拥有。若桥也处理，用户点「停止」时两边会互相覆盖（且带竞态）。
    #[test]
    fn bridge_ignores_stop_lifecycle_states() {
        for state in [
            SupervisorState::Idle,
            SupervisorState::Stopping,
            SupervisorState::Stopped,
        ] {
            assert_eq!(
                classify_state(&state),
                StateAction::Ignore,
                "{state:?} 不应由状态桥处理（stop() 拥有这些相位）"
            );
        }
    }

    /// `Failed` 才是唯一进错误页的终态；`Running` 必须忽略（端点已由
    /// `LaunchEvent::Ready` 写入，重复处理会再跑一次导航副作用）。
    #[test]
    fn terminal_and_running_classification() {
        let failed = SupervisorState::Failed {
            diagnostics: sample_diagnostics(),
            total_restarts: 4,
        };
        assert_eq!(classify_state(&failed), StateAction::Terminal);

        let running = SupervisorState::Running {
            endpoint: dsh_host::token::LaunchEndpoint {
                url: "http://127.0.0.1:1234/?token=tok"
                    .parse()
                    .expect("测试用 URL 应可解析"),
                token: "tok".to_string(),
                host: "127.0.0.1".to_string(),
                port: 1234,
            },
            pid: 42,
        };
        assert_eq!(
            classify_state(&running),
            StateAction::Ignore,
            "Running 不应重复处理（Ready 事件已写过端点）"
        );
    }

    /// 首次尝试与重启尝试的文案必须可区分——用户靠它判断「是不是在自愈」。
    #[test]
    fn restart_attempts_are_labelled_distinctly() {
        assert_eq!(
            classify_state(&SupervisorState::Starting { attempt: 1 }),
            StateAction::Transition(
                HarnessPhase::Preparing,
                "Preparing to start DeepSeek Harness…".to_string()
            )
        );
        match classify_state(&SupervisorState::Starting { attempt: 3 }) {
            StateAction::Transition(HarnessPhase::Starting, message) => {
                assert!(message.contains('3'), "文案应含尝试序号：{message}");
            }
            other => panic!("第 3 次尝试应走「重启中」分支，实际 {other:?}"),
        }
    }
}
