//! Anthropic Claude Provider Adapter.
//!
//! Formats tools according to Anthropic tool use specifications:
//! ```json
//! {
//!   "name": "...",
//!   "description": "...",
//!   "input_schema": {
//!     "type": "object",
//!     "properties": { ... },
//!     "required": [ ... ]
//!   }
//! }
//! ```

use super::{ModelProviderAdapter, TransformError};
use crate::sanitizer::{sanitize_schema, TargetProvider};
use crate::schema::CanonicalTool;
use serde_json::{json, Value};

/// Adapter for Anthropic Claude Messages API.
#[derive(Debug, Default, Clone)]
pub struct ClaudeAdapter;

impl ClaudeAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl ModelProviderAdapter for ClaudeAdapter {
    fn provider_id(&self) -> &'static str {
        "claude"
    }

    fn transform_tool(&self, tool: &CanonicalTool) -> Result<Value, TransformError> {
        tool.validate_name()
            .map_err(TransformError::ValidationError)?;

        let sanitized_schema = sanitize_schema(&tool.parameters, TargetProvider::Claude)?;

        Ok(json!({
            "name": tool.name,
            "description": tool.description,
            "input_schema": sanitized_schema,
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
