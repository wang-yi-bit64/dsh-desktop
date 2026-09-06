//! 统一错误类型（dsh-host）。
//!
//! 本模块承担两件事：
//!
//! 1. **宿主自身的失败**：目录创建、子进程派生、端口预留、环境捕获、参数校验。
//! 2. **Harness 侧失败的包装**：把 [`FailureCause`]（C7 的结构化归因）提升为
//!    [`HostError`]，从而让「宿主错误」与「Harness 错误」共用一套传播路径。
//!
//! # 退出码
//!
//! 退出码**只在 CLI 的 `main` 出口使用**（库层绝不调用 `std::process::exit`，
//! 见共享知识约定）。映射表的所有常量集中在 [`crate::contracts`]（INV-4）。
//!
//! | [`HostError`] 变体 | 退出码常量 | 值 |
//! |---|---|---|
//! | — 成功 — | `EXIT_OK` | 0 |
//! | `CreateDir` / `Port` / `Environment` / `LogIo` | `EXIT_UNEXPECTED` | 1 |
//! | `InvalidArgument` | `EXIT_USAGE` | 2 |
//! | `MissingResource` | `EXIT_MISSING_RESOURCE` | 3 |
//! | `Spawn` / `ProcessGuard` | `EXIT_SPAWN_FAILED` | 4 |
//! | `TokenNotFound` | `EXIT_TOKEN_NOT_FOUND` | 5 |
//! | `ReadyTimeout` | `EXIT_READY_TIMEOUT` | 6 |
//! | `PortInUse` | `EXIT_PORT_IN_USE` | 7 |
//! | `HarnessFailed` / `ProcessExited` | `EXIT_HARNESS_FAILED` | 8 |
//!
//! # 示例
//!
//! ```
//! use dsh_host::contracts::{EXIT_READY_TIMEOUT, EXIT_SPAWN_FAILED};
//! use dsh_host::error::HostError;
//!
//! assert_eq!(HostError::TokenNotFound.exit_code(), 5);
//! assert_eq!(HostError::ReadyTimeout { seconds: 120 }.exit_code(), EXIT_READY_TIMEOUT);
//! assert_eq!(
//!     HostError::Spawn(std::io::Error::other("boom")).exit_code(),
//!     EXIT_SPAWN_FAILED
//! );
//! ```

use std::path::PathBuf;

use crate::contracts::{
    EXIT_HARNESS_FAILED, EXIT_MISSING_RESOURCE, EXIT_PORT_IN_USE, EXIT_READY_TIMEOUT,
    EXIT_SPAWN_FAILED, EXIT_TOKEN_NOT_FOUND, EXIT_UNEXPECTED, EXIT_USAGE,
};
use crate::logs::FailureCause;

/// dsh-host 的全部失败路径。
///
/// 变体**只增不改**：既有 8 个变体的签名被 `src-tauri` 直接依赖，
/// 改动会破坏 GUI 层编译。
#[derive(Debug, thiserror::Error)]
pub enum HostError {
    /// 资源目录缺少启动 Harness 所必需的条目（INV-1：资源只读，缺了只能报错）。
    #[error("bundled resource is missing: {0} ({1})")]
    MissingResource(&'static str, PathBuf),

    /// 创建 userData 下的目录失败。
    #[error("could not create directory {0}: {1}")]
    CreateDir(PathBuf, std::io::Error),

    /// 派生子进程失败。
    #[error("could not spawn the Harness process: {0}")]
    Spawn(std::io::Error),

    /// 预留 / 解析端口失败。
    #[error("could not reserve a loopback port: {0}")]
    Port(std::io::Error),

    /// 平台进程防护（Job Object / PDEATHSIG）设置失败。
    #[error("platform process guard failed: {0}")]
    ProcessGuard(String),

    /// 环境变量捕获失败（Windows 注册表 / login shell）。
    #[error("environment capture failed: {0}")]
    Environment(String),

    /// 参数非法。
    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    /// 落盘日志打开 / 写入失败。
    ///
    /// 属于**非致命**错误：宿主应降级为「仅内存日志」继续运行，而不是终止启动。
    #[error("could not write the log file {0}: {1}")]
    LogIo(PathBuf, std::io::Error),

    /// C4 — 超过就绪总超时。
    #[error("harness did not become ready within {seconds}s")]
    ReadyTimeout { seconds: u64 },

    /// C3 — 在超时前没有从 stdout 抓到 `dsh web:` 的 token 行。
    #[error("no launch token line was captured before the deadline")]
    TokenNotFound,

    /// 就绪之前子进程就退出了。
    #[error("harness exited before becoming ready (code: {code:?})")]
    ProcessExited { code: Option<i32> },

    /// 端口被占用，且重试次数已耗尽。
    #[error("port {port} is in use after {attempts} attempt(s)")]
    PortInUse { port: u16, attempts: usize },

    /// 兜底：把 C7 的结构化归因包成宿主错误。
    #[error("{0}")]
    HarnessFailed(FailureCause),
}

/// dsh-host 的统一结果别名。
pub type HostResult<T> = Result<T, HostError>;

impl HostError {
    /// 便捷构造：缺少资源。
    ///
    /// # 示例
    ///
    /// ```
    /// use dsh_host::error::HostError;
    ///
    /// let error = HostError::missing("node_executable", "/res/node/node.exe");
    /// assert_eq!(error.exit_code(), 3);
    /// ```
    pub fn missing(name: &'static str, path: impl Into<PathBuf>) -> Self {
        HostError::MissingResource(name, path.into())
    }

    /// 该错误对应的 CLI 退出码（映射表见模块文档）。
    ///
    /// # 示例
    ///
    /// ```
    /// use dsh_host::error::HostError;
    ///
    /// assert_eq!(HostError::ProcessExited { code: Some(1) }.exit_code(), 8);
    /// assert_eq!(HostError::PortInUse { port: 4173, attempts: 3 }.exit_code(), 7);
    /// ```
    pub fn exit_code(&self) -> i32 {
        match self {
            HostError::MissingResource(..) => EXIT_MISSING_RESOURCE,
            HostError::Spawn(..) | HostError::ProcessGuard(..) => EXIT_SPAWN_FAILED,
            HostError::InvalidArgument(..) => EXIT_USAGE,
            HostError::ReadyTimeout { .. } => EXIT_READY_TIMEOUT,
            HostError::TokenNotFound => EXIT_TOKEN_NOT_FOUND,
            HostError::PortInUse { .. } => EXIT_PORT_IN_USE,
            HostError::HarnessFailed(..) | HostError::ProcessExited { .. } => EXIT_HARNESS_FAILED,
            HostError::CreateDir(..)
            | HostError::Port(..)
            | HostError::Environment(..)
            | HostError::LogIo(..) => EXIT_UNEXPECTED,
        }
    }

    /// 降级为前端可消费的结构化归因（C7）。
    ///
    /// 宿主侧错误没有对应的 Harness 归因时，退化为携带详情的
    /// [`FailureCause::SpawnFailed`]（启动前置失败）或 [`FailureCause::Unknown`]，
    /// 保证错误页始终有可读文案，而不是空白。
    ///
    /// # 示例
    ///
    /// ```
    /// use dsh_host::error::HostError;
    ///
    /// let cause = HostError::ReadyTimeout { seconds: 120 }.to_failure_cause();
    /// assert_eq!(cause.kind(), "startup_timeout");
    ///
    /// let cause = HostError::ProcessExited { code: Some(3) }.to_failure_cause();
    /// assert_eq!(cause.kind(), "unexpected_exit");
    /// ```
    pub fn to_failure_cause(&self) -> FailureCause {
        match self {
            HostError::MissingResource(name, path) => FailureCause::MissingResource {
                name: (*name).to_string(),
                path: path.display().to_string(),
            },
            HostError::CreateDir(path, error) => FailureCause::SpawnFailed {
                detail: format!("无法创建目录 {}：{error}", path.display()),
            },
            HostError::Spawn(error) => FailureCause::SpawnFailed {
                detail: error.to_string(),
            },
            HostError::Port(error) => FailureCause::SpawnFailed {
                detail: format!("无法预留回环端口：{error}"),
            },
            HostError::ProcessGuard(detail) => FailureCause::SpawnFailed {
                detail: detail.clone(),
            },
            HostError::Environment(detail) => FailureCause::SpawnFailed {
                detail: format!("环境变量捕获失败：{detail}"),
            },
            // 用法错误与日志 IO 都不属于 Harness 侧故障，保留 Unknown 以免
            // 错误页误判成「插件故障」而给出安全模式入口。
            HostError::InvalidArgument(..) | HostError::LogIo(..) => FailureCause::Unknown,
            HostError::ReadyTimeout { seconds } => FailureCause::StartupTimeout {
                seconds: *seconds,
            },
            HostError::TokenNotFound => FailureCause::StderrTail {
                detail: "未在超时前捕获启动 token 行（C3）".to_string(),
            },
            HostError::ProcessExited { code } => FailureCause::UnexpectedExit { code: *code },
            HostError::PortInUse { port, attempts } => FailureCause::PortInUse {
                detail: format!("端口 {port} 被占用，已重试 {attempts} 次"),
            },
            HostError::HarnessFailed(cause) => cause.clone(),
        }
    }
}

impl From<FailureCause> for HostError {
    fn from(cause: FailureCause) -> Self {
        HostError::HarnessFailed(cause)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个变体的退出码必须固定，CI / 故障注入脚本依赖它做断言。
    #[test]
    fn exit_code_mapping_is_stable() {
        let io = || std::io::Error::other("boom");

        let cases: [(HostError, i32); 13] = [
            (HostError::MissingResource("node", PathBuf::from("/r")), 3),
            (HostError::CreateDir(PathBuf::from("/d"), io()), 1),
            (HostError::Spawn(io()), 4),
            (HostError::Port(io()), 1),
            (HostError::ProcessGuard("job".into()), 4),
            (HostError::Environment("reg".into()), 1),
            (HostError::InvalidArgument("bad".into()), 2),
            (HostError::LogIo(PathBuf::from("/l"), io()), 1),
            (HostError::ReadyTimeout { seconds: 120 }, 6),
            (HostError::TokenNotFound, 5),
            (HostError::ProcessExited { code: Some(1) }, 8),
            (HostError::PortInUse { port: 4173, attempts: 3 }, 7),
            (
                HostError::HarnessFailed(FailureCause::DshEntryFailed { detail: "x".into() }),
                8,
            ),
        ];

        for (error, expected) in cases {
            assert_eq!(error.exit_code(), expected, "退出码漂移：{error}");
        }
    }

    /// `HostError → FailureCause → HostError` 的类别不得漂移。
    #[test]
    fn failure_cause_round_trip() {
        let io = || std::io::Error::other("boom");

        let errors = vec![
            HostError::MissingResource("node", PathBuf::from("/r")),
            HostError::CreateDir(PathBuf::from("/d"), io()),
            HostError::Spawn(io()),
            HostError::Port(io()),
            HostError::ProcessGuard("job".into()),
            HostError::Environment("reg".into()),
            HostError::InvalidArgument("bad".into()),
            HostError::LogIo(PathBuf::from("/l"), io()),
            HostError::ReadyTimeout { seconds: 120 },
            HostError::TokenNotFound,
            HostError::ProcessExited { code: Some(1) },
            HostError::PortInUse { port: 4173, attempts: 3 },
            HostError::HarnessFailed(FailureCause::UnexpectedExit { code: None }),
        ];

        for error in errors {
            let before = error.to_failure_cause().kind().to_string();
            let after = HostError::from(error.to_failure_cause());
            assert_eq!(before, after.to_failure_cause().kind(), "归因类别漂移");
        }
    }

    /// 就绪超时必须能被错误页识别成「超时」而非「未知」。
    #[test]
    fn ready_timeout_maps_to_startup_timeout() {
        let cause = HostError::ReadyTimeout { seconds: 45 }.to_failure_cause();
        assert_eq!(cause.kind(), "startup_timeout");
        assert!(!cause.is_plugin_fault());
        assert!(!cause.is_retryable());
    }

    /// 端口冲突必须保持可重试语义（C1 端口策略依赖它）。
    #[test]
    fn port_in_use_stays_retryable() {
        let cause = HostError::PortInUse {
            port: 4173,
            attempts: 3,
        }
        .to_failure_cause();
        assert_eq!(cause.kind(), "port_in_use");
        assert!(cause.is_retryable());
    }
}
