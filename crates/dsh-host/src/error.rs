//! 统一错误类型（dsh-host）。

use std::path::PathBuf;

/// dsh-host 的全部失败路径。
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
}

/// dsh-host 的统一结果别名。
pub type HostResult<T> = Result<T, HostError>;

impl HostError {
    /// 便捷构造：缺少资源。
    pub fn missing(name: &'static str, path: impl Into<PathBuf>) -> Self {
        HostError::MissingResource(name, path.into())
    }
}
