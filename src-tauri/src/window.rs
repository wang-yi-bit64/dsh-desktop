//! Window navigation between the local shell pages and the Harness web UI.
//!
//! The main window starts on the splash page, moves to the Harness URL once
//! the runtime reports ready, and falls back to the error page on failure.

use tauri::{Manager, Runtime, WebviewWindow};

use crate::harness_runtime::RuntimePhase;

pub const MAIN_WINDOW: &str = "main";

pub fn main_window<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN_WINDOW)
}

/// Build an absolute URL for a bundled frontend page. Tauri serves the local
/// frontend from a platform-specific origin (`http://tauri.localhost` on
/// Windows, `tauri://localhost` elsewhere), and `navigate` rejects relative
/// URLs.
fn local_page(page: &str) -> tauri::Url {
    #[cfg(windows)]
    const ORIGIN: &str = "http://tauri.localhost/";
    #[cfg(not(windows))]
    const ORIGIN: &str = "tauri://localhost/";
    url::Url::parse(ORIGIN)
        .and_then(|base| base.join(page))
        .expect("bundled page url must be valid")
}

/// Navigate the main window to the ready Harness endpoint.
pub fn open_harness<R: Runtime>(app: &tauri::AppHandle<R>, url: &str, token: &str) {
    let Some(window) = main_window(app) else { return };
    let target = format!("{}/?token={}", url.trim_end_matches('/'), token);
    let _ = window.navigate(target.parse().unwrap_or_else(|_| {
        url.parse().expect("harness url must be valid")
    }));
}

/// Show the local error page.
pub fn show_error_page<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = main_window(app) else { return };
    let _ = window.navigate(local_page("error.html"));
}

/// Show the local splash page.
pub fn show_splash<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = main_window(app) else { return };
    let _ = window.navigate(local_page("index.html"));
}

/// Show the plugin recovery page with detection evidence in the query string.
pub fn show_recovery_page<R: Runtime>(app: &tauri::AppHandle<R>, plugins: &[String]) {
    let Some(window) = main_window(app) else { return };
    let joined = plugins.join(",");
    let target = format!("plugin-recovery.html?plugins={}", urlencoding(&joined));
    let _ = window.navigate(local_page(&target));
}

/// Show the safe-mode management page.
pub fn show_safe_mode_page<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = main_window(app) else { return };
    let _ = window.navigate(local_page("safe-mode.html"));
}

/// React to a runtime phase change by moving the window.
pub fn apply_phase<R: Runtime>(
    app: &tauri::AppHandle<R>,
    phase: RuntimePhase,
    url: Option<&str>,
    token: Option<&str>,
) {
    match phase {
        RuntimePhase::Ready => {
            if let (Some(url), Some(token)) = (url, token) {
                open_harness(app, url, token);
            }
        }
        RuntimePhase::Failed => show_error_page(app),
        RuntimePhase::Starting => show_splash(app),
        _ => {}
    }
}

fn urlencoding(input: &str) -> String {
    input
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}
