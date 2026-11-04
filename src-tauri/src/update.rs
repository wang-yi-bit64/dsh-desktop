//! Automatic updates via tauri-plugin-updater (generic provider).
//!
//! Mirrors the Electron `electron-updater` behaviour: check shortly after
//! startup and every six hours, offer before downloading, install only when
//! the user chooses to restart, and allow skipping one version.
//!
//! # 2026-10-03 三项补齐（对照上游桌面端）
//!
//! 1. **失败分类**：所有失败点（检查 / 下载 / 安装）除给页面一个 `message` 外，
//!    还给出稳定错误码（`E1005`~`E1008`，见 [`dsh_host::contracts::codes`]），
//!    页面据此分派而不是匹配英文文案——与 `commands` 面的封套纪律同一取向。
//! 2. **更新 journal**：检查 / 分类 / 下载 / 安装各阶段的结论写进
//!    [`crate::update_journal`] 的 JSONL；用户报「更新卡住了」时诊断包里能看见
//!    到底停在哪一步。只写事实与版本号，不写 URL / Token。
//! 3. **就绪提醒**：更新就绪后窗口可能已藏进托盘（关窗即隐藏），用户看不见
//!    页面。此时经托盘状态行 + 系统通知告知「版本已就绪，重启即装」。
//!
//! # 2026-10-30 阶段状态机（CD05 / CD06）
//!
//! 4. **失败归因不再猜百分比**：`download()` 曾用 `percent >= 100` 推断「失败
//!    发生在安装还是下载」，而 `self.status.percent` 从未被进度回调写回（它只
//!    `emit` 事件）⇒ 那个判定永假、`E1007` 成了死码。现在由 [`UpdateStage`]
//!    显式记录「现在在哪一步」，失败归因读阶段；`percent` 退回只画进度条。
//! 5. **`check()` 不再硬编码网络失败**：检查阶段的任何 `Err` 曾一律报
//!    `CheckNetwork`（`E1005`），连签名/配置问题都被说成「检查网络」。
//!    现在统一走 [`UpdateFailure::classify_at`]，由阶段 + 错误文本共同归类。
//! 6. **进度写回状态**：`updates_status` 命令读到的 `percent` 与 `updates://status`
//!    事件同源，页面刷新一次不再把进度条打回 0。

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dsh_host::contracts::{codes, ErrorCategory, IpcEnvelope};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

use crate::update_journal::{JournalAction, UpdateJournal};

pub const STATUS_EVENT: &str = "updates://status";
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// 安装形态判定住在**无头 crate**（[`dsh_host::install`]）：判据是纯路径运算，
/// 按 `AGENTS.md` §3 的分流判据属于 `dsh-host`。留在 `src-tauri` 的代价是
/// **本地无法证伪**——本机 GNU 工具链加载不了壳层测试二进制
/// （`docs/incidents/local-toolchain-limits.md`），而这条判据正是 2026-10-17
/// 事故的现场（`docs/incidents/desktop-shell-and-tray.md`）。
///
/// 这里 re-export 只为让命令面（`commands::install_mode`）不必写跨 crate 路径。
pub use dsh_host::install::InstallMode;

/// 失败归因判据住在**无头 crate**（`dsh_host::update_failure`）——与 `InstallMode`
/// 同一条分流理由：判据是纯逻辑，留在壳层就**本地无法证伪**（本机壳层测试二进制
/// 加载即 `STATUS_ENTRYPOINT_NOT_FOUND`），而这张表正是 CD05 / CD06 的全部内容。
///
/// 这里 re-export 只为让本模块与命令面不必写跨 crate 路径。
pub use dsh_host::update_failure::{UpdateFailure, UpdateStage};


#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    Downloading,
    /// 字节已到位、正在交给安装器。新增于 2026-10-30（CD06）：
    /// 这一段可能持续可见数秒，旧实现把它显示成「下载中 100%」。
    Installing,
    Downloaded,
    UpToDate,
    Error,
}

#[derive(Clone, Debug, Serialize)]
pub struct UpdateStatus {
    pub phase: UpdatePhase,
    pub manual: bool,
    pub available_version: Option<String>,
    pub percent: Option<f64>,
    pub message: Option<String>,
    /// 稳定错误码（失败时；见 [`UpdateFailure`]）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

pub struct UpdateManager {
    app: AppHandle,
    status: Arc<Mutex<UpdateStatus>>,
    skipped_version: Arc<Mutex<Option<String>>>,
    /// 观测设施：写不进去时整体降级为 `None`，更新链路照常继续。
    journal: Option<UpdateJournal>,
}

impl UpdateManager {
    pub fn new(app: AppHandle) -> Self {
        // 通道名随本次构建的更新源确定；拿不到时退空串（journal 仍可用）。
        let channel = Self::resolve_channel(&app);
        let journal = app
            .path()
            .app_data_dir()
            .ok()
            .and_then(|dir| UpdateJournal::open(&dir, channel));
        if journal.is_none() {
            log::warn!("update journal disabled: diagnostics for update failures will be missing");
        }
        Self {
            app,
            status: Arc::new(Mutex::new(UpdateStatus {
                phase: UpdatePhase::Idle,
                manual: false,
                available_version: None,
                percent: None,
                message: None,
                code: None,
            })),
            skipped_version: Arc::new(Mutex::new(None)),
            journal,
        }
    }

    /// 从当前更新端点推导通道路径（`updater-rc` / `updater-alpha`）。
    fn resolve_channel(app: &AppHandle) -> String {
        let endpoints = app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|value| value.get("endpoints"))
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        for endpoint in endpoints {
            if let Some(text) = endpoint.as_str() {
                if let Some(tail) = text.rsplit('/').nth(1) {
                    return tail.strip_prefix("updater-").unwrap_or(tail).to_owned();
                }
            }
        }
        String::new()
    }

    pub async fn status(&self) -> UpdateStatus {
        self.status.lock().await.clone()
    }

    async fn set_status(&self, status: UpdateStatus) {
        *self.status.lock().await = status.clone();
        let _ = self.app.emit(STATUS_EVENT, &status);
    }

    /// 记一条 journal 并同时落日志——两处的受众不同（日志给人肉眼看，
    /// journal 给将来的诊断包比对）。
    fn journal(
        &self,
        action: JournalAction,
        version: Option<String>,
        code: Option<String>,
        summary: impl std::fmt::Display,
    ) {
        log::info!("update {action:?}: {summary}");
        if let Some(journal) = self.journal.as_ref() {
            journal.record(action, version, code, summary.to_string());
        }
    }

    /// 更新就绪后的可见回执（托盘状态行 + 系统通知）。
    ///
    /// 关窗即隐藏意味着**页面可能在用户看不见的地方**；没有这一步，下载完成这个
    /// 事实只在用户碰巧切回更新页时才可见。通知失败只记日志。
    fn announce_ready(&self, version: &str) {
        crate::tray::set_update_ready_status(&self.app, true);
        let body = format!("Version {version} is ready. Restart to install.");
        if let Err(error) = crate::notifications::notify_update_ready(&self.app, &body) {
            log::debug!("update-ready notification unavailable: {error}");
        }
    }

    /// Start the periodic check loop.
    pub fn start(self: &Arc<Self>) {
        // 只有**安装版**才有 NSIS passive-update 的落点。便携版与「取不到自身
        // 路径」都跳过轮询——但两者的理由分开记：前者是设计事实，后者是环境异常，
        // 混成一句话会让诊断包看不出到底是哪种（§7.1 规则 3）。
        let mode = Self::install_mode();
        if mode != InstallMode::Installed {
            self.journal(
                JournalAction::Started,
                None,
                None,
                format!("{} build: update polling skipped", mode.as_str()),
            );
            return;
        }
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            self_journal_start(&manager).await;
            // Initial check shortly after startup.
            tokio::time::sleep(Duration::from_secs(10)).await;
            manager.check(false).await;
            loop {
                tokio::time::sleep(CHECK_INTERVAL).await;
                manager.check(false).await;
            }
        });
    }

    /// Check for an update. `manual` reflects a user-initiated check.
    pub async fn check(&self, manual: bool) {
        self.journal(JournalAction::Check, None, None, format!("manual={manual}"));
        self.set_status(UpdateStatus {
            phase: UpdatePhase::Checking,
            manual,
            available_version: None,
            percent: None,
            message: None,
            code: None,
        })
        .await;

        let updater = match self.app.updater_builder().build() {
            Ok(updater) => updater,
            Err(error) => {
                let failure = UpdateFailure::classify_at(UpdateStage::Checking, &error);
                self.fail(UpdateStage::Checking, &error, failure, manual, None)
                    .await;
                return;
            }
        };

        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let skipped = self.skipped_version.lock().await.clone();
                if !manual && skipped.as_deref() == Some(version.as_str()) {
                    self.journal(
                        JournalAction::CheckResult,
                        Some(version.clone()),
                        None,
                        "skipped by user",
                    );
                    self.set_status(UpdateStatus {
                        phase: UpdatePhase::UpToDate,
                        manual,
                        available_version: Some(version),
                        percent: None,
                        message: None,
                        code: None,
                    })
                    .await;
                    return;
                }
                self.journal(
                    JournalAction::CheckResult,
                    Some(version.clone()),
                    None,
                    "update available",
                );
                self.set_status(UpdateStatus {
                    phase: UpdatePhase::Available,
                    manual,
                    available_version: Some(version),
                    percent: None,
                    message: None,
                    code: None,
                })
                .await;
            }
            Ok(None) => {
                self.journal(JournalAction::CheckResult, None, None, "already up to date");
                self.set_status(UpdateStatus {
                    phase: UpdatePhase::UpToDate,
                    manual,
                    available_version: None,
                    percent: None,
                    message: None,
                    code: None,
                })
                .await;
            }
            Err(error) => {
                // CD05：这里曾经硬编码 `UpdateFailure::CheckNetwork`，等于绕过
                // `classify()`——检查阶段的签名/配置类失败一律被说成「网络问题」，
                // 用户于是反复重试一个不可能成功的检查。改走 `classify_at()`：
                // 阶段给出主判据，错误文本只做阶段内细分。
                let failure = UpdateFailure::classify_at(UpdateStage::Checking, &error);
                self.fail(UpdateStage::Checking, &error, failure, manual, None)
                    .await;
            }
        }
    }

    /// 统一的失败落点：封套错误码 + 失败分类 + journal。
    async fn fail(
        &self,
        stage: UpdateStage,
        error: impl std::fmt::Display,
        failure: UpdateFailure,
        manual: bool,
        version: Option<String>,
    ) {
        let summary = format!("{} failed: {error}", stage.as_str());
        self.journal(
            JournalAction::Failed,
            version.clone(),
            Some(failure.code().to_string()),
            &summary,
        );
        self.set_status(UpdateStatus {
            phase: UpdatePhase::Error,
            manual,
            available_version: version,
            percent: None,
            message: Some(error.to_string()),
            code: Some(failure.code().to_string()),
        })
        .await;
    }

    /// Download the available update (user consented).
    ///
    /// # 返回形态
    ///
    /// 返回封套而不是 `Result<(), String>`：更新失败的原因（网络不通 / 校验
    /// 不过 / 无可用版本）必须能被页面**分类**处理，而不是显示一个字符串。
    pub async fn download(&self) -> IpcEnvelope<()> {
        let updater = match self.app.updater_builder().build() {
            Ok(updater) => updater,
            // 还没开始传输 ⇒ 阶段是 `Checking`（下面那次 `check()` 复查同理）。
            Err(error) => return Self::failure(UpdateStage::Checking, error),
        };
        let update = match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => {
                return IpcEnvelope::failure(
                    codes::UPDATER_UNAVAILABLE,
                    ErrorCategory::Environment,
                    "no update is available to download",
                )
                .with_action("Run a check first; the release may have been withdrawn.")
            }
            Err(error) => return Self::failure(UpdateStage::Checking, error),
        };

        let version = update.version.clone();
        let app = self.app.clone();
        self.journal(
            JournalAction::Download,
            Some(version.clone()),
            None,
            "user consented",
        );

        self.set_status(UpdateStatus {
            phase: UpdatePhase::Downloading,
            manual: false,
            available_version: Some(version.clone()),
            percent: Some(0.0),
            message: None,
            code: None,
        })
        .await;

        let app_for_progress = app.clone();
        let status_slot = Arc::clone(&self.status);
        let mut downloaded: u64 = 0;

        // 阶段账目：进入 `Downloading` 就是「字节还没走完」这个事实的唯一定义。
        // 验签与安装由下面两个分支显式推进，不再靠百分比猜。
        let stage = Arc::new(AtomicU8::new(UpdateStage::Downloading as u8));
        let stage_for_finish = Arc::clone(&stage);

        let result = update
            .download(
                move |chunk_length, content_length| {
                    downloaded += chunk_length as u64;
                    let Some(total) = content_length else {
                        return;
                    };
                    if total == 0 {
                        return;
                    }
                    let percent = (downloaded as f64 / total as f64 * 100.0).min(100.0);
                    let app = app_for_progress.clone();
                    let status_slot = Arc::clone(&status_slot);
                    tauri::async_runtime::spawn(async move {
                        // CD06 关键修复：旧实现只 `emit`，**从不写** `self.status`，
                        // 于是 `updates_status` 命令永远读到开头那个 `Some(0.0)`——
                        // 页面刷新一次进度条就归零，而 `percent >= 100` 的安装判定
                        // 也因此永假。现在事件与状态同源，同一把锁里取快照。
                        let snapshot = {
                            let mut guard = status_slot.lock().await;
                            guard.phase = UpdatePhase::Downloading;
                            guard.percent = Some(percent);
                            guard.clone()
                        };
                        let _ = app.emit(STATUS_EVENT, &snapshot);
                    });
                },
                move || {
                    // 上游在这里**刚收完字节、还没验签**（插件 2.13.0
                    // `updater.rs:835` 调用本回调，紧接着 `:837` 才 `verify_signature`）。
                    // 这是唯一能如实标记「验签进行中」的时点，再往后就没有回调了。
                    stage_for_finish.store(UpdateStage::Verifying as u8, Ordering::SeqCst);
                },
            )
            .await;

        let bytes = match result {
            Ok(bytes) => bytes,
            Err(error) => {
                // 失败归因读**当前阶段**：`on_download_finish` 没触发 ⇒ 传输中途失败
                // （`E1006`）；已触发 ⇒ 字节完整、失败在验签（`E1008`）。
                // 这里不再问 `percent`——它当时记的是进度条，不是流程位置。
                let current = UpdateStage::from_u8(stage.load(Ordering::SeqCst));
                let failure = UpdateFailure::classify_at(current, &error);
                self.fail(current, &error, failure, false, Some(version))
                    .await;
                return IpcEnvelope::failure(failure.code(), failure.category(), error.to_string());
            }
        };

        // `download()` 返回意味着字节已到位**且已通过签名校验**（插件在同一函数
        // 内完成验签）。先如实记一条「下载完成」——这条不该等到安装成功才写，
        // 否则「下载成功了但装不上」这种最需要诊断的现场反而没有下载记录。
        self.journal(
            JournalAction::Downloaded,
            Some(version.clone()),
            None,
            format!(
                "{} stage: download finished, signature accepted",
                UpdateStage::Verifying.as_str()
            ),
        );

        // 接下来是安装：显式推进阶段，页面据此显示「正在安装」。
        stage.store(UpdateStage::Installing as u8, Ordering::SeqCst);
        self.set_status(UpdateStatus {
            phase: UpdatePhase::Installing,
            manual: false,
            available_version: Some(version.clone()),
            percent: Some(100.0),
            message: None,
            code: None,
        })
        .await;

        match update.install(bytes) {
            Ok(()) => {
                // ⚠️ Windows 上这个分支**通常不可达**：`install_inner` 启动安装器后
                // 直接 `std::process::exit(0)`（插件 `updater.rs:972`）。macOS / Linux
                // 会正常返回，由用户重启后才生效。改动前走 `download_and_install`，
                // 行为完全相同——这里只是把两步拆开以便标记阶段。
                stage.store(UpdateStage::Completed as u8, Ordering::SeqCst);
                self.journal(
                    JournalAction::Install,
                    Some(version.clone()),
                    None,
                    format!(
                        "{} stage: bytes handed to the installer",
                        UpdateStage::Installing.as_str()
                    ),
                );
                self.set_status(UpdateStatus {
                    phase: UpdatePhase::Downloaded,
                    manual: false,
                    available_version: Some(version.clone()),
                    percent: Some(100.0),
                    message: None,
                    code: None,
                })
                .await;
                // 就绪回执：窗口可能藏在托盘（关窗即隐藏），页面对用户不可见。
                self.announce_ready(&version);
                IpcEnvelope::ok(())
            }
            Err(error) => {
                let failure = UpdateFailure::classify_at(UpdateStage::Installing, &error);
                self.fail(UpdateStage::Installing, &error, failure, false, Some(version))
                    .await;
                IpcEnvelope::failure(failure.code(), failure.category(), error.to_string())
            }
        }
    }

    /// Restart the app and install the downloaded update.
    ///
    /// 始终成功：`restart()` 不返回失败信息，而进程随之退出——没有可上报的
    /// 失败面。**「下载了但装不上」的失败面不在这里**：它在 [`Self::download`]
    /// 的 `install(bytes)` 调用点，由 `UpdateStage::Installing` 归类为 `E1007`
    /// （该处改动前是 `E1007` 的死码，见 [`UpdateStage`] 文档）。不要在这里
    /// 补一个恒真的成功来假装覆盖了那条路径（`AGENTS.md` §7.1 规则 2）。
    pub async fn install(&self) -> IpcEnvelope<()> {
        // `restart()` 在返回前不会真的返回（进程即将被替换），因此后面的语句
        // 在编译期就是不可达的——留着是为了让返回类型显式。
        let version = self.status.lock().await.available_version.clone();
        self.journal(
            JournalAction::Install,
            version,
            None,
            format!("{} stage: restart requested by the user", UpdateStage::Restarting.as_str()),
        );
        self.app.restart();
        #[allow(unreachable_code)]
        IpcEnvelope::ok(())
    }

    /// 把更新器的错误映射为封套。
    ///
    /// 归为「环境」而非「网络」：`updater_builder().build()` 的失败多为**未配置
    /// 更新源 / 签名公钥不匹配**（配置问题），而 `check()` 的网络失败也常由代理
    /// 或证书引起——两者都不该让页面只建议用户「检查网络」了事。类别只表达
    /// 归因族，具体原因在 `message` 里。
    fn failure(stage: UpdateStage, error: impl std::fmt::Display) -> IpcEnvelope<()> {
        let failure = UpdateFailure::classify_at(stage, error.to_string());
        IpcEnvelope::failure(failure.code(), failure.category(), error.to_string())
    }

    /// 当前进程的安装形态。
    ///
    /// ⚠️ **禁止**改用 `app.path().executable_dir()` 推断：它返回的是「用户的
    /// 可执行文件目录」，在 Windows / macOS 上恒为 `None`（详见 [`InstallMode`]
    /// 与 `docs/incidents/desktop-shell-and-tray.md`）。判据只认
    /// `dsh_host::install::classify` 的正向信号。
    pub(crate) fn install_mode() -> InstallMode {
        match dsh_host::install::classify_current() {
            Ok(mode) => mode,
            Err(error) => {
                // 取不到自身路径属环境异常：允许降级，但必须留下可核对的理由
                // （`AGENTS.md` §7.1 规则 3：禁止无声降级）。
                log::warn!("cannot resolve the current executable path: {error}");
                InstallMode::Unknown
            }
        }
    }

    /// Skip a specific version for automatic checks.
    pub async fn skip(&self, version: String) {
        *self.skipped_version.lock().await = Some(version.clone());
        self.journal(
            JournalAction::Discarded,
            Some(version),
            None,
            "user skipped this version",
        );
    }
}

/// 启动时的 journal 首条记录（单独函数：`start(self: &Arc<Self>)` 里不便借用 `self`）。
async fn self_journal_start(manager: &Arc<UpdateManager>) {
    manager.journal(
        JournalAction::Started,
        None,
        None,
        "update loop started (startup +10s, then every 6h)",
    );
}

// 本模块的失败归因判据（`UpdateFailure` / `UpdateStage`）连同其单测住在
// `crates/dsh-host/src/update_failure.rs`：壳层测试二进制在本机 GNU 工具链下
// 加载即 `STATUS_ENTRYPOINT_NOT_FOUND`，留在这里的断言跑不起来等于没有。
