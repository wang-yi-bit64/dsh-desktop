//! Provider Adapters for LLM Tool Calling.
//!
//! Transforms canonical tool schemas and payloads into provider-specific formats:
//! - OpenAI / DeepSeek (`OpenAIAdapter`)
//! - Google Gemini (`GeminiAdapter`)
//! - Anthropic Claude (`ClaudeAdapter`)

pub mod claude;
pub mod gemini;
pub mod openai;

pub use claude::ClaudeAdapter;
pub use gemini::GeminiAdapter;
pub use openai::OpenAIAdapter;

use crate::schema::CanonicalTool;
use thiserror::Error;

/// Transformation errors occurring during tool or request conversion.
#[derive(Debug, Error, PartialEq)]
pub enum TransformError {
    #[error("Tool validation failed: {0}")]
    ValidationError(String),
    #[error("Sanitization error: {0}")]
    SanitizeError(String),
    #[error("Serialization / Deserialization error: {0}")]
    JsonError(String),
    #[error("Unsupported feature: {0}")]
    Unsupported(String),
}

impl From<crate::sanitizer::SanitizeError> for TransformError {
    fn from(err: crate::sanitizer::SanitizeError) -> Self {
        TransformError::SanitizeError(err.to_string())
    }
}

/// Trait implemented by model provider adapters.
pub trait ModelProviderAdapter: Send + Sync {
    /// Unique provider identifier (e.g. "openai", "gemini", "claude", "deepseek").
    fn provider_id(&self) -> &'static str;

    /// Transforms a single `CanonicalTool` into the target provider's tool declaration structure.
    fn transform_tool(&self, tool: &CanonicalTool) -> Result<serde_json::Value, TransformError>;

    /// Transforms a slice of `CanonicalTool`s into the provider's top-level tools parameter payload.
    fn transform_tools(
        &self,
        tools: &[CanonicalTool],
    ) -> Result<serde_json::Value, TransformError> {
        let mut list = Vec::with_capacity(tools.len());
        for tool in tools {
            list.push(self.transform_tool(tool)?);
        }
        Ok(serde_json::Value::Array(list))
    }

    /// Assembles a complete provider-compliant HTTP chat completion request payload.
    fn build_request_payload(
        &self,
        model: &str,
        messages: &[serde_json::Value],
        tools: &[CanonicalTool],
    ) -> Result<serde_json::Value, TransformError>;
}
