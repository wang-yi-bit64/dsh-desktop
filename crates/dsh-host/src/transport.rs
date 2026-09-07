//! 统一传输层协议与 JSON-RPC 2.0 桌面通信模型。
//!
//! 支持以下三种通信拓扑：
//! - [`TransportProtocol::Http`]：传统的 HTTP 探测与 Webview 导航模式。
//! - [`TransportProtocol::NamedPipe`]：Windows 平台命名的全双工管道通信（IPC）。
//! - [`TransportProtocol::UnixDomainSocket`]：macOS / Linux 平台的 Unix 域套接字通信（IPC）。

use std::fmt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::contracts::{NAMED_PIPE_PREFIX, UDS_SOCKET_FILENAME};

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

/// JSON-RPC 2.0 标识符。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcId {
    /// 数值型 ID。
    Number(i64),
    /// 字符串型 ID。
    String(String),
    /// 空值 ID。
    Null,
}

impl From<i64> for RpcId {
    fn from(value: i64) -> Self {
        Self::Number(value)
    }
}

impl From<&str> for RpcId {
    fn from(value: &str) -> Self {
        Self::String(value.to_string())
    }
}

impl From<String> for RpcId {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl fmt::Display for RpcId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Number(n) => write!(f, "{n}"),
            Self::String(s) => write!(f, "{s}"),
            Self::Null => write!(f, "null"),
        }
    }
}

/// JSON-RPC 2.0 请求对象。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcRequest {
    /// JSON-RPC 协议版本，固定为 `"2.0"`。
    pub jsonrpc: String,
    /// 请求方法名。
    pub method: String,
    /// 请求参数（可选）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    /// 请求标识符。如果为 `None`，则为单向 Notification。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<RpcId>,
}

impl RpcRequest {
    /// 构造一个新的标准 JSON-RPC 2.0 请求。
    pub fn new(id: impl Into<RpcId>, method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            method: method.into(),
            params,
            id: Some(id.into()),
        }
    }

    /// 构造一个新的单向通知（Notification，无 id 且不期望回复）。
    pub fn notification(method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            method: method.into(),
            params,
            id: None,
        }
    }

    /// 检查是否为单向通知。
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }
}

/// JSON-RPC 2.0 错误体。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    /// 错误码。
    pub code: i64,
    /// 简要错误信息。
    pub message: String,
    /// 附加错误数据（可选）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    /// 构造一个新的错误对象。
    pub fn new(code: i64, message: impl Into<String>, data: Option<Value>) -> Self {
        Self {
            code,
            message: message.into(),
            data,
        }
    }

    /// 标准 Parse error (-32700)。
    pub fn parse_error(data: Option<Value>) -> Self {
        Self::new(-32700, "Parse error", data)
    }

    /// 标准 Invalid Request (-32600)。
    pub fn invalid_request(data: Option<Value>) -> Self {
        Self::new(-32600, "Invalid Request", data)
    }

    /// 标准 Method not found (-32601)。
    pub fn method_not_found(data: Option<Value>) -> Self {
        Self::new(-32601, "Method not found", data)
    }

    /// 标准 Invalid params (-32602)。
    pub fn invalid_params(data: Option<Value>) -> Self {
        Self::new(-32602, "Invalid params", data)
    }

    /// 标准 Internal error (-32603)。
    pub fn internal_error(data: Option<Value>) -> Self {
        Self::new(-32603, "Internal error", data)
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RPC Error [{}]: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

/// JSON-RPC 2.0 响应对象。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcResponse {
    /// JSON-RPC 协议版本，固定为 `"2.0"`。
    pub jsonrpc: String,
    /// 成功时的返回结果。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// 失败时的错误信息。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
    /// 关联的请求标识符。
    pub id: Option<RpcId>,
}

impl RpcResponse {
    /// 构造成功的响应对象。
    pub fn success(id: impl Into<RpcId>, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            result: Some(result),
            error: None,
            id: Some(id.into()),
        }
    }

    /// 构造失败的响应对象。
    pub fn error(id: Option<RpcId>, error: RpcError) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            result: None,
            error: Some(error),
            id,
        }
    }

    /// 检查响应是否成功。
    pub fn is_success(&self) -> bool {
        self.error.is_none() && self.result.is_some()
    }

    /// 检查响应是否包含错误。
    pub fn is_error(&self) -> bool {
        self.error.is_some()
    }
}

/// JSON-RPC 2.0 顶层消息包装枚举（请求或响应）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcMessage {
    /// RPC 请求或通知。
    Request(RpcRequest),
    /// RPC 回复。
    Response(RpcResponse),
}

impl RpcMessage {
    /// 将消息序列化为 JSON 字符串。
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// 将消息序列化为带换行符（NDJSON 协议）的 JSON 字符串。
    pub fn to_ndjson_line(&self) -> Result<String, serde_json::Error> {
        let mut s = self.to_json()?;
        s.push('\n');
        Ok(s)
    }

    /// 从 JSON 字符串反序列化 RPC 消息。
    pub fn from_json(raw: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(raw)
    }
}

impl From<RpcRequest> for RpcMessage {
    fn from(req: RpcRequest) -> Self {
        Self::Request(req)
    }
}

impl From<RpcResponse> for RpcMessage {
    fn from(res: RpcResponse) -> Self {
        Self::Response(res)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::DEFAULT_RPC_TIMEOUT_SECS;
    use serde_json::json;

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

    #[test]
    fn rpc_request_serialization() {
        let req = RpcRequest::new(
            1,
            "system.ping",
            Some(json!({"timeout": DEFAULT_RPC_TIMEOUT_SECS})),
        );
        let json_str = serde_json::to_string(&req).unwrap();
        let v: Value = serde_json::from_str(&json_str).unwrap();

        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 1);
        assert_eq!(v["method"], "system.ping");
        assert_eq!(v["params"]["timeout"], 30);
        assert!(!req.is_notification());

        let notif = RpcRequest::notification("log.stream", Some(json!({"line": "hello"})));
        assert!(notif.is_notification());
        let notif_json = serde_json::to_string(&notif).unwrap();
        let notif_v: Value = serde_json::from_str(&notif_json).unwrap();
        assert!(notif_v.get("id").is_none());
        assert_eq!(notif_v["method"], "log.stream");
    }

    #[test]
    fn rpc_response_success_and_error() {
        let success = RpcResponse::success("req-99", json!({"status": "ready"}));
        assert!(success.is_success());
        assert!(!success.is_error());

        let json_str = serde_json::to_string(&success).unwrap();
        let parsed: RpcResponse = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed.id, Some(RpcId::String("req-99".to_string())));
        assert_eq!(parsed.result, Some(json!({"status": "ready"})));
        assert_eq!(parsed.error, None);

        let err = RpcError::method_not_found(Some(json!({"details": "unknown handler"})));
        let failure = RpcResponse::error(Some(RpcId::Number(42)), err);
        assert!(!failure.is_success());
        assert!(failure.is_error());

        let err_json = serde_json::to_string(&failure).unwrap();
        let parsed_err: RpcResponse = serde_json::from_str(&err_json).unwrap();
        assert_eq!(parsed_err.id, Some(RpcId::Number(42)));
        assert_eq!(parsed_err.error.unwrap().code, -32601);
    }

    #[test]
    fn rpc_message_round_trip() {
        let req = RpcRequest::new("abc", "get_status", None);
        let msg: RpcMessage = req.clone().into();
        let ndjson = msg.to_ndjson_line().unwrap();
        assert!(ndjson.ends_with('\n'));

        let parsed = RpcMessage::from_json(ndjson.trim_end()).unwrap();
        assert_eq!(parsed, RpcMessage::Request(req));

        let res = RpcResponse::success("abc", json!({"ok": true}));
        let msg_res: RpcMessage = res.clone().into();
        let json_res = msg_res.to_json().unwrap();
        let parsed_res = RpcMessage::from_json(&json_res).unwrap();
        assert_eq!(parsed_res, RpcMessage::Response(res));
    }
}
