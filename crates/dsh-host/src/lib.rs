//! # dsh-host
//!
//! 无 GUI 依赖的 DeepSeek Harness 宿主库。
//!
//! 本 crate 承担「宿主」的全部可测逻辑，不含任何 Tauri / 窗口依赖，因此
//! `cargo test -p dsh-host` 可以在无显示器、无资源包的机器上完整运行
//! （不变量 INV-6）。Tauri 应用层只负责窗口、事件与 IPC 接线。
//!
//! | 模块 | 职责 | 对应契约 |
//! |---|---|---|
//! | [`contracts`] | 所有消费 DSH 未文档化行为的常量与阈值 | §4 全表 |
//! | [`args`] | argv / env 的构造、校验、透传分流、`--print-argv` 快照 | C1、C2 |
//! | [`paths`] | 资源目录 / userData 目录布局 | C8 |
//! | [`env`] | 子进程环境变量（PATH 合并、注册表 / login shell 捕获、覆盖） | C2 |
//! | [`token`] | stdout 中 `dsh web:` URL 与 token 解析 | C3 |
//! | [`readiness`] | HTTP/1.0 就绪探测与稳定窗 | C4 |
//! | [`process`] | 子进程派生、平台孤儿防护、陈旧进程清扫、控制台清洗 | C1、INV-3 |
//! | [`stop`] | SIGTERM → 4s → SIGKILL 停止语义 | C6 |
//! | [`logs`] | 日志环形缓冲、滚动落盘、失败归因、级别前缀 | C7 |
//! | [`logging`] | 宿主日志（`app.log`）落盘门面 + 级别过滤 | C7 |
//! | [`transport`] | 统一传输协议（Named Pipe / UDS / HTTP）；RPC 消息模型 re-export 自 `dsh-contracts::rpc`（唯一契约源） | — |
//! | [`launch`] | 上述模块的编排（spawn → 日志泵 → 就绪等待） | C1–C7 |
//! | [`error`] | 统一错误类型 + 退出码映射 + 归因降级 | — |

pub mod args;
pub mod contracts;
pub mod diagnostics;
pub mod env;
pub mod error;
pub mod launch;
pub mod logging;
pub mod logs;
pub mod paths;
pub mod plugin_worker;
pub mod process;
pub mod readiness;
pub mod safe_mode;
pub mod session;
pub mod stop;
pub mod supervisor;
pub mod token;
pub mod transport;

pub use args::{parse_env_overrides, ArgvSnapshot, HarnessArgs};
pub use diagnostics::{
    extract_offending_plugins, format_crash_diagnostics, CrashCategory, CrashDiagnostics,
    DiagnosticReport, DiagnosticsAnalyzer,
};
pub use error::{HostError, HostResult};
pub use launch::{LaunchOutcome, Launcher, LauncherConfig};
pub use logs::{FailureCause, LogLevel, LogLine, LogRing, LogSource};
pub use paths::Layout;
pub use readiness::{ProbeConfig, ReadinessOutcome};
pub use safe_mode::{
    ensure_safe_mode_profile, generate_isolated_profile_config, SafeModeContext, SafeModeManager,
};
pub use session::{
    Profile, ProfileManager, ProfileMetadata, Session, SessionManager, SessionMetadata,
    SessionStore,
};
pub use supervisor::{Supervisor, SupervisorConfig, SupervisorState};
pub use token::LaunchEndpoint;
pub use transport::{RpcError, RpcId, RpcMessage, RpcRequest, RpcResponse, TransportProtocol};
