//! # Tauri IPC 统一 Envelope 通信协议
//!
//! # 为什么命令面必须走封套
//!
//! 命令面长期一律返回 `Result<T, String>`：成功有类型，**失败只有一个字符串**。
//! 后果是前端无法编程化区分故障类别——「端口占用」与「插件入口失败」的处置
//! 完全不同（前者换端口重试，后者进安全模式），但页面只能对文案做字符串匹配。
//!
//! 封套把三件事分开：`success`（成败）、`data`（类型化结果）、
//! `error`（[`AppError`]：稳定错误码 + 类别 + 建议动作）。错误码表见
//! [`crate::errors::codes`]。
//!
//! # 形状是跨语言契约
//!
//! 前端读的是 JSON 字段名，不是 Rust 类型：`success` / `data` / `error` /
//! `timestamp_ms`，`error` 内是 `code` / `message` / `category` /
//! `suggested_action` / `details`。改字段名等于改契约，会**静默**打断所有页面的
//! 错误分派（页面只会看到 `success` 缺失而当成失败处理）。本文件的 `tests`
//! 钉住这个形状。

use serde::{Deserialize, Serialize};

use crate::errors::{AppError, ErrorCategory};

/// 统一 IPC 响应封套。
///
/// - 成功：`success = true`，`data` 有值，`error` 为 `None`；
/// - 失败：`success = false`，`data` 为 `None`，`error` 有值。
///
/// `None` 字段用 `skip_serializing_if` 略去，页面因此可以只判 `success`。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcEnvelope<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppError>,
    pub timestamp_ms: u64,
}

impl<T> IpcEnvelope<T> {
    /// 成功封套。
    pub fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
            timestamp_ms: now_ms(),
        }
    }
}

impl IpcEnvelope<()> {
    /// 失败封套（`data` 类型为 `()` 的形态，可经 [`IpcEnvelope::into_failure`]
    /// 转成任意命令的返回类型）。
    pub fn err(error: AppError) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error),
            timestamp_ms: now_ms(),
        }
    }

    /// 按族别构造失败封套。
    pub fn failure(
        code: impl Into<String>,
        category: ErrorCategory,
        message: impl Into<String>,
    ) -> Self {
        Self::err(AppError::new(code, message, category))
    }

    /// 调用方不是本地页——命令守卫的统一拒绝形态（契约 `E4002`）。
    pub fn denied(detail: impl std::fmt::Display) -> Self {
        Self::failure(
            crate::errors::codes::PERMISSION_DENIED,
            ErrorCategory::Authentication,
            format!("permission denied: {detail}"),
        )
        .with_action("Only local shell pages may invoke host commands.")
    }

    /// 请求的动作名不被识别（契约 `E7002`）。
    ///
    /// 刻意**不**静默返回 `false`：一个拼错的动作名若不报错，页面上就是
    /// 「按钮点了没反应」——本仓库在命令名漂移上已经吃过一次这个亏。
    pub fn unknown_action(action: &str) -> Self {
        Self::failure(
            crate::errors::codes::UNKNOWN_ACTION,
            ErrorCategory::Internal,
            format!("unknown action: {action}"),
        )
    }

    /// 附加建议动作。
    pub fn with_action(mut self, action: impl Into<String>) -> Self {
        if let Some(error) = self.error.as_mut() {
            error.suggested_action = Some(action.into());
        }
        self
    }

    /// 把失败封套转成任意命令的返回类型。
    ///
    /// 存在的理由：命令守卫在返回具体类型（如 `HarnessSnapshot`）的命令里也要
    /// 能早退，而守卫产出的失败封套天然是 `IpcEnvelope<()>`。失败封套的 `data`
    /// 恒为 `None`，因此这个转换恒安全——**不要**用它转换成功封套（会静默丢
    /// 掉 `data`，`debug_assert` 在测试构建下会拦下来）。
    pub fn into_failure<U>(self) -> IpcEnvelope<U> {
        debug_assert!(
            !self.success,
            "into_failure called on a successful envelope: data would be silently dropped"
        );
        IpcEnvelope {
            success: false,
            data: None,
            error: self.error,
            timestamp_ms: self.timestamp_ms,
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 封套形状是跨语言契约：字段名一改，所有页面的错误分派静默失效。
    #[test]
    fn success_envelope_has_the_contract_shape() {
        let json = serde_json::to_value(IpcEnvelope::ok(7u32)).expect("envelope must serialize");
        assert_eq!(json["success"], serde_json::json!(true), "{json}");
        assert_eq!(json["data"], serde_json::json!(7), "{json}");
        assert!(json.get("error").is_none(), "error must be omitted: {json}");
        assert!(
            json["timestamp_ms"].is_u64(),
            "timestamp_ms must be a number: {json}"
        );
    }

    #[test]
    fn failure_envelope_carries_a_programmatic_code() {
        let envelope = IpcEnvelope::failure(
            crate::errors::codes::PORT_IN_USE,
            ErrorCategory::Network,
            "port 4173 is taken",
        );
        let json = serde_json::to_value(&envelope).expect("envelope must serialize");
        assert_eq!(json["success"], serde_json::json!(false), "{json}");
        assert!(json.get("data").is_none(), "data must be omitted: {json}");
        assert_eq!(json["error"]["code"], serde_json::json!("E2001"), "{json}");
        assert_eq!(json["error"]["category"], serde_json::json!("network"));
        assert_eq!(
            json["error"]["message"],
            serde_json::json!("port 4173 is taken")
        );
    }

    /// 前端按 `category` 分派，`category` 的字符串必须与枚举的稳定表示一致。
    #[test]
    fn every_category_has_a_stable_string() {
        for category in [
            ErrorCategory::Environment,
            ErrorCategory::Network,
            ErrorCategory::ProcessLifecycle,
            ErrorCategory::Authentication,
            ErrorCategory::PluginSandbox,
            ErrorCategory::ModelGateway,
            ErrorCategory::Internal,
        ] {
            let json = serde_json::to_value(category).unwrap();
            assert_eq!(
                json,
                serde_json::json!(category.as_str()),
                "as_str 与 serde 表示必须一致，否则页面按 category 分派会拿到另一个词"
            );
        }
    }

    #[test]
    fn failures_convert_to_any_command_return_type_without_data_loss() {
        let envelope: IpcEnvelope<Vec<String>> = IpcEnvelope::unknown_action("nope").into_failure();
        assert!(!envelope.success);
        assert!(envelope.data.is_none());
        assert_eq!(
            envelope.error.expect("must carry the cause").code,
            crate::errors::codes::UNKNOWN_ACTION
        );
    }

    /// 错误码族号与类别必须对得上：`E4xxx` 的族是鉴权，不是环境。
    #[test]
    fn code_families_match_their_categories() {
        assert_eq!(
            crate::errors::codes::PERMISSION_DENIED,
            "E4002",
            "拒绝类错误必须落在 E4xxx（鉴权与安全）"
        );
        let envelope = IpcEnvelope::denied("http://127.0.0.1:1/");
        assert_eq!(
            envelope.error.as_ref().unwrap().category,
            ErrorCategory::Authentication
        );
    }
}
