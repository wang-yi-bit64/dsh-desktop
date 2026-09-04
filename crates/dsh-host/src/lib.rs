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
//! | [`contracts`] | 所有消费的 DSH 未文档化行为的常量与阈值 | §4 全表 |
//! | [`paths`] | 资源目录 / userData 目录布局 | C8 |
//! | [`env`] | 子进程环境变量（PATH 合并、注册表 / login shell 捕获） | C2 |
//! | [`token`] | stdout 中 `dsh web:` URL 与 token 解析 | C3 |
//! | [`readiness`] | HTTP/1.0 就绪探测与稳定窗 | C4 |
//! | [`process`] | 子进程派生、平台孤儿防护、陈旧进程清扫、控制台清洗 | C1、INV-3 |
//! | [`stop`] | SIGTERM → 4s → SIGKILL 停止语义 | C6 |
//! | [`logs`] | 日志环形缓冲、滚动落盘、失败归因 | C7 |
//! | [`launch`] | 上述模块的编排（spawn → 日志泵 → 就绪等待） | C1–C7 |
//! | [`error`] | 统一错误类型 | — |

pub mod contracts;
pub mod env;
pub mod error;
pub mod launch;
pub mod logs;
pub mod paths;
pub mod process;
pub mod readiness;
pub mod stop;
pub mod token;

pub use error::{HostError, HostResult};
pub use launch::{LaunchOutcome, Launcher, LauncherConfig};
pub use logs::{FailureCause, LogLine, LogRing, LogSource};
pub use paths::Layout;
pub use readiness::{ProbeConfig, ReadinessOutcome};
pub use token::LaunchEndpoint;
