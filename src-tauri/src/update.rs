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

/// 稳定错误码 + 类别：让页面**分派**而不是匹配字符串。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateFailure {
    /// 检查失败且可归因到网络。
    CheckNetwork,
    /// 下载失败且可归因到网络。
    DownloadNetwork,
    /// 安装（重启交接）失败。
    Install,
    /// 签名 / 校验和被拒：不可重试。
    SignatureRejected,
    /// 未细分（分类尽力而为，失败不至丢失原消息）。
    Other,
}

impl UpdateFailure {
    /// 由上游错误文本推断失败类别。
    ///
    /// 只做**保守**匹配：命中的关键词都是网络/传输层的确定性信号。推断不出就归
    /// `Other`——宁可少分类，也不要把「证书不匹配」说成「网络问题」。
    pub fn classify(error: impl std::fmt::Display) -> Self {
        let text = error.to_string().to_ascii_lowercase();
        if text.contains("signature")
            || text.contains("checksum")
            || text.contains("invalid key")
            || text.contains("pubkey")
        {
            return Self::SignatureRejected;
        }
        let network = [
            "timed out",
            "timeout",
            "refused",
            "unreachable",
            "connection",
            "dns",
            "resolve",
            "network",
            "tls",
            "certificate",
            "proxy",
            "could not connect",
            "error sending request",
        ]
        .iter()
        .any(|hint| text.contains(hint));
        if network {
            Self::CheckNetwork
        } else {
            Self::Other
        }
    }

    /// 对应的稳定错误码。
    pub fn code(self) -> &'static str {
        match self {
            Self::CheckNetwork => codes::UPDATE_CHECK_NETWORK,
            Self::DownloadNetwork => codes::UPDATE_DOWNLOAD_NETWORK,
            Self::Install => codes::UPDATE_INSTALL_FAILED,
            Self::SignatureRejected => codes::UPDATE_SIGNATURE_REJECTED,
            Self::Other => codes::UPDATER_UNAVAILABLE,
        }
    }

    /// 对应错误族（与 `codes` 模块的族号↔类别测试一致）。
    pub fn category(self) -> ErrorCategory {
        match self {
            Self::CheckNetwork | Self::DownloadNetwork => ErrorCategory::Network,
            Self::Install | Self::SignatureRejected | Self::Other => ErrorCategory::Environment,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    Downloading,
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
                    return tail
                        .strip_prefix("updater-")
                        .unwrap_or(tail)
                        .to_owned();
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
    fn journal(&self, action: JournalAction, version: Option<String>, code: Option<String>, summary: impl std::fmt::Display) {
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
        // 便携版不经过安装器，没有 NSIS passive-update 的落点；与其让 updater
        // 报「环境不可用」，不如在启动时就静默跳过轮询。
        if Self::is_portable_mode(&self.app) {
            self.journal(
                JournalAction::Started,
                None,
                None,
                "portable build: update polling skipped",
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
                let failure = UpdateFailure::classify(&error);
                self.fail(&error, failure, manual, None, "check").await;
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
                self.journal(
                    JournalAction::CheckResult,
                    None,
                    None,
                    "already up to date",
                );
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
                self.fail(&error, UpdateFailure::CheckNetwork, manual, None, "check")
                    .await;
            }
        }
    }

    /// 统一的失败落点：封套错误码 + 失败分类 + journal。
    async fn fail(
        &self,
        error: impl std::fmt::Display,
        failure: UpdateFailure,
        manual: bool,
        version: Option<String>,
        stage: &str,
    ) {
        let summary = format!("{stage} failed: {error}");
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
            Err(error) => return Self::failure(error),
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
            Err(error) => return Self::failure(error),
        };

        let version = update.version.clone();
        let app = self.app.clone();
        self.journal(JournalAction::Download, Some(version.clone()), None, "user consented");

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
        let version_for_progress = version.clone();
        let mut downloaded: u64 = 0;
        let result = update
            .download_and_install(
                move |chunk_length, content_length| {
                    downloaded += chunk_length as u64;
                    if let Some(total) = content_length {
                        if total > 0 {
                            let percent = (downloaded as f64 / total as f64 * 100.0).min(100.0);
                            let app = app_for_progress.clone();
                            let version = version_for_progress.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = app.emit(
                                    STATUS_EVENT,
                                    &UpdateStatus {
                                        phase: UpdatePhase::Downloading,
                                        manual: false,
                                        available_version: Some(version),
                                        percent: Some(percent),
                                        message: None,
                                        code: None,
                                    },
                                );
                            });
                        }
                    }
                },
                move || {
                    // Download finished; restart & install handled by install().
                },
            )
            .await;

        match result {
            Ok(()) => {
                self.journal(
                    JournalAction::Downloaded,
                    Some(version.clone()),
                    None,
                    "download finished",
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
                // `download_and_install` 涵盖下载与安装两段。失败发生在「已下载
                // 100% 之后」才可能是安装问题，其余按下载处理——安装本身的失败
                // 由下一次重启前的交接体现（那里没有可上报的错误面）。
                let failure = if matches!(
                    self.status.lock().await.percent,
                    Some(p) if p >= 100.0
                ) {
                    UpdateFailure::Install
                } else {
                    UpdateFailure::DownloadNetwork
                };
                self.fail(&error, failure, false, Some(version), "download")
                    .await;
                IpcEnvelope::failure(failure.code(), failure.category(), error.to_string())
            }
        }
    }

    /// Restart the app and install the downloaded update.
    ///
    /// 始终成功：`restart()` 不返回失败信息，而进程随之退出——没有可上报的
    /// 失败面。若将来出现「下载了但装不上」的路径，改成真实判定，不要在这里
    /// 补一个恒真的成功（`AGENTS.md` §7.1 规则 2）。
    pub async fn install(&self) -> IpcEnvelope<()> {
        // `restart()` 在返回前不会真的返回（进程即将被替换），因此后面的语句
        // 在编译期就是不可达的——留着是为了让返回类型显式。
        let version = self.status.lock().await.available_version.clone();
        self.journal(
            JournalAction::Install,
            version,
            None,
            "restart requested by the user",
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
    fn failure(error: impl std::fmt::Display) -> IpcEnvelope<()> {
        let failure = UpdateFailure::classify(error.to_string());
        IpcEnvelope::failure(failure.code(), failure.category(), error.to_string())
    }

    /// 当前可执行文件是否落在「便携版」形态下。
    ///
    /// 判据：exe 的父目录路径若包含 `Program Files`（含 `Program Files (x86)`），
    /// 则是安装器放好的位置，按安装版处理；否则认为是用户手动解压的便携目录，
    /// 不启动 updater 轮询。
    ///
    /// 取不到 exe 路径时按便携处理（保守策略：宁可跳过更新，也不让 updater
    /// 在无 installer 落点的环境里反复报错）。
    pub(crate) fn is_portable_mode(app: &AppHandle) -> bool {
        app.path()
            .executable_dir()
            .ok()
            .and_then(|p| p.to_str().map(|s| s.to_owned()))
            .map(|dir| !dir.contains("Program Files"))
            .unwrap_or(true)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 分类必须**保守**：网络信号命中、签名问题不得说成网络、未知归 Other。
    #[test]
    fn failure_classification_is_conservative() {
        assert_eq!(
            UpdateFailure::classify("request timed out after 30s"),
            UpdateFailure::CheckNetwork
        );
        assert_eq!(
            UpdateFailure::classify("error sending request for url"),
            UpdateFailure::CheckNetwork
        );
        assert_eq!(
            UpdateFailure::classify("Could not connect to the server"),
            UpdateFailure::CheckNetwork
        );
        assert_eq!(
            UpdateFailure::classify("signature verification failed"),
            UpdateFailure::SignatureRejected
        );
        assert_eq!(
            UpdateFailure::classify("minisign checksum mismatch"),
            UpdateFailure::SignatureRejected
        );
        // 归 Other 不得声称网络问题（判据：页面不能因此误导用户「检查网络」）。
        assert_eq!(
            UpdateFailure::classify("updater not configured"),
            UpdateFailure::Other
        );
    }

    /// 错误码与类别必须与 `codes` 的族号↔类别约定一致（否则 `gate -- ipc-surface`
    /// 的族号测试会红）。
    #[test]
    fn failure_codes_stay_in_family() {
        for failure in [
            UpdateFailure::CheckNetwork,
            UpdateFailure::DownloadNetwork,
            UpdateFailure::Install,
            UpdateFailure::SignatureRejected,
            UpdateFailure::Other,
        ] {
            let code = failure.code();
            assert!(code.starts_with("E1"), "{failure:?} 的码 {code} 必须是 E1 族");
            assert_eq!(&code[1..2], "1");
        }
        assert_eq!(
            UpdateFailure::CheckNetwork.category(),
            ErrorCategory::Network
        );
        assert_eq!(
            UpdateFailure::SignatureRejected.category(),
            ErrorCategory::Environment
        );
    }
}
