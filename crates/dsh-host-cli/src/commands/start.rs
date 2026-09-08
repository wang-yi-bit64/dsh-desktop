//! `start` / `stop` 子命令：Harness 生命周期。

use std::time::Duration;

use dsh_host::args::{parse_env_overrides, HarnessArgs};
use dsh_host::contracts::EXIT_OK;
use dsh_host::env::{capture_shell_environment, harness_env_with_overrides};
use dsh_host::launch::{LaunchEvent, Launcher, LauncherConfig, PortMode, RunningHarness};
use dsh_host::logging::AppLog;
use dsh_host::logs::{FailureCause, LogRing};
use dsh_host::paths::Layout;
use dsh_host::process::{
    clear_pid_file, is_process_alive, process_belongs_to, read_pid_file, terminate_process_tree,
};

use crate::cli::{LogLevelArg, PortModeArg, StartArgs, StopArgs};
use crate::commands::{apply_mock_if_requested, ExitCode};

/// `start`：启动 Harness，等待就绪后保持前台直到 ctrl+c 或子进程退出。
pub async fn run(args: StartArgs, log_level: LogLevelArg, json: bool) -> ExitCode {
    let mut layout = Layout::resolve(&args.resource, &args.data);
    apply_mock_if_requested(&mut layout, args.mock);
    if let Err(error) = layout.ensure_dirs() {
        eprintln!("[cli] 目录创建失败：{error}");
        return error.exit_code();
    }

    // 初始化应用日志：落盘全量，stdout 按 --log-level 过滤。
    let _app_log = AppLog::open(&layout, log_level.into());

    // C2 环境组装：shell 快照 + 契约项 + `--env` 覆盖项。
    let overrides = match parse_env_overrides(&args.env) {
        Ok(overrides) => overrides,
        Err(error) => {
            eprintln!("[cli] {error}");
            return dsh_host::contracts::EXIT_USAGE;
        }
    };
    let shell = match capture_shell_environment() {
        Ok(shell) => shell,
        Err(error) => {
            eprintln!("[cli] 环境捕获失败：{error}");
            return error.exit_code();
        }
    };
    let environment = harness_env_with_overrides(&layout, &shell, None, &overrides);

    let mut config = LauncherConfig::default();
    if let Some(seconds) = args.timeout {
        config.probe.total_timeout = Duration::from_secs(seconds);
    }
    // 端口策略：--port 显式给定（含 0）优先于 --port-mode。
    config.port_mode = match args.port {
        Some(0) => PortMode::Ephemeral,
        Some(port) => PortMode::Fixed(port),
        None => match args.port_mode {
            PortModeArg::Reserved => PortMode::Reserved,
            PortModeArg::Ephemeral => PortMode::Ephemeral,
        },
    };

    // dry-run：打印 argv 快照后退出，不派生子进程。
    if args.print_argv {
        let probe_port = match config.port_mode {
            PortMode::Reserved => dsh_host::launch::reserve_ephemeral_port().await,
            PortMode::Ephemeral => Ok(0),
            PortMode::Fixed(port) => Ok(port),
        };
        let port = match probe_port {
            Ok(port) => port,
            Err(error) => {
                eprintln!("[cli] 端口预留失败：{error}");
                return error.exit_code();
            }
        };
        let harness_args: HarnessArgs = build_preview_args(&layout, config.port_mode, port, &args);
        return print_argv_snapshot(&harness_args, &environment, json);
    }

    let mut launcher = Launcher::new(layout.clone(), config);
    if let Some(host) = args.host.clone() {
        launcher = launcher.with_host(host);
    }
    if args.open {
        launcher = launcher.with_no_open(false);
    }
    if !args.dsh_args.is_empty() {
        warn_passthrough_conflicts(&args.dsh_args);
        launcher = launcher.with_extra(args.dsh_args.clone());
    }

    println!("[cli] resource  = {}", layout.resource_dir.display());
    println!("[cli] dsh_home  = {}", layout.dsh_home.display());
    println!("[cli] launch    = {}", layout.launch_root.display());

    let running = launcher
        .run(Some(&environment), |event| match event {
            LaunchEvent::Log(line) => println!("{line}"),
            LaunchEvent::Spawned { pid, port } => println!("[cli] spawned pid={pid} port={port}"),
            LaunchEvent::TokenFound { endpoint } => {
                println!("[cli] token acquired (port {})", endpoint.port)
            }
            LaunchEvent::ReadyChecking { port } => println!("[cli] probing 127.0.0.1:{port} …"),
            LaunchEvent::Ready { endpoint } => println!("[cli] ready    {}", endpoint.base_url()),
            LaunchEvent::Failed { cause } => println!("[cli] failed   {cause}"),
            LaunchEvent::Preparing => println!("[cli] preparing"),
        })
        .await;

    match running {
        Ok(mut running) => {
            report_ready(&running, json);
            hold_until_exit(&mut running).await;
            EXIT_OK
        }
        Err(error) => {
            eprintln!("[cli] 启动失败（退出码 {}）：{error}", error.exit_code());
            if let Some(logs) = error_logs_hint(&error) {
                print_tail(&logs, 30);
            }
            eprintln!("[cli] 完整日志：{}", layout.log_path.display());
            error.exit_code()
        }
    }
}

/// 预览用的参数集（与 `Launcher::build_args` 同源的字段拼装）。
fn build_preview_args(
    layout: &Layout,
    port_mode: PortMode,
    port: u16,
    args: &StartArgs,
) -> HarnessArgs {
    let _ = port_mode;
    HarnessArgs {
        layout: layout.clone(),
        port,
        host: args
            .host
            .clone()
            .unwrap_or_else(|| dsh_host::contracts::HARNESS_HOST.to_string()),
        no_open: !args.open,
        extra: args.dsh_args.clone(),
    }
}

/// `--print-argv`：输出 program / args / cwd / env_delta（JSON）。
fn print_argv_snapshot(
    harness_args: &HarnessArgs,
    environment: &dsh_host::env::HarnessEnv,
    json: bool,
) -> ExitCode {
    let snapshot = harness_args.argv_snapshot();
    if json {
        let payload = serde_json::json!({
            "program": snapshot.program,
            "args": snapshot.args,
            "cwd": snapshot.cwd,
            "env": environment.as_pairs().iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect::<Vec<_>>(),
        });
        println!("{payload}");
    } else {
        println!("[cli] program = {}", snapshot.program.display());
        println!("[cli] cwd     = {}", snapshot.cwd.display());
        println!("[cli] args:");
        for arg in &snapshot.args {
            println!("  {arg}");
        }
        println!("[cli] env（契约项 + 覆盖项 + PATH）:");
        for (key, value) in environment.as_pairs() {
            println!("  {key}={value}");
        }
    }
    EXIT_OK
}

/// 就绪后的前台保持：ctrl+c 优雅停止，或跟随子进程退出。
async fn hold_until_exit(running: &mut RunningHarness) {
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

/// 透传段与契约参数同名时给出可观测的 warn（不拦截：语义由 dsh 的 yargs 决定）。
fn warn_passthrough_conflicts(dsh_args: &[String]) {
    const CONTRACT_ARGS: [&str; 4] = ["--host", "--port", "--patch", "--no-open"];
    for arg in dsh_args {
        if CONTRACT_ARGS.contains(&arg.as_str()) {
            eprintln!(
                "[desktop] {} passthrough overrides contract arg: {arg}",
                dsh_host::contracts::LOG_LEVEL_WARN.trim_end()
            );
        }
    }
}

fn report_ready(running: &RunningHarness, json: bool) {
    if json {
        let payload = serde_json::json!({
            "outcome": "ready",
            "pid": running.pid,
            "url": running.endpoint.url,
            "port": running.endpoint.port,
        });
        println!("{payload}");
    } else {
        println!("[cli] navigate → {}", running.endpoint.url);
    }
}

/// 失败时尽量给出日志尾部（当前错误未携带日志快照，先提示落盘位置）。
fn error_logs_hint(_error: &dsh_host::HostError) -> Option<LogRing> {
    None
}

fn print_tail(logs: &LogRing, lines: usize) {
    for line in logs.tail(lines) {
        println!("{line}");
    }
}

/// `stop`：终止 pidfile 记录的进程树（INV-3 兜底路径）。
pub fn stop(args: StopArgs, json: bool) -> ExitCode {
    let layout = Layout::resolve(&args.data, &args.data);
    let Some(record) = read_pid_file(&layout) else {
        if json {
            println!(
                "{}",
                serde_json::json!({"outcome": "stop", "stopped": false, "reason": "no_pidfile"})
            );
        } else {
            println!("[cli] 无 pidfile，无需停止：{}", layout.pid_file.display());
        }
        return EXIT_OK;
    };

    let alive = is_process_alive(record.pid);
    let ours = process_belongs_to(record.pid, &record.resource_dir);
    if alive && ours {
        terminate_process_tree(record.pid);
    }
    clear_pid_file(&layout);

    if json {
        println!(
            "{}",
            serde_json::json!({
                "outcome": "stop",
                "stopped": alive && ours,
                "pid": record.pid,
            })
        );
    } else if alive && ours {
        println!("[cli] 已终止 pid={}（port {}）", record.pid, record.port);
    } else {
        println!(
            "[cli] pid={} 已不存活或不属于本应用，仅清理 pidfile",
            record.pid
        );
    }

    // 归因兜底：若停止的是陌生进程，这不该发生在正常流程里。
    if alive && !ours {
        eprintln!(
            "[cli] {} pid={} 不属于本应用资源目录，未触碰",
            dsh_host::contracts::LOG_LEVEL_WARN.trim_end(),
            record.pid
        );
        return dsh_host::contracts::EXIT_UNEXPECTED;
    }
    EXIT_OK
}

/// 保留给未来：把 [`FailureCause`] 映射成 doctor 提示。
#[allow(dead_code)]
fn cause_hint(cause: &FailureCause) -> &'static str {
    if cause.is_plugin_fault() {
        "疑似插件故障：可尝试安全模式（阶段 5）或移除最近安装的插件"
    } else {
        "核心故障：查看 harness.log 尾部与 MANIFEST 校验结果"
    }
}
