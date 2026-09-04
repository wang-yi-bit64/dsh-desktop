//! `dsh-host-cli` — 无 GUI 的 Harness 宿主排障入口。
//!
//! 计划 ADR-3 / INV-6：GUI 层只做壳与事件接线，主链路必须能在命令行里
//! 独立复现。现场排障时先跑 `dsh-host-cli start`，就能区分「宿主逻辑问题」
//! 与「Tauri 窗口/权限问题」。
//!
//! ```text
//! dsh-host-cli start  --resource <dir> --data <dir> [--timeout 45]
//! dsh-host-cli status --resource <dir> --data <dir>
//! dsh-host-cli tail   --data <dir> [--lines 30]
//! dsh-host-cli probe  --port 4173
//! ```

use std::path::PathBuf;
use std::time::Duration;

use clap::{Parser, Subcommand};
use dsh_host::contracts::HARNESS_HOST;
use dsh_host::launch::{LaunchEvent, LaunchOutcome, Launcher, LauncherConfig};
use dsh_host::logs::{LogLine, LogRing};
use dsh_host::paths::Layout;
use dsh_host::readiness::{is_healthy, probe_status};

#[derive(Parser, Debug)]
#[command(name = "dsh-host-cli", version, about = "Headless Harness host runner")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// 启动 Harness 并等待就绪，打印端点信息。
    Start {
        /// 只读资源目录（对应 `resource_dir()`）。
        #[arg(long)]
        resource: PathBuf,
        /// 可写用户数据目录（对应 `app_data_dir()`）。
        #[arg(long)]
        data: PathBuf,
        /// 就绪总超时（秒），默认取平台契约值。
        #[arg(long)]
        timeout: Option<u64>,
    },
    /// 打印解析出的目录布局与资源齐备性。
    Status {
        #[arg(long)]
        resource: PathBuf,
        #[arg(long)]
        data: PathBuf,
    },
    /// 打印最近 N 行 harness 日志。
    Tail {
        #[arg(long)]
        data: PathBuf,
        #[arg(long, default_value_t = 30)]
        lines: usize,
    },
    /// 对指定端口做一次 HTTP 就绪探测（契约 C4）。
    Probe {
        #[arg(long, default_value_t = 4173)]
        port: u16,
        #[arg(long, default_value_t = 2)]
        timeout: u64,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
        Command::Start {
            resource,
            data,
            timeout,
        } => start(resource, data, timeout).await,
        Command::Status { resource, data } => status(resource, data),
        Command::Tail { data, lines } => tail(data, lines),
        Command::Probe { port, timeout } => probe(port, timeout).await,
    }
}

async fn start(
    resource: PathBuf,
    data: PathBuf,
    timeout: Option<u64>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut layout = Layout::resolve(&resource, &data);
    apply_mock_if_requested(&mut layout);
    layout.ensure_dirs()?;

    let mut config = LauncherConfig::default();
    if let Some(seconds) = timeout {
        config.probe.total_timeout = Duration::from_secs(seconds);
    }

    let launcher = Launcher::new(layout.clone(), config);
    println!("[cli] resource  = {}", layout.resource_dir.display());
    println!("[cli] dsh_home  = {}", layout.dsh_home.display());
    println!("[cli] launch    = {}", layout.launch_root.display());

    let outcome = launcher
        .launch(None, |event| match event {
            LaunchEvent::Log(line) => println!("{line}"),
            LaunchEvent::Spawned { pid, port } => println!("[cli] spawned pid={pid} port={port}"),
            LaunchEvent::TokenFound { endpoint } => {
                println!("[cli] token acquired (port {})", endpoint.port)
            }
            LaunchEvent::ReadyChecking { port } => {
                println!("[cli] probing {HARNESS_HOST}:{port} …")
            }
            LaunchEvent::Ready { endpoint } => println!("[cli] ready    {}", endpoint.base_url()),
            LaunchEvent::Failed { cause } => println!("[cli] failed   {cause}"),
            LaunchEvent::Preparing => println!("[cli] preparing"),
        })
        .await?;

    match outcome {
        LaunchOutcome::Ready(mut running) => {
            println!("[cli] navigate → {}", running.endpoint.url);
            println!("[cli] ctrl+c to stop");
            let exit = running.take_exit();
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {
                    println!("[cli] stopping");
                    running.terminate();
                }
                exit = async {
                    match exit {
                        Some(receiver) => receiver.await.ok(),
                        None => None,
                    }
                } => {
                    println!("[cli] harness exited: {exit:?}");
                }
            }
        }
        LaunchOutcome::Failed { cause, logs } => {
            eprintln!("[cli] 启动失败：{cause}");
            print_tail(&logs, 30);
            std::process::exit(1);
        }
    }

    Ok(())
}

fn status(resource: PathBuf, data: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let layout = Layout::resolve(&resource, &data);
    println!("resource_dir : {}", layout.resource_dir.display());
    println!("app_data_dir : {}", layout.app_data_dir.display());
    println!("node         : {}", layout.node_executable.display());
    println!("node_entry   : {}", layout.node_entry.display());
    println!("dsh_entry    : {}", layout.dsh_entry.display());
    println!("patch        : {}", layout.patch.display());
    println!("dsh_home     : {}", layout.dsh_home.display());
    println!("launch_root  : {}", layout.launch_root.display());
    println!("harness.log  : {}", layout.log_path.display());
    println!("pid_file     : {}", layout.pid_file.display());

    let missing = layout.missing_resources();
    if missing.is_empty() {
        println!("resources    : ok");
    } else {
        println!("resources    : MISSING");
        for (name, path) in missing {
            println!("  - {name}: {}", path.display());
        }
        std::process::exit(2);
    }
    Ok(())
}

fn tail(data: PathBuf, lines: usize) -> Result<(), Box<dyn std::error::Error>> {
    let layout = Layout::resolve(PathBuf::from("."), &data);
    if !layout.log_path.exists() {
        println!("[cli] 尚无日志文件：{}", layout.log_path.display());
        return Ok(());
    }
    let content = std::fs::read_to_string(&layout.log_path)?;
    let mut ring = LogRing::new();
    for line in content.lines() {
        if let Some(parsed) = LogLine::parse(line) {
            ring.push(parsed);
        }
    }
    for line in ring.tail(lines) {
        println!("{line}");
    }
    Ok(())
}

async fn probe(port: u16, timeout: u64) -> Result<(), Box<dyn std::error::Error>> {
    let status = probe_status(HARNESS_HOST, port, Duration::from_secs(timeout)).await;
    let healthy = is_healthy(status, true);
    println!(
        "[cli] {HARNESS_HOST}:{port} → status={} healthy(token known)={healthy}",
        status
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unreachable".to_string())
    );
    Ok(())
}

fn print_tail(logs: &LogRing, lines: usize) {
    for line in logs.tail(lines) {
        println!("{line}");
    }
}

/// `DSH_MOCK=1`：把入口替换成 mock-harness（与 Tauri 侧 `layout.rs` 同语义）。
///
/// mock 只解析 `--port` / `--delay` / `--fail`，其余 argv 忽略；
/// 故障模式可用 `DSH_MOCK_FAIL` / `DSH_MOCK_DELAY` 注入。
fn apply_mock_if_requested(layout: &mut dsh_host::paths::Layout) {
    let mock_enabled = std::env::var("DSH_MOCK")
        .map(|value| value == "1")
        .unwrap_or(false);
    if !mock_enabled {
        return;
    }
    // 资源目录由 fault-inject 组装，mock 脚本就放在其中。
    let mock = layout.resource_dir.join("mock-harness.mjs");
    let mock = std::fs::canonicalize(&mock).unwrap_or(mock);
    let mock_display = mock.display().to_string();
    layout.node_entry = mock.clone();
    layout.dsh_entry = mock;
    eprintln!("[cli] DSH_MOCK=1 → 入口已替换为 {mock_display}");
}
