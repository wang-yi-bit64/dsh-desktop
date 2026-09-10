//! Automatic updates via tauri-plugin-updater (generic provider).
//!
//! Mirrors the Electron `electron-updater` behaviour: check shortly after
//! startup and every six hours, offer before downloading, install only when
//! the user chooses to restart, and allow skipping one version.

use std::sync::Arc;
use std::time::Duration;

use dsh_host::contracts::{codes, ErrorCategory, IpcEnvelope};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

pub const STATUS_EVENT: &str = "updates://status";
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

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
}

pub struct UpdateManager {
    app: AppHandle,
    status: Arc<Mutex<UpdateStatus>>,
    skipped_version: Arc<Mutex<Option<String>>>,
}

impl UpdateManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            status: Arc::new(Mutex::new(UpdateStatus {
                phase: UpdatePhase::Idle,
                manual: false,
                available_version: None,
                percent: None,
                message: None,
            })),
            skipped_version: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn status(&self) -> UpdateStatus {
        self.status.lock().await.clone()
    }

    async fn set_status(&self, status: UpdateStatus) {
        *self.status.lock().await = status.clone();
        let _ = self.app.emit(STATUS_EVENT, &status);
    }

    /// Start the periodic check loop.
    pub fn start(self: &Arc<Self>) {
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
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
        self.set_status(UpdateStatus {
            phase: UpdatePhase::Checking,
            manual,
            available_version: None,
            percent: None,
            message: None,
        })
        .await;

        let updater = match self.app.updater_builder().build() {
            Ok(updater) => updater,
            Err(error) => {
                self.set_status(UpdateStatus {
                    phase: UpdatePhase::Error,
                    manual,
                    available_version: None,
                    percent: None,
                    message: Some(error.to_string()),
                })
                .await;
                return;
            }
        };

        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let skipped = self.skipped_version.lock().await.clone();
                if !manual && skipped.as_deref() == Some(version.as_str()) {
                    self.set_status(UpdateStatus {
                        phase: UpdatePhase::UpToDate,
                        manual,
                        available_version: Some(version),
                        percent: None,
                        message: None,
                    })
                    .await;
                    return;
                }
                self.set_status(UpdateStatus {
                    phase: UpdatePhase::Available,
                    manual,
                    available_version: Some(version),
                    percent: None,
                    message: None,
                })
                .await;
            }
            Ok(None) => {
                self.set_status(UpdateStatus {
                    phase: UpdatePhase::UpToDate,
                    manual,
                    available_version: None,
                    percent: None,
                    message: None,
                })
                .await;
            }
            Err(error) => {
                self.set_status(UpdateStatus {
                    phase: UpdatePhase::Error,
                    manual,
                    available_version: None,
                    percent: None,
                    message: Some(error.to_string()),
                })
                .await;
            }
        }
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

        self.set_status(UpdateStatus {
            phase: UpdatePhase::Downloading,
            manual: false,
            available_version: Some(version.clone()),
            percent: Some(0.0),
            message: None,
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
                self.set_status(UpdateStatus {
                    phase: UpdatePhase::Downloaded,
                    manual: false,
                    available_version: Some(version),
                    percent: Some(100.0),
                    message: None,
                })
                .await;
                IpcEnvelope::ok(())
            }
            Err(error) => {
                self.set_status(UpdateStatus {
                    phase: UpdatePhase::Error,
                    manual: false,
                    available_version: Some(version),
                    percent: None,
                    message: Some(error.to_string()),
                })
                .await;
                Self::failure(error)
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
        IpcEnvelope::failure(
            codes::UPDATER_UNAVAILABLE,
            ErrorCategory::Environment,
            error.to_string(),
        )
    }

    /// Skip a specific version for automatic checks.
    pub async fn skip(&self, version: String) {
        *self.skipped_version.lock().await = Some(version);
    }
}
