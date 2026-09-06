//! `doctor` 子命令：环境自检。
//!
//! 输出 PASS / WARN / FAIL 三态表；任一 FAIL 即退出码 3（EXIT_MISSING_RESOURCE）。
//! 检查项对应 `contracts::MIN_NODE_MAJOR` / `RECOMMENDED_NODE_MAJOR` 与 C8 布局。

use std::net::TcpListener;

use dsh_host::contracts::{
    DEFAULT_PROBE_PORT, EXIT_MISSING_RESOURCE, EXIT_OK, MIN_NODE_MAJOR, RECOMMENDED_NODE_MAJOR,
};
use dsh_host::paths::Layout;

use crate::cli::DoctorArgs;
use crate::commands::ExitCode;

/// 单项检查结果。
struct Check {
    status: Status,
    name: &'static str,
    detail: String,
}

#[derive(PartialEq, Eq)]
enum Status {
    Pass,
    Warn,
    Fail,
}

/// 执行环境自检。
pub fn run(args: DoctorArgs) -> ExitCode {
    let mut layout = Layout::resolve(&args.resource, &args.data);
    crate::commands::apply_mock_if_requested(&mut layout, false);

    let mut checks = Vec::new();

    // 1. node 可执行文件存在 + 版本达标。
    checks.push(check_node(&layout));

    // 2. 四个必需资源。
    let missing = layout.missing_resources();
    checks.push(if missing.is_empty() {
        Check {
            status: Status::Pass,
            name: "resources",
            detail: "node_entry / dsh_entry / patch / node_executable 齐备".to_string(),
        }
    } else {
        Check {
            status: Status::Fail,
            name: "resources",
            detail: missing
                .iter()
                .map(|(name, path)| format!("{name} 缺失（{}）", path.display()))
                .collect::<Vec<_>>()
                .join("；"),
        }
    });

    // 3. MANIFEST（warning 级：组装清单缺失不阻断，但值得知晓）。
    checks.push(if layout.manifest.exists() {
        Check {
            status: Status::Pass,
            name: "manifest",
            detail: layout.manifest.display().to_string(),
        }
    } else {
        Check {
            status: Status::Warn,
            name: "manifest",
            detail: format!("{} 不存在（未跑过 prepare:harness？）", layout.manifest.display()),
        }
    });

    // 4. logs 目录可写（保证 ensure_dirs 后可写）。
    checks.push(match layout.ensure_dirs() {
        Ok(()) => match std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&layout.app_log_path)
        {
            Ok(_) => Check {
                status: Status::Pass,
                name: "logs",
                detail: format!("可写：{}", layout.log_path.display()),
            },
            Err(error) => Check {
                status: Status::Fail,
                name: "logs",
                detail: format!("无法写入 {}：{error}", layout.app_log_path.display()),
            },
        },
        Err(error) => Check {
            status: Status::Fail,
            name: "logs",
            detail: format!("目录创建失败：{error}"),
        },
    });

    // 5. 默认探测端口占用情况。
    checks.push(check_port(DEFAULT_PROBE_PORT));

    // 6. pidfile 状态。
    checks.push(match dsh_host::process::read_pid_file(&layout) {
        None => Check {
            status: Status::Pass,
            name: "pidfile",
            detail: "无残留".to_string(),
        },
        Some(record) => {
            let alive = dsh_host::process::is_process_alive(record.pid);
            let ours = dsh_host::process::process_belongs_to(record.pid, &record.resource_dir);
            if alive && ours {
                Check {
                    status: Status::Warn,
                    name: "pidfile",
                    detail: format!(
                        "记录的进程仍存活（pid={} port={}），start 前会自动清扫",
                        record.pid, record.port
                    ),
                }
            } else {
                Check {
                    status: Status::Pass,
                    name: "pidfile",
                    detail: format!("记录已失效（pid={} alive={alive}）", record.pid),
                }
            }
        }
    });

    // 输出三态表。
    println!("{:<6} {:<12} {}", "STATE", "CHECK", "DETAIL");
    let mut failed = 0usize;
    let mut warned = 0usize;
    for check in &checks {
        let state = match check.status {
            Status::Pass => {
                println!("{:<6} {:<12} {}", "PASS", check.name, check.detail);
                continue;
            }
            Status::Warn => {
                warned += 1;
                "WARN"
            }
            Status::Fail => {
                failed += 1;
                "FAIL"
            }
        };
        println!("{state:<6} {:<12} {}", check.name, check.detail);
    }

    println!();
    println!(
        "summary: {} checks, {failed} fail, {warned} warn",
        checks.len()
    );
    if failed > 0 {
        EXIT_MISSING_RESOURCE
    } else {
        EXIT_OK
    }
}

/// node 版本检查（版本不足 → FAIL / WARN）。
fn check_node(layout: &Layout) -> Check {
    if !layout.node_executable.exists() {
        return Check {
            status: Status::Fail,
            name: "node",
            detail: format!("不存在：{}", layout.node_executable.display()),
        };
    }
    let output = std::process::Command::new(&layout.node_executable)
        .arg("--version")
        .output();
    let Ok(output) = output else {
        return Check {
            status: Status::Fail,
            name: "node",
            detail: "无法执行 --version".to_string(),
        };
    };
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // 形如 v22.11.0。
    let major: u32 = version
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|part| part.parse().ok())
        .unwrap_or(0);
    if major >= RECOMMENDED_NODE_MAJOR {
        Check {
            status: Status::Pass,
            name: "node",
            detail: format!("{version}（≥ 推荐 {RECOMMENDED_NODE_MAJOR}）"),
        }
    } else if major >= MIN_NODE_MAJOR {
        Check {
            status: Status::Warn,
            name: "node",
            detail: format!(
                "{version}：低于推荐 {RECOMMENDED_NODE_MAJOR}，但 ≥ 硬下限 {MIN_NODE_MAJOR}"
            ),
        }
    } else {
        Check {
            status: Status::Fail,
            name: "node",
            detail: format!(
                "{version}：低于硬下限 {MIN_NODE_MAJOR}（Harness 需要 Node ≥ {MIN_NODE_MAJOR}）"
            ),
        }
    }
}

/// 端口占用检查（只检测绑定冲突，不判定服务健康）。
fn check_port(port: u16) -> Check {
    match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => {
            drop(listener);
            Check {
                status: Status::Pass,
                name: "port",
                detail: format!("{port} 空闲"),
            }
        }
        Err(error) => Check {
            status: Status::Warn,
            name: "port",
            detail: format!("{port} 不可绑定（{error}）；如被 harness 占用属正常"),
        },
    }
}
