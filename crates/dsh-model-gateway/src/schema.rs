//! Canonical Tool Schema Definitions and JSON Schema representations.
//!
//! Provides structured models for tool definitions across LLM providers.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Schema type enumeration representing standard JSON schema data types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SchemaType {
    String,
    Number,
    Integer,
    Boolean,
    Array,
    Object,
    Null,
}

impl SchemaType {
    /// Returns the uppercase name used by Gemini OpenAPI 3.0 dialect (e.g. "STRING", "OBJECT").
    pub fn to_gemini_type_str(&self) -> &'static str {
        match self {
            SchemaType::String => "STRING",
            SchemaType::Number => "NUMBER",
            SchemaType::Integer => "INTEGER",
            SchemaType::Boolean => "BOOLEAN",
            SchemaType::Array => "ARRAY",
            SchemaType::Object => "OBJECT",
            SchemaType::Null => "NULL",
        }
    }

    /// Returns the lowercase standard JSON Schema name.
    pub fn to_standard_type_str(&self) -> &'static str {
        match self {
            SchemaType::String => "string",
            SchemaType::Number => "number",
            SchemaType::Integer => "integer",
            SchemaType::Boolean => "boolean",
            SchemaType::Array => "array",
            SchemaType::Object => "object",
            SchemaType::Null => "null",
        }
    }
}

/// A structured property definition within a JSON Schema object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ParameterProperty {
    /// The property data type (if single typed).
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub property_type: Option<SchemaType>,

    /// Property description explaining its semantics.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Nested object properties if type is object.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<BTreeMap<String, ParameterProperty>>,

    /// Item schema if type is array.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<ParameterProperty>>,

    /// Required child fields if type is object.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<Vec<String>>,

    /// Allowed enum values for string/number types.
    #[serde(rename = "enum", skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<serde_json::Value>>,

    /// Default fallback value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,

    /// Additional arbitrary schema attributes (e.g. format, minimum, maximum).
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Top-level or nested JSON Schema definition for tool parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonSchema {
    /// Schema dialect identifier (e.g. `http://json-schema.org/draft-07/schema#`).
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema_dialect: Option<String>,

    /// Type of the root parameter object (typically `SchemaType::Object`).
    #[serde(rename = "type", default = "default_object_type")]
    pub schema_type: SchemaType,

    /// High-level description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Property map for object schemas.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub properties: BTreeMap<String, ParameterProperty>,

    /// List of required property keys.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required: Vec<String>,

    /// Whether additional properties are allowed (often stripped for strict providers).
    #[serde(
        rename = "additionalProperties",
        skip_serializing_if = "Option::is_none"
    )]
    pub additional_properties: Option<bool>,

    /// Array items schema if root schema is an array.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<ParameterProperty>>,

    /// Union types or polymorphic definitions (will be normalized by sanitizer).
    #[serde(rename = "anyOf", skip_serializing_if = "Option::is_none")]
    pub any_of: Option<Vec<serde_json::Value>>,

    /// One-of schema variations.
    #[serde(rename = "oneOf", skip_serializing_if = "Option::is_none")]
    pub one_of: Option<Vec<serde_json::Value>>,

    /// All-of schema variations.
    #[serde(rename = "allOf", skip_serializing_if = "Option::is_none")]
    pub all_of: Option<Vec<serde_json::Value>>,

    /// Other extra fields from standard or custom JSON Schemas.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

fn default_object_type() -> SchemaType {
    SchemaType::Object
}

impl Default for JsonSchema {
    fn default() -> Self {
        Self {
            schema_dialect: None,
            schema_type: SchemaType::Object,
            description: None,
            properties: BTreeMap::new(),
            required: Vec::new(),
            additional_properties: None,
            items: None,
            any_of: None,
            one_of: None,
            all_of: None,
            extra: BTreeMap::new(),
        }
    }
}

/// Canonical tool definition used across DSH model gateway.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CanonicalTool {
    /// Unique identifier for the tool (e.g. matching `^[a-zA-Z0-9_-]{1,64}$`).
    pub name: String,

    /// Human-readable and LLM-targeted description of what the tool does.
    pub description: String,

    /// Parameter schema defining the tool input arguments.
    pub parameters: serde_json::Value,

    /// Optional plugin / origin identifier for fault attribution and audit trails.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_plugin: Option<String>,

    /// Whether this tool requires strict schema adherence.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub strict: bool,
}

impl CanonicalTool {
    /// Creates a new `CanonicalTool` with given name, description, and parameters.
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        parameters: serde_json::Value,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters,
            source_plugin: None,
            strict: false,
        }
    }

    /// Sets the source plugin identifier.
    pub fn with_source_plugin(mut self, source_plugin: impl Into<String>) -> Self {
        self.source_plugin = Some(source_plugin.into());
        self
    }

    /// Sets strict schema mode.
    pub fn with_strict(mut self, strict: bool) -> Self {
        self.strict = strict;
        self
    }

    /// Validates the tool name against the standard identifier regex: `^[a-zA-Z0-9_-]{1,64}$`.
    pub fn validate_name(&self) -> Result<(), String> {
        let name = &self.name;
        if name.is_empty() {
            return Err("tool name cannot be empty".to_string());
        }
        if name.len() > 64 {
            return Err(format!(
                "tool name '{}' exceeds 64 characters length limit",
                name
            ));
        }
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(format!(
                "tool name '{}' contains invalid characters; must match ^[a-zA-Z0-9_-]+$",
                name
            ));
        }
        Ok(())
    }
}
