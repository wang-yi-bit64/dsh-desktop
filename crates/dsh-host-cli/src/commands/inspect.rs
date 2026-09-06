//! `status` / `probe` / `tail` 子命令：只读检查。

use std::time::Duration;

use dsh_host::contracts::{EXIT_MISSING_RESOURCE, EXIT_OK, EXIT_UNEXPECTED};
use dsh_host::logs::LogLine;
use dsh_host::paths::Layout;
use dsh_host::readiness::{is_healthy, probe_status};

use crate::cli::{ProbeArgs, StatusArgs, TailArgs};
use crate::commands::ExitCode;

/// `status`：打印布局与资源齐备性（感知 mock，修复 A4）。
pub fn status(args: StatusArgs, json: bool) -> ExitCode {
    let mut layout = Layout::resolve(&args.resource, &args.data);
    // mock 模式下资源判定必须与实际启动路径一致，否则排障会被误导。
    let mocked = crate::commands::apply_mock_if_requested(&mut layout, false);

    let missing = layout.missing_resources();
    if json {
        println!(
            "{}",
            serde_json::json!({
                "resource_dir": layout.resource_dir,
                "app_data_dir": layout.app_data_dir,
                "mocked": mocked,
                "missing": missing.iter().map(|(name, path)| serde_json::json!({
                    "name": name,
                    "path": path,
                })).collect::<Vec<_>>(),
            })
        );
    } else {
        println!("resource_dir : {}", layout.resource_dir.display());
        println!("app_data_dir : {}", layout.app_data_dir.display());
        println!("mocked       : {mocked}");
        println!("node         : {}", layout.node_executable.display());
        println!("node_entry   : {}", layout.node_entry.display());
        println!("dsh_entry    : {}", layout.dsh_entry.display());
        println!("patch        : {}", layout.patch.display());
        println!("manifest     : {}", layout.manifest.display());
        println!("dsh_home     : {}", layout.dsh_home.display());
        println!("launch_root  : {}", layout.launch_root.display());
        println!("harness.log  : {}", layout.log_path.display());
        println!("app.log      : {}", layout.app_log_path.display());
        println!("pid_file     : {}", layout.pid_file.display());

        if let Some(record) = dsh_host::process::read_pid_file(&layout) {
            let alive = dsh_host::process::is_process_alive(record.pid);
            println!(
                "pid_file     : pid={} port={} alive={alive}",
                record.pid, record.port
            );
        }
    }

    if missing.is_empty() {
        if !json {
            println!("resources    : ok");
        }
        EXIT_OK
    } else {
        if !json {
            println!("resources    : MISSING");
            for (name, path) in missing {
                println!("  - {name}: {}", path.display());
            }
        }
        EXIT_MISSING_RESOURCE
    }
}

/// `tail`：读取最近 N 行 harness 日志（只依赖 data 目录，修复 A5）。
pub fn tail(args: TailArgs) -> ExitCode {
    // tail 只读 `<data>/logs/harness.log`；resource 位置参数语义上不参与，
    // 用 data 目录本身占位并注明，避免 `.` 这类无意义魔数。
    let layout = Layout::resolve(&args.data, &args.data);
    if !layout.log_path.exists() {
        println!("[cli] 尚无日志文件：{}", layout.log_path.display());
        return EXIT_OK;
    }
    let content = match std::fs::read_to_string(&layout.log_path) {
        Ok(content) => content,
        Err(error) => {
            eprintln!("[cli] 读取日志失败：{error}");
            return EXIT_UNEXPECTED;
        }
    };
    let mut count = 0usize;
    // 从后往前扫，找到第 N 行后正序输出（避免把整个日志灌进内存环形缓冲）。
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(args.lines);
    for line in &lines[start..] {
        match LogLine::parse(line) {
            Some(parsed) => println!("{parsed}"),
            None => println!("{line}"),
        }
        count += 1;
    }
    if count == 0 {
        println!("[cli] 日志为空");
    }
    EXIT_OK
}

/// `probe`：单次 HTTP 就绪探测（契约 C4）。
pub async fn probe(args: ProbeArgs) -> ExitCode {
    let status = probe_status(
        dsh_host::contracts::HARNESS_HOST,
        args.port,
        Duration::from_secs(args.timeout),
    )
    .await;
    let healthy = is_healthy(status, true);
    println!(
        "[cli] {}:{} → status={} healthy(token known)={healthy}",
        dsh_host::contracts::HARNESS_HOST,
        args.port,
        status
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unreachable".to_string())
    );
    if healthy {
        EXIT_OK
    } else {
        EXIT_UNEXPECTED
    }
}
