//! 统一传输层协议与 JSON-RPC 2.0 桌面通信模型。
//!
//! 支持以下三种通信拓扑：
//! - [`TransportProtocol::Http`]：传统的 HTTP 探测与 Webview 导航模式。
//! - [`TransportProtocol::NamedPipe`]：Windows 平台命名的全双工管道通信（IPC）。
//! - [`TransportProtocol::UnixDomainSocket`]：macOS / Linux 平台的 Unix 域套接字通信（IPC）。
//!
//! # RPC 消息模型（契约收敛）
//!
//! JSON-RPC 2.0 消息模型（[`RpcRequest`] / [`RpcResponse`] / [`RpcError`] /
//! [`RpcId`] / [`RpcMessage`]）的唯一定义点是 `dsh-contracts::rpc`；本模块
//! 仅 re-export 以保持 `dsh_host::transport::RpcX` 与 `dsh_host::RpcX` 两条
//! 既有引用路径兼容。**禁止在本 crate 内重复定义协议类型**，否则会与
//! `crate::contracts` 的 glob re-export 形成同名异型冲突。

use std::fmt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::contracts::{NAMED_PIPE_PREFIX, UDS_SOCKET_FILENAME};

pub use dsh_contracts::rpc::{RpcError, RpcId, RpcMessage, RpcRequest, RpcResponse};

/// 宿主与 Harness / 运行时之间的底层通信协议与端点定义。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TransportProtocol {
    /// 标准 HTTP 协议传输。
    Http,
    /// Windows 命名管道传输。
    NamedPipe {
        /// 命名管道完整路径（例如 `\\.\pipe\dsh-runtime-12345`）。
        path: String,
    },
    /// Unix Domain Socket 传输。
    UnixDomainSocket {
        /// 套接字文件所在绝对路径。
        path: PathBuf,
    },
}

impl TransportProtocol {
    /// 为给定的实例标识符构建平台推荐的 IPC 传输协议。
    ///
    /// - Windows: 构造命名管道 `\\.\pipe\dsh-runtime-{instance_id}`
    /// - Unix / macOS: 在 `socket_dir` 下构造 `{socket_dir}/dsh-runtime.sock`
    pub fn default_for_platform(instance_id: &str, socket_dir: impl AsRef<Path>) -> Self {
        if cfg!(windows) {
            Self::named_pipe_with_id(instance_id)
        } else {
            Self::uds_in_dir(socket_dir)
        }
    }

    /// 使用指定的实例标识符构造 Windows 命名管道传输。
    pub fn named_pipe_with_id(instance_id: &str) -> Self {
        Self::NamedPipe {
            path: format!("{NAMED_PIPE_PREFIX}{instance_id}"),
        }
    }

    /// 在指定目录下构造 Unix Domain Socket 传输。
    pub fn uds_in_dir(socket_dir: impl AsRef<Path>) -> Self {
        Self::UnixDomainSocket {
            path: socket_dir.as_ref().join(UDS_SOCKET_FILENAME),
        }
    }

    /// 检查当前传输协议是否为本地 IPC（命名管道或 UDS）。
    pub fn is_ipc(&self) -> bool {
        matches!(self, Self::NamedPipe { .. } | Self::UnixDomainSocket { .. })
    }

    /// 返回端点的字符串表示（便于日志和诊断）。
    pub fn endpoint_display(&self) -> String {
        match self {
            Self::Http => "http://127.0.0.1 (dynamic)".to_string(),
            Self::NamedPipe { path } => path.clone(),
            Self::UnixDomainSocket { path } => path.to_string_lossy().into_owned(),
        }
    }
}

impl fmt::Display for TransportProtocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http => write!(f, "HTTP"),
            Self::NamedPipe { path } => write!(f, "NamedPipe({path})"),
            Self::UnixDomainSocket { path } => write!(f, "UDS({})", path.display()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::UDS_SOCKET_FILENAME;

    #[test]
    fn transport_protocol_display_and_helpers() {
        let http = TransportProtocol::Http;
        assert_eq!(http.to_string(), "HTTP");
        assert!(!http.is_ipc());
        assert_eq!(http.endpoint_display(), "http://127.0.0.1 (dynamic)");

        let np = TransportProtocol::named_pipe_with_id("test-session");
        assert_eq!(
            np,
            TransportProtocol::NamedPipe {
                path: r"\\.\pipe\dsh-runtime-test-session".to_string()
            }
        );
        assert!(np.is_ipc());
        assert_eq!(np.endpoint_display(), r"\\.\pipe\dsh-runtime-test-session");

        let expected_uds_path = Path::new("/tmp/dsh").join(UDS_SOCKET_FILENAME);
        let uds = TransportProtocol::uds_in_dir("/tmp/dsh");
        assert_eq!(
            uds,
            TransportProtocol::UnixDomainSocket {
                path: expected_uds_path.clone()
            }
        );
        assert!(uds.is_ipc());
        assert_eq!(
            uds.endpoint_display(),
            expected_uds_path.to_string_lossy().into_owned()
        );
    }

    #[test]
    fn transport_protocol_platform_default() {
        let proto = TransportProtocol::default_for_platform("inst-42", "/var/run/dsh");
        if cfg!(windows) {
            assert_eq!(
                proto,
                TransportProtocol::NamedPipe {
                    path: r"\\.\pipe\dsh-runtime-inst-42".to_string()
                }
            );
        } else {
            assert_eq!(
                proto,
                TransportProtocol::UnixDomainSocket {
                    path: Path::new("/var/run/dsh").join(UDS_SOCKET_FILENAME)
                }
            );
        }
    }

    #[test]
    fn transport_protocol_serde_round_trip() {
        let http = TransportProtocol::Http;
        let serialized = serde_json::to_string(&http).unwrap();
        assert_eq!(serialized, r#"{"type":"http"}"#);
        let parsed: TransportProtocol = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed, http);

        let pipe = TransportProtocol::named_pipe_with_id("sess-1");
        let serialized = serde_json::to_string(&pipe).unwrap();
        let parsed: TransportProtocol = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed, pipe);

        let uds = TransportProtocol::uds_in_dir("/tmp");
        let serialized = serde_json::to_string(&uds).unwrap();
        let parsed: TransportProtocol = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed, uds);
    }

    /// 契约收敛验证：`crate::contracts`（glob re-export）与 `crate::transport`
    /// （显式 re-export）必须指向同一组类型，不允许同名异型。
    #[test]
    fn rpc_types_are_the_same_across_contracts_and_transport() {
        fn assert_same_type<T: 'static>(_: &T) {}

        let req = RpcRequest::new(1, "ping", None);
        assert_same_type::<dsh_contracts::rpc::RpcRequest>(&req);
        let resp = RpcResponse::success(2, serde_json::json!({"ok": true}));
        assert_same_type::<dsh_contracts::rpc::RpcResponse>(&resp);

        // 行为一致性：re-export 的类型与 contracts 侧构造器互通。
        let via_contracts =
            dsh_contracts::rpc::RpcResponse::success(3, serde_json::json!({"pong": true}));
        let msg: RpcMessage = via_contracts.into();
        assert!(matches!(msg, RpcMessage::Response(_)));
    }
}
