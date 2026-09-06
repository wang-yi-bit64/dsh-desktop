//! `dsh-host-cli` — 无 GUI 的 Harness 宿主排障入口。
//!
//! 计划 ADR-3 / INV-6：GUI 层只做壳与事件接线，主链路必须能在命令行里
//! 独立复现。现场排障时先跑 `dsh-host-cli start`，就能区分「宿主逻辑问题」
//! 与「Tauri 窗口/权限问题」。
//!
//! ```text
//! dsh-host-cli start  --resource <dir> --data <dir> [--port N] [--env K=V] -- <dsh args…>
//! dsh-host-cli stop   --data <dir>
//! dsh-host-cli status --resource <dir> --data <dir>
//! dsh-host-cli tail   --data <dir> [--lines 30]
//! dsh-host-cli probe  [--port 4173] [--timeout 2]
//! dsh-host-cli doctor --resource <dir> --data <dir>
//! ```
//!
//! 退出码见 `dsh_host::contracts::EXIT_*`；`--json` 供 fault-inject / CI 断言。

mod cli;
mod commands;

use clap::Parser as _;

use cli::Cli;

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let code = commands::dispatch(cli.command, cli.log_level, cli.json).await;
    // 退出码是 CLI 与脚本之间的唯一契约出口：库层绝不 exit，这里统一收口。
    std::process::exit(code);
}
