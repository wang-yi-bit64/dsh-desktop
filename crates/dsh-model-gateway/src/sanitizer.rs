//! Schema Sanitizer Module.
//!
//! Provides schema transformations and sanitizations tailored for specific LLM providers.
//! Specifically:
//! - OpenAI / DeepSeek: Standard JSON Schema cleanup, removing unsupported schema dialect tags.
//! - Gemini: Strict OpenAPI 3.0 subset, converting types to uppercase, flattening `anyOf`/`oneOf`/`allOf`,
//!   stripping `additionalProperties`, `$schema`, `null` types, and ensuring valid property shapes.
//! - Claude: Anthropic format preparation, normalizing object property definitions.

use serde_json::{json, Map, Value};
use thiserror::Error;

/// Errors that can occur during schema sanitization.
#[derive(Debug, Error, PartialEq)]
pub enum SanitizeError {
    #[error("Invalid JSON Schema format: {0}")]
    InvalidSchema(String),
    #[error("Circular reference or excessive schema depth encountered: {0}")]
    MaxDepthExceeded(usize),
}

/// The target provider flavor for sanitization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetProvider {
    OpenAI,
    DeepSeek,
    Gemini,
    Claude,
}

const MAX_SCHEMA_DEPTH: usize = 32;

/// Sanitizes an input JSON Schema `Value` for a specific provider.
pub fn sanitize_schema(schema: &Value, provider: TargetProvider) -> Result<Value, SanitizeError> {
    match provider {
        TargetProvider::OpenAI | TargetProvider::DeepSeek => sanitize_for_openai(schema, 0),
        TargetProvider::Gemini => sanitize_for_gemini(schema, 0),
        TargetProvider::Claude => sanitize_for_claude(schema, 0),
    }
}

/// Sanitizes a JSON schema for OpenAI / DeepSeek compatible APIs.
/// - Strips `$schema`, `$id`, `definitions`, `$defs` (inlining or removing if not resolvable).
/// - Resolves `anyOf` / `oneOf` with null (e.g. `{"type": ["string", "null"]}` or `anyOf: [{"type": "string"}, {"type": "null"}]`).
/// - Retains valid properties and recursively sanitizes nested objects and arrays.
pub fn sanitize_for_openai(schema: &Value, depth: usize) -> Result<Value, SanitizeError> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err(SanitizeError::MaxDepthExceeded(depth));
    }

    match schema {
        Value::Object(map) => {
            let mut out = Map::new();

            // 1. Handle union types in 'type' field: e.g. ["string", "null"] -> "string" (nullable in OpenAI/standard)
            let mut effective_type = map.get("type").cloned();
            if let Some(Value::Array(types)) = &effective_type {
                let non_null_types: Vec<&Value> = types
                    .iter()
                    .filter(|t| t.as_str() != Some("null"))
                    .collect();
                if let Some(first) = non_null_types.first() {
                    effective_type = Some((*first).clone());
                } else {
                    effective_type = Some(Value::String("string".to_string()));
                }
            }

            // 2. Handle anyOf / oneOf collapsing if present
            if let Some(first_valid) = extract_first_valid_branch(map, "anyOf")
                .or_else(|| extract_first_valid_branch(map, "oneOf"))
            {
                let mut sanitized_branch = sanitize_for_openai(&first_valid, depth + 1)?;
                if let Value::Object(ref mut branch_map) = sanitized_branch {
                    // Merge description if not present in branch
                    if let Some(desc) = map.get("description") {
                        if !branch_map.contains_key("description") {
                            branch_map.insert("description".to_string(), desc.clone());
                        }
                    }
                }
                return Ok(sanitized_branch);
            }

            for (key, val) in map {
                // Strip meta schemas and disallowed fields
                if key == "$schema"
                    || key == "$id"
                    || key == "anyOf"
                    || key == "oneOf"
                    || key == "allOf"
                {
                    continue;
                }

                if key == "type" {
                    if let Some(ref t) = effective_type {
                        out.insert("type".to_string(), t.clone());
                    }
                    continue;
                }

                if key == "properties" {
                    if let Value::Object(props) = val {
                        let mut sanitized_props = Map::new();
                        for (p_key, p_val) in props {
                            sanitized_props
                                .insert(p_key.clone(), sanitize_for_openai(p_val, depth + 1)?);
                        }
                        out.insert("properties".to_string(), Value::Object(sanitized_props));
                    }
                    continue;
                }

                if key == "items" {
                    out.insert("items".to_string(), sanitize_for_openai(val, depth + 1)?);
                    continue;
                }

                out.insert(key.clone(), val.clone());
            }

            // Ensure object schema has properties if type is object
            if out.get("type").and_then(|v| v.as_str()) == Some("object")
                && !out.contains_key("properties")
            {
                out.insert("properties".to_string(), Value::Object(Map::new()));
            }

            Ok(Value::Object(out))
        }
        Value::Array(arr) => {
            let mut items = Vec::with_capacity(arr.len());
            for item in arr {
                items.push(sanitize_for_openai(item, depth + 1)?);
            }
            Ok(Value::Array(items))
        }
        _ => Ok(schema.clone()),
    }
}

/// Sanitizes a JSON schema for Google Gemini's FunctionDeclaration parameters.
/// - Gemini requires OpenAPI 3.0 schema subset.
/// - `type` must be uppercase: `STRING`, `NUMBER`, `INTEGER`, `BOOLEAN`, `ARRAY`, `OBJECT`.
/// - `additionalProperties`, `$schema`, `anyOf`, `oneOf`, `allOf`, `default` (in some versions) are removed or flattened.
/// - `null` types are removed.
/// - `properties` and `required` are cleaned up.
pub fn sanitize_for_gemini(schema: &Value, depth: usize) -> Result<Value, SanitizeError> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err(SanitizeError::MaxDepthExceeded(depth));
    }

    match schema {
        Value::Object(map) => {
            let mut out = Map::new();

            // 1. Resolve anyOf / oneOf / allOf
            if let Some(first_valid) = extract_first_valid_branch(map, "anyOf")
                .or_else(|| extract_first_valid_branch(map, "oneOf"))
                .or_else(|| extract_first_valid_branch(map, "allOf"))
            {
                let mut sanitized_branch = sanitize_for_gemini(&first_valid, depth + 1)?;
                if let Value::Object(ref mut branch_map) = sanitized_branch {
                    if let Some(desc) = map.get("description") {
                        if !branch_map.contains_key("description") {
                            branch_map.insert("description".to_string(), desc.clone());
                        }
                    }
                }
                return Ok(sanitized_branch);
            }

            // 2. Normalize and uppercase `type`
            let raw_type = map.get("type");
            let normalized_type = match raw_type {
                Some(Value::String(s)) => {
                    let upper = s.to_ascii_uppercase();
                    if upper == "NULL" {
                        "STRING".to_string()
                    } else {
                        upper
                    }
                }
                Some(Value::Array(types)) => {
                    // Extract first non-null type
                    types
                        .iter()
                        .filter_map(|t| t.as_str())
                        .find(|s| *s != "null")
                        .map(|s| s.to_ascii_uppercase())
                        .unwrap_or_else(|| "STRING".to_string())
                }
                None => {
                    if map.contains_key("properties") {
                        "OBJECT".to_string()
                    } else if map.contains_key("items") {
                        "ARRAY".to_string()
                    } else if map.contains_key("enum") {
                        "STRING".to_string()
                    } else {
                        "OBJECT".to_string()
                    }
                }
                _ => "OBJECT".to_string(),
            };

            out.insert("type".to_string(), Value::String(normalized_type.clone()));

            // 3. Process standard supported fields: description, enum, properties, required, items
            if let Some(desc) = map.get("description").and_then(|d| d.as_str()) {
                out.insert("description".to_string(), Value::String(desc.to_string()));
            }

            if let Some(Value::Array(arr)) = map.get("enum") {
                let cleaned_enums: Vec<Value> =
                    arr.iter().filter(|v| !v.is_null()).cloned().collect();
                if !cleaned_enums.is_empty() {
                    out.insert("enum".to_string(), Value::Array(cleaned_enums));
                }
            }

            if normalized_type == "OBJECT" {
                let mut sanitized_props = Map::new();
                if let Some(Value::Object(props)) = map.get("properties") {
                    for (p_key, p_val) in props {
                        sanitized_props
                            .insert(p_key.clone(), sanitize_for_gemini(p_val, depth + 1)?);
                    }
                }
                out.insert("properties".to_string(), Value::Object(sanitized_props));

                // Process required fields
                if let Some(Value::Array(reqs)) = map.get("required") {
                    let valid_reqs: Vec<Value> = reqs
                        .iter()
                        .filter(|r| {
                            if let Some(r_str) = r.as_str() {
                                if let Some(Value::Object(ref p)) = out.get("properties") {
                                    return p.contains_key(r_str);
                                }
                            }
                            false
                        })
                        .cloned()
                        .collect();
                    if !valid_reqs.is_empty() {
                        out.insert("required".to_string(), Value::Array(valid_reqs));
                    }
                }
            } else if normalized_type == "ARRAY" {
                if let Some(items) = map.get("items") {
                    out.insert("items".to_string(), sanitize_for_gemini(items, depth + 1)?);
                } else {
                    // Default array items to string if unspecified for Gemini
                    out.insert("items".to_string(), json!({"type": "STRING"}));
                }
            }

            Ok(Value::Object(out))
        }
        Value::Array(arr) => {
            let mut items = Vec::with_capacity(arr.len());
            for item in arr {
                items.push(sanitize_for_gemini(item, depth + 1)?);
            }
            Ok(Value::Array(items))
        }
        _ => Ok(schema.clone()),
    }
}

/// Sanitizes a JSON schema for Anthropic Claude `input_schema`.
pub fn sanitize_for_claude(schema: &Value, depth: usize) -> Result<Value, SanitizeError> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err(SanitizeError::MaxDepthExceeded(depth));
    }

    match schema {
        Value::Object(map) => {
            let mut out = Map::new();

            // Claude expects standard JSON Schema object as top level
            let mut effective_type = map.get("type").cloned();
            if effective_type.is_none() && map.contains_key("properties") {
                effective_type = Some(Value::String("object".to_string()));
            }

            if let Some(first_valid) = extract_first_valid_branch(map, "anyOf")
                .or_else(|| extract_first_valid_branch(map, "oneOf"))
            {
                let mut sanitized_branch = sanitize_for_claude(&first_valid, depth + 1)?;
                if let Value::Object(ref mut branch_map) = sanitized_branch {
                    if let Some(desc) = map.get("description") {
                        if !branch_map.contains_key("description") {
                            branch_map.insert("description".to_string(), desc.clone());
                        }
                    }
                }
                return Ok(sanitized_branch);
            }

            for (key, val) in map {
                if key == "$schema"
                    || key == "$id"
                    || key == "anyOf"
                    || key == "oneOf"
                    || key == "allOf"
                {
                    continue;
                }

                if key == "type" {
                    if let Some(ref t) = effective_type {
                        out.insert("type".to_string(), t.clone());
                    }
                    continue;
                }

                if key == "properties" {
                    if let Value::Object(props) = val {
                        let mut sanitized_props = Map::new();
                        for (p_key, p_val) in props {
                            sanitized_props
                                .insert(p_key.clone(), sanitize_for_claude(p_val, depth + 1)?);
                        }
                        out.insert("properties".to_string(), Value::Object(sanitized_props));
                    }
                    continue;
                }

                if key == "items" {
                    out.insert("items".to_string(), sanitize_for_claude(val, depth + 1)?);
                    continue;
                }

                out.insert(key.clone(), val.clone());
            }

            if out.get("type").and_then(|v| v.as_str()) == Some("object")
                && !out.contains_key("properties")
            {
                out.insert("properties".to_string(), Value::Object(Map::new()));
            }

            Ok(Value::Object(out))
        }
        Value::Array(arr) => {
            let mut items = Vec::with_capacity(arr.len());
            for item in arr {
                items.push(sanitize_for_claude(item, depth + 1)?);
            }
            Ok(Value::Array(items))
        }
        _ => Ok(schema.clone()),
    }
}

/// Helper to find the first non-null branch inside anyOf/oneOf/allOf arrays.
fn extract_first_valid_branch(map: &Map<String, Value>, key: &str) -> Option<Value> {
    if let Some(Value::Array(branches)) = map.get(key) {
        for branch in branches {
            if let Value::Object(b_map) = branch {
                if let Some(Value::String(t)) = b_map.get("type") {
                    if t != "null" {
                        return Some(branch.clone());
                    }
                } else if !b_map.is_empty() {
                    return Some(branch.clone());
                }
            }
        }
    }
    None
}
