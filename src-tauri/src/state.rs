//! Shared application state wired into Tauri's managed state.

use std::sync::Arc;

use tokio::sync::Mutex;

use crate::harness_runtime::HarnessRuntime;
use crate::mobile_bridge::MobileBridge;
use crate::update::UpdateManager;

pub struct AppState {
    pub runtime: Arc<HarnessRuntime>,
    pub mobile: Arc<MobileBridge>,
    pub updates: Arc<Mutex<Option<Arc<UpdateManager>>>>,
    /// Whether the window is currently showing the Harness web UI.
    pub harness_loaded: Mutex<bool>,
}

impl AppState {
    pub fn new(runtime: Arc<HarnessRuntime>, mobile: Arc<MobileBridge>) -> Self {
        Self {
            runtime,
            mobile,
            updates: Arc::new(Mutex::new(None)),
            harness_loaded: Mutex::new(false),
        }
    }
}
