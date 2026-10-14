//! clap 参数定义（`dsh-host-cli`）。
//!
//! # 两段式参数语义
//!
//! 宿主选项用 `--opt`；**`--` 之后的全部内容原样透传给底层 dsh**：
//!
//! ```text
//! dsh-host-cli start --resource R --data D -- --profile my-profile --verbose
//! ```
//!
//! 透传段放在契约参数之后，dsh（yargs）的「后者胜」语义让它能覆盖宿主的
//! `--port` 等参数——与「手工跑 dsh 并追加参数」的结果一致。宿主选项里
//! 拼错的参数（如 `--typo`）会被 clap 拒绝（退出码 2），不会被吞进透传。

use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};

use dsh_host::contracts::DEFAULT_PROBE_PORT;

/// 命令行入口。
#[derive(Parser, Debug)]
#[command(name = "dsh-host-cli", version, about = "Headless Harness host runner")]
pub struct Cli {
    /// 日志级别（只过滤 stdout 输出；落盘始终全量，排障不丢证据）。
    #[arg(long, global = true, value_enum, default_value_t = LogLevelArg::Info)]
    pub log_level: LogLevelArg,
    /// 以 JSON 输出结构化结果（供 fault-inject / CI 断言）。
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub command: Commands,
}

/// 日志级别（与 [`dsh_host::logs::LogLevel`] 一一对应）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
pub enum LogLevelArg {
    Error,
    Warn,
    #[default]
    Info,
    Debug,
}

impl From<LogLevelArg> for dsh_host::logs::LogLevel {
    fn from(value: LogLevelArg) -> Self {
        match value {
            LogLevelArg::Error => dsh_host::logs::LogLevel::Error,
            LogLevelArg::Warn => dsh_host::logs::LogLevel::Warn,
            LogLevelArg::Info => dsh_host::logs::LogLevel::Info,
            LogLevelArg::Debug => dsh_host::logs::LogLevel::Debug,
        }
    }
}

/// 端口分配策略。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
pub enum PortModeArg {
    /// 预留端口后传给 dsh（默认，与桌面端一致）。
    #[default]
    Reserved,
    /// 传 `--port 0`，由内核分配并从 stdout 回报（需 Spike 证实 dsh 支持）。
    Ephemeral,
}

/// 子命令集合。
#[derive(Subcommand, Debug)]
pub enum Commands {
    /// 启动 Harness 并等待就绪（`--` 之后原样透传给 dsh）。
    Start(StartArgs),
    /// 停止 pidfile 记录的 Harness 进程树。
    Stop(StopArgs),
    /// 打印解析出的目录布局与资源齐备性。
    Status(StatusArgs),
    /// 打印最近 N 行 harness 日志。
    Tail(TailArgs),
    /// 对指定端口做一次 HTTP 就绪探测（契约 C4）。
    Probe(ProbeArgs),
    /// 环境自检：node / 资源 / MANIFEST / 日志 / 端口 / pidfile。
    Doctor(DoctorArgs),
    /// 崩溃自愈演示：启动 → 注入崩溃 → 指数退避重启 → 报告恢复结果（S6-2）。
    ///
    /// 这是`dsh_host::Supervisor` 唯一的命令行入口，因此也是 INV-6
    /// 「主链路必须能在命令行独立复现」的兑现点之一：全程无 GUI、无窗口系统。
    Recover(RecoverArgs),
}

/// `recover` 参数。
#[derive(clap::Args, Debug)]
pub struct RecoverArgs {
    /// 只读资源目录（对应 `resource_dir()`）。
    #[arg(long)]
    pub resource: PathBuf,
    /// 可写用户数据目录（pidfile 位于 `<data>/launch-root/harness.pid`）。
    #[arg(long)]
    pub data: PathBuf,
    /// 就绪总超时（秒），默认取平台契约值。
    #[arg(long)]
    pub timeout: Option<u64>,
    /// 固定监听端口；省略则自动预留。
    #[arg(long)]
    pub port: Option<u16>,
    /// 监听地址，默认契约值 `127.0.0.1`。
    #[arg(long)]
    pub host: Option<String>,
    /// 用 mock-harness 顶替真实入口（等价于环境变量 `DSH_MOCK=1`）。
    #[arg(long)]
    pub mock: bool,
    /// 崩溃注入模式；默认 `startup`（启动即失败，触发退避重启路径）。
    #[arg(long, value_enum, default_value = "startup")]
    pub fail: FailModeArg,
    /// 观察窗口（秒）：这段时间内 Supervisor 应至少完成一次重启。
    #[arg(long, default_value_t = 60)]
    pub observe_secs: u64,
}

/// `recover --fail` 的可选故障模式。
///
/// 刻意只暴露两种**启动即失败**的模式：`startup`（exit 3）与 `no-url`
/// （永不打印就绪 URL）。两者都走 `LaunchOutcome::Failed` 分支——该分支
/// **不经过**稳定窗口重置，因此退避与断路器才可被如实观测。
///
/// ⚠️ 不要加`after-ready`：它走 `Ready` 分支，每次崩溃都会因超过
/// `SUPERVISOR_STABLE_UPTIME` 被重置计数与退避，观测到的将永远是初值。
#[derive(clap::ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailModeArg {
    /// 启动即退出（mock exit 3）。
    Startup,
    /// 卡住不打印 URL（触发就绪超时后失败）。
    NoUrl,
}

impl FailModeArg {
    /// 转为传给 mock 入口的 `--fail` 载荷。
    #[must_use]
    pub fn as_mock_value(self) -> &'static str {
        match self {
            FailModeArg::Startup => "startup",
            FailModeArg::NoUrl => "no-url",
        }
    }
}

/// `start` 参数。
#[derive(clap::Args, Debug)]
pub struct StartArgs {
    /// 只读资源目录（对应 `resource_dir()`）。
    #[arg(long)]
    pub resource: PathBuf,
    /// 可写用户数据目录（对应 `app_data_dir()`）。
    #[arg(long)]
    pub data: PathBuf,
    /// 就绪总超时（秒），默认取平台契约值。
    #[arg(long)]
    pub timeout: Option<u64>,
    /// 固定监听端口；省略则自动预留，`0` 等价于 `--port-mode ephemeral`。
    #[arg(long)]
    pub port: Option<u16>,
    /// 监听地址，默认契约值 `127.0.0.1`。
    #[arg(long)]
    pub host: Option<String>,
    /// 覆盖 C2 契约环境变量（可多次：`--env NO_COLOR=0 --env FOO=bar`）。
    #[arg(long, value_name = "K=V")]
    pub env: Vec<String>,
    /// 允许 dsh 把 URL 交给系统浏览器（默认禁止，C1）。
    #[arg(long)]
    pub open: bool,
    /// 用 mock-harness 顶替真实入口（等价于环境变量 `DSH_MOCK=1`）。
    #[arg(long)]
    pub mock: bool,
    /// dry-run：打印完整 argv / cwd / env_delta 后退出，不派生子进程。
    #[arg(long)]
    pub print_argv: bool,
    /// 端口分配策略（与 `--port` 互斥使用；`--port` 优先）。
    #[arg(long, value_enum, default_value_t = PortModeArg::Reserved)]
    pub port_mode: PortModeArg,
    /// 启动 profile（C10）。省略等价于 `web`：裸子命令 + 普通 patch。
    ///
    /// 传 `desktop-safe-mode` 时走 `--profile desktop-safe-mode` 并把 `--patch`
    /// 换成 `dsh-desktop-safe.patch.yml`——这正是 GUI「Restart in Safe Mode」
    /// 的启动路径，故可用于无头复现与 `--print-argv` 取证。
    #[arg(long)]
    pub profile: Option<String>,
    /// `--` 之后的全部内容原样透传给底层 dsh。
    #[arg(last = true, allow_hyphen_values = true)]
    pub dsh_args: Vec<String>,
}

/// `stop` 参数。
#[derive(clap::Args, Debug)]
pub struct StopArgs {
    /// 可写用户数据目录（pidfile 位于 `<data>/launch-root/harness.pid`）。
    #[arg(long)]
    pub data: PathBuf,
}

/// `status` 参数。
#[derive(clap::Args, Debug)]
pub struct StatusArgs {
    #[arg(long)]
    pub resource: PathBuf,
    #[arg(long)]
    pub data: PathBuf,
}

/// `tail` 参数。
#[derive(clap::Args, Debug)]
pub struct TailArgs {
    /// 可写用户数据目录（日志位于 `<data>/logs/harness.log`）。
    #[arg(long)]
    pub data: PathBuf,
    #[arg(long, default_value_t = 30)]
    pub lines: usize,
}

/// `probe` 参数。
#[derive(clap::Args, Debug)]
pub struct ProbeArgs {
    #[arg(long, default_value_t = DEFAULT_PROBE_PORT)]
    pub port: u16,
    #[arg(long, default_value_t = 2)]
    pub timeout: u64,
}

/// `doctor` 参数。
#[derive(clap::Args, Debug)]
pub struct DoctorArgs {
    #[arg(long)]
    pub resource: PathBuf,
    #[arg(long)]
    pub data: PathBuf,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    /// clap 定义必须能通过自身校验（拼错字段名 / 冲突参数会在这里暴露）。
    #[test]
    fn cli_definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn passthrough_after_double_dash() {
        let cli = Cli::try_parse_from([
            "dsh-host-cli",
            "start",
            "--resource",
            "R",
            "--data",
            "D",
            "--",
            "--profile",
            "x",
            "--verbose",
        ])
        .unwrap();

        let Commands::Start(args) = cli.command else {
            panic!("应为 start 子命令");
        };
        assert_eq!(args.dsh_args, vec!["--profile", "x", "--verbose"]);
    }

    #[test]
    fn unknown_host_option_is_rejected() {
        // 宿主选项拼错必须报错（退出码 2），不能被静默吞进透传段。
        let parsed = Cli::try_parse_from([
            "dsh-host-cli",
            "start",
            "--resource",
            "R",
            "--data",
            "D",
            "--typo",
        ]);
        assert!(parsed.is_err());
    }

    #[test]
    fn hyphen_values_in_passthrough_are_preserved() {
        let cli = Cli::try_parse_from([
            "dsh-host-cli",
            "start",
            "--resource",
            "R",
            "--data",
            "D",
            "--",
            "--fail",
            "startup",
            "--negative=-1",
        ])
        .unwrap();

        let Commands::Start(args) = cli.command else {
            panic!("应为 start 子命令");
        };
        assert_eq!(args.dsh_args, vec!["--fail", "startup", "--negative=-1"]);
    }
}
