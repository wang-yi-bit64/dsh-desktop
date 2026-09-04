//! Harness child-process lifecycle.
//!
//! Rust port of `src/main/runtime/harness-runtime.ts`. Launches the bundled
//! Node.js runtime against the Harness entry on a reserved loopback port,
//! captures its output, extracts the per-process launch token, polls for
//! readiness and manages graceful shutdown.

use std::collections::VecDeque;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex;

use crate::shell_env;

pub const STATUS_EVENT: &str = "harness://status";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimePhase {
    Idle,
    Starting,
    Ready,
    Stopping,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeSnapshot {
    pub phase: RuntimePhase,
    pub message: String,
    pub launch_directory: Option<String>,
    pub url: Option<String>,
    pub auth_token: Option<String>,
    pub logs: Vec<String>,
}

/// Everything needed to launch the bundled Harness.
#[derive(Clone)]
pub struct RuntimePaths {
    /// Bundled Node.js executable (`resources/node/node(.exe)`).
    pub node_executable: PathBuf,
    /// `harness-node-entry.mjs` wrapper entry.
    pub node_entry: PathBuf,
    /// Harness CLI entry (`@deepseek-ai/dsh/lib/bin.js`).
    pub dsh_entry: PathBuf,
    /// `dsh-desktop.patch.yml` desktop patch layer.
    pub patch: PathBuf,
    /// DSH_HOME for profiles/sessions/settings.
    pub dsh_home: PathBuf,
    /// Desktop diagnostics log.
    pub log_path: PathBuf,
    /// Application-owned launch directory (child cwd).
    pub launch_directory: PathBuf,
}

struct RuntimeInner {
    phase: RuntimePhase,
    message: String,
    launch_directory: Option<String>,
    url: Option<String>,
    auth_token: Option<String>,
    log_lines: VecDeque<String>,
    child: Option<Child>,
    log_file: Option<std::fs::File>,
}

pub struct HarnessRuntime {
    app: AppHandle,
    paths: RuntimePaths,
    inner: Arc<Mutex<RuntimeInner>>,
}

impl HarnessRuntime {
    pub fn new(app: AppHandle, paths: RuntimePaths) -> Self {
        Self {
            app,
            paths,
            inner: Arc::new(Mutex::new(RuntimeInner {
                phase: RuntimePhase::Idle,
                message: "Harness is not running.".into(),
                launch_directory: None,
                url: None,
                auth_token: None,
                log_lines: VecDeque::with_capacity(220),
                child: None,
                log_file: None,
            })),
        }
    }

    pub async fn snapshot(&self) -> RuntimeSnapshot {
        let inner = self.inner.lock().await;
        RuntimeSnapshot {
            phase: inner.phase,
            message: inner.message.clone(),
            launch_directory: inner.launch_directory.clone(),
            url: inner.url.clone(),
            auth_token: inner.auth_token.clone(),
            logs: inner.log_lines.iter().cloned().collect(),
        }
    }

    pub async fn is_ready(&self) -> bool {
        self.inner.lock().await.phase == RuntimePhase::Ready
    }

    /// Launch Harness and wait for readiness. Emits status events throughout.
    pub async fn start(self: &Arc<Self>) {
        self.stop().await;

        let paths = self.paths.clone();

        // Entry checks mirror the Electron runtime: fail fast with a message
        // naming the missing piece instead of hanging on readiness.
        if !paths.dsh_entry.exists() {
            self.set_state(
                RuntimePhase::Failed,
                format!("Harness entry was not found: {}", paths.dsh_entry.display()),
            )
            .await;
            return;
        }
        if !paths.node_executable.exists() {
            self.set_state(
                RuntimePhase::Failed,
                format!(
                    "Bundled Node.js runtime was not found: {}",
                    paths.node_executable.display()
                ),
            )
            .await;
            return;
        }
        if !paths.node_entry.exists() {
            self.set_state(
                RuntimePhase::Failed,
                format!(
                    "Harness diagnostic entry was not found: {}",
                    paths.node_entry.display()
                ),
            )
            .await;
            return;
        }
        if !paths.patch.exists() {
            self.set_state(
                RuntimePhase::Failed,
                format!("DSH Desktop patch was not found: {}", paths.patch.display()),
            )
            .await;
            return;
        }

        if let Err(error) = std::fs::create_dir_all(&paths.dsh_home) {
            self.set_state(
                RuntimePhase::Failed,
                format!("Could not create DSH_HOME: {error}"),
            )
            .await;
            return;
        }
        if let Some(parent) = paths.log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let port = match reserve_port().await {
            Ok(port) => port,
            Err(error) => {
                self.set_state(
                    RuntimePhase::Failed,
                    format!("Could not reserve a local port: {error}"),
                )
                .await;
                return;
            }
        };
        let url = format!("http://127.0.0.1:{port}");
        let args = build_node_arguments(&paths, port);
        let startup_timeout = if cfg!(windows) {
            Duration::from_secs(120)
        } else {
            Duration::from_secs(45)
        };

        {
            let mut inner = self.inner.lock().await;
            inner.launch_directory = Some(paths.launch_directory.display().to_string());
            inner.url = None;
            inner.auth_token = None;
            inner.log_file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&paths.log_path)
                .ok();
        }

        self.write_log("").await;
        self.write_log(&format!(
            "[desktop] starting {}",
            chrono_now()
        ))
        .await;
        self.write_log(&format!(
            "[desktop] launch directory {}",
            paths.launch_directory.display()
        ))
        .await;
        self.write_log(&format!("[desktop] endpoint {url}"))
            .await;
        self.write_log(&format!("[desktop] node {}", paths.node_executable.display()))
            .await;
        self.write_log(&format!("[desktop] entry {}", paths.node_entry.display()))
            .await;
        self.write_log(&format!("[desktop] dsh {}", paths.dsh_entry.display()))
            .await;
        self.write_log(&format!("[desktop] patch {}", paths.patch.display()))
            .await;
        self.set_state(RuntimePhase::Starting, "Starting DeepSeek Harness…".to_string())
            .await;

        let spawn_result = spawn_harness(&paths, &args).await;
        let mut child = match spawn_result {
            Ok(child) => child,
            Err(error) => {
                self.write_log(&format!("[desktop] launch failed: {error}"))
                    .await;
                self.set_state(
                    RuntimePhase::Failed,
                    format!("Harness could not start: {error}"),
                )
                .await;
                return;
            }
        };

        self.write_log("[desktop] Bundled Node.js Harness process started")
            .await;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        {
            let mut inner = self.inner.lock().await;
            inner.child = Some(child);
        }

        // Line readers feed the shared log buffer and extract the launch token.
        let runtime = Arc::clone(self);
        let stdout_task = {
            let runtime = Arc::clone(&runtime);
            tokio::spawn(async move {
                if let Some(stdout) = stdout {
                    let mut lines = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        runtime.handle_line("stdout", &line).await;
                    }
                }
            })
        };
        let stderr_task = {
            let runtime = Arc::clone(&runtime);
            tokio::spawn(async move {
                if let Some(stderr) = stderr {
                    let mut lines = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        runtime.handle_line("stderr", &line).await;
                    }
                }
            })
        };

        // Readiness loop: the launch token must be present and the probe must
        // stay healthy for a 500ms stability window.
        let started_at = Instant::now();
        let deadline = started_at + startup_timeout;
        let mut ready_since: Option<Instant> = None;
        let mut last_progress = Instant::now();
        let mut ready = false;

        while Instant::now() < deadline {
            let alive = {
                let mut inner = self.inner.lock().await;
                match inner.child.as_mut() {
                    Some(child) => child.try_wait().ok().flatten().is_none(),
                    None => false,
                }
            };
            if !alive {
                break;
            }

            // Early failure: the entry rejected before the port opened.
            if let Some(cause) = self.dsh_entry_failure_cause().await {
                self.write_log(
                    "[desktop] Harness entry failed during startup; stopping immediately",
                )
                .await;
                self.stop_child().await;
                self.set_state(
                    RuntimePhase::Failed,
                    format!("Harness could not start.\n{cause}"),
                )
                .await;
                return;
            }

            let token = self.inner.lock().await.auth_token.clone();
            let healthy = match probe_status(&url).await {
                Some(status) => {
                    token.is_some() && (200..500).contains(&status)
                }
                None => false,
            };

            let now = Instant::now();
            if healthy {
                let stable_since = *ready_since.get_or_insert(now);
                if now.duration_since(stable_since) >= Duration::from_millis(500) {
                    ready = true;
                    break;
                }
            } else {
                ready_since = None;
            }

            if last_progress.elapsed() >= Duration::from_secs(10) {
                last_progress = now;
                self.write_log(&format!(
                    "[desktop] waiting for Harness ({}s)",
                    started_at.elapsed().as_secs()
                ))
                .await;
            }

            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        stdout_task.abort();
        stderr_task.abort();

        if !ready {
            self.stop_child().await;
            if self.inner.lock().await.phase == RuntimePhase::Starting {
                let cause = self.failure_cause().await;
                let message = if started_at.elapsed() >= startup_timeout {
                    format!(
                        "Harness did not become ready within {} seconds.",
                        startup_timeout.as_secs()
                    )
                } else {
                    "Harness stopped unexpectedly during startup.".to_string()
                };
                let message = match cause {
                    Some(cause) => format!("{message}\n{cause}"),
                    None => message,
                };
                self.set_state(RuntimePhase::Failed, message).await;
            }
            return;
        }

        {
            let mut inner = self.inner.lock().await;
            inner.url = Some(url);
        }
        self.set_state(RuntimePhase::Ready, "Harness is ready.".to_string()).await;

        // Watch the child so an unexpected exit flips the state machine.
        let runtime = Arc::clone(self);
        tokio::spawn(async move {
            let exit = {
                let mut inner = runtime.inner.lock().await;
                match inner.child.as_mut() {
                    Some(child) => child.wait().await,
                    None => return,
                }
            };
            let mut inner = runtime.inner.lock().await;
            // Only react when this child is still the active launch.
            if inner.phase != RuntimePhase::Ready && inner.phase != RuntimePhase::Starting {
                return;
            }
            inner.child = None;
            let detail = match exit {
                Ok(status) => format!("exit code {}", status.code().unwrap_or(-1)),
                Err(error) => format!("wait failed: {error}"),
            };
            drop(inner);
            runtime
                .write_log(&format!("[node] Harness process exited ({detail})"))
                .await;
            let cause = runtime.failure_cause().await;
            let message = match cause {
                Some(cause) => format!("Harness stopped unexpectedly ({detail}).\n{cause}"),
                None => format!("Harness stopped unexpectedly ({detail})."),
            };
            runtime.set_state(RuntimePhase::Failed, message).await;
        });
    }

    /// Gracefully stop the Harness child process.
    pub async fn stop(&self) {
        let has_child = self.inner.lock().await.child.is_some();
        if !has_child {
            let mut inner = self.inner.lock().await;
            inner.log_file = None;
            if inner.phase != RuntimePhase::Failed {
                inner.phase = RuntimePhase::Idle;
                inner.message = "Harness is not running.".into();
            }
            drop(inner);
            self.emit_status().await;
            return;
        }

        self.set_state(RuntimePhase::Stopping, "Stopping Harness…".to_string())
            .await;
        self.stop_child().await;
        let mut inner = self.inner.lock().await;
        inner.log_file = None;
        inner.url = None;
        inner.auth_token = None;
        inner.phase = RuntimePhase::Idle;
        inner.message = "Harness is not running.".into();
        drop(inner);
        self.emit_status().await;
    }

    async fn stop_child(&self) {
        let mut child = self.inner.lock().await.child.take();
        let Some(child) = child.as_mut() else {
            return;
        };

        if cfg!(windows) {
            // Kill the whole process tree: Harness spawns pwsh/git/ripgrep
            // children that must not survive the desktop app.
            if let Some(pid) = child.id() {
                let _ = tokio::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                    .output()
                    .await;
                let _ = tokio::time::timeout(Duration::from_secs(4), child.wait()).await;
                return;
            }
        }

        #[cfg(unix)]
        {
            if let Some(pid) = child.id() {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
                let exited = tokio::time::timeout(Duration::from_secs(4), child.wait()).await;
                if exited.is_err() {
                    let _ = child.kill().await;
                }
                return;
            }
        }

        let _ = child.kill().await;
    }

    async fn handle_line(&self, source: &str, line: &str) {
        if line.is_empty() {
            return;
        }
        let formatted = format!("[{source}] {line}");
        let token = if source == "stdout" {
            extract_launch_token(line)
        } else {
            None
        };
        {
            let mut inner = self.inner.lock().await;
            if inner.auth_token.is_none() {
                if let Some(token) = token {
                    inner.auth_token = Some(token);
                }
            }
            push_log_line(&mut inner.log_lines, &formatted);
            if let Some(file) = inner.log_file.as_mut() {
                let _ = writeln!(file, "{formatted}");
            }
        }
    }

    async fn write_log(&self, line: &str) {
        let mut inner = self.inner.lock().await;
        push_log_line(&mut inner.log_lines, line);
        if let Some(file) = inner.log_file.as_mut() {
            let _ = writeln!(file, "{line}");
        }
    }

    async fn set_state(&self, phase: RuntimePhase, message: String) {
        {
            let mut inner = self.inner.lock().await;
            inner.phase = phase;
            inner.message = message;
        }
        self.emit_status().await;
    }

    async fn emit_status(&self) {
        let snapshot = self.snapshot().await;
        let _ = self.app.emit(STATUS_EVENT, &snapshot);
    }

    /// Scan the current attempt's stderr for a DSH entry rejection.
    async fn dsh_entry_failure_cause(&self) -> Option<String> {
        let inner = self.inner.lock().await;
        let attempt = latest_attempt_logs(&inner.log_lines);
        attempt.iter().find_map(|line| {
            let text = line.strip_prefix("[stderr] ")?;
            capture_match(text, r"DSH entry failed:\s*(.+)")
        })
    }

    /// Best-effort failure cause from the latest attempt's stderr.
    async fn failure_cause(&self) -> Option<String> {
        let inner = self.inner.lock().await;
        let attempt = latest_attempt_logs(&inner.log_lines);
        let mut stderr_lines: Vec<&str> = Vec::new();
        let mut dsh_entry_error = None;
        let mut uncaught_error = None;

        for line in attempt {
            let Some(text) = line.strip_prefix("[stderr] ") else {
                continue;
            };
            stderr_lines.push(text);
            if dsh_entry_error.is_none() {
                dsh_entry_error = capture_match(text, r"DSH entry failed:\s*(.+)");
            }
            if uncaught_error.is_none() {
                uncaught_error = capture_match(text, r"uncaught exception:\s*(.+)")
                    .or_else(|| capture_match(text, r"unhandled rejection:\s*(.+)"));
            }
        }

        if let Some(cause) = dsh_entry_error {
            return Some(cause);
        }
        if let Some(cause) = uncaught_error {
            return Some(cause);
        }
        for line in stderr_lines.iter().rev() {
            let line = line.trim();
            if !line.is_empty()
                && line.len() < 200
                && (line.contains("error")
                    || line.contains("Error")
                    || line.contains("ERROR")
                    || line.contains("failed")
                    || line.contains("Failed")
                    || line.contains("FAILED"))
            {
                return Some(line.to_string());
            }
        }
        stderr_lines
            .last()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty() && line.len() < 200)
            .map(|line| line.to_string())
    }
}

fn push_log_line(lines: &mut VecDeque<String>, line: &str) {
    lines.push_back(line.to_string());
    while lines.len() > 200 {
        lines.pop_front();
    }
}

fn latest_attempt_logs(log_lines: &VecDeque<String>) -> Vec<&String> {
    let mut start = 0;
    for (index, line) in log_lines.iter().enumerate() {
        if line.trim_start().starts_with("[desktop] starting ") {
            start = index + 1;
        }
    }
    log_lines.iter().skip(start).collect()
}

fn capture_match(text: &str, pattern: &str) -> Option<String> {
    let regex = regex::Regex::new(pattern).ok()?;
    regex
        .captures(text)
        .and_then(|captures| captures.get(1))
        .map(|m| m.as_str().trim().to_string())
}

/// The process launch token from the Harness URL line.
///
/// The Host prints one root URL carrying a per-process token; only
/// `GET /?token=...` exchanges it for the signed session cookie.
pub fn extract_launch_token(line: &str) -> Option<String> {
    let regex = regex::Regex::new(r"\bdsh web:\s*(\S+)").ok()?;
    let raw_url = regex.captures(line)?.get(1)?.as_str();
    let parsed = url::Url::parse(raw_url).ok()?;
    let token = parsed
        .query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())?;
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// `web --patch <patch> --no-open --host 127.0.0.1 --port <port>`
pub fn build_harness_arguments(paths: &RuntimePaths, port: u16) -> Vec<String> {
    vec![
        "web".to_string(),
        "--patch".to_string(),
        paths.patch.display().to_string(),
        // The desktop window is the only intended surface; without this
        // Harness hands the loopback URL to the system browser on every launch.
        "--no-open".to_string(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
    ]
}

/// `--expose-internals <node-entry> <dsh-entry> <harness args>`
///
/// `--expose-internals` is required by Cordis HMR and is granted only to this
/// isolated child process, never to the web view.
pub fn build_node_arguments(paths: &RuntimePaths, port: u16) -> Vec<String> {
    let mut args = vec![
        "--expose-internals".to_string(),
        paths.node_entry.display().to_string(),
        paths.dsh_entry.display().to_string(),
    ];
    args.extend(build_harness_arguments(paths, port));
    args
}

/// Reserve a loopback port by binding port 0 and releasing it.
async fn reserve_port() -> std::io::Result<u16> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// One HTTP GET against the loopback endpoint; returns the status code.
async fn probe_status(url: &str) -> Option<u16> {
    let address = url.trim_start_matches("http://");
    let stream =
        tokio::time::timeout(Duration::from_secs(1), tokio::net::TcpStream::connect(address))
            .await
            .ok()?
            .ok()?;
    let request = format!(
        "GET / HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    );
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = stream;
    stream.write_all(request.as_bytes()).await.ok()?;
    let mut buffer = vec![0u8; 1024];
    let read = tokio::time::timeout(Duration::from_secs(1), stream.read(&mut buffer))
        .await
        .ok()?
        .ok()?;
    let head = String::from_utf8_lossy(&buffer[..read]);
    // HTTP/1.1 200 OK
    let status = head.split_whitespace().nth(1)?.parse::<u16>().ok()?;
    Some(status)
}

async fn spawn_harness(paths: &RuntimePaths, args: &[String]) -> std::io::Result<Child> {
    let environment = shell_env::resolve_shell_environment();
    let path_value = shell_env::resolve_environment_path(environment);

    let mut command = tokio::process::Command::new(&paths.node_executable);
    command
        .args(args)
        .current_dir(&paths.launch_directory)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        // ELECTRON_RUN_AS_NODE never applies here, but keep the environment
        // clean of any host-specific overrides regardless.
        .env_remove("ELECTRON_RUN_AS_NODE")
        .env("DSH_HOME", &paths.dsh_home)
        .env("NO_COLOR", "1")
        .env("npm_config_side_effects_cache", "false")
        .env("PNPM_CONFIG_SIDE_EFFECTS_CACHE", "false");

    // Inherit the full shell environment (PATH from the user's profile).
    for (name, value) in environment {
        if name.eq_ignore_ascii_case("path") {
            continue;
        }
        command.env(name, value);
    }
    let path_key = if cfg!(windows) { "Path" } else { "PATH" };
    command.env(path_key, path_value);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Detached process group: a child calling os.kill(pid, 0) must not
        // broadcast Ctrl+C to the desktop shell (upstream issue #208).
        // CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW.
        command.creation_flags(0x0000_0200 | 0x0800_0000);
    }

    command.kill_on_drop(false).spawn()
}

fn chrono_now() -> String {
    // RFC3339-ish timestamp without pulling in chrono.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("{now}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_token_from_url_line() {
        let line = "dsh web: http://127.0.0.1:4321/?token=abc123";
        assert_eq!(extract_launch_token(line), Some("abc123".into()));
    }

    #[test]
    fn no_token_without_query() {
        let line = "dsh web: http://127.0.0.1:4321/";
        assert_eq!(extract_launch_token(line), None);
    }

    #[test]
    fn ignores_other_lines() {
        assert_eq!(extract_launch_token("some other output"), None);
    }

    #[test]
    fn harness_arguments_are_stable() {
        let paths = RuntimePaths {
            node_executable: PathBuf::from("node"),
            node_entry: PathBuf::from("entry.mjs"),
            dsh_entry: PathBuf::from("bin.js"),
            patch: PathBuf::from("patch.yml"),
            dsh_home: PathBuf::from("home"),
            log_path: PathBuf::from("log"),
            launch_directory: PathBuf::from("launch"),
        };
        assert_eq!(
            build_harness_arguments(&paths, 1234),
            vec![
                "web",
                "--patch",
                "patch.yml",
                "--no-open",
                "--host",
                "127.0.0.1",
                "--port",
                "1234"
            ]
        );
        let node_args = build_node_arguments(&paths, 1234);
        assert_eq!(node_args[0], "--expose-internals");
        assert_eq!(node_args[1], "entry.mjs");
        assert_eq!(node_args[2], "bin.js");
    }
}
