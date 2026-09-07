//! DSH Model Gateway (`dsh-model-gateway`)
//!
//! Multi-provider LLM tool calling schema validation, sanitization, and adapter gateway.
//!
//! Provides a unified schema format (`CanonicalTool`), automatic JSON Schema cleaning & dialect conversion
//! (supporting OpenAI, Gemini, Claude, DeepSeek), and a unified ModelGateway dispatcher facade.

pub mod adapters;
pub mod sanitizer;
pub mod schema;

pub use adapters::{
    claude::ClaudeAdapter, gemini::GeminiAdapter, openai::OpenAIAdapter, ModelProviderAdapter,
    TransformError,
};
pub use sanitizer::{
    sanitize_for_claude, sanitize_for_gemini, sanitize_for_openai, sanitize_schema, SanitizeError,
    TargetProvider,
};
pub use schema::{CanonicalTool, JsonSchema, ParameterProperty, SchemaType};

use std::collections::HashMap;
use std::sync::Arc;

/// Unified Gateway facade for managing provider adapters and executing transformations.
#[derive(Clone)]
pub struct ModelGateway {
    adapters: HashMap<String, Arc<dyn ModelProviderAdapter>>,
}

impl Default for ModelGateway {
    fn default() -> Self {
        Self::new()
    }
}

impl ModelGateway {
    /// Creates a `ModelGateway` pre-populated with standard adapters:
    /// - `openai` (OpenAI / DeepSeek compatible)
    /// - `deepseek` (DeepSeek-specific alias)
    /// - `gemini` (Google Gemini)
    /// - `claude` (Anthropic Claude)
    pub fn new() -> Self {
        let mut gateway = Self {
            adapters: HashMap::new(),
        };

        gateway.register_adapter(Arc::new(OpenAIAdapter::new()));
        gateway.register_adapter(Arc::new(OpenAIAdapter::with_provider_name("deepseek")));
        gateway.register_adapter(Arc::new(GeminiAdapter::new()));
        gateway.register_adapter(Arc::new(ClaudeAdapter::new()));

        gateway
    }

    /// Registers a new or custom provider adapter.
    pub fn register_adapter(&mut self, adapter: Arc<dyn ModelProviderAdapter>) {
        self.adapters
            .insert(adapter.provider_id().to_string(), adapter);
    }

    /// Retrieves an adapter by its provider key.
    pub fn get_adapter(&self, provider: &str) -> Option<Arc<dyn ModelProviderAdapter>> {
        self.adapters.get(provider).cloned()
    }

    /// Transforms canonical tools for a target provider.
    pub fn transform_tools(
        &self,
        provider: &str,
        tools: &[CanonicalTool],
    ) -> Result<serde_json::Value, TransformError> {
        let adapter = self.get_adapter(provider).ok_or_else(|| {
            TransformError::Unsupported(format!(
                "Provider '{}' is not registered in gateway",
                provider
            ))
        })?;

        adapter.transform_tools(tools)
    }

    /// Builds a full request payload for a target provider.
    pub fn build_request(
        &self,
        provider: &str,
        model: &str,
        messages: &[serde_json::Value],
        tools: &[CanonicalTool],
    ) -> Result<serde_json::Value, TransformError> {
        let adapter = self.get_adapter(provider).ok_or_else(|| {
            TransformError::Unsupported(format!(
                "Provider '{}' is not registered in gateway",
                provider
            ))
        })?;

        adapter.build_request_payload(model, messages, tools)
    }
}
