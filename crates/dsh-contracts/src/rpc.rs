//! # 统一 RPC 消息模型与 JSON-RPC 2.0 规范（唯一契约源）
//!
//! 本模块是整个 workspace 中 JSON-RPC 2.0 消息模型的**唯一定义点**：
//! - `dsh-host` 的 [`crate::transport`] 通过 re-export 引用本模块，不得重复定义；
//! - `build/plugin-worker-host.mjs`（Node 侧）按同一协议手写实现，错误码与
//!   字段语义必须与本模块保持一致（参见各类型的文档注释）。
//!
//! 规范要点（RFC 参照 JSON-RPC 2.0 官方规范）：
//! - 请求：`jsonrpc` 固定 `"2.0"`；Notification（无 `id`）不期望回复，
//!   `id` 与 `params` 缺省时不序列化（与 Node 侧 `sendSuccessResponse` 对齐）。
//! - 响应：`result` 与 `error` **互斥**，构造器强制其一；`id` 永远序列化
//!   （即使检测失败也必须为 `null`，规范要求响应必须携带 `id` 成员）。
//! - 错误码：`-32700` / `-32600` / `-32601` / `-32602` / `-32603` 为标准码，
//!   Node 侧 `plugin-worker-host.mjs` 另用 `-32000`（Server error 区间）上报
//!   未捕获异常，两端语义一致。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JSON-RPC 2.0 请求/响应标识符。
///
/// `Null` 变体用于错误响应：规范允许在无法确定请求 id 时以 `null` 回复。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcId {
    /// 数值型 ID。
    Number(i64),
    /// 字符串型 ID。
    String(String),
    /// 空值 ID（错误响应中请求 id 不可确定时使用）。
    Null,
}

impl From<i64> for RpcId {
    fn from(n: i64) -> Self {
        Self::Number(n)
    }
}

impl From<String> for RpcId {
    fn from(s: String) -> Self {
        Self::String(s)
    }
}

impl From<&str> for RpcId {
    fn from(s: &str) -> Self {
        Self::String(s.to_string())
    }
}

impl std::fmt::Display for RpcId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
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
    /// JSON-RPC 协议版本，构造器固定为 `"2.0"`。
    pub jsonrpc: String,
    /// 请求方法名。
    pub method: String,
    /// 请求参数（可选；缺省时不序列化）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    /// 请求标识符（`None` 即单向 Notification，缺省时不序列化）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<RpcId>,
}

impl RpcRequest {
    /// 构造一个新的标准 JSON-RPC 2.0 请求。
    pub fn new(id: impl Into<RpcId>, method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: Some(id.into()),
            method: method.into(),
            params,
        }
    }

    /// 构造一个单向通知（Notification，无 `id` 且不期望回复）。
    pub fn notification(method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: None,
            method: method.into(),
            params,
        }
    }

    /// 检查是否为单向通知。
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }
}

/// JSON-RPC 2.0 错误对象。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    /// 错误码（标准区间 -32768 ~ -32000；`-32000` 为 Server error 自定义区间）。
    pub code: i64,
    /// 简要错误信息。
    pub message: String,
    /// 附加错误数据（可选；缺省时不序列化）。
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

    /// 标准 Parse error (-32700)：非法 JSON。
    pub fn parse_error(data: Option<Value>) -> Self {
        Self::new(-32700, "Parse error", data)
    }

    /// 标准 Invalid Request (-32600)：JSON 合法但不是有效请求对象。
    pub fn invalid_request(data: Option<Value>) -> Self {
        Self::new(-32600, "Invalid Request", data)
    }

    /// 标准 Method not found (-32601)：方法不存在或不可用。
    pub fn method_not_found(data: Option<Value>) -> Self {
        Self::new(-32601, "Method not found", data)
    }

    /// 标准 Invalid params (-32602)：参数无效。
    pub fn invalid_params(data: Option<Value>) -> Self {
        Self::new(-32602, "Invalid params", data)
    }

    /// 标准 Internal error (-32603)：内部错误。
    pub fn internal_error(data: Option<Value>) -> Self {
        Self::new(-32603, "Internal error", data)
    }

    /// Server error 区间 (-32000 ~ -32099)：实现自定义错误，
    /// Node 侧 `plugin-worker-host.mjs` 用 `-32000` 上报未捕获异常/拒绝。
    pub fn server_error(message: impl Into<String>, data: Option<Value>) -> Self {
        Self::new(-32000, message, data)
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RPC Error [{}]: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

/// JSON-RPC 2.0 响应对象。
///
/// `result` 与 `error` 互斥（构造器强制其一）；`id` 永远序列化——规范要求
/// 响应必须包含与请求相同的 `id`，检测失败时为 `null`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcResponse {
    /// JSON-RPC 协议版本，构造器固定为 `"2.0"`。
    pub jsonrpc: String,
    /// 成功时的返回结果（与 `error` 互斥）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// 失败时的错误信息（与 `result` 互斥）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
    /// 关联的请求标识符（永远序列化；不可确定时为 `null`）。
    pub id: Option<RpcId>,
}

impl RpcResponse {
    /// 构造成功的响应对象。
    pub fn success(id: impl Into<RpcId>, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: Some(id.into()),
            result: Some(result),
            error: None,
        }
    }

    /// 构造失败的响应对象（`id` 传 `None` 时序列化为 `null`）。
    pub fn error(id: Option<RpcId>, error: RpcError) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(error),
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
    use serde_json::json;

    #[test]
    fn rpc_request_serialization() {
        let req = RpcRequest::new(1, "system.ping", Some(json!({"timeout": 30})));
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
    fn rpc_response_error_id_always_serialized() {
        // 规范要求：错误响应的 id 不可确定时也必须序列化为 null。
        let failure = RpcResponse::error(None, RpcError::parse_error(None));
        let v: Value = serde_json::from_str(&serde_json::to_string(&failure).unwrap()).unwrap();
        assert_eq!(v["id"], Value::Null);
        assert_eq!(v["error"]["code"], -32700);
        assert!(v.get("result").is_none(), "result 与 error 必须互斥");
    }

    #[test]
    fn rpc_id_null_round_trip() {
        let id = RpcId::Null;
        assert_eq!(id.to_string(), "null");
        let v: Value = serde_json::from_str(&serde_json::to_string(&id).unwrap()).unwrap();
        assert_eq!(v, Value::Null);
        let parsed: RpcId = serde_json::from_str("null").unwrap();
        assert_eq!(parsed, RpcId::Null);
    }

    #[test]
    fn rpc_error_standard_codes_and_display() {
        assert_eq!(RpcError::parse_error(None).code, -32700);
        assert_eq!(RpcError::invalid_request(None).code, -32600);
        assert_eq!(RpcError::method_not_found(None).code, -32601);
        assert_eq!(RpcError::invalid_params(None).code, -32602);
        assert_eq!(RpcError::internal_error(None).code, -32603);
        assert_eq!(RpcError::server_error("boom", None).code, -32000);
        let e = RpcError::method_not_found(None);
        assert_eq!(e.to_string(), "RPC Error [-32601]: Method not found");
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

    #[test]
    fn rpc_message_untagged_dispatch_prefers_request_shape() {
        // 通知（无 id）应识别为 Request；响应必须靠 result/error 字段区分。
        let parsed = RpcMessage::from_json(r#"{"jsonrpc":"2.0","method":"ping"}"#).unwrap();
        assert!(matches!(parsed, RpcMessage::Request(req) if req.is_notification()));

        let parsed =
            RpcMessage::from_json(r#"{"jsonrpc":"2.0","id":7,"result":{"pong":true}}"#).unwrap();
        assert!(matches!(parsed, RpcMessage::Response(_)));
    }
}
