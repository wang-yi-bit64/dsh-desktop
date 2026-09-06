//! 子命令实现聚合与统一出口。
//!
//! 退出码约定（`dsh_host::contracts::EXIT_*`）由各子命令返回，
//! `main` 是唯一调用 `std::process::exit` 的地方。

pub mod doctor;
pub mod inspect;
pub mod start;

use crate::cli::{Commands, LogLevelArg};
use dsh_host::paths::Layout;

/// 统一的子命令执行结果：进程退出码。
pub type ExitCode = i32;

/// 分发子命令。
pub async fn dispatch(command: Commands, log_level: LogLevelArg, json: bool) -> ExitCode {
    match command {
        Commands::Start(args) => start::run(args, log_level, json).await,
        Commands::Stop(args) => start::stop(args, json),
        Commands::Status(args) => inspect::status(args, json),
        Commands::Tail(args) => inspect::tail(args),
        Commands::Probe(args) => inspect::probe(args).await,
        Commands::Doctor(args) => doctor::run(args),
    }
}

/// 把「资源目录」替换为 mock 入口（`--mock` 或环境变量 `DSH_MOCK=1`）。
///
/// mock 脚本由 `scripts/fault-inject.mjs` 组装进资源目录；只解析
/// `--port` / `--delay` / `--fail`，其余 argv 忽略。与 Tauri 侧
/// `layout.rs` 的语义保持一致。
pub fn apply_mock_if_requested(layout: &mut Layout, force: bool) -> bool {
    let mock_enabled = force
        || std::env::var("DSH_MOCK")
            .map(|value| value == "1")
            .unwrap_or(false);
    if !mock_enabled {
        return false;
    }
    let mock = layout.resource_dir.join("mock-harness.mjs");
    let mock = std::fs::canonicalize(&mock).unwrap_or(mock);
    eprintln!(
        "[cli] mock 模式 → 入口已替换为 {}",
        mock.display()
    );
    layout.node_entry = mock.clone();
    layout.dsh_entry = mock;
    true
}
