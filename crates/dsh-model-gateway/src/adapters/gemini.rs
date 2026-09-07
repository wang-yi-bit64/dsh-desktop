//! Google Gemini Provider Adapter.
//!
//! Converts CanonicalTool into Gemini's `FunctionDeclaration` structure:
//! ```json
//! {
//!   "name": "...",
//!   "description": "...",
//!   "parameters": {
//!     "type": "OBJECT",
//!     "properties": { ... },
//!     "required": [ ... ]
//!   }
//! }
//! ```
//! And request payload tools formatted as:
//! ```json
//! {
//!   "tools": [
//!     {
//!       "functionDeclarations": [ ... ]
//!     }
//!   ]
//! }
//! ```

use super::{ModelProviderAdapter, TransformError};
use crate::sanitizer::{sanitize_schema, TargetProvider};
use crate::schema::CanonicalTool;
use serde_json::{json, Value};

/// Adapter for Google Gemini Generative Language APIs.
#[derive(Debug, Default, Clone)]
pub struct GeminiAdapter;

impl GeminiAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl ModelProviderAdapter for GeminiAdapter {
    fn provider_id(&self) -> &'static str {
        "gemini"
    }

    fn transform_tool(&self, tool: &CanonicalTool) -> Result<Value, TransformError> {
        tool.validate_name()
            .map_err(TransformError::ValidationError)?;

        let sanitized_params = sanitize_schema(&tool.parameters, TargetProvider::Gemini)?;

        Ok(json!({
            "name": tool.name,
            "description": tool.description,
            "parameters": sanitized_params,
        }))
    }

    /// For Gemini, multiple function declarations are wrapped inside a single `functionDeclarations` object in `tools`.
    fn transform_tools(&self, tools: &[CanonicalTool]) -> Result<Value, TransformError> {
        let mut declarations = Vec::with_capacity(tools.len());
        for tool in tools {
            declarations.push(self.transform_tool(tool)?);
        }
        Ok(json!([
            {
                "functionDeclarations": declarations
            }
        ]))
    }

    fn build_request_payload(
        &self,
        _model: &str,
        contents: &[Value],
        tools: &[CanonicalTool],
    ) -> Result<Value, TransformError> {
        let mut payload = json!({
            "contents": contents,
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
