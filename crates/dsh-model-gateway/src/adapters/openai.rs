//! OpenAI and DeepSeek Provider Adapter.
//!
//! Formats tools as:
//! ```json
//! {
//!   "type": "function",
//!   "function": {
//!     "name": "...",
//!     "description": "...",
//!     "parameters": { ... },
//!     "strict": false
//!   }
//! }
//! ```

use super::{ModelProviderAdapter, TransformError};
use crate::sanitizer::{sanitize_schema, TargetProvider};
use crate::schema::CanonicalTool;
use serde_json::{json, Value};

/// Adapter for OpenAI, DeepSeek, vLLM, and Ollama compatible endpoints.
#[derive(Debug, Default, Clone)]
pub struct OpenAIAdapter {
    provider_name: &'static str,
}

impl OpenAIAdapter {
    /// Creates a standard OpenAI adapter.
    pub fn new() -> Self {
        Self {
            provider_name: "openai",
        }
    }

    /// Creates an adapter configured with a custom identifier (e.g. "deepseek", "vllm").
    pub fn with_provider_name(provider_name: &'static str) -> Self {
        Self { provider_name }
    }
}

impl ModelProviderAdapter for OpenAIAdapter {
    fn provider_id(&self) -> &'static str {
        self.provider_name
    }

    fn transform_tool(&self, tool: &CanonicalTool) -> Result<Value, TransformError> {
        tool.validate_name()
            .map_err(TransformError::ValidationError)?;

        let sanitized_params = sanitize_schema(&tool.parameters, TargetProvider::OpenAI)?;

        let mut func_obj = json!({
            "name": tool.name,
            "description": tool.description,
            "parameters": sanitized_params,
        });

        if tool.strict {
            if let Value::Object(ref mut map) = func_obj {
                map.insert("strict".to_string(), Value::Bool(true));
            }
        }

        Ok(json!({
            "type": "function",
            "function": func_obj
        }))
    }

    fn build_request_payload(
        &self,
        model: &str,
        messages: &[Value],
        tools: &[CanonicalTool],
    ) -> Result<Value, TransformError> {
        let mut payload = json!({
            "model": model,
            "messages": messages,
        });

        if !tools.is_empty() {
            let tools_val = self.transform_tools(tools)?;
            if let Value::Object(ref mut map) = payload {
                map.insert("tools".to_string(), tools_val);
            }
        }

        Ok(payload)
    }
}
