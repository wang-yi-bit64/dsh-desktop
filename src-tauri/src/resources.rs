//! Runtime resolution of bundled resources.
//!
//! The prepare-harness build step assembles everything under
//! `src-tauri/resources/`:
//!
//! ```text
//! resources/
//!   node/node(.exe)                  Bundled Node.js runtime
//!   harness-node-entry.mjs           Wrapper entry (imports the hide patch)
//!   windows-child-process-hide.mjs   Sibling of the wrapper entry
//!   dsh-desktop.patch.yml            Desktop patch layer passed via --patch
//!   harness/node_modules/...         Full @deepseek-ai/dsh dependency tree
//! ```
//!
//! The node_modules tree keeps its npm layout so `bin.js` resolves its
//! dependencies by walking upward from its own location.

use std::path::PathBuf;

use tauri::{Manager, Runtime};
use tauri::path::BaseDirectory;

use crate::harness_runtime::RuntimePaths;
use crate::paths;

/// Resolve a path inside the bundled resource directory.
fn resource_path<R: Runtime>(app: &tauri::AppHandle<R>, relative: &str) -> PathBuf {
    app.path()
        .resolve(relative, BaseDirectory::Resource)
        .unwrap_or_else(|_| PathBuf::from(relative))
}

/// Locate the bundled Node.js executable for the current platform.
pub fn node_executable<R: Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    resource_path(app, &format!("resources/node/{name}"))
}

/// The Harness CLI entry inside the bundled dependency tree.
pub fn dsh_entry<R: Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    resource_path(
        app,
        "resources/harness/node_modules/@deepseek-ai/dsh/lib/bin.js",
    )
}

/// Assemble the full runtime path set for a launch.
pub fn runtime_paths<R: Runtime>(app: &tauri::AppHandle<R>) -> RuntimePaths {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    RuntimePaths {
        node_executable: node_executable(app),
        node_entry: resource_path(app, "resources/harness-node-entry.mjs"),
        dsh_entry: dsh_entry(app),
        patch: resource_path(app, "resources/dsh-desktop.patch.yml"),
        dsh_home: paths::dsh_home(&data_dir),
        log_path: paths::harness_log_path(&data_dir),
        launch_directory: paths::launch_root(&data_dir),
    }
}

/// Path to a bundled HTML page served to the window (splash, recovery, …).
pub fn bundled_page<R: Runtime>(app: &tauri::AppHandle<R>, name: &str) -> PathBuf {
    resource_path(app, &format!("resources/{name}"))
}

/// Brand logo paths used by the mobile bridge.
pub fn brand_logo_paths<R: Runtime>(app: &tauri::AppHandle<R>) -> (PathBuf, PathBuf) {
    (
        resource_path(app, "resources/logo-light.png"),
        resource_path(app, "resources/logo-dark.png"),
    )
}

pub fn app_icon_path<R: Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    resource_path(app, "resources/app-icon.png")
}
