//! # Tauri IPC 统一 Envelope 通信协议

use serde::{Deserialize, Serialize};

/// 统一 IPC 响应封套
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcEnvelope<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<IpcErrorPayload>,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcErrorPayload {
    pub code: String,
    pub message: String,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl<T> IpcEnvelope<T> {
    pub fn ok(data: T) -> Self {
        let timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Self {
            success: true,
            data: Some(data),
            error: None,
            timestamp_ms,
        }
    }

    pub fn err(
        code: impl Into<String>,
        message: impl Into<String>,
        category: impl Into<String>,
    ) -> IpcEnvelope<()> {
        let timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        IpcEnvelope {
            success: false,
            data: None,
            error: Some(IpcErrorPayload {
                code: code.into(),
                message: message.into(),
                category: category.into(),
                suggested_action: None,
                details: None,
            }),
            timestamp_ms,
        }
    }
}
