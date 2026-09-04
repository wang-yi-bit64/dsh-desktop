//! Automatic updates via tauri-plugin-updater (generic provider).
//!
//! Mirrors the Electron `electron-updater` behaviour: check shortly after
//! startup and every six hours, offer before downloading, install only when
//! the user chooses to restart, and allow skipping one version.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
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
    pub async fn download(&self) -> Result<(), String> {
        let updater = self
            .app
            .updater_builder()
            .build()
            .map_err(|e| e.to_string())?;
        let update = updater
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no update available".to_string())?;

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
                Ok(())
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
                Err(error.to_string())
            }
        }
    }

    /// Restart the app and install the downloaded update.
    pub async fn install(&self) -> Result<(), String> {
        self.app.restart();
    }

    /// Skip a specific version for automatic checks.
    pub async fn skip(&self, version: String) {
        *self.skipped_version.lock().await = Some(version);
    }
}
